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
import { MarketCalendar, type MarketStatus } from "../src/providers/market/calendar.js";
import type { MarketIndex } from "../src/providers/market/indices.js";
import type { QuoteProvider } from "../src/providers/market/types.js";
import {
  apportion,
  BASIS,
  buildSchedule,
  checkNarrative,
  computeAccount,
  factsText,
  KR_PREVIOUS_DAY_NOTE,
  leaders,
  numberTokens,
  pickIndices,
  summaryText,
  templateNarrative,
  US_PREVIOUS_DAY_NOTE,
  usLastSessionDate,
  usPreviousDay,
  usRegularKst,
  usSessionDate,
  type AccountData,
  type AccountHolding,
} from "../src/services/accountNumbers.js";
import { FakeSearchProvider, fakeIndexSource, fakeIndices, fakeProviders, SAMPLE_MASTER } from "./helpers.js";

/**
 * 계좌 한 장 브리핑 (3-31).
 *  - 숫자: 앱 잔고 합계와 같은 기준, 기여 상위 + 그 외 = 당일 손익 (정확히), 가격 효과 + 환율 효과 = 미국 보유분 원화 변화 (정확히)
 *  - 설명: 모델이 입력에 없는 숫자(값·단위·부호)나 권유·전망 표현을 쓰면 기본 문장, 모델이 없거나 실패해도 기본 문장으로 저장(실패 아님)
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

  it("환율 효과: 가격 효과 + 환율 효과 = 미국 보유분 원화 변화 (정확히), 가격 효과 = 당일 손익의 미국 몫", () => {
    const a = computeAccount(fixture.holdings, { usdKrw: fixture.usdKrw });
    expect(a.fx.status).toBe("computed");
    expect(a.fx.priceEffect).toBe(a.markets.us!.day);
    expect(a.fx.priceEffect! + a.fx.fxEffect!).toBe(a.fx.usdHoldingsKrwChange!);
    // 환율 효과 = 전일 달러 평가액 × 원/달러 변동 (5.2원)
    const prevUsd = sumOf(fixture.holdings.filter((h) => h.quote?.currency === "USD").map((h) => (h.quote!.price - h.quote!.change) * h.quantity!));
    within1(a.fx.fxEffect!, prevUsd * 5.2);
    expect(a.fx.usdKrw).toEqual({ value: 1391, change: 5.2, changeRate: 0.38, stale: false });
    expect(a.fx.appliedRate).toBe(1391.5);

    // 여러 경우에도 합이 맞는다 (환율 하락·종목 하락 섞임)
    for (const d of [-12.3, -0.1, 0, 3.7, 20]) {
      const list = [holding("A", "가", -1.23, { currency: "USD", qty: 37, price: 88.8, fx: 1380.25 }), holding("B", "나", 0.77, { currency: "USD", qty: 3.5, price: 412.1, fx: 1380.25 }), holding("005930", "다", 500, { qty: 11 })];
      const r = computeAccount(list, { usdKrw: { ...fixture.usdKrw, change: d } }).fx;
      expect(r.priceEffect! + r.fxEffect!).toBe(r.usdHoldingsKrwChange!);
    }
  });

  it("환율 효과 등식: 무작위 달러 포트폴리오 5000개 모두 '변화 = 가격 효과 + 환율 효과'가 정확하고, 반올림 전 원래 변화와 1.5원 안", () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 0; n < 5000; n++) {
      const fx = 1300 + rnd() * 150;
      const d = (rnd() - 0.5) * 30;
      const list = Array.from({ length: 1 + (n % 6) }, (_, i) => {
        const price = 5 + rnd() * 500;
        return holding(`U${i}`, `미국${i}`, (rnd() - 0.5) * price * 0.2, { currency: "USD", qty: Math.round(rnd() * 3000) / 100, price, fx });
      });
      list.push(holding("005930", "삼성전자", Math.round((rnd() - 0.5) * 4000), { qty: 1 + (n % 13) }));
      const r = computeAccount(list, { usdKrw: { ...fixture.usdKrw, change: d } }).fx;
      expect(r.priceEffect! + r.fxEffect!).toBe(r.usdHoldingsKrwChange!);
      const us = list.filter((h) => h.quote!.currency === "USD");
      const raw = us.reduce((a, h) => a + h.quote!.price * h.quantity! * fx - (h.quote!.price - h.quote!.change) * h.quantity! * (fx - d), 0);
      expect(Math.abs(r.usdHoldingsKrwChange! - raw)).toBeLessThanOrEqual(1.5);
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
    // 등락을 모르는 종목(빈 값)은 당일 0 으로, 합계가 NaN 이 되지 않는다
    const noChange = holding("035420", "NAVER", 100);
    const b = computeAccount([{ ...noChange, quote: { ...noChange.quote!, change: Number.NaN } }, holding("000660", "SK하이닉스", 1000)]);
    expect(b).toMatchObject({ holdings: 2, dayPnl: 1000 });
    expect(b.contributions.map((c) => c.amount)).toEqual([1000, 0]);
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
    expect(facts).toContain("- 날짜: 2026-09-25 오후 브리핑");
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

  it("기본 문장의 기여 줄: 표·사실과 같은 줄(상위 5 + 그 외)을 모두 적고, 적은 금액의 합 = 당일 손익 (4·5위가 빠지지 않는다)", () => {
    const amounts = (text: string) => {
      const line = text.split("\n").find((l) => l.startsWith("- 기여 순서: "))!;
      return [...line.matchAll(/([+-]?)([\d,]+)원/g)].map((m) => (m[1] === "-" ? -1 : 1) * Number(m[2]!.replace(/,/g, "")));
    };
    const d = dataFrom(fixture.holdings);
    const t = templateNarrative(d);
    expect(t).toContain("- 기여 순서: 리게티 컴퓨팅 -268,838원, 엔비디아 +39,240원, NAVER -17,500원, SK하이닉스 +13,500원, 삼성전자 -12,000원, 그 외 2종목 -4,669원.");
    expect(sumOf(amounts(t))).toBe(d.dayPnl);
    // 17종목 계좌도 (상위 5 + 그 외 12종목) 합이 맞는다
    const many = Array.from({ length: 17 }, (_, i) => holding(`0000${String(i).padStart(2, "0")}`, `종목${i}`, (i % 2 ? 1 : -1) * (137 + i * 91.3), { qty: 3 + i }));
    const dm = dataFrom(many);
    const tm = templateNarrative(dm);
    expect(tm).toContain(`그 외 12종목 `);
    expect(amounts(tm)).toHaveLength(6);
    expect(sumOf(amounts(tm))).toBe(dm.dayPnl);
    expect(checkNarrative(tm, factsText(dm))).toEqual({ ok: true });
  });

  it("한국 휴장일: 국내 등락이 직전 거래일 것임을 요약 셋째 줄·사실·기본 문장에 밝힌다", () => {
    const d = dataFrom(fixture.holdings, { krPreviousDay: true });
    expect(summaryText(d).split("\n")).toHaveLength(3);
    expect(summaryText(d).split("\n")[2]).toBe(KR_PREVIOUS_DAY_NOTE);
    expect(factsText(d)).toContain("오늘 한국은 휴장이라 국내 종목의 등락률과 당일 손익은 직전 거래일 것입니다");
    expect(templateNarrative(d)).toContain("오늘 한국은 휴장이라 국내 종목의 당일 손익은 직전 거래일 등락입니다");
    expect(checkNarrative(templateNarrative(d), factsText(d))).toEqual({ ok: true });
    expect(summaryText(dataFrom(fixture.holdings)).split("\n")).toHaveLength(2);
  });

  it("지난밤 미국 평일 휴장: 오전·오후 모두 표시하고, 주말 뒤(월요일)·평소·미국 종목이 없으면 표시하지 않는다", () => {
    const a = computeAccount(fixture.holdings, { usdKrw: fixture.usdKrw });
    const krOnly = computeAccount([holding("005930", "삼성전자", 100)]);
    // 추수감사절(11/26, 목) 다음 날 오전·오후: 지난밤 정규장이 휴장 → 미국 등락은 11/25 것 (전날 오전 브리핑에 이미 담김)
    expect(usLastSessionDate(new Date("2026-11-27T08:30:00+09:00"))).toBe("2026-11-26");
    expect(usLastSessionDate(new Date("2026-11-27T16:05:00+09:00"))).toBe("2026-11-26");
    expect(usPreviousDay(new Date("2026-11-27T08:30:00+09:00"), a)).toBe(true);
    expect(usPreviousDay(new Date("2026-11-27T16:05:00+09:00"), a)).toBe(true);
    expect(usPreviousDay(new Date("2026-11-27T08:30:00+09:00"), krOnly)).toBe(false);
    // 추수감사절 당일 오전(지난밤 11/25 정규장은 열림)·평소
    expect(usPreviousDay(new Date("2026-11-26T08:30:00+09:00"), a)).toBe(false);
    expect(usPreviousDay(new Date("2026-09-25T08:30:00+09:00"), a)).toBe(false);
    // 독립기념일 대체 휴장(7/3, 금) 다음 날 오전은 표시, 주말 뒤 월요일 오전(지난밤 일요일)은 표시하지 않는다
    expect(usPreviousDay(new Date("2026-07-04T08:30:00+09:00"), a)).toBe(true);
    expect(usPreviousDay(new Date("2026-07-06T08:30:00+09:00"), a)).toBe(false);
    // 요약·사실·기본 문장
    const d = dataFrom(fixture.holdings, { usPreviousDay: true });
    expect(summaryText(d).split("\n")).toEqual([expect.stringMatching(/^당일 /), expect.stringMatching(/^총 평가금액 /), US_PREVIOUS_DAY_NOTE]);
    expect(summaryText({ ...d, krPreviousDay: true }).split("\n").slice(2)).toEqual([KR_PREVIOUS_DAY_NOTE, US_PREVIOUS_DAY_NOTE]);
    expect(factsText(d)).toContain("- 참고: 지난밤 미국은 휴장이라 미국 종목의 등락률과 당일 손익은 직전 거래일 것입니다");
    expect(templateNarrative(d)).toContain("- 지난밤 미국은 휴장이라 미국 종목의 당일 손익은 직전 거래일 등락입니다");
    expect(checkNarrative(templateNarrative(d), factsText(d))).toEqual({ ok: true });
    // 알림 본문에도 한 줄
    const m = buildDigest("morning", "2026-11-27", [], { id: 1, dayPnl: -1000, dayRate: null, top: [{ name: "애플", amount: -1000 }], usPreviousDay: true })!;
    expect(m.body).toBe(`기여 1위 애플 -1,000원\n${US_PREVIOUS_DAY_NOTE}`);
  });

  it("모델 설명 검사: 사실에 없는 숫자·매매·전망 표현은 거절, 순서 같은 작은 정수와 표기 그대로 옮긴 숫자는 통과", () => {
    const facts = "- 당일 손익: -2,868,108원 (-1.23%)\n- 1. RGTX: -1,234,567원 (등락률 -8.10%)\n- 코스피 3,412.35 (-0.80%)";
    const toks = numberTokens("-2,868,108원 과 1.23% · 9/25 22:30 · 3종목");
    expect(toks.tokens.map((t) => [t.kind, t.key || t.value, t.unit, t.sign])).toEqual([
      ["date", "9/25", "", null],
      ["time", "22:30", "", null],
      ["num", 2868108, "원", "-"],
      ["num", 1.23, "%", null],
      ["num", 3, "종목", null],
    ]);
    // 개수는 낱말 그대로, 순위·기간·모르는 접미어·목록 번호·말로 적은 방향
    expect(numberTokens("2위 · 2번째 · 3일 연속 · 4거래일 · 2배 · 8.06% 올랐고").tokens.map((t) => [t.value, t.unit, t.dir])).toEqual([
      [2, "위", 0],
      [2, "번째", 0],
      [3, "기간", 0],
      [4, "?", 0],
      [2, "?", 0],
      [8.06, "%", 1],
    ]);
    expect(numberTokens("- 1. RGTX: -1원\n  2. 애플: +1원").tokens.filter((t) => t.unit === "rank").map((t) => t.value)).toEqual([1, 2]);
    expect(checkNarrative("- 당일 손익은 -2,868,108원(-1.23%)입니다.\n- 1위는 RGTX(-1,234,567원, -8.10%)입니다.\n- 코스피는 -0.80%였습니다.", facts)).toEqual({ ok: true });
    // 부호를 적어 옮기거나 단위를 빼고 옮긴 것, 지수 값 뒤 '포인트'는 통과
    expect(checkNarrative("- 당일 손실은 -2,868,108원(-1.23%)입니다.\n- 코스피는 3,412.35포인트, -0.80% 내렸습니다.", facts)).toEqual({ ok: true });
    // 부호가 붙은 사실(손익·등락률)을 부호 없이 옮기면 거절 — 말로 적은 방향은 낱말 목록이 다 잡지 못한다 (4차 검증)
    expect(checkNarrative("- 당일 손실은 2,868,108원(1.23%)입니다.\n- 코스피는 3,412.35포인트, 0.80% 내렸습니다.", facts)).toEqual({ ok: false, reason: "부호가 빠진 숫자: 2,868,108원, 1.23%, 0.80%" });
    expect(checkNarrative("- 당일 손익은 약 287만 원입니다.", facts)).toEqual({ ok: false, reason: "입력에 없는 숫자: 287만" });
    expect(checkNarrative("- RGTX 는 -1.2% 내렸습니다.", facts)).toMatchObject({ ok: false });
    expect(checkNarrative("- RGTX 비중을 줄이고 매도를 고려할 만합니다.", facts)).toEqual({ ok: false, reason: "쓰지 않는 표현: 비중" });
    expect(checkNarrative("- 내일은 반등 전망입니다.", facts)).toMatchObject({ ok: false });
    expect(checkNarrative("  ", facts)).toEqual({ ok: false, reason: "빈 응답" });
  });

  it("모델 설명 검사 (검증에서 찾은 경우): 부호 뒤집기·반올림한 등락률·장 시간 숫자·틀린 쉼표는 거절", () => {
    const d = dataFrom(fixture.holdings);
    const facts = factsText(d);
    expect(facts).toContain("리게티 컴퓨팅: -268,838원 (등락률 -8.06%)");
    expect(facts).toMatch(/20:00/); // 장 시간에 20 이 있어도
    const cases: Array<[string, string]> = [
      ["- 당일 손익은 +250,267원 이익입니다.", "입력에 없는 숫자: +250,267원"], // 실제 -250,267원
      ["- 리게티 컴퓨팅이 약 8% 내려 가장 크게 기여했습니다.", "입력에 없는 숫자: 8%"], // 실제 -8.06%
      ["- 삼성전자가 1% 하락했습니다.", "입력에 없는 숫자: 1%"], // 10 이하 정수라도 % 가 붙으면 봐주지 않는다 (실제 -1.65%)
      ["- 애플이 3% 하락했습니다.", "입력에 없는 숫자: 3%"],
      ["- 삼성전자가 20% 하락했습니다.", "입력에 없는 숫자: 20%"],
      ["- 코스피가 25% 급락했습니다.", "입력에 없는 숫자: 25%"], // 날짜 9/25 의 25
      ["- 당일 손익은 -250,2670원입니다.", "숫자 표기가 틀림: -250,2670원"],
      ["- 엔비디아는 -39,240원을 보탰습니다.", "입력에 없는 숫자: -39,240원"], // 실제 +39,240원
      ["- 미국 정규장은 23:30에 열립니다.", "입력에 없는 숫자: 23:30"],
      ["- 국내 보유분 4종목이 -15,827%를 기록했습니다.", "입력에 없는 숫자: -15,827%"], // 값은 있어도 단위가 다르면
    ];
    for (const [text, reason] of cases) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    // 사실에 있는 날짜·시각·순서는 통과
    expect(checkNarrative("- 미국 정규장은 9월 25일 22:30(한국 시간)에 열립니다.\n- 1위 리게티 컴퓨팅, 2위 엔비디아이고 그 외 2종목이 있습니다.", facts)).toEqual({ ok: true });
  });

  it("모델 설명 검사 (2차 검증): 지어낸 개수·연속일·순서·모르는 접미어는 거절 — 작은 정수라고 봐주지 않는다", () => {
    const d = dataFrom(fixture.holdings);
    const facts = factsText(d);
    // 사실: 보유 7종목, 그 외 2종목, 국내 4종목·미국 3종목, 기여 순위 1~5, 공시 없음. 6·8·9·10 은 없다
    expect(facts).toContain("보유 7종목");
    expect(facts).toContain("그 외 2종목");
    expect(facts).not.toMatch(/\d일 공시/); // 공시 기간을 숫자로 적지 않는다 ('3일 연속'이 통과하지 않게)
    const cases: Array<[string, string]> = [
      ["- 보유 9종목 가운데 리게티 컴퓨팅이 가장 크게 움직였습니다.", "입력에 없는 숫자: 9종목"],
      ["- 그 외 8종목은 합쳐 -4,669원입니다.", "입력에 없는 숫자: 8종목"],
      ["- 오늘 공시 6건이 나왔습니다.", "입력에 없는 숫자: 6건"],
      ["- 리게티 컴퓨팅 10주가 계좌를 끌어내렸습니다.", "입력에 없는 숫자: 10주"],
      ["- 리게티 컴퓨팅은 4거래일 연속 하락했습니다.", "입력에 없는 숫자: 4거래일"],
      ["- 리게티 컴퓨팅은 4 거래일째 하락했습니다.", "입력에 없는 숫자: 4 거래일째"],
      ["- 이번 주 들어 2번째 급락입니다.", "입력에 없는 숫자: 2번째"],
      ["- 리게티 컴퓨팅은 3일 연속 하락했습니다.", "입력에 없는 숫자: 3일 연속"],
      ["- 리게티 컴퓨팅 손실이 엔비디아 이익의 2배입니다.", "입력에 없는 숫자: 2배입니다"],
      ["- 기여 7위는 없습니다.", "입력에 없는 숫자: 7위"], // 순위는 사실의 기여 순서 번호(1~5)만
    ];
    for (const [text, reason] of cases) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    // 사실에 있는 개수·순위·지수 값은 통과
    for (const text of [
      "- 보유 7종목 가운데 1위는 리게티 컴퓨팅, 5위는 삼성전자입니다.",
      "- 국내 보유분 4종목과 미국 보유분 3종목이 있고, 그 외 2종목은 -4,669원입니다.",
      "- 당일 손익 기여 상위 5종목이 대부분을 차지했습니다.",
      "- 코스피는 3,412.35로 마감했습니다.",
      "- S&P500 지수는 받지 못했습니다.",
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
    // 공시가 있으면 건수가 사실에 들어가 기본 문장의 '최근 공시 N건'이 통과하고, 다른 건수는 거절
    const withDisc = dataFrom(fixture.holdings, { schedule: buildSchedule(null, new Date("2026-09-25T16:05:00+09:00"), [{ code: "005930", name: "삼성전자", title: "분기보고서", filedAt: "2026-09-24", url: null }]) });
    expect(factsText(withDisc)).toContain("최근 공시 1건: ");
    expect(templateNarrative(withDisc)).toContain("최근 공시 1건.");
    expect(checkNarrative(templateNarrative(withDisc), factsText(withDisc))).toEqual({ ok: true });
    expect(checkNarrative("- 최근 공시 2건이 있습니다.", factsText(withDisc))).toEqual({ ok: false, reason: "입력에 없는 숫자: 2건" });
  });

  it("모델 설명 검사 (2차 검증): 부호 없이 말로 방향을 뒤집으면 거절, 사실과 같은 방향은 통과", () => {
    const facts = factsText(dataFrom(fixture.holdings));
    // 사실: 당일 -250,267원 (-2.66%), 리게티 컴퓨팅 -8.06%, 엔비디아 +1.82% · +39,240원, 원/달러 +5.20원
    const cases: Array<[string, string]> = [
      ["- 리게티 컴퓨팅이 8.06% 올랐습니다.", "방향이 사실과 반대: 8.06% 올랐"],
      ["- 리게티 컴퓨팅이 8.06% 올라 가장 크게 기여했습니다.", "방향이 사실과 반대: 8.06% 올라"],
      ["- 당일 손익은 250,267원 이익입니다.", "방향이 사실과 반대: 250,267원 이익"],
      ["- 계좌는 2.66% 상승했습니다.", "방향이 사실과 반대: 2.66% 상승"],
      ["- 엔비디아는 1.82% 하락했습니다.", "방향이 사실과 반대: 1.82% 하락"],
      ["- 엔비디아에서 39,240원 손실이 났습니다.", "방향이 사실과 반대: 39,240원 손실"],
      ["- 리게티 컴퓨팅은 -8.06% 올랐습니다.", "방향이 사실과 반대: -8.06% 올랐"], // 부호를 적어도 말이 반대면
    ];
    for (const [text, reason] of cases) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    // 사실과 같은 방향이라도 부호를 빼고 옮기면 거절 (4차 검증: 방향 낱말 목록에 기대지 않는다)
    for (const [text, reason] of [
      ["- 리게티 컴퓨팅은 8.06% 내려 268,838원 손실을 냈습니다.", "부호가 빠진 숫자: 8.06%, 268,838원"],
      ["- 당일 손실은 250,267원(2.66%)입니다.", "부호가 빠진 숫자: 250,267원, 2.66%"],
    ] as const) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    for (const text of [
      "- 리게티 컴퓨팅은 -8.06% 내려 -268,838원 손실을 냈습니다.",
      "- 당일 손실은 -250,267원(-2.66%)입니다.",
      "- 코스피는 -0.80% 내렸고 나스닥은 +0.35% 올랐습니다.",
      "- 원/달러가 +5.20원 올라 환율 효과 +24,717원이 생겼습니다.",
      "- 엔비디아(+39,240원)가 올렸지만 리게티 컴퓨팅(-268,838원)이 끌어내렸습니다.",
      "- 당일 손익은 -250,267원으로, 나스닥 +0.35%와 달리 계좌는 하락했습니다.", // 다른 숫자 뒤의 방향을 가져오지 않는다
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
  });

  it("모델 설명 검사 (3차 검증): 굵은 글씨·따옴표·화살표·전각·글자 뒤에 붙은 부호도 부호로 읽는다", () => {
    // 앞 글자가 빈칸·괄호일 때만 부호로 읽어서 **+250,267원** · `+250,267원` · →+8.06% 가 부호 없는 숫자로 통과하던 것
    expect(
      numberTokens("**+1원** `-2원` \"+3원\" ‘-4원’ _+5원_ →+6% 가-7원 +**8원** ＋９원 －10원 −11원 —12원 마이너스 13원 플러스14원 ▲15원 ▼ 16원 △17원 ±18%").tokens.map((t) => [t.value, t.sign, t.raw]),
    ).toEqual([
      [1, "+", "+1원"],
      [2, "-", "-2원"],
      [3, "+", "+3원"],
      [4, "-", "-4원"],
      [5, "+", "+5원"],
      [6, "+", "+6%"],
      [7, "-", "-7원"],
      [8, "+", "+8원"],
      [9, "+", "+9원"],
      [10, "-", "-10원"],
      [11, "-", "-11원"],
      [12, "-", "-12원"],
      [13, "-", "마이너스 13원"],
      [14, "+", "플러스 14원"],
      [15, "+", "▲15원"],
      [16, "-", "▼16원"],
      [17, "?", "△17원"], // 회계의 △(마이너스)와 상승 표시가 갈려 어느 쪽과도 맞추지 않는다
      [18, "?", "±18%"],
    ]);
    // 글머리표 '- ' 는 부호가 아니다 (기여 순위 번호)
    expect(numberTokens("- 1. 리게티 컴퓨팅\n- 250,267원").tokens.map((t) => [t.value, t.sign, t.unit])).toEqual([
      [1, null, "rank"],
      [250267, null, "원"],
    ]);

    const facts = factsText(dataFrom(fixture.holdings));
    // 사실: 당일 -250,267원 (-2.66%), 리게티 컴퓨팅 -268,838원 (-8.06%), 엔비디아 +39,240원 (+1.82%), 총 평가금액 9,157,673원
    const cases: Array<[string, string]> = [
      ["- 당일 손익은 **+250,267원**입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 당일 손익은 `+250,267원`입니다.", "입력에 없는 숫자: +250,267원"],
      ['- 당일 손익은 "+250,267원"입니다.', "입력에 없는 숫자: +250,267원"],
      ["- 당일 손익은 ‘+250,267원’입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 당일 손익은 _+250,267원_입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 당일 손익은 +**250,267원**입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 리게티 컴퓨팅 등락률 →+8.06%입니다.", "입력에 없는 숫자: +8.06%"],
      ["- 엔비디아는 **-39,240원**을 보탰습니다.", "입력에 없는 숫자: -39,240원"],
      ["- 엔비디아-39,240원, 계좌를 받쳤습니다.", "입력에 없는 숫자: -39,240원"], // 글자 바로 뒤의 '-'
      ["- 리게티 컴퓨팅+268,838원입니다.", "입력에 없는 숫자: +268,838원"],
      ["- 엔비디아는 −39,240원입니다.", "입력에 없는 숫자: -39,240원"], // 유니코드 빼기
      ["- 엔비디아는 —39,240원입니다.", "입력에 없는 숫자: -39,240원"],
      ["- 당일 손익은 ＋２５０，２６７원입니다.", "입력에 없는 숫자: +250,267원"], // 전각
      ["- 엔비디아는 －39,240원입니다.", "입력에 없는 숫자: -39,240원"],
      ["- 당일 손익은 +\u200b250,267원입니다.", "입력에 없는 숫자: +250,267원"], // 폭 없는 빈칸
      ["- 당일 손익은 플러스 250,267원입니다.", "입력에 없는 숫자: 플러스 250,267원"],
      ["- 엔비디아는 마이너스 39,240원입니다.", "입력에 없는 숫자: 마이너스 39,240원"],
      ["- 당일 손익은 ▲250,267원입니다.", "입력에 없는 숫자: ▲250,267원"],
      ["- 엔비디아는 ▼ 39,240원입니다.", "입력에 없는 숫자: ▼39,240원"],
      ["- 당일 손익은 △250,267원입니다.", "입력에 없는 숫자: △250,267원"],
      ["- 리게티 컴퓨팅은 ±8.06% 움직였습니다.", "입력에 없는 숫자: ±8.06%"],
      ["- 당일 손익은 + 250,267원입니다.", "입력에 없는 숫자: +250,267원"], // 한 칸 띄운 부호 (줄 머리 글머리표가 아니면)
      ["- 코스피는 3,412.35 +0.80%입니다.", "입력에 없는 숫자: +0.80%"],
      // 숫자 바로 뒤의 화살표, 숫자 바로 앞의 방향 낱말 (부호 없이)
      ["- 리게티 컴퓨팅은 8.06%↑ 움직였습니다.", "방향이 사실과 반대: 8.06% ↑"],
      ["- 엔비디아는 1.82%▼입니다.", "방향이 사실과 반대: 1.82% ▼"],
      ["- 엔비디아는 손실 39,240원입니다.", "방향이 사실과 반대: 39,240원 손실"],
      ["- 당일 이익은 250,267원입니다.", "방향이 사실과 반대: 250,267원 이익"],
      ["- 리게티 컴퓨팅 상승률 8.06%입니다.", "방향이 사실과 반대: 8.06% 상승"],
      // 빈칸으로 끊거나 0으로 시작하는 숫자 조각
      ["- 당일 손익은 -250 267원입니다.", "숫자 표기가 틀림: 250 267원"],
      ["- 총 평가금액은 9 157 673원입니다.", "숫자 표기가 틀림: 9 157, 157 673원"],
      ["- 그 외 2종목은 -4, 000원입니다.", "숫자 표기가 틀림: 000원"],
      ["- 리게티 컴퓨팅은 -8. 06% 내렸습니다.", "숫자 표기가 틀림: 06%"],
      // 만·억 단위, 한글로 적은 숫자
      ["- 당일 손익은 -25만 원입니다.", "입력에 없는 숫자: -25만"],
      ["- 총 평가금액은 915만 원입니다.", "입력에 없는 숫자: 915만"],
      ["- 총 평가금액은 약 0.09억 원입니다.", "입력에 없는 숫자: 0.09억"],
      ["- 당일 손익은 마이너스 이십오만 원입니다.", "입력에 없는 숫자: 이십오만 원"],
      ["- 당일 손실은 약 이십오만 이천 원입니다.", "입력에 없는 숫자: 이십오만 이천 원"],
      ["- 엔비디아는 수만 원을 보탰습니다.", "입력에 없는 숫자: 수만 원"],
      ["- 리게티 컴퓨팅이 팔 퍼센트 내렸습니다.", "입력에 없는 숫자: 팔 퍼센트"],
    ];
    for (const [text, reason] of cases) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    // 부호·방향이 사실과 같으면 꾸밈이 붙어도 통과
    for (const text of [
      "- 당일 손익은 **-250,267원**(**-2.66%**)입니다.",
      '- 1위 리게티 컴퓨팅은 `-268,838원`, 엔비디아는 "+39,240원"입니다.',
      "- 엔비디아 등락률 →+1.82%, 리게티 컴퓨팅 →−8.06%입니다.",
      "- 당일 손익은 －２５０，２６７원(마이너스 2.66%)입니다.",
      "- 엔비디아는 ▲39,240원, 리게티 컴퓨팅은 ▼268,838원입니다.",
      "- 엔비디아 1.82%↑, 리게티 컴퓨팅 8.06%↓입니다.",
      "- 엔비디아는 이익 +39,240원, 리게티 컴퓨팅은 손실 -268,838원입니다.",
      "- 엔비디아+39,240원, 리게티 컴퓨팅-268,838원입니다.",
      "- 리게티 컴퓨팅은 하락률 -8.06%로 1위입니다.",
      "- 엔비디아는 하락장에서도 +39,240원을 벌었습니다.", // 부호를 적었으면 앞 낱말('하락장')은 보지 않는다
      "- 리게티 컴퓨팅 -268,838원 엔비디아 플러스 39,240원입니다.", // 다음 숫자의 말 부호('플러스')를 앞 숫자의 방향으로 가져오지 않는다
      "- 총 평가금액은 9,157,673원이고 보유 7종목, 원/달러 1,391.00원입니다.",
      "- 1-2위는 리게티 컴퓨팅과 엔비디아이고 코스피는 3,412.35 -0.80%입니다.", // 숫자에 붙은 '-'는 범위, 띄운 '-'는 부호
      "- 정리하면 1위는 리게티 컴퓨팅이고 원/달러 변동으로 환율 효과 +24,717원이 생겼습니다.",
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
    // 기본 문장은 그대로 통과
    expect(checkNarrative(templateNarrative(dataFrom(fixture.holdings)), facts)).toEqual({ ok: true });
  });

  it("모델 설명 검사 (4차 검증): HTML 엔티티·태그는 거절, 부호 뒤의 꾸밈·여러 칸·취소선·괄호를 건너뛰고, 모르는 부호 모양은 어느 사실과도 맞추지 않는다", () => {
    // 부호와 숫자 사이의 빈칸·강조·코드·취소선·여는 괄호는 개수·순서와 상관없이 건너뛴다. 모르는 기호(▴ ➕ 📈 ˗ …)는 '?'
    expect(
      numberTokens("**+** 1원 `-` 2원 +  3원 +\t 4원 -~~5원~~ +(6원) ▴7% ➕\ufe0f8원 📈9% ˗10원 ↗11% 1~2위 엔비디아 — 12원 = 13원 → 14원").tokens.map((t) => [t.value, t.sign, t.raw]),
    ).toEqual([
      [1, "+", "+1원"],
      [2, "-", "-2원"],
      [3, "+", "+3원"],
      [4, "+", "+4원"],
      [5, "-", "-5원"],
      [6, "+", "+6원"],
      [7, "?", "▴7%"],
      [8, "?", "➕8원"],
      [9, "?", "📈9%"],
      [10, "?", "˗10원"],
      [11, "?", "↗11%"],
      [1, null, "1"], // 범위 '1~2위'
      [2, null, "2위"],
      [12, null, "12원"], // 띄운 긴 줄표는 문장 부호
      [13, null, "13원"], // = → 는 부호가 아니다
      [14, null, "14원"],
    ]);
    // 글머리표('- ', '+ ', '-  ')는 여전히 부호가 아니다
    expect(numberTokens("- 1. 리게티 컴퓨팅\n-  250,267원\n+ 3종목\n- **7종목**").tokens.map((t) => [t.value, t.sign])).toEqual([
      [1, null],
      [250267, null],
      [3, null],
      [7, null],
    ]);

    const facts = factsText(dataFrom(fixture.holdings));
    // 사실: 당일 -250,267원, 엔비디아 +39,240원 (+1.82%), 리게티 컴퓨팅 -8.06%
    const cases: Array<[string, string]> = [
      ["- 당일 손익은 &plus;250,267원입니다.", "쓰지 않는 표기: &plus;"],
      ["- 엔비디아는 &minus;39,240원입니다.", "쓰지 않는 표기: &minus;"],
      ["- 엔비디아는 &ndash;39,240원입니다.", "쓰지 않는 표기: &ndash;"],
      ["- 엔비디아는 &mdash;39,240원입니다.", "쓰지 않는 표기: &mdash;"],
      ["- 엔비디아는 &#8722;39,240원입니다.", "쓰지 않는 표기: &#8722;"],
      ["- 엔비디아는 &#x2212;39,240원입니다.", "쓰지 않는 표기: &#x2212;"],
      ["- 당일 손익은 <b>+</b>250,267원입니다.", "쓰지 않는 표기: <b>"],
      ["- 당일 손익은 \u202e+250,267원입니다.", "쓰지 않는 표기: 글자 방향 제어 문자"],
      ["- 당일 손익은 **+** 250,267원입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 당일 손익은 `+` 250,267원입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 당일 손익은 +  250,267원입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 당일 손익은 +\t 250,267원입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 당일 손익은 +\u00a0 250,267원입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 엔비디아는 -~~39,240원~~입니다.", "입력에 없는 숫자: -39,240원"],
      ["- 당일 손익은 +(250,267원)입니다.", "입력에 없는 숫자: +250,267원"],
      ["- 리게티 컴퓨팅은 ▴8.06%입니다.", "입력에 없는 숫자: ▴8.06%"],
      ["- 엔비디아는 ▾1.82%입니다.", "입력에 없는 숫자: ▾1.82%"],
      ["- 리게티 컴퓨팅은 ↗8.06%입니다.", "입력에 없는 숫자: ↗8.06%"],
      ["- 리게티 컴퓨팅은 ⇧8.06%입니다.", "입력에 없는 숫자: ⇧8.06%"],
      ["- 당일 손익은 ➕250,267원입니다.", "입력에 없는 숫자: ➕250,267원"],
      ["- 엔비디아는 ➖39,240원입니다.", "입력에 없는 숫자: ➖39,240원"],
      ["- 리게티 컴퓨팅은 📈8.06%입니다.", "입력에 없는 숫자: 📈8.06%"],
      ["- 엔비디아는 ˗39,240원입니다.", "입력에 없는 숫자: ˗39,240원"],
    ];
    for (const [text, reason] of cases) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    // 부호가 사실과 같으면 꾸밈·괄호·빈칸이 끼어도 통과, 괄호 뒤 다른 말의 방향을 가져오지 않는다
    for (const text of [
      "- 당일 손익은 **-** 250,267원이고 엔비디아는 `+` 39,240원입니다.",
      "- 엔비디아는 +(39,240원), 리게티 컴퓨팅은 -~~268,838원~~입니다.",
      "- 엔비디아(+39,240원)와 SK하이닉스(+13,500원)가 손실을 일부 줄였습니다.",
      "- 엔비디아 +39,240원이 손실을 일부 줄였습니다.",
      "- 미국 보유분 원화 평가 변화 = -209,723원이고 코스피 → -0.80%입니다.",
      "- 1~2위는 리게티 컴퓨팅과 엔비디아입니다.",
      "- S&P500 지수는 받지 못했습니다.",
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
    // 사실 목록의 숫자는 모두 부호를 알아본다 ('?' 없음)
    expect(numberTokens(facts).tokens.filter((t) => t.sign === "?")).toEqual([]);
  });

  it("모델 설명 검사 (4차 검증): 부호가 붙은 사실(손익·등락률)을 부호 없이 옮기면 거절, 부호를 적어도 말(강세·손해·흑자…)이 반대면 거절", () => {
    const facts = factsText(dataFrom(fixture.holdings));
    // 사실: 당일 -250,267원, 리게티 컴퓨팅 -268,838원 (-8.06%), 엔비디아 +39,240원 (+1.82%), 코스피 -0.80%
    const cases: Array<[string, string]> = [
      // 뒤집은 방향 (넓힌 낱말)
      ["- 리게티 컴퓨팅은 8.06% 강세였습니다.", "방향이 사실과 반대: 8.06% 강세"],
      ["- 엔비디아는 1.82% 약세였습니다.", "방향이 사실과 반대: 1.82% 약세"],
      ["- 엔비디아에서 39,240원 손해를 봤습니다.", "방향이 사실과 반대: 39,240원 손해"],
      ["- 리게티 컴퓨팅에서 268,838원 이득을 봤습니다.", "방향이 사실과 반대: 268,838원 이득"],
      ["- 당일 손익은 250,267원 흑자입니다.", "방향이 사실과 반대: 250,267원 흑자"],
      ["- 엔비디아에서 39,240원 적자가 났습니다.", "방향이 사실과 반대: 39,240원 적자"],
      ["- 리게티 컴퓨팅은 8.06% 폭등했습니다.", "방향이 사실과 반대: 8.06% 폭등"],
      ["- 엔비디아는 1.82% 밀리며 끝났습니다.", "방향이 사실과 반대: 1.82% 밀리"],
      ["- 리게티 컴퓨팅은 268,838원을 벌어들였습니다.", "방향이 사실과 반대: 268,838원 벌어들"],
      ["- 리게티 컴퓨팅은 268,838원 벌어다 주었습니다.", "방향이 사실과 반대: 268,838원 벌어다"],
      ["- 엔비디아는 39,240원 깎였습니다.", "방향이 사실과 반대: 39,240원 깎"],
      ["- 엔비디아는 39,240원을 날렸습니다.", "방향이 사실과 반대: 39,240원 날렸"],
      ["- 엔비디아는 39,240원 까먹었습니다.", "방향이 사실과 반대: 39,240원 까먹"],
      ["- 엔비디아는 39,240원 잃은 셈입니다.", "방향이 사실과 반대: 39,240원 잃"],
      ["- 리게티 컴퓨팅은 8.06% 오름세였습니다.", "방향이 사실과 반대: 8.06% 오름"],
      ["- 코스피는 0.80% 상향했습니다.", "방향이 사실과 반대: 0.80% 상향"],
      ["- 엔비디아 낙폭은 1.82%였습니다.", "방향이 사실과 반대: 1.82% 낙폭"],
      ["- 리게티 컴퓨팅 평가익 268,838원입니다.", "방향이 사실과 반대: 268,838원 평가익"],
      // 부호를 적어도 말이 반대면
      ["- 엔비디아는 +39,240원 손해를 봤습니다.", "방향이 사실과 반대: +39,240원 손해"],
      ["- 리게티 컴퓨팅은 -8.06% 강세였습니다.", "방향이 사실과 반대: -8.06% 강세"],
      ["- 당일 손익은 -250,267원 흑자입니다.", "방향이 사실과 반대: -250,267원 흑자"],
      // 방향 낱말이 맞거나, 모르는 말이거나, 세 어절 밖에 있어도 부호를 빼면 거절
      ["- 리게티 컴퓨팅은 8.06% 빠지며 부진했습니다.", "부호가 빠진 숫자: 8.06%"],
      ["- 엔비디아는 1.82% 뛰며 강세였습니다.", "부호가 빠진 숫자: 1.82%"],
      ["- 리게티 컴퓨팅은 268,838원으로 계좌를 가장 크게 끌어올렸습니다.", "부호가 빠진 숫자: 268,838원"],
      ["- 엔비디아는 39,240원 보탬이 됐습니다.", "부호가 빠진 숫자: 39,240원"],
      ["- 엔비디아는 하락장에서도 39,240원을 벌었습니다.", "부호가 빠진 숫자: 39,240원"],
      ["- 리게티 컴퓨팅 268,838원이 가장 컸습니다.", "부호가 빠진 숫자: 268,838원"],
    ];
    for (const [text, reason] of cases) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    for (const text of [
      "- 엔비디아는 +1.82% 강세로 +39,240원 이득이었습니다.",
      "- 리게티 컴퓨팅은 -8.06% 약세, 엔비디아는 +1.82% 강세였습니다.",
      "- 당일 손익은 -250,267원 적자이고 리게티 컴퓨팅이 -268,838원을 까먹었습니다.",
      "- 엔비디아 1.82%↑, 리게티 컴퓨팅 8.06%↓입니다.", // 숫자에 붙은 화살표는 부호로 본다
      "- 보유 7종목, 코스피 3,412.35, 원/달러 1,391.00원, 총 평가금액 9,157,673원입니다.", // 부호 없는 사실은 그대로
      "- 누적 평가손익은 +883,324원(+10.68%)입니다.", // '평가손익'은 방향 낱말이 아니다
      "- 미국 보유분은 -3.54%로 나스닥 +0.35%와 달리 내렸습니다.", // '와 달리' 뒤의 말은 다른 주어의 방향
      "- 기여 2위 엔비디아(+39,240원)와 4위 SK하이닉스(+13,500원)가 하락 폭을 일부 줄였습니다.",
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
  });

  it("모델 설명 검사 (4차 검증): 한글로 적은 개수·기간·소수와 0~9 가 아닌 숫자는 거절", () => {
    const facts = factsText(dataFrom(fixture.holdings));
    // 사실: 보유 7종목, 공시 없음. 공시 기간도 숫자·수 낱말 없이 적는다 ('사흘'이 '사흘 연속'을 통과시키지 않게)
    expect(facts).not.toMatch(/사흘|이틀/);
    const cases: Array<[string, string]> = [
      ["- 리게티 컴퓨팅은 이틀 연속 하락했습니다.", "입력에 없는 숫자: 이틀 연속"],
      ["- 리게티 컴퓨팅은 사흘째 내렸습니다.", "입력에 없는 숫자: 사흘째"],
      ["- 최근 사흘 동안 공시가 없었습니다.", "입력에 없는 숫자: 사흘 동안"],
      ["- 보유 종목 가운데 세 종목이 올랐습니다.", "입력에 없는 숫자: 세 종목"],
      ["- 보유 여덟 종목입니다.", "입력에 없는 숫자: 여덟 종목"],
      ["- 보유 종목 가운데 세  종목이 올랐습니다.", "입력에 없는 숫자: 세  종목"], // 빈칸 두 칸 (화면에는 한 칸으로 보인다)
      ["- 리게티 컴퓨팅이 팔  퍼센트 내렸습니다.", "입력에 없는 숫자: 팔  퍼센트"],
      ["- 최근 공시는 두 건입니다.", "입력에 없는 숫자: 두 건"],
      ["- 코스피보다 열 배 크게 움직였습니다.", "입력에 없는 숫자: 열 배"],
      ["- 엔비디아는 두 번째로 크게 움직였습니다.", "입력에 없는 숫자: 두 번째"],
      ["- 리게티 컴퓨팅은 한 달 동안 내렸습니다.", "입력에 없는 숫자: 한 달"],
      ["- 계좌는 플러스 이점육육퍼센트였습니다.", "입력에 없는 숫자: 이점육육퍼센트"],
      ["- 리게티 컴퓨팅은 팔 점 영육 퍼센트 내렸습니다.", "입력에 없는 숫자: 팔 점 영육 퍼센트"],
      ["- 보유 이십 종목입니다.", "입력에 없는 숫자: 이십 종목"],
      ["- 당일 손익은 +٢٥٠,٢٦٧원입니다.", "숫자 표기가 틀림: ٢٥٠, ٢٦٧"],
      ["- 엔비디아는 +۳۹,۲۴۰원입니다.", "숫자 표기가 틀림: ۳۹, ۲۴۰"],
    ];
    for (const [text, reason] of cases) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    // 개수가 아닌 말은 통과: '두 시장'·'이 종목'·'오늘 하루'·'강세 종목'·'열립니다'·'이점이'
    for (const text of [
      "- 한국과 미국 두 시장의 움직임을 나눠 봅니다.",
      "- 이 종목은 리게티 컴퓨팅입니다.",
      "- 오늘 하루 계좌는 -250,267원 움직였습니다.",
      "- 강세 종목과 약세 종목이 섞였습니다.",
      "- 미국 정규장은 9/25 22:30(한국 시간)에 열립니다.",
      "- 환율 효과를 따로 보는 이점이 있습니다.",
      "- 보유 7종목 가운데 1위는 리게티 컴퓨팅입니다.",
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
  });

  it("모델 설명 검사 (4차 검증): 매입·매각·사고팔기·시점·진입·관망·유지 권고, 낫습니다·좋습니다·필요합니다, 미래·추측형(~ㄹ 것입니다·듯·것 같·곧·계속·우려)은 거절", () => {
    const facts = factsText(dataFrom(fixture.holdings, {
      schedule: buildSchedule(null, new Date("2026-09-25T16:05:00+09:00"), [{ code: "000660", name: "SK하이닉스", title: "공개매수신고서", filedAt: "2026-09-25", url: null }]),
    }));
    for (const [text, word] of [
      ["- 리게티 컴퓨팅을 팔고 삼성전자를 사는 것이 낫습니다.", "팔고"],
      ["- 추가 매입을 검토해 볼 만합니다.", "매입"],
      ["- 검토해 볼 만합니다.", "검토"],
      ["- 리게티 컴퓨팅을 매각하는 게 낫습니다.", "매각"],
      ["- 엔비디아를 사는 게 낫습니다.", "사는 게"],
      ["- 엔비디아를 팔 시점입니다.", "팔 시점"],
      ["- 정리할 시점입니다.", "정리할"],
      ["- 지금은 관망하는 것이 좋습니다.", "관망"],
      ["- 삼성전자 보유를 유지하는 것이 좋습니다.", "유지하는"],
      ["- 삼성전자를 더 담으시는 것도 좋습니다.", "담으"],
      ["- 오늘 하락은 좋은 진입 시점입니다.", "진입"],
      ["- 엔비디아 쪽이 더 좋습니다.", "좋"],
      ["- 현금 비율을 늘리는 것이 안전합니다.", "현금"],
      ["- 포트폴리오 리밸런싱이 필요합니다.", "리밸런싱"],
      ["- 미국 종목 쪽이 더 안전합니다.", "안전"],
      ["- 비율 조정이 필요합니다.", "필요"],
      ["- 공개매수에 응하는 것이 낫습니다.", "낫"],
      // 미래·추측
      ["- 코스피는 곧 회복할 것입니다.", "곧"],
      ["- 코스피는 회복할 것입니다.", "회복"],
      ["- 하락세가 계속될 것입니다.", "계속"],
      ["- 상승세가 지속됩니다.", "지속"],
      ["- 다음 주에는 오를 듯합니다.", "다음 주"],
      ["- 원/달러는 더 오를 듯합니다.", "오를"],
      ["- 코스피가 더 내려갈 것 같습니다.", "내려갈"],
      ["- 추가 하락이 우려됩니다.", "우려"],
      ["- 환율 변동이 걱정됩니다.", "걱정"],
      ["- 엔비디아 덕분에 버틴 것 같습니다.", "것 같"],
      ["- 엔비디아가 버팀목이 된 듯합니다.", "듯"],
      ["- 반도체 쪽이 흔들릴 것입니다.", "릴 것입니다"],
      ["- 원/달러가 움직이면 환율 효과도 달라질 겁니다.", "질 겁니다"],
      ["- 계좌가 버티겠습니다.", "겠"],
      ["- 나스닥 흐름이 계좌에 유리합니다.", "유리"],
    ] as const) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason: `쓰지 않는 표현: ${word}` });
    // 설명문은 통과 (사실에 있는 공시 제목 속 '매수', 과거형 서술)
    for (const text of [
      "- SK하이닉스 공개매수신고서가 최근 공시로 있습니다.",
      "- 국내 보유분은 -0.56%, 미국 보유분은 -3.54%로 미국 쪽 움직임이 컸습니다.",
      "- 환율 효과 +24,717원은 당일 손익에 넣지 않은 별도 항목입니다.",
      "- 원/달러가 +5.20원 올라 미국 보유분의 원화 가치가 +24,717원 달라졌습니다.",
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
    expect(checkNarrative(templateNarrative(dataFrom(fixture.holdings)), factsText(dataFrom(fixture.holdings)))).toEqual({ ok: true });
  });

  it("넓힌 검사가 기본 문장·사실을 거절하지 않는다: 여러 시각(장 전·장중·장 뒤·밤·새벽)·휴장·공시·환율 없음·실제 기준 문장에서 기본 문장과 사실 그대로 옮긴 글은 통과", () => {
    const disc = [{ code: "005930", name: "삼성전자", title: "분기보고서 (2026.06)", filedAt: "2026-09-24", url: null }];
    const holiday = { now: "", KR: { market: "KR", isTradingDay: false, isOpen: false, opensAt: "2026-09-28T23:00:00.000Z", closesAt: null, source: "toss" }, US: { market: "US", isTradingDay: true, isOpen: false, opensAt: "2026-09-25T13:30:00.000Z", closesAt: null, source: "toss" } } as MarketStatus;
    for (const at of ["2026-09-25T07:40:00+09:00", "2026-09-25T08:30:00+09:00", "2026-09-25T12:00:00+09:00", "2026-09-25T16:05:00+09:00", "2026-09-25T22:00:00+09:00", "2026-09-26T03:00:00+09:00", "2026-11-27T08:30:00+09:00"]) {
      for (const status of [null, holiday]) {
        for (const over of [{}, { krPreviousDay: true, usPreviousDay: true }, { fx: { ...computeAccount(fixture.holdings).fx, status: "unavailable" as const, reason: "원/달러 전일 대비 변동을 받지 못해 환율 효과를 계산하지 못했습니다", usdHoldingsKrwChange: null, priceEffect: null, fxEffect: null } }]) {
          const d = dataFrom(fixture.holdings, { basis: BASIS, schedule: buildSchedule(status, new Date(at), disc), ...over });
          const facts = factsText(d);
          expect(checkNarrative(templateNarrative(d), facts), `${at} 기본 문장`).toEqual({ ok: true });
          expect(checkNarrative(facts, facts), `${at} 사실 그대로`).toEqual({ ok: true });
          expect(numberTokens(facts).tokens.filter((t) => t.sign === "?"), at).toEqual([]);
          expect(facts, at).not.toMatch(/지금:/); // 장 상태는 '브리핑 시각 기준'
        }
      }
    }
  });

  it("모델 설명 검사: 권유·전망 표현은 거절, 사실에 있는 공시 제목·'예상액'은 통과", () => {
    const facts = factsText(dataFrom(fixture.holdings, {
      basis: "총 평가금액은 수수료·세금 예상액을 뺀 값",
      schedule: buildSchedule(null, new Date("2026-09-25T16:05:00+09:00"), [
        { code: "005930", name: "삼성전자", title: "주식매수선택권부여에관한신고", filedAt: "2026-09-24", url: null },
        { code: "000660", name: "SK하이닉스", title: "공개매수신고서", filedAt: "2026-09-25", url: null },
        { code: "035420", name: "NAVER", title: "영업실적등에대한전망(공정공시)", filedAt: "2026-09-25", url: null },
      ]),
    }));
    for (const [text, word] of [
      ["- 비중을 줄이는 것이 좋겠습니다.", "비중"],
      ["- 추가 상승이 예상됩니다.", "예상"],
      ["- 반등할 수 있습니다.", "반등"],
      ["- 다시 오를 가능성이 큽니다.", "가능성"],
      ["- 지금은 팔 때입니다.", "팔 때"],
      ["- 반도체 업황 회복이 기대됩니다.", "기대"],
      ["- 리게티 컴퓨팅을 줄이는 것을 고려해 볼 만합니다.", "고려해"],
      ["- 환율을 확인하세요.", "세요"],
      ["- 실적 전망이 밝습니다.", "전망"],
      ["- 공개매수에 응하는 것을 추천합니다.", "추천"],
      // 2차 검증에서 통과하던 권유·행동 제안·전망
      ["- 지금 사세요.", "세요"],
      ["- 리게티 컴퓨팅은 파세요.", "세요"],
      ["- 차익 실현을 검토해 보세요.", "차익"],
      ["- 리게티 컴퓨팅을 처분하는 것이 바람직합니다.", "처분"],
      ["- 미국 종목을 줄여 나가시길 권장드립니다.", "시길"],
      ["- 비율을 줄이는 것을 권장합니다.", "권장"],
      ["- 저가 매집 기회입니다.", "매집"],
      ["- 지금이 담아 둘 때입니다.", "담아"],
      ["- 지금이 좋은 기회입니다.", "기회"],
      ["- 들어갈 타이밍입니다.", "타이밍"],
      ["- 앞으로 코스피가 더 떨어질 것으로 보입니다.", "앞으로"],
      ["- 코스피가 더 떨어질 것으로 보입니다.", "떨어질"],
      ["- 영향이 컸던 것으로 보입니다.", "것으로 보"],
      ["- 내일도 하락세가 이어질 수 있습니다.", "내일"],
      ["- 하락세가 이어질 수 있습니다.", "이어질"],
      ["- 원/달러가 오르면 환율 효과가 커질 수 있습니다.", "수 있습니다"],
      ["- 향후 흐름을 지켜봐야 합니다.", "향후"],
      ["- 당분간 변동이 클 듯합니다.", "당분간"],
      ["- 추가 상승 여력이 남았습니다.", "여력"],
      ["- 손실 종목은 정리하는 편이 낫습니다.", "정리하"],
      ["- 참고하시기 바랍니다.", "바랍니다"],
      ["- 환율을 확인하십시오.", "십시오"],
    ] as const) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason: `쓰지 않는 표현: ${word}` });
    // 장 시간을 말하는 '내일 새벽'·요약하는 '정리하면'은 괜찮다
    expect(checkNarrative("- 미국 정규장은 9/25 22:30부터 내일 새벽 05:00까지입니다.\n- 정리하면 당일 손익은 -250,267원입니다.", facts)).toEqual({ ok: true });
    // 공시일의 '일'만 쓴 것은 통과, 사실에 없는 날은 거절
    expect(checkNarrative("- 삼성전자는 24일 공시를 냈습니다.", facts)).toEqual({ ok: true });
    expect(checkNarrative("- 삼성전자는 23일 공시를 냈습니다.", facts)).toEqual({ ok: false, reason: "입력에 없는 숫자: 23일" });
    expect(
      checkNarrative(
        '- 최근 공시로 삼성전자 "주식매수선택권부여에관한신고"(9/24), SK하이닉스 공개매수신고서, NAVER 영업실적등에대한전망(공정공시)가 있습니다.\n- 총 평가금액은 수수료·세금 예상액을 뺀 값입니다.',
        facts,
      ),
    ).toEqual({ ok: true });
  });

  it("모델 설명 검사 (5차 검증): 다른 목록·인용 표시 뒤의 '- '·'+ '는 안쪽 글머리표라 부호가 아니다 — 부호가 빠진 숫자로 거절", () => {
    // 마크다운에서 '- - 1원'·'1. - 1원'·'> - 1원'·'* + 1원'·들여쓴 '  - + 1원'은 안쪽 글머리표가 되어 부호가 화면에서 사라진다
    for (const line of ["- - 268,838원", "1. - 268,838원", "> - 268,838원", ">- 268,838원", "* + 268,838원", "  - + 268,838원", "2) + 268,838원", "- 1. - 268,838원", "- - - 268,838원"]) {
      expect(numberTokens(line).tokens.find((t) => t.value === 268838)?.sign, line).toBeNull();
    }
    // 빈칸 없이 붙은 부호, 날짜·글자 뒤의 띄운 부호는 여전히 부호 (날짜를 지운 자리를 목록 표시로 보지 않는다)
    expect(numberTokens("- -268,838원").tokens[0]!.sign).toBe("-");
    expect(numberTokens("- 9/25 - 268,838원").tokens.find((t) => t.value === 268838)!.sign).toBe("-");
    expect(numberTokens("- 리게티 컴퓨팅 - 268,838원").tokens[0]!.sign).toBe("-");

    const facts = factsText(dataFrom(fixture.holdings));
    // 사실: 리게티 컴퓨팅 -268,838원, 엔비디아 +39,240원
    for (const [text, reason] of [
      ["- - 268,838원 보탬이 됐습니다.", "부호가 빠진 숫자: 268,838원"],
      ["1. - 268,838원 보탬이 됐습니다.", "부호가 빠진 숫자: 268,838원"],
      ["> - 268,838원 보탬이 됐습니다.", "부호가 빠진 숫자: 268,838원"],
      ["* - 268,838원 보탬이 됐습니다.", "부호가 빠진 숫자: 268,838원"],
      ["- 기여 순서\n  - - 268,838원 보탬이 된 리게티 컴퓨팅\n  - + 39,240원 발목을 잡은 엔비디아", "부호가 빠진 숫자: 268,838원, 39,240원"],
    ] as const) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    for (const text of ["- 리게티 컴퓨팅 - 268,838원이 가장 컸습니다.", "- -268,838원으로 리게티 컴퓨팅이 1위였습니다.", "1. 리게티 컴퓨팅 -268,838원"]) {
      expect(checkNarrative(text, facts), text).toEqual({ ok: true });
    }
  });

  it("모델 설명 검사 (5차 검증): 개수 말 없이 쓴 고유어 수·서수·기간·어림수도 거절", () => {
    const facts = factsText(dataFrom(fixture.holdings));
    const cases: Array<[string, string]> = [
      ["- 오른 종목은 둘, 내린 종목은 다섯입니다.", "입력에 없는 숫자: 둘, 다섯"],
      ["- 오른 종목은 셋뿐입니다.", "입력에 없는 숫자: 셋"],
      ["- 하나뿐인 상승 종목은 엔비디아입니다.", "입력에 없는 숫자: 하나"],
      ["- 엔비디아가 둘째로 크게 움직였습니다.", "입력에 없는 숫자: 둘째"],
      ["- NAVER는 셋째, SK하이닉스는 넷째였습니다.", "입력에 없는 숫자: 셋째, 넷째"],
      ["- 첫째로 리게티 컴퓨팅이 컸습니다.", "입력에 없는 숫자: 첫째"],
      ["- 엔비디아는 첫 번째로 컸습니다.", "입력에 없는 숫자: 첫 번째"],
      ["- 리게티 컴퓨팅은 일주일 만에 가장 크게 내렸습니다.", "입력에 없는 숫자: 일주일"],
      ["- 코스피는 석 달 만에 가장 크게 내렸습니다.", "입력에 없는 숫자: 석 달"],
      ["- 반년 만의 가장 큰 낙폭이었습니다.", "입력에 없는 숫자: 반년"],
      ["- 리게티 컴퓨팅은 삼 개월 만에 가장 크게 내렸습니다.", "입력에 없는 숫자: 삼 개월"],
      ["- 두세 종목이 크게 움직였습니다.", "입력에 없는 숫자: 두세"],
      ["- 서너 종목이 내렸습니다.", "입력에 없는 숫자: 서너"],
      ["- 대여섯 종목이 올랐습니다.", "입력에 없는 숫자: 대여섯"],
      ["- 리게티 컴퓨팅은 두 자릿수 하락을 기록했습니다.", "입력에 없는 숫자: 두 자릿수"],
      ["- 몇 년 만의 낙폭이었습니다.", "입력에 없는 숫자: 몇 년"],
    ];
    for (const [text, reason] of cases) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    for (const text of [
      "- 한국과 미국 두 시장의 움직임을 나눠 봅니다.",
      "- 하나은행 매매기준율 원/달러는 1,391.00원입니다.",
      "- 강세 종목과 약세 종목이 섞였습니다.",
      "- 미국 정규장은 9/25 22:30(한국 시간)에 열립니다.",
      "- 둘러본 결과 리게티 컴퓨팅이 1위였습니다.",
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
  });

  it("모델 설명 검사 (5차 검증): 의무·권고·평가·예측 표현, 과거형 설명이 아닌 끝맺음과 물음표는 거절", () => {
    const facts = factsText(dataFrom(fixture.holdings));
    for (const [text, word] of [
      // 의무·권고·제안
      ["- 리게티 컴퓨팅 보유량을 줄여야 합니다.", "야 합"],
      ["- 추가 하락에 대비해야 합니다.", "야 합"],
      ["- 변동성에 유의해야 합니다.", "유의"],
      ["- 미국 종목 비율을 낮출 것을 제안합니다.", "제안"],
      ["- 미국 종목 비율을 낮출 것을 권고합니다.", "권고"],
      ["- 나눠 담기를 권해 드립니다.", "권해"],
      ["- 엔비디아를 늘리는 것도 방법입니다.", "방법입니다"],
      ["- 엔비디아는 더 늘릴 만합니다.", "릴 만합"],
      ["- 엔비디아를 늘립시다.", "립시다"],
      ["- 리게티 컴퓨팅은 줄여도 됩니다.", "여도 됩"],
      ["- 엔비디아를 늘리는 게 어떨까요?", "어떨"],
      ["- 분산 투자가 중요합니다.", "중요"],
      ["- 리스크 관리가 중요합니다.", "중요"],
      // 평가
      ["- 애플은 저평가 상태입니다.", "저평가"],
      ["- 엔비디아는 매력적인 가격대입니다.", "매력"],
      ["- 엔비디아로 갈아타는 편이 현명합니다.", "갈아타"],
      ["- 지금이 늘릴 적기입니다.", "적기"],
      ["- 삼성전자는 장기 보유에 적합합니다.", "적합"],
      ["- 나눠 사는 전략이 유효합니다.", "전략"],
      ["- 원/달러 흐름이 미국 보유분에 우호적입니다.", "우호"],
      // 예측
      ["- 엔비디아는 상승 여지가 있습니다.", "여지"],
      ["- 코스피가 더 밀릴지도 모릅니다.", "모릅"],
      ["- 엔비디아가 오르리라 봅니다.", "리라"],
      ["- 환율 효과가 커질 거라 봅니다.", "질 거라"],
      ["- 하락 확률이 높습니다.", "확률"],
      ["- 코스피는 머지않아 회복합니다.", "머지않"],
      ["- 엔비디아는 조만간 오릅니다.", "조만간"],
      ["- 리게티 컴퓨팅이 오를 차례입니다.", "를 차례"],
      ["- 추세 전환이 임박했습니다.", "임박"],
      ["- 되돌림이 나올 만합니다.", "되돌림"],
      ["- 하락세는 오래가지 않습니다.", "오래가"],
      // 낱말 목록에 없어도 끝맺음이 과거형 설명이 아니면 (현재형은 앞일을 말할 때도 쓴다)
      ["- 코스피는 다시 오릅니다.", "문장 끝 '오릅니다'"],
      ["- 원/달러는 더 내립니다.", "문장 끝 '내립니다'"],
      ["- 리게티 컴퓨팅 보유량을 줄입니다.", "문장 끝 '줄입니다'"],
      ["- 반도체 흐름이 개선됩니다.", "문장 끝 '개선됩니다'"],
      ["- 엔비디아를 더 늘린다.", "문장 끝 '늘린다'"],
      ["- 엔비디아가 강하다고 봅니다.", "문장 끝 '봅니다'"],
      ["- 당일 손익은 -250,267원이었습니다?", "물음표"],
    ] as const) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason: `쓰지 않는 표현: ${word}` });
    // 설명문·일정 문장·명사로 끝나는 줄은 통과
    for (const text of [
      "- 환율 효과는 당일 손익과 따로 봅니다.",
      "- 한국 정규장은 15:30에 마감합니다.",
      "- 코스피는 3,412.35로 마감했습니다.",
      "- 리게티 컴퓨팅은 -8.06% 내려 -268,838원 손실을 냈습니다.",
      "- 합계에서 뺀 종목은 없습니다.",
      "- 환율 효과는 당일 손익에 넣지 않습니다.",
      "- 기준은 앱 잔고 화면과 같습니다.",
      "- 기여 1위: 리게티 컴퓨팅 -268,838원",
      "- 삼성전자 기여는 크지 않았습니다.",
      "- 반도체 분야 하락이 컸습니다.",
      "- 미국 정규장은 브리핑 시각 기준 아직 열리지 않았습니다.",
      "- 당일 손익은 -250,267원이다.",
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
  });

  it("모델 설명 검사 (5차 검증): 퍼센트포인트·기간으로 쓴 'N일'·앞 어절 방향(부호를 적어도)·사실에 없는 이유는 거절", () => {
    const facts = factsText(dataFrom(fixture.holdings));
    // 사실: 코스피 -0.80%, 날짜 9/24·9/25·9/26, 엔비디아 +39,240원, 리게티 컴퓨팅 -268,838원, SK하이닉스 +13,500원
    const cases: Array<[string, string]> = [
      ["- 코스피는 -0.80퍼센트포인트 움직였습니다.", "입력에 없는 숫자: -0.80퍼센트포인트"],
      ["- 코스피는 -0.80 퍼센트 포인트 움직였습니다.", "입력에 없는 숫자: -0.80 퍼센트 포인트"],
      ["- 리게티 컴퓨팅은 25일 만에 가장 크게 내렸습니다.", "입력에 없는 숫자: 25일"],
      ["- 24일 만의 최대 낙폭이었습니다.", "입력에 없는 숫자: 24일"],
      ["- 엔비디아 손실 +39,240원이었습니다.", "방향이 사실과 반대: +39,240원 손실"],
      ["- 리게티 컴퓨팅 이익 -268,838원이었습니다.", "방향이 사실과 반대: -268,838원 이익"],
      ["- SK하이닉스(+13,500원)는 HBM 수주 소식에 올랐습니다.", "쓰지 않는 표현: 수주"],
      ["- 리게티 컴퓨팅(-268,838원)은 양자컴퓨팅 업황 부진 여파로 내렸습니다.", "쓰지 않는 표현: 업황"],
      ["- 엔비디아(+39,240원)는 실적 발표 효과로 올랐습니다.", "쓰지 않는 표현: 실적"],
    ];
    for (const [text, reason] of cases) expect(checkNarrative(text, facts), text).toEqual({ ok: false, reason });
    for (const text of [
      "- 미국 정규장은 25일 22:30(한국 시간)에 열립니다.",
      "- 마지막 정규장은 24일(현지)에 끝났습니다.",
      "- 엔비디아는 하락장에서도 +39,240원을 보탰습니다.", // '하락장에서도'는 숫자의 방향이 아니다
      "- 엔비디아는 이익 +39,240원, 리게티 컴퓨팅은 손실 -268,838원이었습니다.",
    ]) expect(checkNarrative(text, facts), text).toEqual({ ok: true });
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

/** 종목 브리핑은 평범하게, 계좌 브리핑은 사실에서 숫자를 그대로 옮겨(또는 지어내어, 또는 text 그대로) 답하는 가짜 모델 */
class AccountGen implements TextGenerator {
  model = "fake-model";
  requests: GenerateRequest[] = [];
  mode: "copy" | "invent" | "fail" | "text" = "copy";
  text = "";
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
      if (this.mode === "text") return done(this.text);
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
const holidayCalendar = { status: async (): Promise<MarketStatus> => ({ now: "", KR: closed("KR"), US: closed("US") }), isTradingDay: async () => false, isTradingDate: async () => false };
/** 한국만 휴장인 날 (추석 등): 국내 종목 브리핑은 건너뛰고 미국은 만든다 */
const openUs = { market: "US" as const, isTradingDay: true, isOpen: false, opensAt: "2026-09-25T13:30:00.000Z", closesAt: null, source: "toss" as const };
const krHolidayCalendar = {
  status: async (): Promise<MarketStatus> => ({ now: "", KR: closed("KR"), US: openUs }),
  isTradingDay: async (code: string) => !/^\d/.test(code),
  isTradingDate: async (market: "KR" | "US") => market === "US",
};

const AAPL: ListedStock = { code: "AAPL", name: "애플", market: "NASDAQ", isinCode: null, groupCode: null };
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

describe("계좌 브리핑 (서버)", () => {
  let app: FastifyInstance;
  let db: Db;
  afterEach(async () => {
    await app?.close();
    await db?.destroy();
  });

  const setup = async (o: { at?: string; gen?: AccountGen; holdings?: boolean; disabledModel?: boolean; holiday?: boolean | "kr"; llm?: boolean } = {}) => {
    db = await createMigratedDb(":memory:");
    const push = new FakePush();
    const gen = o.gen ?? new AccountGen();
    if (o.disabledModel) gen.model = "disabled";
    const quotes = new MixedQuotes();
    const indices = fakeIndices(fakeIndexSource({ fx: { close: "1,391.00", change: "5.20", rate: "0.38" } }), () => new Date(o.at ?? "2026-09-25T16:05:00+09:00"));
    // 휴장 달력을 주지 않으면: 토스 달력 조회는 실패하고, 요일 추정(fallback)은 테스트 시각으로 한다 (실제 오늘이 주말이어도 결과가 같게)
    const calendar = o.holiday ? (o.holiday === "kr" ? krHolidayCalendar : holidayCalendar) : new MarketCalendar(async () => new Response("{}", { status: 500 }), () => new Date(o.at ?? "2026-09-25T16:05:00+09:00"));
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ push, generator: gen, quotes, indices, search: new FakeSearchProvider([AAPL]), calendar: calendar as never }),
      logger: false,
      receiptDelayMs: 0,
      now: () => new Date(o.at ?? "2026-09-25T16:05:00+09:00"),
    });
    // 모델 설명(플래그 accountBriefingLlm, 기본 꺼짐)의 검사를 시험하려고 켠다. 기본값 경로는 llm:false 로 따로 본다
    if (o.llm !== false) await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accountBriefingLlm: true } });
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
    expect(push.sent[0]!.body).toBe("기여 1위 애플 -18,089원 · 2위 삼성전자 -12,000원\n종목 브리핑 3종목 · 변동 상위 SK하이닉스 +1.99% · 삼성전자 -1.65%");
    expect(push.sent[0]!.data).toMatchObject({ type: "briefing", digest: true, count: 3, accountBriefingId: b.id });
    expect(accountCalls(gen)).toBe(1);

    const detail = (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json();
    const d = detail.data as AccountData;
    expect(d.contributions.reduce((a, c) => a + c.amount, 0) + (d.others?.amount ?? 0)).toBe(d.dayPnl);
    expect(d.fx.status).toBe("computed");
    expect(d.fx.priceEffect! + d.fx.fxEffect!).toBe(d.fx.usdHoldingsKrwChange!);
    expect(d.krPreviousDay).toBe(false);
    expect(d.usPreviousDay).toBe(false);
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
    expect(d.data.narrative).toEqual({ source: "template", reason: "입력에 없는 숫자: 12만" });
    expect(d.detail).toContain("당일 손익은 -16,589원");
    expect(d.detail).not.toContain("12만");

    gen.mode = "fail";
    await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon", force: true } });
    b = (await list())[0]!;
    d = (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json();
    expect(b).toMatchObject({ status: "ok", template: true });
    expect(d.data.narrative.reason).toMatch(/^모델 호출 실패/);
  });

  it("기본값(accountBriefingLlm 꺼짐)에서는 모델을 부르지 않고 숫자로 만든 기본 문장만 쓴다. 켜면 모델 설명", async () => {
    const { gen, push } = await setup({ llm: false });
    expect((await app.inject({ method: "GET", url: "/api/features" })).json().features).toMatchObject({ accountBriefing: true, accountBriefingLlm: false });
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    const b = (await list())[0]!;
    expect(b).toMatchObject({ status: "ok", template: true, model: "template" });
    expect(accountCalls(gen)).toBe(0);
    const d = (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json();
    expect(d.data.narrative).toEqual({ source: "template", reason: "모델 설명 꺼짐" });
    expect(d.detail).toContain("당일 손익은 -16,589원");
    // 숫자·알림은 그대로 (설명 문단만 기본 문장)
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.title).toBe("오후 계좌 브리핑 · 당일 -16,589원 (-0.65%)");

    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accountBriefingLlm: true } });
    await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon", force: true } });
    expect(accountCalls(gen)).toBe(1);
    expect((await list())[0]).toMatchObject({ template: false, model: "fake-model" });
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

  it("가짜 모델이 숫자를 바꿔 쓰거나 권유·전망을 쓰면 모두 기본 문장 (source=template), 표기 그대로 옮기면 모델 설명", async () => {
    const gen = new AccountGen();
    gen.mode = "text";
    await setup({ gen });
    // 실제: 당일 -16,589원 (-0.65%), 애플 -18,089원 (-1.59%), SK하이닉스 +13,500원 (+1.99%), 삼성전자 -12,000원 (-1.65%)
    const run = async (text: string) => {
      gen.text = text;
      await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon", force: true } });
      const b = (await list())[0]!;
      return (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json() as { detail: string; data: AccountData };
    };
    const rejected: Array<[string, string]> = [
      ["- 당일 손익은 +16,589원 이익입니다.", "입력에 없는 숫자: +16,589원"],
      ["- 애플이 약 2% 내렸습니다.", "입력에 없는 숫자: 2%"],
      ["- 애플이 3% 하락했습니다.", "입력에 없는 숫자: 3%"],
      ["- 삼성전자가 20% 하락했습니다.", "입력에 없는 숫자: 20%"],
      ["- 당일 손익은 -16,5890원입니다.", "숫자 표기가 틀림: -16,5890원"],
      ["- 애플 비중을 줄이는 것이 좋겠습니다.", "쓰지 않는 표현: 비중"],
      ["- 추가 상승이 예상됩니다.", "쓰지 않는 표현: 예상"],
      ["- SK하이닉스는 반등할 가능성이 큽니다.", "쓰지 않는 표현: 반등"],
      ["- 애플은 팔 때입니다.", "쓰지 않는 표현: 팔 때"],
      // 2차 검증: 3종목 보유인데 지어낸 개수·주식 수·연속일·공시 건수
      ["- 보유 9종목입니다.", "입력에 없는 숫자: 9종목"],
      ["- 애플 5주가 움직였습니다.", "입력에 없는 숫자: 5주"],
      ["- 3일 연속 하락했습니다.", "입력에 없는 숫자: 3일 연속"],
      ["- 공시 7건이 나왔습니다.", "입력에 없는 숫자: 7건"],
      ["- 애플은 2거래일째 내렸습니다.", "입력에 없는 숫자: 2거래일째"],
      // 부호 없이 말로 뒤집은 방향 (실제 애플 -1.59%, 당일 -16,589원)
      ["- 애플이 1.59% 올랐습니다.", "방향이 사실과 반대: 1.59% 올랐"],
      ["- 당일 손익은 16,589원 이익입니다.", "방향이 사실과 반대: 16,589원 이익"],
      ["- 계좌는 0.65% 상승했습니다.", "방향이 사실과 반대: 0.65% 상승"],
      // 권유·행동 제안·전망
      ["- 지금 사세요.", "쓰지 않는 표현: 세요"],
      ["- 애플은 파세요.", "쓰지 않는 표현: 세요"],
      ["- 차익 실현을 검토해 보세요.", "쓰지 않는 표현: 차익"],
      ["- 애플을 처분하는 것이 바람직합니다.", "쓰지 않는 표현: 처분"],
      ["- 애플을 줄여 나가시길 권장드립니다.", "쓰지 않는 표현: 시길"],
      ["- 저가 매집 기회입니다.", "쓰지 않는 표현: 매집"],
      ["- 앞으로 코스피가 더 떨어질 것으로 보입니다.", "쓰지 않는 표현: 앞으로"],
      ["- 내일도 하락세가 이어질 수 있습니다.", "쓰지 않는 표현: 내일"],
      // 3차 검증: 굵은 글씨·따옴표·화살표·전각·말로 적은 부호로 뒤집은 부호 (실제 당일 -16,589원 (-0.65%), SK하이닉스 +13,500원)
      ["- 당일 손익은 **+16,589원**입니다.", "입력에 없는 숫자: +16,589원"],
      ["- 당일 손익은 `+16,589원`입니다.", "입력에 없는 숫자: +16,589원"],
      ['- 당일 손익은 "+16,589원"입니다.', "입력에 없는 숫자: +16,589원"],
      ["- 당일 손익은 ‘+16,589원’입니다.", "입력에 없는 숫자: +16,589원"],
      ["- 당일 손익은 _+16,589원_입니다.", "입력에 없는 숫자: +16,589원"],
      ["- 계좌 등락률은 →+0.65%입니다.", "입력에 없는 숫자: +0.65%"],
      ["- SK하이닉스는 **-13,500원**을 보탰습니다.", "입력에 없는 숫자: -13,500원"],
      ["- 당일 손익은 ＋１６，５８９원입니다.", "입력에 없는 숫자: +16,589원"],
      ["- SK하이닉스는 −13,500원입니다.", "입력에 없는 숫자: -13,500원"],
      ["- 당일 손익은 플러스 16,589원입니다.", "입력에 없는 숫자: 플러스 16,589원"],
      ["- 당일 손익은 ▲16,589원입니다.", "입력에 없는 숫자: ▲16,589원"],
      ["- 애플은 1.59%↑ 움직였습니다.", "방향이 사실과 반대: 1.59% ↑"],
      ["- 당일 손익은 -16 589원입니다.", "숫자 표기가 틀림: 16 589원"],
      ["- 당일 손익은 마이너스 만 육천 원입니다.", "입력에 없는 숫자: 만 육천 원"],
      // 4차 검증: HTML 엔티티, 부호 뒤 꾸밈, 모르는 부호 모양 (실제 당일 -16,589원, SK하이닉스 +13,500원, 애플 -1.59%)
      ["- 당일 손익은 &plus;16,589원입니다.", "쓰지 않는 표기: &plus;"],
      ["- SK하이닉스는 &minus;13,500원입니다.", "쓰지 않는 표기: &minus;"],
      ["- 당일 손익은 **+** 16,589원입니다.", "입력에 없는 숫자: +16,589원"],
      ["- 애플은 ▴1.59%입니다.", "입력에 없는 숫자: ▴1.59%"],
      // 4차 검증: 넓힌 방향 낱말, 부호를 뺀 숫자
      ["- 애플은 1.59% 강세, SK하이닉스는 1.99% 약세입니다.", "방향이 사실과 반대: 1.59% 강세, 1.99% 약세"],
      ["- 애플에서 18,089원 이득, SK하이닉스에서 13,500원 손해입니다.", "방향이 사실과 반대: 18,089원 이득, 13,500원 손해"],
      ["- 당일 손익은 16,589원 흑자입니다.", "방향이 사실과 반대: 16,589원 흑자"],
      ["- 애플은 1.59% 빠지며 약세였습니다.", "부호가 빠진 숫자: 1.59%"],
      // 4차 검증: 한글로 적은 기간·개수, 권유·전망
      ["- 애플은 이틀 연속 하락했습니다.", "입력에 없는 숫자: 이틀 연속"],
      ["- 보유 종목 가운데 두 종목이 내렸습니다.", "입력에 없는 숫자: 두 종목"],
      ["- 애플을 팔고 삼성전자를 사는 것이 낫습니다.", "쓰지 않는 표현: 팔고"],
      ["- 코스피는 곧 회복할 것입니다.", "쓰지 않는 표현: 곧"],
      ["- 애플은 더 내려갈 것 같습니다.", "쓰지 않는 표현: 내려갈"],
    ];
    for (const [text, reason] of rejected) {
      const d = await run(text);
      expect(d.data.narrative, text).toEqual({ source: "template", reason });
      expect(d.detail).toContain("- 오후 기준 당일 손익은 -16,589원(-0.65%)입니다.");
      expect(d.detail).not.toContain(text.slice(2)); // 모델 문장은 화면에 나가지 않는다
    }
    const ok = await run("- 당일 손익은 -16,589원 (-0.65%)입니다.\n- 보유 3종목 가운데 1위는 애플(-18,089원, -1.59%), 2위는 SK하이닉스(+13,500원)입니다.\n- 애플은 -1.59% 내렸습니다.\n- 미국 정규장은 9/25 22:30(한국 시간)에 열립니다.");
    expect(ok.data.narrative).toEqual({ source: "llm", reason: null });
    // 괄호 안에 부호를 적은 기여 두 개 뒤의 '손실을 줄였'은 그 숫자들의 방향으로 가져오지 않는다
    const reduced = await run("- SK하이닉스(+13,500원)가 손실을 일부 줄였지만 애플(-18,089원)이 1위였습니다.");
    expect(reduced.data.narrative).toEqual({ source: "llm", reason: null });
    // 꾸밈이 붙어도 부호·방향이 사실과 같으면 모델 설명
    const decorated = await run("- 당일 손익은 **-16,589원**(→-0.65%)입니다.\n- SK하이닉스는 `+13,500원`, 애플은 ▼18,089원입니다.\n- 애플은 1.59%↓ 내렸습니다.");
    expect(decorated.data.narrative).toEqual({ source: "llm", reason: null });
    expect(decorated.detail).toContain("**-16,589원**");
  });

  it("5차 검증: 안쪽 글머리표로 숨긴 부호·개수 말 없는 한글 수·의무/평가/예측 표현·현재형 끝맺음·지어낸 이유는 가짜 모델에서도 기본 문장 (source=template)", async () => {
    const gen = new AccountGen();
    gen.mode = "text";
    await setup({ gen });
    // 실제: 당일 -16,589원 (-0.65%), 애플 -18,089원 (-1.59%), SK하이닉스 +13,500원 (+1.99%), 삼성전자 -12,000원 (-1.65%). 오른 종목 1, 내린 종목 2
    const run = async (text: string) => {
      gen.text = text;
      await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon", force: true } });
      const b = (await list())[0]!;
      return (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json() as { detail: string; data: AccountData };
    };
    const rejected: Array<[string, string]> = [
      ["- 기여 순서\n  - - 18,089원 보탬이 된 애플\n  - + 13,500원 발목을 잡은 SK하이닉스", "부호가 빠진 숫자: 18,089원, 13,500원"],
      ["- 오른 종목은 둘, 내린 종목은 하나입니다.\n- 애플은 일주일 만에 가장 크게 움직였습니다.", "입력에 없는 숫자: 둘, 하나, 일주일"],
      ["- 애플 보유량을 줄여야 합니다.", "쓰지 않는 표현: 야 합"],
      ["- 분산 투자가 중요합니다.", "쓰지 않는 표현: 중요"],
      ["- 애플은 저평가 상태라 보유할 가치가 있습니다.", "쓰지 않는 표현: 저평가"],
      ["- 코스피는 머지않아 회복합니다.", "쓰지 않는 표현: 머지않"],
      ["- 애플은 다시 오릅니다.", "쓰지 않는 표현: 문장 끝 '오릅니다'"],
      ["- 당일 손익은 -16,589원이었습니다?", "쓰지 않는 표현: 물음표"],
      ["- SK하이닉스(+13,500원)는 HBM 수주 소식에 올랐습니다.", "쓰지 않는 표현: 수주"],
      ["- 애플 손실 +18,089원이었습니다.", "입력에 없는 숫자: +18,089원"],
      ["- SK하이닉스 손실 +13,500원이었습니다.", "방향이 사실과 반대: +13,500원 손실"],
    ];
    for (const [text, reason] of rejected) {
      const d = await run(text);
      expect(d.data.narrative, text).toEqual({ source: "template", reason });
      expect(d.detail).toContain("- 오후 기준 당일 손익은 -16,589원(-0.65%)입니다.");
    }
    // 과거형 설명·일정 문장은 그대로 모델 설명
    const ok = await run("- 당일 손익은 -16,589원 (-0.65%)이었습니다.\n- 1위 애플(-18,089원)이 계좌를 끌어내렸고 SK하이닉스(+13,500원)가 일부를 메웠습니다.\n- 환율 효과는 당일 손익과 따로 봅니다.\n- 미국 정규장은 9/25 22:30(한국 시간)에 열립니다.");
    expect(ok.data.narrative).toEqual({ source: "llm", reason: null });
  });

  it("관리용 계좌 브리핑 실행은 그 세션 시각 전이면 409 — 아직 오지 않은 세션을 미리 만들어 두면 예약 실행이 건너뛰어 그 값으로 굳는다", async () => {
    const { push } = await setup({ at: "2026-09-25T11:00:00+09:00" });
    const early = await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon", force: true } });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("TOO_EARLY");
    expect(await list()).toEqual([]);
    // 이미 지난 오전 세션은 만든다 (알림 없음)
    expect((await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "morning" } })).statusCode).toBe(200);
    expect((await list()).map((b) => b.session)).toEqual(["morning"]);
    expect(push.sent).toHaveLength(0);
    // 설정에서 오후 시각을 앞당기면 그 뒤로는 만든다
    await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { afternoonTime: "10:30" } });
    expect((await app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon" } })).statusCode).toBe(200);
  });

  it("지난밤 미국만 평일 휴장(추수감사절 다음 날 오전): 미국 등락이 직전 거래일 것임을 요약·알림·사실·기본 문장에 밝힌다", async () => {
    const gen = new AccountGen();
    gen.mode = "fail"; // 기본 문장도 확인
    const { push } = await setup({ gen, at: "2026-11-27T08:30:00+09:00" });
    await app.briefingService.runSession("morning", { trigger: "schedule" });
    const b = (await list())[0]!;
    expect(b).toMatchObject({ date: "2026-11-27", session: "morning" });
    expect(b.headline).toMatchObject({ usPreviousDay: true });
    expect(b.headline).not.toHaveProperty("krPreviousDay");
    expect(b.summary.split("\n")[2]).toBe(US_PREVIOUS_DAY_NOTE);
    expect(US_PREVIOUS_DAY_NOTE).toBe("지난밤 미국 휴장 · 미국 종목은 직전 거래일 등락");
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.body.split("\n")).toContain(US_PREVIOUS_DAY_NOTE);
    const d = (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json() as { detail: string; data: AccountData };
    expect(d.data.usPreviousDay).toBe(true);
    expect(d.detail).toContain("지난밤 미국은 휴장이라 미국 종목의 당일 손익은 직전 거래일 등락입니다");
    expect(factsText(d.data)).toContain("참고: 지난밤 미국은 휴장이라");
  });

  it("한국만 휴장인 날: 국내 등락이 직전 거래일 것임을 요약·알림·사실에 밝힌다 (당일 손익은 앱 잔고 화면과 같은 기준 그대로)", async () => {
    const { push, gen } = await setup({ holiday: "kr" });
    const r = await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    expect(r.results.filter((x) => x.status === "skipped").map((x) => x.code).sort()).toEqual(["000660", "005930"]);
    const b = (await list())[0]!;
    expect(b.headline).toMatchObject({ dayPnl: -16_589, krPreviousDay: true });
    expect(b.summary.split("\n")).toEqual(["당일 -16,589원 (-0.65%) · 기여 1위 애플 -18,089원", `총 평가금액 ${b.headline.totalValue.toLocaleString("ko-KR")}원 · 환율 효과 +4,259원`, "오늘 한국 휴장 · 국내 종목은 직전 거래일 등락"]);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.body).toBe("기여 1위 애플 -18,089원 · 2위 삼성전자 -12,000원\n오늘 한국 휴장 · 국내 종목은 직전 거래일 등락\n종목 브리핑 1종목 · 변동 상위 애플 -1.59%");
    const d = (await app.inject({ method: "GET", url: `/api/account-briefings/${b.id}` })).json().data as AccountData;
    expect(d.krPreviousDay).toBe(true);
    expect(gen.requests.find((q) => q.label === "account_briefing")!.user).toContain("참고: 오늘 한국은 휴장이라");
  });

  it("모든 종목의 알림을 끈 사용자에게는 계좌 요약만 담은 알림도 보내지 않는다 (예전처럼 0건), 일부만 끄면 1건", async () => {
    const gen = new AccountGen();
    gen.failStocks = true; // 종목 브리핑이 모두 실패해 알릴 종목이 없는 세션
    const { push } = await setup({ gen });
    await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { mutedCodes: ["000660", "005930", "AAPL"] } });
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    expect(await list()).toHaveLength(1); // 계좌 브리핑은 만든다 (브리핑 탭에서 볼 수 있게)
    expect(push.sent).toHaveLength(0);
    await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { mutedCodes: ["000660", "005930"] } });
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", force: true } });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.title).toMatch(/^오후 계좌 브리핑 · 당일 /);
  });

  it("관리용 계좌 브리핑 실행이 도는 중에 종목 실행이 끝나면 기다렸다가 그 계좌 브리핑을 알림 앞머리로 쓴다 ('이미 만드는 중' 오류로 빠지지 않게)", async () => {
    const gen = new AccountGen();
    let release!: () => void;
    gen.gate = new Promise((r) => (release = r));
    await setup({ gen });
    const admin = app.inject({ method: "POST", url: "/api/account-briefings/run", payload: { session: "afternoon" } });
    await expect.poll(() => accountCalls(gen)).toBe(1);
    // 종목 실행이 끝난 순간 (BriefingService.onRunDone → afterRun)
    const after = app.accountBriefings.afterRun({ session: "afternoon", date: "2026-09-25", partial: false, force: false, results: [{ status: "ok" }] });
    release();
    const [b, res] = await Promise.all([after, admin]);
    expect(res.statusCode).toBe(200);
    expect(b).toMatchObject({ status: "ok", session: "afternoon", date: "2026-09-25", id: res.json().briefing.id });
    expect(accountCalls(gen)).toBe(1); // 다시 만들지 않는다
  });

  it("위젯 응답(accountIds): 플래그가 켜져 있으면 최근 계좌 브리핑 id 를 넣어 앱 백그라운드 알림이 알아보게, 끄면 넣지 않는다", async () => {
    await setup();
    expect((await app.inject({ method: "GET", url: "/api/widget" })).json()).not.toHaveProperty("accountIds");
    await app.briefingService.runSession("afternoon", { trigger: "schedule" });
    const id = (await list())[0]!.id;
    expect((await app.inject({ method: "GET", url: "/api/widget" })).json().accountIds).toEqual([id]);
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { accountBriefing: false } });
    expect((await app.inject({ method: "GET", url: "/api/widget" })).json()).not.toHaveProperty("accountIds");
  });
});

describe("기여 1위는 당일 손익과 같은 방향 (2026-09-25 캡처: 오른 날 '기여 1위 애플 -171,154원')", () => {
  const row = (name: string, amount: number) => ({ code: name, name, currency: "KRW" as const, amount, changeRate: 0, value: 0 });
  it("오른 날은 올린 종목, 내린 날은 내린 종목만 크기 순. 0 이면 크기 순 그대로", () => {
    const contributions = [row("애플", -171_154), row("엔비디아", 169_763), row("퀀티넘", 148_403), row("SK하이닉스", -81_000)];
    expect(leaders({ dayPnl: 423_788, contributions }).map((r) => r.name)).toEqual(["엔비디아", "퀀티넘"]);
    expect(leaders({ dayPnl: -5_000, contributions }).map((r) => r.name)).toEqual(["애플", "SK하이닉스"]);
    expect(leaders({ dayPnl: 0, contributions }).map((r) => r.name)).toEqual(["애플", "엔비디아", "퀀티넘", "SK하이닉스"]);
  });
});

describe("평가손익은 앱 잔고 합계와 같은 반올림 (통합 리뷰)", () => {
  it("평가 1,000,000.6원 · 매입 900,000.4원 → 100,001원 (한 번에 반올림한 100,000원이 아님)", () => {
    const h = holding("005930", "삼성전자", 0, { qty: 1, price: 1_000_000.6 });
    const a = computeAccount([{ ...h, evaluation: { ...h.evaluation, marketValue: 1_000_000.6, costBasis: 900_000.4 } }], { afterCost: false });
    expect(a.totalValue).toBe(1_000_001);
    expect(a.totalCost).toBe(900_000);
    expect(a.totalProfit).toBe(a.totalValue - a.totalCost);
  });
});
