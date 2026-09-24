import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { NotFoundError, ProviderError } from "../lib/errors.js";
import type { MarketCalendar } from "../providers/market/calendar.js";
import { MarketIndices } from "../providers/market/indices.js";

const candlesQuery = z.object({
  period: z.enum(["1m", "5m", "30m", "D", "W", "M"]).default("D"),
  count: z.coerce.number().int().min(5).max(1000).default(120),
});

/** 장 운영 상태 (앱의 실시간 배지·갱신 주기, 휴장 안내용) + 홈 상단 지수 띠와 그 차트 */
export const marketRoutes: FastifyPluginAsync<{ calendar: MarketCalendar; indices?: MarketIndices }> = async (app, { calendar, indices }) => {
  const idx = indices ?? new MarketIndices();
  app.get("/status", async () => calendar.status());
  /**
   * GET /api/market/indices — 코스피·코스닥·나스닥·S&P500·다우·필라반도체·원/달러·원/100엔·원/위안 (30초 캐시).
   * 항목마다 fetchedAt(서버가 출처에서 받은 시각). 출처가 실패한 항목은 마지막 값에 stale: true·open: false (5초 안에 응답)
   */
  app.get("/indices", async () => ({ indices: await idx.list() }));
  /** GET /api/market/indices/:code/candles?period=1m|5m|30m|D|W|M&count= — 지수·환율 차트 (종목 차트와 같은 형식) */
  app.get("/indices/:code/candles", async (req) => {
    const code = String((req.params as { code?: string }).code ?? "");
    const { period, count } = candlesQuery.parse(req.query);
    let series;
    try {
      series = await idx.candles(code, period, count);
    } catch (e) {
      throw new ProviderError("naver", `지수 차트를 불러오지 못했습니다 (${code})`, e);
    }
    if (!series) throw new NotFoundError(`알 수 없는 지수입니다: ${code}`);
    return series;
  });
};
