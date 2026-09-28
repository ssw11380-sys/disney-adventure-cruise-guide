import { readFileSync } from "node:fs";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AUTH_ROUTES, decide, EMPTY_READS, NO_SESSION_ROUTES, OUTSIDE_API_ROUTES, routeKey, SANITIZED_ROUTES, SHARED_HEALTH_KEYS, SHARED_ROUTES, type AuthState } from "../src/auth/routePolicy.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { summaryLines, type MarketSummaryData } from "../src/services/marketSummaryCalc.js";
import type { MarketSummarySources } from "../src/services/marketSummaryService.js";
import { fakeProviders } from "./helpers.js";

/**
 * 계정 A단계 경로 정책: 새 계정(주인 아님)이 주인의 개인 데이터를 보지도 바꾸지도 못하는지.
 *  1. 모든 등록 경로를 센다 — 공유(SHARED) · 인증(AUTH) · 개인(아래 KNOWN_PERSONAL) 중 정확히 하나. 새 경로를 만들면 여기서 실패해 정하게 된다
 *     (정하지 않아도 서버는 기본으로 막는다 — 공유 목록에 없으면 주인만)
 *     /api 밖 경로(/ · /health — 관문을 지나지 않음)도 센다: OUTSIDE_API_ROUTES 에 없으면 실패
 *  2. 카나리아: 주인 데이터에 눈에 띄는 표시를 심고, 주인 아닌 계정으로 모든 GET 을 불러 본문에 표시가 하나도 없어야 한다.
 *     쓰기 경로는 모두 403 이고 표 행 수가 그대로여야 한다. 세션 없는 요청은 403 session_required
 */
vi.stubEnv("ACCOUNTS_DISABLED", "");
afterAll(() => vi.unstubAllEnvs());

/** 주인만 쓰는 개인·관리 경로 (A단계). 새 경로가 개인이면 여기에 더한다 — 공유라면 src/auth/routePolicy.ts 의 SHARED_ROUTES 에 */
const KNOWN_PERSONAL = new Set([
  "GET /api/stocks",
  "POST /api/stocks",
  "PATCH /api/stocks/:code",
  "DELETE /api/stocks/:code",
  "GET /api/stream",
  "GET /api/price-alerts",
  "GET /api/price-alerts/volume",
  "POST /api/price-alerts",
  "DELETE /api/price-alerts/:id",
  "POST /api/price-alerts/:id/fired",
  "GET /api/briefings/latest",
  "GET /api/briefings",
  "GET /api/briefings/:id",
  "POST /api/briefings/run",
  "GET /api/briefings/schedule",
  "GET /api/account-briefings",
  "GET /api/account-briefings/:id",
  "POST /api/account-briefings/run",
  "GET /api/widget",
  "GET /api/devices",
  "POST /api/devices",
  "DELETE /api/devices/:token",
  "GET /api/notifications/settings",
  "PUT /api/notifications/settings",
  "POST /api/notifications/test",
  "POST /api/notifications/receipts",
  "GET /api/snapshots",
  "GET /api/trades",
  "GET /api/trade-records",
  "GET /api/scores/:code/history",
  // 관리
  "GET /api/admin/features",
  "PUT /api/admin/features",
  "GET /api/admin/backups",
  "POST /api/admin/backups/run",
  "GET /api/admin/backups/:name",
  "GET /api/admin/master",
  "POST /api/admin/master/refresh",
  "GET /api/admin/toss/status",
  "GET /api/admin/toss/reconcile",
  "POST /api/admin/toss/import-holdings",
  "GET /api/admin/toss/krw-cost",
  "PUT /api/admin/toss/krw-cost",
  "GET /api/admin/toss/holdings-raw",
  "GET /api/admin/toss/probe",
  "POST /api/admin/dart/refresh",
  "GET /api/admin/trade-records",
  "POST /api/admin/trade-records/snapshot",
  "POST /api/admin/trade-records/sync-trades",
  "GET /api/admin/app-errors",
]);

const CANARY = "OWNER-CANARY-7f3";
const CANARY_NAME = "카나리아전자";
const CANARY_PUSH = "ExponentPushToken[canary7f3]";
const MARKS = [CANARY, CANARY_NAME, "canary7f3", "777.77"];

describe("decide (순수 함수)", () => {
  const owner: AuthState = { kind: "user", user: { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: false }, session: { id: 1, remember: true, expiresAt: "" } };
  const member: AuthState = { kind: "user", user: { id: 2, loginId: "m", email: "m@x.co", isOwner: false, usingInitialPassword: false }, session: { id: 2, remember: true, expiresAt: "" } };
  it("꺼짐은 모두 허용, 세션 없음은 세션 없이 여는 경로·인증 경로만", () => {
    expect(decide("GET /api/stocks", { kind: "off" })).toEqual({ action: "allow" });
    expect(decide("GET /api/admin/features", { kind: "off" })).toEqual({ action: "allow" });
    expect(decide("GET /api/features", { kind: "anonymous" })).toEqual({ action: "allow" });
    expect(decide("POST /api/auth/login", { kind: "anonymous" })).toEqual({ action: "allow" });
    expect(decide("GET /api/market/status", { kind: "anonymous" })).toMatchObject({ action: "deny", status: 403, body: { code: "session_required" } });
  });
  it("주인은 모두, 주인 아닌 계정은 공유만 (빈 값·owner_only·personal_data_not_ready)", () => {
    for (const k of [...SHARED_ROUTES, ...KNOWN_PERSONAL]) expect(decide(k, owner)).toEqual({ action: "allow" });
    for (const k of SHARED_ROUTES) expect(decide(k, member)).toEqual({ action: "allow" });
    expect(decide("GET /api/stocks", member)).toMatchObject({ action: "empty" });
    expect(decide("GET /api/admin/backups", member)).toMatchObject({ action: "deny", status: 403, body: { code: "owner_only" } });
    expect(decide("POST /api/stocks", member)).toMatchObject({ action: "deny", status: 403, body: { code: "personal_data_not_ready" } });
    // 목록에 없는 새 경로는 기본으로 막힌다
    expect(decide("GET /api/something-new", member)).toMatchObject({ action: "deny", body: { code: "personal_data_not_ready" } });
  });
  it("routeKey: HEAD 는 GET, 끝 슬래시는 뺀다", () => {
    expect(routeKey("HEAD", "/api/stocks/")).toBe("GET /api/stocks");
    expect(routeKey("get", "/api/stocks/:code")).toBe("GET /api/stocks/:code");
    expect(routeKey("GET", "/")).toBe("GET /");
  });
});

/** 시장 요약 픽스처 한 건에 주인 보유 표시를 심는다 */
function summaryWithCanary(): MarketSummaryData {
  const fx = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: Array<{ data: MarketSummaryData }> };
  const d = structuredClone(fx.cases[1]!.data);
  d.holdings!.high[0]!.name = CANARY_NAME;
  d.notes = [...d.notes, `보유 종목을 읽지 못함 (${CANARY})`, "원/달러를 받지 못함"];
  return d;
}

interface World {
  app: FastifyInstance;
  db: Db;
  owner: string;
  member: string;
  ids: { briefing: number; account: number; summary: number; alert: number };
}

async function world(): Promise<World> {
  const db = await createMigratedDb(":memory:");
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:" }),
    db,
    // 시장 요약 경로는 출처가 있어야 등록된다 (요약은 직접 넣는다 — 출처는 부르지 않음). 발견 탭 출처는 네트워크 없이 실패
    providers: fakeProviders({ marketSummary: {} as MarketSummarySources, discover: new NaverDiscover(async () => Promise.reject(new Error("네트워크 없음"))) }),
    logger: false,
    enableScheduler: false,
    now: () => new Date("2026-09-23T16:30:00+09:00"),
    auth: { scryptN: 1024 },
  });
  await app.stockService.refreshMaster();
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: "서성원", password: "1111" } });
  const owner = login.json().token as string;
  const o = { "x-session-token": owner };
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
  expect(summary).toContain(CANARY_NAME);
  const s = await db.insertInto("market_summaries").values({ summary_date: "2026-09-23", session: "afternoon", market: "KR", status: "ok", summary, data: JSON.stringify(data), created_at: ts }).returning("id").executeTakeFirstOrThrow();
  await db
    .insertInto("account_snapshots")
    .values({ snapshot_date: "2026-09-23", market: "KR", status: "ok", method: "close", as_of: ts, scheduled_at: ts, source: "toss-openapi", reason: null, holdings_count: 1, total_value_krw: 777.77, data: JSON.stringify({ memo: CANARY }), created_at: ts, updated_at: ts })
    .execute();
  const member = (await app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "newbie", password: "abcd1234", passwordConfirm: "abcd1234", email: "n@example.com" } })).json().token as string;
  return { app, db, owner, member, ids: { briefing: Number(b.id), account: Number(a.id), summary: Number(s.id), alert: Number(alert.json().id) } };
}

/** 경로 모양 → 실제 주소 (심은 코드·id 로 채운다) */
function fill(url: string, w: World): string {
  return url
    .replace("/api/briefings/:id", `/api/briefings/${w.ids.briefing}`)
    .replace("/api/account-briefings/:id", `/api/account-briefings/${w.ids.account}`)
    .replace("/api/market-summaries/:id", `/api/market-summaries/${w.ids.summary}`)
    .replace("/api/price-alerts/:id", `/api/price-alerts/${w.ids.alert}`)
    .replace(":code", "005930")
    .replace(":kind", "company")
    .replace(":market", "KR")
    .replace(":category", "up")
    .replace(":id", "1")
    .replace(":name", "backup-20260923-000000.sbk")
    .replace(":token", encodeURIComponent(CANARY_PUSH));
}

const TABLES = ["registered_stocks", "price_alerts", "devices", "briefings", "account_briefings", "market_summaries", "account_snapshots", "meta", "users"] as const;
async function counts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = Number((await sql<{ n: number }>`select count(*) as n from ${sql.table(t)}`.execute(db)).rows[0]?.n ?? 0);
  return out;
}

describe("경로 정책 — 모든 경로 · 카나리아", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(async () => {
    await w.app.close();
    await w.db.destroy();
  });

  const apiKeys = () => [...new Set(w.app.routeList.filter((r) => r.url.startsWith("/api")).map((r) => routeKey(r.method, r.url)))].sort();

  it("모든 /api 경로는 공유·인증·개인 중 정확히 하나 (새 경로는 여기서 정한다)", () => {
    const keys = apiKeys();
    const unknown: string[] = [];
    for (const k of keys) {
      const n = [SHARED_ROUTES.has(k), AUTH_ROUTES.has(k), KNOWN_PERSONAL.has(k)].filter(Boolean).length;
      if (n !== 1) unknown.push(`${k} (${n})`);
    }
    expect(unknown, "공유(SHARED_ROUTES)인지 개인(KNOWN_PERSONAL)인지 정하세요").toEqual([]);
    // 목록에 있는데 실제로 없는 경로 (오타·지운 경로)
    const all = new Set(keys);
    expect([...SHARED_ROUTES, ...AUTH_ROUTES, ...KNOWN_PERSONAL, ...Object.keys(EMPTY_READS), ...SANITIZED_ROUTES, ...NO_SESSION_ROUTES].filter((k) => !all.has(k))).toEqual([]);
    expect([...SANITIZED_ROUTES].filter((k) => !SHARED_ROUTES.has(k))).toEqual([]);
    expect(Object.keys(EMPTY_READS).filter((k) => !KNOWN_PERSONAL.has(k) || !k.startsWith("GET "))).toEqual([]);
    expect(keys.length).toBe(SHARED_ROUTES.size + AUTH_ROUTES.size + KNOWN_PERSONAL.size);
  });

  it("/api 밖 경로도 센다 — 목록(OUTSIDE_API_ROUTES)에 없는 새 경로는 여기서 정한다", () => {
    const outside = [...new Set(w.app.routeList.filter((r) => !r.url.startsWith("/api")).map((r) => routeKey(r.method, r.url)))].sort();
    expect(outside, "새 /api 밖 경로: routePolicy.ts OUTSIDE_API_ROUTES 에 넣고 주인 데이터가 새지 않는지 아래 테스트에 더하세요").toEqual([...OUTSIDE_API_ROUTES].sort());
  });

  it("/health · / : 주인 아닌 계정·세션 없음·끊긴 세션에는 주인 상세가 없다 (주인 세션만 — 토큰은 맞으므로 limited 아님)", async () => {
    const bogus = `gzs1_${"A".repeat(43)}`;
    for (const headers of [{ "x-session-token": w.member }, {}, { "x-session-token": bogus }] as Record<string, string>[]) {
      const h = await w.app.inject({ method: "GET", url: "/health", headers });
      expect(h.statusCode).toBe(200);
      expect(Object.keys(h.json()).sort(), JSON.stringify(headers)).toEqual([...SHARED_HEALTH_KEYS].sort());
      expect(h.json().viewer).toBe("shared");
      for (const mark of MARKS) expect(h.body).not.toContain(mark);
      const root = await w.app.inject({ method: "GET", url: "/", headers });
      expect(root.statusCode).toBe(200);
      expect(root.body).not.toContain("등록된 알림 기기");
      expect(root.body).not.toContain("브리핑 모델");
    }
    const o = { "x-session-token": w.owner };
    const mine = (await w.app.inject({ method: "GET", url: "/health", headers: o })).json();
    expect(mine.devices).toBe(1);
    expect(mine).toHaveProperty("tossOpenApi");
    expect(mine).toHaveProperty("lastBriefing");
    expect(mine.accounts).toEqual({ enabled: true });
    // CORS 사전 요청은 본문이 없다
    const pre = await w.app.inject({ method: "OPTIONS", url: "/api/stocks", headers: { origin: "https://x.test", "access-control-request-method": "GET" } });
    expect(pre.statusCode).toBe(204);
    expect(pre.body).toBe("");
    expect((await w.app.inject({ method: "GET", url: "/", headers: o })).body).toContain("등록된 알림 기기: 1대");
  });

  it("주인은 심은 데이터를 본다 (카나리아가 제대로 심겼는지)", async () => {
    const o = { "x-session-token": w.owner };
    expect((await w.app.inject({ method: "GET", url: "/api/stocks", headers: o })).body).toContain(CANARY);
    expect((await w.app.inject({ method: "GET", url: "/api/market-summaries", headers: o })).body).toContain(CANARY_NAME);
    expect((await w.app.inject({ method: "GET", url: `/api/briefings/${w.ids.briefing}`, headers: o })).body).toContain(CANARY);
    expect((await w.app.inject({ method: "GET", url: "/api/devices", headers: o })).body).toContain("canary7f3");
  });

  it("주인 아닌 계정: 모든 GET 본문에 주인 표시가 하나도 없다", async () => {
    const m = { "x-session-token": w.member };
    const leaks: string[] = [];
    for (const k of apiKeys().filter((x) => x.startsWith("GET "))) {
      const url = fill(k.slice(4), w);
      const r = await w.app.inject({ method: "GET", url, headers: m });
      for (const mark of MARKS) if (r.body.includes(mark)) leaks.push(`${k} → ${mark}`);
      if (!SHARED_ROUTES.has(k) && !AUTH_ROUTES.has(k)) {
        if (k in EMPTY_READS) expect(r.statusCode, k).toBe(200);
        else expect(r.statusCode, `${k} ${r.body}`).toBe(403);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("주인 아닌 계정: 시장 요약은 내 종목 비교를 뺀 모습 (지수·환율·업종·뉴스는 그대로)", async () => {
    const m = { "x-session-token": w.member };
    const o = { "x-session-token": w.owner };
    const mine = (await w.app.inject({ method: "GET", url: `/api/market-summaries/${w.ids.summary}`, headers: o })).json();
    const seen = (await w.app.inject({ method: "GET", url: `/api/market-summaries/${w.ids.summary}`, headers: m })).json();
    expect(mine.data.holdings).not.toBeNull();
    expect(seen.data.holdings).toBeNull();
    expect(seen.summary.split("\n").length).toBe(mine.summary.split("\n").length - 1);
    expect(seen.data.indices).toEqual(mine.data.indices);
    expect(seen.data.notes).toEqual(["원/달러를 받지 못함"]);
    const list = (await w.app.inject({ method: "GET", url: "/api/market-summaries?limit=4", headers: m })).json();
    expect(list[0]).toEqual(seen);
    expect((await w.app.inject({ method: "GET", url: "/api/market-summaries/latest", headers: m })).json()).toEqual(seen);
  });

  it("주인 아닌 계정: 예전 문구로 저장된 요약의 '내 종목' 줄·모르는 안내도 새지 않는다 (요약 글을 보유 없이 다시 만든다)", async () => {
    const data = summaryWithCanary();
    data.notes = [...data.notes, `새로 생긴 안내 ${CANARY}`, `미국 시세를 받지 못함 (${CANARY_NAME} 조회 실패)`];
    const current = summaryLines(data, new Date("2026-09-23T16:00:00+09:00")).map((l) => l.text);
    // 옛 코드가 만든 글: '내 종목' 줄 문구가 지금과 조금 다르다 (지금 코드로 다시 만든 줄과 글자가 같지 않음)
    const old = current.map((l) => (l.includes(CANARY_NAME) ? `내 종목 비교(예전 문구) · ${CANARY_NAME} +3.2%` : l)).join("\n");
    const row = await w.db.insertInto("market_summaries").values({ summary_date: "2026-09-24", session: "afternoon", market: "KR", status: "ok", summary: old, data: JSON.stringify(data), created_at: "2026-09-24T16:00:00+09:00" }).returning("id").executeTakeFirstOrThrow();
    const m = { "x-session-token": w.member };
    const seen = await w.app.inject({ method: "GET", url: `/api/market-summaries/${row.id}`, headers: m });
    expect(seen.statusCode).toBe(200);
    expect(seen.body).not.toContain(CANARY_NAME);
    expect(seen.body).not.toContain(CANARY);
    expect(seen.json().summary.split("\n")).toEqual(current.filter((l) => !l.includes(CANARY_NAME)));
    expect(seen.json().data.notes).toEqual(["원/달러를 받지 못함"]);
    for (const url of ["/api/market-summaries?limit=20", "/api/market-summaries/latest"]) expect((await w.app.inject({ method: "GET", url, headers: m })).body).not.toContain(CANARY_NAME);
    // 주인은 저장된 그대로
    expect((await w.app.inject({ method: "GET", url: `/api/market-summaries/${row.id}`, headers: { "x-session-token": w.owner } })).json().summary).toBe(old);
    await w.db.deleteFrom("market_summaries").where("id", "=", Number(row.id)).execute();
  });

  it("주인 아닌 계정: 모든 쓰기(공유·인증 빼고)는 403, 표 행 수 그대로", async () => {
    const m = { "x-session-token": w.member };
    const before = await counts(w.db);
    for (const k of apiKeys().filter((x) => !x.startsWith("GET ") && !SHARED_ROUTES.has(x) && !AUTH_ROUTES.has(x))) {
      const [method, url] = k.split(" ") as [string, string];
      const r = await w.app.inject({ method: method as "POST", url: fill(url, w), headers: m, payload: { code: "000660", quantity: 1, token: "ExponentPushToken[member]", kind: "priceAbove", value: 1, session: "morning", accounts: false, items: {} } });
      expect(r.statusCode, `${k} ${r.body}`).toBe(403);
      expect(["personal_data_not_ready", "owner_only"], k).toContain(r.json().code);
    }
    expect(await counts(w.db)).toEqual(before);
  });

  it("세션 없는 요청: 세션 없이 여는 경로 말고는 모두 403 session_required, 표시가 새지 않는다", async () => {
    for (const k of apiKeys()) {
      if (NO_SESSION_ROUTES.has(k) || AUTH_ROUTES.has(k)) continue;
      const [method, url] = k.split(" ") as [string, string];
      const r = await w.app.inject({ method: method as "GET", url: fill(url, w) });
      expect(r.statusCode, k).toBe(403);
      expect(r.json().code, k).toBe("session_required");
    }
  });
});
