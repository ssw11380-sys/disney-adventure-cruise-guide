import { computeTechnicalSummary, type TechnicalSummary } from "../analysis/indicators.js";
import { isKrCode } from "../lib/codes.js";
import { NotListedError } from "../lib/errors.js";
import type { MarketStatus } from "../providers/market/calendar.js";
import { completedCandles, marketContext, type MarketContext } from "./marketContext.js";
import type { Candle, Quote, RegisteredStock } from "../domain/types.js";
import type { ChainLogger } from "../providers/market/chain.js";
import { applyFundamentals, type NaverFundamentals } from "../providers/market/fundamentals.js";
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
 * 원래 없는 데이터(미국 종목 수급, 키를 넣지 않은 DART, SEC 에 없는 ETF 공시)는 실패가 아니므로 missing 이 아니라 notes 에 둔다.
 */

export interface CollectorDeps {
  quotes: QuoteProvider;
  news: NewsProvider;
  financials: FinancialsProvider | null;
  /** 미국 종목용 (SEC EDGAR). 없으면 "미국 종목 미지원" */
  financialsUs?: FinancialsProvider | null;
  investorFlow: InvestorFlowProvider | null;
  /** PER/PBR/배당/환율 보강 (StockService 와 같은 로직을 브리핑·분석 데이터에도 적용) */
  fundamentals?: NaverFundamentals | null;
  /** 여러 종목 시세를 한 번에 받아 두는 곳(토스 웹). 브리핑 전에 불러 한국 종목 기준가를 미리 채운다 */
  quickPrices?: { getMany(codes: string[]): Promise<unknown> } | null;
  /** 장 상태 (정규장 중·마감·프리/애프터·주간거래). 없으면 요일·시각으로 추정 */
  calendar?: { status(): Promise<MarketStatus> } | null;
  now?: () => Date;
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
  /** 브리핑 시점의 장 상태 (예전 스냅샷에는 없음) */
  marketState?: MarketContext;
  /** 실제로 받으려다 실패한 데이터 */
  missing: string[];
  /** 원래 제공되지 않는 데이터 (실패 아님). 예전 스냅샷에는 없음 */
  notes?: string[];
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
  /** 분석 시점의 장 상태 (예전 스냅샷에는 없음) */
  marketState?: MarketContext;
  missing: string[];
  /** 원래 제공되지 않는 데이터 (실패 아님) */
  notes?: string[];
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

  private news(stock: { code: string; name: string; market?: string }, limit: number): Promise<NewsItem[]> {
    const n = this.deps.news;
    return n.forStock ? n.forStock(stock, limit) : n.search(stock.name, limit);
  }

  /** 현재가 + 밸류에이션·환율 보강 */
  private async quote(code: string, market?: string): Promise<Quote> {
    const q = await this.deps.quotes.getQuote(code);
    const f = this.deps.fundamentals;
    if (!f) return q;
    const [fund, fx] = await Promise.all([
      q.per === null || q.pbr === null ? f.get(code, market ?? null).catch(() => null) : Promise.resolve(null),
      q.currency === "USD" ? f.usdKrw().catch(() => null) : Promise.resolve(null),
    ]);
    let out = applyFundamentals(q, fund);
    // 원화 환산은 함께 넣는 환율(fxRate)로 — 앱(StockService)과 같은 규칙
    if (q.currency === "USD" && fx) out = { ...out, fxRate: fx, priceKrw: Math.round(out.price * fx) };
    return out;
  }

  /** 여러 종목을 모을 때 앞서 한 번: 시세·기준가를 일괄로 받아 둔다 (종목마다 따로 부르지 않게). 실패해도 그냥 진행 */
  async warm(codes: string[]): Promise<void> {
    if (!this.deps.quickPrices || !codes.length) return;
    await this.deps.quickPrices.getMany(codes).catch(() => undefined);
  }

  /** SEC 에 없는 종목(ETF 등)은 실패가 아니라 "해당 없음" → notes 에 남기고 empty 로 */
  private notListed<T>(notes: string[], label: string, empty: T, fn: () => Promise<T>): () => Promise<T> {
    return () =>
      fn().catch((e: unknown) => {
        if (!(e instanceof NotListedError)) throw e;
        notes.push(`${label}: SEC 에서 찾지 못한 종목(ETF 등)이라 해당 없음`);
        return empty;
      });
  }

  private async marketStatus(): Promise<MarketStatus | null> {
    return this.deps.calendar ? this.deps.calendar.status().catch(() => null) : null;
  }

  /** 시장에 맞는 재무·공시 소스. 한국은 DART, 미국은 EDGAR */
  private finFor(code: string): { provider: FinancialsProvider | null; missingSuffix: string } {
    if (isKrCode(code)) return { provider: this.deps.financials, missingSuffix: "(DART 키 없음)" };
    return { provider: this.deps.financialsUs ?? null, missingSuffix: "(미국 종목 미지원)" };
  }

  async collectBriefing(stock: RegisteredStock): Promise<BriefingSnapshot> {
    const missing: string[] = [];
    const notes: string[] = [];
    const q = this.deps;
    const now = q.now?.() ?? new Date();
    const kr = isKrCode(stock.code);
    const fin = this.finFor(stock.code);
    const [quote, series, news, disclosures, investorFlow, status] = await Promise.all([
      this.attempt("현재가", missing, () => this.quote(stock.code, stock.market)),
      this.attempt("일봉/기술적 지표", missing, () => q.quotes.getCandles(stock.code, "D", 160)),
      this.attempt("뉴스", missing, () => this.news(stock, 8)),
      fin.provider
        ? this.attempt("공시", missing, this.notListed(notes, "공시", [] as Disclosure[], () => fin.provider!.getDisclosures(stock.code, 7, 8)))
        : (notes.push(kr ? "공시: DART 키가 없어 받지 않음" : "공시: 미국 공시 소스 없음"), Promise.resolve(null)),
      !kr
        ? (notes.push("수급: 미국 종목은 투자자별 매매 동향이 제공되지 않음"), Promise.resolve(null))
        : q.investorFlow
          ? this.attempt("수급", missing, () => q.investorFlow!.getInvestorFlow(stock.code, 10))
          : (notes.push("수급: KIS/토스 Open API 키가 없어 받지 않음"), Promise.resolve(null)),
      this.marketStatus(),
    ]);
    // 지표는 끝난 봉까지만 (정규장 중인 오늘 봉·20:00 전 한국 통합 봉·주간거래로 생긴 봉은 빼고)
    const market = marketContext(stock.code, status, now);
    const candles = series ? completedCandles(series.candles, market, now) : null;
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
      marketState: market,
      missing: orderMissing(missing),
      notes,
    };
  }

  async collectAnalysis(stock: { code: string; name: string; market: string }, kind: "company" | "value" | "technical"): Promise<AnalysisSnapshot> {
    const missing: string[] = [];
    const notes: string[] = [];
    const q = this.deps;
    const now = q.now?.() ?? new Date();
    const { provider: fin, missingSuffix } = this.finFor(stock.code);
    const noDart = <T>(label: string): Promise<T | null> => {
      missing.push(`${label}${missingSuffix}`);
      return Promise.resolve(null);
    };

    const wantFundamentals = kind !== "technical";
    const wantTechnical = kind !== "company";

    const [quote, daily, weekly, company, financials, dividends, disclosures, news, status] = await Promise.all([
      this.attempt("현재가", missing, () => this.quote(stock.code, stock.market)),
      wantTechnical ? this.attempt("일봉", missing, () => q.quotes.getCandles(stock.code, "D", 160)) : Promise.resolve(null),
      kind === "technical" ? this.attempt("주봉", missing, () => q.quotes.getCandles(stock.code, "W", 26)) : Promise.resolve(null),
      kind === "company" ? (fin ? this.attempt("회사 개요", missing, this.notListed<CompanyProfile | null>(notes, "회사 개요", null, () => fin.getCompany(stock.code))) : noDart<CompanyProfile>("회사 개요")) : Promise.resolve(null),
      wantFundamentals ? (fin ? this.attempt("재무제표", missing, this.notListed(notes, "재무제표", [] as AnnualFinancials[], () => fin.getAnnualFinancials(stock.code, 5))) : noDart<AnnualFinancials[]>("재무제표")) : Promise.resolve(null),
      kind === "value" ? (fin ? this.attempt("배당", missing, this.notListed(notes, "배당", [] as DividendInfo[], () => fin.getDividends(stock.code, 3))) : noDart<DividendInfo[]>("배당")) : Promise.resolve(null),
      wantFundamentals ? (fin ? this.attempt("공시", missing, this.notListed(notes, "공시", [] as Disclosure[], () => fin.getDisclosures(stock.code, 90, 10))) : noDart<Disclosure[]>("공시")) : Promise.resolve(null),
      kind === "company" ? this.attempt("뉴스", missing, () => this.news(stock, 8)) : Promise.resolve(null),
      this.marketStatus(),
    ]);

    // 기술적 지표는 브리핑과 같이 끝난 정규장 봉까지만
    const marketState = marketContext(stock.code, status, now);
    const technical = daily ? computeTechnicalSummary(completedCandles(daily.candles, marketState, now)) : null;
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
      marketState,
      missing: orderMissing(missing),
      notes,
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
