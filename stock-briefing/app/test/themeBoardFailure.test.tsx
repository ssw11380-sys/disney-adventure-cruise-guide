import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeList, ThemeSummary } from "@/api/types";
import { render } from "./miniRender";

const h = vi.hoisted(() => ({
  data: undefined as ThemeList | undefined,
  failed: false,
  fetching: false,
  refetch: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", RefreshControl: "RefreshControl",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  FlatList: (p: { data: ThemeSummary[]; renderItem: (arg: { item: ThemeSummary; index: number }) => React.ReactNode; ListHeaderComponent: React.ReactNode; ListFooterComponent: React.ReactNode; ListEmptyComponent: React.ReactNode; numColumns?: number }) =>
    React.createElement("FlatList", { numColumns: p.numColumns }, p.ListHeaderComponent,
      p.data.length ? p.data.map((item, index) => React.createElement(React.Fragment, { key: item.id }, p.renderItem({ item, index }))) : p.ListEmptyComponent,
      p.ListFooterComponent),
}));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: () => 1 };
});
vi.mock("@/api/hooks", () => ({
  useDiscoverThemes: () => ({ data: h.data, isError: h.failed, isFetching: h.fetching, isLoading: false, isPlaceholderData: false, error: new Error("연결 실패"), refetch: h.refetch }),
}));
vi.mock("@/lib/settingsLink", () => ({ useSettingsGuide: () => ({}) }));
vi.mock("@/lib/uxFlags", () => ({ useUx: () => ({ emptyGuide: false }) }));
vi.mock("@/components/Screen", () => ({ DISCLAIMER: "시험용 고지" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Empty: "Empty", ErrorView: "ErrorView" }));
vi.mock("@/components/discover/shared", () => ({ StatusLine: "StatusLine", usePull: () => ({ pulling: false, onPull: h.refetch }) }));
vi.mock("@/components/discover/Skeleton", () => ({ SkeletonRows: "SkeletonRows" }));
vi.mock("@/components/discover/ThemeRow", () => ({
  useThemeRowH: () => 72,
  ThemeRow: ({ theme }: { theme: ThemeSummary }) => React.createElement("ThemeRow", { theme }, theme.name),
}));
vi.mock("@/components/discover/ThemeHeatmap", () => ({
  HEAT_MAX: { day: 5, week: 10, month: 20 }, HeatLegend: "HeatLegend",
  HeatTile: ({ theme }: { theme: ThemeSummary }) => React.createElement("HeatTile", { theme }, theme.name),
}));

const { ThemeBoard } = await import("@/components/discover/ThemeBoard");
const previous: ThemeSummary = { id: "test-theme", name: "기존 자료", changeRate: 1.2, up: 2, flat: 1, down: 0, leaders: [] };
beforeEach(() => {
  h.data = { market: "KR", kind: "theme", period: "day", themes: [previous], marketOpen: true, session: "regular", asOf: "2026-10-02T10:00:00+09:00", source: "시험 자료", basis: "구성 종목 평균" };
  h.failed = false;
  h.fetching = false;
  h.refetch.mockClear();
});

describe("테마·업종 보드 — 기존 자료가 남아 있는 조회 실패", () => {
  it.each([
    { name: "좁은 목록", width: undefined, heat: false, kind: "theme" as const },
    { name: "좁은 히트맵", width: undefined, heat: true, kind: "sector" as const },
    { name: "넓은 목록", width: 900, heat: false, kind: "sector" as const },
    { name: "넓은 히트맵", width: 900, heat: true, kind: "theme" as const },
  ])("$name: 이전 자료와 실패 안내·다시 확인 버튼을 함께 보여 준다", ({ width, heat, kind }) => {
    h.data!.kind = kind;
    h.failed = true;
    const r = render(<ThemeBoard market="KR" wideW={width} />);
    if (heat) r.act(() => (r.byLabel("히트맵으로 보기").props.onPress as () => void)());
    const word = kind === "theme" ? "테마" : "업종";
    expect(r.text()).toContain(`${word} 자료를 갱신하지 못했습니다. 이전 ${word} 자료를 표시합니다.`);
    const rows = r.all().filter((n) => n.type === (heat ? "HeatTile" : "ThemeRow"));
    expect(rows.map((n) => n.props.theme)).toEqual([previous]);
    expect(h.refetch).not.toHaveBeenCalled();
    r.act(() => (r.byLabel(`${word} 다시 확인`).props.onPress as () => void)());
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("정상 목록에는 실패 안내가 없고, 다시 받아 성공하면 안내를 거둔다", () => {
    const r = render(<ThemeBoard market="KR" />);
    expect(r.text()).not.toContain("갱신하지 못했습니다");
    expect(r.has("테마 다시 확인")).toBe(false);
    h.failed = true;
    r.rerender();
    expect(r.has("테마 다시 확인")).toBe(true);
    h.failed = false;
    h.data = { ...h.data!, themes: [{ ...previous, name: "새 자료", changeRate: 2.3 }] };
    r.rerender();
    expect(r.text()).not.toContain("갱신하지 못했습니다");
    expect(r.has("테마 다시 확인")).toBe(false);
    expect(r.all().find((n) => n.type === "ThemeRow")?.props.theme).toMatchObject({ name: "새 자료", changeRate: 2.3 });
  });

  it("기존 자료가 없는 첫 조회 실패는 이전 자료가 있다고 안내하지 않는다", () => {
    h.data = undefined;
    h.failed = true;
    const r = render(<ThemeBoard market="KR" />);
    expect(r.text()).not.toContain("이전 테마 자료");
    expect(r.has("테마 다시 확인")).toBe(false);
    expect(r.all().filter((n) => n.type === "ErrorView")).toHaveLength(1);
    expect(r.has("업종별")).toBe(true);
  });

  it("다시 받는 동안 공용 버튼의 로딩 상태로 연속 누름을 막는다", () => {
    h.failed = true;
    h.fetching = true;
    const r = render(<ThemeBoard market="KR" />);
    expect(r.byLabel("테마 다시 확인").props.loading).toBe(true);
    expect(r.all().filter((n) => n.type === "ThemeRow")).toHaveLength(1);
  });
});
