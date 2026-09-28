import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Providers } from "../src/providers/index.js";
import type { ScoreSources, ScoreStock } from "../src/services/indicatorScoreService.js";
import { benchOf, candlesOf } from "./fixtures/indicatorScores/load.js";
import { fakeProviders } from "./helpers.js";

/**
 * 계정 A단계 검증 9차:
 *  - 보는 사람을 모르면 주인 아님 (닫힌 쪽으로): 계정이 켜져 있는데 관문이 보는 사람(req.auth)을 채우기 전에 끝난 응답
 *    (세션 끊김 401 · API 토큰 401 · 없는 주소 404 — /api 안팎)에는 서버 처리 시간 머리글(Server-Timing)을 붙이지 않는다.
 *    계정이 꺼져 있으면(관리 API 로 끔 · 비상 끄기 ACCOUNTS_DISABLED=1) 예전처럼 API 토큰 = 주인이라 붙인다 (주인 아닌 계정의 세션을 보낸 요청만 빼고)
 *  - 주인 아닌 계정의 지표 점수 요청은 주인 하루 기록(indicator_scores)을 쓰지 않는다
 */
vi.stubEnv("ACCOUNTS_DISABLED", "");
afterAll(() => vi.unstubAllEnvs());

const T0 = Date.parse("2026-09-28T10:00:00+09:00");
const OWNER = "서성원";
const API = "tok-9th";

interface Ctx {
  app: FastifyInstance;
  db: Db;
}
const opened: Ctx[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) {
    await c.app.close();
    await c.db.destroy();
  }
});

async function makeApp(env: Record<string, string> = {}, providers: Providers = fakeProviders()): Promise<Ctx> {
  const db = await createMigratedDb(":memory:");
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:", ...env }), db, providers, logger: false, enableScheduler: false, now: () => new Date(T0), auth: { scryptN: 1024 } });
  const c = { app, db };
  opened.push(c);
  return c;
}

const S = (token: string) => ({ "x-session-token": token });
const timing = (r: { headers: Record<string, unknown> }) => r.headers["server-timing"];

async function withUsers(env: Record<string, string> = {}, headers: Record<string, string> = {}, providers?: Providers) {
  const c = await makeApp(env, providers);
  await c.app.stockService.refreshMaster();
  const owner = (await c.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { loginId: OWNER, password: "1111" } } as InjectOptions)).json().token as string;
  expect(owner).toBeTruthy();
  const member = (await c.app.inject({ method: "POST", url: "/api/auth/signup", headers, payload: { loginId: "member1", password: "abcd1234", passwordConfirm: "abcd1234", email: "m@example.com" } } as InjectOptions)).json().token as string;
  expect(member).toBeTruthy();
  return { ...c, owner, member };
}

describe("검증 9차: 계정이 켜져 있으면 보는 사람을 모르는 응답은 주인 아님 — 서버 처리 시간 머리글 없음", () => {
  it("관문이 채우기 전에 끝난 응답(세션 끊김 401 · 없는 주소 404 — /api 안팎)에는 없다. 주인 세션의 공유 경로에는 있다", async () => {
    const { app, owner } = await withUsers();
    const mine = await app.inject({ method: "GET", url: "/api/stocks/005930", headers: S(owner) });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(timing(mine)).toMatch(/^app;dur=/);
    const cases: Array<[string, InjectOptions, number]> = [
      ["끊긴 세션", { method: "GET", url: "/api/stocks/005930", headers: S("no-such-session") }, 401],
      ["세션 없음", { method: "GET", url: "/api/stocks/005930" }, 403],
      ["없는 /api 주소 (주인 세션이어도 관문이 보지 않음)", { method: "GET", url: "/api/no-such-route", headers: S(owner) }, 404],
      ["없는 주소", { method: "GET", url: "/no-such-page", headers: S(owner) }, 404],
      ["/health 세션 없음", { method: "GET", url: "/health" }, 200],
    ];
    for (const [name, req, status] of cases) {
      const r = await app.inject(req);
      expect(r.statusCode, `${name} ${r.body}`).toBe(status);
      expect(timing(r), name).toBeUndefined();
    }
    // /health 주인 세션은 주인 보기
    expect(timing(await app.inject({ method: "GET", url: "/health", headers: S(owner) }))).toMatch(/^app;dur=/);
  });

  it("API 토큰이 틀려 관문 전에 401 로 끝난 응답에도 없다 (API 토큰 + 주인 세션이면 있다)", async () => {
    const bearer = { authorization: `Bearer ${API}` };
    const { app, owner } = await withUsers({ API_TOKEN: API }, bearer);
    const denied = await app.inject({ method: "GET", url: "/api/stocks/005930", headers: S(owner) });
    expect(denied.statusCode).toBe(401);
    expect(timing(denied)).toBeUndefined();
    const ok = await app.inject({ method: "GET", url: "/api/stocks/005930", headers: { ...bearer, ...S(owner) } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(timing(ok)).toMatch(/^app;dur=/);
  });

  it("계정을 관리 API 로 끄면 예전처럼 API 토큰 = 주인 — 없는 주소·세션 없는 요청에도 있다, 주인 아닌 계정의 세션을 보낸 요청만 없다", async () => {
    const { app, owner, member } = await withUsers();
    expect((await app.inject({ method: "PUT", url: "/api/admin/features", headers: S(owner), payload: { accounts: false } })).statusCode).toBe(200);
    for (const req of [{ method: "GET", url: "/api/stocks/005930" }, { method: "GET", url: "/api/no-such-route" }, { method: "GET", url: "/no-such-page" }, { method: "GET", url: "/health" }] as InjectOptions[]) {
      const r = await app.inject(req);
      expect(timing(r), `${req.url} ${r.statusCode}`).toMatch(/^app;dur=/);
    }
    const m = await app.inject({ method: "GET", url: "/api/stocks/005930", headers: S(member) });
    expect(m.statusCode, m.body).toBe(200);
    expect(timing(m)).toBeUndefined();
  });

  it("비상 끄기(ACCOUNTS_DISABLED=1)도 예전처럼 — API 토큰 401 · 없는 주소 · 공유 경로 모두 있다", async () => {
    const { app } = await makeApp({ ACCOUNTS_DISABLED: "1", API_TOKEN: API });
    await app.stockService.refreshMaster();
    const bearer = { authorization: `Bearer ${API}` };
    for (const [req, status] of [
      [{ method: "GET", url: "/api/stocks/005930" }, 401],
      [{ method: "GET", url: "/api/stocks/005930", headers: bearer }, 200],
      [{ method: "GET", url: "/api/no-such-route", headers: bearer }, 404],
      [{ method: "GET", url: "/no-such-page" }, 404],
    ] as Array<[InjectOptions, number]>) {
      const r = await app.inject(req);
      expect(r.statusCode, `${req.url} ${r.body}`).toBe(status);
      expect(timing(r), `${req.url} ${r.statusCode}`).toMatch(/^app;dur=/);
    }
  });
});

describe("검증 9차: 주인 아닌 계정의 지표 점수 요청은 주인 하루 기록(indicator_scores)을 쓰지 않는다", () => {
  // 주인 등록 종목(registered 를 비워 둠 = 등록 종목)을 기록한 일봉으로
  const NVDA: ScoreStock = { code: "NVDA", name: "엔비디아", market: "NASDAQ" };
  const scoreSources = (): ScoreSources => ({
    stock: async (code) => (code === "NVDA" ? NVDA : null),
    candles: async (code, count) => ({ code, period: "D", candles: candlesOf(code).slice(-count), source: "yahoo" }),
    benchmark: async (code) => (code === "NASDAQ" ? benchOf("NVDA") : null),
    product: async () => null,
    registered: async () => [NVDA],
  });
  const rows = (db: Db) => db.selectFrom("indicator_scores").select(["code", "kind", "score_date"]).orderBy("code").orderBy("kind").execute();

  it("주인 등록 종목을 가입자가 먼저 열어도 표는 그대로 — 주인이 같은 결과를 받을 때 남는다", async () => {
    const { app, db, owner, member } = await withUsers({}, {}, fakeProviders({ scoreSources: scoreSources() }));
    expect(await rows(db)).toEqual([]);
    const m = await app.inject({ method: "GET", url: "/api/scores/NVDA", headers: S(member) });
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json().trend).toMatchObject({ status: "ok", score: 69 });
    expect(await rows(db)).toEqual([]);
    // 주인이 열면 (같은 기준 거래일 결과) 그때 남긴다
    const mine = await app.inject({ method: "GET", url: "/api/scores/NVDA", headers: S(owner) });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(await rows(db)).toEqual([{ code: "NVDA", kind: "trend", score_date: "2026-09-25" }]);
  });
});
