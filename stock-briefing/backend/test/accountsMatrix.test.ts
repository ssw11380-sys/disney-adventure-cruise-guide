import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AUTH_ROUTES, NO_SESSION_ROUTES, routeKey } from "../src/auth/routePolicy.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { summaryLines, type MarketSummaryData } from "../src/services/marketSummaryCalc.js";
import type { MarketSummarySources } from "../src/services/marketSummaryService.js";
import { fakeProviders } from "./helpers.js";
import { MEMBER_VARIANTS, NAME_CANARY, NAME_MARKS, nameCanaryProviders, OWNER_WARM_URLS, plantRegisteredNames } from "./nameCanary.js";

/**
 * 계정 A단계 검증 4차 (M1): **API 토큰만으로는 주인 개인 데이터가 절대 나가지 않는다** (API 토큰은 앱 묶음 안에 있어 앱을 가진 누구나 꺼낼 수 있다).
 * 등록된 모든 경로 × 보는 사람 {주인 세션 · 주인 아닌 계정 세션 · 아무것도 없음 · 기한 지난 세션 · 끊긴(로그아웃한) 세션 · API 토큰만} 을 모두 불러
 *  - 주인 세션 말고는 어떤 응답에도 주인 표시(카나리아)가 없다
 *  - API 토큰만: 세션 없이 여는 경로(플래그·로그인·가입) 말고는 403 session_required — 로그아웃한·세션이 끝난·다시 설치한 폰과 같다
 *  - 기한 지난·끊긴 세션: 401 session_invalid (앱이 로그아웃하는 유일한 응답)
 *  - 아무것도 없음: API 토큰 확인에서 401 UNAUTHORIZED
 *  - 쓰기 경로는 주인 표의 행 수를 바꾸지 않는다
 * 요청 한 번씩 부르는 행렬이라 실시간 스트림은 **연결 시점**(업그레이드 전 거절)까지다. 이미 열린 연결이 세션이 끝난 뒤 닫히는지는
 * test/accountsStream.test.ts (검증 6차 — 로그아웃·모든 기기·비밀번호 변경·되돌리기·기한 지남·비상 → 보통 모드)
 * 비상 모드(ACCOUNTS_DISABLED=1 · 플래그 끔)는 문서(설계 5장) 그대로: API 토큰만 = 주인 (계정 전과 같음 — 가입자가 있으면 켜기 전에 API 토큰을 바꾼다),
 * 주인 아닌 계정의 세션(살아 있음·기한 지남·끊김)을 보낸 요청만 그 계정으로 막는다
 * 등록 표 이름 카나리아(검증 8차, test/nameCanary): 주인 등록 표 이름·시장을 마스터와 다르게 두고 주인이 공유 캐시(분석 글·점수)를 먼저 채운 뒤,
 * :code 가 있는 경로는 여러 종목(레버리지 상품·기초자산·등록 표에만 있는 종목)으로 부른다 — 가짜 모델은 분석 글에 종목 이름을 쓴다
 */
vi.stubEnv("ACCOUNTS_DISABLED", "");
afterAll(() => vi.unstubAllEnvs());

const API_TOKEN = "matrix-api-token-7f3";
const T0 = Date.parse("2026-09-23T16:30:00+09:00");
const HOUR = 3_600_000;
const CANARY = "OWNER-CANARY-7f3";
const CANARY_NAME = NAME_CANARY.stock;
const CANARY_PUSH = "ExponentPushToken[canary7f3]";
const MARKS = [CANARY, "canary7f3", "777.77", ...NAME_MARKS];

type Viewer = "owner" | "member" | "none" | "expired" | "revoked" | "tokenOnly";

interface World {
  app: FastifyInstance;
  db: Db;
  clock: { t: number };
  tokens: { owner: string; member: string; short: string; revoked: string };
  ids: { briefing: number; account: number; summary: number; alert: number };
}

function summaryWithCanary(): MarketSummaryData {
  const fx = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: Array<{ data: MarketSummaryData }> };
  const d = structuredClone(fx.cases[1]!.data);
  d.holdings!.high[0]!.name = CANARY_NAME;
  return d;
}

async function world(env: Record<string, string> = {}, db0?: Db): Promise<World> {
  const clock = { t: T0 };
  const db = db0 ?? (await createMigratedDb(":memory:"));
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN, ...env }),
    db,
    providers: fakeProviders({ ...nameCanaryProviders(), marketSummary: {} as MarketSummarySources, discover: new NaverDiscover(async () => Promise.reject(new Error("네트워크 없음"))) }),
    logger: false,
    enableScheduler: false,
    now: () => new Date(clock.t),
    auth: { scryptN: 1024 },
  });
  return { app, db, clock, tokens: { owner: "", member: "", short: "", revoked: "" }, ids: { briefing: 0, account: 0, summary: 0, alert: 0 } };
}

const bearer = { authorization: `Bearer ${API_TOKEN}` };

async function seed(w: World): Promise<void> {
  const { app, db } = w;
  await app.stockService.refreshMaster();
  const login = async (remember: boolean) => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", headers: bearer, payload: { loginId: "서성원", password: "1111", remember } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().token as string;
  };
  w.tokens.owner = await login(true);
  w.tokens.short = await login(false);
  w.tokens.revoked = await login(true);
  const o = { ...bearer, "x-session-token": w.tokens.owner };
  expect((await app.inject({ method: "POST", url: "/api/stocks", headers: o, payload: { code: "005930", quantity: 777.77, avgPrice: 70000, memo: CANARY } })).statusCode).toBe(201);
  const alert = await app.inject({ method: "POST", url: "/api/price-alerts", headers: o, payload: { code: "005930", kind: "priceAbove", value: 91200 } });
  expect(alert.statusCode, alert.body).toBe(201);
  expect((await app.inject({ method: "POST", url: "/api/devices", headers: o, payload: { token: CANARY_PUSH, platform: "android", deviceName: CANARY } })).statusCode).toBeLessThan(300);
  const ts = "2026-09-23T16:00:00+09:00";
  const b = await db
    .insertInto("briefings")
    .values({ code: "005930", session: "afternoon", briefing_date: "2026-09-23", status: "ok", summary: `${CANARY} 보유 777.77주`, detail: CANARY, data_snapshot: JSON.stringify({ holding: { quantity: 777.77, memo: CANARY } }), missing_data: "[]", model: "fake", error: null, created_at: ts })
    .returning("id")
    .executeTakeFirstOrThrow();
  const a = await db
    .insertInto("account_briefings")
    .values({ briefing_date: "2026-09-23", session: "afternoon", status: "ok", summary: `${CANARY} 계좌`, detail: CANARY, data: JSON.stringify({ top: [{ name: CANARY_NAME }] }), model: "template", created_at: ts })
    .returning("id")
    .executeTakeFirstOrThrow();
  const data = summaryWithCanary();
  const summary = summaryLines(data, new Date(ts)).map((l) => l.text).join("\n");
  const s = await db.insertInto("market_summaries").values({ summary_date: "2026-09-23", session: "afternoon", market: "KR", status: "ok", summary, data: JSON.stringify(data), created_at: ts }).returning("id").executeTakeFirstOrThrow();
  await db
    .insertInto("account_snapshots")
    .values({ snapshot_date: "2026-09-23", market: "KR", status: "ok", method: "close", as_of: ts, scheduled_at: ts, source: "toss-openapi", reason: null, holdings_count: 1, total_value_krw: 777.77, data: JSON.stringify({ memo: CANARY }), created_at: ts, updated_at: ts })
    .execute();
  // 등록 표 이름 카나리아: 토스 동기화처럼 이름·시장을 마스터와 다르게 + 등록 표에만 있는 종목·기초자산, 그다음 주인이 공유 캐시를 채운다
  expect((await app.inject({ method: "POST", url: "/api/stocks", headers: o, payload: { code: "SOXX", quantity: 1, avgPrice: 100 } })).statusCode).toBe(201);
  await plantRegisteredNames(db, ts);
  for (const url of OWNER_WARM_URLS) expect((await app.inject({ method: "GET", url, headers: o })).statusCode, url).toBe(200);
  const signup = await app.inject({ method: "POST", url: "/api/auth/signup", headers: bearer, payload: { loginId: "newbie", password: "abcd1234", passwordConfirm: "abcd1234", email: "n@example.com" } });
  expect(signup.statusCode, signup.body).toBe(201);
  w.tokens.member = signup.json().token as string;
  // 끊긴 세션: 그 기기에서 로그아웃
  expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...bearer, "x-session-token": w.tokens.revoked } })).statusCode).toBe(204);
  w.ids = { briefing: Number(b.id), account: Number(a.id), summary: Number(s.id), alert: Number(alert.json().id) };
}

function headersOf(w: World, v: Viewer): Record<string, string> {
  switch (v) {
    case "owner":
      return { ...bearer, "x-session-token": w.tokens.owner };
    case "member":
      return { ...bearer, "x-session-token": w.tokens.member };
    case "expired":
      return { ...bearer, "x-session-token": w.tokens.short };
    case "revoked":
      return { ...bearer, "x-session-token": w.tokens.revoked };
    case "tokenOnly":
      return { ...bearer };
    case "none":
      return {};
  }
}

function fill(url: string, w: World, v: { code: string; kind: string } = MEMBER_VARIANTS[0]!): string {
  return url
    .replace("/api/briefings/:id", `/api/briefings/${w.ids.briefing}`)
    .replace("/api/account-briefings/:id", `/api/account-briefings/${w.ids.account}`)
    .replace("/api/market-summaries/:id", `/api/market-summaries/${w.ids.summary}`)
    .replace("/api/price-alerts/:id", `/api/price-alerts/${w.ids.alert}`)
    .replace(":code", v.code)
    .replace(":kind", v.kind)
    .replace(":market", "KR")
    .replace(":category", "up")
    .replace(":id", "1")
    .replace(":name", "backup-20260923-000000.sbk")
    .replace(":token", encodeURIComponent(CANARY_PUSH));
}

const PAYLOAD = { code: "000660", quantity: 1, token: "ExponentPushToken[intruder]", kind: "priceAbove", value: 1, session: "morning", accounts: false, items: {}, errors: [], email: "x@example.com", current: "1111", next: "abcd1234", nextConfirm: "abcd1234" };

const TABLES = ["registered_stocks", "price_alerts", "devices", "briefings", "account_briefings", "market_summaries", "account_snapshots", "meta", "users"] as const;
async function counts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number((await sql<{ n: number }>`select count(*) as n from ${sql.table(t)}`.execute(db)).rows[0]?.n ?? 0);
  return out;
}

const allKeys = (w: World) => [...new Set(w.app.routeList.filter((r) => r.url.startsWith("/api")).map((r) => routeKey(r.method, r.url)))].sort();

/** 부르면 이 사람의 세션이 끝나는 경로 — 행렬 맨 끝에 따로 부른다 */
const ENDS_SESSION = new Set(["POST /api/auth/logout", "POST /api/auth/logout-all"]);

/** 경로 하나를 부른다 — :code · :kind 가 있는 GET 은 종목 여러 벌로 (등록 표 이름 카나리아) */
async function call(w: World, key: string, v: Viewer) {
  const [method, url] = key.split(" ") as [string, string];
  const variants = method === "GET" && /:code|:kind/.test(url) ? MEMBER_VARIANTS : [MEMBER_VARIANTS[0]!];
  const out = [];
  for (const x of variants) {
    const at = fill(url, w, x);
    out.push({ at, r: await w.app.inject({ method: method as "GET", url: at, headers: headersOf(w, v), ...(method === "GET" ? {} : { payload: PAYLOAD }) }) });
  }
  return out;
}

describe("M1 경로 × 보는 사람 행렬 (계정 켜짐 · API 토큰 있음)", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    await seed(w);
    // 자동 로그인을 끈 세션(12시간)이 지나도록 — 다른 세션(1년)은 그대로
    w.clock.t += 13 * HOUR;
  });
  afterEach(async () => {
    await w.app.close();
    await w.db.destroy();
  });

  it("주인 세션은 심은 데이터를 본다 (카나리아가 제대로 심겼는지)", async () => {
    for (const url of ["/api/stocks", "/api/widget", `/api/briefings/${w.ids.briefing}`, "/api/devices", "/api/market-summaries"]) {
      const r = await w.app.inject({ method: "GET", url, headers: headersOf(w, "owner") });
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
      expect(MARKS.some((m) => r.body.includes(m)), url).toBe(true);
    }
  });

  for (const v of ["tokenOnly", "none", "expired", "revoked", "member"] as const) {
    it(`${v}: 모든 경로(모든 메서드)에 주인 표시가 없고, 쓰기는 주인 표를 바꾸지 않는다`, async () => {
      const before = await counts(w.db);
      const leaks: string[] = [];
      const statuses: Record<string, number> = {};
      const keys = allKeys(w).filter((k) => !ENDS_SESSION.has(k));
      for (const key of [...keys, ...allKeys(w).filter((k) => ENDS_SESSION.has(k))]) {
        for (const { at, r } of await call(w, key, v)) {
          const where = `${key} (${at})`;
          statuses[key] = Math.min(statuses[key] ?? 999, r.statusCode);
          for (const m of MARKS) if (r.body.includes(m)) leaks.push(`${where} → ${m}`);
          const open = NO_SESSION_ROUTES.has(key);
          if (v === "none") expect(r.json(), where).toMatchObject({ error: "UNAUTHORIZED" });
          else if (v === "tokenOnly") {
            if (!open && key !== "POST /api/auth/logout") {
              expect(r.statusCode, `${where} ${r.body}`).toBe(403);
              expect(r.json().code, where).toBe("session_required");
            }
          } else if (v === "expired" || v === "revoked") {
            if (!open) {
              expect(r.statusCode, `${where} ${r.body}`).toBe(401);
              expect(r.json().code, where).toBe("session_invalid");
            }
          } else if (!AUTH_ROUTES.has(key) && r.statusCode < 300) {
            // 주인 아닌 계정: 성공한 개인 경로는 빈 값뿐 (표시 검사가 위에서 본다)
            expect(r.statusCode, where).toBe(200);
          }
        }
      }
      expect(leaks).toEqual([]);
      expect(await counts(w.db)).toEqual(before);
      // 세션이 없거나 끝난 폰: 개인 데이터를 주는 성공 응답이 하나도 없다
      if (v !== "member") expect(Object.entries(statuses).filter(([k, s]) => s < 300 && !NO_SESSION_ROUTES.has(k) && k !== "POST /api/auth/logout")).toEqual([]);
    });
  }

  it("/health · / : 주인 세션만 상세, 나머지는 공유 모습·제한 모습 (주인 표시 없음)", async () => {
    for (const v of ["tokenOnly", "none", "expired", "revoked", "member"] as const) {
      const h = await w.app.inject({ method: "GET", url: "/health", headers: headersOf(w, v) });
      expect(h.statusCode).toBe(200);
      expect(h.json(), v).not.toHaveProperty("devices");
      expect(h.json(), v).not.toHaveProperty("tossOpenApi");
      for (const m of MARKS) expect(h.body, v).not.toContain(m);
      const root = await w.app.inject({ method: "GET", url: "/", headers: headersOf(w, v) });
      expect(root.body, v).not.toContain("등록된 알림 기기");
    }
    expect((await w.app.inject({ method: "GET", url: "/health", headers: headersOf(w, "owner") })).json()).toHaveProperty("devices", 1);
  });

  it("웹소켓 스트림: 세션이 없거나 끝났거나 주인이 아니면 업그레이드 전에 거절 (연결한 뒤 세션이 끝나면 닫히는지는 accountsStream)", async () => {
    for (const [v, code] of [["tokenOnly", 403], ["expired", 401], ["revoked", 401], ["member", 403], ["none", 401]] as const) {
      const r = await w.app.inject({ method: "GET", url: "/api/stream", headers: headersOf(w, v) });
      expect(r.statusCode, v).toBe(code);
    }
  });

  it("푸시: 계정이 켜져 있으면 살아 있는 **주인 세션**에 묶인 기기에만 보낸다 — 세션 없이(계정 전·비상 모드) 등록한 기기·끝난 세션의 기기에는 보내지 않는다", async () => {
    expect(await w.app.deviceService.enabledTokens()).toEqual([CANARY_PUSH]);
    // 계정 전(세션 없이) 등록된 옛 행 · 끝난 세션(자동 로그인 끔 12시간 지남)에 묶인 행
    const ts = "2026-09-23T10:00:00+09:00";
    const shortId = Number((await w.db.selectFrom("sessions").select("id").where("remember", "=", 0).executeTakeFirstOrThrow()).id);
    await w.db
      .insertInto("devices")
      .values([
        { token: "ExponentPushToken[unbound1]", platform: "android", device_name: null, enabled: 1, disabled_reason: null, created_at: ts, last_seen_at: ts, session_id: null },
        { token: "ExponentPushToken[expired1]", platform: "android", device_name: null, enabled: 1, disabled_reason: null, created_at: ts, last_seen_at: ts, session_id: shortId },
      ])
      .execute();
    expect(await w.app.deviceService.enabledTokens()).toEqual([CANARY_PUSH]);
    // 주인이 로그아웃하면 이 폰으로도 가지 않는다
    await w.app.inject({ method: "POST", url: "/api/auth/logout", headers: headersOf(w, "owner") });
    expect(await w.app.deviceService.enabledTokens()).toEqual([]);
  });
});

describe("M1 비상 모드 (문서와 같게: API 토큰만 = 주인, 주인 아닌 계정의 세션만 그 계정으로)", () => {
  const cases = [
    ["ACCOUNTS_DISABLED=1", async (db: Db) => world({ ACCOUNTS_DISABLED: "1" }, db)],
    ["관리 API 로 플래그 끔", async (db: Db) => {
      const w = await world({}, db);
      const owner = (await w.app.inject({ method: "POST", url: "/api/auth/login", headers: bearer, payload: { loginId: "서성원", password: "1111" } })).json().token as string;
      expect((await w.app.inject({ method: "PUT", url: "/api/admin/features", headers: { ...bearer, "x-session-token": owner }, payload: { accounts: false } })).statusCode).toBe(200);
      return w;
    }],
  ] as const;
  for (const [label, open] of cases) {
    it(label, async () => {
      const on = await world();
      await seed(on);
      const tokens = on.tokens;
      const memberExpired = (await on.app.inject({ method: "POST", url: "/api/auth/login", headers: bearer, payload: { loginId: "newbie", password: "abcd1234", remember: false } })).json().token as string;
      const memberRevoked = (await on.app.inject({ method: "POST", url: "/api/auth/login", headers: bearer, payload: { loginId: "newbie", password: "abcd1234" } })).json().token as string;
      await on.app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...bearer, "x-session-token": memberRevoked } });
      await on.app.close();
      const w = await open(on.db);
      w.tokens = tokens;
      w.ids = on.ids;
      w.clock.t = T0 + 13 * HOUR;
      try {
        const get = (url: string, h: Record<string, string>) => w.app.inject({ method: "GET", url, headers: h });
        // API 토큰만 = 주인 (계정 전과 같음 — 문서: 가입자가 있으면 비상 모드 전에 API 토큰을 바꾼다)
        expect((await get("/api/stocks", bearer)).body).toContain(CANARY);
        expect((await get("/api/widget", bearer)).statusCode).toBe(200);
        // 주인 세션도 주인
        expect((await get("/api/stocks", { ...bearer, "x-session-token": tokens.owner })).body).toContain(CANARY);
        // 주인 아닌 계정의 세션 — 살아 있음 · 기한 지남 · 끊김 모두 그 계정으로 (개인 경로 빈 값·403, 주인 표시 없음)
        for (const t of [tokens.member, memberExpired, memberRevoked]) {
          const h = { ...bearer, "x-session-token": t };
          const list = await get("/api/stocks", h);
          expect(list.statusCode).toBe(200);
          expect(list.json()).toEqual([]);
          expect((await get("/api/widget", h)).json().code).toBe("personal_data_not_ready");
          for (const url of ["/api/market-summaries", "/health", `/api/briefings/${w.ids.briefing}`, "/api/devices"]) for (const m of MARKS) expect((await get(url, h)).body, url).not.toContain(m);
          // 공유 캐시(분석 글·지표 점수)의 등록 표 이름 — 비상 모드에도 주인 아닌 계정 보기 (검증 8차)
          for (const url of ["/api/stocks/005930/analysis/company", "/api/stocks/SOXX/analysis/technical", "/api/stocks/900001/analysis/company", "/api/scores/SOXL", "/api/scores/RGTX", "/api/scores/SOXX"]) {
            const r = await get(url, h);
            expect(r.statusCode, `${url} ${r.body}`).toBe(url.includes("900001") ? 404 : 200);
            for (const m of MARKS) expect(r.body, url).not.toContain(m);
          }
          const dev = await w.app.inject({ method: "POST", url: "/api/devices", headers: h, payload: { token: "ExponentPushToken[member]", platform: "android" } });
          expect(dev.statusCode).toBe(403);
        }
        // 로그인 경로는 없는 주소
        expect((await w.app.inject({ method: "POST", url: "/api/auth/login", headers: bearer, payload: { loginId: "newbie", password: "abcd1234" } })).statusCode).toBe(404);
        // 푸시: 비상 모드에는 계정 전처럼 세션 없이 등록한 기기에도 보낸다 (주인 세션 기기도)
        expect(await w.app.deviceService.enabledTokens()).toEqual([CANARY_PUSH]);
      } finally {
        await w.app.close();
        await on.db.destroy();
      }
    });
  }
});
