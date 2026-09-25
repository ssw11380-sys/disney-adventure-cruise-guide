import { describe, expect, it } from "vitest";
import { WIDTH_EXPANDED, WIDTH_MEDIUM } from "@/lib/screenInfo";
import {
  classifyWindow,
  COMPACT,
  DETAIL_MIN,
  FOLD_OFF,
  foldLayoutOf,
  isWide,
  leftPaneWidth,
  listPaneWidth,
  railWidth,
  sameWindowClass,
  twoPaneWidths,
  type WindowClass,
} from "@/lib/windowClass";
import { layout, touch } from "@/tokens";

/**
 * 창 크기 등급 (3-42 접는 폰, 플래그 foldLayout 의 기반). 순수 함수만 본다 — 훅·화면은 test/foldLayout.test.tsx
 * 창 크기는 삼성 공식 해상도 ÷ 420dpi 추정값 (폰 실측 전)
 */
const FOLD8_FOLDED = { width: 475, height: 751 };
const FOLD8_LAND = { width: 933, height: 704 }; // 펼친 안쪽 화면의 기본 자세
const FOLD8_PORT = { width: 704, height: 933 };
const ULTRA_FOLDED = { width: 411, height: 960 };
const ULTRA_PORT = { width: 859, height: 954 }; // 울트라 안쪽 화면의 기본 자세
const ULTRA_LAND = { width: 954, height: 859 };

const at = (s: { width: number; height: number }, fontScale = 1, prev: WindowClass | null = null) => classifyWindow({ ...s, fontScale }, prev);

/** 크기를 차례로 바꿔 가며(창을 끌어 크기를 바꾸는 것처럼) 등급을 이어서 계산한다 */
function drag(widths: number[], height: number, fontScale = 1): WindowClass[] {
  const out: WindowClass[] = [];
  let prev: WindowClass | null = null;
  for (const width of widths) {
    prev = classifyWindow({ width, height, fontScale }, prev);
    out.push(prev);
  }
  return out;
}

describe("기준 토큰 (폰 실측 전 추정값, tokens.ts layout 한 곳)", () => {
  it("요청한 기준값 그대로이고, 2단을 끄는 폭은 켜는 폭보다 낮다", () => {
    expect(layout).toMatchObject({ twoPaneMin: 840, twoPaneExit: 816, listPaneW: 400, readableMax: 720, shortHeight: 760, mediumMin: 600, expandedMin: 840, railHysteresis: 24 });
    expect(layout.twoPaneExit).toBeLessThan(layout.twoPaneMin);
    // 탭 막대의 끄기 여유는 2단 켜기·끄기 폭 차이와 같다 (둘이 같은 폭에서 꺼진다)
    expect(layout.expandedMin - layout.railHysteresis).toBe(layout.twoPaneExit);
    // 2단일 때 오른쪽 상세 칸의 최소(끄기 직전 816 − 목록 400 − 구분선 1 = 415)가 가장 좁은 바깥 화면(울트라 접힘 411)보다 좁지 않다
    expect(DETAIL_MIN).toBe(415);
    expect(DETAIL_MIN).toBeGreaterThanOrEqual(ULTRA_FOLDED.width);
  });

  it("설정 '화면 정보'의 폭 등급과 같은 토큰을 쓴다", () => {
    expect(WIDTH_MEDIUM).toBe(layout.mediumMin);
    expect(WIDTH_EXPANDED).toBe(layout.expandedMin);
  });
});

describe("폴드8·울트라 추정 창 크기 (글자 100%)", () => {
  it.each([
    ["폴드8 접힘", FOLD8_FOLDED, { width: "compact", short: true, twoPane: false, rail: false }],
    ["울트라 접힘", ULTRA_FOLDED, { width: "compact", short: false, twoPane: false, rail: false }],
    ["폴드8 펼침 세로", FOLD8_PORT, { width: "medium", short: false, twoPane: false, rail: false }],
    ["폴드8 펼침 가로 (기본 자세)", FOLD8_LAND, { width: "expanded", short: true, twoPane: true, rail: true }],
    ["울트라 펼침 세로 (기본 자세)", ULTRA_PORT, { width: "expanded", short: false, twoPane: true, rail: false }],
    ["울트라 펼침 가로", ULTRA_LAND, { width: "expanded", short: false, twoPane: true, rail: false }],
  ] as const)("%s", (_name, size, want) => {
    expect(at(size)).toEqual(want);
  });

  it("접힌 화면(좁음)은 어떤 높이·글자 배율에서도 2단·탭 막대가 없다", () => {
    for (const s of [FOLD8_FOLDED, ULTRA_FOLDED, { width: 360, height: 640 }, { width: 599, height: 500 }])
      for (const f of [0.85, 1, 1.3, 2]) expect(at(s, f)).toMatchObject({ width: "compact", twoPane: false, rail: false });
  });

  it("높이 짧음은 760dp 미만 (경계 포함 여부)", () => {
    expect(at({ width: 933, height: 759 }).short).toBe(true);
    expect(at({ width: 933, height: 760 }).short).toBe(false);
    expect(at({ width: 933, height: 760 }).rail).toBe(false);
  });

  it("폭 등급 경계: 599 좁음 · 600 중간 · 839 중간 · 840 넓음", () => {
    expect(at({ width: 599, height: 900 }).width).toBe("compact");
    expect(at({ width: 600, height: 900 }).width).toBe("medium");
    expect(at({ width: 839, height: 900 }).width).toBe("medium");
    expect(at({ width: 840, height: 900 }).width).toBe("expanded");
  });

  it("크기를 모르면(0·NaN) 휴대폰 화면 그대로", () => {
    expect(at({ width: 0, height: 0 })).toEqual(COMPACT);
    expect(at({ width: Number.NaN, height: 700 })).toEqual(COMPACT);
    expect(at({ width: 933, height: 0 })).toEqual(COMPACT);
  });
});

describe("기준선 근처에서 깜빡이지 않기 (히스테리시스)", () => {
  it("2단: 840 에서 켜지고, 816 아래로 좁아져야 꺼지며, 다시 840 이 되어야 켜진다", () => {
    const widths = [800, 839, 840, 830, 817, 816, 815, 830, 839, 840];
    expect(drag(widths, 900).map((c) => c.twoPane)).toEqual([false, false, true, true, true, true, false, false, false, true]);
  });

  it("창을 끌며 기준선 양쪽을 오가도(835↔845) 한 번 켜진 뒤에는 바뀌지 않는다", () => {
    const widths = [845, 835, 845, 835, 845, 835];
    expect(drag(widths, 900).map((c) => c.twoPane)).toEqual([true, true, true, true, true, true]);
    expect(drag([835, 845, 835, 845], 900).map((c) => c.twoPane)).toEqual([false, true, true, true]);
  });

  it("왼쪽 탭 막대: 폭 '넓음'(840)에서 켜고, 켜진 뒤에는 816 아래로 좁아져야 끈다 (높이가 짧은 창에서만)", () => {
    expect(drag([800, 840, 820, 816, 815, 830, 840], 704).map((c) => c.rail)).toEqual([false, true, true, true, false, false, true]);
    // 높이가 넉넉해지면 꺼진다 (울트라 가로 859)
    expect(drag([933, 933], 704).map((c) => c.rail)).toEqual([true, true]);
    expect(classifyWindow({ width: 933, height: 859, fontScale: 1 }, at(FOLD8_LAND)).rail).toBe(false);
  });

  it("왼쪽 탭 막대는 폭 등급 '넓음'을 그대로 따른다: 처음 켤 때는 넓음 + 높이 짧음일 때만", () => {
    for (let w = 560; w <= 1000; w += 7)
      for (const hh of [500, 700, 759, 760, 783, 784, 900])
        for (const f of [1, 1.4, 2]) {
          const c = at({ width: w, height: hh }, f);
          expect(c.rail).toBe(c.width === "expanded" && c.short);
        }
    // 경계: 폭 등급 기준(expandedMin) 한 칸 아래는 켜지지 않는다
    expect(at({ width: layout.expandedMin - 1, height: 704 }).rail).toBe(false);
    expect(at({ width: layout.expandedMin, height: 704 }).rail).toBe(true);
  });

  it("왼쪽 탭 막대: 높이도 기준선 근처(760~783)에서 전 상태를 지킨다 — 팝업 창을 위아래로 끌어도 깜빡이지 않는다", () => {
    const heights = [700, 759, 770, 783, 770, 784, 770, 759, 770];
    let prev: WindowClass | null = null;
    const seen = heights.map((height) => (prev = classifyWindow({ width: 933, height, fontScale: 1 }, prev)));
    expect(seen.map((c) => c.rail)).toEqual([true, true, true, true, true, false, false, true, true]);
    // '높이 짧음' 값 자체는 창 그대로 (기준선 여유 없음)
    expect(seen.map((c) => c.short)).toEqual([true, true, false, false, false, false, false, true, false]);
    // 처음 계산이면 760 이상은 켜지지 않는다
    expect(at({ width: 933, height: 770 }).rail).toBe(false);
  });

  it("처음 계산(prev 없음)은 켜는 폭 기준이다 — 앱을 828dp 창에서 열면 한 단", () => {
    expect(at({ width: 828, height: 900 }).twoPane).toBe(false);
    expect(at({ width: 828, height: 900 }, 1, at({ width: 900, height: 900 })).twoPane).toBe(true);
  });

  it("등급이 같은지 비교", () => {
    expect(sameWindowClass(at(FOLD8_LAND), at({ width: 950, height: 700 }))).toBe(true);
    expect(sameWindowClass(at(FOLD8_LAND), at(FOLD8_PORT))).toBe(false);
    expect(sameWindowClass(null, at(FOLD8_LAND))).toBe(false);
    expect(sameWindowClass(null, null)).toBe(true);
  });
});

describe("큰 글씨 (글자 배율)", () => {
  it("2단 왼쪽 목록 폭: 100% 400 · 130% 460 · 140% 이상 480 (상한 fontCap.row), 작은 글씨는 100% 와 같다", () => {
    expect(listPaneWidth(1)).toBe(400);
    expect(listPaneWidth(0.85)).toBe(400);
    expect(listPaneWidth(1.3)).toBe(460);
    expect(listPaneWidth(1.4)).toBe(480);
    expect(listPaneWidth(2)).toBe(480);
    expect(listPaneWidth(Number.NaN)).toBe(400);
  });

  it("목록이 넓어진 만큼 2단 기준도 올라가 오른쪽 칸 폭이 지켜진다 (140%: 920 에서 켜고 896 아래에서 끔)", () => {
    expect(twoPaneWidths(1)).toEqual({ enter: 840, exit: 816 });
    expect(twoPaneWidths(1.4)).toEqual({ enter: 920, exit: 896 });
    // 울트라 펼침 세로(859)는 큰 글씨에서 한 단, 폴드8 펼침 가로(933)는 2단 그대로
    expect(at(ULTRA_PORT, 1.4).twoPane).toBe(false);
    expect(at(FOLD8_LAND, 1.4).twoPane).toBe(true);
    expect(at(ULTRA_LAND, 2).twoPane).toBe(true);
    // 폭 등급·높이·탭 막대는 글자 배율과 상관없다 (안드로이드 창 크기 등급)
    expect(at(ULTRA_PORT, 1.4)).toMatchObject({ width: "expanded", short: false, rail: false });
    expect(at(FOLD8_LAND, 2)).toMatchObject({ width: "expanded", short: true, rail: true });
  });

  it("실제 왼쪽 칸 폭: 오른쪽 칸(구분선 뺀 폭)이 415dp 보다 좁아지면 줄이되 400 아래로는 줄이지 않는다", () => {
    expect(leftPaneWidth(933, 1)).toBe(400);
    expect(leftPaneWidth(933, 1.4)).toBe(480);
    expect(leftPaneWidth(880, 1.4)).toBe(880 - layout.divider - DETAIL_MIN);
    expect(leftPaneWidth(700, 1.4)).toBe(400);
    expect(leftPaneWidth(0, 1.3)).toBe(460);
    // 2단을 끄기 직전 폭(816): 목록 400 + 구분선 1 + 상세 415
    expect(leftPaneWidth(816, 1)).toBe(400);
    expect(816 - leftPaneWidth(816, 1) - layout.divider).toBe(DETAIL_MIN);
  });

  it("틀 폭이 816 이상이면 어떤 글자 크기에서도 오른쪽 칸 ≥ 415 · 목록 400~480", () => {
    for (let box = layout.twoPaneExit; box <= 1400; box++)
      for (const f of [0.85, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 2]) {
        const left = leftPaneWidth(box, f);
        expect(left).toBeGreaterThanOrEqual(layout.listPaneW);
        expect(left).toBeLessThanOrEqual(listPaneWidth(f));
        expect(box - left - layout.divider).toBeGreaterThanOrEqual(DETAIL_MIN);
      }
  });

  it("펼친 폴드8 가로(933)에서 왼쪽 탭 막대를 뺀 틀로 나누면 모든 글자 크기에서 오른쪽 칸 ≥ 415", () => {
    const got = [1, 1.1, 1.3, 1.4, 1.5, 2].map((f) => {
      const box = FOLD8_LAND.width - railWidth(f);
      const left = leftPaneWidth(box, f);
      return { box, left, right: box - left - layout.divider };
    });
    // 100%: 막대 80 → 틀 853 · 목록 400 · 상세 452 / 130%: 막대 92 → 841 · 425 · 415 / 140%: 막대 96 → 837 · 421 · 415
    expect(got[0]).toEqual({ box: 853, left: 400, right: 452 });
    expect(got[2]).toEqual({ box: 841, left: 425, right: 415 });
    expect(got[3]).toEqual({ box: 837, left: 421, right: 415 });
    for (const g of got) {
      expect(g.box).toBeGreaterThanOrEqual(layout.twoPaneExit);
      expect(g.right).toBeGreaterThanOrEqual(DETAIL_MIN);
    }
    // 창 폭(933)으로 나누던 때는 130% 에서 상세가 933 − 92 − 460 − 1 = 380 으로 좁아졌다
    expect(FOLD8_LAND.width - railWidth(1.3) - listPaneWidth(1.3) - layout.divider).toBe(380);
  });

  it("왼쪽 탭 막대 폭: 100% 80 · 150% 이상 100 (탭 이름 상한 fontCap.chrome)", () => {
    expect(railWidth(1)).toBe(80);
    expect(railWidth(1.5)).toBe(100);
    expect(railWidth(2)).toBe(100);
    expect(railWidth(0.85)).toBe(80);
    // 누르는 칸 폭 = 막대 폭 − 라이브러리 좌우 여백(material 12 × 2) ≥ 44 (3-22)
    const MATERIAL_SPACING = 12;
    expect(railWidth(1) - MATERIAL_SPACING * 2).toBeGreaterThanOrEqual(touch.min);
  });
});

describe("플래그를 거친 값 (foldLayoutOf)", () => {
  it("꺼져 있으면 창 크기와 상관없이 휴대폰 화면 그대로", () => {
    for (const s of [FOLD8_FOLDED, FOLD8_LAND, FOLD8_PORT, ULTRA_FOLDED, ULTRA_PORT, ULTRA_LAND]) {
      const l = foldLayoutOf(false, at(s));
      expect(l).toEqual({ width: "compact", short: false, twoPane: false, rail: false, on: false });
      expect(l).toBe(FOLD_OFF);
      expect(isWide(l)).toBe(false);
    }
  });

  it("켜져 있으면 창 등급 그대로", () => {
    expect(foldLayoutOf(true, at(FOLD8_LAND))).toEqual({ width: "expanded", short: true, twoPane: true, rail: true, on: true });
    expect(isWide(foldLayoutOf(true, at(FOLD8_PORT)))).toBe(true);
    expect(isWide(foldLayoutOf(true, at(FOLD8_FOLDED)))).toBe(false);
  });
});
