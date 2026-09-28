import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountData } from "@/components/AccountBand";
import { render, type HostNode } from "./miniRender";

/**
 * 3-35 리뷰 반영 — 넓은 창 계좌 띠(AccountBand)의 '비중'·'테마' 두 버튼.
 *  - 큰 글씨(130% 이상)의 줄바꿈 띠(두 줄 띠 둘째 줄·촘촘 띠)는 두 버튼을 위아래로 쌓는다 → 칸 자리가 버튼 하나만큼 그대로 (704×933·200% '매입금액'이 셋째 줄로 밀리지 않게)
 *  - 100%·한 줄 띠는 옆으로 (사이 12)
 *  - 테마 버튼이 없으면(플래그 끔) 지금 나무 그대로
 */
const h = vi.hoisted(() => ({ fontScale: 1 }));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 0.5, absoluteFill: {} },
  Platform: { OS: "android" },
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => h.fontScale };
});
vi.mock("@/components/ui", () => ({ Button: "Button" }));

const { AccountBand, STACK_ACTIONS_SCALE } = await import("@/components/AccountBand");

const flat = (v: unknown): Record<string, unknown> => Object.assign({}, ...[v].flat(Infinity).filter(Boolean));
const treeText = (tree: unknown) => JSON.stringify(tree, (_k, v) => (typeof v === "function" ? undefined : v));
const bucket = (value: number, cost: number, day: number, count: number) => ({ value, cost, day, count });
const DATA: AccountData = {
  total: bucket(71_445_876, 54_699_110, 423_789, 17),
  byCur: { KRW: bucket(31_451_551, 26_060_000, 300_000, 9), USD: bucket(28_741.88, 21_040, 90, 8) },
  usdInKrw: bucket(39_994_325, 28_639_110, 123_789, 8),
  estimated: false,
  currentBasis: 0,
  afterCost: true,
  showKrw: false,
  fx: 1391.5,
  excluded: null,
};
const noop = () => undefined;
const actionsBox = (r: ReturnType<typeof render>): HostNode => {
  const btn = r.all().find((n) => n.type === "Button" && n.props.accessibilityLabel === "내 종목 테마 보기")!;
  return r.all().find((n) => n.children.includes(btn))!;
};

beforeEach(() => {
  h.fontScale = 1;
});

describe("넓은 창 계좌 띠 '비중'·'테마' 두 버튼 (3-35)", () => {
  it("글자 100%: 옆으로 (사이 12)", () => {
    const r = render(<AccountBand data={DATA} oneLine={false} pad={12} onAllocation={noop} onThemes={noop} />);
    const box = actionsBox(r);
    expect(box.children.map((c) => (c as HostNode).props.accessibilityLabel)).toEqual(["비중 보기", "내 종목 테마 보기"]);
    expect(flat(box.props.style)).toMatchObject({ flexDirection: "row", columnGap: 12 });
  });

  it("글자 130%·200% 줄바꿈 띠(두 줄 띠·촘촘 띠): 위아래로 쌓는다 (칸 자리가 버튼 하나만큼 그대로)", () => {
    expect(STACK_ACTIONS_SCALE).toBe(1.3);
    for (const fs of [1.3, 2]) {
      h.fontScale = fs;
      for (const dense of [false, true]) {
        const box = actionsBox(render(<AccountBand data={DATA} oneLine={false} dense={dense} pad={12} onAllocation={noop} onThemes={noop} />));
        expect(flat(box.props.style), `${fs} ${dense}`).toMatchObject({ flexDirection: "column", rowGap: 12 });
      }
      // 한 줄 띠(줄바꿈 없음)는 옆으로 그대로
      expect(flat(actionsBox(render(<AccountBand data={DATA} oneLine rates pad={12} onAllocation={noop} onThemes={noop} />)).props.style)).toMatchObject({ flexDirection: "row" });
    }
  });

  it("테마 버튼만(비중 보기 꺼짐)이면 쌓을 것이 없다 · 테마 버튼이 없으면 지금 나무 그대로", () => {
    h.fontScale = 2;
    expect(flat(actionsBox(render(<AccountBand data={DATA} oneLine={false} pad={12} onThemes={noop} />)).props.style)).toMatchObject({ flexDirection: "row" });
    // 테마 버튼이 없으면 '비중' 하나짜리 칸 그대로 (쌓기·사이 없음)
    const a = render(<AccountBand data={DATA} oneLine={false} pad={12} onAllocation={noop} />);
    expect(a.all().some((n) => n.props.accessibilityLabel === "내 종목 테마 보기")).toBe(false);
    const alloc = a.all().find((n) => n.type === "Button" && n.props.accessibilityLabel === "비중 보기")!;
    const box = a.all().find((n) => n.children.includes(alloc))!;
    expect(box.children).toHaveLength(1);
    expect(flat(box.props.style)).toEqual({ paddingLeft: 8 });
    expect(treeText(a.tree)).not.toContain("columnGap");
  });
});
