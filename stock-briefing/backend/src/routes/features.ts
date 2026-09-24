import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { UnknownFeatureError, type FeatureService } from "../services/featureService.js";

/** GET /api/features — 앱이 60초마다 받아 useFeature 로 쓴다 */
export const featureRoutes: FastifyPluginAsync<{ features: FeatureService }> = async (app, { features }) => {
  app.get("/", async () => features.all());
};

const patchBody = z.record(z.string(), z.boolean().nullable());

/** 관리: GET 목록(기본값·설명), PUT {플래그: true|false|null} — null 은 기본값으로 */
export const featureAdminRoutes: FastifyPluginAsync<{ features: FeatureService }> = async (app, { features }) => {
  app.get("/", async () => ({ features: await features.detail() }));
  app.put("/", async (req, reply) => {
    const body = patchBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "BAD_REQUEST", message: "{플래그: true|false|null} 형식이어야 합니다" });
    try {
      return await features.set(body.data);
    } catch (e) {
      if (e instanceof UnknownFeatureError) return reply.code(400).send({ error: "UNKNOWN_FEATURE", message: e.message });
      throw e;
    }
  });
};
