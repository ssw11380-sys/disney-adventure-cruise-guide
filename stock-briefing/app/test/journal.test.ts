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
  dayRealizedText,
  detailLine,
  detailTime,
  extraLines,
  headLines,
  journalHref,
  krTaxLine,
  periodRange,
  qtyText,
  realizedText,
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
        { label: "국내", value: "+45,000원", sign: 1 },
        { label: "미국", value: "+$17.43 (원화 약 +24,703원, 추정)", sign: 1 },
        { label: "합계", value: "약 +69,703원", sign: 1 },
      ],
      counts: "매수 5건 · 매도 3건 · 체결 8건",
      notes: [JOURNAL.grossNote, "실현손익을 모르는 매도 1건은 합계에서 뺐어요 (기록 시작 전에 산 몫)."],
    });
    expect(beforeRecordNote(resp)).toBe("9월 23일부터 저장한 기록이에요. 그 전 체결은 토스에서 받아 온 것만 있어요.");
    expect(beforeRecordNote({ ...resp, from: "2026-09-24" })).toBeNull();
  });

  it("날짜 머리 오른쪽: 통화가 섞이면 둘 다, 매도가 없으면 없음", () => {
    expect(dayRealizedText({ KRW: 45_000, USD: 17.43, krwTotal: null, krwTotalEstimated: true })).toBe("실현 +45,000원 · +$17.43");
    expect(dayRealizedText({ KRW: null, USD: -1.2, krwTotal: null, krwTotalEstimated: true })).toBe("실현 -$1.20");
    expect(dayRealizedText({ KRW: null, USD: null, krwTotal: null, krwTotalEstimated: false })).toBeNull();
  });
});

describe("거래 상세", () => {
  it("실현손익 계산: 판매 금액 − 평균 구매가 × 수량 = 실현손익, 수수료·세금, 원화로는 (§4.4)", () => {
    const c = calcRows(soxlSell);
    expect(c.rows).toEqual([
      { label: "판매 금액", value: "$187.50" },
      { label: "− 평균 구매가 $34.0133 × 5주", value: "$170.07" },
      { label: "= 실현손익", value: "+$17.43 (+10.25%)", sign: 1 },
      { label: "수수료·세금", value: "토스가 주지 않아 빼지 않았어요" },
      { label: "원화로는", value: "약 +24,703원 (추정)", sign: 1 },
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
    expect(returnsSpeech(ready)).toBe("9월 28일부터 10월 12일까지 10거래일, 수익률 시간가중 3.42% 상승, 기간 손익 456,000원 이익");
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
