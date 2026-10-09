import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", BackHandler: { addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-router", () => ({ useFocusEffect: () => undefined }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Muted: "Muted", SectionTitle: "SectionTitle" }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.dark }; });
const { SettingsSections } = await import("@/components/SettingsSections");
afterEach(cleanupRenders);
const sections = [ { id: "update", title: "앱 업데이트", detail: "최신 버전", content: <React.Fragment>업데이트 내용</React.Fragment> }, { id: "server", title: "연결·진단", detail: "주소와 상태", content: <React.Fragment>서버 내용</React.Fragment> } ];
describe("설정 분류 목록", () => {
  it("첫 화면에는 분류만 보이고 선택한 본문만 열며 목록으로 복귀한다", () => {
    const r = render(<SettingsSections sections={sections} openServerRequest={null} refreshing={false} onRefresh={() => undefined} />);
    expect(r.text().includes("업데이트 내용")).toBe(false); expect(r.text().includes("서버 내용")).toBe(false);
    r.act(() => (r.all().find(n => n.props.accessibilityLabel === "앱 업데이트, 최신 버전")!.props.onPress as () => void)());
    expect(r.text().includes("업데이트 내용")).toBe(true); expect(r.text().includes("서버 내용")).toBe(false);
    r.act(() => (r.all().find(n => n.props.title === "설정 목록으로")!.props.onPress as () => void)());
    expect(r.text().includes("업데이트 내용")).toBe(false);
  });
  it("연결 오류의 바로가기는 서버 분류를 즉시 연다", () => {
    const r = render(<SettingsSections sections={sections} openServerRequest="request-1" refreshing={false} onRefresh={() => undefined} />);
    expect(r.text().includes("서버 내용")).toBe(true); expect(r.text().includes("업데이트 내용")).toBe(false);
  });
});
