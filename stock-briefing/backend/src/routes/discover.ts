import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError, NotFoundError } from "../lib/errors.js";
import type { DiscoverService } from "../services/discoverService.js";

const marketParam = z.object({ market: z.enum(["KR", "US"]) });
const rankParams = marketParam.extend({ category: z.enum(["tradingValue", "volume", "gainers", "losers"]) });
const rankQuery = z.object({
  page: z.coerce.number().int().min(1).max(20).default(1),
  size: z.coerce.number().int().min(10).max(100).default(50),
  /** 첫 쪽이 준 목록 판 (뒤 쪽을 같은 목록에서 이어 받기) */
  v: z.coerce.number().int().positive().optional(),
  /** r=1: 앱이 restart(판을 잃었으니 첫 쪽부터 다시)를 안다. 없으면(옛 앱 번들) 잃은 판의 뒤 쪽도 지금 목록에서 준다 */
  r: z.string().optional(),
});
const themesQuery = z.object({ kind: z.enum(["theme", "sector"]).default("theme"), period: z.enum(["day", "week", "month"]).default("day") });
const themeParams = marketParam.extend({ id: z.string().min(1).max(40).regex(/^[0-9A-Za-z_-]+$/) });
const themeQuery = z.object({ kind: z.enum(["theme", "sector"]).default("theme") });

/** 발견 탭: 순위·테마·업종 (네이버 증권). 조회 실패는 502, 모르는 테마는 404 */
export const discoverRoutes: FastifyPluginAsync<{ service: DiscoverService }> = async (app, { service }) => {
  /**
   * 출처(네이버·토스) 실패는 502 로, 원인은 로그에 남긴다. 코드 오류(TypeError 등)는 감싸지 않고 500 으로 기록되게 둔다.
   * what 은 조사까지 붙인 말 ("순위를")
   */
  const upstream = async <T>(what: string, log: { warn: (o: unknown, m?: string) => void }, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NotFoundError || e instanceof AppError) throw e;
      if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) throw e;
      log.warn({ err: e instanceof Error ? e.message : String(e) }, `발견 탭 출처 실패: ${what}`);
      throw new AppError(502, "UPSTREAM", `${what} 불러오지 못했습니다 (출처가 응답하지 않습니다. 잠시 뒤 다시 시도하세요)`);
    }
  };

  /** GET /api/discover/:market/rank/:category?page=&size=&v=&r=1 */
  app.get("/:market/rank/:category", async (req) => {
    const { market, category } = rankParams.parse(req.params);
    const { page, size, v, r } = rankQuery.parse(req.query);
    return upstream("순위를", req.log, () => service.rank(market, category, page, size, v, { restart: r === "1" }));
  });

  /** GET /api/discover/:market/themes?kind=theme|sector&period=day|week|month */
  app.get("/:market/themes", async (req) => {
    const { market } = marketParam.parse(req.params);
    const { kind, period } = themesQuery.parse(req.query);
    return upstream("테마를", req.log, () => service.themes(market, kind, period));
  });

  /** GET /api/discover/:market/themes/:id?kind= — 구성 종목 */
  app.get("/:market/themes/:id", async (req) => {
    const { market, id } = themeParams.parse(req.params);
    const { kind } = themeQuery.parse(req.query);
    const detail = await upstream("테마 구성 종목을", req.log, () => service.theme(market, kind, id));
    if (!detail) throw new NotFoundError(`테마를 찾을 수 없습니다: ${id}`);
    return detail;
  });
};
