import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { appErrorBatch, appErrorInput, type AppErrorService } from "../services/appErrorService.js";

/** POST /api/app-errors — 앱 JS 오류 보고 (한 건 또는 {errors: [...]}) */
export const appErrorRoutes: FastifyPluginAsync<{ service: AppErrorService }> = async (app, { service }) => {
  app.post("/", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const body = req.body as { errors?: unknown } | undefined;
    const list = body && Array.isArray(body.errors) ? appErrorBatch.parse(body).errors : [appErrorInput.parse(body)];
    const r = await service.record(list);
    return reply.code(r.saved > 0 ? 201 : 429).send(r);
  });
};

const summaryQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

/** GET /api/admin/app-errors?days=7 — 최근 N일 앱 오류 수·종류·자주 난 오류 */
export const appErrorAdminRoutes: FastifyPluginAsync<{ service: AppErrorService }> = async (app, { service }) => {
  app.get("/", async (req) => service.summary(summaryQuery.parse(req.query).days));
};
