import { describe, expect, it } from "vitest";
import { AVG_BAND, DOMAIN_PAD, LABEL_GUARD_BARS, LINE_OVERSHOOT, placeInsideLabels, priceDomain, textWidth, topOverlayAlign, type Box } from "@/lib/chartBasis";
import { pastViewLabel } from "@/lib/chartLayout";
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
  const place = (b: Box[], labels: Parameters<typeof placeInsideLabels>[0]["labels"], extra: Partial<Parameters<typeof placeInsideLabels>[0]> = {}) =>
    placeInsideLabels({ plotW: 300, plotH: 200, bars: b, labels, ...extra });
  const hitsBars = (box: Box, b: Box[]) => b.filter((x) => x.left < box.right && box.left < x.right && x.top < box.bottom && box.top < x.bottom).length;
  const overlap = (a: Box, c: Box) => a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;

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

  it("오늘 52주 신저가: 오른쪽 끝 봉이 글자 자리를 덮으면 선 아래, 그것도 막히면 봉이 없는 곳으로 가로로 옮긴다 (최신 봉은 덮지 않는다)", () => {
    // 마지막 봉들이 선(y 150) 위아래를 모두 덮는다
    const b = bars((i) => (i >= 24 ? [120, 175] : [40, 80]));
    const [s] = place(b, [{ y: 150, text: "52주 최저", prefer: "right" }]);
    expect(hitsBars(s!.box, b)).toBe(0);
    // 되도록 예전 자리(오른쪽) 가까이: 막힌 봉 바로 왼쪽
    expect(s!.box.right).toBeLessThanOrEqual(242);
    expect(s!.box.right).toBeGreaterThan(230);
    // 선 아래가 비어 있으면 자리는 그대로 두고 아래로
    const b2 = bars((i) => (i >= 24 ? [120, 149] : [40, 80]));
    const [s2] = place(b2, [{ y: 150, text: "52주 최저", prefer: "right" }]);
    expect(s2).toMatchObject({ side: "right", ty: 162 });
  });

  it("평단 글자가 앞쪽 봉을 가리면 가리지 않는 곳으로 (RGTX: 왼쪽 위 → 아래 또는 옆)", () => {
    const b = bars((i) => (i <= 8 ? [40, 100] : [150, 190]));
    const [s] = place(b, [{ y: 90, text: "평단 18,599", prefer: "left" }]);
    expect(hitsBars(s!.box, b)).toBe(0);
  });

  it("가까운 두 글자(평단 · 52주 최저)는 서로 겹치지 않고, 나란히 놓여도 조금 띄운다", () => {
    for (const gap of [0, 4, 8, 13]) {
      const spots = place(base, [
        { y: 60, text: "평단 18,599", prefer: "left" },
        { y: 60 + gap, text: "52주 최저", prefer: "left" },
      ]);
      const [a, c] = spots.map((s) => s!.box);
      expect(overlap(a!, c!), `${gap}`).toBe(false);
      if (a!.top < c!.bottom && c!.top < a!.bottom) expect(Math.max(c!.left - a!.right, a!.left - c!.right), `${gap}`).toBeGreaterThanOrEqual(4);
    }
  });

  it("고정 글자(범위 밖 평단)는 위아래로 옮기지 않고 봉이 없는 곳으로 가로로만 옮긴다", () => {
    const b = bars((i) => (i <= 10 ? [0, 30] : [100, 140]));
    const [s] = place(b, [{ y: 12, text: "평단(범위 위) 18,599", prefer: "left", fixed: true }]);
    expect(s!.ty).toBe(12);
    expect(hitsBars(s!.box, b)).toBe(0);
  });

  it("RGTX(오늘 52주 신저가): 먼저 놓은 평단 글자가 왼쪽을 막아도 '52주 최저'가 최신 봉을 덮지 않는다 — 예전에는 최신 봉 16개를 덮었다", () => {
    // 접은 화면 475 의 가격 칸(폭 373 · 높이 194), 봉 120개. 52주 최저선 y 184 (선 아래는 그림 밖), 평단선은 11.3 위 →
    // 왼쪽 선 위 자리는 평단 글자와 1.7px 겹친다. 최근 40봉은 52주 최저선 바로 위(168~183), 그 앞 봉은 위쪽(60~150)
    const step = 373 / 120;
    const b: Box[] = Array.from({ length: 120 }, (_, i) => {
      const x = i * step + step / 2;
      return { left: x - 1.1, right: x + 1.1, top: i >= 80 ? 168 : 60 + (i % 7) * 10, bottom: i >= 80 ? 183 : 90 + (i % 7) * 8 };
    });
    const labels = [
      { y: 172.7, text: "평단 19,064", prefer: "left" as const, keep: true },
      { y: 184, text: "52주 최저", prefer: "right" as const },
    ];
    // 가격 칸 아래 틈(거래량 칸 앞)까지 글자 상자를 놓을 수 있다 (PriceChart 는 거래량 칸이 있으면 8)
    const [avg, low] = placeInsideLabels({ plotW: 373, plotH: 194, bars: b, labels, lines: [179], bottomSlack: 8 });
    expect(avg).not.toBeNull();
    expect(low).not.toBeNull();
    expect(overlap(avg!.box, low!.box)).toBe(false);
    // 선 위 자리(171~187)는 현재가선(179)을 끊는다 → 선 아래
    expect(low!.box.top).toBeGreaterThan(184);
    expect(low!.box.bottom).toBeLessThanOrEqual(194 + 8);
    // 최신 봉(오른쪽 끝 LABEL_GUARD_BARS 개)은 물론 어떤 봉도 덮지 않는다
    expect(hitsBars(low!.box, b.slice(-LABEL_GUARD_BARS))).toBe(0);
    expect(hitsBars(low!.box, b)).toBe(0);
    expect(hitsBars(avg!.box, b)).toBe(0);
  });

  it("어디에 놓아도 최신 봉을 덮거나 봉을 많이 덮거나 다른 글자와 겹치면 글자를 빼고 선만 (평단은 빼지 않는다)", () => {
    // 봉 60개(5px 간격)가 선(y 150) 위아래를 그림 전체에 걸쳐 덮는다 → 어디에 놓아도 지난 봉 LABEL_DROP_BARS 개 이상
    const full: Box[] = Array.from({ length: 60 }, (_, i) => ({ left: i * 5 + 1, right: i * 5 + 4, top: 120, bottom: 190 }));
    const [avg, low] = place(full, [
      { y: 150, text: "평단 18,599", prefer: "left", keep: true },
      { y: 150, text: "52주 최저", prefer: "right" },
    ]);
    expect(avg).not.toBeNull();
    expect(low).toBeNull();
    // 덮는 봉이 적으면(봉 사이가 넓은 확대 화면) 남긴다
    const [, sparse] = place(bars(() => [120, 190]), [
      { y: 150, text: "평단 18,599", prefer: "left", keep: true },
      { y: 150, text: "52주 최저", prefer: "right" },
    ]);
    expect(sparse).not.toBeNull();
    // 최신 봉(오른쪽 끝)만 선을 덮고 나머지는 비었으면 최신 봉을 피해 남긴다
    const [s3] = place(bars((i) => (i >= 25 ? [120, 190] : [20, 60])), [{ y: 150, text: "52주 최저", prefer: "right" }]);
    expect(s3).not.toBeNull();
    expect(s3!.box.right).toBeLessThanOrEqual(252);
    // 폭이 모자라 글자가 들어가지 않으면 평단이 아닌 글자는 빠진다
    const narrow = placeInsideLabels({ plotW: 40, plotH: 200, bars: [], labels: [{ y: 100, text: "52주 최고", prefer: "right" }] });
    expect(narrow[0]).toBeNull();
  });

  it("다른 가로선(현재가선)이 글자를 가로지르지 않는 자리가 있으면 그곳", () => {
    // 평단선 y 100, 현재가선 y 94 → 선 위 글자(86~99)는 현재가선이 가로지른다 → 선 아래(102~115)
    const [s] = place(bars(() => [150, 190]), [{ y: 100, text: "평단 18,599", prefer: "left", keep: true }], { lines: [94] });
    expect(s!.box.top).toBeGreaterThan(100);
    const [t2] = place(bars(() => [150, 190]), [{ y: 100, text: "평단 18,599", prefer: "left", keep: true }]);
    expect(t2!.box.bottom).toBeLessThan(100);
  });

  it("현재가선이 가로지르는 자리는 봉 몇 개를 덮는 자리보다 나쁘고, 그런 자리밖에 없으면 52주 글자는 뺀다 (평단은 남긴다)", () => {
    // 52주 최저선 y 184 · 현재가선 179 · 그림 높이 194: 선 위 자리(171~187)는 현재가선을 끊고, 선 아래(186~199)는 그림 밖
    const low = { y: 184, text: "52주 최저", prefer: "right" as const };
    expect(place([], [low], { plotH: 194, lines: [179] })[0]).toBeNull();
    // 가격 칸 아래 틈을 주면 선 아래
    expect(place([], [low], { plotH: 194, lines: [179], bottomSlack: 8 })[0]!.box.top).toBeGreaterThan(184);
    // 평단은 빼지 않는다 (현재가선을 끊더라도)
    expect(place([], [{ ...low, text: "평단 13,000", keep: true }], { plotH: 194, lines: [179] })[0]).not.toBeNull();
    // 선 위는 어디든 현재가선(95)을 끊고, 선 아래는 어디든 지난 봉 몇 개(8개 미만)를 덮는다 → 선 아래 (예전 점수로는 현재가선 3점 < 봉 6개라 선 위)
    const b = bars(() => [105, 120]);
    const [s] = place(b, [{ y: 100, text: "52주 최고", prefer: "right" }], { lines: [95] });
    expect(s).not.toBeNull();
    expect(s!.box.top).toBeGreaterThan(95);
  });

  it("plotTop(과거 구간 안내 버튼 자리) 위로는 글자 상자를 놓지 않는다", () => {
    // 선 y 45: 선 위 자리(31~44)는 버튼 자리(0~40)에 걸린다 → 선 아래
    const [s] = place(base, [{ y: 45, text: "52주 최고", prefer: "right" }], { plotTop: 40 });
    expect(s!.box.top).toBeGreaterThanOrEqual(40);
    expect(s!.ty).toBe(57);
    // 버튼 자리가 없으면 예전처럼 선 위
    expect(place(base, [{ y: 45, text: "52주 최고", prefer: "right" }])[0]!.ty).toBe(41);
  });

  it("벗어난 이동평균 표시(글자 앞 색 네모 lead)는 상자가 그만큼 넓고 늘 왼쪽 맞춤, 평단 글자와 나란히 겹치지 않게", () => {
    const [avg, ma] = place(base, [
      { y: 12, text: "평단(범위 위) 19,064", prefer: "left", fixed: true, keep: true },
      { y: 12, text: "120일선(범위 위)", prefer: "right", fixed: true, lead: 11 },
    ]);
    expect(ma!.box.right - ma!.box.left).toBeCloseTo(textWidth("120일선(범위 위)") + 11 + 6, 5);
    expect(ma!.side).toBe("left");
    expect(ma!.box.right).toBe(298);
    expect(overlap(avg!.box, ma!.box)).toBe(false);
  });
});

describe("과거 구간 안내 버튼 자리 (topOverlayAlign)", () => {
  // 폭 300 그림, 봉 30개. 버튼 폭 120 · 위에서 36 까지
  const bars = (f: (i: number) => number): Box[] => Array.from({ length: 30 }, (_, i) => ({ left: i * 10 + 2, right: i * 10 + 8, top: f(i), bottom: 190 }));
  const align = (b: Box[], labels?: Box[]) => topOverlayAlign({ plotW: 300, width: 120, bottom: 36, bars: b, labels }).align;

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
  it("그림 안 글자(범위 밖 평단 — 왼쪽 위)를 덮지 않는 쪽으로, 점수 0 이면 아무것도 덮지 않는다", () => {
    const avgLabel: Box = { left: 2, right: 126, top: 2, bottom: 15 };
    expect(align(bars(() => 100), [avgLabel])).toBe("right");
    expect(topOverlayAlign({ plotW: 300, width: 120, bottom: 36, bars: bars(() => 100), labels: [avgLabel] }).cost).toBe(0);
    // 글자 하나는 봉 몇 개보다 무겁다 (봉 3개를 덮는 쪽이 평단 글자를 덮는 쪽보다 낫다)
    expect(align(bars((i) => (i >= 27 ? 5 : 100)), [avgLabel])).toBe("right");
  });
});

describe("과거 구간 안내 글 (pastViewLabel)", () => {
  it("일·주·월: 긴 글과 짧은 글", () => {
    expect(pastViewLabel(2, "D")).toEqual({ text: "2일 전까지 보는 중", short: "2일 전" });
    expect(pastViewLabel(3, "W")).toEqual({ text: "3주 전까지 보는 중", short: "3주 전" });
    expect(pastViewLabel(4, "M")).toEqual({ text: "4개월 전까지 보는 중", short: "4개월 전" });
    expect(pastViewLabel(1_200, "D")?.text).toBe("1,200일 전까지 보는 중");
  });

  it("분봉: 같은 날이면 분·시간, 다른 날까지 갔으면 보이는 마지막 봉의 날짜·시각 (예전 '1,950분 전'은 30분봉 5일치였다)", () => {
    const today = { date: "2026-09-24" };
    const same = (time: string) => ({ last: { date: "2026-09-24", time }, latest: today });
    expect(pastViewLabel(7, "1m", same("2026-09-24T15:13:00-04:00"))).toEqual({ text: "7분 전까지 보는 중", short: "7분 전" });
    expect(pastViewLabel(3, "5m", same("2026-09-24T15:40:00-04:00"))?.text).toBe("15분 전까지 보는 중");
    expect(pastViewLabel(13, "5m", same("2026-09-24T14:55:00-04:00"))).toEqual({ text: "1시간 5분 전까지 보는 중", short: "1시간 5분 전" });
    expect(pastViewLabel(4, "30m", same("2026-09-24T13:30:00-04:00"))?.text).toBe("2시간 전까지 보는 중");
    expect(pastViewLabel(65, "30m", { last: { date: "2026-09-17", time: "2026-09-17T14:30:00-04:00" }, latest: today })).toEqual({
      text: "9월 17일 14:30까지 보는 중",
      short: "9/17 14:30까지",
    });
    // 날짜를 모르면(봉을 넘기지 않으면) 분·시간
    expect(pastViewLabel(3, "5m")?.text).toBe("15분 전까지 보는 중");
  });

  it("최신 구간이면 없음", () => {
    expect(pastViewLabel(0, "D")).toBeNull();
    expect(pastViewLabel(-1, "D")).toBeNull();
    expect(pastViewLabel(Number.NaN, "D")).toBeNull();
  });
});
