import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { FinancialsProvider } from "../providers/dart/types.js";
import type { NewsProvider } from "../providers/news/types.js";
import type { AnalysisService } from "../services/analysisService.js";
import type { StockService } from "../services/stockService.js";

const params = z.object({
  code: z.string().regex(/^\d{6}$/, "종목 코드는 6자리 숫자"),
  kind: z.enum(["company", "value", "technical"]),
});
const codeParam = z.object({ code: z.string().regex(/^\d{6}$/, "종목 코드는 6자리 숫자") });
const query = z.object({ refresh: z.coerce.boolean().default(false) });

export interface AnalysisRouteDeps {
  service: AnalysisService;
  stocks: StockService;
  news: NewsProvider;
  financials: FinancialsProvider | null;
}

export const analysisRoutes: FastifyPluginAsync<AnalysisRouteDeps> = async (app, { service, stocks, news, financials }) => {
  /** GET /api/stocks/:code/analysis/:kind?refresh=1 — 종목 상세 탭 (회사 소개 / 가치투자 / 기술적 분석) */
  app.get("/:code/analysis/:kind", async (req) => {
    const { code, kind } = params.parse(req.params);
    const { refresh } = query.parse(req.query);
    return service.get(code, kind, { refresh });
  });

  /** GET /api/stocks/:code/news — 종목 상세 4번째 탭 (최근 뉴스 + 공시). 각 항목 독립, 실패는 error 로 */
  app.get("/:code/news", async (req) => {
    const { code } = codeParam.parse(req.params);
    const name =
      (await stocks.get(code))?.name ??
      (await stocks.search(code, 1)).results[0]?.name ??
      code;
    const [newsRes, discRes] = await Promise.allSettled([
      news.search(name, 15),
      financials ? financials.getDisclosures(code, 30, 15) : Promise.reject(new Error("DART_API_KEY 가 설정되지 않았습니다")),
    ]);
    return {
      code,
      name,
      news: newsRes.status === "fulfilled" ? newsRes.value : [],
      newsError: newsRes.status === "rejected" ? String(newsRes.reason?.message ?? newsRes.reason) : null,
      disclosures: discRes.status === "fulfilled" ? discRes.value : [],
      disclosuresError: discRes.status === "rejected" ? String(discRes.reason?.message ?? discRes.reason) : null,
    };
  });
};
