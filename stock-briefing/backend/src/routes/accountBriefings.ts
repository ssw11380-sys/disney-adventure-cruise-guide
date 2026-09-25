import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { seoulDate } from "../lib/time.js";
import type { AccountBriefingService } from "../services/accountBriefingService.js";

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(30).default(10) });
const idParam = z.object({ id: z.coerce.number().int().positive() });
const runBody = z.object({ session: z.enum(["morning", "afternoon"]), force: z.boolean().default(false) });

/**
 * 계좌 한 장 브리핑 (3-31). 새 경로라 예전 앱은 부르지 않고, 새 앱은 예전 서버의 404 를 "없음"으로 본다.
 *  - GET  /api/account-briefings?limit=N   최신 순 (카드용 머리 숫자 headline 포함)
 *  - GET  /api/account-briefings/:id       상세 (계산한 숫자 data 포함)
 *  - POST /api/account-briefings/run       { session, force } 오늘 계좌 브리핑만 다시 (종목 브리핑·알림 없음)
 */
export const accountBriefingRoutes: FastifyPluginAsync<{ service: AccountBriefingService; busy: () => boolean; now: () => Date }> = async (app, { service, busy, now }) => {
  app.get("/", async (req) => {
    const { limit } = listQuery.parse(req.query);
    return service.list(limit);
  });

  app.get("/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    return service.get(id);
  });

  app.post("/run", async (req, reply) => {
    const body = runBody.parse(req.body ?? {});
    if (!(await service.enabled())) return reply.code(409).send({ error: "DISABLED", message: "계좌 브리핑 기능이 꺼져 있습니다" });
    if (busy()) return reply.code(409).send({ error: "BUSY", message: "브리핑이 이미 실행 중입니다" });
    const briefing = await service.generate(body.session, { date: seoulDate(now()), force: body.force });
    return { briefing, skipped: briefing ? null : "이미 만든 계좌 브리핑이 있거나(force 로 다시 만들기) 보유 종목이 없습니다" };
  });
};
