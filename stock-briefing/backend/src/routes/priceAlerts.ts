import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import { AppError } from "../lib/errors.js";
import { isCalendarDate, PRICE_ALERT_KINDS, VOLUME_MAX_CODES, type PriceAlertService } from "../services/priceAlertService.js";

/** 종목 코드 글 (routes/stocks.ts 의 codeParam 과 같은 규칙·같은 글) */
const CODE_MSG = "종목 코드는 6자리 숫자(한국) 또는 티커(미국)";
const code = z.string(CODE_MSG).transform(normalizeCode).pipe(z.string().regex(CODE_RE, CODE_MSG));
// zod 는 모양만 본다(모든 부품에 한국어 글 — 기본 글은 영어라 앱의 저장 실패 창에 영어가 보인다). 종류별 값 범위는 서비스의 checkValue
const createBody = z.object(
  {
    code,
    kind: z.enum(PRICE_ALERT_KINDS, "조건 종류가 올바르지 않습니다"),
    value: z.number("값은 숫자로 넣어 주세요"),
  },
  "요청 본문이 올바르지 않습니다",
);
const firedBody = z.object(
  {
    // 모양과 실제 날짜 (2026-13-45 거절). 서버 오늘 앞뒤 하루 안인지는 서비스 markFired 가 본다
    date: z.string("날짜는 YYYY-MM-DD 로 넣어 주세요").refine(isCalendarDate, "날짜는 YYYY-MM-DD 로 넣어 주세요"),
    at: z
      .string("시각 형식이 올바르지 않습니다")
      .max(40, "시각 형식이 올바르지 않습니다")
      .refine((s) => !Number.isNaN(Date.parse(s)), "시각 형식이 올바르지 않습니다"),
    value: z.number("값은 숫자로 넣어 주세요"),
  },
  "요청 본문이 올바르지 않습니다",
);
const ID_MSG = "알림 번호가 올바르지 않습니다";
const idParam = z.object({ id: z.coerce.number(ID_MSG).int(ID_MSG).positive(ID_MSG).max(Number.MAX_SAFE_INTEGER, ID_MSG) });

const disabled = () => new AppError(409, "DISABLED", "가격 알림 기능이 꺼져 있습니다");

/**
 * 가격·등락률·거래량 알림 (3-29, 플래그 priceAlerts). 새 경로라 예전 앱은 부르지 않고, 새 앱은 예전 서버의 404 를 "조건 없음"으로 본다.
 * 플래그를 끄면 목록은 빈 목록(DB 를 읽지 않음), 만들기·지우기·울림 기록은 409, 거래량 상태는 빈 목록(봉 조회 0). 저장된 조건은 지우지 않는다.
 *  - GET    /api/price-alerts                  { rules } (종목 코드, id 순. 줄마다 registered = 지금 등록 종목인지)
 *  - POST   /api/price-alerts                  { code, kind, value } → 201 조건
 *  - DELETE /api/price-alerts/:id              204
 *  - POST   /api/price-alerts/:id/fired        { date, at, value } → { first, rule } (그날 처음 울렸으면 first. date 는 실제 날짜이고 서버 오늘 앞뒤 하루 안)
 *  - GET    /api/price-alerts/volume?codes=A,B { items } 거래량 급증 상태 (최대 10종목, 순서대로)
 */
export const priceAlertRoutes: FastifyPluginAsync<{ service: PriceAlertService }> = async (app, { service }) => {
  app.get("/", async () => {
    if (!(await service.enabled())) return { rules: [] };
    return { rules: await service.list() };
  });

  app.post("/", async (req, reply) => {
    if (!(await service.enabled())) throw disabled();
    const body = createBody.parse(req.body ?? {});
    const rule = await service.create(body);
    return reply.code(201).send(rule);
  });

  app.get("/volume", async (req) => {
    if (!(await service.enabled())) return { items: [] };
    const raw = (req.query as { codes?: unknown }).codes;
    if (typeof raw !== "string" || !raw.trim()) throw new AppError(400, "VALIDATION", "codes: 종목 코드를 1개 이상 넣어 주세요");
    const codes: string[] = [];
    for (const part of raw.split(",")) {
      const c = normalizeCode(part);
      if (c && !codes.includes(c)) codes.push(c);
    }
    if (!codes.length) throw new AppError(400, "VALIDATION", "codes: 종목 코드를 1개 이상 넣어 주세요");
    if (codes.some((c) => !CODE_RE.test(c))) throw new AppError(400, "VALIDATION", `codes: ${CODE_MSG}`);
    if (codes.length > VOLUME_MAX_CODES) throw new AppError(400, "VALIDATION", "codes: 한 번에 10종목까지입니다");
    return { items: await service.volume(codes) };
  });

  app.delete("/:id", async (req, reply) => {
    if (!(await service.enabled())) throw disabled();
    const { id } = idParam.parse(req.params);
    await service.remove(id);
    return reply.code(204).send();
  });

  app.post("/:id/fired", async (req) => {
    if (!(await service.enabled())) throw disabled();
    const { id } = idParam.parse(req.params);
    const body = firedBody.parse(req.body ?? {});
    return service.markFired(id, body.date, body.at, body.value);
  });
};
