import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MEMBER_AI_DAILY, MEMBER_CARRIED_BADGE, MEMBER_CARRIED_TEXT, MEMBER_SCORE_DAILY, memberScoreView } from "../src/auth/routePolicy.js";
import { carriedBadge, carriedText } from "../src/services/valueScoreText.js";
import { GLOBAL_LOCK_FAILS } from "../src/auth/rateLimit.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { seoulIso } from "../src/lib/time.js";
import { memberSummary } from "../src/routes/marketSummaries.js";
import type { MarketSummary } from "../src/services/marketSummaryService.js";
import type { CandlePeriod, CandleSeries } from "../src/domain/types.js";
import type { LiveTick, StockSessionFacts, TossRealtime } from "../src/providers/market/tossRealtime.js";
import { FakeQuoteProvider, fakeProviders } from "./helpers.js";

/**
 * 계정 A단계 검증 4차:
 *  - M2 공유 캐시로 주인 종목이 드러나지 않게: 주인 아닌 계정의 공유 응답에는 캐시 시각·상태(computedAt·createdAt·cached·id·재무 받은 시각)를
 *    요청 시각 값으로 바꾸고, 서버 처리 시간 머리글(Server-Timing)도 주지 않는다. 하루 한도도 캐시와 상관없이 센다 (한도를 다 쓴 뒤
 *    '캐시에 있으면 200, 없으면 429' 로 주인 종목을 알아내지 못하게)
 *  - 잠금은 아이디 + IP 로 (남이 다른 IP 에서 틀려도 주인은 잠기지 않음), 아이디 전체 잠금은 훨씬 높은 횟수에서만
 *  - 시장 요약 data 가 없으면 빈 요약 (저장된 글을 그대로 주지 않음)
 */
vi.stubEnv("ACCOUNTS_DISABLED", "");
afterAll(() => vi.unstubAllEnvs());

const T0 = Date.parse("2026-09-28T10:00:00+09:00");
const MIN = 60_000;
const OWNER = "서성원";

interface Ctx {
  app: FastifyInstance;
  db: Db;
  clock: { t: number };
}
const opened: Ctx[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) {
    await c.app.close();
    await c.db.destroy();
  }
});

async function makeApp(): Promise<Ctx> {
  const clock = { t: T0 };
  const db = await createMigratedDb(":memory:");
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(), logger: false, enableScheduler: false, now: () => new Date(clock.t), auth: { scryptN: 1024 } });
  const c = { app, db, clock };
  opened.push(c);
  return c;
}

const S = (token: string) => ({ "x-session-token": token });
const login = (app: FastifyInstance, loginId: string, password: string, extra: Partial<InjectOptions> = {}) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId, password }, ...extra } as InjectOptions);

async function seeded() {
  const c = await makeApp();
  await c.app.stockService.refreshMaster();
  const owner = (await login(c.app, OWNER, "1111")).json().token as string;
  expect((await c.app.inject({ method: "POST", url: "/api/stocks", headers: S(owner), payload: { code: "005930", quantity: 3, avgPrice: 70000 } })).statusCode).toBe(201);
  const member = (await c.app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "member1", password: "abcd1234", passwordConfirm: "abcd1234", email: "m@example.com" } })).json().token as string;
  return { ...c, owner, member };
}

describe("M2: 공유 캐시의 시각·상태로 주인 종목이 드러나지 않는다 (시각 오라클)", () => {
  it("분석: 주인이 먼저 만들어 둔 종목(캐시)과 처음 만드는 종목이 주인 아닌 계정에게 같은 모양 — id 0 · cached false · createdAt 요청 시각", async () => {
    const { app, clock, owner, member } = await seeded();
    const mine = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(owner) });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().createdAt).toBe(seoulIso(new Date(T0)));
    clock.t += 7 * MIN;
    const now = seoulIso(new Date(clock.t));
    const cached = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(member) });
    const fresh = await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/company", headers: S(member) });
    for (const r of [cached, fresh]) {
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ id: 0, cached: false, createdAt: now });
      expect(r.headers["server-timing"]).toBeUndefined();
    }
    // 주인은 그대로 (캐시 표시·만든 시각·서버 처리 시간)
    const again = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(owner) });
    expect(again.json()).toMatchObject({ cached: true, createdAt: seoulIso(new Date(T0)), id: mine.json().id });
    expect(again.headers["server-timing"]).toMatch(/^app;dur=/);
  });

  it("지표 점수: 주인 종목의 캐시 계산 시각(computedAt) 대신 요청 시각, 재무 받은 시각은 빈 값", async () => {
    const { app, clock, owner, member } = await seeded();
    const first = await app.inject({ method: "GET", url: "/api/scores/005930", headers: S(owner) });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().computedAt).toBe(seoulIso(new Date(T0)));
    clock.t += 3 * MIN;
    const now = seoulIso(new Date(clock.t));
    const a = await app.inject({ method: "GET", url: "/api/scores/005930", headers: S(member) });
    const b = await app.inject({ method: "GET", url: "/api/scores/000660", headers: S(member) });
    for (const r of [a, b]) {
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().computedAt).toBe(now);
      if (r.json().value?.asOf) expect(r.json().value.asOf.fetchedAt).toBeNull();
      expect(r.headers["server-timing"]).toBeUndefined();
    }
    // 주인은 캐시 그대로
    expect((await app.inject({ method: "GET", url: "/api/scores/005930", headers: S(owner) })).json().computedAt).toBe(seoulIso(new Date(T0)));
  });

  it("공유 경로 전부: 주인 아닌 계정에게는 서버 처리 시간 머리글이 없다 (캐시 적중이 빨라 보이는 것을 숨김), 주인에게는 있다", async () => {
    const { app, owner, member } = await seeded();
    for (const url of ["/api/stocks/005930", "/api/stocks/005930/quote", "/api/stocks/005930/candles", "/api/stocks/005930/news", "/api/market/status", `/api/stocks/search?q=${encodeURIComponent("삼성")}`]) {
      const m = await app.inject({ method: "GET", url, headers: S(member) });
      expect(m.statusCode, `${url} ${m.body}`).toBe(200);
      expect(m.headers["server-timing"], url).toBeUndefined();
      expect((await app.inject({ method: "GET", url, headers: S(owner) })).headers["server-timing"], url).toMatch(/^app;dur=/);
    }
  });

  it(`분석 하루 한도(${MEMBER_AI_DAILY})는 캐시와 상관없이 서로 다른 종목·종류 수로 센다 — 다 쓴 뒤에는 캐시에 있든 없든 429, 오늘 이미 본 것은 계속`, async () => {
    const { app, owner, member } = await seeded();
    // 주인이 만들어 둔 캐시
    expect((await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/value", headers: S(owner) })).statusCode).toBe(200);
    const m = S(member);
    // 주인 캐시(005930 value)·처음 만들 것(000660 value)을 뺀 서로 다른 종목·종류
    const pool = [["000660", "company"], ["000660", "technical"], ...["005935", "247540", "465580"].flatMap((code) => ["company", "value", "technical"].map((kind) => [code, kind]))];
    const seen = pool.slice(0, MEMBER_AI_DAILY).map(([code, kind]) => `/api/stocks/${code}/analysis/${kind}`);
    expect(seen).toHaveLength(MEMBER_AI_DAILY);
    for (const url of seen) expect((await app.inject({ method: "GET", url, headers: m })).statusCode, url).toBe(200);
    const cachedOver = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/value", headers: m });
    const freshOver = await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/value", headers: m });
    for (const r of [cachedOver, freshOver]) {
      expect(r.statusCode).toBe(429);
      expect(r.json().code).toBe("ai_daily_limit");
    }
    expect(cachedOver.body).toBe(freshOver.body);
    // 이미 본 것은 다시 봐도 세지 않는다
    expect((await app.inject({ method: "GET", url: seen[0]!, headers: m })).statusCode).toBe(200);
    // 주인은 한도 없음
    expect((await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/value", headers: S(owner) })).statusCode).toBe(200);
  });

  it(`지표 점수 하루 한도(${MEMBER_SCORE_DAILY}종목): 캐시에 있는 주인 종목과 처음 계산할 종목이 다 쓴 뒤 똑같이 429, 오늘 본 종목은 계속`, async () => {
    const { app, owner, member } = await seeded();
    expect((await app.inject({ method: "GET", url: "/api/scores/005930", headers: S(owner) })).statusCode).toBe(200);
    const m = S(member);
    expect((await app.inject({ method: "GET", url: "/api/scores/005935", headers: m })).statusCode).toBe(200);
    // 모르는 종목 코드도 한 종목으로 센다 (계산 전에 센다)
    for (let i = 1; i < MEMBER_SCORE_DAILY; i++) await app.inject({ method: "GET", url: `/api/scores/${String(900000 + i)}`, headers: m });
    const cachedOver = await app.inject({ method: "GET", url: "/api/scores/005930", headers: m });
    const freshOver = await app.inject({ method: "GET", url: "/api/scores/000660", headers: m });
    for (const r of [cachedOver, freshOver]) {
      expect(r.statusCode, r.body).toBe(429);
      expect(r.json()).toMatchObject({ code: "score_daily_limit" });
    }
    expect(cachedOver.body).toBe(freshOver.body);
    expect((await app.inject({ method: "GET", url: "/api/scores/005935", headers: m })).statusCode).toBe(200);
    // 주인은 한도 없음
    expect((await app.inject({ method: "GET", url: "/api/scores/000660", headers: S(owner) })).statusCode).toBe(200);
  });
});

describe("잠금은 아이디 + IP (주인을 남이 다른 곳에서 잠그지 못함)", () => {
  it("한 IP 에서 5번 틀리면 그 IP 만 10분 막힌다 — 주인은 다른 IP 에서 바로 로그인, 막힌 IP 는 남은 시간을 받는다", async () => {
    const { app, clock } = await makeApp();
    const bad = { remoteAddress: "10.1.1.1" };
    for (let i = 1; i <= 4; i++) expect((await login(app, OWNER, "bad", bad)).statusCode).toBe(400);
    const fifth = await login(app, OWNER, "bad", bad);
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ code: "too_many_attempts", retryAfterSec: 600 });
    expect((await login(app, OWNER, "1111", bad)).statusCode).toBe(429);
    // 다른 IP (주인 폰) 는 그대로
    expect((await login(app, OWNER, "1111", { remoteAddress: "10.2.2.2" })).statusCode).toBe(200);
    clock.t += 4 * MIN;
    const later = await login(app, OWNER, "1111", bad);
    expect(later.statusCode).toBe(429);
    expect(later.json().retryAfterSec).toBe(360);
    expect(later.json().message).toBe("여러 번 틀려서 잠시 막아 두었어요. 6분 뒤에 다시 해 주세요");
    clock.t += 6 * MIN;
    expect((await login(app, OWNER, "1111", bad)).statusCode).toBe(200);
  });

  it(`여러 IP 에서 한 아이디를 모두 ${GLOBAL_LOCK_FAILS}번 틀리면 그 아이디 전체가 10분 막힌다 (훨씬 높은 문턱). 없는 아이디도 같다`, async () => {
    const { app, clock } = await makeApp();
    for (const id of [OWNER, "ghost"]) {
      let n = 0;
      for (let ip = 0; n < GLOBAL_LOCK_FAILS; ip++) {
        for (let i = 0; i < 4 && n < GLOBAL_LOCK_FAILS; i++, n++) {
          const r = await login(app, id, "bad", { remoteAddress: `10.3.${ip}.${id === OWNER ? 1 : 2}` });
          if (n < GLOBAL_LOCK_FAILS - 1) expect(r.statusCode, `${id} ${n}`).toBe(400);
          else expect(r.statusCode).toBe(429);
        }
      }
      expect((await login(app, id, "1111", { remoteAddress: "10.9.9.9" })).statusCode).toBe(429);
    }
    clock.t += 10 * MIN + 1000;
    expect((await login(app, OWNER, "1111", { remoteAddress: "10.9.9.9" })).statusCode).toBe(200);
  });
});

describe("아이디 전체 잠금은 10분 창 안에서만 센다 (검증 5차)", () => {
  it("IP 한 곳에서 '5번 틀림 → 10분 잠금'을 두 시간 되풀이해도(60번) 주인은 다른 IP 에서 로그인된다", async () => {
    const { app, clock } = await makeApp();
    const bad = { remoteAddress: "10.4.4.4" };
    let fails = 0;
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 5; i++, fails++) expect((await login(app, OWNER, "bad", bad)).statusCode).toBe(i < 4 ? 400 : 429);
      // 아이디 전체가 잠기지 않았는지 — 다른 IP 에서 한 번 틀려 본다 (맞히면 횟수가 지워지므로 틀려서 확인). 예전(쌓기만)에는 누적 50번째부터 429
      const probe = await login(app, OWNER, "bad", { remoteAddress: `10.5.${round}.5` });
      fails++;
      expect(probe.statusCode, `round ${round} (누적 ${fails})`).toBe(400);
      clock.t += 10 * MIN + 1000;
    }
    expect(fails).toBeGreaterThan(GLOBAL_LOCK_FAILS);
    expect((await login(app, OWNER, "1111", { remoteAddress: "10.6.6.6" })).statusCode).toBe(200);
  });
});

describe("시장 요약 가림 — data 가 없는 옛 행", () => {
  it("data 를 읽지 못한 요약은 저장된 글(주인 종목 줄이 있을 수 있음)을 주지 않고 빈 요약", () => {
    const s: MarketSummary = { id: 1, date: "2026-09-23", session: "afternoon", market: "KR", status: "ok", summary: "코스피 +1%\n내 종목 · 카나리아전자 +3%", data: null, createdAt: "2026-09-23T16:00:00+09:00" } as MarketSummary;
    const seen = memberSummary(s);
    expect(seen.summary).toBe("");
    expect(seen.data).toBeNull();
    expect(JSON.stringify(seen)).not.toContain("카나리아");
    // 실패 행의 고정 문구는 그대로 (주인 데이터가 아님), 모르는 글은 빈 값
    expect(memberSummary({ ...s, status: "failed", summary: "지수를 받지 못해 시장 요약을 만들지 못했습니다" }).summary).toBe("지수를 받지 못해 시장 요약을 만들지 못했습니다");
    expect(memberSummary({ ...s, status: "failed", summary: "내 종목 카나리아전자" }).summary).toBe("");
  });
});

/**
 * 검증 5차 M2: 주인 아닌 계정의 시세·상세가 **주인 등록 종목 때문에 서버에 쌓인 상태**를 드러내지 않는다.
 * 같은 가짜 출처·같은 시계로 서버 둘을 띄운다 — (가) 주인이 삼성전자를 등록하고 잔고를 받아(세션 자격 캐시·웹소켓 구독·3초 갱신 가격이 쌓임)
 * 점수까지 계산해 둔 서버, (나) 주인이 다른 종목만 가진 서버. 주인 아닌 계정이 삼성전자를 부르면 두 서버의 응답 본문이 같아야 한다.
 * (응답 속도·첫 응답의 '계산 준비 중' 같은 캐시 적중 차이는 남는다 — 설계 3장 '남는 신호')
 */
describe("M2 (검증 5차): 주인 등록 종목과 처음 보는 종목의 응답이 같다 — 세션 자격(eligible)·웹소켓 초록 점", () => {
  // 월요일 17:00 — 한국 애프터마켓(NXT, 16:00~20:00): 세션 자격(nxt·etp)을 종목별 캐시에서만 안다
  const T1 = Date.parse("2026-09-28T17:00:00+09:00");

  /** 토스 웹 가짜: 세션 사실은 '전에 물어본 종목'만 바로 준다 (진짜 toss.ts 처럼 받아 둔 값만 · 새 값은 뒤에서) */
  function tossWeb(clock: { t: number }) {
    const known = new Set<string>();
    const unknown: StockSessionFacts = { daytime: null, nxt: null, halted: null, nxtHalted: null, etp: null, exchange: null, pricedAt: null };
    return {
      name: "toss-web",
      async getMany(codes: string[]): Promise<Map<string, LiveTick>> {
        return new Map(codes.map((c) => [c, { code: c, price: 100_500, volume: 10, timestamp: seoulIso(new Date(clock.t)), receivedAt: clock.t }]));
      },
      sessionFacts(codes: string[]): Map<string, StockSessionFacts> {
        // 받아 둔 종목: NXT 아님 + ETF (16:00~20:00 애프터마켓 대상 아님 → eligible false). 처음 보는 종목: 모름 (eligible null)
        const out = new Map(codes.map((c) => [c, known.has(c) ? { daytime: null, nxt: false, halted: false, nxtHalted: false, etp: true, exchange: "krx", pricedAt: clock.t } : unknown]));
        for (const c of codes) known.add(c);
        return out;
      },
    };
  }
  /** 토스 웹소켓 가짜: 주인 등록 종목만 구독·체결 */
  function wsFor(clock: { t: number }, subscribed: string[]): TossRealtime {
    return {
      get: (c: string) => (subscribed.includes(c) ? { code: c, price: 100_700, volume: 5, timestamp: seoulIso(new Date(clock.t - 1000)), receivedAt: clock.t - 1000 } : null),
      setCodes: () => undefined,
      status: () => ({ enabled: true, connected: true, subscribed, lastMessageAt: seoulIso(new Date(clock.t - 1000)), lastError: null, lastAliveAt: seoulIso(new Date(clock.t - 1000)) }),
      on: () => undefined,
      off: () => undefined,
    } as unknown as TossRealtime;
  }

  async function server(ownerCode: string) {
    const clock = { t: T1 };
    const db = await createMigratedDb(":memory:");
    // 시세 스냅샷은 1분 전 것 (웹소켓 체결이 그보다 새로워 주인 시세에는 웹소켓 가격이 붙는다)
    const quotes = new (class extends FakeQuoteProvider {
      override async getQuote(code: string) {
        return { ...(await super.getQuote(code)), asOf: seoulIso(new Date(clock.t - 60_000)) };
      }
      // 봉은 개수와 상관없이 같은 날짜의 같은 값 (진짜 출처처럼 — 많이 받아 둔 캐시에서 잘라 줘도 같은 봉)
      override async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
        const end = Date.UTC(2026, 8, 25);
        const candles = Array.from({ length: count }, (_, i) => {
          const k = count - 1 - i;
          const c = 100_000 + Math.round(Math.sin(k / 7) * 5000) - k * 20;
          return { date: new Date(end - k * 86_400_000).toISOString().slice(0, 10), open: c - 200, high: c + 800, low: c - 900, close: c, volume: 1_000_000 + k * 1000 };
        });
        return { code, period, candles, source: this.name };
      }
    })("toss");
    const providers = fakeProviders({ quotes, quickPrices: tossWeb(clock), live: wsFor(clock, [ownerCode]) });
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers, logger: false, enableScheduler: false, now: () => new Date(clock.t), auth: { scryptN: 1024 } });
    opened.push({ app, db, clock });
    await app.stockService.refreshMaster();
    const owner = (await login(app, OWNER, "1111")).json().token as string;
    expect((await app.inject({ method: "POST", url: "/api/stocks", headers: S(owner), payload: { code: ownerCode, quantity: 3, avgPrice: 70000 } })).statusCode).toBe(201);
    // 주인 앱처럼: 잔고 두 번(세션 자격 캐시가 채워짐), 상세·점수 (주인 캐시)
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "GET", url: "/api/stocks?quotes=1", headers: S(owner) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/stocks/${ownerCode}/quote`, headers: S(owner) })).statusCode).toBe(200);
    await app.inject({ method: "GET", url: `/api/scores/${ownerCode}`, headers: S(owner) });
    const member = (await app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "member1", password: "abcd1234", passwordConfirm: "abcd1234", email: "m@example.com" } })).json().token as string;
    return { app, owner, member };
  }

  it("주인이 등록·조회해 둔 서버와 처음 보는 서버에서 주인 아닌 계정의 시세·상세·차트·점수 본문이 같다 (eligible·realtime·live 포함)", async () => {
    const warm = await server("005930");
    const cold = await server("000660");
    // 주인에게는 캐시가 드러난다 (이 테스트가 실제로 두 서버의 상태를 다르게 만들었는지 확인)
    const ownerQ = (await warm.app.inject({ method: "GET", url: "/api/stocks/005930/quote", headers: S(warm.owner) })).json();
    expect(ownerQ.session.eligible).toBe(false);
    expect(ownerQ.price).toBe(100_700); // 웹소켓 체결 가격
    for (const url of ["/api/stocks/005930/quote", "/api/stocks/005930", "/api/stocks/005930/candles", "/api/scores/005930", "/api/stocks/005930/news"]) {
      const a = await warm.app.inject({ method: "GET", url, headers: S(warm.member) });
      const b = await cold.app.inject({ method: "GET", url, headers: S(cold.member) });
      expect(a.statusCode, `${url} ${a.body}`).toBe(b.statusCode);
      expect(a.json(), url).toEqual(b.json());
    }
    // 세션 자격은 늘 '모름' (주인 등록 종목도), 가격은 토스 웹 가격 (웹소켓은 주인 등록 종목만 구독하므로 쓰지 않음)
    const q = (await warm.app.inject({ method: "GET", url: "/api/stocks/005930/quote", headers: S(warm.member) })).json();
    expect(q.session.eligible).toBeNull();
    expect(q.session.halted ?? null).toBeNull();
    expect(q.price).toBe(100_500);
  });

  it("같은 서버 안에서도: 주인 등록 종목(세션 자격 캐시 있음)과 처음 보는 종목의 session 이 같은 모양 (eligible null)", async () => {
    const { app, member } = await server("005930");
    const mine = (await app.inject({ method: "GET", url: "/api/stocks/005930/quote", headers: S(member) })).json();
    const other = (await app.inject({ method: "GET", url: "/api/stocks/000660/quote", headers: S(member) })).json();
    expect(mine.session).toEqual(other.session);
    expect(mine.session.eligible).toBeNull();
    expect({ realtime: mine.realtime, live: mine.live ?? false }).toEqual({ realtime: other.realtime, live: other.live ?? false });
    // 상세도 같은 규칙
    const d = (await app.inject({ method: "GET", url: "/api/stocks/005930", headers: S(member) })).json();
    expect(d.quote.session.eligible).toBeNull();
  });
});

describe("M2 (검증 5차): 지표 점수 가치 칸의 '지난 값' 날짜도 가린다 (한국 간이 가치 #94 포함)", () => {
  it("재무 받은 시각(asOf.fetchedAt)·'지난 값 M/D' 배지·'…에 받은 값' 안내의 날짜를 뺀다 — 다른 칸은 그대로", () => {
    const fetchedAt = "2026-09-27T20:10:00+09:00";
    const r = {
      code: "005930",
      computedAt: "2026-09-27T20:15:00+09:00",
      value: {
        grade: "lite",
        asOf: { fetchedAt, fiscalShort: "26.2Q" },
        flags: [{ key: "carriedForward", text: carriedText(fetchedAt) }, { key: "lossMaking", text: "적자" }],
        badges: ["간이 계산", carriedBadge(fetchedAt)],
      },
    };
    const seen = memberScoreView(r, "2026-09-28T10:00:00+09:00");
    expect(seen.computedAt).toBe("2026-09-28T10:00:00+09:00");
    expect(seen.value.asOf).toEqual({ fetchedAt: null, fiscalShort: "26.2Q" });
    expect(seen.value.flags).toEqual([{ key: "carriedForward", text: MEMBER_CARRIED_TEXT }, { key: "lossMaking", text: "적자" }]);
    expect(seen.value.badges).toEqual(["간이 계산", MEMBER_CARRIED_BADGE]);
    expect(JSON.stringify(seen)).not.toMatch(/9\/27|9월 27일|2026-09-27/);
    // 가치 칸이 없으면 시각만
    expect(memberScoreView({ computedAt: "x" }, "y")).toEqual({ computedAt: "y" });
  });
});
