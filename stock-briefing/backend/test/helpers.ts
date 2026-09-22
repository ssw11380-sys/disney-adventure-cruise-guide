import type { CandlePeriod, CandleSeries, ListedStock, Quote } from "../src/domain/types.js";
import { ProviderError } from "../src/lib/errors.js";
import { GenerationError, type GenerateRequest, type GenerateResult, type TextGenerator } from "../src/llm/generator.js";
import type { InvestorFlowDay, InvestorFlowProvider } from "../src/providers/market/investorFlow.js";
import type { MasterProvider, QuoteProvider, StockSearchProvider } from "../src/providers/market/types.js";
import type { NewsItem, NewsProvider } from "../src/providers/news/types.js";
import type { Providers } from "../src/providers/index.js";
import type { PushMessage, PushSender, PushSendResult } from "../src/notifications/push.js";

export const SAMPLE_MASTER: ListedStock[] = [
  { code: "000660", name: "SK하이닉스", market: "KOSPI", isinCode: "KR7000660001", groupCode: "ST" },
  { code: "005930", name: "삼성전자", market: "KOSPI", isinCode: "KR7005930003", groupCode: "ST" },
  { code: "005935", name: "삼성전자우", market: "KOSPI", isinCode: "KR7005931001", groupCode: "ST" },
  { code: "247540", name: "에코프로비엠", market: "KOSDAQ", isinCode: "KR7247540008", groupCode: "ST" },
  { code: "465580", name: "ACE 하이닉스+삼성전자", market: "KOSPI", isinCode: "KR7465580000", groupCode: "EF" },
];

export function makeQuote(code: string, source: string, price = 100_000): Quote {
  return {
    code, currency: "KRW", price, change: 1000, changeRate: 1.01, open: 99_000, high: 101_000, low: 98_500, prevClose: 99_000,
    volume: 1_000_000, marketCap: null, per: null, pbr: null, eps: null, bps: null, high52w: null, low52w: null,
    asOf: "2026-09-22T09:00:00+09:00", source,
  };
}

export class FakeQuoteProvider implements QuoteProvider {
  calls = 0;
  constructor(
    public readonly name: string,
    public readonly opts: { fail?: boolean; price?: number; failCandles?: boolean } = {},
  ) {}
  async getQuote(code: string): Promise<Quote> {
    this.calls++;
    if (this.opts.fail) throw new ProviderError(this.name, "고의 실패");
    return makeQuote(code, this.name, this.opts.price);
  }
  async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    this.calls++;
    if (this.opts.fail || this.opts.failCandles) throw new ProviderError(this.name, "고의 실패");
    const candles = Array.from({ length: count }, (_, i) => {
      const c = 100_000 + Math.round(Math.sin(i / 7) * 5000) + i * 50;
      return {
        date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
        open: c - 200, high: c + 800, low: c - 900, close: c, volume: 1_000_000 + i * 1000,
      };
    });
    return { code, period, candles, source: this.name };
  }
}

export class FakeSearchProvider implements StockSearchProvider {
  readonly name = "fake-search";
  calls: string[] = [];
  constructor(private readonly results: ListedStock[] = []) {}
  async search(query: string): Promise<ListedStock[]> {
    this.calls.push(query);
    return this.results;
  }
}

export class FakeMasterProvider implements MasterProvider {
  readonly name = "fake-master";
  constructor(private readonly rows: ListedStock[] = SAMPLE_MASTER) {}
  async fetchAll(): Promise<ListedStock[]> {
    return this.rows;
  }
}

export class FakeNewsProvider implements NewsProvider {
  readonly name = "fake-news";
  queries: string[] = [];
  constructor(public opts: { fail?: boolean } = {}) {}
  async search(query: string, limit: number): Promise<NewsItem[]> {
    this.queries.push(query);
    if (this.opts.fail) throw new ProviderError(this.name, "고의 실패");
    return Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
      title: `${query} 뉴스 ${i + 1}`,
      url: `https://example.com/${i}`,
      source: "예시일보",
      publishedAt: "2026-09-22T00:00:00.000Z",
      summary: null,
    }));
  }
}

export class FakeInvestorFlow implements InvestorFlowProvider {
  readonly name = "fake-flow";
  async getInvestorFlow(_code: string, days: number): Promise<InvestorFlowDay[]> {
    return Array.from({ length: days }, (_, i) => ({ date: `2026-09-${String(22 - i).padStart(2, "0")}`, close: 100_000, individual: -1000 * i, foreign: 800 * i, institution: 200 * i }));
  }
}

/** 프롬프트를 받은 순서대로 기록하고 canned 응답을 준다 */
export class FakeGenerator implements TextGenerator {
  readonly model = "fake-model";
  requests: GenerateRequest[] = [];
  constructor(public opts: { failKind?: GenerationError["kind"]; failOnLabel?: string } = {}) {}
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    if (this.opts.failKind && (!this.opts.failOnLabel || req.label?.startsWith(this.opts.failOnLabel))) {
      throw new GenerationError("가짜 실패", this.opts.failKind);
    }
    const label = req.label ?? "";
    const text = label.startsWith("briefing_summary")
      ? "- **주가** 100,000원 (+1.01%)\n2. 뉴스 요약 한 줄\n3. 내일 체크포인트\n4. 넘치는 줄"
      : `## 한 줄 요약\n${label} 결과입니다.\n\n## 본문\n데이터 길이 ${req.user.length}`;
    return { text, model: this.model, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, stopReason: "end_turn" };
  }
}

/** 아무것도 보내지 않는 푸시 (기본 가짜) */
export class NoopPushSender implements PushSender {
  readonly name = "noop-push";
  isValidToken(token: string): boolean {
    return /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/.test(token);
  }
  async send(tokens: string[], _message: PushMessage): Promise<PushSendResult> {
    return { results: tokens.map((token) => ({ token, ok: true, error: null, receiptId: null })) };
  }
  async checkReceipts() {
    return [];
  }
}

export function fakeProviders(over: Partial<Providers> = {}): Providers {
  return {
    quotes: new FakeQuoteProvider("kis"),
    tossOpenApi: null,
    live: null,
    quickPrices: null,
    search: new FakeSearchProvider([SAMPLE_MASTER[0]!]),
    master: new FakeMasterProvider(),
    news: new FakeNewsProvider(),
    financials: null,
    investorFlow: null,
    generator: new FakeGenerator(),
    dart: null,
    push: new NoopPushSender(),
    ...over,
  };
}
