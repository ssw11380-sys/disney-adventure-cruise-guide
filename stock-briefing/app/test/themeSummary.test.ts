import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ThemeSummary } from "@/api/types";
import { formatPct } from "@/lib/format";
import { headlineRate } from "@/lib/themeSummary";
import { changeColor, dark, light } from "@/tokens";

/**
 * 테마·업종 상세 머리의 대표 등락률 (DISC-03). 미국 업종 출처 초기화 때 종목만 저장본으로 덮고 같은 때 요약을 확인하지 못하면
 * 서버는 unverified 를 준다 — 그때 요약 등락률은 출처가 비운 때 값(0%·+0.40% 등)이라 화면의 종목(모두 상승 등)과 맞지 않는다.
 */
const summary = (s: Partial<ThemeSummary>): ThemeSummary => ({ id: "57", name: "IT", changeRate: 0, up: 0, flat: 0, down: 0, leaders: [], ...s });

describe("headlineRate", () => {
  it("확인하지 못한 요약은 등락률을 대표 값으로 쓰지 않는다 — '-' 에 중립 색 (0.00%·상승 색이 아니게)", () => {
    for (const changeRate of [0, 0.4, -1.2]) {
      const rate = headlineRate(summary({ changeRate, unverified: true }));
      expect(rate).toBeNull();
      expect(formatPct(rate)).toBe("-");
      for (const t of [light, dark]) expect(changeColor(t, rate)).toBe(t.ink);
    }
  });

  it("확인한 요약·옛 서버(필드 없음)는 등락률 그대로", () => {
    expect(headlineRate(summary({ changeRate: 2.8, up: 10 }))).toBe(2.8);
    expect(headlineRate(summary({ changeRate: -0.9, unverified: false }))).toBe(-0.9);
    expect(formatPct(headlineRate(summary({ changeRate: 0.4 })))).toBe("+0.40%");
    expect(headlineRate(undefined)).toBeNull();
  });

  it("상세 화면은 머리 등락률·색을 headlineRate 로 보여 주고, 확인 못 한 요약에는 단순 평균도 붙이지 않는다", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/app/discover/theme/[id].tsx", import.meta.url)), "utf8");
    expect(src).toContain("headlineRate(theme)");
    expect(src).toMatch(/changeColor\(t, headRate\)/);
    expect(src).toMatch(/styles\.big[^>]*>\{formatPct\(headRate\)\}/);
    expect(src).not.toMatch(/formatPct\(theme\.changeRate\)/);
    expect(src).toMatch(/headRate !== null && theme\?\.simpleAvg !== undefined/);
    // 곧 채워진다는 뜻으로 읽히지 않게 (서버 note: "…같은 때 값을 확인하지 못했습니다" — 새로고침해도 그대로일 수 있다)
    expect(src).toMatch(/theme\?\.unverified \?[^\n]*>등락률 확인 못 함</);
    expect(src).not.toContain("등락률 확인 중");
  });
});
