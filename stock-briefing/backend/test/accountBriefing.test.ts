import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { CandlePeriod, CandleSeries, ListedStock, Quote } from "../src/domain/types.js";
import { GenerationError, type GenerateRequest, type GenerateResult, type TextGenerator } from "../src/llm/generator.js";
import { PromptStore } from "../src/llm/prompts.js";
import { buildDigest } from "../src/notifications/digest.js";
import type { PushMessage, PushSender, PushSendResult } from "../src/notifications/push.js";
import type { MarketStatus } from "../src/providers/market/calendar.js";
import type { MarketIndex } from "../src/providers/market/indices.js";
import type { QuoteProvider } from "../src/providers/market/types.js";
import {
  apportion,
  buildSchedule,
  checkNarrative,
  computeAccount,
  factsText,
  numbersIn,
  pickIndices,
  summaryText,
  templateNarrative,
  usRegularKst,
  usSessionDate,
  type AccountData,
  type AccountHolding,
} from "../src/services/accountNumbers.js";
import { FakeSearchProvider, fakeIndexSource, fakeIndices, fakeProviders, SAMPLE_MASTER } from "./helpers.js";

/**
 * 계좌 한 장 브리핑 (3-31).
 *  - 숫자: 앱 잔고 합계와 같은 기준, 기여 상위 + 그 외 = 당일 손익 (±1원), 환율 효과 나눔의 합 = 미국 보유분 원화 변화 (±1원)
 *  - 설명: 모델이 입력에 없는 숫자를 쓰면 기본 문장, 모델이 없거나 실패해도 기본 문장으로 저장(실패 아님)
 *  - 알림: 세션당 1건 그대로, 앞머리만 계좌 요약. 플래그를 끄면 생성·모델 호출·알림 변화·지수 조회 0
 */

const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountBriefing.json", import.meta.url), "utf8")) as {
  usdKrw: MarketIndex;
  holdings: AccountHolding[];
  expected: { totalValue: number; totalCost: number; totalProfit: number; dayPnl: number; usdValue: number; usdDay: number };
};

const within1 = (a: number, b: number) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(1);
const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function holding(code: string, name: string, change: number, opts: { qty?: number; price?: number; currency?: "KRW" | "USD"; fx?: number | null } = {}): AccountHolding {
  const qty = opts.qty ?? 1;
  const price = opts.price ?? 10_000;
  const currency = opts.currency ?? "KRW";
  return {
    code,
    name,
    quantity: qty,
    avgPrice: price,
    quote: { currency, price, change, changeRate: Math.round((change / (price - change)) * 10000) / 100, fxRate: currency === "USD" ? (opts.fx ?? null) : null },
    evaluation: { marketValue: price * qty, costBasis: price * qty, profit: 0, profitRate: 0, costRate: null, afterCost: null, costBasisKrw: null, krwCostSource: null },
  };
}

function dataFrom(list: AccountHolding[], over: Partial<AccountData> = {}): AccountData {
  const idx = [
    { code: "KOSPI", name: "코스피", kind: "index", value: 3412.35, change: -27.5, changeRate: -0.8, open: false, asOf: null },
    { code: "NASDAQ", name: "나스닥", kind: "index", value: 21234.5, change: 74.1, changeRate: 0.35, open: false, asOf: null },
    fixture.usdKrw,
  ] as MarketIndex[];
  const { rows, missing } = pickIndices(idx);
  return {
    version: 1,
    session: "afternoon",
    date: "2026-09-25",
    asOf: "2026-09-25T16:05:00+09:00",
    basis: "기준",
    ...computeAccount(list, { usdKrw: fixture.usdKrw }),
    indices: rows,
    missingIndices: missing,
    schedule: buildSchedule(null, new Date("2026-09-25T16:05:00+09:00"), []),
    narrative: { source: "template", reason: null },
    ...over,
  };
}

describe("계좌 숫자 (순수 계산)", () => {
  it("공용 픽스처: 총 평가·매입·손익·당일 손익이 앱 잔고 합계(비용 차감 기본값)와 같다", () => {
    const a = computeAccount(fixture.holdings, { usdKrw: fixture.usdKrw });
    expect(a).toMatchObject({ afterCost: true, holdings: 7, totalValue: fixture.expected.totalValue, totalCost: fixture.expected.totalCost, totalProfit: fixture.expected.totalProfit, dayPnl: fixture.expected.dayPnl });
    expect(a.markets.us!.value).toBe(fixture.expected.usdValue);
    within1(a.markets.us!.day, fixture.expected.usdDay);
    expect(a.excluded).toEqual([]); // 관심 종목(현대차)은 보유가 아니라 빠질 뿐 excluded 가 아니다
  });

  it("기여 상위 5 + 그 외 N종목의 합 = 당일 손익 (±1원), |기여| 큰 순, 국내 + 미국 = 계좌", () => {
    const a = computeAccount(fixture.holdings, { usdKrw: fixture.usdKrw });
    expect(a.contributions).toHaveLength(5);
    expect(a.others).toEqual({ count: 2, amount: expect.any(Number) });
    within1(sumOf(a.contributions.map((c) => c.amount)) + a.others!.amount, a.dayPnl);
    expect(sumOf(a.contributions.map((c) => c.amount)) + a.others!.amount).toBe(a.dayPnl); // 실제로는 정확히 같다
    expect(a.contributions[0]).toMatchObject({ code: "RGTX", name: "리게티 컴퓨팅", currency: "USD", changeRate: -8.06 });
    const sizes = a.contributions.map((c) => Math.abs(c.amount));
    expect([...sizes].sort((x, y) => y - x)).toEqual(sizes);
    expect(a.markets.kr!.day + a.markets.us!.day).toBe(a.dayPnl);
    expect(a.dayRate).not.toBeNull();
  });

  it("작은 조각이 많아 반올림이 쌓여도 합이 맞는다 (0.4원 × 7종목 → 3원)", () => {
    const list = Array.from({ length: 7 }, (_, i) => holding(`00000${i}`, `종목${i}`, 0.4));
    const a = computeAccount(list);
    expect(a.dayPnl).toBe(3);
    expect(sumOf(a.contributions.map((c) => c.amount)) + a.others!.amount).toBe(3);
    expect(a.contributions.every((c) => c.amount === 0 || c.amount === 1)).toBe(true);
  });

  it("나누기(최대 나머지): 합 = 목표, 각 값은 내림 또는 올림 — 무작위 200회", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let n = 0; n < 200; n++) {
      const values = Array.from({ length: 1 + (n % 17) }, () => rnd() * 1_000_000);
      const out = apportion(values);
      expect(sumOf(out)).toBe(Math.round(sumOf(values)));
      out.forEach((v, i) => expect(v === Math.floor(values[i]!) || v === Math.ceil(values[i]!)).toBe(true));
    }
    expect(apportion([])).toEqual([]);
    expect(apportion([1.5, 1.5], 2)).toEqual([1, 1]);
  });

  it("환율 효과: 가격 효과 + 환율 효과 = 미국 보유분 원화 변화 (±1원), 가격 효과 = 당일 손익의 미국 몫", () => {
    const a = computeAccount(fixture.holdings, { usdKrw: fixture.usdKrw });
    expect(a.fx.status).toBe("computed");
    expect(a.fx.priceEffect).toBe(a.markets.us!.day);
    within1(a.fx.priceEffect! + a.fx.fxEffect!, a.fx.usdHoldingsKrwChange!);
    // 환율 효과 = 전일 달러 평가액 × 원/달러 변동 (5.2원)
    const prevUsd = sumOf(fixture.holdings.filter((h) => h.quote?.currency === "USD").map((h) => (h.quote!.price - h.quote!.change) * h.quantity!));
    within1(a.fx.fxEffect!, prevUsd * 5.2);
    expect(a.fx.usdKrw).toEqual({ value: 1391, change: 5.2, changeRate: 0.38, stale: false });
    expect(a.fx.appliedRate).toBe(1391.5);

    // 여러 경우에도 합이 맞는다 (환율 하락·종목 하락 섞임)
    for (const d of [-12.3, -0.1, 0, 3.7, 20]) {
      const list = [holding("A", "가", -1.23, { currency: "USD", qty: 37, price: 88.8, fx: 1380.25 }), holding("B", "나", 0.77, { currency: "USD", qty: 3.5, price: 412.1, fx: 1380.25 }), holding("005930", "다", 500, { qty: 11 })];
      const r = computeAccount(list, { usdKrw: { ...fixture.usdKrw, change: d } }).fx;
      within1(r.priceEffect! + r.fxEffect!, r.usdHoldingsKrwChange!);
    }
  });

  it("환율 효과를 계산할 수 없으면 이유를 남긴다: 미국 종목 없음 / 원/달러 변동 없음, 환율 없는 미국 종목·시세 없는 보유 종목은 합계에서 뺀다", () => {
    expect(computeAccount([holding("005930", "삼성전자", 100)], { usdKrw: fixture.usdKrw }).fx).toMatchObject({ status: "none", fxEffect: null });
    const noIdx = computeAccount([holding("NVDA", "엔비디아", 1, { currency: "USD", price: 100, fx: 1390 })], { usdKrw: null });
    expect(noIdx.fx).toMatchObject({ status: "unavailable", priceEffect: null, fxEffect: null, appliedRate: 1390 });
    expect(noIdx.fx.reason).toContain("계산하지 못했습니다");
    const missing = { ...holding("005930", "삼성전자", 100), quote: null, evaluation: null };
    const a = computeAccount([holding("TSLA", "테슬라", 5, { currency: "USD", price: 260, fx: null }), missing, holding("000660", "SK하이닉스", 1000)]);
    expect(a.excluded.map((e) => [e.code, e.reason])).toEqual([
      ["TSLA", "환율을 받지 못해 원화 합계에서 뺐습니다"],
      ["005930", "시세를 받지 못해 합계에서 뺐습니다"],
    ]);
    expect(a).toMatchObject({ holdings: 1, dayPnl: 1000 });
  });

  it("오늘 일정: 한국 휴장(다음 개장), 미국 정규장을 한국 시간으로 (서머타임·겨울·휴장일)", () => {
    const status = (krTrading: boolean, opensAt: string | null): MarketStatus => ({
      now: "",
      KR: { market: "KR", isTradingDay: krTrading, isOpen: false, opensAt, closesAt: null, source: "toss" },
      US: { market: "US", isTradingDay: true, isOpen: false, opensAt: null, closesAt: null, source: "toss" },
    });
    const s = buildSchedule(status(false, "2026-09-28T23:00:00.000Z"), new Date("2026-09-25T08:30:00+09:00"), []);
    expect(s.kr).toMatchObject({ date: "2026-09-25", tradingDay: false, hours: null, nextOpen: "2026-09-28T23:00:00.000Z" });
    expect(s.us).toMatchObject({ date: "2026-09-25", tradingDay: true, hours: "정규장 9/25 22:30~9/26 05:00 (한국 시간)" });
    // 오후(뉴욕 새벽 3시)도 같은 날 밤 정규장
    expect(usSessionDate(new Date("2026-09-25T16:00:00+09:00"))).toBe("2026-09-25");
    // 한국 새벽 2시(뉴욕 정규장 진행 중)는 그 정규장
    expect(usSessionDate(new Date("2026-09-26T02:00:00+09:00"))).toBe("2026-09-25");
    expect(usRegularKst("2026-12-01")).toBe("정규장 12/1 23:30~12/2 06:00 (한국 시간)");
    const thanksgiving = buildSchedule(status(true, null), new Date("2026-11-26T16:00:00+09:00"), []);
    expect(thanksgiving.us).toMatchObject({ date: "2026-11-26", tradingDay: false, hours: null });
    expect(thanksgiving.kr).toMatchObject({ tradingDay: true, hours: "정규장 09:00~15:30 · 넥스트레이드 08:00~20:00" });
  });

  it("사실 목록과 기본 문장: 기본 문장의 숫자는 모두 사실 안에 있다, 요약 두 줄", () => {
    const d = dataFrom(fixture.holdings);
    const facts = factsText(d);
    expect(facts).toContain(`당일 손익: -250,267원`);
    expect(facts).toContain("1. 리게티 컴퓨팅: ");
    expect(facts).toContain(`그 외 2종목: `);
    expect(facts).toContain("환율 효과는 당일 손익에 넣지 않음");
    expect(facts).toContain("받지 못한 지수: 코스닥, S&P500");
    expect(checkNarrative(templateNarrative(d), facts)).toEqual({ ok: true });
    const top = d.contributions[0]!;
    expect(summaryText(d)).toBe(`당일 -250,267원 (${d.dayRate! > 0 ? "+" : ""}${d.dayRate!.toFixed(2)}%) · 기여 1위 리게티 컴퓨팅 ${top.amount.toLocaleString("ko-KR")}원\n총 평가금액 9,157,673원 · 환율 효과 +${d.fx.fxEffect!.toLocaleString("ko-KR")}원`);
    // 미국 종목이 없으면 환율 효과 줄이 없다
    expect(summaryText(dataFrom([holding("005930", "삼성전자", 100, { qty: 3 })]))).toBe("당일 +300원 (+1.01%) · 기여 1위 삼성전자 +300원\n총 평가금액 30,000원");
  });

  it("모델 설명 검사: 사실에 없는 숫자·매매·전망 표현은 거절, 순서 같은 작은 정수와 표기 그대로 옮긴 숫자는 통과", () => {
    const facts = "- 당일 손익: -2,868,108원 (-1.23%)\n- 1. RGTX: -1,234,567원 (등락률 -8.10%)\n- 코스피 3,412.35 (-0.80%)";
    expect(numbersIn("-2,868,108원 과 1.23%")).toEqual([2868108, 1.23]);
    expect(checkNarrative("- 당일 손익은 -2,868,108원(-1.23%)입니다.\n- 1위는 RGTX(-1,234,567원, -8.10%)입니다.\n- 코스피는 -0.80%였습니다.", facts)).toEqual({ ok: true });
    expect(checkNarrative("- 당일 손익은 약 287만 원입니다.", facts)).toEqual({ ok: false, reason: "입력에 없는 숫자: 287" });
    expect(checkNarrative("- RGTX 는 -1.2% 내렸습니다.", facts)).toMatchObject({ ok: false });
    expect(checkNarrative("- RGTX 비중을 줄이고 매도를 고려할 만합니다.", facts)).toEqual({ ok: false, reason: "쓰지 않는 표현: 매도" });
    expect(checkNarrative("- 내일은 반등 전망입니다.", facts)).toMatchObject({ ok: false });
    expect(checkNarrative("  ", facts)).toEqual({ ok: false, reason: "빈 응답" });
  });

  it("알림 묶음: 계좌 요약이 앞머리, 종목 브리핑 줄은 그 아래, 누르면 계좌 브리핑 (예전 앱은 digest 로 브리핑 탭)", () => {
    const items = [
      { briefingId: 11, code: "RGTX", name: "리게티 컴퓨팅", summary: "요약", changeRate: -8.1 },
      { briefingId: 12, code: "005930", name: "삼성전자", summary: "요약", changeRate: 1.2 },
      { briefingId: 13, code: "000660", name: "SK하이닉스", summary: "요약", changeRate: null },
    ];
    const account = { id: 7, dayPnl: -2_868_108, dayRate: -1.23, top: [{ name: "RGTX", amount: -1_234_567 }, { name: "삼성전자", amount: -456_789 }, { name: "셋째", amount: 1 }] };
    const m = buildDigest("morning", "2026-09-25", items, account)!;
    expect(m.title).toBe("오전 계좌 브리핑 · 당일 -2,868,108원 (-1.23%)");
    expect(m.body).toBe("기여 1위 RGTX -1,234,567원 · 2위 삼성전자 -456,789원\n종목 브리핑 3종목 · 변동 상위 리게티 컴퓨팅 -8.10% · 삼성전자 +1.20%");
    expect(m.data).toEqual({ type: "briefing", digest: true, session: "morning", date: "2026-09-25", count: 3, accountBriefingId: 7, briefingId: 11, code: "RGTX" });
    // 종목 브리핑이 없어도 계좌 브리핑만으로 1건
    const only = buildDigest("afternoon", "2026-09-25", [], { ...account, dayPnl: 12_000, dayRate: null, top: [{ name: "애플", amount: 12_000 }] })!;
    expect(only).toEqual({ title: "오후 계좌 브리핑 · 당일 +12,000원", body: "기여 1위 애플 +12,000원", data: { type: "briefing", digest: true, session: "afternoon", date: "2026-09-25", count: 0, accountBriefingId: 7 } });
    // 계좌 브리핑이 없으면 예전 그대로
    expect(buildDigest("morning", "2026-09-25", items, null)!.title).toBe("오전 브리핑 3종목");
  });
});

describe("prompts/account_briefing.md", () => {
  it("시스템+사용자 구조이고 사실(facts)을 넣으며, 매매 지시 금지·숫자 지어내기 금지 규칙이 있다", async () => {
    const p = await new PromptStore().load("account_briefing");
    expect(p.system.length).toBeGreaterThan(100);
    expect(p.userTemplate).toContain("{{facts}}");
    expect(p.userTemplate).toContain("{{date}}");
    expect(p.system).toMatch(/매수\/매도[^\n]*금지/);
    expect(p.system).toContain("새 숫자를 만들지 않");
    expect(p.system).toContain("예측하거나 전망하지 않습니다");
  });
});

// ── 서버에서 ────────────────────────────────────────────────

class FakePush implements PushSender {
  readonly name = "fake-push";
  sent: PushMessage[] = [];
  isValidToken(token: string): boolean {
    return token.startsWith("ExponentPushToken[");
  }
  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    return { results: tokens.map((token) => ({ token, ok: true, error: null, receiptId: null })) };
  }
  async checkReceipts() {
    return [];
  }
}

/** 국내 2종목 + 애플(달러). 등락을 종목마다 다르게 */
class MixedQuotes implements QuoteProvider {
  readonly name = "mixed";
  calls = 0;
  private readonly spec: Record<string, { currency: "KRW" | "USD"; price: number; change: number; fxRate?: number }> = {
    "000660": { currency: "KRW", price: 231_000, change: 4_500 },
    "005930": { currency: "KRW", price: 71_500, change: -1_200 },
    "247540": { currency: "KRW", price: 150_000, change: 0 },
    AAPL: { currency: "USD", price: 201.5, change: -3.25, fxRate: 1391.5 },
  };
  async getQuote(code: string): Promise<Quote> {
    this.calls++;
    const s = this.spec[code] ?? { currency: "KRW" as const, price: 10_000, change: 0 };
    return {
      code, currency: s.currency, price: s.price, change: s.change, changeRate: Math.round((s.change / (s.price - s.change)) * 10000) / 100, open: null, high: null, low: null, prevClose: s.price - s.change,
      volume: null, marketCap: null, per: null, pbr: null, eps: null, bps: null, high52w: null, low52w: null, asOf: "2026-09-25T15:30:00+09:00", source: "mixed", ...(s.fxRate ? { fxRate: s.fxRate } : {}),
    };
  }
  async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    const candles = Array.from({ length: count }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), open: 100, high: 110, low: 90, close: 100 + (i % 5), volume: 1000 }));
    return { code, period, candles, source: this.name };
  }
}

/** 종목 브리핑은 평범하게, 계좌 브리핑은 사실에서 숫자를 그대로 옮겨(또는 지어내어) 답하는 가짜 모델 */
class AccountGen implements TextGenerator {
  model = "fake-model";
  requests: GenerateRequest[] = [];
  mode: "copy" | "invent" | "fail" = "copy";
  failStocks = false;
  gate: Promise<void> | null = null;
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const label = req.label ?? "";
    const done = (text: string): GenerateResult => ({ text, model: this.model, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "end_turn" });
    if (label === "account_briefing") {
      if (this.gate) await this.gate;
      if (this.mode === "fail") throw new GenerationError("가짜 실패", "api");
      if (this.mode === "invent") return done("- 당일 손익은 약 12만 원입니다.");
      const day = req.user.match(/당일 손익: ([^\n]+)/)?.[1] ?? "";
      const top = req.user.match(/ {2}1\. ([^\n]+)/)?.[1] ?? "";
      return done(`- 오늘 계좌의 당일 손익은 ${day}입니다.\n- 가장 크게 움직인 종목은 ${top}입니다.\n- 환율 효과는 당일 손익과 따로 봅니다.`);
    }
    if (this.failStocks) throw new GenerationError("가짜 실패", "api");
    return done(label.startsWith("briefing_summary") ? "주가 한 줄\n뉴스 한 줄\n볼 것 한 줄" : "## 상세\n본문");
  }
}

/** 두 시장 모두 휴장인 날 */
const closed = (market: "KR" | "US") => ({ market, isTradingDay: false, isOpen: false, opensAt: "2026-09-28T23:00:00.000Z", closesAt: null, source: "toss" as const });
const holidayCalendar = { status: async (): Promise<MarketStatus> => ({ now: "", KR: closed("KR"), US: closed("US") }), isTradingDay: async () => false };

const AAPL: ListedStock = { code: "AAPL", name: "애플", market: "NASDAQ", isinCode: null, groupCode: null };
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

describe("계좌 브리핑 (서버)", () => {
  let app: FastifyInstance;
  let db: Db;
  afterEach(async () => {
    await app?.close();
    await db?.destroy();
  });

  const setup = async (o: { at?: string; gen?: AccountGen; holdings?: boolean; disabledModel?: boolean; holiday?: boolean } = {}) => {
    db = await createMigratedDb(":memory:");
    const push = new FakePush();
    const gen = o.gen ?? new AccountGen();
    if (o.disabledModel) gen.model = "disabled";
    const quotes = new MixedQuotes();
    const indices = fakeIndices(fakeIndexSource({ fx: { close: "1,391.00", change: "5.20", rate: "0.38" } }), () => new Date(o.at ?? "2026-09-25T16:05:00+09:00"));
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ push, generator: gen, quotes, indices, search: new FakeSearchProvider([AAPL]), ...(o.holiday ? { calendar: holidayCalendar as never } : {}) }),
      logger: false,
      receiptDelayMs: 0,
      now: () => new Date(o.at ?? "2026-09-25T16:05:00+09:00"),
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    const h = o.holdings !== false;
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660", ...(h ? { quantity: 3, avgPrice: 250_000 } : {}) } });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930", ...(h ? { quantity: 10, avgPrice: 70_000 } : {}) } });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "AAPL", ...(h ? { quantity: 4, avgPrice: 190 } : {}) } });
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN, platform: "android" } });
    return { push, gen, quotes, indices };
  };
  const accountCalls = (gen: AccountGen) => gen.requests.filter((r) => r.label === "account_briefing").length;
  const list = async () => (await app.inject({ method: "GET", url: "/api/account-briefings" })).json() as Array<{ id: number; session: string; date: string; status: string; summary: string; template: boolean; model: string; headline: { dayPnl: number; totalValue: number; top: Array<{ name: string; amount: number }> } }>;

  it("예약 실행이 끝나면 계좌 브리핑 1건, 세션 알림은 1건이고 앞머리가 계좌 요약, 누르면 계좌 브리핑", async () => {
    const { push, gen } = await setup();
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    const items = await list();
    expect(items).toHaveLength(1);
    const b = items[0]!;
    // 삼성전자 -1,200×10 + SK하이닉스 +4,500×3 + 애플 -3.25×4×1391.5 = -12,000 + 13,500 - 18,089.5 = -16,589.5 → -16,589원.
    // 나눌 때 반올림 몫 1원이 애플로 가서 애플 -18,089원 (국내 +1,500 + 미국 -18,089 = -16,589)
    expect(b).toMatchObject({ date: "2026-09-25", session: "afternoon", status: "ok", template: false, model: "fake-model" });
    expect(b.headline.dayPnl).toBe(Math.round(-12_000 + 13_500 - 3.25 * 4 * 1391.5));
    expect(b.headline.top[0]).toMatchObject({ name: "애플" });
    expect(b.summary.split("\n")[0]).toBe(`당일 -16,589원 (-0.65%) · 기여 1위 애플 -18,089원`);

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.title).toBe("오후 계좌 브리핑 · 당일 -16,589원 (-0.65%)");
    expect(push.sent[0]!.body).toBe("기여 1위 애플 -18,089원 · 2위 SK하이닉스 +13,500원\n종목 브리핑 3종목 · 변동 상위 SK하이닉스 +1.99% · 삼성전자 -1.65%");
    expect(push.sent[0]!.data).toMatchObject({ type: "briefing", digest: true, count: 3, accountBriefingId: b.id });
    expect(accountCalls(gen)).toBe(1);

    const detail = (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json();
    const d = detail.data as AccountData;
    expect(d.contributions.reduce((a, c) => a + c.amount, 0) + (d.others?.amount ?? 0)).toBe(d.dayPnl);
    expect(d.fx.status).toBe("computed");
    within1(d.fx.priceEffect! + d.fx.fxEffect!, d.fx.usdHoldingsKrwChange!);
    expect(d.indices.map((i) => i.code)).toEqual(["KOSPI", "KOSDAQ", "NASDAQ", "SPX"]);
    expect(d.schedule.us.hours).toBe("정규장 9/25 22:30~9/26 05:00 (한국 시간)");
    expect(detail.detail).toBe("- 오늘 계좌의 당일 손익은 -16,589원 (-0.65%)입니다.\n- 가장 크게 움직인 종목은 애플: -18,089원 (등락률 -1.59%)입니다.\n- 환율 효과는 당일 손익과 따로 봅니다.");
    // 모델에게는 계산한 숫자와 금지 규칙을 준다
    const req = gen.requests.find((r) => r.label === "account_briefing")!;
    expect(req.user).toContain("당일 손익: -16,589원");
    expect(req.system).toMatch(/매수\/매도[^\n]*금지/);
    expect((await app.inject({ method: "GET", url: "/api/account-briefings/999" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/account-briefings?limit=0" })).statusCode).toBe(400);
  });

  it("다시 실행: 이미 있으면 건너뛰고(알림·모델 호출 없음), 수동 전체 실행(force)은 덮어쓰고 알림 1건, 일부 종목 실행은 만들지 않는다", async () => {
    const { push, gen } = await setup();
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    const first = (await list())[0]!;
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    expect(push.sent).toHaveLength(1);
    expect(accountCalls(gen)).toBe(1);
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", codes: ["005930"], force: true } });
    expect(accountCalls(gen)).toBe(1);
    expect(push.sent).toHaveLength(1);
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", force: true } });
    expect(accountCalls(gen)).toBe(2);
    expect(push.sent).toHaveLength(2);
    const again = await list();
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(first.id); // 날짜·세션마다 1건 (덮어쓰기)
    expect(push.sent[1]!.data).toMatchObject({ accountBriefingId: first.id });
  });

  it("모델이 입력에 없는 숫자를 쓰거나, 실패하거나, 없으면 기본 문장으로 저장한다 (실패 아님)", async () => {
    const gen = new AccountGen();
    gen.mode = "invent";
    await setup({ gen });
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    let b = (await list())[0]!;
    expect(b).toMatchObject({ status: "ok", template: true, model: "template" });
    let d = (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json();
    expect(d.data.narrative).toEqual({ source: "template", reason: "입력에 없는 숫자: 12" });
    expect(d.detail).toContain("당일 손익은 -16,589원");
    expect(d.detail).not.toContain("12만");

    gen.mode = "fail";
    await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon", force: true } });
    b = (await list())[0]!;
    d = (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json();
    expect(b).toMatchObject({ status: "ok", template: true });
    expect(d.data.narrative.reason).toMatch(/^모델 호출 실패/);
  });

  it("모델 키가 없으면 모델을 부르지 않고 기본 문장", async () => {
    const { gen } = await setup({ disabledModel: true });
    await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "morning" } });
    expect(accountCalls(gen)).toBe(0);
    expect((await list())[0]).toMatchObject({ status: "ok", template: true, session: "morning" });
  });

  it("종목 브리핑이 모두 실패해도(모델 장애) 계좌 브리핑은 기본 문장으로 만들고 알림 1건", async () => {
    const gen = new AccountGen();
    gen.failStocks = true;
    gen.mode = "fail";
    const { push } = await setup({ gen });
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    const b = (await list())[0]!;
    expect(b).toMatchObject({ status: "ok", template: true });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.title).toMatch(/^오후 계좌 브리핑 · 당일 /);
    expect(push.sent[0]!.data).toEqual({ type: "briefing", digest: true, session: "afternoon", date: "2026-09-25", count: 0, accountBriefingId: b.id });
  });

  it("두 시장 모두 휴장이라 모든 종목을 건너뛴 예약 실행은 계좌 브리핑·알림 0, 수동 전체 실행(force)은 만든다", async () => {
    const { push, gen } = await setup({ holiday: true });
    const r = await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    expect(r.results.every((x) => x.status === "skipped")).toBe(true);
    expect(await list()).toEqual([]);
    expect(accountCalls(gen)).toBe(0);
    expect(push.sent).toHaveLength(0);
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", force: true } });
    expect(await list()).toHaveLength(1);
    const d = (await app.inject({ method: "GET", url: `/api/account-briefings/${(await list())[0]!.id}` })).json().data as AccountData;
    expect(d.schedule.kr).toMatchObject({ tradingDay: false, hours: null, nextOpen: "2026-09-28T23:00:00.000Z" });
  });

  it("보유 종목이 없으면 만들지 않고 알림은 예전 그대로", async () => {
    const { push, gen } = await setup({ holdings: false });
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    expect(await list()).toEqual([]);
    expect(accountCalls(gen)).toBe(0);
    expect(push.sent.map((m) => m.title)).toEqual(["오후 브리핑 3종목"]);
  });

  it("플래그를 끄면: 생성·모델 호출·지수 조회 0, 알림은 예전 문구, 설정 응답에 accountBriefing:false, 수동 실행은 409", async () => {
    const { push, gen, indices } = await setup();
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accountBriefing: false } });
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    expect(await list()).toEqual([]);
    expect(accountCalls(gen)).toBe(0);
    expect(indices.calls).toBe(0);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.title).toBe("오후 브리핑 3종목");
    expect(push.sent[0]!.data).not.toHaveProperty("accountBriefingId");
    expect((await app.inject({ method: "GET", url: "/api/notifications/settings" })).json()).toMatchObject({ digest: true, accountBriefing: false });
    expect((await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon" } })).statusCode).toBe(409);
    // 켜면 설정 응답이 알려 준다 (앱 백그라운드 알림이 같은 규칙을 쓰게)
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accountBriefing: true } });
    expect((await app.inject({ method: "GET", url: "/api/notifications/settings" })).json()).toMatchObject({ accountBriefing: true });
  });

  it("계좌 브리핑을 만드는 동안은 실행 중(running)으로 보여 앱 백그라운드 알림이 기다린다", async () => {
    const gen = new AccountGen();
    let release!: () => void;
    gen.gate = new Promise((r) => (release = r));
    await setup({ gen });
    const run = app.briefingService.runSession("afternoon", { trigger: "schedule" });
    await expect.poll(() => accountCalls(gen)).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/notifications/settings" })).json().running).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon" } })).statusCode).toBe(409);
    release();
    await run;
    expect((await app.inject({ method: "GET", url: "/api/notifications/settings" })).json().running).toBe(false);
  });

  it("공시는 종목 브리핑이 받아 둔 것만 쓴다 (최근 3일, DART 를 새로 부르지 않음)", async () => {
    await setup();
    const snap = (d: Array<{ title: string; filedAt: string }>) => JSON.stringify({ disclosures: d.map((x, i) => ({ receiptNo: String(i), filer: "삼성전자", url: `https://dart.fss.or.kr/${i}`, ...x })) });
    const row = { session: "morning", briefing_date: "2026-09-25", status: "ok", summary: "s", detail: "d", missing_data: "[]", model: "m", error: null, created_at: "2026-09-25T08:40:00+09:00" };
    await db.insertInto("briefings").values({ ...row, code: "005930", data_snapshot: snap([{ title: "분기보고서 (2026.06)", filedAt: "2026-09-24" }, { title: "옛 공시", filedAt: "2026-09-18" }]) }).execute();
    await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon" } });
    const b = (await list())[0]!;
    const d = (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json().data as AccountData;
    expect(d.schedule.disclosures).toEqual([{ code: "005930", name: "삼성전자", title: "분기보고서 (2026.06)", filedAt: "2026-09-24", url: "https://dart.fss.or.kr/0" }]);
  });
});
