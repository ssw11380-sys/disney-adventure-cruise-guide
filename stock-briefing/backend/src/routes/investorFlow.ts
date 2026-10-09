import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { memberFlowView, ownerView } from "../auth/routePolicy.js";
import { CODE_RE, KR_CODE_RE, normalizeCode } from "../lib/codes.js";
import { AppError } from "../lib/errors.js";
import { seoulIso } from "../lib/time.js";
import { FLOW_TEXT } from "../services/flowText.js";
import type { InvestorFlowService } from "../services/investorFlowService.js";

const codeParam = z.object({ code: z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE, "종목 코드는 6자리 숫자(한국) 또는 티커(미국)")) });
const krQuery = z.object({ code: z.string().transform(normalizeCode).pipe(z.string().regex(KR_CODE_RE, "한국 종목 코드(6자리)가 필요합니다")) });

/**
 * 수급 탭 (3-33, 플래그 flowTab). 새 경로라 예전 앱은 부르지 않는다.
 *  - GET /api/investor-flow/:code — 공용(shared): 시장 자료, 계정마다 다른 값 없음. 한국 종목은 투자자별 순매수·외국인 보유율, 미국은 supported: false.
 *    주인 아닌 계정(계정 A단계)은 가린 모습 (routePolicy memberFlowView — 받은 시각은 요청 시각, 대조 기록 없음, 옛 캐시는 502)
 *    플래그가 꺼져 있거나 출처 묶음이 없으면 404 (외부 호출 0). 두 출처 모두 실패하고 캐시도 없으면 502
 */
export const investorFlowRoutes: FastifyPluginAsync<{ service: InvestorFlowService; now?: () => Date }> = async (app, { service, now = () => new Date() }) => {
  app.get("/:code", async (req, reply) => {
    if (!(await service.enabled())) return reply.code(404).send({ error: "NOT_FOUND", message: FLOW_TEXT.off });
    const { code } = codeParam.parse(req.params);
    const body = await service.get(code);
    if (ownerView(req)) return body;
    // 계정 A단계 (main #122 합친 뒤): 주인 아닌 계정은 캐시의 받은 시각·대조 기록 없이 (그 종목을 누가 먼저 열었는지 드러나지 않게).
    // 새로 받지 못해 옛 캐시(stale)만 있으면 처음 보는 종목의 실패와 같게 502
    if (body.supported && body.stale) throw new AppError(502, "UPSTREAM", FLOW_TEXT.upstream);
    return memberFlowView(body, seoulIso(now()));
  });
};

/**
 * 관리(서버 주인만): GET /api/admin/investor-flow/check?code=005930 — 토스 Open API 원자료와 그 자리에서 대조해 날짜별 두 값을 준다.
 * 원자료가 담기므로 공용 경로에는 개수만. 플래그가 꺼져 있으면 { enabled: false }
 */
export const investorFlowAdminRoutes: FastifyPluginAsync<{ service: InvestorFlowService }> = async (app, { service }) => {
  app.get("/check", async (req) => {
    if (!(await service.enabled())) return { enabled: false };
    const { code } = krQuery.parse(req.query ?? {});
    return service.adminCheck(code);
  });
};
