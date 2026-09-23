import type { FastifyPluginAsync } from "fastify";
import type { MarketCalendar } from "../providers/market/calendar.js";
import { MarketIndices } from "../providers/market/indices.js";

/** 장 운영 상태 (앱의 실시간 배지·갱신 주기, 휴장 안내용) + 홈 상단 지수 띠 */
export const marketRoutes: FastifyPluginAsync<{ calendar: MarketCalendar; indices?: MarketIndices }> = async (app, { calendar, indices }) => {
  const idx = indices ?? new MarketIndices();
  app.get("/status", async () => calendar.status());
  /** GET /api/market/indices — 코스피·코스닥·나스닥·S&P500·다우·필라반도체·원/달러 (30초 캐시) */
  app.get("/indices", async () => ({ indices: await idx.list() }));
};
