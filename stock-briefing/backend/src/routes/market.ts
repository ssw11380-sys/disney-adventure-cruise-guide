import type { FastifyPluginAsync } from "fastify";
import type { MarketCalendar } from "../providers/market/calendar.js";

/** 장 운영 상태 (앱의 실시간 배지·갱신 주기, 휴장 안내용) */
export const marketRoutes: FastifyPluginAsync<{ calendar: MarketCalendar }> = async (app, { calendar }) => {
  app.get("/status", async () => calendar.status());
};
