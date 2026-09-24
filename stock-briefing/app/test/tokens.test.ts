import { describe, expect, it } from "vitest";
import { contrast, deltaE2000 } from "@/lib/color";
import { HEAT_MAX, heatColor } from "@/lib/heat";
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
      warn: t.warn,
      danger: t.danger,
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

  it("차트 선은 바탕 3종에서 3:1 이상 (그래픽 대비, 전체 화면 차트는 bg 위)", () => {
    const lines = [...Object.values(t.chart.ma), t.chart.rsi, t.chart.macd, t.chart.signal, t.chart.band];
    const low = lines.flatMap((c) => BACK.filter((b) => contrast(c, t[b]) < 3).map((b) => `${c}/${b}`));
    expect(low).toEqual([]);
  });

  it("가격 영역에 함께 그리는 선(이동평균·볼린저·평단)끼리 ΔE2000 15 이상", () => {
    const lines: [string, string][] = [...Object.entries(t.chart.ma).map(([p, c]) => [`ma${p}`, c] as [string, string]), ["band", t.chart.band], ["gold", t.gold]];
    const near: string[] = [];
    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length; j++) {
        const d = deltaE2000(lines[i]![1], lines[j]![1]);
        if (d < 15) near.push(`${lines[i]![0]}~${lines[j]![0]} ${d.toFixed(1)}`);
      }
    expect(near).toEqual([]);
  });

  it("히트맵 타일: 모든 등락률·기간에서 글자 대비 4.5 이상", () => {
    const low: string[] = [];
    for (const max of Object.values(HEAT_MAX))
      for (let r = -max * 1.2; r <= max * 1.2; r += max / 200) {
        const c = heatColor(t, r, max);
        if (contrast(c.fg, c.bg) < 4.5) low.push(`${r.toFixed(2)}/${max} ${c.bg} ${contrast(c.fg, c.bg).toFixed(2)}`);
      }
    expect(low.slice(0, 5)).toEqual([]);
  });
});

describe("색 계산", () => {
  it("알려진 값과 맞다", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    // 같은 색은 0, 순서를 바꿔도 같다, sRGB 빨강–파랑은 52.88 (Sharma 2005 공식, D65)
    expect(deltaE2000("#3D8EFF", "#3D8EFF")).toBe(0);
    expect(deltaE2000("#FF0000", "#0000FF")).toBeCloseTo(52.88, 1);
    expect(deltaE2000("#0000FF", "#FF0000")).toBeCloseTo(deltaE2000("#FF0000", "#0000FF"), 10);
  });
});
