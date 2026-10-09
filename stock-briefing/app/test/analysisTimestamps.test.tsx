import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Analysis } from "@/api/types";
import { render } from "./miniRender";

const h = vi.hoisted(() => ({ flag: false, data: undefined as Analysis | undefined, notices: [] as unknown[] }));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", Linking: {}, Animated: {}, Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 475, height: 751, fontScale: 2 }),
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
// 시세 시각·검사 결과 안내의 문구 검증은 공통 컴포넌트 테스트가 맡고, 여기서는 모든 본문 경로의 전달 여부를 확인한다.
vi.mock("@/components/ReportVerification", () => ({
  ReportVerificationNotice: ({ verification }: { verification?: unknown }) => {
    h.notices.push(verification);
    return React.createElement("ReportVerificationNotice", { verification });
  },
}));
const { AnalysisTab, AnalysisPreview } = await import("@/components/StockDetailParts");

beforeEach(() => {
  h.flag = false;
  h.notices = [];
  h.data = { id: 1, code: "005930", kind: "company", content: "검토할 보고서 본문", missing: [], model: "fake", cached: true, createdAt: "2026-10-02T10:00:00+09:00" };
});

describe("AI 보고서의 생성 시각과 자료 시각 구분", () => {
  it.each([false, true].flatMap((flag) => ["tab", "preview", "expanded"].map((view) => ({ flag, view }))))(
    "복구 $flag · $view: 생성 시각을 자료 기준처럼 표시하지 않고 시세 안내에 원자료 정보를 전달한다",
    ({ flag, view }) => {
      h.flag = flag;
      const verification = { scope: "quote_claims" as const, quoteAsOf: "2026-10-01T15:30:00+09:00", quoteSource: "시험 시세", checkedClaims: 0, issues: [] };
      h.data = { ...h.data!, verification } as Analysis;
      const r = render(view === "tab"
        ? <AnalysisTab code="005930" kind="company" requested onRequest={vi.fn()} />
        : <AnalysisPreview code="005930" kind="company" title="기업 개요" lines={3} requested onRequest={vi.fn()} defaultOpen={view === "expanded"} />);
      expect(r.text()).toContain("생성");
      expect(r.text()).toContain("10:00");
      expect(r.text()).not.toMatch(/10:00\s*기준/);
      expect(r.text()).toContain("검토할 보고서 본문");
      expect(h.notices).toContain(verification);
    },
  );

  it.each([false, true])("복구 %s: 예전 서버의 자료 시각이 없으면 생성 시각을 대신 넘기지 않는다", (flag) => {
    h.flag = flag;
    render(<AnalysisTab code="005930" kind="company" requested onRequest={vi.fn()} />);
    expect(h.notices).toEqual([undefined]);
  });
});
