import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import { NotFoundError } from "../lib/errors.js";
import type { BriefingScheduler } from "../scheduler.js";
import type { BriefingService } from "../services/briefingService.js";
import type { BriefingStatusService } from "../services/briefingStatus.js";

const sessionEnum = z.enum(["morning", "afternoon"]);
const listQuery = z.object({
  code: z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE)).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  session: sessionEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const runBody = z.object({
  session: sessionEnum,
  codes: z.array(z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE))).optional(),
  force: z.boolean().default(false),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });

export const briefingRoutes: FastifyPluginAsync<{ service: BriefingService; scheduler: BriefingScheduler | null; status?: BriefingStatusService | null }> = async (
  app,
  { service, scheduler, status },
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

  /**
   * 늦음·실패 안내 (브리핑 3차 2, 플래그 briefingStatus): 오늘 예약 시각이 지난 가장 최근 회차의 상태. 오류 원문은 넣지 않는다.
   * 플래그가 꺼져 있으면 404 (앱은 예전 안내 그대로)
   */
  app.get("/status", async () => {
    if (!status || !(await status.enabled())) throw new NotFoundError("브리핑 상태 안내가 꺼져 있습니다");
    return status.status();
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
