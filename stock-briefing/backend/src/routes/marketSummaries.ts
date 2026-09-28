import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ownerView } from "../auth/routePolicy.js";
import { NotFoundError } from "../lib/errors.js";
import { holdingsText } from "../services/marketSummaryCalc.js";
import type { MarketSummary, MarketSummaryService } from "../services/marketSummaryService.js";

/**
 * 계정 A단계: 주인 아닌 계정에게는 내 종목 비교를 뺀 요약을 준다 — data.holdings 없음, 요약 글에서 '내 종목' 줄 빼기,
 * 안내(notes)에서 보유·종목 시세 이야기 빼기. 나머지(지수·환율·금리·업종·일정·뉴스)는 그대로
 */
export function memberSummary(s: MarketSummary): MarketSummary {
  if (!s.data) return s;
  const mine = holdingsText(s.data);
  const summary = mine ? s.summary.split("\n").filter((l) => l !== mine).join("\n") : s.summary;
  const notes = s.data.notes.filter((n) => !/보유|내 종목|시세를 받지 못함/.test(n));
  return { ...s, summary, data: { ...s.data, holdings: null, notes } };
}

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(4) });
const idParam = z.object({ id: z.coerce.number().int().positive() });

/**
 * 시장 전체 요약 (플래그 marketSummary). 새 경로라 예전 앱은 부르지 않고, 새 앱은 예전 서버의 404 를 "없음"으로 본다 (카드 없음).
 * 플래그를 끄면 조회도 0건 — 목록은 빈 목록, 한 건은 404.
 *  - GET /api/market-summaries?limit=N   최신 순 (날짜 내림차순, 같은 날은 오후 먼저). 카드가 쓰는 숫자(data)까지
 *  - GET /api/market-summaries/latest     가장 최근 한 건 (없으면 404)
 *  - GET /api/market-summaries/:id        한 건
 */
export const marketSummaryRoutes: FastifyPluginAsync<{ service: MarketSummaryService }> = async (app, { service }) => {
  app.get("/", async (req) => {
    const { limit } = listQuery.parse(req.query);
    const list = await service.list(limit);
    return ownerView(req) ? list : list.map(memberSummary);
  });

  app.get("/latest", async (req) => {
    const [first] = await service.list(1);
    if (!first) throw new NotFoundError("시장 요약이 아직 없습니다");
    return ownerView(req) ? first : memberSummary(first);
  });

  app.get("/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const one = await service.get(id);
    return ownerView(req) ? one : memberSummary(one);
  });
};
