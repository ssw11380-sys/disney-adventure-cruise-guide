import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CODE_RE, isKrCode, normalizeCode } from "../lib/codes.js";
import type { FinancialsProvider } from "../providers/dart/types.js";
import type { NewsProvider } from "../providers/news/types.js";
import type { AnalysisService } from "../services/analysisService.js";
import type { StockService } from "../services/stockService.js";

const params = z.object({
  code: z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE, "종목 코드는 6자리 숫자(한국) 또는 티커(미국)")),
  kind: z.enum(["company", "value", "technical"]),
});
const codeParam = z.object({ code: z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE, "종목 코드는 6자리 숫자(한국) 또는 티커(미국)")) });
const query = z.object({ refresh: z.coerce.boolean().default(false) });

export interface AnalysisRouteDeps {
  service: AnalysisService;
  stocks: StockService;
  news: NewsProvider;
  financials: FinancialsProvider | null;
  /** 미국 종목 공시 (SEC EDGAR) */
  financialsUs?: FinancialsProvider | null;
}

export const analysisRoutes: FastifyPluginAsync<AnalysisRouteDeps> = async (app, { service, stocks, news, financials, financialsUs }) => {
  /** GET /api/stocks/:code/analysis/:kind?refresh=1 — 종목 상세 탭 (회사 소개 / 가치투자 / 기술적 분석) */
  app.get("/:code/analysis/:kind", async (req) => {
    const { code, kind } = params.parse(req.params);
    const { refresh } = query.parse(req.query);
    return service.get(code, kind, { refresh });
  });

  /** GET /api/stocks/:code/news — 종목 상세 4번째 탭 (최근 뉴스 + 공시). 각 항목 독립, 실패는 error 로 */
  app.get("/:code/news", async (req) => {
    const { code } = codeParam.parse(req.params);
    const registered = await stocks.get(code);
    const name = registered?.name ?? (await stocks.search(code, 1)).results[0]?.name ?? code;
    const kr = isKrCode(code);
    const fin = kr ? financials : (financialsUs ?? null);
    const [newsRes, discRes] = await Promise.allSettled([
      news.forStock ? news.forStock({ code, name, ...(registered?.market ? { market: registered.market } : {}) }, 15) : news.search(name, 15),
      fin ? fin.getDisclosures(code, 30, 15) : Promise.reject(new Error(kr ? "공시는 OpenDART 키를 등록하면 볼 수 있습니다" : "미국 공시 소스가 없습니다")),
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
