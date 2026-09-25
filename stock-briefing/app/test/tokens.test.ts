import { describe, expect, it } from "vitest";
import { PIE_SLOTS } from "@/lib/allocation";
import { contrast, deltaE2000, hexRgb } from "@/lib/color";
import { HEAT_MAX, heatColor } from "@/lib/heat";
import { dark, light, type Theme } from "@/tokens";

/**
 * 색약 시뮬레이션 (Machado·Oliveira·Fernandes 2009, 강도 1.0, 선형 RGB) + OKLab 거리 ×100.
 * 원 차트 조각처럼 서로 닿는 색이 적색맹·녹색맹에게도 구분되는지 본다 (목표 8 이상). 테스트에서만 쓴다
 */
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;
const toLinear = (hex: string) => hexRgb(hex).map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
function oklab([r, g, b]: number[]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabDelta(a: string, b: string, cvd?: keyof typeof MACHADO): number {
  const sim = (hex: string) => {
    const c = toLinear(hex);
    if (!cvd) return c;
    return MACHADO[cvd].map((row) => Math.min(1, Math.max(0, row[0] * c[0]! + row[1] * c[1]! + row[2] * c[2]!)));
  };
  const [x, y] = [oklab(sim(a)), oklab(sim(b))];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

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
      ...Object.fromEntries(t.chart.pie.map((c, i) => [`pie${i}`, c])),
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

  describe("비중 원 차트 조각 색 (비중 보기)", () => {
    const pie = t.chart.pie;
    /** 원에서 서로 닿는 조각: 차례대로 이웃, 첫 조각과 마지막 조각(조각 수는 2~7개라 첫 색은 모든 색과 닿을 수 있다), 회색은 7번째·첫 조각과 */
    const touching = (): [string, string, string, string][] => {
      const out: [string, string, string, string][] = [];
      for (let i = 0; i + 1 < pie.length; i++) out.push([`pie${i}`, pie[i]!, `pie${i + 1}`, pie[i + 1]!]);
      for (let k = 2; k < pie.length; k++) out.push(["pie0", pie[0]!, `pie${k}`, pie[k]!]);
      out.push(["pieOther", t.chart.pieOther, "pie0", pie[0]!], ["pieOther", t.chart.pieOther, `pie${pie.length - 1}`, pie.at(-1)!]);
      return out;
    };

    it("색 칸 수가 비중 계산의 칸 수와 같다 (8번째부터는 회색)", () => expect(pie).toHaveLength(PIE_SLOTS));

    it("조각 색·회색은 바탕 3종에서 3:1 이상 (그래픽 대비)", () => {
      const low = [...pie, t.chart.pieOther].flatMap((c) => BACK.filter((b) => contrast(c, t[b]) < 3).map((b) => `${c}/${b} ${contrast(c, t[b]).toFixed(2)}`));
      expect(low).toEqual([]);
    });

    it("모든 조각 색끼리 ΔE2000 15 이상 (범례 네모만 보고도 다른 색)", () => {
      const near: string[] = [];
      for (let i = 0; i < pie.length; i++)
        for (let j = i + 1; j < pie.length; j++) if (deltaE2000(pie[i]!, pie[j]!) < 15) near.push(`pie${i}~pie${j} ${deltaE2000(pie[i]!, pie[j]!).toFixed(1)}`);
      expect(near).toEqual([]);
    });

    it("닿는 조각끼리: 보통 시각 OKLab ΔE 15 이상, 적색맹·녹색맹 시뮬레이션에서도 8 이상", () => {
      const near: string[] = [];
      for (const [an, a, bn, b] of touching()) {
        const n = oklabDelta(a, b);
        const c = Math.min(oklabDelta(a, b, "protan"), oklabDelta(a, b, "deutan"));
        if (n < 15 || c < 8) near.push(`${an}~${bn} 보통 ${n.toFixed(1)} 색약 ${c.toFixed(1)}`);
      }
      expect(near).toEqual([]);
    });
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

  it("색약 시뮬레이션 거리: 검정–흰색 100, 빨강–초록은 녹색맹에게 가깝다 (시뮬레이션이 실제로 도는지)", () => {
    expect(oklabDelta("#000000", "#FFFFFF")).toBeCloseTo(100, 0);
    expect(oklabDelta("#D11A22", "#16762F")).toBeGreaterThan(30);
    expect(oklabDelta("#D11A22", "#16762F", "deutan")).toBeLessThan(10);
    // 데이터 시각화 검사 도구(validate_palette.js)가 같은 쌍에 낸 값
    expect(oklabDelta("#C27405", "#007E68", "protan")).toBeCloseTo(10.2, 1);
  });
});
