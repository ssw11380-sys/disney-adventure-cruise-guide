import type { FastifyPluginAsync } from "fastify";
import type { StockService } from "../services/stockService.js";

/** 운영용 엔드포인트. 인증은 단일 사용자 v1 범위 밖이라 없음 (배포 시 네트워크로 보호). */
export const adminRoutes: FastifyPluginAsync<{ service: StockService }> = async (app, { service }) => {
  app.get("/master", async () => service.masterStatus());
  app.post("/master/refresh", async () => service.refreshMaster());
};
