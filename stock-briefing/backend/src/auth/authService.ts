import type { FastifyBaseLogger } from "fastify";
import type { Expression, Kysely, SqlBool } from "kysely";
import type { Db } from "../db/index.js";
import type { Database } from "../db/schema.js";
import { seoulIso } from "../lib/time.js";
import { hashPassword, looksLikeToken, newSessionToken, SCRYPT_N, tokenHash, verifyPassword } from "./password.js";
import { LoginGuard, LoginLock, WindowLimiter } from "./rateLimit.js";
import { confirmError, emailError, loginIdKey, normalizeEmail, normalizeLoginId, passwordError, signupErrors, type SignupInput } from "./rules.js";

/**
 * 로그인·회원가입 (계정 A단계, 플래그 accounts).
 *  - 주인 계정: 서버를 켤 때 주인(is_owner=1)이 없을 때만 만든다 (아이디 '서성원', 처음 비밀번호 1111 — 설정에서 바꾼다). 이미 있으면 건드리지 않는다
 *  - 세션: 자동 로그인 켬 = 365일, 쓸 때마다 연장(하루 한 번까지만 DB 에 적음) / 끔 = 12시간, 쓸 때마다 연장(15분에 한 번까지만 적음).
 *    서버를 다시 켜도(배포) DB 에 있어 유지된다. 끝나는 경우: 직접 로그아웃 · 모든 기기에서 로그아웃 · 다른 기기에서 비밀번호 변경 · 기한 지남
 *  - 토큰은 sha256 만 DB 에, 서버 메모리 캐시 30초 (이 서버에서 끊은 세션은 바로 지운다 — 끊는 동안 읽던 요청이 옛 상태를 다시 캐시에 넣지 않게 세대 번호로 막는다)
 *  - 세션을 끊으면 그 세션으로 등록한 푸시 기기도 지운다 (devices.session_id). '모든 기기에서 로그아웃'·비밀번호 변경은 계정 전(세션 없이)
 *    등록한 주인 기기도 지운다 — 잃어버린 폰으로 주인 계좌 알림이 가지 않게. 앱은 주인으로 다시 로그인하면 이 기기를 다시 등록한다
 *  - 잠금: 같은 아이디를 **같은 IP** 에서 5번 틀리면 그 IP 만 10분 (검증 4차 — 남이 다른 곳에서 주인 아이디를 틀려도 주인 폰은 잠기지 않게),
 *    모든 IP 를 합쳐 50번이면 그 아이디 전체 10분. 없는 아이디도 똑같이 (계정이 있는지 드러나지 않게). 속도 제한은 IP·사용자별 (메모리)
 *    로그인한 뒤의 비밀번호·이메일 변경(지금 비밀번호 다시 확인)은 로그인 잠금과 따로 **세션마다** 5번·10분 — 공개된 아이디로 로그인을 일부러 틀려
 *    주인을 잠가 두어도, 이미 로그인한 주인이 설정에서 처음 비밀번호(1111)를 바꾸는 것은 막히지 않게 (검증 지적)
 *  - 비상 주인 비밀번호 되돌리기: OWNER_RESET_PASSWORD (서버를 켤 때 — **같은 값은 한 번만** 적용. 적용한 값의 해시를 meta 에 적어 두어,
 *    변수를 지우는 것을 잊고 앱에서 비밀번호를 바꾼 뒤 다시 배포해도 되돌리지 않고 주인이 로그아웃되지 않는다)
 *  - 로그: 아이디·이메일·비밀번호·토큰은 적지 않는다
 */
export const REMEMBER_MS = 365 * 86_400_000;
export const SHORT_MS = 12 * 3_600_000;
/** 연장을 DB 에 적는 최소 간격 */
export const REMEMBER_TOUCH_MS = 86_400_000;
export const SHORT_TOUCH_MS = 15 * 60_000;
const CACHE_MS = 30_000;
/** 끝난 세션을 지우기까지 */
const PURGE_AFTER_MS = 30 * 86_400_000;
/** 로그인 비밀번호 길이 상한 (해시 부담 — 가입 규칙은 64자) */
const LOGIN_PASSWORD_MAX = 256;
/** 적용한 OWNER_RESET_PASSWORD 값의 해시 (scrypt — 같은 값이면 다시 적용하지 않는다) */
export const OWNER_RESET_META_KEY = "accounts.ownerResetApplied";

export interface AuthUser {
  id: number;
  loginId: string;
  email: string | null;
  isOwner: boolean;
  /** 처음 비밀번호(1111)를 쓰는 중 — 앱이 한 번 권유하고 설정에 띠를 둔다 */
  usingInitialPassword: boolean;
}

export interface SessionView {
  id: number;
  remember: boolean;
  expiresAt: string;
}

export interface SessionContext {
  user: AuthUser;
  session: SessionView;
}

/** 인증 실패 응답 (status + 앱이 분기에 쓰는 소문자 code). 본문은 이 저장소 표준 { error, message } 에 code 를 더한다 */
export class AuthFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AuthFailure";
  }
  body(): Record<string, unknown> {
    return { error: this.code.toUpperCase(), code: this.code, message: this.message, ...this.extra };
  }
}

export const MSG = {
  badCredentials: "아이디 또는 비밀번호가 맞지 않아요",
  /** 잠김: 남은 시간을 분으로 (올림 — 앱도 retryAfterSec 으로 같은 문장을 만든다) */
  lockedFor: (sec: number) => `여러 번 틀려서 잠시 막아 두었어요. ${Math.max(1, Math.ceil(sec / 60))}분 뒤에 다시 해 주세요`,
  tooMany: "요청이 너무 잦아요. 잠시 뒤에 다시 해 주세요",
  invalid: "입력한 내용을 확인해 주세요",
  loginIdTaken: "이미 쓰고 있는 아이디예요",
  emailTaken: "이미 가입한 이메일이에요",
  badCurrent: "지금 비밀번호가 맞지 않아요",
  conflict: "같은 때에 다른 요청과 겹쳤어요. 다시 해 주세요",
} as const;

/**
 * 유일 색인 위반인지 (SQLite SQLITE_CONSTRAINT_UNIQUE · Postgres 23505). 같은 순간의 가입·이메일 변경이 겹치면 여기로 온다 —
 * 500 으로 두면 오류 로그에 Postgres detail('Key (email)=(…)')이 남을 수 있어 409 로 바꾼다
 */
export function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const x = e as { code?: unknown; message?: unknown };
  return x.code === "23505" || x.code === "SQLITE_CONSTRAINT_UNIQUE" || (typeof x.message === "string" && /UNIQUE constraint failed|duplicate key value/i.test(x.message));
}

interface CachedSession {
  sessionId: number;
  userId: number;
  remember: boolean;
  lastSeenAt: number;
  expiresAt: number;
  user: AuthUser;
}

export interface AuthServiceDeps {
  db: Db;
  now?: () => Date;
  log?: Pick<FastifyBaseLogger, "info" | "warn">;
  ownerLoginId?: string;
  ownerInitialPassword?: string;
  /** 해시 비용 (테스트에서만 낮춘다) */
  scryptN?: number;
}

interface UserRow {
  id: number;
  login_id: string;
  email: string | null;
  is_owner: number;
  initial_password: number;
  password_hash: string;
}

const toUser = (r: Pick<UserRow, "id" | "login_id" | "email" | "is_owner" | "initial_password">): AuthUser => ({
  id: Number(r.id),
  loginId: r.login_id,
  email: r.email,
  isOwner: Number(r.is_owner) === 1,
  usingInitialPassword: Number(r.initial_password) === 1,
});

export class AuthService {
  private readonly now: () => Date;
  private readonly nowMs: () => number;
  private readonly cache = new Map<string, { at: number; s: CachedSession }>();
  /** 로그인 잠금 (아이디 + IP, 아이디 전체는 훨씬 높은 횟수) */
  readonly lock: LoginGuard;
  /** 로그인한 뒤 지금 비밀번호를 다시 확인할 때(비밀번호·이메일 변경)의 잠금 — 세션마다, 로그인 잠금과 따로 */
  readonly reauthLock: LoginLock;
  private readonly loginIp: WindowLimiter;
  /** 가입 시도(형식 오류·겹침 포함)는 IP 별 넉넉히, 실제로 만든 계정은 IP 별 적게 — 통신사 NAT 로 IP 를 나눠 쓰는 사람이 겹친 아이디 몇 번에 막히지 않게 */
  private readonly signupTryIp: WindowLimiter;
  private readonly signupIp: WindowLimiter;
  private readonly signupAll: WindowLimiter;
  private readonly passwordUser: WindowLimiter;
  private readonly emailUser: WindowLimiter;
  private dummy: Promise<string> | null = null;
  private readonly n: number;
  /** 세션을 끊을 때마다 늘린다 — 끊기 전에 DB 를 읽기 시작한 요청이 끊긴 세션을 캐시에 다시 넣지 않게 */
  private gen = 0;
  /** 주인 계정을 확인했는지 (검증 5차 — 켤 때 DB 오류로 실패했으면 로그인·가입 전에 다시 해 본다) */
  private ownerChecked = false;

  constructor(private readonly deps: AuthServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.nowMs = () => this.now().getTime();
    this.n = deps.scryptN ?? SCRYPT_N;
    this.lock = new LoginGuard(this.nowMs);
    this.reauthLock = new LoginLock(this.nowMs);
    this.loginIp = new WindowLimiter(20, 10 * 60_000, this.nowMs);
    this.signupTryIp = new WindowLimiter(20, 3_600_000, this.nowMs);
    this.signupIp = new WindowLimiter(5, 3_600_000, this.nowMs);
    this.signupAll = new WindowLimiter(30, 86_400_000, this.nowMs);
    this.passwordUser = new WindowLimiter(10, 10 * 60_000, this.nowMs);
    this.emailUser = new WindowLimiter(5, 3_600_000, this.nowMs);
  }

  // ── 주인 계정 ────────────────────────────────────────────────

  /** 주인 아이디 (OWNER_LOGIN_ID, 없으면 '서성원') — 가입에서 늘 예약 */
  private ownerLoginId(): string {
    return normalizeLoginId(this.deps.ownerLoginId || "서성원");
  }

  /**
   * 주인이 없을 때만 만든다 (있으면 비밀번호를 되돌리지 않는다). 여러 서버가 동시에 켜져도 한 명.
   * 주인 아이디를 이미 주인 아닌 계정이 쓰고 있으면(검증 5차 전 — 켤 때 실패한 사이 누가 그 아이디로 가입) 그 계정을 주인으로 올리지 않고 "taken" (운영자가 확인)
   */
  async ensureOwner(): Promise<"created" | "exists" | "taken"> {
    const owner = await this.deps.db.selectFrom("users").select("id").where("is_owner", "=", 1).executeTakeFirst();
    if (owner) {
      this.ownerChecked = true;
      return "exists";
    }
    const loginId = this.ownerLoginId();
    const ts = seoulIso(this.now());
    const res = await this.deps.db
      .insertInto("users")
      .values({
        login_id: loginId,
        login_id_key: loginIdKey(loginId),
        email: null,
        password_hash: await hashPassword(this.deps.ownerInitialPassword || "1111", this.n),
        is_owner: 1,
        initial_password: 1,
        created_at: ts,
        updated_at: ts,
      })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    const created = Number(res.numInsertedOrUpdatedRows ?? 0) > 0;
    this.ownerChecked = true;
    if (created) {
      this.deps.log?.info({}, "계정: 주인 계정을 만들었습니다 (처음 비밀번호 — 설정에서 바꾸세요)");
      return "created";
    }
    // 만들지 못함: 다른 서버가 먼저 만들었거나(주인 있음), 주인 아이디를 주인 아닌 계정이 쓰고 있다
    if (await this.deps.db.selectFrom("users").select("id").where("is_owner", "=", 1).executeTakeFirst()) return "exists";
    this.deps.log?.warn({}, "계정: 주인 아이디를 주인 아닌 계정이 쓰고 있어 주인 계정을 만들지 못했습니다 (DB 에서 그 계정을 확인해 주세요)");
    return "taken";
  }

  /** 켤 때 주인 확인이 실패했으면 다시 (로그인·가입 전 — 한 번 확인되면 다시 묻지 않는다). 또 실패해도 로그인·가입은 그대로 진행 */
  private async ownerReady(): Promise<void> {
    if (this.ownerChecked) return;
    await this.ensureOwner().catch((e: unknown) => this.deps.log?.warn({ err: e instanceof Error ? e.message : String(e) }, "계정: 주인 계정 확인 다시 실패"));
  }

  /** 주인이 아직 처음 비밀번호인지 (테스트·운영 확인용 — /health 에는 내보내지 않는다). 주인이 없으면 null */
  async ownerUsesInitialPassword(): Promise<boolean | null> {
    const r = await this.deps.db.selectFrom("users").select("initial_password").where("is_owner", "=", 1).executeTakeFirst();
    return r ? Number(r.initial_password) === 1 : null;
  }

  /**
   * 비상 주인 비밀번호 되돌리기 (Railway 변수 OWNER_RESET_PASSWORD, 서버를 켤 때). 공개 저장소에 처음 비밀번호가 적혀 있어 누가 먼저 로그인해
   * 비밀번호를 바꾸면 되찾을 길이 없기 때문.
   *  - 같은 값은 **한 번만** 적용한다 (적용한 값의 scrypt 해시를 meta 에): 되찾은 뒤 앱에서 비밀번호를 바꾸고 변수를 지우는 것을 잊어도,
   *    다음 배포 때 되돌리거나 주인의 모든 기기를 로그아웃시키지 않는다 ("웬만해선 로그인이 풀리지 않게"). 다른 값을 넣으면 다시 적용된다
   *  - 지금 비밀번호와 같으면 바꾸지 않는다 (적용한 것으로 적어 둔다)
   * 바꾸면: 처음 비밀번호 표시를 지우고(직접 정한 값이므로), 주인의 모든 세션과 주인 기기 등록을 끊고, 잠금을 푼다
   */
  async resetOwnerPassword(password: string): Promise<"reset" | "same" | "applied" | "no_owner"> {
    const row = await this.deps.db.selectFrom("users").select(["id", "login_id", "password_hash"]).where("is_owner", "=", 1).executeTakeFirst();
    if (!row) return "no_owner";
    const applied = await this.deps.db.selectFrom("meta").select("value").where("key", "=", OWNER_RESET_META_KEY).executeTakeFirst();
    if (applied && (await verifyPassword(password, applied.value))) return "applied";
    const hash = await hashPassword(password, this.n);
    const remember = (db: Kysely<Database>) =>
      db.insertInto("meta").values({ key: OWNER_RESET_META_KEY, value: hash }).onConflict((oc) => oc.column("key").doUpdateSet({ value: hash })).execute();
    if (await verifyPassword(password, row.password_hash)) {
      await remember(this.deps.db);
      return "same";
    }
    const ts = seoulIso(this.now());
    const userId = Number(row.id);
    this.gen++;
    await this.deps.db.transaction().execute(async (trx) => {
      await trx.updateTable("users").set({ password_hash: hash, initial_password: 0, updated_at: ts }).where("id", "=", userId).execute();
      await trx.updateTable("sessions").set({ revoked_at: ts }).where("user_id", "=", userId).where("revoked_at", "is", null).execute();
      await dropDevices(trx, { userId, unbound: true });
      await remember(trx);
    });
    this.forget((s) => s.userId === userId);
    this.lock.clear(loginIdKey(row.login_id));
    this.deps.log?.warn({ userId }, "계정: 주인 비밀번호를 OWNER_RESET_PASSWORD 로 되돌렸습니다 (주인 세션·기기 등록을 모두 끊음 — 같은 값은 다시 적용하지 않음, 변수는 지워도 됩니다)");
    return "reset";
  }

  // ── 로그인·가입 ──────────────────────────────────────────────

  async login(input: { loginId: string; password: string; remember: boolean; deviceName?: string | null; ip: string }): Promise<{ token: string; user: AuthUser; session: SessionView }> {
    const ipHit = this.loginIp.hit(input.ip);
    if (!ipHit.ok) throw new AuthFailure(429, "too_many_attempts", MSG.tooMany, { retryAfterSec: ipHit.retryAfterSec });
    const fields: Record<string, string> = {};
    if (!normalizeLoginId(input.loginId)) fields["loginId"] = "required";
    if (!input.password) fields["password"] = "required";
    if (Object.keys(fields).length) throw new AuthFailure(400, "invalid", MSG.invalid, { fields });
    const key = loginIdKey(input.loginId);
    await this.ownerReady();
    const locked = this.lock.lockedFor(key, input.ip);
    if (locked > 0) throw new AuthFailure(429, "too_many_attempts", MSG.lockedFor(locked), { retryAfterSec: locked });
    const row = await this.userByKey(key);
    const tooLong = input.password.length > LOGIN_PASSWORD_MAX;
    // 없는 아이디도 해시를 한 번 계산해 응답 시간을 비슷하게
    const ok = row && !tooLong ? await verifyPassword(input.password, row.password_hash) : (await verifyPassword("x", await this.dummyHash()), false);
    if (!row || !ok) {
      const lockedNow = this.lock.fail(key, input.ip);
      this.deps.log?.warn({ ip: input.ip, ...(row ? { userId: row.id } : {}), locked: lockedNow > 0 }, "계정: 로그인 실패");
      if (lockedNow > 0) throw new AuthFailure(429, "too_many_attempts", MSG.lockedFor(lockedNow), { retryAfterSec: lockedNow });
      throw new AuthFailure(400, "bad_credentials", MSG.badCredentials);
    }
    this.lock.succeed(key, input.ip);
    const created = await this.createSession(Number(row.id), input.remember, input.deviceName ?? null);
    this.deps.log?.info({ userId: row.id, remember: input.remember }, "계정: 로그인");
    return { token: created.token, user: toUser(row), session: created.session };
  }

  async signup(input: SignupInput & { remember: boolean; deviceName?: string | null; ip: string }): Promise<{ token: string; user: AuthUser; session: SessionView }> {
    // 시도는 IP 별 한 시간 20번 (형식 오류·겹친 아이디·이메일 확인 포함 — 알아내기를 막는 몫)
    const tryHit = this.signupTryIp.hit(input.ip);
    if (!tryHit.ok) throw new AuthFailure(429, "too_many_attempts", MSG.tooMany, { retryAfterSec: tryHit.retryAfterSec });
    const fields = signupErrors(input);
    if (Object.keys(fields).length) throw new AuthFailure(400, "invalid", MSG.invalid, { fields });
    const loginId = normalizeLoginId(input.loginId);
    const key = loginIdKey(loginId);
    const email = normalizeEmail(input.email);
    await this.ownerReady();
    // 주인 아이디는 늘 예약 (검증 5차 — 켤 때 주인을 못 만든 사이 누가 그 아이디로 가입하면 주인이 영영 생기지 않았다)
    if (key === loginIdKey(this.ownerLoginId())) throw new AuthFailure(409, "login_id_taken", MSG.loginIdTaken, { fields: { loginId: "login_id_taken" } });
    await this.assertFree(key, email, null);
    // 만드는 계정은 IP 별 한 시간 5개, 전체 하루 30개 (형식이 맞고 겹치지 않는 가입만 센다)
    const ipHit = this.signupIp.hit(input.ip);
    if (!ipHit.ok) throw new AuthFailure(429, "too_many_attempts", MSG.tooMany, { retryAfterSec: ipHit.retryAfterSec });
    const all = this.signupAll.hit("all");
    if (!all.ok) throw new AuthFailure(429, "too_many_attempts", MSG.tooMany, { retryAfterSec: all.retryAfterSec });
    const ts = seoulIso(this.now());
    const hash = await hashPassword(input.password, this.n);
    let id: number;
    try {
      const r = await this.deps.db
        .insertInto("users")
        .values({ login_id: loginId, login_id_key: key, email, password_hash: hash, is_owner: 0, initial_password: 0, created_at: ts, updated_at: ts })
        .returning("id")
        .executeTakeFirstOrThrow();
      id = Number(r.id);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // 같은 순간의 가입(유일 색인) — 어느 칸이 겹쳤는지 다시 본다 (그새 사라졌으면 다시 해 달라고)
      await this.assertFree(key, email, null);
      throw new AuthFailure(409, "conflict", MSG.conflict);
    }
    const created = await this.createSession(id, input.remember, input.deviceName ?? null);
    this.deps.log?.info({ userId: id, ip: input.ip }, "계정: 회원가입");
    return { token: created.token, user: { id, loginId, email, isOwner: false, usingInitialPassword: false }, session: created.session };
  }

  private async assertFree(key: string, email: string, exceptUserId: number | null): Promise<void> {
    if (key) {
      const byId = await this.userByKey(key);
      if (byId && Number(byId.id) !== exceptUserId) throw new AuthFailure(409, "login_id_taken", MSG.loginIdTaken, { fields: { loginId: "login_id_taken" } });
    }
    const byEmail = await this.deps.db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
    if (byEmail && Number(byEmail.id) !== exceptUserId) throw new AuthFailure(409, "email_taken", MSG.emailTaken, { fields: { email: "email_taken" } });
  }

  private userByKey(key: string): Promise<UserRow | undefined> {
    return this.deps.db.selectFrom("users").select(["id", "login_id", "email", "is_owner", "initial_password", "password_hash"]).where("login_id_key", "=", key).executeTakeFirst();
  }

  private dummyHash(): Promise<string> {
    this.dummy ??= hashPassword("dummy-password-0", this.n);
    return this.dummy;
  }

  private async createSession(userId: number, remember: boolean, deviceName: string | null): Promise<{ token: string; session: SessionView }> {
    const token = newSessionToken();
    const t = this.nowMs();
    const expiresAt = seoulIso(new Date(t + (remember ? REMEMBER_MS : SHORT_MS)));
    const ts = seoulIso(new Date(t));
    const r = await this.deps.db
      .insertInto("sessions")
      .values({
        user_id: userId,
        token_hash: tokenHash(token),
        remember: remember ? 1 : 0,
        device_label: deviceName ? deviceName.slice(0, 100) : null,
        created_at: ts,
        last_seen_at: ts,
        expires_at: expiresAt,
        revoked_at: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { token, session: { id: Number(r.id), remember, expiresAt } };
  }

  // ── 요청마다 ─────────────────────────────────────────────────

  /**
   * 세션 토큰 → 사용자. 없는 토큰·끊김·기한 지남은 null (→ 401 session_invalid). DB 를 못 읽으면 오류를 던진다 (→ 503, 로그아웃 아님).
   * 쓸 때마다 기한을 늘리되 DB 에는 자동 로그인 켬은 하루 한 번, 끔은 15분에 한 번만 적는다
   */
  async authenticate(token: string): Promise<SessionContext | null> {
    if (!looksLikeToken(token)) return null;
    const h = tokenHash(token);
    const t = this.nowMs();
    const gen = this.gen;
    let s: CachedSession | null = null;
    const hit = this.cache.get(h);
    if (hit && t - hit.at < CACHE_MS) s = hit.s;
    else {
      const row = await this.deps.db
        .selectFrom("sessions as s")
        .innerJoin("users as u", "u.id", "s.user_id")
        .select(["s.id as sid", "s.user_id", "s.remember", "s.last_seen_at", "s.expires_at", "s.revoked_at", "u.id", "u.login_id", "u.email", "u.is_owner", "u.initial_password"])
        .where("s.token_hash", "=", h)
        .executeTakeFirst();
      if (!row || row.revoked_at) {
        this.cache.delete(h);
        return null;
      }
      s = {
        sessionId: Number(row.sid),
        userId: Number(row.user_id),
        remember: Number(row.remember) === 1,
        lastSeenAt: Date.parse(row.last_seen_at),
        expiresAt: Date.parse(row.expires_at),
        user: toUser(row),
      };
      // 읽는 동안 이 서버에서 세션을 끊었으면(로그아웃·비밀번호 변경) 읽은 행이 끊기 전 것일 수 있다 → 캐시에 넣지 않는다
      if (this.gen === gen) this.cache.set(h, { at: t, s });
    }
    if (!(s.expiresAt > t)) {
      this.cache.delete(h);
      return null;
    }
    const every = s.remember ? REMEMBER_TOUCH_MS : SHORT_TOUCH_MS;
    if (t - s.lastSeenAt >= every) {
      const expiresAt = t + (s.remember ? REMEMBER_MS : SHORT_MS);
      await this.deps.db
        .updateTable("sessions")
        .set({ last_seen_at: seoulIso(new Date(t)), expires_at: seoulIso(new Date(expiresAt)) })
        .where("id", "=", s.sessionId)
        .where("revoked_at", "is", null)
        .execute();
      s = { ...s, lastSeenAt: t, expiresAt };
      if (this.gen === gen) this.cache.set(h, { at: hit && t - hit.at < CACHE_MS ? hit.at : t, s });
    }
    return { user: s.user, session: { id: s.sessionId, remember: s.remember, expiresAt: seoulIso(new Date(s.expiresAt)) } };
  }

  /**
   * 비상 모드(플래그 끔·ACCOUNTS_DISABLED=1) 전용: 이 세션 토큰이 누구 것이었는지 — **기한이 지났거나 끊긴 세션도** (검증 4차).
   * 비상 모드에는 API 토큰만 = 주인이라, 주인 아닌 계정의 폰이 끝난 세션을 계속 보내도 그 계정으로 막으려면 기한과 상관없이 알아봐야 한다.
   * 모르는 토큰이면 null. DB 를 못 읽으면 오류를 던진다 (부르는 쪽이 지금처럼 — 비상 모드가 DB 오류로 막히지 않게)
   */
  async identify(token: string): Promise<{ userId: number; isOwner: boolean } | null> {
    if (!looksLikeToken(token)) return null;
    const row = await this.deps.db
      .selectFrom("sessions as s")
      .innerJoin("users as u", "u.id", "s.user_id")
      .select(["u.id", "u.is_owner"])
      .where("s.token_hash", "=", tokenHash(token))
      .executeTakeFirst();
    return row ? { userId: Number(row.id), isOwner: Number(row.is_owner) === 1 } : null;
  }

  /** 사용자 정보를 DB 에서 다시 (이메일·처음 비밀번호 표시가 다른 기기에서 바뀌었을 수 있다) */
  async me(ctx: SessionContext): Promise<SessionContext> {
    const r = await this.deps.db.selectFrom("users").select(["id", "login_id", "email", "is_owner", "initial_password"]).where("id", "=", ctx.user.id).executeTakeFirst();
    return { user: r ? toUser(r) : ctx.user, session: ctx.session };
  }

  /** 이 세션만 끊는다 (그 세션으로 등록한 푸시 기기도 지운다 — 앱이 알림 빼기에 실패했어도) */
  async logout(sessionId: number): Promise<void> {
    this.gen++;
    await this.deps.db.transaction().execute(async (trx) => {
      await trx.updateTable("sessions").set({ revoked_at: seoulIso(this.now()) }).where("id", "=", sessionId).where("revoked_at", "is", null).execute();
      await dropDevices(trx, { sessionIds: [sessionId] });
    });
    this.forget((s) => s.sessionId === sessionId);
  }

  /** 이 사람의 모든 세션 (이 기기 포함) + 그 세션들로 등록한 푸시 기기. 주인이면 계정 전(세션 없이) 등록한 기기도 */
  async logoutAll(userId: number): Promise<number> {
    this.gen++;
    const owner = await this.isOwner(userId);
    const n = await this.deps.db.transaction().execute(async (trx) => {
      const r = await trx.updateTable("sessions").set({ revoked_at: seoulIso(this.now()) }).where("user_id", "=", userId).where("revoked_at", "is", null).executeTakeFirst();
      await dropDevices(trx, { userId, unbound: owner });
      return Number(r.numUpdatedRows ?? 0);
    });
    this.forget((s) => s.userId === userId);
    this.deps.log?.info({ userId }, "계정: 모든 기기에서 로그아웃");
    return n;
  }

  private async isOwner(userId: number): Promise<boolean> {
    const r = await this.deps.db.selectFrom("users").select("is_owner").where("id", "=", userId).executeTakeFirst();
    return Number(r?.is_owner ?? 0) === 1;
  }

  /** 비밀번호 바꾸기: 지금 세션은 두고 다른 세션은 모두 끊는다. 처음 비밀번호 표시를 지운다 */
  async changePassword(ctx: SessionContext, input: { current: string; next: string; nextConfirm: string }): Promise<{ revokedOthers: number; user: AuthUser }> {
    const hit = this.passwordUser.hit(String(ctx.user.id));
    if (!hit.ok) throw new AuthFailure(429, "too_many_attempts", MSG.tooMany, { retryAfterSec: hit.retryAfterSec });
    const fields: Record<string, string> = {};
    if (!input.current) fields["current"] = "required";
    const nextErr = passwordError(input.next, ctx.user.loginId);
    if (nextErr) fields["next"] = nextErr;
    const cf = confirmError(input.next, input.nextConfirm);
    if (cf) fields["nextConfirm"] = cf;
    if (Object.keys(fields).length) throw new AuthFailure(400, "invalid", MSG.invalid, { fields });
    const row = await this.deps.db.selectFrom("users").select(["id", "login_id", "email", "is_owner", "initial_password", "password_hash"]).where("id", "=", ctx.user.id).executeTakeFirst();
    await this.recheckPassword(ctx, input.current, row?.password_hash ?? null);
    if (!row) throw new AuthFailure(400, "bad_current_password", MSG.badCurrent, { fields: { current: "bad_current_password" } });
    const ts = seoulIso(this.now());
    const hash = await hashPassword(input.next, this.n);
    this.gen++;
    const revoked = await this.deps.db.transaction().execute(async (trx) => {
      await trx.updateTable("users").set({ password_hash: hash, initial_password: 0, updated_at: ts }).where("id", "=", ctx.user.id).execute();
      const r = await trx.updateTable("sessions").set({ revoked_at: ts }).where("user_id", "=", ctx.user.id).where("id", "!=", ctx.session.id).where("revoked_at", "is", null).executeTakeFirst();
      // 다른 세션으로 등록한 기기 + (주인이면) 계정 전 등록 기기. 이 기기는 이 세션에 묶여 있으면 그대로 (앱이 바꾼 뒤 이 기기를 다시 등록한다)
      await dropDevices(trx, { userId: ctx.user.id, exceptSessionId: ctx.session.id, unbound: Number(row.is_owner) === 1 });
      return Number(r.numUpdatedRows ?? 0);
    });
    this.forget((s) => s.userId === ctx.user.id);
    this.deps.log?.info({ userId: ctx.user.id, revokedOthers: revoked }, "계정: 비밀번호 변경");
    return { revokedOthers: revoked, user: { ...toUser(row), usingInitialPassword: false } };
  }

  /**
   * 이메일 등록·변경: 지금 비밀번호를 다시 받는다 (세션만 훔쳐서는 복구용 이메일을 바꾸지 못하게), 사람마다 한 시간 5번
   * (이미 가입한 이메일인지 409 로 끝없이 알아내지 못하게 — 가입·로그인에서 막은 알아내기를 이 경로로 비켜 가지 않게)
   */
  async changeEmail(ctx: SessionContext, input: { email: string; current: string }): Promise<AuthUser> {
    const hit = this.emailUser.hit(String(ctx.user.id));
    if (!hit.ok) throw new AuthFailure(429, "too_many_attempts", MSG.tooMany, { retryAfterSec: hit.retryAfterSec });
    const fields: Record<string, string> = {};
    const err = emailError(input.email);
    if (err) fields["email"] = err;
    if (!input.current) fields["current"] = "required";
    if (Object.keys(fields).length) throw new AuthFailure(400, "invalid", MSG.invalid, { fields });
    const row = await this.deps.db.selectFrom("users").select("password_hash").where("id", "=", ctx.user.id).executeTakeFirst();
    await this.recheckPassword(ctx, input.current, row?.password_hash ?? null);
    const email = normalizeEmail(input.email);
    await this.assertFree("", email, ctx.user.id);
    try {
      await this.deps.db.updateTable("users").set({ email, updated_at: seoulIso(this.now()) }).where("id", "=", ctx.user.id).execute();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // 같은 순간에 다른 사람이 같은 이메일로 가입·변경 — 500 대신 409
      await this.assertFree("", email, ctx.user.id);
      throw new AuthFailure(409, "conflict", MSG.conflict);
    }
    this.forget((s) => s.userId === ctx.user.id);
    return (await this.me(ctx)).user;
  }

  /**
   * 로그인한 뒤 지금 비밀번호 다시 확인 (비밀번호·이메일 변경). 잠금은 세션마다 5번·10분 — 로그인 잠금(아이디별)과 따로 센다:
   * 아이디가 공개돼 있어 남이 로그인을 일부러 틀려 주인을 잠가도, 이미 로그인한 주인이 비밀번호를 바꾸는 것은 막히지 않게.
   * 훔친 세션으로 지금 비밀번호를 맞혀 보는 것은 세션마다 5번·10분 + 사람마다 변경 횟수 제한으로 묶인다
   */
  private async recheckPassword(ctx: SessionContext, current: string, hash: string | null): Promise<void> {
    const key = `s${ctx.session.id}`;
    const locked = this.reauthLock.lockedFor(key);
    if (locked > 0) throw new AuthFailure(429, "too_many_attempts", MSG.lockedFor(locked), { retryAfterSec: locked });
    if (!hash || current.length > LOGIN_PASSWORD_MAX || !(await verifyPassword(current, hash))) {
      const lockedNow = this.reauthLock.fail(key);
      if (lockedNow > 0) throw new AuthFailure(429, "too_many_attempts", MSG.lockedFor(lockedNow), { retryAfterSec: lockedNow });
      throw new AuthFailure(400, "bad_current_password", MSG.badCurrent, { fields: { current: "bad_current_password" } });
    }
    this.reauthLock.succeed(key);
  }

  /** 기한이 지났거나 끊긴 지 30일 넘은 세션을 지운다 (하루 한 번). 지운 세션으로 등록한 기기 행도 지운다 (알림은 이미 가지 않는다 — enabledTokens) */
  async purge(): Promise<number> {
    const cutoff = seoulIso(new Date(this.nowMs() - PURGE_AFTER_MS));
    const r = await this.deps.db
      .deleteFrom("sessions")
      .where((eb) => eb.or([eb("expires_at", "<", cutoff), eb.and([eb("revoked_at", "is not", null), eb("revoked_at", "<", cutoff)])]))
      .executeTakeFirst();
    await this.deps.db
      .deleteFrom("devices")
      .where("session_id", "is not", null)
      .where((eb) => eb.not(eb.exists(eb.selectFrom("sessions").select("sessions.id").whereRef("sessions.id", "=", "devices.session_id"))))
      .execute();
    return Number(r.numDeletedRows ?? 0);
  }

  private forget(match: (s: CachedSession) => boolean): void {
    this.gen++;
    for (const [k, v] of this.cache) if (match(v.s)) this.cache.delete(k);
  }
}

/**
 * 끊은 세션의 푸시 기기 등록을 지운다 (같은 트랜잭션 안에서).
 *  - sessionIds: 이 세션들로 등록한 기기
 *  - userId: 이 사람의 세션으로 등록한 기기 (exceptSessionId 는 빼고)
 *  - unbound: 세션 없이(계정 전·플래그 꺼짐) 등록한 기기도 — 주인만 (A단계에서 세션 없는 등록은 모두 주인 것)
 */
async function dropDevices(trx: Kysely<Database>, o: { sessionIds?: number[]; userId?: number; exceptSessionId?: number; unbound?: boolean }): Promise<void> {
  await trx
    .deleteFrom("devices")
    .where((eb) => {
      const any: Expression<SqlBool>[] = [];
      if (o.sessionIds?.length) any.push(eb("session_id", "in", o.sessionIds));
      if (o.userId !== undefined) {
        let sub = eb.selectFrom("sessions").select("sessions.id").where("sessions.user_id", "=", o.userId);
        if (o.exceptSessionId !== undefined) sub = sub.where("sessions.id", "!=", o.exceptSessionId);
        any.push(eb("session_id", "in", sub));
      }
      if (o.unbound) any.push(eb("session_id", "is", null));
      return any.length ? eb.or(any) : eb.lit(false);
    })
    .execute();
}
