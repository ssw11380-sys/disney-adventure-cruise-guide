import { readFileSync } from "node:fs";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthService, REMEMBER_MS, SHORT_MS } from "../src/auth/authService.js";
import { hashCost, hashPassword, looksLikeToken, newSessionToken, tokenHash, verifyPassword } from "../src/auth/password.js";
import { loginIdKey, normalizeEmail, normalizeLoginId, signupErrors, type SignupInput } from "../src/auth/rules.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Providers } from "../src/providers/index.js";
import { fakeProviders } from "./helpers.js";

/**
 * 로그인·회원가입 (계정 A단계, 플래그 accounts). 시계는 고정(바꿀 수 있는 가짜 시계), 해시 비용은 낮춘다(scryptN 1024 — 규칙은 같다).
 * 기존 테스트는 비상 끄기(ACCOUNTS_DISABLED=1, vitest.config)로 도는데, 이 파일은 켠다
 */
vi.stubEnv("ACCOUNTS_DISABLED", "");
afterAll(() => vi.unstubAllEnvs());

const T0 = Date.parse("2026-09-28T10:00:00+09:00");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OWNER = "서성원";
const NFD_OWNER = OWNER.normalize("NFD");

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

async function makeApp(o: { apiToken?: string; providers?: Partial<Providers>; env?: Record<string, string> } = {}): Promise<Ctx> {
  const clock = { t: T0 };
  const db = await createMigratedDb(":memory:");
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:", ...(o.apiToken ? { API_TOKEN: o.apiToken } : {}), ...o.env }),
    db,
    providers: fakeProviders(o.providers),
    logger: false,
    enableScheduler: false,
    now: () => new Date(clock.t),
    auth: { scryptN: 1024 },
  });
  const c = { app, db, clock };
  opened.push(c);
  return c;
}

const sessionHeader = (token: string) => ({ "x-session-token": token });

async function login(app: FastifyInstance, loginId: string, password: string, remember = true, extra: Partial<InjectOptions> = {}) {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { loginId, password, remember }, ...extra } as InjectOptions);
}

async function ownerToken(app: FastifyInstance, remember = true): Promise<string> {
  const r = await login(app, OWNER, "1111", remember);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().token as string;
}

async function signup(app: FastifyInstance, loginId: string, email: string, password = "abcd1234", remoteAddress = "10.0.0.1") {
  return app.inject({ method: "POST", url: "/api/auth/signup", payload: { loginId, password, passwordConfirm: password, email }, remoteAddress });
}

describe("비밀번호 해시·세션 토큰", () => {
  it("scrypt 해시는 매개변수를 함께 적고, 맞는 비밀번호만 통과, 소금이 달라 같은 비밀번호도 해시가 다르다", async () => {
    const h = await hashPassword("abcd1234", 1024);
    expect(h).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hashCost(h)).toBe(1024);
    expect(await verifyPassword("abcd1234", h)).toBe(true);
    expect(await verifyPassword("abcd1235", h)).toBe(false);
    expect(await verifyPassword("ABCD1234", h)).toBe(false);
    expect(await hashPassword("abcd1234", 1024)).not.toBe(h);
    // 기본 비용은 16384
    expect(hashCost(await hashPassword("x"))).toBe(16_384);
  });

  it("NFC·NFD 로 넣은 같은 글자는 같은 비밀번호, 모양이 틀린 해시는 오류 없이 false", async () => {
    const h = await hashPassword("가나다abc123", 1024);
    expect(await verifyPassword("가나다abc123".normalize("NFD"), h)).toBe(true);
    for (const bad of ["", "scrypt$", "bcrypt$1$2$3$4$5", "scrypt$x$8$1$AAAA$AAAA", "scrypt$1024$8$1$$"]) expect(await verifyPassword("a", bad)).toBe(false);
  });

  it("세션 토큰은 gzs1_ + 43자, DB 에는 sha256 hex 만", () => {
    const t = newSessionToken();
    expect(t).toMatch(/^gzs1_[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(t);
    expect(tokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(looksLikeToken(t)).toBe(true);
    for (const bad of ["", "gzs1_", "abc", `gzs1_${"a".repeat(200)}`, "gzs1_a b", "Bearer x"]) expect(looksLikeToken(bad)).toBe(false);
  });
});

describe("회원가입 규칙 (공용 픽스처 shared/fixtures/authRules.json — 앱과 같은 결과)", () => {
  const fx = JSON.parse(readFileSync(new URL("../../shared/fixtures/authRules.json", import.meta.url), "utf8")) as {
    signup: Array<{ name: string; input: SignupInput; fields: Record<string, string>; normalized?: { loginId: string; loginIdKey: string; email: string } }>;
  };
  for (const c of fx.signup) {
    it(c.name, () => {
      expect(signupErrors(c.input)).toEqual(c.fields);
      if (c.normalized) {
        expect(normalizeLoginId(c.input.loginId)).toBe(c.normalized.loginId);
        expect(loginIdKey(c.input.loginId)).toBe(c.normalized.loginIdKey);
        expect(normalizeEmail(c.input.email)).toBe(c.normalized.email);
      }
    });
  }

  it("서버도 같은 칸별 코드를 한 번에 준다 (400 invalid + fields)", async () => {
    const { app, db } = await makeApp();
    let i = 0;
    for (const c of fx.signup) {
      // 맞는 예마다 새로 (같은 아이디·이메일을 여러 예가 쓴다)
      await db.deleteFrom("users").where("is_owner", "=", 0).execute();
      const r = await app.inject({ method: "POST", url: "/api/auth/signup", payload: c.input, remoteAddress: `10.1.0.${++i}` });
      if (Object.keys(c.fields).length) {
        expect(r.statusCode, c.name).toBe(400);
        expect(r.json(), c.name).toMatchObject({ error: "INVALID", code: "invalid", fields: c.fields });
      } else expect(r.statusCode, `${c.name} ${r.body}`).toBe(201);
    }
  });
});

describe("주인 계정", () => {
  it("서버를 켤 때 한 번만 만든다 — 다시 켜도(재배포) 바꾼 비밀번호를 1111 로 되돌리지 않는다", async () => {
    const { app, db } = await makeApp();
    const rows = await db.selectFrom("users").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ login_id: OWNER, login_id_key: OWNER, email: null, is_owner: 1, initial_password: 1 });
    expect(rows[0]!.password_hash).not.toContain("1111");
    const token = await ownerToken(app);
    const ch = await app.inject({ method: "POST", url: "/api/auth/password", headers: sessionHeader(token), payload: { current: "1111", next: "newpass99", nextConfirm: "newpass99" } });
    expect(ch.statusCode, ch.body).toBe(200);
    // 같은 DB 로 서버를 다시 켠다
    const again = new AuthService({ db, scryptN: 1024 });
    expect(await again.ensureOwner()).toBe("exists");
    expect(await again.ensureOwner()).toBe("exists");
    expect((await db.selectFrom("users").select("id").execute()).length).toBe(1);
    expect((await login(app, OWNER, "1111")).statusCode).toBe(400);
    expect((await login(app, OWNER, "newpass99")).statusCode).toBe(200);
  });

  it("켤 때 주인 확인이 실패했어도(DB 오류) 주인 아이디로는 가입할 수 없고, 다음 로그인 전에 주인을 다시 만든다 (검증 5차 — 남이 먼저 차지하지 못하게)", async () => {
    const db = await createMigratedDb(":memory:");
    try {
      // 켤 때 ensureOwner 가 실패한 서버 (주인 없음) — 서비스만 만들고 ensureOwner 는 부르지 않는다
      const auth = new AuthService({ db, scryptN: 1024 });
      const input = { loginId: "  서성원 ", password: "abcd1234", passwordConfirm: "abcd1234", email: "x@example.com", remember: true, ip: "10.0.0.1" };
      await expect(auth.signup(input)).rejects.toMatchObject({ status: 409, code: "login_id_taken" });
      // 가입이 주인 확인을 다시 해 주인이 생겼다
      expect(await db.selectFrom("users").select(["login_id", "is_owner"]).execute()).toEqual([{ login_id: OWNER, is_owner: 1 }]);
      const fresh = await createMigratedDb(":memory:");
      try {
        const late = new AuthService({ db: fresh, scryptN: 1024 });
        // 로그인도 먼저 주인을 확인한다 — 처음 비밀번호로 바로 들어간다
        const r = await late.login({ loginId: OWNER, password: "1111", remember: true, ip: "10.0.0.2" });
        expect(r.user).toMatchObject({ loginId: OWNER, isOwner: true, usingInitialPassword: true });
      } finally {
        await fresh.destroy();
      }
    } finally {
      await db.destroy();
    }
  });

  it("주인 아이디를 (예전에) 주인 아닌 계정이 차지했으면 그 계정을 주인으로 올리지 않고 'taken' — 운영자가 확인", async () => {
    const db = await createMigratedDb(":memory:");
    try {
      await db.insertInto("users").values({ login_id: OWNER, login_id_key: loginIdKey(OWNER), email: "t@example.com", password_hash: await hashPassword("abcd1234", 1024), is_owner: 0, initial_password: 0, created_at: "x", updated_at: "x" }).execute();
      const auth = new AuthService({ db, scryptN: 1024 });
      expect(await auth.ensureOwner()).toBe("taken");
      expect(await db.selectFrom("users").select("is_owner").execute()).toEqual([{ is_owner: 0 }]);
    } finally {
      await db.destroy();
    }
  });

  it("OWNER_LOGIN_ID·OWNER_INITIAL_PASSWORD 로 바꿀 수 있다 (없을 때만)", async () => {
    const { app } = await makeApp({ env: { OWNER_LOGIN_ID: "  Owner_A ", OWNER_INITIAL_PASSWORD: "s3cret-init" } });
    expect((await login(app, "owner_a", "s3cret-init")).json().user).toMatchObject({ loginId: "Owner_A", isOwner: true, usingInitialPassword: true });
  });

  it("비상 끄기(ACCOUNTS_DISABLED=1)면 주인을 만들지 않고, 플래그를 앱에 꺼짐으로 주고, 관문도 없다", async () => {
    const { app, db } = await makeApp({ env: { ACCOUNTS_DISABLED: "1" } });
    expect(await db.selectFrom("users").select("id").execute()).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/api/features" })).json().features.accounts).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/stocks" })).statusCode).toBe(200);
    expect((await login(app, OWNER, "1111")).statusCode).toBe(404);
  });
});

describe("로그인", () => {
  it("맞으면 토큰·사용자·세션, 처음 비밀번호 표시. 틀린 비밀번호와 없는 아이디는 같은 응답", async () => {
    const { app } = await makeApp();
    const ok = await login(app, OWNER, "1111");
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.token).toMatch(/^gzs1_/);
    expect(body.user).toEqual({ id: expect.any(Number), loginId: OWNER, email: null, isOwner: true, usingInitialPassword: true });
    expect(body.session).toEqual({ id: expect.any(Number), remember: true, expiresAt: "2027-09-28T10:00:00+09:00" });
    // 아이디는 NFD·앞뒤 공백·대소문자와 상관없이
    expect((await login(app, ` ${NFD_OWNER} `, "1111")).statusCode).toBe(200);
    const wrong = await login(app, OWNER, "1112");
    const unknown = await login(app, "nobody", "1111");
    expect(wrong.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: "BAD_CREDENTIALS", code: "bad_credentials", message: "아이디 또는 비밀번호가 맞지 않아요" });
    expect(unknown.json()).toEqual(wrong.json());
    // 빈 칸
    expect((await login(app, "", "")).json()).toMatchObject({ code: "invalid", fields: { loginId: "required", password: "required" } });
  });

  it("같은 아이디 5번 틀리면 10분 잠금 (맞는 비밀번호도 429), 10분 지나면 풀림 — 없는 아이디도 똑같이 잠긴다", async () => {
    const { app, clock } = await makeApp();
    for (let i = 1; i <= 4; i++) expect((await login(app, OWNER, "bad")).statusCode).toBe(400);
    const fifth = await login(app, OWNER, "bad");
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ code: "too_many_attempts", message: "여러 번 틀려서 잠시 막아 두었어요. 10분 뒤에 다시 해 주세요", retryAfterSec: 600 });
    expect(fifth.headers["retry-after"]).toBe("600");
    expect((await login(app, OWNER, "1111")).statusCode).toBe(429);
    // 다른 아이디는 상관없음
    expect((await signup(app, "tester", "t@example.com")).statusCode).toBe(201);
    expect((await login(app, "tester", "abcd1234")).statusCode).toBe(200);
    // 없는 아이디도 5번이면 같은 잠김
    for (let i = 1; i <= 4; i++) expect((await login(app, "ghost", "bad")).statusCode).toBe(400);
    expect((await login(app, "ghost", "bad")).json()).toEqual(fifth.json());
    clock.t += 9 * 60_000;
    expect((await login(app, OWNER, "1111")).statusCode).toBe(429);
    clock.t += 61_000;
    expect((await login(app, OWNER, "1111")).statusCode).toBe(200);
  });

  it("맞으면 틀린 횟수를 지운다 (4번 틀리고 맞은 뒤 다시 4번은 잠기지 않음)", async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 4; i++) await login(app, OWNER, "bad");
    expect((await login(app, OWNER, "1111")).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(app, OWNER, "bad")).statusCode).toBe(400);
  });

  it("IP 별 로그인 제한: 10분에 20번 (다른 IP 는 상관없음)", async () => {
    const { app, clock } = await makeApp();
    for (let i = 0; i < 20; i++) expect((await login(app, `user${i}`, "bad", true, { remoteAddress: "10.9.9.9" })).statusCode).toBe(400);
    const r = await login(app, OWNER, "1111", true, { remoteAddress: "10.9.9.9" });
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe("too_many_attempts");
    expect((await login(app, OWNER, "1111", true, { remoteAddress: "10.9.9.8" })).statusCode).toBe(200);
    clock.t += 10 * 60_000;
    expect((await login(app, OWNER, "1111", true, { remoteAddress: "10.9.9.9" })).statusCode).toBe(200);
  });
});

describe("요청 IP (Railway 앞단 프록시)", () => {
  it("Railway 에서는 프록시 한 단계를 믿어 X-Forwarded-For 의 실제 IP 로 센다 (설정 TRUST_PROXY_HOPS 로 바꿈), 그 밖에는 믿지 않는다", async () => {
    expect(loadConfig({ RAILWAY_ENVIRONMENT: "production" }).trustProxyHops).toBe(1);
    expect(loadConfig({}).trustProxyHops).toBe(0);
    expect(loadConfig({ RAILWAY_ENVIRONMENT: "production", TRUST_PROXY_HOPS: "0" }).trustProxyHops).toBe(0);
    // .env 에 빈 값으로 두면 기본값 (0 이 아니라)
    expect(loadConfig({ RAILWAY_ENVIRONMENT: "production", TRUST_PROXY_HOPS: "" }).trustProxyHops).toBe(1);
    const { app } = await makeApp({ env: { TRUST_PROXY_HOPS: "1" } });
    for (let i = 0; i < 20; i++) await login(app, `u${i}`, "bad", true, { headers: { "x-forwarded-for": "203.0.113.7" } });
    expect((await login(app, OWNER, "1111", true, { headers: { "x-forwarded-for": "203.0.113.7" } })).statusCode).toBe(429);
    expect((await login(app, OWNER, "1111", true, { headers: { "x-forwarded-for": "203.0.113.8" } })).statusCode).toBe(200);
    // 믿지 않으면 머리글로 IP 를 바꿔 제한을 피할 수 없다
    const plain = await makeApp();
    for (let i = 0; i < 20; i++) await login(plain.app, `u${i}`, "bad", true, { headers: { "x-forwarded-for": `198.51.100.${i}` } });
    expect((await login(plain.app, OWNER, "1111", true, { headers: { "x-forwarded-for": "198.51.100.99" } })).statusCode).toBe(429);
  });
});

describe("회원가입", () => {
  it("가입하면 바로 로그인(자동 로그인 켬 — 1년), 주인 아님, 이메일은 소문자", async () => {
    const { app } = await makeApp();
    const r = await signup(app, "Tester_01", "  Tester@Example.COM ");
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ user: { loginId: "Tester_01", email: "tester@example.com", isOwner: false, usingInitialPassword: false }, session: { remember: true, expiresAt: "2027-09-28T10:00:00+09:00" } });
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: sessionHeader(r.json().token) });
    expect(me.json().user).toMatchObject({ loginId: "Tester_01", isOwner: false });
  });

  it("아이디 중복: '서성원'을 NFD·공백으로 넣어도, 영문 대소문자만 달라도 409. 이메일도 대소문자 무시 중복 409", async () => {
    const { app } = await makeApp();
    for (const id of [OWNER, NFD_OWNER, ` ${OWNER}`]) {
      const r = await signup(app, id, `${Math.random().toString(36).slice(2)}@example.com`, "abcd1234", `10.2.0.${id.length}`);
      expect(r.statusCode, id).toBe(409);
      expect(r.json()).toMatchObject({ code: "login_id_taken", message: "이미 쓰고 있는 아이디예요", fields: { loginId: "login_id_taken" } });
    }
    expect((await signup(app, "Tester", "a@example.com", "abcd1234", "10.3.0.1")).statusCode).toBe(201);
    expect((await signup(app, "TESTER", "b@example.com", "abcd1234", "10.3.0.2")).json().code).toBe("login_id_taken");
    const dupEmail = await signup(app, "Other", "A@EXAMPLE.com", "abcd1234", "10.3.0.3");
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.json()).toMatchObject({ code: "email_taken", message: "이미 가입한 이메일이에요", fields: { email: "email_taken" } });
  });

  it("IP 별 가입 제한: 만드는 계정은 1시간에 5개", async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 5; i++) expect((await signup(app, `user${i}x`, `u${i}@example.com`, "abcd1234", "10.4.0.1")).statusCode).toBe(201);
    expect((await signup(app, "user9x", "u9@example.com", "abcd1234", "10.4.0.1")).statusCode).toBe(429);
  });

  it("겹친 아이디·이메일·형식 오류는 만든 계정 수(5)에 세지 않는다 — 시도는 IP 별 1시간 20번 (통신사 NAT 로 IP 를 나눠 써도 겹친 아이디 몇 번에 막히지 않게)", async () => {
    const { app } = await makeApp();
    expect((await signup(app, "taken01", "t0@example.com", "abcd1234", "10.4.1.9")).statusCode).toBe(201);
    for (let i = 0; i < 6; i++) expect((await signup(app, "taken01", `x${i}@example.com`, "abcd1234", "10.4.1.1")).json().code).toBe("login_id_taken");
    expect((await signup(app, "bad id!", "y@example.com", "abcd1234", "10.4.1.1")).json().code).toBe("invalid");
    for (let i = 0; i < 5; i++) expect((await signup(app, `fresh${i}x`, `f${i}@example.com`, "abcd1234", "10.4.1.1")).statusCode).toBe(201);
    // 지금까지 12번 시도 — 8번 더 하면 20번, 그다음은 형식 오류·겹침도 429 (알아내기를 막는 몫)
    for (let i = 0; i < 8; i++) expect((await signup(app, "taken01", `z${i}@example.com`, "abcd1234", "10.4.1.1")).statusCode).toBe(409);
    expect((await signup(app, "taken01", "last@example.com", "abcd1234", "10.4.1.1")).statusCode).toBe(429);
  });

  it("비밀번호는 로그에도 DB 에도 평문으로 남지 않는다", async () => {
    const lines: string[] = [];
    const clock = { t: T0 };
    const db = await createMigratedDb(":memory:");
    const stream = { write: (s: string) => void lines.push(s) };
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(), logger: { stream, level: "info" }, enableScheduler: false, now: () => new Date(clock.t), auth: { scryptN: 1024 } });
    opened.push({ app, db, clock });
    const r = await signup(app, "logcheck", "log@example.com", "Secretpw123");
    await login(app, "logcheck", "WrongPw999");
    await app.inject({ method: "GET", url: `/api/stream?session=${encodeURIComponent(r.json().token)}` });
    const log = lines.join("\n");
    const stored = JSON.stringify(await db.selectFrom("users").selectAll().execute()) + JSON.stringify(await db.selectFrom("sessions").selectAll().execute());
    for (const secret of ["Secretpw123", "WrongPw999", r.json().token as string]) {
      expect(log.includes(secret), secret).toBe(false);
      expect(stored.includes(secret), secret).toBe(false);
    }
    // 아이디·이메일도 로그에 남기지 않는다 (DB 에는 있다)
    expect(log).not.toContain("log@example.com");
    expect(log).not.toContain("logcheck");
    expect(log).toContain("session=[redacted]");
  });
});

describe("자동 로그인 (세션 기한·연장)", () => {
  it("켬: 1년, 쓸 때마다 연장하되 DB 에는 하루 한 번만 적는다. 1년 넘게 안 쓰면 끝", async () => {
    const { app, db, clock } = await makeApp();
    const token = await ownerToken(app, true);
    const row = () => db.selectFrom("sessions").select(["last_seen_at", "expires_at"]).where("token_hash", "=", tokenHash(token)).executeTakeFirstOrThrow();
    expect(await row()).toEqual({ last_seen_at: "2026-09-28T10:00:00+09:00", expires_at: "2027-09-28T10:00:00+09:00" });
    const get = () => app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(token) });
    clock.t += 23 * HOUR;
    expect((await get()).statusCode).toBe(200);
    expect(await row()).toEqual({ last_seen_at: "2026-09-28T10:00:00+09:00", expires_at: "2027-09-28T10:00:00+09:00" });
    clock.t += 2 * HOUR; // 25시간 뒤 (캐시 30초도 지남)
    expect((await get()).statusCode).toBe(200);
    expect(await row()).toEqual({ last_seen_at: "2026-09-29T11:00:00+09:00", expires_at: "2027-09-29T11:00:00+09:00" });
    // 364일 동안 안 씀 → 아직 됨 → 다시 1년
    clock.t += 364 * DAY;
    expect((await get()).statusCode).toBe(200);
    // 그 뒤 1년 + 1분 동안 안 씀 → 끝 (401 session_invalid)
    clock.t += REMEMBER_MS + 60_000;
    const end = await get();
    expect(end.statusCode).toBe(401);
    expect(end.json()).toEqual({ error: "SESSION_INVALID", code: "session_invalid", message: "다시 로그인해 주세요" });
  });

  it("끔: 12시간, 쓸 때마다 연장(15분에 한 번 적음). 12시간 넘게 안 쓰면 끝", async () => {
    const { app, clock } = await makeApp();
    const r = await login(app, OWNER, "1111", false);
    expect(r.json().session).toMatchObject({ remember: false, expiresAt: "2026-09-28T22:00:00+09:00" });
    const token = r.json().token as string;
    const get = () => app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(token) });
    for (let i = 0; i < 3; i++) {
      clock.t += 11 * HOUR;
      expect((await get()).statusCode).toBe(200);
    }
    clock.t += SHORT_MS + 60_000;
    expect((await get()).statusCode).toBe(401);
  });

  it("서버를 다시 켜도(같은 DB, 새 서버) 세션이 그대로", async () => {
    const { app, db } = await makeApp();
    const token = await ownerToken(app);
    const fresh = new AuthService({ db, now: () => new Date(T0 + HOUR), scryptN: 1024 });
    expect((await fresh.authenticate(token))?.user).toMatchObject({ loginId: OWNER, isOwner: true });
  });

  it("세션 DB 를 못 읽으면 401 이 아니라 503 auth_unavailable (앱이 로그아웃하지 않게)", async () => {
    const { app } = await makeApp();
    const token = await ownerToken(app);
    const spy = vi.spyOn(app.authService, "authenticate").mockRejectedValueOnce(new Error("db down"));
    const r = await app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(token) });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "auth_unavailable" });
    spy.mockRestore();
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(token) })).statusCode).toBe(200);
  });

  it("없는 토큰·모양이 틀린 토큰은 401 session_invalid", async () => {
    const { app } = await makeApp();
    for (const t of [newSessionToken(), "garbage", "gzs1_!!"]) {
      const r = await app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(t) });
      expect(r.statusCode, t).toBe(401);
      expect(r.json().code).toBe("session_invalid");
    }
  });
});

describe("로그아웃·비밀번호·이메일", () => {
  it("로그아웃: 이 세션만 끝남 (다른 기기는 그대로), 세션 없이 불러도 204", async () => {
    const { app } = await makeApp();
    const a = await ownerToken(app);
    const b = await ownerToken(app);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: sessionHeader(a) })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(a) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(b) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(204);
  });

  it("모든 기기에서 로그아웃: 이 기기 포함 모두 끝남, 다른 사람 세션은 그대로", async () => {
    const { app } = await makeApp();
    const a = await ownerToken(app);
    const b = await ownerToken(app);
    const other = (await signup(app, "someone", "s@example.com")).json().token as string;
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all", headers: sessionHeader(a) })).statusCode).toBe(204);
    for (const t of [a, b]) expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: sessionHeader(t) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: sessionHeader(other) })).statusCode).toBe(200);
    // 세션 없이 부르면 403 session_required
    expect((await app.inject({ method: "POST", url: "/api/auth/logout-all" })).json().code).toBe("session_required");
  });

  it("비밀번호 바꾸기: 지금 세션은 유지, 다른 세션은 끊김, 처음 비밀번호 표시가 꺼짐. 규칙·틀린 지금 비밀번호", async () => {
    const { app } = await makeApp();
    const here = await ownerToken(app);
    const phone2 = await ownerToken(app);
    const call = (payload: Record<string, string>) => app.inject({ method: "POST", url: "/api/auth/password", headers: sessionHeader(here), payload });
    expect((await call({ current: "0000", next: "abcd1234", nextConfirm: "abcd1234" })).json()).toMatchObject({ code: "bad_current_password", message: "지금 비밀번호가 맞지 않아요" });
    expect((await call({ current: "1111", next: "short1", nextConfirm: "short1" })).json()).toMatchObject({ code: "invalid", fields: { next: "password_length" } });
    expect((await call({ current: "1111", next: "abcdefgh", nextConfirm: "abcdefgh" })).json()).toMatchObject({ fields: { next: "password_mix" } });
    expect((await call({ current: "1111", next: "abcd1234", nextConfirm: "abcd12345" })).json()).toMatchObject({ fields: { nextConfirm: "password_mismatch" } });
    // 다른 이름(currentPassword·newPassword·newPasswordConfirm)도 받는다
    const ok = await call({ currentPassword: "1111", newPassword: "abcd1234", newPasswordConfirm: "abcd1234" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, revokedOthers: 1, user: { usingInitialPassword: false } });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: sessionHeader(here) })).json().user.usingInitialPassword).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(phone2) })).json().code).toBe("session_invalid");
    expect((await login(app, OWNER, "1111")).statusCode).toBe(400);
    expect((await login(app, OWNER, "abcd1234")).statusCode).toBe(200);
    // 아이디와 같은 비밀번호는 안 됨 (대소문자 무시)
    const other = (await signup(app, "pwuser12", "p@example.com")).json().token as string;
    const same = await app.inject({ method: "POST", url: "/api/auth/password", headers: sessionHeader(other), payload: { current: "abcd1234", next: "PWUSER12", nextConfirm: "PWUSER12" } });
    expect(same.json()).toMatchObject({ code: "invalid", fields: { next: "password_same_as_id" } });
  });

  it("이메일 등록·변경: 지금 비밀번호를 다시 받고, 형식·중복(다른 사람) 확인, 자기 이메일 그대로 저장은 됨", async () => {
    const { app, clock } = await makeApp();
    const owner = await ownerToken(app);
    await signup(app, "mailuser", "taken@example.com");
    const put = (email: string, current = "1111") => app.inject({ method: "PUT", url: "/api/auth/email", headers: sessionHeader(owner), payload: { email, current } });
    expect((await put("bad")).json()).toMatchObject({ code: "invalid", fields: { email: "email_format" } });
    expect((await put("", "")).json()).toMatchObject({ fields: { email: "required", current: "required" } });
    // 세션만 있고 비밀번호를 모르면 바꾸지 못한다 (이메일이 겹치는지도 알려 주지 않는다)
    expect((await put("TAKEN@example.com", "0000")).json()).toMatchObject({ code: "bad_current_password", fields: { current: "bad_current_password" } });
    expect((await put("TAKEN@example.com")).json()).toMatchObject({ code: "email_taken" });
    const ok = await put(" Owner@Example.com ");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ email: "owner@example.com", isOwner: true });
    // 다른 이름(currentPassword)도 받는다 (한 시간 5번 제한을 넘지 않게 시계를 옮긴다)
    clock.t += HOUR + 1000;
    expect((await app.inject({ method: "PUT", url: "/api/auth/email", headers: sessionHeader(owner), payload: { email: "owner@example.com", currentPassword: "1111" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: sessionHeader(owner) })).json().user.email).toBe("owner@example.com");
  });

  it("이메일 변경은 사람마다 1시간 5번 — 가입한 이메일인지 끝없이 알아내지 못하게", async () => {
    const { app, clock } = await makeApp();
    await signup(app, "victim01", "victim@example.com", "abcd1234", "10.6.0.1");
    const prober = (await signup(app, "prober01", "prober@example.com", "abcd1234", "10.6.0.2")).json().token as string;
    const put = (email: string) => app.inject({ method: "PUT", url: "/api/auth/email", headers: sessionHeader(prober), payload: { email, current: "abcd1234" } });
    for (let i = 0; i < 5; i++) expect((await put(`guess${i}@example.com`)).statusCode).toBe(200);
    const blocked = await put("victim@example.com");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe("too_many_attempts");
    clock.t += HOUR + 1000;
    expect((await put("victim@example.com")).json().code).toBe("email_taken");
  });
});

describe("관문 (플래그 켜짐/꺼짐 · API 토큰)", () => {
  it("켜짐: 세션 없이는 403 session_required (플래그·로그인·가입만 열림), 주인 세션이면 지금처럼", async () => {
    const { app } = await makeApp();
    const none = await app.inject({ method: "GET", url: "/api/stocks" });
    expect(none.statusCode).toBe(403);
    expect(none.json()).toMatchObject({ error: "SESSION_REQUIRED", code: "session_required" });
    expect((await app.inject({ method: "GET", url: "/api/market/status" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/features" })).json().features.accounts).toBe(true);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const token = await ownerToken(app);
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(token) })).statusCode).toBe(200);
    // X-Session 이름도 받는다
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: { "x-session": token } })).statusCode).toBe(200);
    // 퍼센트 인코딩한 경로로도 피하지 못한다
    expect((await app.inject({ method: "GET", url: "/%61pi/stocks" })).statusCode).toBe(403);
    // /health: 세션 없이는 공유 모습(주인 상세 없음), 주인 세션이면 상세 — 처음 비밀번호를 쓰는지는 어디에도 내보내지 않는다
    const shared = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(shared.viewer).toBe("shared");
    expect(shared.accounts).toBeUndefined();
    expect(shared.limited).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/health", headers: sessionHeader(token) })).json().accounts).toEqual({ enabled: true });
  });

  it("API 토큰은 그대로 앞에서 확인한다 — 토큰이 틀리면 로그인·세션이 있어도 401 UNAUTHORIZED (session_invalid 아님)", async () => {
    const { app } = await makeApp({ apiToken: "secret-123" });
    const bearer = { authorization: "Bearer secret-123" };
    const noToken = await login(app, OWNER, "1111");
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json().error).toBe("UNAUTHORIZED");
    expect(noToken.json().code).toBeUndefined();
    const ok = await login(app, OWNER, "1111", true, { headers: bearer });
    expect(ok.statusCode).toBe(200);
    const s = sessionHeader(ok.json().token);
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: s })).json().error).toBe("UNAUTHORIZED");
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: bearer })).json().code).toBe("session_required");
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: { ...bearer, ...s } })).statusCode).toBe(200);
  });

  it("꺼짐(관리 API): 지금과 같음 — 세션 없이 열리고 주인·모르는 세션 헤더도 그대로, /api/auth/* 는 404", async () => {
    const { app } = await makeApp();
    const token = await ownerToken(app);
    const off = await app.inject({ method: "PUT", url: "/api/admin/features", headers: sessionHeader(token), payload: { accounts: false } });
    expect(off.json().features.accounts).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/stocks" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader("garbage") })).statusCode).toBe(200);
    const auth404 = await login(app, OWNER, "1111");
    expect(auth404.statusCode).toBe(404);
    expect(auth404.json()).toEqual({ error: "NOT_FOUND", message: "없는 주소입니다: POST /api/auth/login" });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: sessionHeader(token) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/health" })).json().accounts).toBeUndefined();
    // 다시 켜면 기존 세션이 그대로 쓰인다
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accounts: true } });
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: sessionHeader(token) })).statusCode).toBe(200);
  });
});

describe("주인 아닌 계정 (A단계: 개인 데이터 기본 거절)", () => {
  async function seeded() {
    const c = await makeApp();
    await c.app.stockService.refreshMaster();
    const owner = await ownerToken(c.app);
    const reg = await c.app.inject({ method: "POST", url: "/api/stocks", headers: sessionHeader(owner), payload: { code: "005930", quantity: 777.77, avgPrice: 70000, memo: "OWNER-CANARY-7f3" } });
    expect(reg.statusCode, reg.body).toBe(201);
    const member = (await signup(c.app, "member1", "m@example.com")).json().token as string;
    return { ...c, owner, member };
  }

  it("읽기는 빈 값, 쓰기는 403 personal_data_not_ready, 관리는 403 owner_only — 주인 데이터는 그대로", async () => {
    const { app, db, member } = await seeded();
    const m = sessionHeader(member);
    const get = (url: string) => app.inject({ method: "GET", url, headers: m });
    expect((await get("/api/stocks")).json()).toEqual([]);
    expect((await get("/api/stocks?quotes=1")).json()).toEqual([]);
    expect((await get("/api/briefings/latest")).json()).toEqual([]);
    expect((await get("/api/price-alerts")).json()).toEqual({ rules: [] });
    expect((await get("/api/devices")).json()).toEqual([]);
    expect((await get("/api/scores/005930/history")).json()).toEqual({ code: "005930", items: [] });
    for (const [method, url, payload] of [
      ["POST", "/api/stocks", { code: "000660" }],
      ["PATCH", "/api/stocks/005930", { quantity: 1 }],
      ["DELETE", "/api/stocks/005930", undefined],
      ["POST", "/api/devices", { token: "ExponentPushToken[member]", platform: "android" }],
      ["GET", "/api/widget", undefined],
      ["GET", "/api/notifications/settings", undefined],
      ["POST", "/api/briefings/run", { session: "morning" }],
    ] as const) {
      const r = await app.inject({ method, url, headers: m, ...(payload ? { payload } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json(), `${method} ${url}`).toEqual({ error: "PERSONAL_DATA_NOT_READY", code: "personal_data_not_ready", message: "개인 종목 기능은 준비 중이에요" });
    }
    expect((await get("/api/admin/features")).json()).toMatchObject({ code: "owner_only" });
    expect((await app.inject({ method: "PUT", url: "/api/admin/features", headers: m, payload: { accounts: false } })).statusCode).toBe(403);
    const rows = await db.selectFrom("registered_stocks").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "005930", quantity: 777.77, memo: "OWNER-CANARY-7f3" });
    expect(await db.selectFrom("devices").select("token").execute()).toHaveLength(0);
  });

  it("종목 상세: 주인이 등록한 종목도 등록하지 않은 종목과 바이트까지 같은 미리 보기 (수량·평단·메모 없음)", async () => {
    const { app, owner, member } = await seeded();
    const mine = await app.inject({ method: "GET", url: "/api/stocks/005930", headers: sessionHeader(owner) });
    expect(mine.json()).toMatchObject({ registered: true, quantity: 777.77, memo: "OWNER-CANARY-7f3" });
    const seen = await app.inject({ method: "GET", url: "/api/stocks/005930", headers: sessionHeader(member) });
    expect(seen.statusCode).toBe(200);
    expect(seen.body).not.toContain("OWNER-CANARY");
    expect(seen.body).not.toContain("777.77");
    expect(seen.json()).toMatchObject({ code: "005930", registered: false, quantity: null, avgPrice: null, memo: null, tossSynced: false, inTossSnapshot: false });
    // 주인이 등록하지 않은 종목을 주인이 볼 때와 같은 모양
    const other = await app.inject({ method: "GET", url: "/api/stocks/000660", headers: sessionHeader(member) });
    const otherOwner = await app.inject({ method: "GET", url: "/api/stocks/000660", headers: sessionHeader(owner) });
    expect(other.body).toBe(otherOwner.body);
    // 공유 경로는 그대로 열린다
    expect((await app.inject({ method: "GET", url: "/api/stocks/005930/quote", headers: sessionHeader(member) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/market/status", headers: sessionHeader(member) })).statusCode).toBe(200);
  });

  it("AI 분석: 주인 아닌 계정은 새로 만들기(refresh)를 무시하고, 서로 다른 분석은 하루 10건까지 (검증 4차 — 캐시에 있든 없든 센다, 오늘 본 것은 계속)", async () => {
    const { app, db, member, owner } = await seeded();
    const m = sessionHeader(member);
    const first = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: m });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ cached: false, id: 0 });
    const again = await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company?refresh=1", headers: m });
    // 새로 만들지 않았다 (분석 행 하나 — 같은 글)
    expect(again.json()).toMatchObject({ cached: false, id: 0, content: first.json().content });
    expect(await db.selectFrom("analyses").select("id").execute()).toHaveLength(1);
    const codes = ["000660", "005935", "247540", "465580"];
    let made = 1;
    for (const kind of ["company", "value", "technical"]) {
      for (const code of codes) {
        if (made >= 10) break;
        const r = await app.inject({ method: "GET", url: `/api/stocks/${code}/analysis/${kind}`, headers: m });
        expect(r.statusCode, r.body).toBe(200);
        made++;
      }
    }
    const over = await app.inject({ method: "GET", url: "/api/stocks/005935/analysis/technical", headers: m });
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe("ai_daily_limit");
    // 오늘 이미 본 것은 계속 보인다, 주인은 제한 없음
    expect((await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/company", headers: m })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/stocks/005935/analysis/technical", headers: sessionHeader(owner) })).statusCode).toBe(200);
  });

  it("웹소켓 스트림(/api/stream)은 주인만 — 주인 아닌 계정은 업그레이드 전에 403", async () => {
    const { app, member } = await seeded();
    const r = await app.inject({ method: "GET", url: `/api/stream?session=${member}` });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("personal_data_not_ready");
  });
});
