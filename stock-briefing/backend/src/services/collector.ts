import { computeTechnicalSummary, type TechnicalSummary } from "../analysis/indicators.js";
import { isKrCode } from "../lib/codes.js";
import type { Candle, Quote, RegisteredStock } from "../domain/types.js";
import type { ChainLogger } from "../providers/market/chain.js";
import type { InvestorFlowDay, InvestorFlowProvider } from "../providers/market/investorFlow.js";
import type { QuoteProvider } from "../providers/market/types.js";
import type { NewsItem, NewsProvider } from "../providers/news/types.js";
import type {
  AnnualFinancials,
  CompanyProfile,
  Disclosure,
  DividendInfo,
  FinancialsProvider,
} from "../providers/dart/types.js";

/**
 * 프롬프트에 넣을 데이터를 모은다.
 * 각 항목은 독립적으로 시도하고, 실패하면 null + missing 목록에 이름을 남긴다.
 * 그래서 외부 API 하나가 죽어도 브리핑은 나간다("데이터 미확인" 표시).
 */

export interface CollectorDeps {
  quotes: QuoteProvider;
  news: NewsProvider;
  financials: FinancialsProvider | null;
  investorFlow: InvestorFlowProvider | null;
  log?: ChainLogger;
}

export interface BriefingSnapshot {
  stock: { code: string; name: string; market: string; quantity: number | null; avgPrice: number | null };
  quote: Quote | null;
  recentCandles: Candle[] | null; // 최근 10일
  technical: TechnicalSummary | null;
  news: NewsItem[] | null;
  disclosures: Disclosure[] | null;
  investorFlow: InvestorFlowDay[] | null;
  holding: { profit: number; profitRate: number; marketValue: number } | null;
  missing: string[];
}

export interface AnalysisSnapshot {
  stock: { code: string; name: string; market: string };
  quote: Quote | null;
  technical: TechnicalSummary | null;
  weeklyCandles: Candle[] | null;
  company: CompanyProfile | null;
  financials: AnnualFinancials[] | null;
  dividends: DividendInfo[] | null;
  disclosures: Disclosure[] | null;
  news: NewsItem[] | null;
  ratios: { roePct: number | null; debtToEquityPct: number | null; operatingMarginPct: number | null } | null;
  missing: string[];
}

export class DataCollector {
  constructor(private readonly deps: CollectorDeps) {}

  private async attempt<T>(label: string, missing: string[], fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      missing.push(label);
      this.deps.log?.warn({ label, err: e instanceof Error ? e.message : String(e) }, "데이터 수집 실패");
      return null;
    }
  }

  async collectBriefing(stock: RegisteredStock): Promise<BriefingSnapshot> {
    const missing: string[] = [];
    const q = this.deps;
    const [quote, series, news, disclosures, investorFlow] = await Promise.all([
      this.attempt("현재가", missing, () => q.quotes.getQuote(stock.code)),
      this.attempt("일봉/기술적 지표", missing, () => q.quotes.getCandles(stock.code, "D", 160)),
      this.attempt("뉴스", missing, () => q.news.search(stock.name, 8)),
      !isKrCode(stock.code)
        ? (missing.push("공시(미국 종목 미지원)"), Promise.resolve(null))
        : q.financials
          ? this.attempt("공시", missing, () => q.financials!.getDisclosures(stock.code, 7, 8))
          : (missing.push("공시(DART 키 없음)"), Promise.resolve(null)),
      !isKrCode(stock.code)
        ? (missing.push("수급(미국 종목 미지원)"), Promise.resolve(null))
        : q.investorFlow
          ? this.attempt("수급", missing, () => q.investorFlow!.getInvestorFlow(stock.code, 10))
          : (missing.push("수급(KIS/토스 Open API 키 없음)"), Promise.resolve(null)),
    ]);
    const candles = series?.candles ?? null;
    const technical = candles ? computeTechnicalSummary(candles) : null;
    if (candles && !technical) missing.push("기술적 지표(봉 부족)");
    const holding =
      quote && stock.quantity && stock.avgPrice
        ? {
            marketValue: quote.price * stock.quantity,
            profit: (quote.price - stock.avgPrice) * stock.quantity,
            profitRate: Math.round(((quote.price - stock.avgPrice) / stock.avgPrice) * 10000) / 100,
          }
        : null;
    return {
      stock: { code: stock.code, name: stock.name, market: stock.market, quantity: stock.quantity, avgPrice: stock.avgPrice },
      quote,
      recentCandles: candles ? candles.slice(-10) : null,
      technical,
      news,
      disclosures,
      investorFlow,
      holding,
      missing: orderMissing(missing),
    };
  }

  async collectAnalysis(stock: { code: string; name: string; market: string }, kind: "company" | "value" | "technical"): Promise<AnalysisSnapshot> {
    const missing: string[] = [];
    const q = this.deps;
    const fin = isKrCode(stock.code) ? q.financials : null;
    const noDart = <T>(label: string): Promise<T | null> => {
      missing.push(isKrCode(stock.code) ? `${label}(DART 키 없음)` : `${label}(미국 종목 미지원)`);
      return Promise.resolve(null);
    };

    const wantFundamentals = kind !== "technical";
    const wantTechnical = kind !== "company";

    const [quote, daily, weekly, company, financials, dividends, disclosures, news] = await Promise.all([
      this.attempt("현재가", missing, () => q.quotes.getQuote(stock.code)),
      wantTechnical ? this.attempt("일봉", missing, () => q.quotes.getCandles(stock.code, "D", 160)) : Promise.resolve(null),
      kind === "technical" ? this.attempt("주봉", missing, () => q.quotes.getCandles(stock.code, "W", 26)) : Promise.resolve(null),
      kind === "company" ? (fin ? this.attempt("회사 개요", missing, () => fin.getCompany(stock.code)) : noDart<CompanyProfile>("회사 개요")) : Promise.resolve(null),
      wantFundamentals ? (fin ? this.attempt("재무제표", missing, () => fin.getAnnualFinancials(stock.code, 5)) : noDart<AnnualFinancials[]>("재무제표")) : Promise.resolve(null),
      kind === "value" ? (fin ? this.attempt("배당", missing, () => fin.getDividends(stock.code, 3)) : noDart<DividendInfo[]>("배당")) : Promise.resolve(null),
      wantFundamentals ? (fin ? this.attempt("공시", missing, () => fin.getDisclosures(stock.code, 90, 10)) : noDart<Disclosure[]>("공시")) : Promise.resolve(null),
      kind === "company" ? this.attempt("뉴스", missing, () => q.news.search(stock.name, 8)) : Promise.resolve(null),
    ]);

    const technical = daily ? computeTechnicalSummary(daily.candles) : null;
    const latest = financials?.at(-1) ?? null;
    const ratios =
      latest
        ? {
            roePct: pct(latest.netIncome, latest.totalEquity),
            debtToEquityPct: pct(latest.totalLiabilities, latest.totalEquity),
            operatingMarginPct: pct(latest.operatingIncome, latest.revenue),
          }
        : null;
    if (quote && quote.per === null && kind === "value") missing.push("PER/PBR(현재 시세 소스가 제공하지 않음)");

    return {
      stock,
      quote,
      technical,
      weeklyCandles: weekly?.candles ?? null,
      company,
      financials,
      dividends,
      disclosures,
      news,
      ratios,
      missing: orderMissing(missing),
    };
  }
}

/** 병렬 수집이라 실패 순서가 뒤섞이므로, 프롬프트에 넣을 때는 고정된 순서로 정렬한다 */
const MISSING_ORDER = [
  "현재가", "일봉", "일봉/기술적 지표", "기술적 지표(봉 부족)", "주봉", "회사 개요", "회사 개요(DART 키 없음)", "회사 개요(미국 종목 미지원)",
  "재무제표", "재무제표(DART 키 없음)", "재무제표(미국 종목 미지원)", "PER/PBR(현재 시세 소스가 제공하지 않음)", "배당", "배당(DART 키 없음)", "배당(미국 종목 미지원)",
  "뉴스", "공시", "공시(DART 키 없음)", "공시(미국 종목 미지원)", "수급", "수급(KIS/토스 Open API 키 없음)", "수급(미국 종목 미지원)",
];
export function orderMissing(missing: string[]): string[] {
  const idx = (s: string) => {
    const i = MISSING_ORDER.indexOf(s);
    return i === -1 ? MISSING_ORDER.length : i;
  };
  return [...missing].sort((a, b) => idx(a) - idx(b));
}

function pct(numer: number | null, denom: number | null): number | null {
  if (numer === null || denom === null || denom === 0) return null;
  return Math.round((numer / denom) * 10000) / 100;
}
