import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 이름·값 줄(Row)의 줄바꿈 (3-42 통합 · 웨이브 E 검증 must): 넓은 창 설정 두 칸에서는 칸이 좁아도(글자 130% 등) 두 칸을 지키고,
 * 이름과 값이 한 줄에 안 들어가면 값이 이름 아래 줄 오른쪽으로 내려간다 (토스 카드 '자동 동기화 · 5분마다 · 마지막 …').
 * 기본(휴대폰·접은 화면·플래그 꺼짐)은 지금과 똑같은 트리
 */
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Switch: "Switch",
  ActivityIndicator: "ActivityIndicator",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});

const { Row, RowWrapContext } = await import("@/components/ui");
const { font, light, space } = await import("@/tokens");

const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
const LONG = "5분마다 · 마지막 9월 26일 오전 2:30 · 변경 3";

describe("Row 줄바꿈 (RowWrapContext)", () => {
  it("기본: 지금과 같은 한 줄 (이름 | 값, 줄바꿈 없음)", () => {
    const r = render(<Row label="자동 동기화" value={LONG} />);
    const box = r.all()[0]!;
    expect(box.type).toBe("View");
    expect(flat(box)).toMatchObject({ flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomColor: light.line });
    expect(flat(box)).not.toHaveProperty("flexWrap");
    expect(box.children.map((c) => (typeof c === "string" ? c : c.type))).toEqual(["Text", "Text"]);
    const [label, value] = box.children as HostNode[];
    expect(flat(label!)).toEqual({ color: light.muted, fontSize: font.small });
    expect(flat(value!)).not.toHaveProperty("textAlign");
  });

  it("넓은 창 설정: 한 줄에 안 들어가면 값이 이름 아래 줄 오른쪽으로 — 이름은 줄이지 않는다", () => {
    const r = render(
      <RowWrapContext.Provider value={true}>
        <Row label="자동 동기화" value={LONG} />
      </RowWrapContext.Provider>,
    );
    const box = r.all()[0]!;
    expect(flat(box)).toMatchObject({ flexDirection: "row", flexWrap: "wrap", columnGap: space.md });
    const [label, valueBox] = box.children as HostNode[];
    expect(label!.type).toBe("Text");
    expect(flat(label!)).toMatchObject({ flexShrink: 0 });
    // 값 칸: 줄 끝(오른쪽)에 붙고, 이름 아래로 내려가도 오른쪽, 칸보다 길면 그 안에서 줄바꿈
    expect(valueBox!.type).toBe("View");
    expect(flat(valueBox!)).toMatchObject({ flexShrink: 1, marginLeft: "auto", alignItems: "flex-end", maxWidth: "100%" });
    const value = valueBox!.children[0] as HostNode;
    expect(value.children).toEqual([LONG]);
    expect(flat(value)).toMatchObject({ textAlign: "right", fontWeight: "600" });
  });

  it("값이 글자가 아닌 요소여도 같은 값 칸에 넣는다 (토스 카드 '서버 공인 IP' 등)", () => {
    const r = render(
      <RowWrapContext.Provider value={true}>
        <Row label="서버 공인 IP" value={<Text>1.2.3.4</Text>} />
      </RowWrapContext.Provider>,
    );
    const valueBox = (r.all()[0]!.children as HostNode[])[1]!;
    expect(flat(valueBox)).toMatchObject({ marginLeft: "auto" });
    expect((valueBox.children[0] as HostNode).children).toEqual(["1.2.3.4"]);
  });
});

const Text = "Text" as unknown as React.FC<{ children: React.ReactNode }>;
