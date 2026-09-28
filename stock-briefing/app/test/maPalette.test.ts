import { describe, expect, it } from "vitest";
import { contrast, deltaE2000 } from "@/lib/color";
import { dark, light, type Theme } from "@/tokens";

/**
 * 이동평균선 색 8가지 (3-39 PR 2, 기능 플래그 maCustom — tokens chart.maPalette).
 *  - 앞 6개 = 지금 chart.ma 의 5·10·20·60·120·200 색 (처음 선이 지금과 같게)
 *  - 8개 모두 바탕 4종(bg·surface·surfaceAlt·zebra)에서 3:1 이상, 상승·하락색과 ΔE2000 20 이상
 *  - 8개 + 볼린저(band) + 평단(gold) 모든 쌍 ΔE2000 15 이상 (가격 영역에 함께 그리는 선)
 */
const BACK = ["bg", "surface", "surfaceAlt", "zebra"] as const;

describe.each([
  ["다크", dark],
  ["라이트", light],
] as [string, Theme][])("이동평균선 색 %s", (_name, t) => {
  const pal = t.chart.maPalette;

  it("8개이고 앞 6개는 chart.ma 의 5·10·20·60·120·200 색", () => {
    expect(pal).toHaveLength(8);
    expect(pal.slice(0, 6)).toEqual([5, 10, 20, 60, 120, 200].map((p) => t.chart.ma[p]));
    for (const c of pal) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("8개 모두 바탕 4종에서 3:1 이상", () => {
    const low: string[] = [];
    for (const [i, c] of pal.entries()) for (const b of BACK) if (contrast(c, t[b]) < 3) low.push(`${i} ${c}/${b} ${contrast(c, t[b]).toFixed(2)}`);
    expect(low).toEqual([]);
  });

  it("8개 모두 상승·하락색과 ΔE2000 20 이상 (등락으로 읽히지 않게)", () => {
    const near: string[] = [];
    for (const [i, c] of pal.entries()) for (const k of ["up", "down"] as const) if (deltaE2000(c, t[k]) < 20) near.push(`${i} ${c}~${k} ${deltaE2000(c, t[k]).toFixed(1)}`);
    expect(near).toEqual([]);
  });

  it("8개 + 볼린저 + 평단의 모든 쌍 ΔE2000 15 이상", () => {
    const all: [string, string][] = [...pal.map((c, i) => [`ma${i}`, c] as [string, string]), ["band", t.chart.band], ["gold", t.gold]];
    const near: string[] = [];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const d = deltaE2000(all[i]![1], all[j]![1]);
        if (d < 15) near.push(`${all[i]![0]}~${all[j]![0]} ${d.toFixed(1)}`);
      }
    expect(near).toEqual([]);
  });
});
