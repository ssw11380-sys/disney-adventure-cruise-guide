import { describe, expect, it } from "vitest";
import { foldGuess, isLandscape, isWindowed, modelLabel, screenInfoRows, screenInfoText, widthClass, type ScreenInfoInput } from "@/lib/screenInfo";

/**
 * 설정 > 화면 정보 (접는 폰 측정). 폴드 바깥·안쪽 화면과 비슷한 크기로 줄 글자를 확인한다.
 * 크기는 삼성 사양 값이 아니라 계산을 확인하려고 고른 예시다 (1080×2400 픽셀 @2.625 = 411×914dp 등)
 */
const D = 2.625; // 420dpi
const base: ScreenInfoInput = {
  window: { width: 1080 / D, height: 2400 / D },
  screen: { width: 1080 / D, height: 2400 / D },
  density: D,
  fontScale: 1,
  insets: { top: 32, bottom: 48, left: 0, right: 0 },
  manufacturer: "samsung",
  modelName: "SM-F966N",
  osVersion: "16",
  apiLevel: 36,
  appVersion: "1.4.0",
  build: "내장 번들",
};
const rows = (i: Partial<ScreenInfoInput>) => Object.fromEntries(screenInfoRows({ ...base, ...i }).map((r) => [r.label, r.value]));
// 안쪽 화면 예시: 1968×2184 픽셀 @2.625 ≈ 750×832dp
const inner = { width: 1968 / D, height: 2184 / D };
const innerLand = { width: inner.height, height: inner.width };

describe("화면 정보 줄", () => {
  it("접었을 때(바깥 화면과 비슷한 크기)", () => {
    expect(rows({})).toEqual({
      모델명: "samsung SM-F966N",
      "안드로이드 버전": "16 (API 36)",
      "앱 창 크기": "411×914 dp",
      "화면 전체 크기": "411×914 dp · 1080×2400 픽셀",
      "화면 밀도": "2.625 (약 420dpi)",
      "글자 배율": "100%",
      "가로/세로": "세로",
      "접힘/펼침": "접힘(바깥 화면)으로 추정 · 짧은 변 411dp",
      "창 상태": "전체 화면",
      "폭 등급": "좁음 (600dp 미만)",
      "화면 여백": "위 32 · 아래 48 · 왼쪽 0 · 오른쪽 0 dp",
    });
  });

  it("폈을 때 세로 (안쪽 화면)", () => {
    const r = rows({ window: inner, screen: inner });
    expect(r["앱 창 크기"]).toBe("750×832 dp");
    expect(r["화면 전체 크기"]).toBe("750×832 dp · 1968×2184 픽셀");
    expect(r["가로/세로"]).toBe("세로");
    expect(r["접힘/펼침"]).toBe("펼침(안쪽 화면)으로 추정 · 짧은 변 750dp");
    expect(r["창 상태"]).toBe("전체 화면");
    expect(r["폭 등급"]).toBe("중간 (600~839dp)");
  });

  it("폈을 때 가로 (안쪽 화면을 돌림) — 짧은 변으로 보므로 여전히 펼침", () => {
    const r = rows({ window: innerLand, screen: innerLand, insets: { top: 24, bottom: 0, left: 0, right: 48 } });
    expect(r["앱 창 크기"]).toBe("832×750 dp");
    expect(r["가로/세로"]).toBe("가로");
    expect(r["접힘/펼침"]).toBe("펼침(안쪽 화면)으로 추정 · 짧은 변 750dp");
    expect(r["폭 등급"]).toBe("중간 (600~839dp)");
    expect(r["화면 여백"]).toBe("위 24 · 아래 0 · 왼쪽 0 · 오른쪽 48 dp");
  });

  it("화면 분할: 창이 화면보다 작다 — 펼침이지만 폭 등급은 창 기준 좁음", () => {
    const r = rows({ window: { width: 412, height: 750 }, screen: innerLand });
    expect(r["창 상태"]).toBe("화면 분할·팝업 창 또는 화면 비율 제한으로 추정");
    expect(r["접힘/펼침"]).toMatch(/^펼침\(안쪽 화면\)/);
    expect(r["폭 등급"]).toBe("좁음 (600dp 미만)");
    expect(r["앱 창 크기"]).toBe("412×750 dp");
    // 위아래로 나눈 화면 분할도
    expect(rows({ window: { width: 750, height: 400 }, screen: inner })["창 상태"]).toBe("화면 분할·팝업 창 또는 화면 비율 제한으로 추정");
  });

  it("글자 배율 130% (소수점 오차도 반올림)", () => {
    expect(rows({ fontScale: 1.3 })["글자 배율"]).toBe("130%");
    expect(rows({ fontScale: 1.1500000953674316 })["글자 배율"]).toBe("115%");
  });

  it("모델·버전을 모르면 '알 수 없음'", () => {
    const r = rows({ manufacturer: null, modelName: null, osVersion: null, apiLevel: null });
    expect(r["모델명"]).toBe("알 수 없음");
    expect(r["안드로이드 버전"]).toBe("알 수 없음");
    expect(rows({ manufacturer: undefined, modelName: "  " })["모델명"]).toBe("알 수 없음");
    expect(rows({ density: 0 })["화면 밀도"]).toBe("알 수 없음");
    expect(rows({ density: 0 })["화면 전체 크기"]).toBe("411×914 dp · ?×? 픽셀");
  });
});

describe("판단 기준", () => {
  it("폭 등급 경계: 600 · 840", () => {
    expect(widthClass(599.9)).toBe("compact");
    expect(widthClass(600)).toBe("medium");
    expect(widthClass(839.9)).toBe("medium");
    expect(widthClass(840)).toBe("expanded");
  });

  it("접힘/펼침은 화면 짧은 변 600dp 기준 (방향과 상관없이)", () => {
    expect(foldGuess({ width: 411, height: 914 })).toBe("folded");
    expect(foldGuess({ width: 914, height: 411 })).toBe("folded");
    expect(foldGuess({ width: 600, height: 700 })).toBe("unfolded");
    expect(foldGuess(innerLand)).toBe("unfolded");
  });

  it("상태 표시줄·내비게이션 바만큼 작은 창은 전체 화면으로 본다", () => {
    expect(isWindowed({ width: 411, height: 914 - 80 }, { width: 411, height: 914 })).toBe(false);
    expect(isWindowed({ width: 832 - 48, height: 750 }, innerLand)).toBe(false);
    expect(isWindowed({ width: 300, height: 500 }, inner)).toBe(true); // 팝업 창
    // 값이 아직 없으면(0) 판단하지 않는다
    expect(isWindowed({ width: 0, height: 0 }, inner)).toBe(false);
  });

  it("가로/세로는 창 기준, 정사각은 세로", () => {
    expect(isLandscape({ width: 832, height: 750 })).toBe(true);
    expect(isLandscape({ width: 750, height: 750 })).toBe(false);
  });

  it("모델명에 제조사가 이미 있으면 한 번만", () => {
    expect(modelLabel("Google", "Google Pixel 9 Pro Fold")).toBe("Google Pixel 9 Pro Fold");
    expect(modelLabel("samsung", null)).toBe("samsung");
    expect(modelLabel(null, "SM-F966N")).toBe("SM-F966N");
  });
});

describe("공유 글", () => {
  it("머리 줄(한국 시각·앱 버전) + 항목마다 한 줄 + 짐작 안내", () => {
    const text = screenInfoText({ ...base, fontScale: 1.3 }, new Date("2026-09-25T05:03:40Z"));
    const lines = text.split("\n");
    expect(lines[0]).toBe("[화면 정보] 2026-09-25 14:03 한국 시각 · 앱 1.4.0 (내장 번들)");
    expect(lines).toContain("앱 창 크기: 411×914 dp");
    expect(lines).toContain("글자 배율: 130%");
    expect(lines).toContain("접힘/펼침: 접힘(바깥 화면)으로 추정 · 짧은 변 411dp");
    expect(lines).toHaveLength(1 + 11 + 1);
    expect(lines.at(-1)).toMatch(/짐작한 값입니다/);
  });

  it("한국 시각은 날짜가 넘어가도 맞다 (UTC 15시 = 다음 날 0시)", () => {
    expect(screenInfoText(base, new Date("2026-09-25T15:00:00Z")).split("\n")[0]).toMatch(/^\[화면 정보\] 2026-09-26 00:00 한국 시각/);
  });

  it("앱 버전을 모르면 머리 줄에서 뺀다", () => {
    expect(screenInfoText({ ...base, appVersion: null }, new Date("2026-09-25T05:03:00Z")).split("\n")[0]).toBe("[화면 정보] 2026-09-25 14:03 한국 시각");
  });
});

describe("폴드8 삼성 사양으로 계산한 크기 (420dpi 기준, 최대 확대 포함)", () => {
  it("일반(SM-F971N) 바깥 475×751 접힘·좁음, 안쪽 가로 933×704 펼침·넓음, 안쪽 세로 704×933 펼침·중간", () => {
    expect(foldGuess({ width: 475, height: 751 })).toBe("folded");
    expect(widthClass(475)).toBe("compact");
    expect(foldGuess({ width: 933, height: 704 })).toBe("unfolded");
    expect(widthClass(933)).toBe("expanded");
    expect(foldGuess({ width: 704, height: 933 })).toBe("unfolded");
    expect(widthClass(704)).toBe("medium");
  });
  it("울트라(SM-F976N) 바깥 411×960 접힘, 안쪽 859×954 펼침·넓음", () => {
    expect(foldGuess({ width: 411, height: 960 })).toBe("folded");
    expect(foldGuess({ width: 859, height: 954 })).toBe("unfolded");
    expect(widthClass(859)).toBe("expanded");
  });
  it("화면 확대 최대(약 520dpi): 일반 안쪽 753×569 는 짧은 변이 600 아래여도 정사각형에 가까워 펼침, 바깥 384×607 은 접힘", () => {
    expect(foldGuess({ width: 753, height: 569 })).toBe("unfolded");
    expect(foldGuess({ width: 569, height: 753 })).toBe("unfolded");
    expect(foldGuess({ width: 384, height: 607 })).toBe("folded");
    expect(foldGuess({ width: 332, height: 775 })).toBe("folded");
  });
});
