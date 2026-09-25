import { describe, expect, it } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { allocation, apportion, arcPath, chartSummary, donutArcs, excludedNote, OTHER_LABEL, PIE_SLOTS, sliceLabel, TOP_INDUSTRY, TOP_STOCK, UNKNOWN_INDUSTRY, type Allocation, type AllocationKind } from "@/lib/allocation";
import { summarize } from "@/lib/portfolio";
import { holding, quote } from "./helpers";

/**
 * 비중 보기 (allocationView). 금액은 잔고 탭 총 평가금액과 같은 기준이고, 차트마다 비중 합 100.0 · 금액 합 = 총 평가금액.
 */
const FX = 1360;
const samsung = holding("005930", quote("005930", 72_000, { industry: "반도체" }), 10, 70_000, undefined, "삼성전자");
const hynix = holding("000660", quote("000660", 230_000, { industry: "반도체" }), 3, 250_000, undefined, "SK하이닉스");
const naver = holding("035420", quote("035420", 180_000, { industry: "인터넷" }), 2, 200_000, undefined, "NAVER");
const apple = holding("AAPL", quote("AAPL", 200, { currency: "USD", fxRate: FX, industry: "하드웨어" }), 4, 180, { costBasisKrw: 950_000, krwCostSource: "exact" }, "애플");
const watchOnly = holding("035720", quote("035720", 41_000), null, null, undefined, "카카오");
const noFx = holding("TSLA", quote("TSLA", 250, { currency: "USD" }), 2, 240, undefined, "테슬라");

const chart = (a: Allocation, kind: AllocationKind) => a.charts.find((c) => c.kind === kind)!;
/** 잔고 탭의 총 평가금액 (AccountPanel: 원화 합계, 환율을 모르면 원화 종목만) 을 원 단위로 */
const accountTotal = (list: RegisteredWithQuote[], afterCost: boolean) => {
  const s = summarize(list, afterCost);
  return Math.round((s.krw ?? s.byCur.KRW).value);
};
/** 차트마다: 비중 합 정확히 100.0 (소수 첫째 자리 정수로), 금액 합 = 총 평가금액, 비중은 소수 첫째 자리 */
function expectConsistent(a: Allocation) {
  for (const c of a.charts) {
    expect(c.slices.reduce((s, x) => s + Math.round(x.pct * 10), 0), c.kind).toBe(1000);
    expect(c.slices.reduce((s, x) => s + x.won, 0), c.kind).toBe(a.total);
    for (const x of c.slices) {
      expect(Number.isInteger(x.won), `${c.kind} ${x.label} 원 단위`).toBe(true);
      expect(Math.abs(x.pct * 10 - Math.round(x.pct * 10)), `${c.kind} ${x.label} 소수 첫째 자리`).toBeLessThan(1e-9);
    }
  }
}

describe("apportion (최대 나머지 반올림)", () => {
  it("합이 정확히 목표값: 1/3 씩이면 33.4 · 33.3 · 33.3", () => {
    expect(apportion([1, 1, 1], 1000)).toEqual([334, 333, 333]);
    expect(apportion([2, 1, 1], 1000)).toEqual([500, 250, 250]);
  });
  it("나머지가 같으면 값이 큰 쪽, 값도 같으면 앞쪽이 먼저", () => {
    expect(apportion([1, 3], 2)).toEqual([0, 2]);
    expect(apportion([1, 1], 1)).toEqual([1, 0]);
    expect(apportion([1, 2, 1, 2], 7)).toEqual([1, 3, 1, 2]);
  });
  it("합이 0 이거나 목표가 0 이면 모두 0, 음수·NaN 은 0 으로 본다", () => {
    expect(apportion([0, 0], 1000)).toEqual([0, 0]);
    expect(apportion([5, 5], 0)).toEqual([0, 0]);
    expect(apportion([-5, 5, Number.NaN], 10)).toEqual([0, 10, 0]);
  });
  it("아주 작은 조각도 합을 깨지 않는다", () => {
    const r = apportion([1_000_000_000, 1, 1, 1], 1000);
    expect(r.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(r[0]).toBe(1000);
  });
});

describe("비중 보기: 잔고 탭과 같은 기준", () => {
  it("원화만: 국내 100.0 · 원화 100.0, 금액 합 = 총 평가금액", () => {
    const a = allocation([samsung, hynix, watchOnly], true);
    expect(a.total).toBe(accountTotal([samsung, hynix, watchOnly], true));
    expect(a.total).toBe(720_000 + 690_000);
    expect(a.count).toBe(2);
    expect(a.krwOnly).toBe(false);
    expect(chart(a, "market").slices.map((s) => [s.label, s.pct])).toEqual([["국내", 100]]);
    expect(chart(a, "currency").slices.map((s) => [s.label, s.pct])).toEqual([["원화", 100]]);
    expect(chart(a, "stock").slices.map((s) => s.label)).toEqual(["삼성전자", "SK하이닉스"]);
    expect(a.excluded).toEqual({ noQuote: 0, noEval: 0, noFx: 0 });
    expectConsistent(a);
  });

  it("원화·달러 섞임: 달러는 그 종목 환율로 원화 환산, 해외 비중 60.2%", () => {
    const list = [samsung, apple];
    const a = allocation(list, false);
    expect(a.total).toBe(720_000 + 800 * FX); // 1,808,000
    expect(a.total).toBe(accountTotal(list, false));
    expect(chart(a, "market").slices.map((s) => [s.label, s.won, s.pct])).toEqual([
      ["국내", 720_000, 39.8],
      ["해외", 1_088_000, 60.2],
    ]);
    expect(chart(a, "currency").slices.map((s) => [s.label, s.pct])).toEqual([
      ["원화", 39.8],
      ["달러", 60.2],
    ]);
    // 매입 원화(950,000)가 아니라 평가금액으로 나눈다
    expect(chart(a, "stock").slices[0]).toMatchObject({ label: "애플", won: 1_088_000 });
    expectConsistent(a);
  });

  it("국내·해외와 원화·달러는 색이 묶음마다 고정 (해외만 있어도 해외 색)", () => {
    const a = allocation([apple], true);
    expect(chart(a, "market").slices.map((s) => [s.label, s.slot])).toEqual([["해외", 1]]);
    expect(chart(a, "currency").slices.map((s) => [s.label, s.slot])).toEqual([["달러", 1]]);
    expect(allocation([samsung, apple], true).charts[0]!.slices.map((s) => s.slot)).toEqual([0, 1]);
  });

  it("환율을 모르는 해외 종목이 있으면 잔고 탭처럼 원화 종목만: 해외는 빼고 알린다", () => {
    const list = [samsung, apple, noFx];
    const a = allocation(list, true);
    expect(a.krwOnly).toBe(true);
    expect(a.total).toBe(720_000);
    expect(a.total).toBe(accountTotal(list, true));
    expect(a.excluded).toEqual({ noQuote: 0, noEval: 0, noFx: 2 });
    expect(excludedNote(a.excluded)).toBe("환율 정보가 없는 해외 2종목 제외");
    expect(chart(a, "market").slices.map((s) => [s.label, s.pct])).toEqual([["국내", 100]]);
    expectConsistent(a);
  });

  it("해외 종목뿐인데 환율을 모르면 비중 없음 (잔고 탭 원화 합계도 0)", () => {
    const a = allocation([noFx], true);
    expect(a.charts).toEqual([]);
    expect(a.total).toBe(0);
    expect(a.excluded.noFx).toBe(1);
  });

  it("비용 차감 설정을 따른다 (켜면 차감 후 평가금액, 끄면 그대로)", () => {
    const withCost = holding("005930", quote("005930", 72_000), 10, 70_000, { costRate: 0.002, afterCost: { marketValue: 718_560, profit: 18_560, profitRate: 2.65 } }, "삼성전자");
    const usCost = holding("AAPL", quote("AAPL", 200, { currency: "USD", fxRate: FX }), 4, 180, { costRate: 0.001, afterCost: { marketValue: 799.2, profit: 79.2, profitRate: 11 } }, "애플");
    const on = allocation([withCost, usCost], true);
    const off = allocation([withCost, usCost], false);
    expect(on.total).toBe(Math.round(718_560 + 799.2 * FX));
    expect(off.total).toBe(720_000 + 800 * FX);
    expect(on.total).toBe(accountTotal([withCost, usCost], true));
    expect(off.total).toBe(accountTotal([withCost, usCost], false));
    expect(chart(on, "stock").slices.find((s) => s.label === "삼성전자")!.won).toBe(718_560);
    expectConsistent(on);
    expectConsistent(off);
  });

  it("업종이 없으면 '업종 정보 없음' 묶음 (이름 있는 업종 뒤)", () => {
    const bare = holding("AAPL", quote("AAPL", 200, { currency: "USD", fxRate: FX }), 40, 180, undefined, "애플"); // 1,088만 원 — 가장 크다
    const a = allocation([samsung, naver, bare], true);
    expect(chart(a, "industry").slices.map((s) => s.label)).toEqual(["반도체", "인터넷", UNKNOWN_INDUSTRY]);
    expect(chart(a, "industry").slices.map((s) => s.slot)).toEqual([0, 1, 2]);
    // 빈 글자도 없는 것으로
    const blank = holding("X", quote("X", 1000, { industry: "  " }), 1, 1000, undefined, "엑스");
    expect(chart(allocation([blank], true), "industry").slices[0]!.label).toBe(UNKNOWN_INDUSTRY);
  });

  it("같은 업종은 합친다 (반도체 2종목)", () => {
    const a = allocation([samsung, hynix, naver], true);
    expect(chart(a, "industry").slices.map((s) => [s.label, s.count, s.won])).toEqual([
      ["반도체", 2, 1_410_000],
      ["인터넷", 1, 360_000],
    ]);
  });

  it(`업종은 큰 순 ${TOP_INDUSTRY}개 + 기타, 기타는 회색`, () => {
    const list = Array.from({ length: 10 }, (_, i) => holding(`K${i}`, quote(`K${i}`, 1000 * (10 - i), { industry: `업종${i}` }), 10, 1000, undefined, `종목${i}`));
    const c = chart(allocation(list, true), "industry");
    expect(c.slices).toHaveLength(TOP_INDUSTRY + 1);
    expect(c.slices.slice(0, TOP_INDUSTRY).map((s) => s.label)).toEqual(["업종0", "업종1", "업종2", "업종3", "업종4", "업종5", "업종6"]);
    const other = c.slices.at(-1)!;
    expect(other).toMatchObject({ label: OTHER_LABEL, other: true, slot: null, count: 3, won: 10 * (3000 + 2000 + 1000) });
    expect(c.slices.slice(0, TOP_INDUSTRY).map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it(`종목은 큰 순 ${TOP_STOCK}개 + 기타. 색은 앞 ${PIE_SLOTS}개까지, 그 뒤와 기타는 회색`, () => {
    const list = Array.from({ length: 13 }, (_, i) => holding(`K${i}`, quote(`K${i}`, 1000 * (13 - i)), 10, 1000, undefined, `종목${i}`));
    const a = allocation(list, true);
    const c = chart(a, "stock");
    expect(c.slices).toHaveLength(TOP_STOCK + 1);
    expect(c.slices.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, null, null, null, null]);
    expect(c.slices.at(-1)).toMatchObject({ label: OTHER_LABEL, other: true, count: 3 });
    expectConsistent(a);
  });

  it("시세 없는 보유 종목은 빼고 '시세 없는 1종목 제외'를 알린다 (관심 종목은 세지 않음)", () => {
    const noQuote = { ...holding("999999", null, 5, 10_000, undefined, "거래정지"), evaluation: null };
    const noAvg = holding("111111", quote("111111", 5000), 3, null, undefined, "평단없음");
    const a = allocation([samsung, noQuote, watchOnly, noAvg], true);
    expect(a.count).toBe(1);
    expect(a.excluded).toEqual({ noQuote: 1, noEval: 1, noFx: 0 });
    expect(excludedNote({ noQuote: 1, noEval: 0, noFx: 0 })).toBe("시세 없는 1종목 제외");
    expect(excludedNote(a.excluded)).toBe("시세 없는 1종목 · 평가금액 없는 1종목 제외");
    expect(excludedNote({ noQuote: 0, noEval: 0, noFx: 0 })).toBeNull();
    expect(a.total).toBe(accountTotal([samsung, noQuote, watchOnly, noAvg], true));
  });

  it("보유가 없으면 차트 없음 (빈 화면)", () => {
    expect(allocation([], true)).toEqual({ total: 0, krwOnly: false, count: 0, excluded: { noQuote: 0, noEval: 0, noFx: 0 }, charts: [] });
    expect(allocation([watchOnly], true).charts).toEqual([]);
  });

  it("반올림: 같은 금액 3종목은 33.4 · 33.3 · 33.3 (합 100.0), 금액 합도 총액과 같다", () => {
    const list = ["A", "B", "C"].map((c) => holding(c, quote(c, 333.33), 1, 300, undefined, c));
    const a = allocation(list, false);
    expect(chart(a, "stock").slices.map((s) => s.pct)).toEqual([33.4, 33.3, 33.3]);
    expect(a.total).toBe(1000); // 999.99 → 1,000원 (잔고 탭 표기와 같음)
    expect(chart(a, "stock").slices.map((s) => s.won)).toEqual([334, 333, 333]);
    expectConsistent(a);
  });

  it("여러 모양의 잔고에서 늘: 차트마다 합 100.0, 금액 합 = 잔고 탭 총 평가금액(±1원 이내가 아니라 정확히)", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const industries = ["반도체", "인터넷", "2차전지", "자동차", "은행", "바이오", "게임", "화학", "조선", null];
    for (let run = 0; run < 60; run++) {
      const n = 1 + Math.floor(rnd() * 25);
      const list = Array.from({ length: n }, (_, i) => {
        const us = rnd() < 0.4;
        const q = quote(`S${i}`, us ? 5 + rnd() * 500 : 1000 + Math.floor(rnd() * 900_000), {
          currency: us ? "USD" : "KRW",
          fxRate: us ? 1300 + rnd() * 100 : null,
          industry: industries[Math.floor(rnd() * industries.length)],
        });
        const cost = rnd() < 0.5 ? { costRate: 0.002, afterCost: { marketValue: q.price * 7 * 0.998, profit: 0, profitRate: 0 } } : undefined;
        return holding(`S${i}`, q, 7, q.price * 0.9, cost, `종목${i}`);
      });
      for (const afterCost of [true, false]) {
        const a = allocation(list, afterCost);
        expect(Math.abs(a.total - accountTotal(list, afterCost))).toBeLessThanOrEqual(1);
        expect(a.charts).toHaveLength(4);
        expectConsistent(a);
      }
    }
  });
});

describe("원 차트 조각 각도", () => {
  const TAU = 2 * Math.PI;
  it("조각이 하나면 고리 전체 (틈 없음)", () => {
    expect(donutArcs([5], 0.05)).toEqual([{ start: 0, end: TAU, full: true }]);
    expect(donutArcs([0, 7, 0], 0.05)).toEqual([null, { start: 0, end: TAU, full: true }, null]);
  });
  it("12시에서 시계 방향으로 값 비율대로, 조각 사이에 틈", () => {
    const gap = 0.02;
    const [a, b] = donutArcs([3, 1], gap) as { start: number; end: number }[];
    expect(a!.start).toBeCloseTo(gap / 2);
    expect(a!.end).toBeCloseTo(0.75 * TAU - gap / 2);
    expect(b!.start).toBeCloseTo(0.75 * TAU + gap / 2);
    expect(b!.end).toBeCloseTo(TAU - gap / 2);
    // 틈 합 + 조각 합 = 한 바퀴
    const arcs = donutArcs([5, 4, 3, 2, 1], gap) as { start: number; end: number }[];
    expect(arcs.reduce((s, x) => s + (x.end - x.start), 0) + gap * 5).toBeCloseTo(TAU);
  });
  it("틈보다 좁은 조각·0 은 그리지 않는다 (범례에는 남음)", () => {
    expect(donutArcs([1_000_000, 1], 0.05)[1]).toBeNull();
    expect(donutArcs([0, 0], 0.05)).toEqual([null, null]);
  });
  it("호 경로: 반 바퀴 넘으면 큰 호 표시, 전체 고리는 반원 두 개", () => {
    expect(arcPath(50, 50, 40, { start: 0, end: Math.PI / 2, full: false })).toBe("M 50.00 10.00 A 40 40 0 0 1 90.00 50.00");
    expect(arcPath(50, 50, 40, { start: 0, end: 1.5 * Math.PI, full: false })).toMatch(/A 40 40 0 1 1 10\.00 50\.00$/);
    expect(arcPath(50, 50, 40, { start: 0, end: TAU, full: true })).toBe("M 50.00 10.00 A 40 40 0 1 1 50.00 90.00 A 40 40 0 1 1 50.00 10.00");
  });
});

describe("비중 보기: 화면 읽기 문장", () => {
  it("차트 한 개를 한 문장으로: '국내 62.3%, 해외 37.7%'", () => {
    const kr = holding("005930", quote("005930", 62_300), 10, 60_000, undefined, "삼성전자");
    const us = holding("AAPL", quote("AAPL", 100, { currency: "USD", fxRate: 1000 }), 3.77, 90, undefined, "애플");
    const a = allocation([kr, us], false);
    expect(chartSummary(chart(a, "market"))).toBe("국내 62.3%, 해외 37.7%");
    expect(chartSummary(chart(a, "currency"))).toBe("원화 62.3%, 달러 37.7%");
  });

  it("범례 한 줄: 이름, (여러 종목이면 종목 수), 금액, 비중", () => {
    expect(sliceLabel({ key: "005930", label: "삼성전자", won: 720_000, pct: 39.8, count: 1, slot: 0, other: false })).toBe("삼성전자, 720,000원, 비중 39.8%");
    expect(sliceLabel({ key: "other", label: "기타", won: 120_000, pct: 2, count: 3, slot: null, other: true })).toBe("기타, 3종목, 120,000원, 비중 2.0%");
  });
});
