import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { AuthFailure, type AuthService } from "../auth/authService.js";
import { SESSION_REQUIRED, sessionOf } from "../auth/routePolicy.js";

/**
 * 로그인·회원가입 (계정 A단계, 플래그 accounts — 꺼져 있으면 app.ts 의 관문이 모두 404).
 *  - POST /api/auth/login   { loginId, password, remember=true, deviceName? } → 200 { token, user, session }
 *  - POST /api/auth/signup  { loginId, password, passwordConfirm, email, remember=true, deviceName? } → 201 { token, user, session }
 *  - GET  /api/auth/me      → { user, session }
 *  - POST /api/auth/logout  → 204 (지금 세션만. 세션이 없어도 204)
 *  - POST /api/auth/logout-all → 204 (이 사람의 모든 세션, 이 기기 포함)
 *  - POST /api/auth/password { current, next, nextConfirm } → { ok, revokedOthers, user } (지금 세션은 두고 다른 세션은 끊는다)
 *  - PUT  /api/auth/email   { email } → { user }
 * 오류는 { error, code, message } (+ fields: 칸별 코드, retryAfterSec). 로그인 실패를 401 이 아닌 400 으로 주는 까닭:
 * 앱은 401 을 'API 토큰 틀림'(UNAUTHORIZED) 또는 '세션 끊김'(session_invalid)으로만 쓴다
 */
const LIMITS = { bodyLimit: 4096 };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
const deviceName = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : null);

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  if (!(e instanceof AuthFailure)) throw e;
  const retry = e.extra["retryAfterSec"];
  if (typeof retry === "number") reply.header("retry-after", String(retry));
  return reply.code(e.status).send(e.body());
}

export const authRoutes: FastifyPluginAsync<{ auth: AuthService }> = async (app, { auth }) => {
  app.post("/login", LIMITS, async (req, reply) => {
    const b = body(req);
    try {
      return await auth.login({ loginId: str(b["loginId"]), password: str(b["password"]), remember: b["remember"] !== false, deviceName: deviceName(b["deviceName"]), ip: req.ip });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/signup", LIMITS, async (req, reply) => {
    const b = body(req);
    try {
      const r = await auth.signup({
        loginId: str(b["loginId"]),
        password: str(b["password"]),
        passwordConfirm: str(b["passwordConfirm"]),
        email: str(b["email"]),
        remember: b["remember"] !== false,
        deviceName: deviceName(b["deviceName"]),
        ip: req.ip,
      });
      return reply.code(201).send(r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/me", async (req, reply) => {
    const ctx = sessionOf(req);
    if (!ctx) return reply.code(403).send(SESSION_REQUIRED);
    return auth.me(ctx);
  });

  app.post("/logout", LIMITS, async (req, reply) => {
    const ctx = sessionOf(req);
    if (ctx) await auth.logout(ctx.session.id);
    return reply.code(204).send();
  });

  app.post("/logout-all", LIMITS, async (req, reply) => {
    const ctx = sessionOf(req);
    if (!ctx) return reply.code(403).send(SESSION_REQUIRED);
    await auth.logoutAll(ctx.user.id);
    return reply.code(204).send();
  });

  app.post("/password", LIMITS, async (req, reply) => {
    const ctx = sessionOf(req);
    if (!ctx) return reply.code(403).send(SESSION_REQUIRED);
    const b = body(req);
    try {
      // 이름 두 가지를 받는다 (current/next/nextConfirm · currentPassword/newPassword/newPasswordConfirm)
      const r = await auth.changePassword(ctx, {
        current: str(b["current"] ?? b["currentPassword"]),
        next: str(b["next"] ?? b["newPassword"]),
        nextConfirm: str(b["nextConfirm"] ?? b["newPasswordConfirm"]),
      });
      return { ok: true, revokedOthers: r.revokedOthers, user: r.user };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put("/email", LIMITS, async (req, reply) => {
    const ctx = sessionOf(req);
    if (!ctx) return reply.code(403).send(SESSION_REQUIRED);
    try {
      return { user: await auth.changeEmail(ctx, str(body(req)["email"])) };
    } catch (e) {
      return fail(reply, e);
    }
  });
};
