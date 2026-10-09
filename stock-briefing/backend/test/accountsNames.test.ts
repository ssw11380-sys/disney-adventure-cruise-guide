import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { seoulIso } from "../src/lib/time.js";
import { MAX_PER_MINUTE, MEMBER_PER_MINUTE, MEMBERS_PER_MINUTE, AppErrorService } from "../src/services/appErrorService.js";
import { IndicatorScoreService, type ScoreSources, type ScoreStock } from "../src/services/indicatorScoreService.js";
import { benchOf, candlesOf } from "./fixtures/indicatorScores/load.js";
import { fakeProviders } from "./helpers.js";
import { NAME_CANARY, NAME_MARKS, nameCanaryProviders, OWNER_WARM_URLS, plantRegisteredNames, REGISTERED_ONLY, UNKNOWN, US_MASTER, type RecordedQuotes } from "./nameCanary.js";

/**
 * 계정 A단계 검증 8차: 주인 등록 표의 이름·시장(토스 동기화 이름 등 — 종목 마스터·검색 값과 다를 때)이 공유 캐시를 거쳐 주인 아닌 계정에게 나가지 않는다.
 *  - AI 분석(GET /api/stocks/:code/analysis/:kind): 글은 공개 이름으로 만든다. 등록 표 이름으로 만든 캐시 글은 가입자에게 주지 않고, 등록 표에만 있는 종목은 모르는 종목과 같은 404
 *  - 지표 점수(GET /api/scores/:code): 계산 자체를 공개 이름·시장으로 (이름·'기초자산 기준'·기초자산 참고 줄·상품 분류·비교 지수). 등록 표에만 있는 기초자산은 모르는 종목처럼 코드로
 *  - 앱 오류 보고(POST /api/app-errors): 주인 아닌 계정은 주인과 다른 분당 몫
 */
vi.stubEnv("ACCOUNTS_DISABLED", "");
afterAll(() => vi.unstubAllEnvs());

// 월요일 10:00 (한국) — 미국 점수 기준 거래일은 9/25(금), 기록한 일봉도 9/25 까지
const T0 = Date.parse("2026-09-28T10:00:00+09:00");
const OWNER = "서성원";
const S = (token: string) => ({ "x-session-token": token });
const PUBLIC = { "005930": "삼성전자", SOXX: US_MASTER[0]!.name, SOXL: US_MASTER[1]!.name } as const;

interface Server {
  app: FastifyInstance;
  db: Db;
  quotes: RecordedQuotes;
  owner: string;
  member: string;
  clock: { t: number };
}
const opened: Server[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) {
    await s.app.close();
    await s.db.destroy();
  }
});

/** registered: 주인이 등록하고(이름을 바꿔) 공유 캐시를 채운 서버 · 아니면 아무것도 등록하지 않은 서버 */
async function server(o: { registered: boolean; warm?: readonly string[] }): Promise<Server> {
  const clock = { t: T0 };
  const db = await createMigratedDb(":memory:");
  const p = nameCanaryProviders();
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(p), logger: false, enableScheduler: false, now: () => new Date(clock.t), auth: { scryptN: 1024 } });
  await app.stockService.refreshMaster();
  const owner = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: OWNER, password: "1111" } })).json().token as string;
  if (o.registered) {
    for (const code of ["005930", "SOXX"]) expect((await app.inject({ method: "POST", url: "/api/stocks", headers: S(owner), payload: { code, quantity: 3, avgPrice: 100 } })).statusCode).toBe(201);
    await plantRegisteredNames(db, seoulIso(new Date(T0)));
    for (const url of o.warm ?? OWNER_WARM_URLS) {
      const r = await app.inject({ method: "GET", url, headers: S(owner) });
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
    }
  }
  const member = (await app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "member1", password: "abcd1234", passwordConfirm: "abcd1234", email: "m@example.com" } })).json().token as string;
  const s = { app, db, quotes: p.quotes, owner, member, clock };
  opened.push(s);
  return s;
}

const noMarks = (body: string, label: string) => {
  for (const m of NAME_MARKS) expect(body, `${label} → ${m}`).not.toContain(m);
};

describe("AI 분석: 글은 공개 이름으로 (주인 등록 표 이름이 공유 캐시로 새지 않음)", () => {
  it("주인이 먼저 만든 캐시 글 · 가입자가 처음 만드는 글 모두 공개 이름 — 주인 글도 공개 이름으로 만든다", async () => {
    const s = await server({ registered: true, warm: ["/api/stocks/005930/analysis/company", "/api/stocks/SOXX/analysis/technical"] });
    s.clock.t += 60_000;
    // 주인 캐시 글 (주인이 등록 표 이름을 바꾼 뒤 만든 글)
    const cached = await s.app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(s.member) });
    expect(cached.statusCode, cached.body).toBe(200);
    expect(cached.json().content).toContain(`종목: ${PUBLIC["005930"]} (005930)`);
    noMarks(cached.body, "005930/company");
    // 가입자가 처음 만드는 글 (등록 표 이름·시장이 마스터와 다른 SOXX)
    for (const kind of ["technical", "value"]) {
      const r = await s.app.inject({ method: "GET", url: `/api/stocks/SOXX/analysis/${kind}`, headers: S(s.member) });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().content).toContain(`종목: ${PUBLIC.SOXX} (SOXX)`);
      expect(r.json().content).toContain('"market": "NASDAQ"');
      noMarks(r.body, `SOXX/${kind}`);
    }
    // 주인이 본 글도 같은 공개 이름 (캐시를 같이 쓴다)
    const mine = await s.app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(s.owner) });
    expect(mine.json().content).toContain(`종목: ${PUBLIC["005930"]} (005930)`);
    expect(mine.json().cached).toBe(true);
  });

  it("고치기 전에 등록 표 이름으로 만든 캐시 글은 가입자에게 주지 않고 공개 이름으로 새로 만든다 (주인에게는 그 뒤 새 글)", async () => {
    const s = await server({ registered: true, warm: [] });
    const at = seoulIso(new Date(T0));
    await s.db
      .insertInto("analyses")
      .values({ code: "005930", kind: "company", content: `종목: ${NAME_CANARY.stock} (005930) 옛 글`, data_snapshot: JSON.stringify({ stock: { code: "005930", name: NAME_CANARY.stock, market: "KOSPI" } }), missing_data: "[]", model: "old", created_at: at })
      .execute();
    // 이름은 같고 시장만 다른 옛 글도 (SOXX: 등록 표 시장 US)
    await s.db
      .insertInto("analyses")
      .values({ code: "SOXX", kind: "company", content: "옛 글 (시장 US)", data_snapshot: JSON.stringify({ stock: { code: "SOXX", name: PUBLIC.SOXX, market: "US" } }), missing_data: "[]", model: "old", created_at: at })
      .execute();
    s.clock.t += 60_000;
    const r = await s.app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(s.member) });
    expect(r.statusCode, r.body).toBe(200);
    noMarks(r.body, "옛 캐시");
    expect(r.json().content).toContain(`종목: ${PUBLIC["005930"]} (005930)`);
    const us = await s.app.inject({ method: "GET", url: "/api/stocks/SOXX/analysis/company", headers: S(s.member) });
    expect(us.json().content).not.toContain("옛 글");
    // 가입자가 새로 만든 글은 공개 이름으로 만든 것이라 다음에는 캐시로 (다시 만들지 않음)
    const n = (await s.db.selectFrom("analyses").select("id").execute()).length;
    s.clock.t += 60_000;
    await s.app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(s.member) });
    expect((await s.db.selectFrom("analyses").select("id").execute()).length).toBe(n);
    // 주인도 그 뒤로는 새 글 (가장 최근)
    expect((await s.app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(s.owner) })).json().content).not.toContain(NAME_CANARY.stock);
  });

  it("등록 표에만 있는 종목은 가입자에게 모르는 종목과 같은 404 (주인이 만든 캐시가 있어도) — 주인은 그대로 본다", async () => {
    const s = await server({ registered: true, warm: [`/api/stocks/${REGISTERED_ONLY}/analysis/company`] });
    const mine = await s.app.inject({ method: "GET", url: `/api/stocks/${REGISTERED_ONLY}/analysis/company`, headers: S(s.owner) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().content).toContain(NAME_CANARY.only);
    const a = await s.app.inject({ method: "GET", url: `/api/stocks/${REGISTERED_ONLY}/analysis/company`, headers: S(s.member) });
    const b = await s.app.inject({ method: "GET", url: `/api/stocks/${UNKNOWN}/analysis/company`, headers: S(s.member) });
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    expect(a.body.replaceAll(REGISTERED_ONLY, "X")).toBe(b.body.replaceAll(UNKNOWN, "X"));
  });

  // main #128(가치 점수 개선 1단계 [8], 플래그 valueAiSafeWording — 서버 기본 켬)과 합친 뒤: 가입자 경로(공개 이름 캐시만)에도 같은 문장 검사
  it("가치분석 문장 검사도 가입자 경로에 — 공개 이름 캐시 글은 걸린 줄을 빼고 주고, 예전 형식 글은 새로 만들며, 등록 표 이름 글은 그대로 주지 않는다", async () => {
    const s = await server({ registered: true, warm: [] });
    const at = seoulIso(new Date(T0));
    const row = (code: string, content: string, name: string, market: string) => ({ code, kind: "value", content, data_snapshot: JSON.stringify({ stock: { code, name, market } }), missing_data: "[]", model: "old", created_at: at });
    await s.db
      .insertInto("analyses")
      .values([
        // 005930: 공개 이름으로 만든 새 형식 글 + 금지어 한 줄
        row("005930", `## 주가와 재무 숫자\n종목: ${PUBLIC["005930"]} (005930)\n지금 사셔도 됩니다.`, PUBLIC["005930"], "KOSPI"),
        // SOXX: 공개 이름으로 만든 예전 프롬프트 형식 글 ('## 강점' — safe 이면 새로 만든다)
        row("SOXX", "## 강점\n좋은 회사입니다.\n## 리스크\n없음", PUBLIC.SOXX, "NASDAQ"),
      ])
      .execute();
    s.clock.t += 60_000;
    const count = async () => (await s.db.selectFrom("analyses").select("id").execute()).length;
    const n0 = await count();

    const a = await s.app.inject({ method: "GET", url: "/api/stocks/005930/analysis/value", headers: S(s.member) });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().content).toContain(`종목: ${PUBLIC["005930"]} (005930)`);
    expect(a.json().content).not.toContain("사셔도");
    expect(a.json().content).toContain("(문장 검사에서 1줄을 뺐습니다)");
    // 가림은 그대로 (번호·만든 시각·캐시 표시 = 요청 시각 값)
    expect(a.json()).toMatchObject({ id: 0, cached: false, createdAt: seoulIso(new Date(s.clock.t)) });
    expect(await count()).toBe(n0);

    const b = await s.app.inject({ method: "GET", url: "/api/stocks/SOXX/analysis/value", headers: S(s.member) });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().content).not.toContain("## 강점");
    expect(b.json().content).not.toContain("좋은 회사");
    expect(b.json().content).toContain(`종목: ${PUBLIC.SOXX} (SOXX)`);
    noMarks(b.body, "SOXX/value 새 글");
    expect(await count()).toBe(n0 + 1);

    // 등록 표 이름으로 만든 새 형식 글 (금지어 없음)도 가입자에게는 주지 않는다 — 문장 검사가 켜져 있어도 8차 규칙 그대로
    await s.db.insertInto("analyses").values(row("005930", `## 주가와 재무 숫자\n종목: ${NAME_CANARY.stock} (005930)`, NAME_CANARY.stock, "KOSPI")).execute();
    s.clock.t += 60_000;
    const c = await s.app.inject({ method: "GET", url: "/api/stocks/005930/analysis/value", headers: S(s.member) });
    expect(c.statusCode, c.body).toBe(200);
    noMarks(c.body, "005930/value 등록 표 이름 캐시 뒤");
    expect(c.json().content).toContain(`종목: ${PUBLIC["005930"]} (005930)`);
  });
});

describe("지표 점수: 계산을 공개 이름·시장으로 (기초자산 참고 줄·'기초자산 기준'·상품 분류·비교 지수)", () => {
  it("주인이 기초자산을 다른 이름·시장으로 등록해 둔 서버와 아무것도 등록하지 않은 서버에서 가입자의 점수 본문이 같다", async () => {
    const warm = await server({ registered: true });
    const cold = await server({ registered: false });
    for (const code of ["SOXL", "SOXX", "005930", "RGTX"]) {
      const a = await warm.app.inject({ method: "GET", url: `/api/scores/${code}`, headers: S(warm.member) });
      const b = await cold.app.inject({ method: "GET", url: `/api/scores/${code}`, headers: S(cold.member) });
      expect(a.statusCode, `${code} ${a.body}`).toBe(200);
      expect(b.statusCode, `${code} ${b.body}`).toBe(200);
      noMarks(a.body, code);
      expect(a.json(), code).toEqual(b.json());
    }
    // 테스트가 실제로 기초자산 참고 줄(이름 포함)을 만들었는지 — 기초자산 기준 이름은 마스터 이름
    const soxl = (await warm.app.inject({ method: "GET", url: "/api/scores/SOXL", headers: S(warm.member) })).json();
    expect(soxl.trend.basis).toEqual({ kind: "underlying", code: "SOXX", name: PUBLIC.SOXX });
    expect(soxl.trend.reference).toMatchObject({ code: "SOXX", name: PUBLIC.SOXX, status: "ok" });
    // 기초자산 SOXX 자체 점수는 마스터 시장(NASDAQ)의 비교 지수로 — 등록 표 시장(US)이면 비교 지수가 없었다
    const soxx = (await warm.app.inject({ method: "GET", url: "/api/scores/SOXX", headers: S(warm.member) })).json();
    expect(soxx.trend.benchmark).toEqual({ code: "NASDAQ", name: "나스닥" });
    // 등록 표에만 있는 기초자산(RGTI)은 모르는 종목처럼 코드로
    const rgtx = (await warm.app.inject({ method: "GET", url: "/api/scores/RGTX", headers: S(warm.member) })).json();
    expect(rgtx.trend.basis).toEqual({ kind: "underlying", code: "RGTI", name: "RGTI" });
    expect(rgtx.trend.reference).toMatchObject({ code: "RGTI", name: "RGTI" });
    // 주인이 보는 계산 결과도 같은 이름 (계산 캐시를 같이 쓴다)
    const mine = (await warm.app.inject({ method: "GET", url: "/api/scores/SOXL", headers: S(warm.owner) })).json();
    expect(mine.trend.reference.name).toBe(PUBLIC.SOXX);
    noMarks(JSON.stringify(mine), "주인 SOXL");
  });

  it("등록 표에만 있는 종목은 계산하지 않고(일봉을 받지 않음) 모르는 종목과 같은 404", async () => {
    const s = await server({ registered: true, warm: [] });
    const before = s.quotes.calls;
    const a = await s.app.inject({ method: "GET", url: `/api/scores/${REGISTERED_ONLY}`, headers: S(s.member) });
    const b = await s.app.inject({ method: "GET", url: `/api/scores/${UNKNOWN}`, headers: S(s.member) });
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    expect(a.body.replaceAll(REGISTERED_ONLY, "X")).toBe(b.body.replaceAll(UNKNOWN, "X"));
    expect(s.quotes.calls).toBe(before);
    // 주인은 등록 표 이름으로 계산해 본다
    const mine = await s.app.inject({ method: "GET", url: `/api/scores/${REGISTERED_ONLY}`, headers: S(s.owner) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().name).toBe(NAME_CANARY.only);
    // 주인이 계산해 둔 뒤에도 가입자는 404
    expect((await s.app.inject({ method: "GET", url: `/api/scores/${REGISTERED_ONLY}`, headers: S(s.member) })).statusCode).toBe(404);
  });

  it("공개 이름을 잠깐 못 찾아 등록 표 값으로 계산해 둔 결과(주인 캐시)는 가입자용으로 다시 계산한다 — 그래도 등록 표 값이면 없음", async () => {
    const db = await createMigratedDb(":memory:");
    let publicKnown = false;
    const reg: ScoreStock = { code: "SOXX", name: NAME_CANARY.underlying, market: "US", registered: true, public: false };
    const pub: ScoreStock = { code: "SOXX", name: PUBLIC.SOXX, market: "NASDAQ", groupCode: "EF", registered: true, public: true };
    const sources: ScoreSources = {
      stock: async () => (publicKnown ? pub : reg),
      candles: async (code, count) => ({ code, period: "D", candles: candlesOf(code).slice(-count), source: "yahoo" }),
      benchmark: async () => benchOf("SOXX"),
      product: async () => null,
      registered: async () => [reg],
    };
    const svc = new IndicatorScoreService({ db, features: { enabled: async () => true }, sources, now: () => new Date(T0) });
    try {
      const owner = await svc.get("SOXX");
      expect(owner?.name).toBe(NAME_CANARY.underlying);
      // 아직 공개 값을 못 찾으면 없음 (등록 표 값으로 계산한 결과를 주지 않는다)
      expect(await svc.getShared("SOXX", 10)).toBeNull();
      publicKnown = true;
      const shared = await svc.getShared("SOXX", 10);
      expect(shared?.name).toBe(PUBLIC.SOXX);
      expect(shared?.trend.benchmark?.code).toBe("NASDAQ");
      noMarks(JSON.stringify(shared), "getShared");
      // 다시 계산한 결과는 주인도 같이 쓴다
      expect((await svc.get("SOXX"))?.name).toBe(PUBLIC.SOXX);
    } finally {
      svc.stop();
      await db.destroy();
    }
  });
});

describe("앱 오류 보고: 주인 아닌 계정은 주인과 다른 분당 몫 (검증 8차)", () => {
  const batch = (n: number, tag: string) => ({ errors: Array.from({ length: n }, (_, i) => ({ kind: "js", message: `${tag}${i}` })) });

  it("가입자가 한도까지 보내도 주인 보고는 버려지지 않고, 가입자 응답은 주인 앱의 보고 수와 상관없다", async () => {
    const s = await server({ registered: false });
    const post = (token: string, payload: object) => s.app.inject({ method: "POST", url: "/api/app-errors", headers: S(token), payload });
    // 주인이 먼저 25건 보낸 1분
    expect((await post(s.owner, batch(20, "o"))).json()).toMatchObject({ saved: 20, dropped: 0 });
    expect((await post(s.owner, batch(5, "o"))).json()).toMatchObject({ saved: 5, dropped: 0 });
    // 가입자는 주인 몫과 상관없이 자기 몫(MEMBER_PER_MINUTE)까지 — 주인이 보내지 않은 서버와 같은 응답
    const m1 = await post(s.member, batch(20, "m"));
    expect(m1.statusCode).toBe(201);
    expect(m1.json()).toEqual({ saved: MEMBER_PER_MINUTE, dropped: 20 - MEMBER_PER_MINUTE, invalid: 0 });
    const m2 = await post(s.member, batch(1, "m"));
    expect(m2.statusCode).toBe(429);
    expect(m2.json()).toEqual({ saved: 0, dropped: 1, invalid: 0 });
    // 주인은 자기 몫의 남은 만큼 그대로
    expect((await post(s.owner, batch(10, "o"))).json()).toMatchObject({ saved: MAX_PER_MINUTE - 25, dropped: 10 - (MAX_PER_MINUTE - 25) });
    // 다른 서버: 주인이 아무것도 보내지 않았어도 가입자 응답은 같다
    const t = await server({ registered: false });
    const other = await t.app.inject({ method: "POST", url: "/api/app-errors", headers: S(t.member), payload: batch(20, "m") });
    expect(other.json()).toEqual(m1.json());
  });

  it("주인 아닌 계정 모두 합친 몫(MEMBERS_PER_MINUTE)을 넘으면 버리지만 주인 몫은 그대로, 다음 분에는 다시", async () => {
    const db = await createMigratedDb(":memory:");
    let t = T0;
    const svc = new AppErrorService(db, () => new Date(t));
    try {
      const e = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "js" as const, message: `e${i}` }));
      let saved = 0;
      for (let i = 1; i <= 4; i++) saved += (await svc.record(e(MEMBER_PER_MINUTE), `u${i}`)).saved;
      expect(saved).toBe(MEMBERS_PER_MINUTE);
      expect(await svc.record(e(1), "u9")).toEqual({ saved: 0, dropped: 1 });
      expect(await svc.record(e(MAX_PER_MINUTE))).toEqual({ saved: MAX_PER_MINUTE, dropped: 0 });
      t += 61_000;
      expect(await svc.record(e(1), "u9")).toEqual({ saved: 1, dropped: 0 });
    } finally {
      await db.destroy();
    }
  });
});
