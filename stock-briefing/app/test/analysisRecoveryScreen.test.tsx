import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Analysis } from "@/api/types";
import type { AnalysisWait } from "@/lib/analysisRecovery";
import { cleanupRenders, render } from "./miniRender";

const h = vi.hoisted(() => ({
  flag: true, timerReads: 0, recoveryReads: 0,
  data: undefined as Analysis | undefined,
  wait: { phase: "idle", startedAt: 0 } as AnalysisWait,
  refresh: vi.fn(), check: vi.fn(), request: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", Linking: {}, Animated: {}, Platform: { OS: "android" },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 475, height: 751, fontScale: 2 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ useRouter: () => ({}) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({}) }));
vi.mock("@/theme", async () => { const tokens = await import("@/tokens"); return { ...tokens, useTheme: () => tokens.light }; });
vi.mock("@/api/hooks", () => ({
  useFeature: () => h.flag,
  useAnalysisRecovery: () => { h.recoveryReads++; return { data: h.data, wait: h.wait, busy: ["checking", "generating", "recovering"].includes(h.wait.phase), refresh: h.refresh, check: h.check }; },
  useAnalysis: () => ({ data: h.data, isLoading: true, isError: false }),
  useStockMutations: () => ({ refreshAnalysis: { isPending: false, isError: false, error: null } }), useStockNews: vi.fn(),
}));
vi.mock("@/lib/useNow", () => ({ useNow: () => { h.timerReads++; return 1_000_000; } }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", ErrorView: "ErrorView", LiveDot: "LiveDot", Loading: "Loading", Muted: "Muted", SectionTitle: "SectionTitle", Stat: "Stat" }));
const { AnalysisTab, AnalysisPreview } = await import("@/components/StockDetailParts");

beforeEach(() => {
  cleanupRenders();
  h.flag = true; h.timerReads = 0; h.recoveryReads = 0;
  h.data = { id: 1, code: "005930", kind: "company", content: "이전 보고서 전체 본문", missing: [], model: "fake", createdAt: "2026-12-28T08:30:00+09:00", cached: true };
  h.wait = { phase: "idle", startedAt: 0 }; h.refresh.mockClear(); h.check.mockClear(); h.request.mockClear();
});

describe("분석 대기 화면", () => {
  it("갱신 중 이전 본문과 경과 시간을 함께 보여 주고 중복 갱신 버튼을 막는다", () => {
    h.wait = { phase: "generating", startedAt: 880_000 };
    const r = render(<AnalysisTab code="005930" kind="company" requested onRequest={h.request} />);
    expect(r.text()).toContain("이전 보고서 전체 본문");
    expect(r.text()).toContain("이전 분석을 보여 주는 중");
    expect(r.all().find((n) => n.type === "Loading")?.props.label).toBe("분석 처리 중 · 120초 경과");
    expect(r.all().find((n) => n.type === "Button")?.props.disabled).toBe(true);
  });

  it("미등록 종목을 다시 열어도 이미 진행 중이면 만들기 안내로 덮지 않는다", () => {
    h.data = undefined;
    h.wait = { phase: "recovering", startedAt: 880_000, requestId: "screen-test-request" };
    const r = render(<AnalysisTab code="005930" kind="company" requested={false} onRequest={h.request} />);
    expect(r.all().some((n) => n.type === "Loading")).toBe(true);
    expect(r.all().some((n) => n.props.title === "AI 분석 만들기")).toBe(false);
    expect(r.all().find((n) => n.type === "Loading")?.props.label).toContain("완료 결과 확인 중");
  });

  it("완료 미확인 상태의 결과 확인은 읽기 동작만 실행하고 이전 본문을 유지한다", () => {
    h.wait = { phase: "unknown", startedAt: 880_000, message: "서버 응답 시간 초과 · 완료 여부를 확인하지 못했습니다" };
    const r = render(<AnalysisPreview code="005930" kind="company" title="기업 개요" lines={3} requested onRequest={h.request} defaultOpen />);
    expect(r.text()).toContain("완료 여부를 확인하지 못했습니다");
    expect(r.text()).toContain("이전 보고서 전체 본문");
    const button = r.all().find((n) => n.props.title === "결과 확인")!;
    r.act(() => (button.props.onPress as () => void)());
    expect(h.check).toHaveBeenCalledOnce();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.timerReads).toBe(0);
  });

  it("본문을 읽는 동안 경과 타이머가 없고 플래그를 끄면 기존 생성 중 화면이다", () => {
    const ready = render(<AnalysisTab code="005930" kind="company" requested onRequest={h.request} />);
    expect(ready.text()).toContain("이전 보고서 전체 본문");
    expect(h.timerReads).toBe(0);
    const before = h.recoveryReads;
    h.flag = false;
    const off = render(<AnalysisTab code="005930" kind="company" requested onRequest={h.request} />);
    expect(h.recoveryReads).toBe(before);
    expect(off.text()).not.toContain("이전 보고서 전체 본문");
    expect(off.all().find((n) => n.type === "Loading")?.props.label).toBe("분석 생성 중");
  });
});
