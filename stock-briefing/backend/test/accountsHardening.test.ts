import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/authService.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { FeatureService } from "../src/services/featureService.js";
import { MEMBER_SHARED_PER_MINUTE } from "../src/auth/routePolicy.js";
import type { Providers } from "../src/providers/index.js";
import { FakeQuoteProvider, fakeProviders } from "./helpers.js";

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

async function makeApp(o: { db?: Db; env?: Record<string, string>; clock?: { t: number }; providers?: Partial<Providers> } = {}): Promise<Ctx> {
  const clock = o.clock ?? { t: T0 };
  const db = o.db ?? (await createMigratedDb(":memory:"));
  if (!o.db) dbs.push(db);
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:", ...o.env }),
    db,
    providers: fakeProviders(o.providers),
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
    // 계정이 켜져 있으면 세션 없이 등록한 옛 기기에는 이미 보내지 않는다 (검증 4차 — 행은 비밀번호를 바꿀 때 지운다)
    expect((await app.deviceService.enabledTokens()).sort()).toEqual([HERE, LOST].sort());
    expect(await deviceRows(db)).toEqual([HERE, LOST, OLD].sort());
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

  it("기한이 지난 세션(자동 로그인 끔 12시간)의 기기에는 보내지 않고, 청소하면 행도 지운다. 세션 없이 등록한 기기는 비상 모드(플래그 끔)에서만 보낸다", async () => {
    const { app, db, clock } = await makeApp();
    const short = await loginToken(app, "1111", false);
    await register(app, LOST, S(short));
    await app.inject({ method: "PUT", url: "/api/admin/features", headers: S(short), payload: { accounts: false } });
    await register(app, OLD);
    // 끈 동안(비상 모드): 계정 전처럼 세션 없이 등록한 기기에도
    expect((await app.deviceService.enabledTokens()).sort()).toEqual([LOST, OLD].sort());
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accounts: true } });
    // 켜면: 살아 있는 주인 세션에 묶인 기기만 (검증 4차 M1)
    expect(await app.deviceService.enabledTokens()).toEqual([LOST]);
    clock.t += 13 * HOUR;
    expect(await app.deviceService.enabledTokens()).toEqual([]);
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

  it("비상 끄기(ACCOUNTS_DISABLED=1)에서도 주인 아닌 계정의 세션이면 그 계정으로 막는다 — 가입자 폰에 주인 잔고·메모가 보이거나 알림 기기가 등록되지 않게", async () => {
    const db = await createMigratedDb(":memory:");
    dbs.push(db);
    const clock = { t: T0 };
    // 계정을 켠 채 주인 종목·주인 아닌 계정을 만든 뒤
    const on = await makeApp({ db, clock });
    await on.app.stockService.refreshMaster();
    const owner = await loginToken(on.app);
    expect((await on.app.inject({ method: "POST", url: "/api/stocks", headers: S(owner), payload: { code: "005930", quantity: 10, avgPrice: 70000, memo: "OWNER-MEMO" } })).statusCode).toBe(201);
    const member = (await on.app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "kim_new", password: "abcd1234", passwordConfirm: "abcd1234", email: "k@example.com" } })).json().token as string;
    await on.app.close();
    opened.splice(opened.indexOf(on.app), 1);

    // 같은 DB 로 비상 끄기 배포
    const { app } = await makeApp({ db, clock, env: { ACCOUNTS_DISABLED: "1" } });
    expect((await app.inject({ method: "GET", url: "/api/features" })).json().features.accounts).toBe(false);
    const list = await app.inject({ method: "GET", url: "/api/stocks", headers: S(member) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/widget", headers: S(member) })).json().code).toBe("personal_data_not_ready");
    const dev = await app.inject({ method: "POST", url: "/api/devices", headers: S(member), payload: { token: LOST, platform: "android", deviceName: "member" } });
    expect(dev.statusCode).toBe(403);
    expect(dev.json().code).toBe("personal_data_not_ready");
    expect(await deviceRows(db)).toEqual([]);
    const health = await app.inject({ method: "GET", url: "/health", headers: S(member) });
    expect(health.json().viewer).toBe("shared");
    expect(health.body).not.toContain("OWNER-MEMO");
    expect((await app.inject({ method: "GET", url: "/api/market/status", headers: S(member) })).statusCode).toBe(200);
    // 세션 없이·주인 세션은 지금처럼 (API 토큰 = 주인), /api/auth/* 는 없는 주소
    expect((await app.inject({ method: "GET", url: "/api/stocks" })).body).toContain("OWNER-MEMO");
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: S(owner) })).body).toContain("OWNER-MEMO");
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: OWNER, password: "1111" } })).statusCode).toBe(404);
    // 세션 확인 자체가 실패하면(DB 오류) 지금처럼 — 비상 끄기가 DB 오류로 막히지 않게 (설계 1장 '끈 동안 주인 아닌 계정')
    vi.spyOn(app.authService, "authenticate").mockRejectedValueOnce(new Error("DB 를 읽지 못함"));
    expect((await app.inject({ method: "GET", url: "/api/market/status", headers: S(member) })).statusCode).toBe(200);
  });
});

describe("로그인한 뒤 비밀번호·이메일 변경의 잠금은 로그인 잠금과 따로", () => {
  it("공개된 아이디로 로그인을 일부러 5번 틀려 주인을 잠가도, 이미 로그인한 주인은 설정에서 비밀번호·이메일을 바꿀 수 있다", async () => {
    const { app } = await makeApp();
    const owner = await loginToken(app);
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: OWNER, password: "wrong" } });
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: OWNER, password: "1111" } })).statusCode).toBe(429);
    const mail = await app.inject({ method: "PUT", url: "/api/auth/email", headers: S(owner), payload: { email: "me@example.com", current: "1111" } });
    expect(mail.statusCode, mail.body).toBe(200);
    const pw = await app.inject({ method: "POST", url: "/api/auth/password", headers: S(owner), payload: { current: "1111", next: "mine2026", nextConfirm: "mine2026" } });
    expect(pw.statusCode, pw.body).toBe(200);
  });

  it("지금 비밀번호를 5번 틀리면 그 세션만 10분 막힌다 (다른 세션·로그인은 그대로)", async () => {
    const { app, clock } = await makeApp();
    const a = await loginToken(app);
    const b = await loginToken(app);
    const change = (t: string, current: string) => app.inject({ method: "POST", url: "/api/auth/password", headers: S(t), payload: { current, next: "mine2026", nextConfirm: "mine2026" } });
    for (let i = 0; i < 4; i++) expect((await change(a, "0000")).json().code).toBe("bad_current_password");
    expect((await change(a, "0000")).statusCode).toBe(429);
    expect((await change(a, "1111")).statusCode).toBe(429);
    // 로그인 잠금은 세지 않았다
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: OWNER, password: "1111" } })).statusCode).toBe(200);
    clock.t += 10 * 60_000 + 1000;
    expect((await change(a, "1111")).statusCode).toBe(200);
    // 비밀번호를 바꿨으니 b 는 끊겼다
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: S(b) })).json().code).toBe("session_invalid");
  });
});

describe("같은 순간의 가입·이메일 변경 (유일 색인)", () => {
  it("이메일 변경이 다른 사람과 겹쳐 유일 색인에 걸리면 500 이 아니라 409 (오류 로그에 이메일이 남지 않게)", async () => {
    const { app } = await makeApp();
    const owner = await loginToken(app);
    await app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "racer01", password: "abcd1234", passwordConfirm: "abcd1234", email: "race@example.com" } });
    // 확인은 지나갔는데(그 사이 다른 사람이 가입) 저장에서 겹친 경우를 흉내 낸다
    const svc = app.authService as unknown as { assertFree: (...a: unknown[]) => Promise<void> };
    vi.spyOn(svc, "assertFree").mockResolvedValueOnce(undefined);
    const r = await app.inject({ method: "PUT", url: "/api/auth/email", headers: S(owner), payload: { email: "race@example.com", current: "1111" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("email_taken");
  });
});

describe("주인 아닌 계정의 공유 경로 (주인 키로 외부를 부르는 몫)", () => {
  it("시세 fresh=1 은 주인만 — 주인 아닌 계정은 캐시를 건너뛰지 못한다", async () => {
    const quotes = new FakeQuoteProvider("kis");
    const { app } = await makeApp({ providers: { quotes } });
    await app.stockService.refreshMaster();
    const owner = await loginToken(app);
    const member = (await app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "kim_new", password: "abcd1234", passwordConfirm: "abcd1234", email: "k@example.com" } })).json().token as string;
    expect((await app.inject({ method: "GET", url: "/api/stocks/005930/quote", headers: S(member) })).statusCode).toBe(200);
    const after = quotes.calls;
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "GET", url: "/api/stocks/005930/quote?fresh=1", headers: S(member) })).statusCode).toBe(200);
    expect(quotes.calls).toBe(after);
    await app.inject({ method: "GET", url: "/api/stocks/005930/quote?fresh=1", headers: S(owner) });
    expect(quotes.calls).toBeGreaterThan(after);
  });

  it("사람마다 1분에 MEMBER_SHARED_PER_MINUTE 번까지, 넘으면 429 (로그아웃 신호 아님) — 1분 뒤 풀림, 주인은 제한 없음", async () => {
    const { app, clock } = await makeApp();
    const owner = await loginToken(app);
    const member = (await app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId: "kim_new", password: "abcd1234", passwordConfirm: "abcd1234", email: "k@example.com" } })).json().token as string;
    for (let i = 0; i < MEMBER_SHARED_PER_MINUTE; i++) expect((await app.inject({ method: "GET", url: "/api/market/status", headers: S(member) })).statusCode).toBe(200);
    const over = await app.inject({ method: "GET", url: "/api/market/status", headers: S(member) });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: "too_many_requests" });
    expect(over.headers["retry-after"]).toBeDefined();
    for (let i = 0; i < MEMBER_SHARED_PER_MINUTE + 5; i++) expect((await app.inject({ method: "GET", url: "/api/market/status", headers: S(owner) })).statusCode).toBe(200);
    clock.t += 61_000;
    expect((await app.inject({ method: "GET", url: "/api/market/status", headers: S(member) })).statusCode).toBe(200);
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
    // 되찾은 뒤 앱에서 비밀번호를 바꾸고 변수를 지우는 것을 잊은 채 다시 배포해도 — 같은 값은 한 번만 적용 (되돌리지 않고, 로그아웃되지 않음)
    const changed = await third.app.inject({ method: "POST", url: "/api/auth/password", headers: S(mine), payload: { current: "mine2026", next: "later2027", nextConfirm: "later2027" } });
    expect(changed.statusCode, changed.body).toBe(200);
    await register(third.app, HERE, S(mine));
    await third.app.close();
    opened.splice(opened.indexOf(third.app), 1);
    const fourth = await makeApp({ db, clock, env: { OWNER_RESET_PASSWORD: "mine2026" } });
    expect(await fourth.app.authService.resetOwnerPassword("mine2026")).toBe("applied");
    expect((await fourth.app.inject({ method: "GET", url: "/api/stocks", headers: S(mine) })).statusCode).toBe(200);
    expect(await deviceRows(db)).toEqual([HERE]);
    expect((await fourth.app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId: OWNER, password: "later2027" } })).statusCode).toBe(200);
    // 다른 값을 넣으면 다시 적용된다 (또 잃어버렸을 때)
    expect(await fourth.app.authService.resetOwnerPassword("again2028")).toBe("reset");
    expect((await fourth.app.inject({ method: "GET", url: "/api/stocks", headers: S(mine) })).json().code).toBe("session_invalid");
  });

  it("주인이 없으면 아무것도 하지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    dbs.push(db);
    const auth = new AuthService({ db, now: () => new Date(T0), scryptN: 1024 });
    expect(await auth.resetOwnerPassword("abcd1234")).toBe("no_owner");
  });
});
