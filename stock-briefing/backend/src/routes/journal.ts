import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import { AppError } from "../lib/errors.js";
import { seoulDate } from "../lib/time.js";
import { JournalOffError, NOTE_MAX, type JournalService } from "../services/journalService.js";
import { addDays } from "../services/tradeRecordCalc.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 합니다");
const MAX_RANGE_DAYS = 400;

/** 기간: 없으면 오늘(한국)까지 최근 30일. 400일 넘게는 받지 않는다 (3-36 매매 기록과 같은 규칙) */
function range(q: { from?: string | undefined; to?: string | undefined }, now: Date): { from: string; to: string } {
  const to = q.to ?? seoulDate(now);
  const from = q.from ?? addDays(to, -30);
  if (from > to) throw new AppError(400, "VALIDATION", "from 이 to 보다 늦습니다");
  if (addDays(from, MAX_RANGE_DAYS) < to) throw new AppError(400, "VALIDATION", `기간은 ${MAX_RANGE_DAYS}일까지입니다`);
  return { from, to };
}

const code = z
  .string()
  .trim()
  .transform((s) => normalizeCode(s))
  .refine((s) => CODE_RE.test(s), "종목 코드 형식이 아닙니다");

/**
 * 매매일지 (3-37, 플래그 tradeJournal — tradeRecords 가 꺼져 있으면 꺼진 것으로 봄). 새 경로만 — 예전 앱은 부르지 않는다.
 * 플래그가 꺼져 있으면 읽기는 { enabled: false } 모양의 빈 값(200), 쓰기는 409 FEATURE_OFF.
 *  - GET /api/journal?from&to&code              날짜별 체결·실현손익(이동평균법)·메모, 기간 요약, 종목 목록(code 면 머리 카드)
 *  - GET /api/journal/stock/:code               종목 상세 '매매 기록' 칸 (지금 보유·기록된 실현손익·체결 수·종목 메모)
 *  - PUT /api/journal/notes { account, orderId, note }   거래 메모 (빈 글 → 지움, 200자까지)
 *  - GET /api/journal/returns?preset=1W|1M|3M|YTD|1Y|custom&from&to&market=ALL|KR|US   기간 수익률 (시간가중, 10거래일 뒤)
 *  - GET /api/journal/tax?year=2026&includeUncertain=1   해외주식 양도세 추정 (참고용). 순서 모름 매도는 기본으로 합계에서 빼고 따로 (1 이면 넣음)
 * 요청은 네트워크를 기다리지 않는다 (환율은 저장한 값만)
 */
export const journalRoutes: FastifyPluginAsync<{ service: JournalService; now: () => Date }> = async (app, { service, now }) => {
  app.get("/journal", async (req) => {
    const q = z.object({ from: day.optional(), to: day.optional(), code: code.optional() }).parse(req.query);
    if (!(await service.enabled())) return { enabled: false, days: [], stocks: [] };
    return service.journal({ ...range(q, now()), ...(q.code ? { code: q.code } : {}) });
  });

  app.get("/journal/stock/:code", async (req) => {
    const p = z.object({ code }).parse(req.params);
    if (!(await service.enabled())) return { enabled: false };
    return { enabled: true, ...(await service.stock(p.code)) };
  });

  app.put("/journal/notes", { bodyLimit: 4096 }, async (req) => {
    const b = z
      .object({
        account: z.number().int().min(0).max(1e9),
        orderId: z.string().min(1).max(64),
        // 글자 수는 지우고 난 뒤에 센다 (보이지 않는 글자는 세지 않음) — 여기서는 크게만 막는다
        note: z.string().max(NOTE_MAX * 4),
      })
      .parse(req.body ?? {});
    if (!(await service.enabled())) throw new JournalOffError();
    return service.saveNote(b.account, b.orderId, b.note);
  });

  app.get("/journal/returns", async (req) => {
    const q = z
      .object({
        preset: z.enum(["1W", "1M", "3M", "YTD", "1Y", "custom"]).default("1M"),
        from: day.optional(),
        to: day.optional(),
        market: z.enum(["ALL", "KR", "US"]).default("ALL"),
      })
      .parse(req.query);
    if (!(await service.enabled())) return { enabled: false, ready: false };
    if (q.preset === "custom") {
      if (!q.from || !q.to) throw new AppError(400, "VALIDATION", "직접 고른 기간은 from·to 가 필요합니다");
      range(q, now());
    }
    return service.returns({ preset: q.preset, market: q.market, ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) });
  });

  app.get("/journal/tax", async (req) => {
    const q = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), includeUncertain: z.enum(["0", "1", "true", "false"]).optional() }).parse(req.query);
    if (!(await service.enabled())) return { enabled: false };
    return service.tax(q.year ?? Number(seoulDate(now()).slice(0, 4)), { includeUncertain: q.includeUncertain === "1" || q.includeUncertain === "true" });
  });
};

/**
 * 관리용 (API_TOKEN 보호): 배포 뒤 확인·환율 미리 받기.
 *  - GET  /check           짝마다 원장 ↔ 스냅샷 대조(맞음·설명되지 않은 구간·큰 주가 변화·기록 전 모름), 빠진 환율
 *  - POST /fx { from, to } 그 기간 체결의 토스 과거 환율·결제일 매매기준율을 지금 받는다 (꺼져 있으면 409)
 */
export const journalAdminRoutes: FastifyPluginAsync<{ service: JournalService; now: () => Date }> = async (app, { service, now }) => {
  app.get("/check", async () => service.check());
  app.post("/fx", async (req) => {
    const b = z.object({ from: day.optional(), to: day.optional() }).parse(req.body ?? {});
    const r = range(b, now());
    return service.prefetch(r.from, r.to);
  });
};
