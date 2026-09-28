import { describe, expect, it } from "vitest";
import { LABEL_PAD, placeInsideLabels, priceDomain, textWidth, type Box } from "@/lib/chartBasis";
import {
  arrowBox,
  arrowPath,
  extremeDate,
  extremeDateSpeech,
  headroomDomain,
  highLowTexts,
  HL,
  HL_HEAD_BOTTOM,
  HL_HEAD_TOP,
  HL_REACH,
  layoutHighLow,
  pctFromCurrent,
  settleWithInside,
  visibleExtremes,
  type HighLowMark,
} from "@/lib/chartHighLow";

/**
 * 차트 최고·최저가 표시 (3-46, 기능 플래그 chartHighLow) — 순수 함수.
 * 사용자 캡처(토스 NAVER 일봉): 현재가 198,000원, 보이는 구간 최고 '255,000원 (-22.3%, 26.07.27)' · 최저 '181,100원 (+9.3%, 26.07.14)'
 */

const NAVER = [
  { date: "2026-07-13", high: 190_000, low: 185_000, close: 186_000 },
  { date: "2026-07-14", high: 186_500, low: 181_100, close: 184_000 },
  { date: "2026-07-27", high: 255_000, low: 220_000, close: 226_000 },
  { date: "2026-09-25", high: 199_000, low: 196_000, close: 198_000 },
];
const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe("보이는 구간 최고·최저 (visibleExtremes)", () => {
  it("봉 모드: 가장 높은 고가·가장 낮은 저가와 그 봉 순서", () => {
    expect(visibleExtremes(NAVER)).toEqual({ high: { index: 2, value: 255_000 }, low: { index: 1, value: 181_100 } });
  });
  it("같은 값이 여럿이면 가장 최근(오른쪽) 봉", () => {
    const bars = [
      { date: "a", high: 10, low: 5, close: 7 },
      { date: "b", high: 9, low: 6, close: 8 },
      { date: "c", high: 10, low: 5, close: 7 },
      { date: "d", high: 8, low: 6, close: 7 },
    ];
    expect(visibleExtremes(bars)).toEqual({ high: { index: 2, value: 10 }, low: { index: 2, value: 5 } });
  });
  it("선 모드: 종가의 최고·최저 (같으면 최근)", () => {
    const bars = [
      { date: "a", high: 10, low: 5, close: 7 },
      { date: "b", high: 9, low: 6, close: 8 },
      { date: "c", high: 9, low: 6, close: 8 },
      { date: "d", high: 9, low: 2, close: 7 },
    ];
    expect(visibleExtremes(bars, "line")).toEqual({ high: { index: 2, value: 8 }, low: { index: 3, value: 7 } });
  });
  it("값 있는 봉이 2개 미만이면 없음 (NaN 봉은 건너뜀)", () => {
    expect(visibleExtremes([])).toBeNull();
    expect(visibleExtremes([{ date: "a", high: 10, low: 5, close: 7 }])).toBeNull();
    expect(visibleExtremes([{ date: "a", high: 10, low: 5, close: 7 }, { date: "b", high: NaN, low: NaN, close: NaN }])).toBeNull();
    // NaN 봉이 끼어 있어도 나머지로 (순서는 보이는 봉 안 그대로)
    expect(visibleExtremes([{ date: "a", high: 10, low: 5, close: 7 }, { date: "b", high: NaN, low: 1, close: 3 }, { date: "c", high: 12, low: 6, close: 8 }])).toEqual({ high: { index: 2, value: 12 }, low: { index: 0, value: 5 } });
  });
  it("최고 = 최저(한 줄로 평평)면 없음", () => {
    expect(visibleExtremes([{ date: "a", high: 7, low: 7, close: 7 }, { date: "b", high: 7, low: 7, close: 7 }])).toBeNull();
    expect(visibleExtremes([{ date: "a", high: 9, low: 5, close: 7 }, { date: "b", high: 9, low: 5, close: 7 }], "line")).toBeNull();
  });
});

describe("현재가 대비 % (pctFromCurrent) — 소수 한 자리 버림, 부호", () => {
  it("캡처 숫자 그대로: 198,000 vs 255,000 → -22.3% (반올림이면 -22.4%), vs 181,100 → +9.3%", () => {
    expect(pctFromCurrent(198_000, 255_000)).toBe("-22.3%");
    expect(pctFromCurrent(198_000, 181_100)).toBe("+9.3%");
  });
  it("0.0% 로 보이면 부호 없이 (같은 값 · 0.05% 미만 차이)", () => {
    expect(pctFromCurrent(100, 100)).toBe("0.0%");
    expect(pctFromCurrent(100, 100.04)).toBe("0.0%");
    expect(pctFromCurrent(100.09, 100)).toBe("0.0%");
  });
  it("부동소수 경계: 12.3% 가 12.2% 로 떨어지지 않는다", () => {
    expect(pctFromCurrent(112.3, 100)).toBe("+12.3%");
    expect(pctFromCurrent(87.7, 100)).toBe("-12.3%");
    expect(pctFromCurrent(123, 100)).toBe("+23.0%");
  });
  it("1,000% 이상은 자리 쉼표", () => {
    expect(pctFromCurrent(30_000, 1_000)).toBe("+2,900.0%");
  });
  it("현재가·값을 모르면(없음·0·음수·NaN) null", () => {
    for (const c of [null, undefined, 0, -1, NaN]) expect(pctFromCurrent(c, 100)).toBeNull();
    expect(pctFromCurrent(100, 0)).toBeNull();
  });
});

describe("날짜 (extremeDate · extremeDateSpeech)", () => {
  it("일·주봉 YY.MM.DD, 월봉 YY.MM", () => {
    expect(extremeDate({ date: "2026-07-27" }, "D", true)).toBe("26.07.27");
    expect(extremeDate({ date: "2026-07-27" }, "W", true)).toBe("26.07.27");
    expect(extremeDate({ date: "2026-07-01" }, "M", true)).toBe("26.07");
  });
  it("분봉: 하루 안이면 HH:mm, 보이는 구간이 여러 날이면 MM.DD HH:mm", () => {
    const bar = { date: "2026-09-25", time: "2026-09-25T14:30:00+09:00" };
    expect(extremeDate(bar, "5m", false)).toBe("14:30");
    expect(extremeDate(bar, "5m", true)).toBe("09.25 14:30");
    expect(extremeDate(bar, "1m", false)).toBe("14:30");
  });
  it("읽는 날짜: 7월 27일 · 해를 넘으면 2025년 · 주봉 '… 주' · 월봉 '2026년 7월' · 분봉 '14시 30분'(여러 날이면 날짜 앞에)", () => {
    const o = { spansDays: true, spansYears: false };
    expect(extremeDateSpeech({ date: "2026-07-27" }, "D", o)).toBe("7월 27일");
    expect(extremeDateSpeech({ date: "2025-07-27" }, "D", { spansDays: true, spansYears: true })).toBe("2025년 7월 27일");
    expect(extremeDateSpeech({ date: "2026-07-27" }, "W", o)).toBe("7월 27일 주");
    expect(extremeDateSpeech({ date: "2026-07-01" }, "M", o)).toBe("2026년 7월");
    expect(extremeDateSpeech({ date: "2026-09-25", time: "2026-09-25T14:30:00+09:00" }, "5m", { spansDays: false, spansYears: false })).toBe("14시 30분");
    expect(extremeDateSpeech({ date: "2026-09-25", time: "2026-09-25T09:00:00+09:00" }, "1m", { spansDays: false, spansYears: false })).toBe("9시");
    expect(extremeDateSpeech({ date: "2026-09-25", time: "2026-09-25T14:30:00+09:00" }, "5m", o)).toBe("9월 25일 14시 30분");
  });
});

describe("글자·화면 읽기 (highLowTexts)", () => {
  const ex = visibleExtremes(NAVER)!;
  it("원화: 캡처와 똑같은 두 글자", () => {
    const tx = highLowTexts(NAVER, ex, { unit: "KRW", period: "D", current: 198_000 });
    expect(tx.high).toBe("255,000원 (-22.3%, 26.07.27)");
    expect(tx.low).toBe("181,100원 (+9.3%, 26.07.14)");
  });
  it("화면 읽기 문장: 요구 문장 + 화면의 %를 말로 (투자 권유로 읽힐 말 없음)", () => {
    const tx = highLowTexts(NAVER, ex, { unit: "KRW", period: "D", current: 198_000 });
    expect(tx.speech).toBe("보이는 구간 최고 255,000원 7월 27일, 최저 181,100원 7월 14일. 현재가는 최고보다 22.3% 낮음, 최저보다 9.3% 높음");
    expect(tx.speech.startsWith("보이는 구간 최고 255,000원 7월 27일, 최저 181,100원 7월 14일")).toBe(true);
    expect(tx.speech).not.toMatch(/매수|매도|기회|싸다|비싸|반등|저점|고점/);
  });
  it("현재가가 최고와 같으면 '최고와 같음'", () => {
    const tx = highLowTexts(NAVER, ex, { unit: "KRW", period: "D", current: 255_000 });
    expect(tx.high).toBe("255,000원 (0.0%, 26.07.27)");
    expect(tx.speech).toContain("현재가는 최고와 같음, 최저보다 40.8% 높음");
  });
  it("달러: '$123.45 (…)', 읽기는 '123.45달러'", () => {
    const bars = [
      { date: "2026-07-27", high: 123.45, low: 100, close: 110 },
      { date: "2026-07-28", high: 120, low: 101.5, close: 110 },
    ];
    const tx = highLowTexts(bars, visibleExtremes(bars)!, { unit: "USD", period: "D", current: 110 });
    expect(tx.high).toBe("$123.45 (-10.8%, 26.07.27)");
    expect(tx.low).toBe("$100.00 (+10.0%, 26.07.27)");
    expect(tx.speech).toBe("보이는 구간 최고 123.45달러 7월 27일, 최저 100.00달러 7월 27일. 현재가는 최고보다 10.8% 낮음, 최저보다 10.0% 높음");
  });
  it("지수·환율(PT): 원 없이 소수 둘째 자리, 읽기는 '현재 값은'", () => {
    const bars = [
      { date: "2026-07-27", high: 2_650.12, low: 2_600, close: 2_610 },
      { date: "2026-07-28", high: 2_640, low: 2_580.5, close: 2_600 },
    ];
    const tx = highLowTexts(bars, visibleExtremes(bars)!, { unit: "PT", period: "D", current: 2_600 });
    expect(tx.high).toBe("2,650.12 (-1.8%, 26.07.27)");
    expect(tx.low).toBe("2,580.50 (+0.7%, 26.07.28)");
    expect(tx.high).not.toContain("원");
    expect(tx.speech).toContain(". 현재 값은 최고보다 1.8% 낮음");
  });
  it("현재가를 모르면 괄호 안에서 %를 빼고, 읽기 뒤 문장도 없음", () => {
    const tx = highLowTexts(NAVER, ex, { unit: "KRW", period: "D", current: null });
    expect(tx.high).toBe("255,000원 (26.07.27)");
    expect(tx.speech).toBe("보이는 구간 최고 255,000원 7월 27일, 최저 181,100원 7월 14일");
  });
  it("분봉: 하루 안이면 시각만, 여러 날이면 날짜와 시각", () => {
    const day = [
      { date: "2026-09-25", time: "2026-09-25T09:00:00+09:00", high: 199_000, low: 196_000, close: 198_000 },
      { date: "2026-09-25", time: "2026-09-25T14:30:00+09:00", high: 201_000, low: 195_500, close: 198_000 },
    ];
    const one = highLowTexts(day, visibleExtremes(day)!, { unit: "KRW", period: "5m", current: 198_000 });
    expect(one.high).toBe("201,000원 (-1.4%, 14:30)");
    expect(one.low).toBe("195,500원 (+1.2%, 14:30)");
    expect(one.speech).toContain("최고 201,000원 14시 30분");
    const two = [{ ...day[0]!, date: "2026-09-24", time: "2026-09-24T15:00:00+09:00" }, day[1]!];
    const multi = highLowTexts(two, visibleExtremes(two)!, { unit: "KRW", period: "5m", current: 198_000 });
    expect(multi.high).toBe("201,000원 (-1.4%, 09.25 14:30)");
    expect(multi.speech).toContain("최고 201,000원 9월 25일 14시 30분");
  });
  it("구간이 해를 넘으면 읽기에 해", () => {
    const bars = [
      { date: "2025-12-29", high: 300, low: 200, close: 250 },
      { date: "2026-01-02", high: 280, low: 210, close: 260 },
    ];
    expect(highLowTexts(bars, visibleExtremes(bars)!, { unit: "KRW", period: "D", current: 260 }).speech).toContain("최고 300원 2025년 12월 29일, 최저 200원 2025년 12월 29일");
  });
});

describe("가격 축 여백 (headroomDomain)", () => {
  const priceH = 194;
  const yOfD = (d: [number, number]) => (v: number) => priceH - ((v - d[0]) / (d[1] - d[0])) * priceH;
  const e = { hi: 255_000, lo: 181_100 };
  const cases: [string, [number, number]][] = [
    ["둘 다", [181_100 - 4_400, 255_000 + 4_400]],
    ["위만 (아래는 평단이 넓혀 둠)", [150_000, 255_000 + 4_000]],
    ["아래만 (위는 넓혀 둠)", [181_100 - 4_000, 300_000]],
    ["그대로 (이미 충분)", [100_000, 400_000]],
  ];
  it.each(cases)("%s: y(최고) ≥ 25 · y(최저) ≤ priceH − 21 · 원래 범위를 좁히지 않고 넓힌 쪽은 딱 맞음", (_, dom) => {
    const d = headroomDomain(dom, e, { priceH, top: HL_HEAD_TOP, bottom: HL_HEAD_BOTTOM });
    const y = yOfD(d);
    expect(y(e.hi)).toBeGreaterThanOrEqual(HL_HEAD_TOP - 1e-6);
    expect(y(e.lo)).toBeLessThanOrEqual(priceH - HL_HEAD_BOTTOM + 1e-6);
    expect(d[0]).toBeLessThanOrEqual(dom[0]);
    expect(d[1]).toBeGreaterThanOrEqual(dom[1]);
    if (d[1] > dom[1]) expect(Math.abs(y(e.hi) - HL_HEAD_TOP)).toBeLessThan(1e-6);
    if (d[0] < dom[0]) expect(Math.abs(y(e.lo) - (priceH - HL_HEAD_BOTTOM))).toBeLessThan(1e-6);
  });
  it("네 경우가 실제로 다르게 넓힌다", () => {
    const got = cases.map(([, dom]) => headroomDomain(dom, e, { priceH, top: HL_HEAD_TOP, bottom: HL_HEAD_BOTTOM }));
    expect(got[0]![0]).toBeLessThan(cases[0]![1][0]);
    expect(got[0]![1]).toBeGreaterThan(cases[0]![1][1]);
    expect(got[1]![0]).toBe(cases[1]![1][0]);
    expect(got[1]![1]).toBeGreaterThan(cases[1]![1][1]);
    expect(got[2]![0]).toBeLessThan(cases[2]![1][0]);
    expect(got[2]![1]).toBe(cases[2]![1][1]);
    expect(got[3]).toEqual(cases[3]![1]);
  });
  it("가격 칸이 너무 낮으면(a + b ≥ 0.6) 그대로", () => {
    expect(headroomDomain([181_000, 255_500], e, { priceH: 70, top: HL_HEAD_TOP, bottom: HL_HEAD_BOTTOM })).toEqual([181_000, 255_500]);
  });
  it("치수: 꼬리 끝 → 글자 상자 먼 끝 24, 위 25 · 아래 21", () => {
    expect(HL_REACH).toBe(HL.ARROW_GAP + HL.ARROW_LEN + HL.TEXT_GAP + HL.ASCENT + HL.DESCENT);
    expect([HL_REACH, HL_HEAD_TOP, HL_HEAD_BOTTOM]).toEqual([24, 25, 21]);
  });
});

describe("자리 (layoutHighLow)", () => {
  // 폭 369 그림, 봉 12개(30px 간격), 가격 칸 194 · 축 [80, 120]
  const plotW = 369, priceH = 194;
  const xOf = (i: number) => i * 30 + 15;
  const yOf = (v: number) => priceH - ((v - 80) / 40) * priceH;
  const texts = { high: "110원 (-5.0%, 26.07.27)", low: "90원 (+15.5%, 26.07.14)" };
  const w = (s: string) => textWidth(s) + LABEL_PAD * 2;
  const lay = (ex: { high: { index: number; value: number }; low: { index: number; value: number } }, extra: Partial<Parameters<typeof layoutHighLow>[0]> = {}) =>
    layoutHighLow({ plotW, bottomLimit: priceH + HL.BOTTOM_SLACK, xOf, yOf, ex, texts, ...extra });

  it("가운데 자리가 비어 있으면 글자 상자 가운데 = 화살표 x (토스 캡처처럼), 글자 기준 middle", () => {
    const [hi, lo] = lay({ high: { index: 5, value: 110 }, low: { index: 6, value: 90 } });
    expect(hi!.kind).toBe("high");
    expect(hi!.anchor).toBe("middle");
    expect((hi!.box.left + hi!.box.right) / 2).toBeCloseTo(xOf(5), 6);
    expect(hi!.tx).toBeCloseTo(xOf(5), 6);
    expect(hi!.box.right - hi!.box.left).toBeCloseTo(w(texts.high), 6);
    expect(lo!.anchor).toBe("middle");
    expect(lo!.showText && hi!.showText).toBe(true);
  });

  it("화살표: 최고는 꼬리 끝 2 위에서 아래를 가리키고(대 8), 글자 상자는 1 위 · 높이 13. 최저는 거꾸로", () => {
    const [hi, lo] = lay({ high: { index: 5, value: 110 }, low: { index: 6, value: 90 } });
    const yh = yOf(110), yl = yOf(90);
    expect(hi!.arrow).toEqual({ x: xOf(5), tipY: yh - 2, tailY: yh - 10 });
    expect(hi!.box.bottom).toBeCloseTo(yh - 11, 6);
    expect(hi!.box.bottom - hi!.box.top).toBe(13);
    expect(hi!.ty).toBeCloseTo(hi!.box.top + 10, 6);
    expect(lo!.arrow).toEqual({ x: xOf(6), tipY: yl + 2, tailY: yl + 10 });
    expect(lo!.box.top).toBeCloseTo(yl + 11, 6);
    expect(lo!.ty).toBeCloseTo(lo!.box.top + 10, 6);
    // 화살촉: 최고는 아래로 향한 꺾쇠(끝보다 위에 날개), 최저는 위로
    expect(arrowPath(hi!)).toBe(`M${xOf(5).toFixed(1)} ${(yh - 10).toFixed(1)}V${(yh - 2).toFixed(1)}M${(xOf(5) - 3).toFixed(1)} ${(yh - 5).toFixed(1)}L${xOf(5).toFixed(1)} ${(yh - 2).toFixed(1)}L${(xOf(5) + 3).toFixed(1)} ${(yh - 5).toFixed(1)}`);
    expect(arrowPath(lo!)).toContain(`L${xOf(6).toFixed(1)} ${(yl + 2).toFixed(1)}L${(xOf(6) + 3).toFixed(1)} ${(yl + 5).toFixed(1)}`);
    expect(arrowBox(hi!)).toEqual({ left: xOf(5) - 4, right: xOf(5) + 4, top: yh - 10, bottom: yh - 2 });
  });

  it("맨 왼쪽 봉: 상자는 그림 왼쪽 끝(2)에 붙고 글자는 화살표 쪽 끝 기준(start)", () => {
    const [hi] = lay({ high: { index: 0, value: 110 }, low: { index: 6, value: 90 } });
    expect(hi!.box.left).toBe(HL.EDGE);
    expect(hi!.anchor).toBe("start");
    expect(hi!.tx).toBe(HL.EDGE + LABEL_PAD);
    expect(hi!.arrow.x).toBe(xOf(0)); // 화살표는 가장자리로 밀지 않는다 (꼬리를 가리킨다)
  });

  it("맨 오른쪽 봉: 상자 오른쪽 = plotW − 2 (가격 축·현재가 태그로 넘어가지 않음), 글자 기준 end", () => {
    const [hi, lo] = lay({ high: { index: 11, value: 110 }, low: { index: 11, value: 90 } });
    for (const m of [hi!, lo!]) {
      expect(m.box.right).toBeCloseTo(plotW - HL.EDGE, 6);
      expect(m.box.right).toBeLessThanOrEqual(plotW);
      expect(m.anchor).toBe("end");
      expect(m.tx).toBeCloseTo(plotW - HL.EDGE - LABEL_PAD, 6);
    }
  });

  it("좁은 폰(360): 어디에 있든 상자는 그림 [2, plotW − 2] 안", () => {
    const narrowW = 360 - 50;
    const step = narrowW / 60;
    for (const i of [0, 1, 5, 29, 30, 55, 59]) {
      const marks = layoutHighLow({ plotW: narrowW, bottomLimit: 134 + 3, xOf: (k) => k * step + step / 2, yOf: (v) => 134 - ((v - 80) / 40) * 134, ex: { high: { index: i, value: 110 }, low: { index: 59 - i, value: 90 } }, texts: { high: "255,000원 (-22.3%, 26.07.27)", low: "181,100원 (+9.3%, 26.07.14)" } });
      for (const m of marks) {
        expect(m.box.left).toBeGreaterThanOrEqual(HL.EDGE - 1e-9);
        expect(m.box.right).toBeLessThanOrEqual(narrowW - HL.EDGE + 1e-9);
        expect(m.showText).toBe(true);
      }
    }
  });

  it("글자가 그림보다 넓으면 글자를 빼고 화살표만", () => {
    const marks = layoutHighLow({ plotW: 60, bottomLimit: priceH + 3, xOf, yOf, ex: { high: { index: 1, value: 110 }, low: { index: 0, value: 90 } }, texts });
    expect(marks.map((m) => m.showText)).toEqual([false, false]);
  });

  // 가운데 자리는 다른 글자가 막고 화살표 x 는 비어 있을 때 (모든 자리가 화살표 x ± 3 을 품으므로, 화살표 위를 덮는 상자는 세 자리를 다 막는다)
  it("오른쪽 반 봉: 가운데가 막히면 안쪽(왼쪽으로 뻗어 글자가 화살표에서 끝남), 안쪽도 막히면 바깥쪽, 셋 다 막히면 화살표만", () => {
    const ex = { high: { index: 6, value: 110 }, low: { index: 1, value: 90 } };
    const x = xOf(6); // 195 — 그림 가운데(184.5)보다 오른쪽
    const [base] = lay(ex);
    const row = { top: base!.box.top, bottom: base!.box.bottom };
    const right = { left: x + 10, right: x + 95, ...row };
    const left = { left: x - 95, right: x - 10, ...row };
    const [a] = lay(ex, { avoid: [right] });
    expect(a!.showText).toBe(true);
    expect(a!.anchor).toBe("end");
    expect(a!.box.right).toBeCloseTo(x + LABEL_PAD, 6);
    expect(a!.tx).toBeCloseTo(x, 6);
    expect(overlap(a!.box, right)).toBe(false);
    const [b] = lay(ex, { avoid: [left] });
    expect(b!.showText).toBe(true);
    expect(b!.anchor).toBe("start");
    expect(b!.box.left).toBeCloseTo(x - LABEL_PAD, 6);
    expect(overlap(b!.box, left)).toBe(false);
    const [c] = lay(ex, { avoid: [left, right] });
    expect(c!.showText).toBe(false);
    // 화살표는 그대로
    expect(c!.arrow).toEqual(base!.arrow);
  });

  it("왼쪽 반 봉의 안쪽은 오른쪽 (글자가 화살표에서 시작)", () => {
    const ex = { high: { index: 3, value: 110 }, low: { index: 9, value: 90 } };
    const x = xOf(3);
    const [base] = lay(ex);
    const [a] = lay(ex, { avoid: [{ left: 10, right: x - 10, top: base!.box.top, bottom: base!.box.bottom }] });
    expect(a!.anchor).toBe("start");
    expect(a!.box.left).toBeCloseTo(x - LABEL_PAD, 6);
  });

  it("차례는 [최고, 최저], 최저 글자는 늘 최고 글자 아래 (겹치지 않음)", () => {
    for (const [hv, lv] of [[110, 90], [101, 99], [120, 81]] as const) {
      const [hi, lo] = lay({ high: { index: 5, value: hv }, low: { index: 5, value: lv } });
      expect([hi!.kind, lo!.kind]).toEqual(["high", "low"]);
      expect(lo!.box.top).toBeGreaterThan(hi!.box.bottom);
    }
  });

  it("상자가 가격 칸 위(0)·아래 한계를 넘으면 글자를 뺀다 — 다만 소수 오차(1e-12)는 봐준다", () => {
    const top = layoutHighLow({ plotW, bottomLimit: priceH + 3, xOf, yOf: (v) => (v > 100 ? 10 : 150), ex: { high: { index: 5, value: 110 }, low: { index: 1, value: 90 } }, texts });
    expect(top[0]!.showText).toBe(false);
    expect(top[1]!.showText).toBe(true);
    const deep = layoutHighLow({ plotW, bottomLimit: priceH + 3, xOf, yOf: (v) => (v > 100 ? 60 : priceH - 10), ex: { high: { index: 5, value: 110 }, low: { index: 1, value: 90 } }, texts });
    expect(deep[1]!.showText).toBe(false);
    // 최저 상자 아래 끝 = 한계 + 1e-12 (여백을 딱 맞게 낸 경우의 소수 오차) → 보인다
    const limit = priceH + 3;
    const exact = layoutHighLow({ plotW, bottomLimit: limit, xOf, yOf: (v) => (v > 100 ? 60 : limit - HL_REACH + 1e-12), ex: { high: { index: 5, value: 110 }, low: { index: 1, value: 90 } }, texts });
    expect(exact[1]!.box.bottom).toBeGreaterThan(limit);
    expect(exact[1]!.showText).toBe(true);
  });
});

describe("평단 글자와 맞추기 (settleWithInside)", () => {
  const plotW = 369;
  const xOf = (i: number) => i * 30 + 15, yOf = (v: number) => 194 - ((v - 80) / 40) * 194;
  const ex = { high: { index: 5, value: 110 }, low: { index: 1, value: 90 } };
  const texts = { high: "110원 (-5.0%, 26.07.27)", low: "90원 (+15.5%, 26.07.14)" };
  const relayout = (avoid: Box[]) => layoutHighLow({ plotW, bottomLimit: 197, xOf, yOf, ex, texts, avoid });
  const base = relayout([]);

  it("겹침이 없으면 그대로 (같은 표시 객체)", () => {
    const r = settleWithInside({ marks: base, labels: [{ keep: true }], placed: [{ box: { left: 300, right: 360, top: 150, bottom: 163 } }], relayout });
    expect(r.marks).toBe(base);
  });

  it("평단(keep) 글자가 최고 글자 가운데 자리를 막으면 최고를 안쪽 자리로, 새 자리와 겹치는 52주 글자는 뺀다, 평단은 늘 남음", () => {
    const x = xOf(5); // 165 — 왼쪽 반 봉이라 안쪽은 오른쪽
    const row = { top: base[0]!.box.top, bottom: base[0]!.box.bottom };
    // 평단 글자: 가운데 자리의 왼쪽 부분 (화살표 x 는 비어 있다)
    const avgBox = { left: 20, right: x - 10, ...row };
    // 52주 글자: 최고의 안쪽 자리(화살표에서 오른쪽으로)에 놓여 있다
    const h52 = { left: x + 40, right: x + 100, ...row };
    const r = settleWithInside({ marks: base, labels: [{ keep: true }, {}], placed: [{ box: avgBox }, { box: h52 }], relayout });
    expect(r.placed[0]).toEqual({ box: avgBox });
    expect(r.marks[0]!.showText).toBe(true);
    expect(r.marks[0]!.anchor).toBe("start");
    expect(r.marks[0]!.box.left).toBeCloseTo(x - LABEL_PAD, 6);
    expect(overlap(r.marks[0]!.box, avgBox)).toBe(false);
    expect(r.placed[1]).toBeNull();
  });

  it("평단을 피할 자리가 하나도 없으면 최고·최저 글자를 빼고 화살표만 (평단은 남음)", () => {
    const wide = { left: 0, right: plotW, top: base[0]!.box.top - 1, bottom: base[0]!.box.bottom + 1 };
    const r = settleWithInside({ marks: base, labels: [{ keep: true }], placed: [{ box: wide }], relayout });
    expect(r.placed[0]).not.toBeNull();
    expect(r.marks[0]!.showText).toBe(false);
    expect(r.marks[1]!.showText).toBe(true);
  });
});

describe("드래그 흉내: 800봉 · 보이는 120봉을 끝까지 옮기며 매 걸음 (폴드8 접힘 가격 칸 194)", () => {
  const DAY = 86_400_000;
  const series = Array.from({ length: 800 }, (_, i) => {
    const c = 200_000 + 40_000 * Math.sin(i / 23) + 9_000 * Math.sin(i / 3.7);
    return { date: new Date(Date.UTC(2024, 0, 1) + i * DAY).toISOString().slice(0, 10), open: c - 500, high: c + 1_500 + (i % 7) * 300, low: c - 1_500 - (i % 5) * 300, close: c + 500 };
  });
  const priceH = 194, plotW = 419 - 50, count = 120, step = plotW / count, bodyW = Math.min(step * 0.7, 14);
  const current = series.at(-1)!.close, avg = 205_000, high52 = 260_000, low52 = 150_000;

  function frame(offset: number, withHL: boolean) {
    const end = series.length - offset, start = end - count;
    const visible = series.slice(start, end);
    const base = priceDomain({ bars: visible, current: offset === 0 ? current : null, avg });
    const e = withHL ? visibleExtremes(visible) : null;
    const domain = e ? headroomDomain(base, { hi: e.high.value, lo: e.low.value }, { priceH, top: HL_HEAD_TOP, bottom: HL_HEAD_BOTTOM }) : base;
    const yOf = (v: number) => priceH - ((v - domain[0]) / (domain[1] - domain[0])) * priceH;
    const xOf = (i: number) => i * step + step / 2;
    const bars = visible.map((c, i) => ({ left: xOf(i) - bodyW / 2, right: xOf(i) + bodyW / 2, top: yOf(c.high), bottom: yOf(c.low) }));
    const texts = e ? highLowTexts(visible, e, { unit: "KRW", period: "D", current }) : null;
    const relayout = (avoid?: Box[]): HighLowMark[] => (e && texts ? layoutHighLow({ plotW, bottomLimit: priceH + HL.BOTTOM_SLACK, xOf, yOf, ex: e, texts, avoid }) : []);
    const marks = relayout();
    const inRange = (v: number) => v > domain[0] && v < domain[1];
    const labels = [
      ...(inRange(avg) ? [{ y: yOf(avg), text: `평단 ${avg.toLocaleString("ko-KR")}`, prefer: "left" as const, keep: true }] : []),
      ...(inRange(high52) ? [{ y: yOf(high52), text: "52주 최고", prefer: "right" as const }] : []),
      ...(inRange(low52) ? [{ y: yOf(low52), text: "52주 최저", prefer: "right" as const }] : []),
    ];
    const placed = placeInsideLabels({ plotW, plotH: priceH, bottomSlack: 8, bars, labels, lines: offset === 0 ? [yOf(current)] : [], avoid: marks.flatMap((m) => [arrowBox(m), ...(m.showText ? [m.box] : [])]) });
    const s = settleWithInside({ marks, labels, placed, relayout });
    return { marks: s.marks, placed: s.placed, e };
  }

  it("글자 상자는 늘 그림 안 · 가격 칸 위아래 안, 평단·52주 글자와 겹침 0, 글자는 대부분 보인다", () => {
    let shown = 0, arrowsOnly = 0;
    for (let off = 0; off <= series.length - count; off++) {
      const { marks, placed, e } = frame(off, true);
      expect(e).not.toBeNull();
      expect(marks).toHaveLength(2);
      for (const m of marks) {
        expect(m.box.left).toBeGreaterThanOrEqual(HL.EDGE - 1e-9);
        expect(m.box.right).toBeLessThanOrEqual(plotW - HL.EDGE + 1e-9);
        if (!m.showText) {
          arrowsOnly++;
          continue;
        }
        shown++;
        expect(m.box.top).toBeGreaterThanOrEqual(-0.5);
        expect(m.box.bottom).toBeLessThanOrEqual(priceH + HL.BOTTOM_SLACK + 0.5);
        for (const p of placed) if (p) expect(overlap(p.box, m.box), `걸음 ${off} ${m.kind}`).toBe(false);
      }
    }
    expect(shown).toBeGreaterThan((shown + arrowsOnly) * 0.95);
  });

  it("시간 지킴이(느슨하게): 681걸음 전체 계산(축 범위·최고·최저·글자 자리·평단·52주 자리)이 2초 미만 (CI 느린 러너 여유 — 이 PC 실측 약 60ms)", () => {
    frame(0, true);
    const t0 = performance.now();
    for (let off = 0; off <= series.length - count; off++) frame(off, true);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
