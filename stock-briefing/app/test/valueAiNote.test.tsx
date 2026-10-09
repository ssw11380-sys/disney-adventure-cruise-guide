import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Analysis, AnalysisKind } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * AI 가치분석 안전망 (가치 점수 개선 1단계 [8], 서버 플래그 valueAiSafeWording — 앱 fallback 켜짐):
 * 금지어 검사가 놓친 말이 있어도 AI 가치분석 글을 그리는 모든 길(휴대폰·넓은 창 탭 · 울트라 펼침 미리보기 · 예전/분석 대기 개선 경로)에서
 * 글 바로 위에 'AI가 쓴 글 · 틀릴 수 있음 · 참고 정보이며 투자 권유가 아닙니다' 한 줄이 늘 붙는다. 기업개요·기술분석 글과 서버가 끈 경우는 지금 그대로
 */
const h = vi.hoisted(() => ({ flags: {} as Record<string, boolean>, data: undefined as Analysis | undefined }));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", Linking: {}, Animated: {}, Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 475, height: 751, fontScale: 1 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ useRouter: () => ({}) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({}) }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.light }; });
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useAnalysis: () => ({ data: h.data, isLoading: !h.data, isError: false }),
  useAnalysisRecovery: () => ({ data: h.data, wait: { phase: "idle", startedAt: 0 }, busy: false, refresh: vi.fn(), check: vi.fn() }),
  useStockMutations: () => ({ refreshAnalysis: { isPending: false, isError: false, mutate: vi.fn() } }), useStockNews: vi.fn(),
}));
vi.mock("@/lib/useNow", () => ({ useNow: () => 0 }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", ErrorView: "ErrorView", LiveDot: "LiveDot", Loading: "Loading", Muted: "Muted", SectionTitle: "SectionTitle", Stat: "Stat" }));
const { AnalysisTab, AnalysisPreview } = await import("@/components/StockDetailParts");
const { AI_NOTE, DISCLAIMER_SHORT, VALUE_AI_NOTE } = await import("@/lib/disclaimer");

const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const BODY = "## 매출과 이익\n매출은 3년 연속 늘었습니다.";
const VIEWS = ["tab", "preview", "expanded", "valuePane"] as const;
type View = (typeof VIEWS)[number];

function show(kind: AnalysisKind, view: View) {
  h.data = { id: 1, code: "NVDA", kind, content: BODY, missing: [], model: "fake", cached: true, createdAt: "2026-10-02T10:00:00+09:00" };
  return render(
    view === "tab" ? (
      <AnalysisTab code="NVDA" kind={kind} requested onRequest={vi.fn()} />
    ) : view === "valuePane" ? (
      // 울트라 펼침 세로 오른쪽 칸의 가치분석: 제목 줄만(lines 0) → 가치분석 탭으로 열면 펼친 채
      <AnalysisPreview code="NVDA" kind={kind} title="AI 가치분석" lines={0} defaultOpen requested onRequest={vi.fn()} />
    ) : (
      <AnalysisPreview code="NVDA" kind={kind} title="AI 분석" lines={3} defaultOpen={view === "expanded"} requested onRequest={vi.fn()} />
    ),
  );
}

beforeEach(() => {
  cleanupRenders();
  h.flags = {};
  h.data = undefined;
});

describe("AI 가치분석 글에 'AI가 쓴 글' + 고지 한 줄 (안전망)", () => {
  it("문구는 이미 쓰는 'AI가 쓴 글 · 틀릴 수 있음'과 짧은 고지를 이은 것", () => {
    expect(VALUE_AI_NOTE).toBe(`${AI_NOTE} · ${DISCLAIMER_SHORT}`);
    expect(VALUE_AI_NOTE).toBe("AI가 쓴 글 · 틀릴 수 있음 · 참고 정보이며 투자 권유가 아닙니다");
  });

  it.each([false, true].flatMap((recovery) => VIEWS.map((view) => ({ recovery, view }))))(
    "분석 대기 개선 $recovery · $view: 가치분석 글 바로 위에 한 줄, 한 번만",
    ({ recovery, view }) => {
      h.flags = { analysisWaitRecovery: recovery, valueAiSafeWording: true };
      const r = show("value", view);
      const text = r.text();
      expect(text).toContain("매출은 3년 연속 늘었습니다");
      expect(text.split(VALUE_AI_NOTE)).toHaveLength(2);
      // 글보다 위 (먼저 읽힌다)
      expect(text.indexOf(VALUE_AI_NOTE)).toBeLessThan(text.indexOf("매출"));
      expect(r.all().some((n) => n.type === "Muted" && textOf(n) === VALUE_AI_NOTE)).toBe(true);
    },
  );

  it.each([false, true])("분석 대기 개선 %s: 플래그를 아직 못 받았거나 예전 서버(값 없음)여도 붙는다 — 앱 fallback 켜짐", (recovery) => {
    h.flags = { analysisWaitRecovery: recovery };
    for (const view of VIEWS) expect(show("value", view).text(), view).toContain(VALUE_AI_NOTE);
  });

  it.each([false, true])("분석 대기 개선 %s: 서버가 valueAiSafeWording 을 끄면 지금 화면 그대로 (한 줄 없음)", (recovery) => {
    h.flags = { analysisWaitRecovery: recovery, valueAiSafeWording: false };
    for (const view of VIEWS) {
      const text = show("value", view).text();
      expect(text, view).toContain("매출은 3년 연속 늘었습니다");
      expect(text, view).not.toContain(AI_NOTE);
    }
  });

  it.each([false, true].flatMap((recovery) => (["company", "technical"] as const).map((kind) => ({ recovery, kind }))))(
    "분석 대기 개선 $recovery · $kind: 기업개요·기술분석 글에는 붙이지 않는다 (지금 그대로)",
    ({ recovery, kind }) => {
      h.flags = { analysisWaitRecovery: recovery, valueAiSafeWording: true };
      for (const view of VIEWS) expect(show(kind, view).text(), view).not.toContain(AI_NOTE);
    },
  );

  it("글이 없을 때(접힌 가치분석 제목 줄)는 한 줄도 없다 — 보이는 AI 글이 없으므로", () => {
    h.flags = { valueAiSafeWording: true };
    h.data = { id: 1, code: "NVDA", kind: "value", content: BODY, missing: [], model: "fake", cached: true, createdAt: "2026-10-02T10:00:00+09:00" };
    const folded = render(<AnalysisPreview code="NVDA" kind="value" title="AI 가치분석" lines={0} requested onRequest={vi.fn()} />);
    expect(folded.text()).not.toContain("매출");
    expect(folded.text()).not.toContain(AI_NOTE);
  });
});
