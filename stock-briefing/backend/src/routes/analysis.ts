import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AnalysisService } from "../services/analysisService.js";

const params = z.object({
  code: z.string().regex(/^\d{6}$/, "종목 코드는 6자리 숫자"),
  kind: z.enum(["company", "value", "technical"]),
});
const query = z.object({ refresh: z.coerce.boolean().default(false) });

/** GET /api/stocks/:code/analysis/:kind?refresh=1 — 종목 상세 탭 (회사 소개 / 가치투자 / 기술적 분석) */
export const analysisRoutes: FastifyPluginAsync<{ service: AnalysisService }> = async (app, { service }) => {
  app.get("/:code/analysis/:kind", async (req) => {
    const { code, kind } = params.parse(req.params);
    const { refresh } = query.parse(req.query);
    return service.get(code, kind, { refresh });
  });
};
