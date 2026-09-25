import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { seoulDate, seoulIso } from "../lib/time.js";
import type { AccountSession } from "../services/accountNumbers.js";
import type { AccountBriefingService } from "../services/accountBriefingService.js";

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(30).default(10) });
const idParam = z.object({ id: z.coerce.number().int().positive() });
const runBody = z.object({ session: z.enum(["morning", "afternoon"]), force: z.boolean().default(false) });

/**
 * 계좌 한 장 브리핑 (3-31). 새 경로라 예전 앱은 부르지 않고, 새 앱은 예전 서버의 404 를 "없음"으로 본다.
 *  - GET  /api/account-briefings?limit=N   최신 순 (카드용 머리 숫자 headline 포함)
 *  - GET  /api/account-briefings/:id       상세 (계산한 숫자 data 포함)
 *  - POST /api/account-briefings/run       { session, force } 오늘 계좌 브리핑만 다시 (종목 브리핑·알림 없음).
 *    그 세션의 브리핑 시각(설정의 HH:MM, 한국 시간) 전이면 409 — 아직 오지 않은 세션을 지금 값으로 만들어 두면 예약 실행이
 *    '이미 있음'으로 건너뛰어 그 값으로 굳고, 세션 알림 앞머리가 빠진다
 */
export const accountBriefingRoutes: FastifyPluginAsync<{
  service: AccountBriefingService;
  busy: () => boolean;
  now: () => Date;
  /** 세션의 브리핑 시각 "HH:MM" (알림 설정). 모르면 null — 시각 검사를 건너뛴다 */
  sessionTime?: (session: AccountSession) => Promise<string | null>;
}> = async (app, { service, busy, now, sessionTime }) => {
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
    const at = sessionTime ? await sessionTime(body.session).catch(() => null) : null;
    if (at && seoulIso(now()).slice(11, 16) < at) {
      const label = body.session === "morning" ? "오전" : "오후";
      return reply.code(409).send({ error: "TOO_EARLY", message: `${label} 브리핑 시각(${at}) 전이라 아직 만들 수 없습니다` });
    }
    const briefing = await service.generate(body.session, { date: seoulDate(now()), force: body.force });
    return { briefing, skipped: briefing ? null : "이미 만든 계좌 브리핑이 있거나(force 로 다시 만들기) 보유 종목이 없습니다" };
  });
};
