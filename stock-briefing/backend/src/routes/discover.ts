import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { NotFoundError, ProviderError } from "../lib/errors.js";
import type { DiscoverService } from "../services/discoverService.js";

const marketParam = z.object({ market: z.enum(["KR", "US"]) });
const rankParams = marketParam.extend({ category: z.enum(["tradingValue", "volume", "gainers", "losers"]) });
const rankQuery = z.object({ page: z.coerce.number().int().min(1).max(20).default(1), size: z.coerce.number().int().min(10).max(100).default(50) });
const themesQuery = z.object({ kind: z.enum(["theme", "sector"]).default("theme"), period: z.enum(["day", "week", "month"]).default("day") });
const themeParams = marketParam.extend({ id: z.string().min(1).max(40).regex(/^[0-9A-Za-z_-]+$/) });
const themeQuery = z.object({ kind: z.enum(["theme", "sector"]).default("theme") });

/** 발견 탭: 순위·테마·업종 (네이버 증권). 조회 실패는 502, 모르는 테마는 404 */
export const discoverRoutes: FastifyPluginAsync<{ service: DiscoverService }> = async (app, { service }) => {
  const upstream = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      throw new ProviderError("discover", `${what}을(를) 불러오지 못했습니다`, e);
    }
  };

  /** GET /api/discover/:market/rank/:category?page=&size= */
  app.get("/:market/rank/:category", async (req) => {
    const { market, category } = rankParams.parse(req.params);
    const { page, size } = rankQuery.parse(req.query);
    return upstream("순위", () => service.rank(market, category, page, size));
  });

  /** GET /api/discover/:market/themes?kind=theme|sector&period=day|week|month */
  app.get("/:market/themes", async (req) => {
    const { market } = marketParam.parse(req.params);
    const { kind, period } = themesQuery.parse(req.query);
    return upstream("테마", () => service.themes(market, kind, period));
  });

  /** GET /api/discover/:market/themes/:id?kind= — 구성 종목 */
  app.get("/:market/themes/:id", async (req) => {
    const { market, id } = themeParams.parse(req.params);
    const { kind } = themeQuery.parse(req.query);
    const detail = await upstream("테마 구성 종목", () => service.theme(market, kind, id));
    if (!detail) throw new NotFoundError(`테마를 찾을 수 없습니다: ${id}`);
    return detail;
  });
};
