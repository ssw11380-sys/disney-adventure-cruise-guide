import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefingWithData } from "@/api/types";
import { cleanupRenders, render } from "./miniRender";

const h = vi.hoisted(() => ({ sources: true, report: null as unknown, loading: false, queries: vi.fn() }));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", Alert: { alert: vi.fn() }, StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo-router", () => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("@/theme", async () => { const m = await import("@/tokens"); return { ...m, useTheme: () => m.dark }; });
vi.mock("@/api/hooks", () => ({
  useBriefing: () => ({ data: h.loading ? undefined : h.report, isPending: h.loading, isSuccess: !h.loading, isError: false, refetch: vi.fn(), dataUpdatedAt: 1 }),
  useBriefings: (...args: unknown[]) => { h.queries(...args); return { data: [] }; },
  useFeature: (key: string) => key === "briefingSources" && h.sources,
  useStockMutations: () => ({ run: { isPending: false, mutate: vi.fn() } }),
}));
vi.mock("@/lib/settingsLink", () => ({ useSettingsGuide: () => ({}) }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/BriefingList", () => ({ Pills: "Pills" }));
vi.mock("@/components/BriefingSources", () => ({ BriefingSources: "BriefingSources" }));
vi.mock("@/components/Freshness", () => ({ StaleBanner: "StaleBanner" }));
vi.mock("@/components/ReportVerification", () => ({ ReportVerificationNotice: "ReportVerificationNotice" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", ErrorView: "ErrorView", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented" }));
const { BriefingBody } = await import("@/components/BriefingBody");
const report = {
  id: 12, code: "005930", name: "긴 이름의 화면 검증용 종목", session: "morning", date: "2026-09-22", status: "ok",
  summary: "검증 요약", detail: "## 긴 보고서\n" + "원문 확인이 필요한 본문\n".repeat(100), missing: [], model: "fake", error: null,
  createdAt: "2026-09-22T08:30:00+09:00", data: { quote: null, news: [{ title: "검증 뉴스", url: "https://example.com" }], disclosures: [] },
} as unknown as BriefingWithData;
beforeEach(() => { h.sources = true; h.loading = false; h.report = report; h.queries.mockClear(); });
afterEach(cleanupRenders);

describe("긴 종목 보고서에서 근거 자료 찾기", () => {
  it("불러오는 화면에서 본문으로 바뀌어도 스크롤 연결을 유지한다", () => {
    h.loading = true;
    const r = render(<BriefingBody id={12} layout="stack" />);
    const initialRef = r.all().find(n => n.type === "Screen")!.props.scrollRef;
    expect(initialRef).toBeDefined();
    h.loading = false;
    r.rerender(<BriefingBody id={12} layout="stack" />);
    expect(r.all().find(n => n.type === "Screen")!.props.scrollRef).toBe(initialRef);
  });
  it.each(["stack", "pane"] as const)("%s: 본문보다 앞의 링크가 실제 근거 위치로 이동하고 재조회하지 않는다", (layout) => {
    const r = render(<BriefingBody id={12} layout={layout} />);
    const link = r.all().find(n => n.props.accessibilityLabel === "근거 뉴스 1, 근거 자료로 이동");
    expect(link).toBeDefined();
    const body = r.all().find(n => n.type === "MarkdownView")!;
    expect(r.all().indexOf(link!)).toBeLessThan(r.all().indexOf(body));
    expect(body.children.join("")).toBe(report.detail);
    const host = r.all().find(n => n.type === "Screen")!;
    const ref = host.props.scrollRef as { current: unknown };
    const scrollTo = vi.fn(); ref.current = { scrollTo };
    const marker = r.all().find(n => n.type === "View" && typeof n.props.onLayout === "function" && n.children.some(c => typeof c !== "string" && c.type === "BriefingSources"))!;
    (marker.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { y: 2400 } } });
    const queryCount = h.queries.mock.calls.length;
    (link!.props.onPress as () => void)();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ y: 2400, animated: true });
    expect(h.queries).toHaveBeenCalledTimes(queryCount);
  });
  it("근거 기능을 끄거나 스냅샷이 없으면 이동 링크를 표시하지 않는다", () => {
    h.sources = false;
    let r = render(<BriefingBody id={12} layout="stack" />);
    expect(r.all().some(n => String(n.props.accessibilityLabel).includes("근거 자료로 이동"))).toBe(false);
    h.sources = true; h.report = { ...report, data: null };
    r = render(<BriefingBody id={12} layout="stack" />);
    expect(r.all().some(n => String(n.props.accessibilityLabel).includes("근거 자료로 이동"))).toBe(false);
  });
  it("두 칸 배치에서는 근거가 왼쪽에 있으므로 잘못된 이동 링크를 만들지 않는다", () => {
    const r = render(<BriefingBody id={12} layout="split" />);
    expect(r.all().some(n => String(n.props.accessibilityLabel).includes("근거 자료로 이동"))).toBe(false);
    expect(r.all().some(n => n.type === "BriefingSources")).toBe(true);
  });
});
