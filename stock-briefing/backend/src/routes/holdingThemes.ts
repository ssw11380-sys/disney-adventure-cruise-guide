import type { FastifyPluginAsync } from "fastify";
import type { HoldingThemesService } from "../services/holdingThemesService.js";

/**
 * 내 보유 종목 × 테마 강도 (3-35, 플래그 holdingThemes). 새 경로라 예전 앱은 부르지 않는다.
 *  - GET /api/holdings/themes   보유 종목이 든 테마·업종의 오늘·1주 강도 (개인 — 보유 종목을 읽는다). 플래그가 꺼져 있으면 404 DISABLED
 * 테마 표·분류·거래대금 기록은 시장 데이터(공유)지만 경로로 내보내지 않는다
 */
export const holdingThemeRoutes: FastifyPluginAsync<{ service: HoldingThemesService }> = async (app, { service }) => {
  app.get("/themes", async (_req, reply) => {
    if (!(await service.enabled())) return reply.code(404).send({ error: "DISABLED", message: "내 종목 테마 기능이 꺼져 있습니다" });
    return service.current();
  });
};

/**
 * 관리: POST /api/admin/holding-themes/rebuild — 한국 테마 표 다시 만들기 (약 2분, 202 로 바로 답하고 뒤에서). 꺼져 있으면 404
 */
export const holdingThemeAdminRoutes: FastifyPluginAsync<{ service: HoldingThemesService }> = async (app, { service }) => {
  app.post("/rebuild", async (_req, reply) => {
    if (!(await service.enabled())) return reply.code(404).send({ error: "DISABLED", message: "내 종목 테마 기능이 꺼져 있습니다" });
    void service.rebuildKrIndex().catch((e: unknown) => app.log.warn({ err: String(e) }, "한국 테마 표 다시 만들기 실패"));
    return reply.code(202).send({ started: true });
  });
};
