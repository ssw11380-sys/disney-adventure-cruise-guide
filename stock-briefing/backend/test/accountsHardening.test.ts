import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/authService.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { FeatureService } from "../src/services/featureService.js";
import { fakeProviders } from "./helpers.js";

/**
 * 계정 A단계 보안 보강 (검증 지적):
 *  - 푸시 기기 등록을 로그인 세션에 묶는다 — 세션을 끊으면(로그아웃·모든 기기에서 로그아웃·비밀번호 변경) 그 등록도 지우고, 끊겼거나 기한이 지난 세션의 기기에는 보내지 않는다
 *  - 끊는 동안 읽던 요청이 끊긴 세션을 캐시에 다시 넣지 않는다
 *  - 플래그를 읽지 못하면 계정 관문은 켜짐으로 (오류로 문이 열리지 않게)
 *  - 플래그를 꺼도 주인 아닌 계정의 세션을 보낸 요청은 그 계정으로 본다 (그 기기에 주인 데이터가 보이지 않게)
 *  - 비상 주인 비밀번호 되돌리기 OWNER_RESET_PASSWORD
 */
vi.stubEnv("ACCOUNTS_DISABLED", "");
afterAll(() => vi.unstubAllEnvs());

const T0 = Date.parse("2026-09-28T10:00:00+09:00");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OWNER = "서성원";
const LOST = "ExponentPushToken[lostphone123]";
const HERE = "ExponentPushToken[herephone456]";
const OLD = "ExponentPushToken[legacy789]";

interface Ctx {
  app: FastifyInstance;
  db: Db;
  clock: { t: number };
}
const opened: FastifyInstance[] = [];
const dbs: Db[] = [];
afterEach(async () => {
  for (const a of opened.splice(0)) await a.close();
  for (const d of dbs.splice(0)) await d.destroy();
});

async function makeApp(o: { db?: Db; env?: Record<string, string>; clock?: { t: number } } = {}): Promise<Ctx> {
  const clock = o.clock ?? { t: T0 };
  const db = o.db ?? (await createMigratedDb(":memory:"));
  if (!o.db) dbs.push(db);
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:", ...o.env }),
    db,
    providers: fakeProviders(),
    logger: false,
    enableScheduler: false,
    now: () => new Date(clock.t),
    auth: { scryptN: 1024 },
  });
  opened.push(app);
  return { app, db, clock };
}

const S = (token: string) => ({ "x-session-token": token });

async function loginToken(app: FastifyInstance, password = "1111", remember = true): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: OWNER, password, remember } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().token as string;
}

async function register(app: FastifyInstance, push: string, headers: Record<string, string> = {}) {
  const r = await app.inject({ method: "POST", url: "/api/devices", headers, payload: { token: push, platform: "android", deviceName: "phone" } });
  expect(r.statusCode, r.body).toBeLessThan(300);
}

const deviceRows = async (db: Db) => (await db.selectFrom("devices").select("token").orderBy("token").execute()).map((r) => r.token);

describe("푸시 기기 등록은 로그인 세션에 묶인다", () => {
  it("모든 기기에서 로그아웃: 잃어버린 폰의 등록이 지워지고 알림이 가지 않는다 (그 폰은 스스로 뺄 수 없다)", async () => {
    const { app, db } = await makeApp();
    const lost = await loginToken(app);
    await register(app, LOST, S(lost));
    expect(await app.deviceService.enabledTokens()).toEqual([LOST]);
    const phone = await loginToken(app);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: S(phone) })).statusCode).toBe(204);
    expect(await app.deviceService.enabledTokens()).toEqual([]);
    expect(await deviceRows(db)).toEqual([]);
    // 끊긴 폰은 스스로 빼지 못한다 (그래서 서버가 지운다)
    expect((await app.inject({ method: "DELETE", url: `/api/devices/${encodeURIComponent(LOST)}`, headers: S(lost) })).statusCode).toBe(401);
  });

  it("이 기기만 로그아웃해도 그 세션의 등록을 서버가 지운다 (앱이 알림 빼기에 실패했어도). 다른 폰의 등록은 그대로", async () => {
    const { app, db } = await makeApp();
    const a = await loginToken(app);
    const b = await loginToken(app);
    await register(app, LOST, S(a));
    await register(app, HERE, S(b));
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: S(a) })).statusCode).toBe(204);
    expect(await deviceRows(db)).toEqual([HERE]);
    expect(await app.deviceService.enabledTokens()).toEqual([HERE]);
  });

  it("비밀번호 변경: 다른 세션의 등록과 계정 전(세션 없이) 등록한 주인 기기는 지우고, 이 세션의 등록은 둔다", async () => {
    const { app, db } = await makeApp();
    const here = await loginToken(app);
    // 계정을 켜기 전(플래그 꺼짐 — API 토큰 = 주인)에 등록한 옛 기기
    await app.inject({ method: "PUT", url: "/api/admin/features", headers: S(here), payload: { accounts: false } });
    await register(app, OLD);
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accounts: true } });
    const other = await loginToken(app);
    await register(app, LOST, S(other));
    await register(app, HERE, S(here));
    expect((await app.deviceService.enabledTokens()).sort()).toEqual([HERE, LOST, OLD].sort());
    const r = await app.inject({ method: "POST", url: "/api/auth/password", headers: S(here), payload: { current: "1111", next: "abcd1234", nextConfirm: "abcd1234" } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await deviceRows(db)).toEqual([HERE]);
    expect(await app.deviceService.enabledTokens()).toEqual([HERE]);
  });

  it("같은 폰을 다시 등록하면 새 세션에 묶인다 (다시 로그인한 뒤 앱이 다시 등록)", async () => {
    const { app } = await makeApp();
    const first = await loginToken(app);
    await register(app, HERE, S(first));
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: S(first) });
    expect(await app.deviceService.enabledTokens()).toEqual([]);
    const again = await loginToken(app);
    await register(app, HERE, S(again));
    expect(await app.deviceService.enabledTokens()).toEqual([HERE]);
  });

  it("기한이 지난 세션(자동 로그인 끔 12시간)의 기기에는 보내지 않고, 청소하면 행도 지운다. 세션 없이 등록한 기기는 예전처럼 보낸다", async () => {
    const { app, db, clock } = await makeApp();
    const short = await loginToken(app, "1111", false);
    await register(app, LOST, S(short));
    await app.inject({ method: "PUT", url: "/api/admin/features", headers: S(short), payload: { accounts: false } });
    await register(app, OLD);
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accounts: true } });
    expect((await app.deviceService.enabledTokens()).sort()).toEqual([LOST, OLD].sort());
    clock.t += 13 * HOUR;
    expect(await app.deviceService.enabledTokens()).toEqual([OLD]);
    clock.t += 31 * DAY;
    await app.authService.purge();
    expect(await deviceRows(db)).toEqual([OLD]);
  });
});

describe("세션 캐시", () => {
  it("끊는 동안 읽던 요청이 끊긴 세션을 캐시에 다시 넣지 않는다 (끊은 뒤 바로 막힌다)", async () => {
    const { app, clock } = await makeApp();
    const token = await loginToken(app);
    // 하루 넘게 지나 연장(DB 쓰기)까지 하는 요청과 로그아웃을 동시에
    clock.t += DAY + HOUR;
    const auth = app.authService;
    const me = await auth.authenticate(token);
    expect(me).not.toBeNull();
    clock.t += DAY + HOUR;
    const [during] = await Promise.all([auth.authenticate(token), auth.logout(me!.session.id)]);
    expect(during === null || during.session.id === me!.session.id).toBe(true);
    expect(await auth.authenticate(token)).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: S(token) })).statusCode).toBe(401);
  });
});

describe("플래그를 읽지 못할 때 · 끈 동안", () => {
  it("계정 플래그는 한 번도 읽지 못하면 켜짐 (보안 관문 — 다른 플래그는 예전처럼 꺼짐), 비상 끄기는 그대로 꺼짐", async () => {
    const broken = { selectFrom: () => { throw new Error("DB 를 읽지 못함"); } } as unknown as Db;
    const f = new FeatureService(broken, () => new Date(T0));
    expect(await f.enabled("accounts")).toBe(true);
    expect(await f.enabled("pollSaver")).toBe(false);
    const killed = new FeatureService(broken, () => new Date(T0), new Set(["accounts"] as const));
    expect(await killed.enabled("accounts")).toBe(false);
  });

  it("플래그를 꺼도 주인 아닌 계정의 세션을 보낸 요청은 그 계정으로 — 주인 잔고가 그 기기에 보이지 않는다", async () => {
    const { app } = await makeApp();
    await app.stockService.refreshMaster();
    const owner = await loginToken(app);
    expect((await app.inject({ method: "POST", url: "/api/stocks", headers: S(owner), payload: { code: "005930", quantity: 123, avgPrice: 71111, memo: "OWNER-MEMO" } })).statusCode).toBe(201);
    const member = (await app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "kim_new", password: "abcd1234", passwordConfirm: "abcd1234", email: "k@example.com" } })).json().token as string;
    await app.inject({ method: "PUT", url: "/api/admin/features", headers: S(owner), payload: { accounts: false } });
    // 주인 아닌 계정: 개인 읽기는 빈 값, 쓰기는 403, 공유는 그대로, /health 는 공유 모습
    const list = await app.inject({ method: "GET", url: "/api/stocks", headers: S(member) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/stocks", headers: S(member), payload: { code: "000660", quantity: 1, avgPrice: 1 } })).json().code).toBe("personal_data_not_ready");
    expect((await app.inject({ method: "GET", url: "/api/market/status", headers: S(member) })).statusCode).toBe(200);
    const health = await app.inject({ method: "GET", url: "/health", headers: S(member) });
    expect(health.json().viewer).toBe("shared");
    expect(health.body).not.toContain("OWNER-MEMO");
    // 세션 없이·주인 세션은 지금처럼 (꺼짐 = API 토큰 = 주인)
    expect((await app.inject({ method: "GET", url: "/api/stocks" })).body).toContain("OWNER-MEMO");
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: S(owner) })).body).toContain("OWNER-MEMO");
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toHaveProperty("devices");
  });
});

describe("비상 주인 비밀번호 되돌리기 (OWNER_RESET_PASSWORD)", () => {
  it("켤 때 지금 비밀번호와 다르면 바꾸고 주인 세션·기기 등록을 모두 끊는다. 같으면(다시 켜도) 아무것도 하지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    dbs.push(db);
    const clock = { t: T0 };
    const first = await makeApp({ db, clock });
    const taken = await loginToken(first.app);
    // 누가 먼저 1111 로 들어와 비밀번호를 바꾸고 알림 기기를 등록했다
    await first.app.inject({ method: "POST", url: "/api/auth/password", headers: S(taken), payload: { current: "1111", next: "stolen99", nextConfirm: "stolen99" } });
    await register(first.app, LOST, S(taken));
    await first.app.close();
    opened.splice(opened.indexOf(first.app), 1);

    const second = await makeApp({ db, clock, env: { OWNER_RESET_PASSWORD: "mine2026" } });
    expect((await second.app.inject({ method: "GET", url: "/api/stocks", headers: S(taken) })).json().code).toBe("session_invalid");
    expect(await deviceRows(db)).toEqual([]);
    expect((await second.app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: OWNER, password: "stolen99" } })).statusCode).toBe(400);
    const mine = await loginToken(second.app, "mine2026");
    expect(await second.app.authService.ownerUsesInitialPassword()).toBe(false);
    await second.app.close();
    opened.splice(opened.indexOf(second.app), 1);

    // 변수를 남긴 채 다시 켜도 (같은 비밀번호) 로그아웃되지 않는다
    const third = await makeApp({ db, clock, env: { OWNER_RESET_PASSWORD: "mine2026" } });
    expect((await third.app.inject({ method: "GET", url: "/api/stocks", headers: S(mine) })).statusCode).toBe(200);
  });

  it("주인이 없으면 아무것도 하지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    dbs.push(db);
    const auth = new AuthService({ db, now: () => new Date(T0), scryptN: 1024 });
    expect(await auth.resetOwnerPassword("abcd1234")).toBe("no_owner");
  });
});
