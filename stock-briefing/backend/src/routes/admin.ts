import type { FastifyPluginAsync } from "fastify";
import type { DartProvider } from "../providers/dart/dart.js";
import type { StockService } from "../services/stockService.js";

/** 운영용 엔드포인트. 인증은 단일 사용자 v1 범위 밖이라 없음 (배포 시 네트워크로 보호). */
export const adminRoutes: FastifyPluginAsync<{ service: StockService; dart: DartProvider | null }> = async (app, { service, dart }) => {
  app.get("/master", async () => service.masterStatus());
  app.post("/master/refresh", async () => service.refreshMaster());

  /** DART 고유번호 매핑 갱신 (DART 키 필요) */
  app.post("/dart/refresh", async (_req, reply) => {
    if (!dart) return reply.code(503).send({ error: "DART_DISABLED", message: "DART_API_KEY 가 설정되지 않았습니다" });
    const count = await dart.refreshCorpCodes();
    return { count };
  });
};
