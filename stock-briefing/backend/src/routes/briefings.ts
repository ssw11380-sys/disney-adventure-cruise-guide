import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { BriefingScheduler } from "../scheduler.js";
import type { BriefingService } from "../services/briefingService.js";

const sessionEnum = z.enum(["morning", "afternoon"]);
const listQuery = z.object({
  code: z.string().regex(/^\d{6}$/).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  session: sessionEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const runBody = z.object({
  session: sessionEnum,
  codes: z.array(z.string().regex(/^\d{6}$/)).optional(),
  force: z.boolean().default(false),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

export const briefingRoutes: FastifyPluginAsync<{ service: BriefingService; scheduler: BriefingScheduler | null }> = async (
  app,
  { service, scheduler },
) => {
  /** 종목별 최신 브리핑 (홈 화면) */
  app.get("/latest", async () => service.latestPerStock());

  /** 목록: ?code=&date=&session=&limit= */
  app.get("/", async (req) => {
    const q = listQuery.parse(req.query);
    const filter: Parameters<BriefingService["list"]>[0] = { limit: q.limit };
    if (q.code) filter.code = q.code;
    if (q.date) filter.date = q.date;
    if (q.session) filter.session = q.session;
    return service.list(filter);
  });

  /** 상세 (수집 데이터 포함) */
  app.get("/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    return service.get(id);
  });

  /** 수동 실행. 등록 종목 전체 또는 codes 지정. 이미 오늘 생성된 건 force=true 가 아니면 건너뜀. */
  app.post("/run", async (req, reply) => {
    const body = runBody.parse(req.body ?? {});
    if (service.isRunning) return reply.code(409).send({ error: "BUSY", message: "브리핑이 이미 실행 중입니다" });
    const opts: Parameters<BriefingService["runSession"]>[1] = { force: body.force };
    if (body.codes) opts.codes = body.codes;
    return service.runSession(body.session, opts);
  });

  app.get("/schedule", async () => scheduler?.status() ?? { timezone: "Asia/Seoul", jobs: [], running: service.isRunning, disabled: true });
};
