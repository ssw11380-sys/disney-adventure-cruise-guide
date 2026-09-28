import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JournalItem, JournalResponse, JournalReturns, JournalTax } from "@/api/types";
import {
  afterBuyText,
  calcRows,
  clampNote,
  customRangeError,
  dayHeader,
  dayHeadSpeech,
  dayRealizedText,
  detailLine,
  detailRows,
  noteResultText,
  noteUnchanged,
  speakTime,
  detailTime,
  extraLines,
  headLines,
  journalHref,
  journalTabs,
  krTaxLine,
  pendingStart,
  periodRange,
  perSellNone,
  qtyText,
  realizedText,
  returnLineLabels,
  returnsHeader,
  returnsLines,
  returnsMethod,
  returnsNotReady,
  returnsSpeech,
  rowSpeech,
  summaryView,
  beforeRecordNote,
  taxItemLines,
  taxRefetch,
  taxView,
  timeText,
  titleText,
  TAX,
  JOURNAL,
} from "@/lib/journal";

/**
 * 매매일지 (3-37) 앱 글 — 줄 글·화면 읽기 문장·기간·수익률·양도세 글. 순수 함수, 고정 값 (예시 — 실제 계좌와 무관)
 */

const soxlSell: JournalItem = {
  key: "3:o3:0",
  kind: "fill",
  account: 3,
  accountLabel: null,
  orderId: "o3",
  code: "SOXL",
  name: "SOXL",
  market: "US",
  currency: "USD",
  side: "SELL",
  quantity: 5,
  orderQuantity: 5,
  amount: 187.5,
  price: 37.5,
  at: "2026-09-25T23:10:04+09:00",
  timeBasis: "filled",
  status: "CLOSED",
  part: null,
  realized: {
    status: "ok",
    reason: null,
    basis: "history-checked",
    anchorDate: "2026-09-25",
    avgCost: 34.0133,
    costAmount: 170.07,
    gross: 17.43,
    rate: 10.25,
    costs: { fee: null, tax: null, total: null, source: null },
    net: null,
    krw: { gross: 24_703, costKrw: 235_809, sellFx: 1389.4, fxSource: "toss", estimated: true, reason: null },
  },
  note: "실적 발표 뒤 일부 정리",
};
const krBuyPart: JournalItem = {
  ...soxlSell,
  key: "3:b1:1",
  orderId: "b1",
  code: "TSLA",
  name: "테슬라",
  side: "BUY",
  quantity: 2,
  orderQuantity: 5,
  amount: 604,
  price: 302,
  at: "2026-09-28T23:41:00+09:00",
  part: { index: 2, count: 2 },
  status: "OPEN",
  realized: null,
  afterBuy: { avgCost: 300, quantity: 2.5 },
  note: null,
};

describe("위 탭 이름", () => {
  it("'양도세 추정'이 한 칸에 안 들어가는 좁은 폭 × 큰 글씨에서만 '양도세' (글자 중간 줄바꿈 막기)", () => {
    const tax = (w: number, s: number) => journalTabs(w, s).find((t) => t.value === "tax")!.label;
    expect(journalTabs(360, 1).map((t) => t.label)).toEqual(["기록", "수익률", "양도세 추정"]);
    expect(tax(360, 1.3)).toBe("양도세 추정");
    expect(tax(360, 2)).toBe("양도세");
    expect(tax(475, 1.3)).toBe("양도세 추정");
    expect(tax(475, 2)).toBe("양도세");
    expect(tax(933, 2)).toBe("양도세 추정");
  });
});

describe("기간 고르기", () => {
  it("1주·1달·3달·올해·1년 (서버와 같은 규칙) · 직접 고른 기간 검증", () => {
    expect(periodRange("1W", "2026-09-28")).toEqual({ from: "2026-09-21", to: "2026-09-28" });
    expect(periodRange("1M", "2026-09-28")).toEqual({ from: "2026-08-28", to: "2026-09-28" });
    expect(periodRange("3M", "2026-05-31")).toEqual({ from: "2026-02-28", to: "2026-05-31" });
    expect(periodRange("YTD", "2026-09-28")).toEqual({ from: "2026-01-01", to: "2026-09-28" });
    expect(periodRange("1Y", "2026-09-28")).toEqual({ from: "2025-09-28", to: "2026-09-28" });
    expect(customRangeError("2026-09-01", "2026-09-28")).toBeNull();
    expect(customRangeError("2026-09-28", "2026-09-01")).toBe("시작이 끝보다 늦어요.");
    expect(customRangeError("2025-01-01", "2026-09-28")).toBe("기간은 400일까지 고를 수 있어요.");
  });
});

describe("기록 줄 글", () => {
  it("시각 세 가지: 체결 시각 · 주문 시각 · 확인 시각(그 전) — 한국 시간", () => {
    expect(timeText({ at: "2026-09-25T14:10:04Z", timeBasis: "filled" })).toBe("23:10");
    expect(timeText({ at: "2026-09-25T22:31:00+09:00", timeBasis: "ordered" })).toBe("주문 22:31");
    expect(timeText({ at: "2026-09-29T05:05:00+09:00", timeBasis: "seen" })).toBe("9/29 05:05 전");
    expect(detailTime(soxlSell)).toBe("2026년 9월 25일 23:10:04");
    expect(detailTime({ at: "2026-09-25T22:31:00+09:00", timeBasis: "ordered" })).toBe("주문 시각 9월 25일 22:31 · 체결 시각 없음");
  });

  it("매도: '5주 · 평균 $37.50 · 23:10 · 판매 금액 $187.50', 오른쪽 '+$17.43 (+10.25%)', 셋째 줄 메모", () => {
    expect(detailLine(soxlSell)).toBe("5주 · 평균 $37.50 · 23:10 · 판매 금액 $187.50");
    expect(realizedText(soxlSell)).toBe("+$17.43 (+10.25%)");
    expect(extraLines(soxlSell)).toEqual(["메모: 실적 발표 뒤 일부 정리"]);
    expect(dayHeader("2026-09-25")).toBe("9월 25일 (금)");
  });

  it("며칠에 걸친 몫·진행 중 주문 · 계좌가 둘 이상이면 앞에 계좌", () => {
    expect(detailLine(krBuyPart)).toBe("이 날 2주 (주문 5주 중) · 평균 $302.00 · 23:41 · 일부 체결 (진행 중)");
    expect(detailLine({ ...krBuyPart, accountLabel: "계좌 2", part: null, status: "CLOSED" })).toBe("계좌 2 · 2주 · 평균 $302.00 · 23:41");
    expect(afterBuyText(krBuyPart)).toBe("이 매수 뒤 평균 구매가 $300.00 · 2.5주");
    expect(qtyText(16.1234440001)).toBe("16.123444주");
    expect(qtyText(1234)).toBe("1,234주");
  });

  it("모름·순서 추정·추정: 오른쪽 꼬리표 + 셋째 줄에 서버가 준 까닭", () => {
    const unknown = { ...soxlSell, note: null, realized: { ...soxlSell.realized!, status: "unknown-cost" as const, gross: null, rate: null, reason: "기록 시작 전에 산 몫이라 평균 구매가를 몰라요." } };
    expect(realizedText(unknown)).toBe("실현손익 모름");
    expect(extraLines(unknown)).toEqual(["기록 시작 전에 산 몫이라 평균 구매가를 몰라요."]);
    const unsure = { ...soxlSell, realized: { ...soxlSell.realized!, status: "order-uncertain" as const, reason: "같은 날 사고판 순서를 몰라 추정했어요." } };
    expect(realizedText(unsure)).toBe("+$17.43 (+10.25%) · 순서 추정");
    expect(extraLines(unsure)).toEqual(["같은 날 사고판 순서를 몰라 추정했어요.", "메모: 실적 발표 뒤 일부 정리"]);
  });

  it("추정 줄: '[추정] NAVER 수량 +10주' · 분할 '1→4' · 병합 '4→1'", () => {
    const est: JournalItem = { ...soxlSell, kind: "estimated", side: null, name: "NAVER", realized: null, note: null, estimated: { qty: 10, reason: "transfer" } };
    expect(titleText(est)).toBe("[추정] NAVER 수량 +10주");
    expect(detailLine(est)).toBe(JOURNAL.estimatedSub);
    expect(titleText({ ...est, estimated: { qty: 27, reason: "split", ratio: 4 } })).toBe("[추정] NAVER 주식 수 변화 (분할 추정 1→4)");
    expect(titleText({ ...est, estimated: { qty: -27, reason: "split", ratio: 0.25 } })).toBe("[추정] NAVER 주식 수 변화 (병합 추정 4→1)");
    expect(titleText({ ...est, estimated: { qty: -3, reason: "transfer" } })).toBe("[추정] NAVER 수량 −3주");
  });

  it("화면 읽기 한 줄 한 문장 (설계 §4.3 예시)", () => {
    expect(rowSpeech(soxlSell)).toBe("9월 25일 오후 11시 10분, SOXL 5주 매도, 평균 37.50달러, 판매 금액 187.50달러, 실현손익 17.43달러 이익, 10.25퍼센트, 메모 있음");
    expect(rowSpeech(krBuyPart)).toBe("9월 28일 오후 11시 41분, 테슬라 이 날 2주, 주문 5주 중 매수, 평균 302.00달러, 산 금액 604.00달러, 일부 체결, 진행 중");
    expect(rowSpeech({ ...soxlSell, note: null, timeBasis: "seen", at: "2026-09-29T05:05:00+09:00", realized: { ...soxlSell.realized!, status: "unknown-cost", gross: null, rate: null } })).toBe(
      "9월 29일 오전 5시 5분 전 확인, SOXL 5주 매도, 평균 37.50달러, 판매 금액 187.50달러, 실현손익 모름",
    );
  });
});

describe("요약·날짜 묶음", () => {
  const resp: JournalResponse = {
    enabled: true,
    from: "2026-09-01",
    to: "2026-09-28",
    recordSince: "2026-09-23",
    summary: {
      orders: 8,
      buys: 5,
      sells: 3,
      realized: { KRW: 45_000, USD: 17.43, krwTotal: 69_703, krwTotalEstimated: true, estimatedIncluded: false },
      costs: { toss: 0, estimated: 2, none: 1 },
      unknownSells: 1,
      truncated: [],
    },
    days: [],
    stocks: [],
  };
  it("국내·미국(원화 약, 추정)·합계 약 · 건수 · 비용 안내 · 모름 건수 (설계 §4.3 카드)", () => {
    expect(summaryView(resp)).toEqual({
      range: "9월 1일 ~ 9월 28일",
      lines: [
        { label: "국내", value: "+45,000원", sign: 1, speech: "국내 실현손익 45,000원 이익" },
        { label: "미국", value: "+$17.43 (원화 약 +24,703원, 추정)", sign: 1, speech: "미국 실현손익 17.43달러 이익, 원화 약 24,703원 이익, 추정" },
        { label: "합계", value: "약 +69,703원", sign: 1, speech: "합계 실현손익 약 69,703원 이익" },
      ],
      counts: "매수 5건 · 매도 3건 · 체결 8건",
      notes: [JOURNAL.grossNote, "실현손익을 모르는 매도 1건은 합계에서 뺐어요 (기록 시작 전에 산 몫)."],
    });
    expect(beforeRecordNote(resp)).toBe("9월 23일부터 저장한 기록이에요. 그 전 체결은 토스에서 받아 온 것만 있어요.");
    expect(beforeRecordNote({ ...resp, from: "2026-09-24" })).toBeNull();
    // 회귀: 종목을 골랐으면 머리 카드의 '기록 시작' 줄과 같은 말이라 두 번 쓰지 않는다
    expect(beforeRecordNote({ ...resp, code: "TQQQ" })).toBeNull();
  });

  it("날짜 머리 오른쪽: 통화가 섞이면 둘 다, 매도가 없으면 없음", () => {
    expect(dayRealizedText({ KRW: 45_000, USD: 17.43, krwTotal: null, krwTotalEstimated: true })).toBe("실현 +45,000원 · +$17.43");
    expect(dayRealizedText({ KRW: null, USD: -1.2, krwTotal: null, krwTotalEstimated: true })).toBe("실현 -$1.20");
    expect(dayRealizedText({ KRW: null, USD: null, krwTotal: null, krwTotalEstimated: false })).toBeNull();
  });

  it("회귀: 날짜 머리 화면 읽기는 읽는 말로 (기호·부호를 그대로 읽지 않는다)", () => {
    expect(dayHeadSpeech("2026-09-23", { KRW: -321_000, USD: 17.43, krwTotal: null, krwTotalEstimated: true })).toBe("9월 23일 수요일, 실현손익 321,000원 손실, 17.43달러 이익");
    expect(dayHeadSpeech("2026-09-23", { KRW: null, USD: null, krwTotal: null, krwTotalEstimated: false })).toBe("9월 23일 수요일");
  });
});

describe("거래 상세", () => {
  it("실현손익 계산: 판매 금액 − 평균 구매가 × 수량 = 실현손익, 수수료·세금, 원화로는 (§4.4)", () => {
    const c = calcRows(soxlSell);
    expect(c.rows).toEqual([
      { label: "판매 금액", value: "$187.50", speech: "판매 금액 187.50달러" },
      { label: "− 평균 구매가 $34.0133 × 5주", value: "$170.07", speech: "빼는 금액, 평균 구매가 34.0133달러 곱하기 5주, 170.07달러" },
      { label: "= 실현손익", value: "+$17.43 (+10.25%)", sign: 1, speech: "실현손익 17.43달러 이익, 10.25퍼센트" },
      { label: "수수료·세금", value: "토스가 주지 않아 빼지 않았어요", speech: "수수료·세금, 토스가 주지 않아 빼지 않았어요" },
      { label: "원화로는", value: "약 +24,703원 (추정)", sign: 1, speech: "원화로는 약 24,703원 이익, 추정" },
    ]);
    expect(c.notes).toEqual([
      "판매 때 환율 1,389.4원(토스) · 매수 때 환율로 쌓은 원화 평균 구매가 기준",
      JOURNAL.method,
      "주문 내역으로 계산 · 9월 25일 토스 평균 구매가와 맞음",
    ]);
  });

  it("메모 입력은 200자에서 멈춘다 (한글·그림 글자도 글자 수로)", () => {
    expect([...clampNote("가".repeat(250))].length).toBe(200);
    expect(clampNote("짧은 메모")).toBe("짧은 메모");
  });

  it("이 종목 머리 카드", () => {
    expect(
      headLines({
        code: "TSLA",
        name: "테슬라",
        market: "US",
        holding: { quantity: 2.5, avgCost: 300, currency: "USD", asOf: "x" },
        orders: 4,
        buys: 3,
        sells: 1,
        realized: { amount: 62.5, currency: "USD", sells: 1, unknown: 0 },
        firstTrade: "2026-09-01",
        lastTrade: "2026-09-28",
        recordSince: "2026-09-28",
        memo: "장기 보유 목표",
      }),
    ).toEqual(["지금 2.5주 · 평균 구매가 $300.00", "기록된 실현손익 +$62.50 · 매수 3건 · 매도 1건", "기록 시작: 9월 28일 (그 전 거래는 토스에서 받아 온 주문 내역만)"]);
    expect(journalHref({ code: "TSLA" })).toBe("/journal?code=TSLA");
    expect(journalHref({ tab: "tax" })).toBe("/journal?tab=tax");
    expect(journalHref()).toBe("/journal");
  });
});

describe("수익률 글", () => {
  const ready: JournalReturns = {
    enabled: true,
    ready: true,
    recordSince: "2026-09-28",
    tradingDays: 10,
    needDays: 10,
    requested: { from: "2026-01-01", to: "2026-10-12" },
    actual: { from: "2026-09-28", to: "2026-10-12" },
    clippedToRecordStart: true,
    market: "ALL",
    currency: "KRW",
    twr: 3.42,
    pnl: 456_000,
    startValue: 12_340_000,
    endValue: 12_800_000,
    buys: 1_000_000,
    sells: 500_000,
    transfersEstimated: 0,
    gaps: [],
    doubtedSkipped: [],
    priceBasis: { regularClose: 100, priceFallback: 1, fallbackCodes: ["000660"] },
    series: [],
  };
  it("준비 전: 숫자 대신 기록 거래일 안내 (§4.6)", () => {
    expect(returnsNotReady({ enabled: true, ready: false, tradingDays: 3, needDays: 10, recordSince: "2026-09-28" })).toBe(
      "기간 수익률은 매일 장 마감 뒤 찍은 계좌 기록으로 계산해요. 기록이 10거래일 쌓이면 보여 드려요. 지금 3거래일 (9월 28일부터).",
    );
  });
  it("회귀: '지금 N거래일'은 기록 전체 길이(recordDays) — 기록이 충분한데 고른 기간 안 기록이 모자라면 다른 안내 (기록이 짧다고 말하지 않는다)", () => {
    // 기록 6거래일, 1주 안 4거래일 → 기록 전체 6거래일로 안내
    expect(returnsNotReady({ enabled: true, ready: false, tradingDays: 4, recordDays: 6, needDays: 10, recordSince: "2026-09-28" })).toBe(
      "기간 수익률은 매일 장 마감 뒤 찍은 계좌 기록으로 계산해요. 기록이 10거래일 쌓이면 보여 드려요. 지금 6거래일 (9월 28일부터).",
    );
    // 기록 40거래일인데 하루만 고름
    const short = returnsNotReady({ enabled: true, ready: false, tradingDays: 1, recordDays: 40, needDays: 10, recordSince: "2026-09-28" });
    expect(short).toBe("고른 기간 안에 계좌 기록이 1거래일뿐이라 수익률을 계산할 수 없어요. 기간을 더 길게 골라 주세요.");
    expect(short).not.toContain("쌓이면");
  });
  it("머리·손익·흐름·당김 문장, 계산 방법은 있을 때만의 줄 포함, 화면 읽기 (§4.6)", () => {
    expect(returnsHeader(ready)).toBe("9월 28일(기록 시작) ~ 10월 12일 · 10거래일");
    expect(returnsLines(ready)).toEqual({
      pnl: "기간 손익 +456,000원",
      pnlSign: 1,
      values: "시작 평가금액 12,340,000원 → 끝 12,800,000원",
      flows: "그 사이 매수 1,000,000원 · 매도 500,000원 (수익률 계산에서 뺐어요)",
      clipped: "고른 기간보다 기록이 짧아 기록 시작일부터 계산했어요.",
    });
    const m = returnsMethod(ready);
    expect(m).toContain("종가가 없는 1종목은 그때 현재가로 계산했어요.");
    expect(m).toContain("미국 종목은 그날 기록의 환율로 원화로 바꿨어요. 환율이 움직인 몫도 들어 있어요.");
    expect(m).toContain("현금 입출금과 배당은 넣지 않았어요. 주식 평가금액만의 수익률이에요.");
    expect(m.some((x) => x.startsWith("빠진 날"))).toBe(false);
    expect(returnsMethod({ ...ready, market: "US", gaps: ["2026-10-01"] })).toEqual(expect.arrayContaining(["빠진 날 1일은 앞뒤를 이어 계산했어요.", "달러 기준이에요. 환율은 넣지 않았어요."]));
    // 회귀: 화면에 보이는 시작→끝 평가금액·그 사이 사고판 금액·기록 시작일부터 계산한 까닭도 읽는다
    expect(returnsSpeech(ready)).toBe(
      "9월 28일부터 10월 12일까지 10거래일, 수익률 시간가중 3.42% 상승, 기간 손익 456,000원 이익, 시작 평가금액 12,340,000원에서 끝 12,800,000원, 그 사이 매수 1,000,000원, 매도 500,000원, 수익률 계산에서 뺐어요, 고른 기간보다 기록이 짧아 기록 시작일부터 계산했어요",
    );
    expect(returnsSpeech({ ...ready, buys: 0, sells: 0, clippedToRecordStart: false })).toBe(
      "9월 28일부터 10월 12일까지 10거래일, 수익률 시간가중 3.42% 상승, 기간 손익 456,000원 이익, 시작 평가금액 12,340,000원에서 끝 12,800,000원",
    );
  });

  it("누적 수익률 선 그림 제목·양 끝 날짜 (점이 2개 이상일 때)", () => {
    expect(returnLineLabels([{ date: "2026-09-28", cum: 0 }, { date: "2026-10-12", cum: 3.42 }])).toEqual({ title: "날짜별 누적 수익률", from: "9월 28일", to: "10월 12일" });
    expect(returnLineLabels([{ date: "2026-09-28", cum: 0 }])).toBeNull();
  });
});

describe("양도세 추정 글", () => {
  const base: JournalTax = {
    enabled: true,
    year: 2026,
    years: [2026],
    rules: { rate: 0.22, nationalRate: 0.2, localRateOfNational: 0.1, deduction: 2_500_000, method: "moving-average", lawYear: 2026 },
    totals: { gains: 4_000_000, losses: -550_000, net: 3_450_000, base: 950_000, nationalTax: 190_000, localTax: 19_000, tax: 209_000, sells: 12 },
    complete: true,
    fxPending: 0,
    excluded: [],
    items: [],
    kr: { securitiesTax: { amount: null, sells: 2, source: null } },
  };
  it("보통: 합계·공제·과세 대상·세율·예상 세액 (§4.7)", () => {
    const v = taxView(base, false)!;
    expect(v.title).toBe("해외주식 양도세 추정 · 2026년");
    expect(v.rows.map((r) => r.speech)).toEqual([
      "양도차익 합계, 이익에서 손실을 뺀 금액, 3,450,000원 이익",
      "기본공제 2,500,000원 빼기",
      "과세 대상 금액 950,000원",
      "세율 22퍼센트, 양도소득세 20퍼센트와 지방소득세 2퍼센트",
      "예상 세액 추정 209,000원",
    ]);
    expect(perSellNone(2026)).toBe("2026년 계산에 넣은 해외주식 매도가 없어요.");
    expect(v.rows.map((r) => [r.label, r.value])).toEqual([
      ["양도차익 합계 (이익 − 손실)", "+3,450,000원"],
      ["기본공제", "-2,500,000원"],
      ["과세 대상 금액", "950,000원"],
      ["세율", "22% (양도소득세 20% + 지방소득세 2%)"],
      ["예상 세액 (추정)", "209,000원"],
    ]);
    expect(v.sub).toBe("이익 +4,000,000원 · 손실 -550,000원 · 매도 12건");
    expect(v.zeroNote).toBeNull();
    expect(v.excluded).toBeNull();
  });
  it("공제 이하 · 손실 · 빠진 매도 · 받는 중(다시 묻기를 다 쓰면 빠진 매도로)", () => {
    expect(taxView({ ...base, totals: { ...base.totals!, net: 2_400_000, base: 0, nationalTax: 0, localTax: 0, tax: 0 } }, false)!.zeroNote).toBe(TAX.underDeduction);
    expect(taxView({ ...base, totals: { ...base.totals!, gains: 0, net: -550_000, base: 0, tax: 0 } }, false)!.rows[0]!.value).toBe("-550,000원 (손실)");
    const ex = taxView({ ...base, complete: false, excluded: [{ code: "TSLA", name: "테슬라", count: 2, reason: "기록 시작 전에 산 몫이라 취득가를 몰라요" }, { code: "SOXL", name: "SOXL", count: 1, reason: "결제일 환율을 받지 못했어요" }] }, false)!;
    expect(ex.excluded).toEqual({ title: "계산에 넣지 못한 매도 3건이 있어 실제와 다를 수 있어요.", lines: ["테슬라 2건 · 기록 시작 전에 산 몫이라 취득가를 몰라요", "SOXL 1건 · 결제일 환율을 받지 못했어요"] });
    const pend = { ...base, complete: false, fxPending: 2 };
    expect(taxView(pend, false)!.pending).toBe("환율을 받는 중이에요 (2건). 잠시 뒤 다시 계산해요.");
    expect(taxView(pend, true)!.pending).toBeNull();
    expect(taxView(pend, true)!.excluded!.title).toBe("계산에 넣지 못한 매도 2건이 있어 실제와 다를 수 있어요.");
  });
  it("받는 중이면 1분마다 다시, 5번에서 멈춘다 (§9 앱-7)", () => {
    const pend = { ...base, fxPending: 1 };
    expect([0, 1, 2, 3, 4].map((n) => taxRefetch(pend, n))).toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
    expect(taxRefetch(pend, 5)).toBe(false);
    expect(taxRefetch(base, 0)).toBe(false);
    expect(taxRefetch(undefined, 0)).toBe(false);
  });
  it("회귀: 다시 묻기 횟수는 '받는 중'이 된 때부터 센다 — 그 전에 쌓인 받은 횟수(앱을 다시 열어 새로 받음)는 세지 않는다", () => {
    const pend = { ...base, fxPending: 1 };
    // 받는 중이 아닌 채 6번 받음 → 기준 없음
    let at: number | null = null;
    for (let n = 1; n <= 6; n++) at = pendingStart(at, base, n);
    expect(at).toBeNull();
    // 7번째 받기에서 새 매도가 받는 중 → 기준 7, 다시 물은 횟수 0 → 다시 묻는다
    at = pendingStart(at, pend, 7);
    expect(at).toBe(7);
    expect(taxRefetch(pend, 7 - at!)).toBe(60_000);
    // 그 뒤 5번 다시 물으면 멈춘다
    for (let n = 8; n <= 12; n++) at = pendingStart(at, pend, n);
    expect(at).toBe(7);
    expect(taxRefetch(pend, 12 - at!)).toBe(false);
    // 받는 중이 끝나면 기준을 지우고, 다시 받는 중이 되면 새로 센다
    expect(pendingStart(at, base, 13)).toBeNull();
    expect(pendingStart(null, pend, 14)).toBe(14);
    // 캐시가 새로 만들어져 받은 횟수가 줄면 새로 센다
    expect(pendingStart(7, pend, 1)).toBe(1);
  });
  it("매도별 계산 두 줄 · 대신한 환율·잠정 표시 · 국내 증권거래세 줄", () => {
    const item = { key: "k", code: "SOXL", name: "SOXL", tradeDate: "2026-09-25", settleDate: "2026-09-29", settleSource: "estimated" as const, quantity: 5, proceedsUsd: 187.5, costsUsd: null, fxSell: { rate: 1389.4, source: "smbs", date: "2026-09-29", provisional: false }, proceedsKrw: 260_512, costKrw: 235_809, costsKrw: null, gainKrw: 24_703 };
    expect(taxItemLines(item)).toEqual(["9/25 SOXL 5주 · 결제일 9/29(추정) · 환율 1,389.40원", "양도가액 260,512원 − 취득가액 235,809원 = +24,703원"]);
    expect(taxItemLines({ ...item, fxSell: { ...item.fxSell, source: "naver-hana", rate: 1388 } })[0]).toBe("9/25 SOXL 5주 · 결제일 9/29(추정) · 환율 1,388.00원(하나은행 고시로 대신)");
    expect(taxItemLines({ ...item, fxSell: { ...item.fxSell, provisional: true } })[0]).toContain("(결제일 전이라 최근 고시)");
    expect(krTaxLine(base)).toBe(TAX.krNoTax);
    expect(krTaxLine({ ...base, kr: { securitiesTax: { amount: 12_345, sells: 2, source: "toss" } } })).toBe("증권거래세(매도할 때 내는 세금): 2026년 -12,345원 (토스 주문 내역)");
  });
});

// ── 문구 검사 ──
const ROOT = fileURLToPath(new URL("../src/", import.meta.url));
/** 매매일지 전용 금지어 (설계 §4.7 끝) — 사실만 적는다 */
const JOURNAL_BANNED = ["절세", "세금을 줄이", "줄이려면", "팔면", "매도하면", "사면", "매수하면", "손실을 확정", "기회", "유리", "추천", "해야 해요"];
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("매매일지 문구 (권유·세금 조언 표현 0건)", () => {
  it("매매일지 화면·부품·글 파일(주석 포함)에 금지어가 없다", () => {
    const targets = [join(ROOT, "lib/journal.ts"), ...files(join(ROOT, "components/journal")), ...files(join(ROOT, "app/journal"))];
    expect(targets.length).toBeGreaterThanOrEqual(5);
    const hits: string[] = [];
    for (const f of targets) {
      const text = readFileSync(f, "utf8");
      for (const w of JOURNAL_BANNED) if (text.includes(w)) hits.push(`${f.slice(ROOT.length)}: ${w}`);
    }
    expect(hits).toEqual([]);
  });

  it("양도세 화면 위 상자와 고지 두 줄이 있다", () => {
    expect(TAX.notice).toBe("참고용 추정이에요. 세금 신고·납부 금액이 아니며, 실제 세금은 홈택스나 세무 전문가에게 확인해 주세요.");
    expect(TAX.notAdvice).toBe("이 화면은 세무 조언이 아니에요.");
    expect(TAX.rules).toHaveLength(6);
  });
});

describe("검토 반영 (3-37 다듬기)", () => {
  it("'체결' 줄 화면 읽기는 읽는 말로 — '9월 25일 오후 11시 10분 4초' (주문 시각·확인 시각도)", () => {
    const rows = (x: JournalItem) => detailRows(x).find((r) => r.label === "체결")!;
    expect(rows(soxlSell)).toMatchObject({ value: "2026년 9월 25일 23:10:04", speech: "체결 9월 25일 오후 11시 10분 4초" });
    expect(speakTime("2026-09-25T23:00:04+09:00", true)).toBe("9월 25일 오후 11시 0분 4초");
    expect(speakTime("2026-09-25T23:10:00+09:00", true)).toBe("9월 25일 오후 11시 10분 0초");
    expect(speakTime("2026-09-25T23:10:04+09:00")).toBe("9월 25일 오후 11시 10분");
    expect(rows({ ...soxlSell, timeBasis: "ordered", at: "2026-09-25T22:31:00+09:00" }).speech).toBe("체결, 주문 시각 9월 25일 오후 10시 31분, 체결 시각 없음");
    expect(rows({ ...soxlSell, timeBasis: "seen", at: "2026-09-29T05:05:00+09:00" }).speech).toBe("체결, 9월 29일 오전 5시 5분 전 확인, 토스가 체결 시각을 주지 않음");
  });

  it("주식 수 변화 추정 줄: 정수 배수는 분할·병합, 그 밖(무상증자 1.5배 등)은 늘어난 수량 + '무상증자·주식배당 등'", () => {
    const est: JournalItem = { ...soxlSell, kind: "estimated", side: null, name: "삼성전자", realized: null, note: null, estimated: { qty: 5, reason: "split", ratio: 1.5 } };
    expect(titleText(est)).toBe("[추정] 삼성전자 주식 수 +5주 (무상증자·주식배당 등)");
    expect(titleText({ ...est, estimated: { qty: -2, reason: "split", ratio: 0.8 } })).toBe("[추정] 삼성전자 주식 수 −2주 (병합 등)");
    expect(titleText({ ...est, estimated: { qty: 30, reason: "split", ratio: 4 } })).toBe("[추정] 삼성전자 주식 수 변화 (분할 추정 1→4)");
    expect(rowSpeech(est)).toContain("추정, 삼성전자 주식 수 +5주 (무상증자·주식배당 등)");
  });

  it("메모 [저장]은 바뀐 것이 있을 때만 (서버처럼 줄바꿈·앞뒤 빈칸 정리 뒤 비교), '메모를 지웠어요.'는 저장한 메모가 있었을 때만", () => {
    expect(noteUnchanged("", null)).toBe(true);
    expect(noteUnchanged("  \n ", null)).toBe(true);
    expect(noteUnchanged(" 실적 발표\n뒤 정리 ", "실적 발표 뒤 정리")).toBe(true);
    expect(noteUnchanged("실적 발표", "실적 발표 뒤 정리")).toBe(false);
    expect(noteUnchanged("", "실적 발표")).toBe(false);
    expect(noteResultText("실적", "실적 발표")).toBe(JOURNAL.noteSaved);
    expect(noteResultText("실적", null)).toBe(JOURNAL.noteDeleted);
    expect(noteResultText(null, null)).toBeNull();
  });

  it("수익률 안내: 전체(원화)에서 미국 기록에 평가 환율이 없으면 그 까닭 · 고른 기간에 기록이 0일이면 기록 시작일과 '기록이 없어요'", () => {
    const usFx = returnsNotReady({ enabled: true, ready: false, tradingDays: 0, recordDays: 30, needDays: 10, recordSince: "2026-09-28", market: "ALL", usFxMissing: true });
    expect(usFx).toBe("미국 계좌 기록에 평가 환율이 없어 전체(원화) 수익률을 계산할 수 없어요. 한국·미국은 따로 볼 수 있어요.");
    expect(usFx).not.toContain("기간을 더 길게");
    const none = returnsNotReady({ enabled: true, ready: false, tradingDays: 0, recordDays: 30, needDays: 10, recordSince: "2026-09-28", requested: { from: "2026-10-03", to: "2026-10-04" }, actual: null });
    expect(none).toBe("고른 기간(10월 3일 ~ 10월 4일)에는 계좌 기록이 없어요. 기록은 9월 28일부터 있고, 주말·휴일과 기록 시작 전 날짜에는 기록이 없어요.");
    expect(none).not.toContain("기간을 더 길게");
    // 1거래일은 지금 안내 그대로
    expect(returnsNotReady({ enabled: true, ready: false, tradingDays: 1, recordDays: 30, needDays: 10, recordSince: "2026-09-28" })).toContain("1거래일뿐이라");
  });

  it("검토 반영 3차: 기록이 중간에 멈춘 경우(9/9~9/28 뒤로 없음, 10/5~10/12 고름)는 '주말·휴일·기록 시작 전'이 아니라 마지막 기록일을 말한다", () => {
    const base = { enabled: true, ready: false, tradingDays: 0, recordDays: 14, needDays: 10, recordSince: "2026-09-09", recordUntil: "2026-09-28", actual: null } as const;
    const after = returnsNotReady({ ...base, requested: { from: "2026-10-05", to: "2026-10-12" } });
    expect(after).toBe("고른 기간(10월 5일 ~ 10월 12일)에는 계좌 기록이 없어요. 마지막 기록은 9월 28일이고, 그 뒤로는 계좌 기록이 저장되지 않았어요. 기록은 매일 장 마감 뒤 저장돼요.");
    expect(after).not.toContain("주말·휴일");
    // 기록 시작 전만 고름
    expect(returnsNotReady({ ...base, requested: { from: "2026-09-01", to: "2026-09-06" } })).toBe("고른 기간(9월 1일 ~ 9월 6일)에는 계좌 기록이 없어요. 기록은 9월 9일부터 있어요.");
    // 기록 사이의 주말·휴일
    expect(returnsNotReady({ ...base, requested: { from: "2026-09-19", to: "2026-09-20" } })).toBe(
      "고른 기간(9월 19일 ~ 9월 20일)에는 계좌 기록이 없어요. 기록은 9월 9일부터 9월 28일까지 있고, 그 사이 주말·휴일과 기록이 빠진 날에는 기록이 없어요.",
    );
  });

  it("양도세: 평균 구매가를 추정한 매도가 합계에 있으면 합계 줄·아래 줄에 '추정 포함', 따로 상자(종목·건수·까닭), 매도별 계산 첫 줄에 '추정 포함'", () => {
    const d: JournalTax = {
      enabled: true,
      year: 2026,
      years: [2026],
      rules: { rate: 0.22, nationalRate: 0.2, localRateOfNational: 0.1, deduction: 2_500_000, method: "moving-average", lawYear: 2026 },
      totals: { gains: 4_000_000, losses: -550_000, net: 3_450_000, base: 950_000, nationalTax: 190_000, localTax: 19_000, tax: 209_000, sells: 12 },
      complete: true,
      fxPending: 0,
      excluded: [],
      items: [],
      estimatedIncluded: 2,
      estimatedSells: [{ code: "SOXL", name: "SOXL", count: 2, reason: "분할·무상증자 같은 주식 수 변화 전후라 평균 구매가를 추정했어요." }],
      kr: { securitiesTax: { amount: null, sells: 0, source: null } },
    };
    const v = taxView(d, false)!;
    expect(v.rows[0]).toMatchObject({ label: "양도차익 합계 (이익 − 손실, 추정 포함)", value: "+3,450,000원" });
    expect(v.rows[0]!.speech).toContain("추정 포함");
    expect(v.sub).toBe("이익 +4,000,000원 · 손실 -550,000원 · 매도 12건 (추정 포함 2건)");
    expect(v.estimated).toEqual({ title: "평균 구매가를 추정한 매도 2건이 합계에 들어 있어요.", lines: ["SOXL 2건 · 분할·무상증자 같은 주식 수 변화 전후라 평균 구매가를 추정했어요."] });
    // 없으면 지금 그대로
    const plain = taxView({ ...d, estimatedIncluded: 0, estimatedSells: [] }, false)!;
    expect(plain.rows[0]!.label).toBe("양도차익 합계 (이익 − 손실)");
    expect(plain.estimated).toBeNull();
    expect(taxView({ ...d, estimatedIncluded: undefined, estimatedSells: undefined }, false)!.estimated).toBeNull();
    const item = { key: "k", code: "SOXL", name: "SOXL", tradeDate: "2026-09-28", settleDate: "2026-09-30", settleSource: "estimated" as const, quantity: 5, proceedsUsd: 125, costsUsd: null, fxSell: { rate: 1350, source: "smbs", date: "2026-09-30", provisional: false }, proceedsKrw: 168_750, costKrw: 168_750, costsKrw: null, gainKrw: 0 };
    expect(taxItemLines({ ...item, estimate: { status: "estimated", reason: "x" } })[0]).toBe("9/28 SOXL 5주 · 결제일 9/30(추정) · 환율 1,350.00원 · 추정 포함");
    expect(taxItemLines(item)[0]).toBe("9/28 SOXL 5주 · 결제일 9/30(추정) · 환율 1,350.00원");
  });

  it("검토 반영 4차: 순서를 모르는 매도는 합계에서 빠짐 — 빠진 매도 상자에 까닭 + 추정 양도차익 한 줄, 매도별 계산 첫 줄 '합계에서 뺌'", () => {
    const reason = "사고판 순서나 주문 내역에 없는 주식 수 변화(입고·출고·병합 등)를 몰라 취득가가 확실하지 않아 합계에서 뺐어요";
    const item = { key: "u", code: "SOXL", name: "SOXL", tradeDate: "2026-09-28", settleDate: "2026-09-30", settleSource: "estimated" as const, quantity: 4000, proceedsUsd: 100_000, costsUsd: null, fxSell: { rate: 1350, source: "smbs", date: "2026-09-30", provisional: false }, proceedsKrw: 135_000_000, costKrw: 540_000_000, costsKrw: null, gainKrw: -405_000_000, estimate: { status: "order-uncertain" as const, reason: "x" } };
    const d: JournalTax = {
      enabled: true,
      year: 2026,
      years: [2026],
      rules: { rate: 0.22, nationalRate: 0.2, localRateOfNational: 0.1, deduction: 2_500_000, method: "moving-average", lawYear: 2026 },
      totals: { gains: 4_000_000, losses: -550_000, net: 3_450_000, base: 950_000, nationalTax: 190_000, localTax: 19_000, tax: 209_000, sells: 12 },
      complete: false,
      fxPending: 0,
      excluded: [{ code: "SOXL", name: "SOXL", count: 1, reason }],
      items: [],
      uncertainExcluded: 1,
      uncertainGainKrw: -405_000_000,
      uncertainItems: [item],
      kr: { securitiesTax: { amount: null, sells: 0, source: null } },
    };
    const v = taxView(d, false)!;
    expect(v.excluded).toEqual({ title: "계산에 넣지 못한 매도 1건이 있어 실제와 다를 수 있어요.", lines: [`SOXL 1건 · ${reason}`, "취득가가 확실하지 않아 뺀 매도 1건의 추정 양도차익은 -405,000,000원이에요."] });
    // 합계 줄에는 '추정 포함'을 붙이지 않는다 (합계에 들어 있지 않음)
    expect(v.rows[0]!.label).toBe("양도차익 합계 (이익 − 손실)");
    expect(taxItemLines(item, true)[0]).toBe("9/28 SOXL 4,000주 · 결제일 9/30(추정) · 환율 1,350.00원 · 합계에서 뺌");
    expect(taxItemLines(item, true)[1]).toBe("양도가액 135,000,000원 − 취득가액 540,000,000원 = -405,000,000원");
    // 예전 서버(칸 없음)는 지금 그대로
    expect(taxView({ ...d, uncertainExcluded: undefined, uncertainGainKrw: undefined }, false)!.excluded!.lines).toEqual([`SOXL 1건 · ${reason}`]);
  });
});
