import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { memberAnalysisView, memberFlowView, memberMissingText, SANITIZED_ROUTES, SHARED_ROUTES } from "../src/auth/routePolicy.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { seoulIso } from "../src/lib/time.js";
import { NaverFundamentals } from "../src/providers/market/fundamentals.js";
import type { FlowTrendRow, FlowTrendSource } from "../src/providers/market/investorFlow.js";
import type { Providers } from "../src/providers/index.js";
import { fakeProviders } from "./helpers.js";

/**
 * 계정 A단계 — main #97~#126 을 합친 뒤 새로 생긴 **공유** 경로·칸이 주인 아닌 계정에게 공유 캐시의 시각·상태를 내보내지 않는지 (검증 4~7차 M2 와 같은 규칙).
 *  - GET /api/stocks/:code/analysis/:kind/state (#97 분석 대기 복구): 주인 아닌 계정에게는 저장 글·진행 여부·요청 기록 없이 늘 같은 모양
 *  - GET /api/stocks/:code/analysis/:kind: requestId·refresh 를 보지 않고, 보고서에 쓴 시세 시각(verification.quoteAsOf)·재무 수신 시각을 뺀다
 *  - GET /api/investor-flow/:code (#122 수급 탭): 받은 시각은 요청 시각, 대조 기록 없음, 옛 캐시(stale)는 처음 보는 종목처럼 502
 *  - 시세·종목 상세의 재무 보강 수신 시각(#103 fundamentalsBasis.receivedAt)은 늘 null
 * 새 개인 경로(관심종목·관심 그룹·매매일지·일정·공시·내 종목 테마)는 test/routePolicy.test.ts 의 경로 전수·카나리아가 본다
 */
vi.stubEnv("ACCOUNTS_DISABLED", "");
afterAll(() => vi.unstubAllEnvs());

const T0 = Date.parse("2026-09-28T10:00:00+09:00"); // 월요일 장중 — 수급 캐시 10분
const MIN = 60_000;
const S = (token: string) => ({ "x-session-token": token });

interface Ctx {
  app: FastifyInstance;
  db: Db;
  clock: { t: number };
  owner: string;
  member: string;
}
const opened: Ctx[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) {
    await c.app.close();
    await c.db.destroy();
  }
});

async function seeded(over: Partial<Providers> = {}): Promise<Ctx> {
  const clock = { t: T0 };
  const db = await createMigratedDb(":memory:");
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(over), logger: false, enableScheduler: false, now: () => new Date(clock.t), auth: { scryptN: 1024 } });
  await app.stockService.refreshMaster();
  const owner = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: "서성원", password: "1111" } })).json().token as string;
  expect((await app.inject({ method: "POST", url: "/api/stocks", headers: S(owner), payload: { code: "005930", quantity: 3, avgPrice: 70000 } })).statusCode).toBe(201);
  const member = (await app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "member1", password: "abcd1234", passwordConfirm: "abcd1234", email: "m@example.com" } })).json().token as string;
  const c = { app, db, clock, owner, member };
  opened.push(c);
  return c;
}

const count = async (db: Db, table: "analyses") => Number((await db.selectFrom(table).select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);

describe("새 공유 경로는 가림 목록에 있다", () => {
  it("분석 대기 상태·수급 탭은 공유(SHARED)이면서 가림(SANITIZED)", () => {
    for (const k of ["GET /api/stocks/:code/analysis/:kind/state", "GET /api/investor-flow/:code"]) {
      expect(SHARED_ROUTES.has(k), k).toBe(true);
      expect(SANITIZED_ROUTES.has(k), k).toBe(true);
    }
  });
});

describe("분석 대기 복구 (#97, 플래그 analysisWaitRecovery)", () => {
  it("상태 경로: 주인은 저장 글·진행 여부를 보고, 주인 아닌 계정은 주인이 만든 종목이든 처음 보는 종목이든 늘 같은 빈 모양 (요청 ID 는 '모름')", async () => {
    const { app, clock, owner, member } = await seeded();
    expect((await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(owner) })).statusCode).toBe(200);
    clock.t += 5 * MIN;
    const mine = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company/state", headers: S(owner) });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().latest).toMatchObject({ code: "005930", kind: "company", cached: true, createdAt: seoulIso(new Date(T0)) });
    const bodies: string[] = [];
    for (const code of ["005930", "000660"]) {
      const r = await app.inject({ method: "GET", url: `/api/stocks/${code}/analysis/company/state`, headers: S(member) });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ latest: null, running: false });
      bodies.push(r.body);
      const tracked = await app.inject({ method: "GET", url: `/api/stocks/${code}/analysis/company/state?requestId=a-member-request-0001`, headers: S(member) });
      expect(tracked.json()).toEqual({ latest: null, running: false, request: { id: "a-member-request-0001", status: "unknown", result: null } });
    }
    expect(bodies[0]).toBe(bodies[1]);
    // 세션 없음은 그대로 막힌다
    expect((await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company/state" })).json().code).toBe("session_required");
  });

  it("플래그를 끄면 상태 경로는 주인·주인 아닌 계정 모두 404 (예전과 같음)", async () => {
    const { app, owner, member } = await seeded();
    await app.inject({ method: "PUT", url: "/api/admin/features", headers: S(owner), payload: { analysisWaitRecovery: false } });
    for (const who of [owner, member]) expect((await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company/state", headers: S(who) })).statusCode).toBe(404);
  });

  it("주인 아닌 계정의 분석 요청은 requestId·refresh 를 보지 않는다 — 새로 만들지 않고, 시세 시각은 '제공되지 않음'(null)", async () => {
    const { app, db, clock, owner, member } = await seeded();
    const made = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: S(owner) });
    expect(made.json().verification?.scope).toBe("quote_claims");
    const before = await count(db, "analyses");
    clock.t += 2 * MIN;
    const r = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company?refresh=1&requestId=a-member-request-0002", headers: S(member) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: 0, cached: false, createdAt: seoulIso(new Date(clock.t)) });
    expect(r.json().verification).toMatchObject({ scope: "quote_claims", quoteAsOf: null });
    expect(await count(db, "analyses")).toBe(before);
    // 주인의 요청 추적은 그대로 (같은 요청 ID 를 다시 물으면 같은 결과)
    const tracked = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company?requestId=a-owner-request-0001", headers: S(owner) });
    expect(tracked.json()).toMatchObject({ id: made.json().id, cached: true });
    const state = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company/state?requestId=a-owner-request-0001", headers: S(owner) });
    expect(state.json().request).toMatchObject({ id: "a-owner-request-0001", status: "completed" });
  });

  it("memberAnalysisView: 재무 보강 수신 시각을 '이전 수신 자료'로, 환율·다른 줄은 그대로, 시세 시각은 null", () => {
    expect(memberMissingText("재무 보강 갱신 실패(2026-09-28T09:30:00+09:00 수신 자료 사용)")).toBe("재무 보강 갱신 실패(이전 수신 자료 사용)");
    for (const same of ["재무 보강 갱신 실패(사용할 이전 자료 없음)", "환율 갱신 실패(2026-09-28T09:00:00+09:00 수신 자료 사용)", "뉴스"]) expect(memberMissingText(same)).toBe(same);
    const a = { id: 7, code: "005930", kind: "company", createdAt: "x", cached: true, missing: ["재무 보강 갱신 실패(2026-09-28T09:30:00+09:00 수신 자료 사용)"], verification: { scope: "quote_claims", quoteAsOf: "2026-09-28T09:30:00+09:00", quoteSource: "kis", checkedClaims: 1, issues: [] } };
    expect(memberAnalysisView(a, "now")).toEqual({ ...a, id: 0, createdAt: "now", cached: false, missing: ["재무 보강 갱신 실패(이전 수신 자료 사용)"], verification: { ...a.verification, quoteAsOf: null } });
    // 예전 모양(칸 없음)은 칸을 새로 만들지 않는다
    expect(memberAnalysisView({ id: 1, createdAt: "x", cached: true }, "now")).toEqual({ id: 0, createdAt: "now", cached: false });
  });
});

// ───────────────────────────── 수급 탭 (#122) ─────────────────────────────

const ROWS: FlowTrendRow[] = ["2026-09-25", "2026-09-24", "2026-09-23"].map((date) => ({
  date, individual: 10, foreign: -4, institution: -6, otherCorp: 0, foreignRatio: 50.1, foreignHolding: null, foreignLimit: null, close: 70000, inMarketTime: false, hasAll: true, updatedAt: `${date}T20:15:40.000+09:00`,
}));
class Flow implements FlowTrendSource {
  fail = false;
  calls = 0;
  constructor(readonly name: string) {}
  async trend(): Promise<FlowTrendRow[]> {
    this.calls++;
    if (this.fail) throw new Error("고의 실패");
    return ROWS;
  }
}

describe("수급 탭 GET /api/investor-flow/:code (#122) — 주인 아닌 계정", () => {
  it("캐시 안(10분)에서는 받은 시각 대신 요청 시각 — 주인이 먼저 연 종목과 처음 보는 종목이 같은 모양. 주인은 캐시 그대로", async () => {
    const toss = new Flow("toss-web");
    const { app, clock, owner, member } = await seeded({ investorFlowSources: { tossWeb: toss, naver: new Flow("naver") } });
    const mine = await app.inject({ method: "GET", url: "/api/investor-flow/005930", headers: S(owner) });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json()).toMatchObject({ supported: true, source: "toss-web", fetchedAt: seoulIso(new Date(T0)), stale: false });
    clock.t += 3 * MIN;
    const now = seoulIso(new Date(clock.t));
    const cached = await app.inject({ method: "GET", url: "/api/investor-flow/005930", headers: S(member) });
    const fresh = await app.inject({ method: "GET", url: "/api/investor-flow/000660", headers: S(member) });
    expect(toss.calls).toBe(2); // 005930 은 캐시에서 (출처를 다시 부르지 않음)
    for (const r of [cached, fresh]) {
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ supported: true, fetchedAt: now, stale: false, check: null });
      expect(r.headers["server-timing"]).toBeUndefined();
    }
    const { code: _a, ...c } = cached.json();
    const { code: _b, ...f } = fresh.json();
    expect(c).toEqual(f);
    expect(cached.json().days).toEqual(mine.json().days);
    // 주인은 받은 시각 그대로
    expect((await app.inject({ method: "GET", url: "/api/investor-flow/005930", headers: S(owner) })).json().fetchedAt).toBe(seoulIso(new Date(T0)));
  });

  it("두 출처 모두 실패해 옛 캐시(stale)만 있으면: 주인은 옛 값(stale), 주인 아닌 계정은 처음 보는 종목과 같은 502", async () => {
    const toss = new Flow("toss-web");
    const naver = new Flow("naver");
    const { app, clock, owner, member } = await seeded({ investorFlowSources: { tossWeb: toss, naver } });
    expect((await app.inject({ method: "GET", url: "/api/investor-flow/005930", headers: S(owner) })).statusCode).toBe(200);
    clock.t += 11 * MIN;
    toss.fail = true;
    naver.fail = true;
    const seen = await app.inject({ method: "GET", url: "/api/investor-flow/005930", headers: S(member) });
    const first = await app.inject({ method: "GET", url: "/api/investor-flow/000660", headers: S(member) });
    for (const r of [seen, first]) {
      expect(r.statusCode, r.body).toBe(502);
      expect(r.json().error).toBe("UPSTREAM");
    }
    expect(seen.body).toBe(first.body);
    const mine = await app.inject({ method: "GET", url: "/api/investor-flow/005930", headers: S(owner) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ stale: true, fetchedAt: seoulIso(new Date(T0)) });
  });

  it("memberFlowView: 대조 기록을 빼고, 받은 시각과 같은 asOf(네이버·고친 시각 없는 줄)만 요청 시각으로 — 출처가 줄을 고친 시각은 그대로. 미국(supported:false)은 그대로", () => {
    const toss = { code: "005930", supported: true, source: "toss-web", asOf: "2026-09-25T20:15:40+09:00", fetchedAt: "2026-09-28T10:00:00+09:00", stale: false, check: { at: "2026-09-28T10:00:01+09:00", days: 20, same: 20 } };
    expect(memberFlowView(toss, "now")).toEqual({ ...toss, fetchedAt: "now", check: null });
    const naver = { ...toss, source: "naver", asOf: toss.fetchedAt, check: null };
    expect(memberFlowView(naver, "now")).toEqual({ ...naver, asOf: "now", fetchedAt: "now" });
    const us = { code: "AAPL", supported: false, reason: "x" };
    expect(memberFlowView(us, "now")).toBe(us);
  });
});

// ───────────────────────────── 재무 보강 수신 시각 (#103) ─────────────────────────────

describe("시세·종목 상세의 재무 보강 수신 시각 (fundamentalsBasis.receivedAt) — 주인 아닌 계정은 늘 null", () => {
  it("주인이 데워 둔 재무 캐시(받은 시각 T0)든 처음 받는 종목이든 null, 주인은 받은 시각 그대로", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ totalInfos: [{ code: "per", value: "15" }, { code: "pbr", value: "1.2" }] })));
    const fundamentals = new NaverFundamentals(fetcher as unknown as typeof fetch, () => new Date(T0), 60 * MIN);
    const { app, clock, owner, member } = await seeded({ fundamentals });
    const mine = await app.inject({ method: "GET", url: "/api/stocks/005930/quote", headers: S(owner) });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().fundamentalsBasis).toMatchObject({ receivedAt: seoulIso(new Date(T0)), fields: expect.arrayContaining(["per", "pbr"]) });
    clock.t += 20_000;
    for (const url of ["/api/stocks/005930/quote", "/api/stocks/000660/quote"]) {
      const r = await app.inject({ method: "GET", url, headers: S(member) });
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
      expect(r.json().fundamentalsBasis, url).toMatchObject({ receivedAt: null, refreshFailed: false, fields: expect.arrayContaining(["per", "pbr"]) });
    }
    const detail = await app.inject({ method: "GET", url: "/api/stocks/005930", headers: S(member) });
    expect(detail.json().quote.fundamentalsBasis.receivedAt).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/stocks/005930/quote", headers: S(owner) })).json().fundamentalsBasis.receivedAt).toBe(seoulIso(new Date(T0)));
  });
});
