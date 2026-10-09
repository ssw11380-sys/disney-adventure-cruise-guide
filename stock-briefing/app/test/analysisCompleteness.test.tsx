import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Analysis } from "@/api/types";
import { cleanupRenders, render } from "./miniRender";

const h = vi.hoisted(() => ({ flag: false, data: undefined as Analysis | undefined }));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", Linking: {}, Animated: {}, Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 933, height: 704, fontScale: 1 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ useRouter: () => ({}) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({}) }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.light }; });
vi.mock("@/api/hooks", () => ({
  useFeature: () => h.flag,
  useAnalysis: () => ({ data: h.data, isLoading: false, isError: false }),
  useAnalysisRecovery: () => ({ data: h.data, wait: { phase: "idle", startedAt: 0 }, busy: false, refresh: vi.fn(), check: vi.fn() }),
  useStockMutations: () => ({ refreshAnalysis: { isPending: false, isError: false, mutate: vi.fn() } }), useStockNews: vi.fn(),
}));
vi.mock("@/lib/useNow", () => ({ useNow: () => 0 }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", ErrorView: "ErrorView", LiveDot: "LiveDot", Loading: "Loading", Muted: "Muted", SectionTitle: "SectionTitle", Stat: "Stat" }));
const { AnalysisTab, AnalysisPreview } = await import("@/components/StockDetailParts");

beforeEach(() => {
  cleanupRenders();
  h.flag = false;
  h.data = { id: 1, code: "005930", kind: "company", content: "검토할 보고서 본문", missing: ["재무 자료", "뉴스"], model: "fake", cached: true, createdAt: "2026-10-02T10:00:00+09:00" };
});

describe("분석 미리보기의 자료 누락 안내", () => {
  it.each([false, true].flatMap((flag) => ["tab", "preview", "expanded"].map((view) => ({ flag, view }))))(
    "복구 $flag · $view: 본문을 읽을 때 누락 자료를 펼침 여부와 관계없이 한 번 표시한다",
    ({ flag, view }) => {
      h.flag = flag;
      const r = render(view === "tab"
        ? <AnalysisTab code="005930" kind="company" requested onRequest={vi.fn()} />
        : <AnalysisPreview code="005930" kind="company" title="기업 개요" lines={3} requested onRequest={vi.fn()} defaultOpen={view === "expanded"} />);
      expect(r.text()).toContain("검토할 보고서 본문");
      expect(r.text()).toContain("데이터 미확인: 재무 자료, 뉴스");
      expect(r.text().match(/데이터 미확인:/g)).toHaveLength(1);
    },
  );

  it.each([false, true])("복구 %s: 누락 없는 분석에는 경고를 만들지 않는다", (flag) => {
    h.flag = flag;
    h.data = { ...h.data!, missing: [] };
    const r = render(<AnalysisPreview code="005930" kind="company" title="기업 개요" lines={3} requested onRequest={vi.fn()} />);
    expect(r.text()).toContain("검토할 보고서 본문");
    expect(r.text()).not.toContain("데이터 미확인:");
  });
});
