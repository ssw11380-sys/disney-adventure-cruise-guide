import { describe, expect, it } from "vitest";
import { AVG_BAND, DOMAIN_PAD, LINE_OVERSHOOT, placeInsideLabels, priceDomain, textWidth, topOverlayAlign, type Box } from "@/lib/chartBasis";
import { pastViewText } from "@/lib/chartLayout";
import { bollinger, sma } from "@/lib/indicators";

/**
 * 가격 축 범위와 그림 안쪽 글자 자리 (2026-09-26 사용자 RGTX 접은 화면 캡처 — 버그 수정, 플래그 없음).
 *  - 120일선의 옛 값(110,000원)이 축을 넓혀 봉(13,000~16,000원)이 차트 아래 6분의 1에 눌렸다 → 선은 봉 범위 + 조금까지만
 *  - '평단 18,599' · '52주 최저' 글자가 봉·서로 겹쳤다 → 겹치지 않는 자리(위·아래·반대쪽)로
 */

/** 예전(3-42 까지) 가격 범위 계산 그대로 — 선이 봉 범위 안이면 새 계산과 같아야 한다 */
function oldDomain(o: { bars: { low: number; high: number }[]; lines: (number | null)[][]; current?: number | null; avg?: number | null }): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const c of o.bars) {
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  }
  for (const s of o.lines)
    for (const v of s)
      if (v !== null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
  if (o.current) {
    lo = Math.min(lo, o.current);
    hi = Math.max(hi, o.current);
  }
  const band = (hi - lo) * 0.25;
  if (o.avg && o.avg > lo - band && o.avg < hi + band) {
    lo = Math.min(lo, o.avg);
    hi = Math.max(hi, o.avg);
  }
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.01 || 1;
  return [lo - pad, hi + pad];
}

/** 일봉 n 개: close(i) 로 종가, 고가·저가는 종가 ± spread */
function series(n: number, close: (i: number) => number, spread = 400) {
  return Array.from({ length: n }, (_, i) => {
    const c = close(i);
    return { open: c, close: c, high: c + spread, low: c - spread };
  });
}

/** RGTX 와 비슷한 모양: 앞 130일은 200,000 → 20,000 원으로 떨어지고, 보이는 마지막 120일은 13,100~15,900 원 */
const RGTX = [...series(130, (i) => 200_000 - (180_000 * i) / 129, 2_000), ...series(120, (i) => 14_500 + 1_000 * Math.sin(i / 5))];

describe("가격 축 범위 (priceDomain)", () => {
  it("RGTX 모양: 120일선이 110,000원대에서 시작해도 축은 봉 범위 + 조금 (≈ 12,500 ~ 17,000원)", () => {
    const closes = RGTX.map((c) => c.close);
    const start = RGTX.length - 120;
    const visible = RGTX.slice(start);
    const lines = [5, 20, 60, 120].map((p) => sma(closes, p).slice(start));
    // 120일선의 보이는 첫 값은 10만원이 넘는다 (캡처의 보라 선)
    expect(lines[3]![0]!).toBeGreaterThan(100_000);
    const [lo, hi] = priceDomain({ bars: visible, lines, current: 14_430, avg: 18_599 });
    expect(lo).toBeGreaterThan(12_500);
    expect(lo).toBeLessThan(13_100);
    expect(hi).toBeGreaterThan(15_900);
    expect(hi).toBeLessThan(17_000);
    // 예전 계산은 선 값을 모두 넣어 위가 10만원을 넘었다 (봉이 아래 6분의 1)
    expect(oldDomain({ bars: visible, lines, current: 14_430, avg: 18_599 })[1]).toBeGreaterThan(100_000);
  });

  it("선은 봉(+현재가) 범위에서 폭의 LINE_OVERSHOOT 까지만 넓힌다 — 위아래 모두", () => {
    const bars = [{ low: 1_000, high: 2_000 }];
    const room = 1_000 * LINE_OVERSHOOT;
    const pad = (x: number) => x * DOMAIN_PAD;
    expect(priceDomain({ bars, lines: [[5_000, 100]] })).toEqual([1_000 - room - pad(1_000 + 2 * room), 2_000 + room + pad(1_000 + 2 * room)]);
    // 조금 넘는 선(한도 안)은 모두 보인다 (예전과 같다)
    expect(priceDomain({ bars, lines: [[2_050, 960]] })).toEqual(oldDomain({ bars, lines: [[2_050, 960]] }));
  });

  it("보통 종목(선이 봉 범위 안)은 예전 계산과 똑같다 — 이동평균·볼린저·현재가·평단 조합", () => {
    // 옆으로 오가는 종목: 이동평균·볼린저가 모두 봉 범위 안
    const bars = series(250, (i) => 80_000 + 3_000 * Math.sin(i / 3), 3_000);
    const closes = bars.map((c) => c.close);
    for (const count of [60, 120]) {
      const start = bars.length - count;
      const visible = bars.slice(start);
      const bb = bollinger(closes, 20, 2);
      const lines = [...[5, 20, 60, 120].map((p) => sma(closes, p).slice(start)), bb.upper.slice(start), bb.lower.slice(start)];
      const lo = Math.min(...visible.map((c) => c.low));
      const hi = Math.max(...visible.map((c) => c.high));
      for (const s of lines) for (const v of s) if (v !== null) expect(v >= lo && v <= hi, `${count}`).toBe(true);
      for (const extra of [{}, { current: 81_000 }, { avg: 79_500 }, { current: 84_000, avg: 90_000 }, { avg: 200_000 }])
        expect(priceDomain({ bars: visible, lines, ...extra }), `${count} ${JSON.stringify(extra)}`).toEqual(oldDomain({ bars: visible, lines, ...extra }));
    }
  });

  it("현재가는 넘겨받을 때만(최신 구간), 평단은 ±AVG_BAND 안쪽만 축에 넣는다", () => {
    const bars = [{ low: 100, high: 200 }];
    expect(priceDomain({ bars, current: 260 })[1]).toBeGreaterThan(260);
    expect(priceDomain({ bars })[1]).toBeLessThan(210);
    expect(priceDomain({ bars, avg: 200 + 100 * AVG_BAND - 1 })[1]).toBeGreaterThan(224);
    expect(priceDomain({ bars, avg: 200 + 100 * AVG_BAND + 1 })[1]).toBeLessThan(210);
  });

  it("봉이 없으면 [0, 1], 한 값뿐이어도 폭이 0 이 아니다", () => {
    expect(priceDomain({ bars: [] })).toEqual([0, 1]);
    const [lo, hi] = priceDomain({ bars: [{ low: 5_000, high: 5_000 }], lines: [[9_000]] });
    expect(hi - lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(5_200);
  });
});

describe("그림 안쪽 글자 자리 (placeInsideLabels)", () => {
  // 폭 300 · 높이 200 그림, 봉 30개(10px 간격). 기본 봉은 y 100~140
  const bars = (f: (i: number) => [number, number]): Box[] => Array.from({ length: 30 }, (_, i) => ({ left: i * 10 + 2, right: i * 10 + 8, top: f(i)[0], bottom: f(i)[1] }));
  const base = bars(() => [100, 140]);
  const place = (b: Box[], labels: Parameters<typeof placeInsideLabels>[0]["labels"]) => placeInsideLabels({ plotW: 300, plotH: 200, bars: b, labels });
  const hitsBars = (box: Box, b: Box[]) => b.some((x) => x.left < box.right && box.left < x.right && x.top < box.bottom && box.top < x.bottom);

  it("가리는 것이 없으면 예전 자리: 평단은 선 위 왼쪽, 52주는 선 위 오른쪽 (글자 상자 = 글자 폭 + 6)", () => {
    const [avg, h52] = place(base, [
      { y: 60, text: "평단 18,599", prefer: "left" },
      { y: 30, text: "52주 최고", prefer: "right" },
    ]);
    expect(avg).toMatchObject({ side: "left", ty: 56, x: 5, box: { left: 2, top: 46, bottom: 59 } });
    expect(avg!.box.right - avg!.box.left).toBeCloseTo(textWidth("평단 18,599") + 6, 5);
    expect(h52).toMatchObject({ side: "right", ty: 26, x: 295 });
    expect(h52!.box.right).toBe(298);
  });

  it("그림 맨 위에 붙은 선은 선 아래에 적는다", () => {
    const [s] = place(base, [{ y: 5, text: "52주 최고", prefer: "right" }]);
    expect(s).toMatchObject({ side: "right", ty: 17 });
  });

  it("오늘 52주 신저가: 오른쪽 끝 봉이 글자 자리를 덮으면 선 아래 → 그래도 가리면 왼쪽으로", () => {
    // 마지막 봉들이 선(y 150) 위아래를 모두 덮는다
    const b = bars((i) => (i >= 24 ? [120, 175] : [40, 80]));
    const [s] = place(b, [{ y: 150, text: "52주 최저", prefer: "right" }]);
    expect(s!.side).toBe("left");
    expect(hitsBars(s!.box, b)).toBe(false);
    // 선 아래가 비어 있으면 쪽은 그대로 두고 아래로
    const b2 = bars((i) => (i >= 24 ? [120, 149] : [40, 80]));
    const [s2] = place(b2, [{ y: 150, text: "52주 최저", prefer: "right" }]);
    expect(s2).toMatchObject({ side: "right", ty: 162 });
  });

  it("평단 글자가 앞쪽 봉을 가리면 가리지 않는 곳으로 (RGTX: 왼쪽 위 → 아래 또는 오른쪽)", () => {
    const b = bars((i) => (i <= 8 ? [40, 100] : [150, 190]));
    const [s] = place(b, [{ y: 90, text: "평단 18,599", prefer: "left" }]);
    expect(hitsBars(s!.box, b)).toBe(false);
  });

  it("가까운 두 글자(평단 · 52주 최저)는 서로 겹치지 않는다", () => {
    for (const gap of [0, 4, 8, 13]) {
      const spots = place(base, [
        { y: 60, text: "평단 18,599", prefer: "left" },
        { y: 60 + gap, text: "52주 최저", prefer: "left" },
      ]);
      const [a, c] = spots.map((s) => s.box);
      expect(a!.left < c!.right && c!.left < a!.right && a!.top < c!.bottom && c!.top < a!.bottom, `${gap}`).toBe(false);
    }
  });

  it("고정 글자(범위 밖 평단)는 위아래로 옮기지 않고 쪽만 바꾼다", () => {
    const b = bars((i) => (i <= 10 ? [0, 30] : [100, 140]));
    const [s] = place(b, [{ y: 12, text: "평단(범위 위) 18,599", prefer: "left", fixed: true }]);
    expect(s).toMatchObject({ side: "right", ty: 12 });
  });
});

describe("과거 구간 안내 버튼 자리 (topOverlayAlign)", () => {
  // 폭 300 그림, 봉 30개. 버튼 폭 120 · 위에서 36 까지
  const bars = (f: (i: number) => number): Box[] => Array.from({ length: 30 }, (_, i) => ({ left: i * 10 + 2, right: i * 10 + 8, top: f(i), bottom: 190 }));
  const align = (b: Box[]) => topOverlayAlign({ plotW: 300, width: 120, bottom: 36, bars: b });

  it("위쪽이 비어 있으면 가운데", () => expect(align(bars(() => 100))).toBe("center"));
  it("가운데에 급등한 봉 꼭대기가 있으면 비어 있는 쪽 (RGTX 6월 급등)", () => {
    expect(align(bars((i) => (i >= 12 && i <= 17 ? 5 : 100)))).toBe("left");
  });
  it("오르는 종목(최신 봉이 오른쪽 위)은 가운데가 비어 있으면 가운데, 가운데도 막히면 왼쪽", () => {
    expect(align(bars((i) => (i >= 25 ? 5 : 100)))).toBe("center");
    expect(align(bars((i) => (i >= 12 ? 5 : 100)))).toBe("left");
  });
  it("내리는 종목(옛 봉이 왼쪽 위)·가운데 막힘이면 오른쪽", () => {
    expect(align(bars((i) => (i <= 18 ? 5 : 100)))).toBe("right");
  });
});

describe("과거 구간 안내 글 (pastViewText)", () => {
  it("일·주·월·분 단위", () => {
    expect(pastViewText(2, "D")).toBe("2일 전까지 보는 중");
    expect(pastViewText(3, "W")).toBe("3주 전까지 보는 중");
    expect(pastViewText(4, "M")).toBe("4개월 전까지 보는 중");
    expect(pastViewText(7, "1m")).toBe("7분 전까지 보는 중");
    expect(pastViewText(3, "5m")).toBe("15분 전까지 보는 중");
    expect(pastViewText(65, "30m")).toBe("1,950분 전까지 보는 중");
    expect(pastViewText(1_200, "D")).toBe("1,200일 전까지 보는 중");
  });

  it("최신 구간이면 없음", () => {
    expect(pastViewText(0, "D")).toBeNull();
    expect(pastViewText(-1, "D")).toBeNull();
    expect(pastViewText(Number.NaN, "D")).toBeNull();
  });
});
