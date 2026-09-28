import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ownerView, sessionOf } from "../auth/routePolicy.js";
import { CODE_RE, isKrCode, normalizeCode } from "../lib/codes.js";
import { NotListedError } from "../lib/errors.js";
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
  /** 계정 A단계: 주인 아닌 계정이 새로 만들게 하는 분석 수 (사용자별 하루). 없으면 한도 없음 */
  memberQuota?: { take(userId: number): boolean };
}

export const analysisRoutes: FastifyPluginAsync<AnalysisRouteDeps> = async (app, { service, stocks, news, financials, financialsUs, memberQuota }) => {
  /** GET /api/stocks/:code/analysis/:kind?refresh=1 — 종목 상세 탭 (회사 소개 / 가치투자 / 기술적 분석) */
  app.get("/:code/analysis/:kind", async (req, reply) => {
    const { code, kind } = params.parse(req.params);
    const { refresh } = query.parse(req.query);
    if (ownerView(req)) return service.get(code, kind, { refresh });
    // 계정 A단계: 주인 아닌 계정은 새로 만들기(refresh)를 무시하고(모델 비용), 캐시에 없어 새로 만드는 것은 사용자별 하루 한도까지
    const fresh = await service.fresh(code, kind);
    if (fresh) return fresh;
    const who = sessionOf(req);
    if (who && memberQuota && !memberQuota.take(who.user.id)) {
      return reply.code(429).send({ error: "AI_DAILY_LIMIT", code: "ai_daily_limit", message: "오늘 새로 만들 수 있는 분석 수를 다 썼어요. 내일 다시 볼 수 있어요" });
    }
    return service.get(code, kind, { refresh: false });
  });

  /** GET /api/stocks/:code/news — 종목 상세 4번째 탭 (최근 뉴스 + 공시). 각 항목 독립, 실패는 error 로 */
  app.get("/:code/news", async (req) => {
    const { code } = codeParam.parse(req.params);
    // 계정 A단계: 주인 아닌 계정은 등록 표를 보지 않는다 (미리 보기 이름·시장만)
    const registered = ownerView(req) ? await stocks.get(code) : null;
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
