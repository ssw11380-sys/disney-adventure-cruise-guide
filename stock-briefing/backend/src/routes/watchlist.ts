import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CODE_RE, isKrCode, normalizeCode } from "../lib/codes.js";
import type { FeatureService } from "../services/featureService.js";
import type { WatchlistService } from "../services/watchlistService.js";

const codeParam = z.object({ code: z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE)) });
const input = z.object({ startPrice: z.number().finite().positive().max(100_000_000), desiredPrice: z.number().finite().positive().max(100_000_000), alerts: z.boolean() });
export const watchlistRoutes: FastifyPluginAsync<{ service: WatchlistService; features: FeatureService }> = async (app, { service, features }) => {
  app.addHook("preHandler", async (_req, reply) => {
    if (!(await features.enabled("watchlistSteps"))) return reply.code(404).send({ error: "OFF", message: "관심종목 기능이 꺼져 있습니다" });
  });
  app.get("/", async () => ({ items: await service.list() }));
  app.get("/settings", async () => service.settings());
  app.get("/events", async () => service.events());
  app.put("/settings", async req => service.setSettings(z.object({ holdings: z.boolean() }).parse(req.body).holdings));
  app.put("/:code", async (req, reply) => {
    const { code } = codeParam.parse(req.params), body = input.parse(req.body);
    const prices = [body.startPrice, body.desiredPrice];
    if (prices.some(v => isKrCode(code) ? !Number.isInteger(v) : Math.round(v * 100) / 100 !== v || v > 1_000_000)) return reply.code(400).send({ error: "PRICE", message: "국내 가격은 원 단위, 미국 가격은 소수 둘째 자리까지 입력하세요" });
    return service.save(code, body);
  });
  app.delete("/:code", async (req, reply) => { await service.remove(codeParam.parse(req.params).code); return reply.code(204).send(); });
};
