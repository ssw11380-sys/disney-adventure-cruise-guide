import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import type { IndicatorScoreService } from "../services/indicatorScoreService.js";

const codeParam = z.object({ code: z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE, "종목 코드는 6자리 숫자(한국) 또는 티커(미국)")) });

/**
 * 지표 점수 (3-44, 플래그 indicatorScores). 새 경로라 예전 앱은 부르지 않는다.
 *  - GET /api/scores/:code   종목 하나의 지표 점수 (추세 · 가치(2단계, 미국 보통주 — 플래그 valueScore) · 종합, 문장 포함). 플래그가 꺼져 있거나 모르는 종목이면 404.
 *    가치 칸은 늘 있고(예전 앱은 label·text 만 읽음), 새 칸(score·families·flags·asOf·composite.gapText …)은 더하기만 했다
 *  - GET /api/scores/:code/history[?kind=value]   저장한 하루 기록 (최근 30일, 확인용)
 */
export const scoreRoutes: FastifyPluginAsync<{ service: IndicatorScoreService }> = async (app, { service }) => {
  const off = { error: "NOT_FOUND", message: "지표 점수 기능이 꺼져 있습니다" };

  app.get("/:code", async (req, reply) => {
    if (!(await service.enabled())) return reply.code(404).send(off);
    const { code } = codeParam.parse(req.params);
    const r = await service.get(code);
    if (!r) return reply.code(404).send({ error: "NOT_FOUND", message: `종목을 찾을 수 없습니다: ${code}` });
    return r;
  });

  app.get("/:code/history", async (req, reply) => {
    if (!(await service.enabled())) return reply.code(404).send(off);
    const { code } = codeParam.parse(req.params);
    // ?kind=value 면 가치 지표 기록 (없으면 1단계와 같은 모양 — 추세 기록)
    if ((req.query as { kind?: string } | undefined)?.kind === "value") return { code, kind: "value", items: await service.history(code, 30, "value") };
    return { code, items: await service.history(code) };
  });
};
