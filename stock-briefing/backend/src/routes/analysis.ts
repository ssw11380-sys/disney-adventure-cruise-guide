import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CODE_RE, isKrCode, normalizeCode } from "../lib/codes.js";
import { NotFoundError, NotListedError } from "../lib/errors.js";
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
const trackingQuery = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{12,80}$/, "분석 요청 ID 형식이 올바르지 않습니다").optional() });

export interface AnalysisRouteDeps {
  service: AnalysisService;
  features?: { enabled(key: "analysisWaitRecovery"): Promise<boolean> };
  stocks: StockService;
  news: NewsProvider;
  financials: FinancialsProvider | null;
  /** 미국 종목 공시 (SEC EDGAR) */
  financialsUs?: FinancialsProvider | null;
}

export const analysisRoutes: FastifyPluginAsync<AnalysisRouteDeps> = async (app, { service, features, stocks, news, financials, financialsUs }) => {
  app.get("/:code/analysis/:kind/state", async (req) => {
    if (!await features?.enabled("analysisWaitRecovery")) throw new NotFoundError("분석 상태 확인 기능이 꺼져 있습니다");
    const { code, kind } = params.parse(req.params);
    const { requestId } = trackingQuery.parse(req.query);
    return service.state(code, kind, requestId);
  });

  /** GET /api/stocks/:code/analysis/:kind?refresh=1 — 종목 상세 탭 (회사 소개 / 가치투자 / 기술적 분석) */
  app.get("/:code/analysis/:kind", async (req) => {
    const { code, kind } = params.parse(req.params);
    const { refresh } = query.parse(req.query);
    // 요청 ID 없는 구버전과 플래그를 끈 경로는 예전 조회·생성 동작을 그대로 쓴다.
    if ((req.query as Record<string, unknown>).requestId !== undefined && await features?.enabled("analysisWaitRecovery")) {
      const { requestId } = trackingQuery.parse(req.query);
      return service.getTracked(code, kind, requestId!, { refresh });
    }
    return service.get(code, kind, { refresh });
  });

  /** GET /api/stocks/:code/news — 종목 상세 4번째 탭 (최근 뉴스 + 공시). 각 항목 독립, 실패는 error 로 */
  app.get("/:code/news", async (req) => {
    const { code } = codeParam.parse(req.params);
    const registered = await stocks.get(code);
    // 등록 안 한 종목은 코드가 정확히 같은 종목의 이름만 쓴다. 검색 첫 결과는 이름이 비슷한 다른 종목일 수 있다 (GE → TIGER 200)
    const name = registered?.name ?? (await stocks.preview(code))?.name ?? code;
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
      disclosuresError:
        discRes.status === "rejected"
          ? discRes.reason instanceof NotListedError
            ? "SEC 에서 찾지 못한 종목(ETF 등)이라 공시가 없습니다"
            : String(discRes.reason?.message ?? discRes.reason)
          : null,
    };
  });
};
