import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { NotFoundError } from "../lib/errors.js";
import type { MarketSummaryService } from "../services/marketSummaryService.js";

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(4) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * 시장 전체 요약 (플래그 marketSummary). 새 경로라 예전 앱은 부르지 않고, 새 앱은 예전 서버의 404 를 "없음"으로 본다 (카드 없음).
 * 플래그를 끄면 조회도 0건 — 목록은 빈 목록, 한 건은 404.
 *  - GET /api/market-summaries?limit=N   최신 순 (날짜 내림차순, 같은 날은 오후 먼저). 카드가 쓰는 숫자(data)까지
 *  - GET /api/market-summaries/latest     가장 최근 한 건 (없으면 404)
 *  - GET /api/market-summaries/:id        한 건
 */
export const marketSummaryRoutes: FastifyPluginAsync<{ service: MarketSummaryService }> = async (app, { service }) => {
  app.get("/", async (req) => {
    const { limit } = listQuery.parse(req.query);
    return service.list(limit);
  });

  app.get("/latest", async () => {
    const [first] = await service.list(1);
    if (!first) throw new NotFoundError("시장 요약이 아직 없습니다");
    return first;
  });

  app.get("/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    return service.get(id);
  });
};
