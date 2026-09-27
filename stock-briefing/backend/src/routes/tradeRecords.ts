import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { seoulDate } from "../lib/time.js";
import { addDays } from "../services/tradeRecordCalc.js";
import { FeatureOffError, type TradeRecordService } from "../services/tradeRecordService.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 합니다");
const market = z.enum(["KR", "US"]);
const rangeQuery = z.object({ from: day.optional(), to: day.optional() });
const MAX_RANGE_DAYS = 400;

/** 기간: 없으면 오늘(한국)까지 최근 30일. 400일 넘게는 받지 않는다 */
function range(q: { from?: string | undefined; to?: string | undefined }, now: Date): { from: string; to: string } {
  const to = q.to ?? seoulDate(now);
  const from = q.from ?? addDays(to, -30);
  if (from > to) throw new AppError(400, "VALIDATION", "from 이 to 보다 늦습니다");
  if (addDays(from, MAX_RANGE_DAYS) < to) throw new AppError(400, "VALIDATION", `기간은 ${MAX_RANGE_DAYS}일까지입니다`);
  return { from, to };
}

/**
 * 매매 기록 읽기 (3-36, 플래그 tradeRecords). 새 경로라 예전 앱은 부르지 않는다. 플래그를 끄면 빈 값(조회 0건).
 *  - GET /api/snapshots?from=YYYY-MM-DD&to=YYYY-MM-DD&market=KR|US   일별 계좌 스냅샷 (빈칸 gap 줄 포함), 날짜·시장 순
 *  - GET /api/trades?from&to&code                                    저장한 체결(토스 주문 내역) + 주문 내역으로 설명되지 않는 수량 변화(estimated, 추정)
 *  - GET /api/trade-records                                          기록 상태 (시작일·저장한 날 수·최근 5·30거래일 빠진 날·체결 건수)
 */
export const tradeRecordRoutes: FastifyPluginAsync<{ service: TradeRecordService; now: () => Date }> = async (app, { service, now }) => {
  app.get("/snapshots", async (req) => {
    const q = rangeQuery.extend({ market: market.optional() }).parse(req.query);
    if (!(await service.enabled())) return { enabled: false, items: [] };
    const r = range(q, now());
    return { enabled: true, ...r, items: await service.listSnapshots({ ...r, ...(q.market ? { market: q.market } : {}) }) };
  });

  app.get("/trades", async (req) => {
    const q = rangeQuery.extend({ code: z.string().trim().toUpperCase().max(12).optional() }).parse(req.query);
    if (!(await service.enabled())) return { enabled: false, items: [], estimated: [] };
    const r = range(q, now());
    return { enabled: true, ...r, source: "toss-orders", ...(await service.listTrades({ ...r, ...(q.code ? { code: q.code } : {}) })) };
  });

  app.get("/trade-records", async () => {
    if (!(await service.enabled())) return { enabled: false };
    return { enabled: true, ...(await service.status()) };
  });
};

/**
 * 관리용 (API_TOKEN 보호): 상태, 지금 스냅샷 찍기(마감 뒤에만, force 면 덮어쓰기), 지금 체결 받기.
 * 플래그가 꺼져 있으면 409, 토스 키가 없으면 503
 */
export const tradeRecordAdminRoutes: FastifyPluginAsync<{ service: TradeRecordService }> = async (app, { service }) => {
  app.get("/", async () => ({ enabled: await service.enabled(), ...(await service.status()) }));

  app.post("/snapshot", async (req) => {
    const body = z.object({ market, force: z.boolean().optional() }).parse(req.body ?? {});
    return service.snapshotNow(body.market, { force: body.force ?? false });
  });

  app.post("/sync-trades", async (req) => {
    const body = z.object({ market }).parse(req.body ?? {});
    if (!(await service.enabled())) throw new FeatureOffError();
    return service.syncTrades(body.market);
  });
};
