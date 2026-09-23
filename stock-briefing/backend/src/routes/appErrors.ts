import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { appErrorInput, type AppErrorInput, type AppErrorService } from "../services/appErrorService.js";

/**
 * POST /api/app-errors — 앱 JS 오류 보고 (한 건 또는 {errors: [...]}, 최대 20건).
 * 항목마다 따로 검사해 맞는 것만 저장한다(한 건이 틀렸다고 묶음 전체를 거절하면 앱이 같은 묶음을 계속 다시 보낸다).
 */
export const appErrorRoutes: FastifyPluginAsync<{ service: AppErrorService }> = async (app, { service }) => {
  app.post("/", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const body = req.body as { errors?: unknown } | undefined;
    const raw: unknown[] = body && Array.isArray(body.errors) ? body.errors : [body];
    if (raw.length === 0 || raw.length > 20) throw new AppError(400, "VALIDATION", "errors: 1~20건");
    const valid: AppErrorInput[] = [];
    for (const item of raw) {
      const p = appErrorInput.safeParse(item);
      if (p.success) valid.push(p.data);
    }
    const invalid = raw.length - valid.length;
    if (valid.length === 0) throw new AppError(400, "VALIDATION", `형식이 맞는 보고가 없습니다 (${invalid}건)`);
    const r = await service.record(valid);
    if (r.saved === 0) return reply.code(429).header("retry-after", "60").send({ ...r, invalid });
    return reply.code(201).send({ ...r, invalid });
  });
};

const summaryQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

/** GET /api/admin/app-errors?days=7 — 최근 N일(오늘 포함, 한국 날짜) 앱 오류 수·종류·자주 난 오류 */
export const appErrorAdminRoutes: FastifyPluginAsync<{ service: AppErrorService }> = async (app, { service }) => {
  app.get("/", async (req) => service.summary(summaryQuery.parse(req.query).days));
};
