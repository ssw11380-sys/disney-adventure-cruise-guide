import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { memberScoreView, ownerView, SCORE_DAILY_LIMIT, sessionOf } from "../auth/routePolicy.js";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import { seoulIso } from "../lib/time.js";
import type { IndicatorScoreService } from "../services/indicatorScoreService.js";

const codeParam = z.object({ code: z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE, "종목 코드는 6자리 숫자(한국) 또는 티커(미국)")) });

/**
 * 지표 점수 (3-44, 플래그 indicatorScores). 새 경로라 예전 앱은 부르지 않는다.
 *  - GET /api/scores/:code   종목 하나의 지표 점수 (추세 · 가치(2단계, 미국 보통주 — 플래그 valueScore) · 종합, 문장 포함). 플래그가 꺼져 있거나 모르는 종목이면 404.
 *    가치 칸은 늘 있고(예전 앱은 label·text 만 읽음), 새 칸(score·families·flags·asOf·composite.gapText …)은 더하기만 했다
 *  - GET /api/scores/:code/history[?kind=value]   저장한 하루 기록 (최근 30일, 확인용)
 */
export interface ScoreRouteDeps {
  service: IndicatorScoreService;
  /**
   * 계정 A단계 (검증 4차): 주인 아닌 계정이 하루에 볼 수 있는 서로 다른 종목 수 — 계산에 주인 키로 일봉·재무를 받는다.
   * 캐시에 있든 없든 센다 (장 마감 뒤 미리 계산한 주인 등록 종목이 한도를 다 쓴 뒤 캐시 여부로 드러나지 않게). 없으면 한도 없음
   */
  memberQuota?: { take(userId: number, item: string): boolean };
  now?: () => Date;
}

export const scoreRoutes: FastifyPluginAsync<ScoreRouteDeps> = async (app, { service, memberQuota, now = () => new Date() }) => {
  const off = { error: "NOT_FOUND", message: "지표 점수 기능이 꺼져 있습니다" };

  app.get("/:code", async (req, reply) => {
    if (!(await service.enabled())) return reply.code(404).send(off);
    const { code } = codeParam.parse(req.params);
    const owner = ownerView(req);
    const who = owner ? null : sessionOf(req);
    if (who && memberQuota && !memberQuota.take(who.user.id, code)) return reply.code(429).send(SCORE_DAILY_LIMIT);
    // 주인 아닌 계정: 가치 칸이 '재무 받는 중'이면 받기를 잠깐 기다린다 — 처음 보는 종목만 '계산 준비 중'으로 시작해 주인 등록 종목이 본문으로 드러나지 않게 (검증 6차 M2)
    const r = owner ? await service.get(code) : await service.getShared(code);
    if (!r) return reply.code(404).send({ error: "NOT_FOUND", message: `종목을 찾을 수 없습니다: ${code}` });
    // 주인 아닌 계정: 캐시 계산 시각 대신 요청 시각, 재무 받은 시각은 빈 값 (검증 4차 M2)
    return owner ? r : memberScoreView(r, seoulIso(now()));
  });

  app.get("/:code/history", async (req, reply) => {
    if (!(await service.enabled())) return reply.code(404).send(off);
    const { code } = codeParam.parse(req.params);
    // ?kind=value 면 가치 지표 기록 (없으면 1단계와 같은 모양 — 추세 기록)
    if ((req.query as { kind?: string } | undefined)?.kind === "value") return { code, kind: "value", items: await service.history(code, 30, "value") };
    return { code, items: await service.history(code) };
  });
};
