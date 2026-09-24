import { describe, expect, it } from "vitest";
import { contrast, deltaE2000 } from "@/lib/color";
import { dark, light, type Theme } from "@/tokens";

/** 글자로 쓰는 색 (바탕 3종 위에서 4.5 이상) */
const TEXT = ["ink", "sub", "muted", "accent", "gold", "up", "down", "live", "warn", "danger"] as const;
const BACK = ["bg", "surface", "surfaceAlt"] as const;

describe.each([
  ["다크", dark],
  ["라이트", light],
] as [string, Theme][])("디자인 토큰 %s (3-20)", (_name, t) => {
  it("글자/바탕 조합 대비 4.5 이상", () => {
    const low: string[] = [];
    for (const fg of TEXT) for (const bg of BACK) if (contrast(t[fg], t[bg]) < 4.5) low.push(`${fg}/${bg} ${contrast(t[fg], t[bg]).toFixed(2)}`);
    for (const [fg, bg] of [["accentInk", "accent"], ["onFill", "upFill"], ["onFill", "downFill"]] as const) {
      if (contrast(t[fg], t[bg]) < 4.5) low.push(`${fg}/${bg} ${contrast(t[fg], t[bg]).toFixed(2)}`);
    }
    expect(low).toEqual([]);
  });

  it("강조색·보조선·실시간·평단 색은 상승·하락색과 ΔE2000 20 이상", () => {
    const aux: Record<string, string> = {
      accent: t.accent,
      live: t.live,
      gold: t.gold,
      band: t.chart.band,
      rsi: t.chart.rsi,
      macd: t.chart.macd,
      signal: t.chart.signal,
      ...Object.fromEntries(Object.entries(t.chart.ma).map(([p, c]) => [`ma${p}`, c])),
    };
    const near: string[] = [];
    for (const [k, c] of Object.entries(aux)) {
      for (const ref of ["up", "down"] as const) {
        const d = deltaE2000(c, t[ref]);
        if (d < 20) near.push(`${k}~${ref} ${d.toFixed(1)}`);
      }
    }
    expect(near).toEqual([]);
  });

  it("차트 선은 패널 바탕에서 3:1 이상 (그래픽 대비)", () => {
    const lines = [...Object.values(t.chart.ma), t.chart.rsi, t.chart.macd, t.chart.signal];
    expect(lines.filter((c) => contrast(c, t.surface) < 3)).toEqual([]);
  });
});

describe("색 계산", () => {
  it("알려진 값과 맞다", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    // Sharma(2005) 표의 한 쌍 (Lab 이 아니라 sRGB 라 근사) — 같은 색은 0
    expect(deltaE2000("#3D8EFF", "#3D8EFF")).toBe(0);
    expect(deltaE2000("#FF0000", "#0000FF")).toBeGreaterThan(40);
  });
});
