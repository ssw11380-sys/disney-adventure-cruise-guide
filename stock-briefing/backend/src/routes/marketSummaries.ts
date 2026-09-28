import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ownerView } from "../auth/routePolicy.js";
import { NotFoundError } from "../lib/errors.js";
import { summaryLines, type MarketSummaryData } from "../services/marketSummaryCalc.js";
import type { MarketSummary, MarketSummaryService } from "../services/marketSummaryService.js";

/** 주인 아닌 계정에게도 보여 줄 수 있는 안내(notes) — 시장 전체 이야기만. 목록에 없는 안내는 뺀다 (모르는 문구가 늘어도 새지 않는 쪽) */
const MARKET_NOTE = /^(지수를 받지 못함|원\/달러|미 10년물|한국 업종|섹터 ETF|비교할 업종|뉴스\()/;

function marketNotes(d: MarketSummaryData): string[] {
  const indexNames = d.indices.map((i) => `${i.name}: `);
  return d.notes.filter((n) => MARKET_NOTE.test(n) || indexNames.some((p) => n.startsWith(p)));
}

/**
 * 계정 A단계: 주인 아닌 계정에게는 내 종목 비교를 뺀 요약을 준다 — data.holdings 없음, 요약 글은 **보유 없이 data 에서 다시 만든다**
 * (예전에는 저장된 글에서 지금 문구와 글자가 같은 '내 종목' 줄만 뺐다 — 문구가 조금만 바뀌어도 이미 저장된 요약의 그 줄(주인 종목 이름·등락률)이
 * 그대로 갔다. 검증 지적). 안내(notes)는 시장 전체 이야기만 남긴다(모르는 안내는 뺌). 나머지(지수·환율·금리·업종·일정·뉴스)는 그대로
 */
/** 만들지 못한 요약의 고정 문구 (services/marketSummaryService — 주인 데이터가 아니다) */
const FAILED_TEXT = "지수를 받지 못해 시장 요약을 만들지 못했습니다";

export function memberSummary(s: MarketSummary): MarketSummary {
  // data 를 읽지 못한 옛 행: 저장된 글(내 종목 줄이 있을 수 있음)을 주지 않는다 — 실패 행의 고정 문구만 (검증 4차)
  if (!s.data) return { ...s, summary: s.status === "failed" && s.summary === FAILED_TEXT ? s.summary : "", data: null };
  const data: MarketSummaryData = { ...s.data, holdings: null, notes: marketNotes(s.data) };
  let summary = s.summary === FAILED_TEXT ? s.summary : "";
  if (s.status === "ok") {
    try {
      // 만든 때 기준으로 ('오늘'·'밤사이' 같은 말이 저장된 글과 같게)
      summary = summaryLines(data, new Date(Date.parse(s.data.asOf) || Date.parse(s.createdAt) || 0))
        .map((l) => l.text)
        .join("\n");
    } catch {
      summary = ""; // 옛 모양의 data 라 다시 만들지 못하면 글 없이 (저장된 글을 그대로 주지 않는다)
    }
  }
  return { ...s, summary, data };
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
