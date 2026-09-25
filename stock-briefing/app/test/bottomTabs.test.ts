import { describe, expect, it } from "vitest";
import { classifyWindow } from "@/lib/windowClass";
import { layout } from "@/tokens";

/**
 * 펼친 폴드에서도 탭은 아래 탭 바 (2026-09-26 사용자 선택: "펼쳤을 때 메뉴가 하단에 나오는 게 더 좋다").
 * 왼쪽 세로 막대 규칙은 layout.railOn 을 켜면 다시 쓰인다 (막대 배치 시험은 fold*.test·windowClass.test 가 막대를 켠 채로 한다)
 */
describe("펼친 화면 탭 위치: 기본은 아래 탭 바", () => {
  it("기본값은 막대 꺼짐", () => {
    expect(layout.railOn).toBe(false);
  });

  it.each([
    ["폴드8 펼침 가로", 933, 704],
    ["폴드8 펼침 가로(실제 창)", 933, 632],
    ["울트라 펼침 가로", 954, 859],
    ["울트라 펼침 세로", 859, 954],
    ["폴드8 펼침 세로", 704, 933],
    ["넓고 짧은 창", 1200, 600],
  ])("%s %i×%i: 막대 없음(아래 탭 바), 넓은 창 배치·2단 판단은 그대로", (_n, width, height) => {
    const c = classifyWindow({ width, height, fontScale: 1 });
    expect(c.rail).toBe(false);
    expect(classifyWindow({ width, height, fontScale: 1 }, c).rail).toBe(false);
    expect(c.width).not.toBe("compact");
  });

  it("막대를 켜면(railOn) 예전처럼 넓고 짧은 창에서만 막대", () => {
    expect(classifyWindow({ width: 933, height: 704, fontScale: 1 }, null, { rail: true }).rail).toBe(true);
    expect(classifyWindow({ width: 859, height: 954, fontScale: 1 }, null, { rail: true }).rail).toBe(false);
  });
});
