import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";

const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>, wide: false,
  history: undefined as unknown, accounts: undefined as unknown, summaries: undefined as unknown,
  historyError: false, accountError: false, summaryError: false, fetching: false,
  historyRetry: vi.fn(async () => undefined), accountRetry: vi.fn(async () => undefined), summaryRetry: vi.fn(async () => undefined), mutate: vi.fn(),
}));
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", RefreshControl: "RefreshControl", Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() }, Platform: { OS: "android" }, StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: h.wide ? 933 : 475, height: h.wide ? 704 : 751, scale: 1, fontScale: 1 }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn() }, Tabs: { Screen: "TabsScreen" } }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.dark, useFontScale: () => 1 }; });
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.parse("2026-10-04T12:00:00+09:00") }));
vi.mock("@/lib/settingsLink", () => ({ useSettingsGuide: () => ({}) }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/Freshness", () => ({ StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/BriefingSources", () => ({ BriefingSources: "BriefingSources" }));
vi.mock("@/components/AccountBriefingCard", () => ({ AccountBriefingCard: "AccountBriefingCard", AccountBriefingRow: "AccountBriefingRow" }));
vi.mock("@/components/MarketSummaryCard", () => ({ MarketSummaryCard: "MarketSummaryCard", MarketSummaryRow: "MarketSummaryRow" }));
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", Empty: "Empty", ErrorView: "ErrorView", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented", TableHead: "TableHead" }));

const report = { id: 12, code: "005930", name: "검증 종목", session: "morning", date: "2026-10-02", status: "ok", summary: "저장된 요약", detail: "저장된 전체 본문", missing: [], model: "fake", error: null, createdAt: "2026-10-02T08:40:00+09:00", data: null };
const past = { ...report, id: 11, date: "2026-10-01" };
vi.mock("@/api/hooks", () => {
  const q = (data: unknown) => ({ data, isError: false, isSuccess: data !== undefined, isFetching: h.fetching, refetch: vi.fn(async () => undefined), dataUpdatedAt: 1, fetchStatus: "idle" });
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ ...q({ features: h.flags }) }),
    useMarketSummaries: () => ({ ...q(h.summaries), isError: h.summaryError, refetch: h.summaryRetry }),
    useMarketSummary: () => q(undefined),
    useAccountBriefings: () => ({ ...q(h.accounts), isError: h.accountError, refetch: h.accountRetry }),
    useAccountBriefing: () => q(undefined),
    useLatestBriefings: () => q([{ code: report.code, name: report.name, latest: report }]),
    useRegisteredStocks: () => q([]), useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q({ KR: { isTradingDay: true, opensAt: null }, US: { isTradingDay: true } }),
    useStockMutations: () => ({ run: { mutate: h.mutate, isPending: false } }),
    useBriefing: () => q(report),
    useBriefings: () => ({ ...q(h.history), isError: h.historyError, refetch: h.historyRetry }),
    useBriefingStatus: () => q(undefined),
  };
});
const { BriefingBody } = await import("@/components/BriefingBody");
const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { statusView } = await import("@/lib/briefingStatus");
beforeEach(() => {
  h.flags = {}; h.wide = false; h.fetching = false;
  h.history = undefined; h.accounts = undefined; h.summaries = undefined;
  h.historyError = false; h.accountError = false; h.summaryError = false;
  h.historyRetry.mockClear(); h.accountRetry.mockClear(); h.summaryRetry.mockClear(); h.mutate.mockClear();
  forgetWindowClass();
});
afterEach(cleanupRenders);

describe("브리핑 목록 부분 실패에서 회복하기", () => {
  it.each(["stack", "split", "pane"] as const)("%s: 지난 목록만 실패해도 본문을 보존하고 해당 조회만 재시도한다", (layout) => {
    h.historyError = true;
    const r = render(<BriefingBody id={12} layout={layout} />);
    expect(r.text()).toContain("지난 브리핑 목록을 불러오지 못했습니다");
    expect(r.all().find((n) => n.type === "MarkdownView")?.children).toContain(report.detail);
    const button = r.all().find((n) => n.type === "Button" && n.props.accessibilityLabel === "지난 브리핑 목록 다시 불러오기")!;
    (button.props.onPress as () => void)();
    expect(h.historyRetry).toHaveBeenCalledTimes(1); expect(h.mutate).not.toHaveBeenCalled();
    h.history = [past]; r.rerender();
    expect(r.text()).toContain("이전에 받은 목록 기준입니다");
    expect(r.all().some((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).includes("10월 1일"))).toBe(true);
    h.historyError = false; r.rerender();
    expect(r.text()).not.toContain("불러오지 못했습니다");
    expect(r.text()).toContain("지난 브리핑");
  });
  it.each([false, true])("계좌·시장 목록 오류는 본문 목록을 막지 않고 각각 구분한다 (넓은 화면 %s)", (wide) => {
    h.wide = wide; h.flags = { accountBriefing: true, marketSummary: true, foldLayout: wide };
    h.accountError = true; h.summaryError = true;
    const r = render(<BriefingsScreen />);
    expect(r.text()).toContain("계좌 브리핑 목록을 불러오지 못했습니다");
    expect(r.text()).toContain("시장 요약 목록을 불러오지 못했습니다");
    const accountButton = r.all().find((n) => n.type === "Button" && n.props.accessibilityLabel === "계좌 브리핑 목록 다시 불러오기")!;
    (accountButton.props.onPress as () => void)();
    expect(h.accountRetry).toHaveBeenCalledTimes(1); expect(h.summaryRetry).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled();
    h.fetching = true; r.rerender();
    expect(r.all().find((n) => n.type === "Button" && n.props.accessibilityLabel === "계좌 브리핑 목록 다시 불러오기")?.props.loading).toBe(true);
    h.accountError = false; h.summaryError = false; h.accounts = []; h.summaries = []; r.rerender();
    expect(r.text()).not.toContain("불러오지 못했습니다");
  });
  it("기능이 꺼진 목록의 남은 오류는 표시하지 않는다", () => {
    h.accountError = true; h.summaryError = true;
    expect(render(<BriefingsScreen />).text()).not.toContain("목록을 불러오지 못했습니다");
  });
  it("계좌·시장 목록 갱신 실패 시 기존 카드와 날짜를 그대로 유지하며 캐시임을 알린다", () => {
    const account = { ...report, headline: null, template: true }, summary = { ...report, id: 15 };
    h.flags = { accountBriefing: true, marketSummary: true }; h.accounts = [account]; h.summaries = [summary];
    h.accountError = true; h.summaryError = true;
    const r = render(<BriefingsScreen />);
    expect(r.text().match(/이전에 받은 목록 기준입니다/g)).toHaveLength(2);
    expect(r.all().find((n) => n.type === "AccountBriefingCard")?.props.briefing).toBe(account);
    expect(r.all().find((n) => n.type === "MarketSummaryCard")?.props.summary).toBe(summary);
    expect(h.mutate).not.toHaveBeenCalled();
  });
  it("실행 완료 시각만으로 보고서 수치의 기준 시각을 단정하지 않는다", () => {
    const view = statusView({ session: "morning", date: "2026-10-02", state: "late", late: true, scheduledAt: "2026-10-02T08:30:00+09:00", startedAt: "2026-10-02T08:30:00+09:00", finishedAt: "2026-10-02T09:12:00+09:00", total: 1, done: 1, problems: [], reasonKind: null, nextRunAt: null, retryAt: null, manualRun: true }, Date.parse("2026-10-02T09:15:00+09:00"))!;
    expect(view.line).toBe("예정 08:30 → 09:12 완료");
    expect(view.small?.note).toBe("완료 시각은 생성이 끝난 때입니다. 자료 기준 시각은 각 보고서에서 확인해 주세요.");
    expect(view.speech).not.toContain("숫자는 9시 12분 기준");
  });
});
