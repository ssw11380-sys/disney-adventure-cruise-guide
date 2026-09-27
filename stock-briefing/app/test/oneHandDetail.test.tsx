import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 종목 상세 3-24 (기능 플래그 oneHand·emptyGuide).
 *  - 휴대폰·접은 화면: 아래 고정 막대(관심 추가 / 관심 해제 / 보유 수정 · 차트 크게), 스크롤로 가격 줄이 가려지면 머리에 현재가(시세 머리와 같은 글)
 *  - 넓은 창: 합친 머리·차트가 늘 보이므로 막대·머리 현재가 없음 (중복 조작을 만들지 않는다)
 *  - 꺼져 있으면(제공자 없음) 막대·스크롤 속성·머리 제목 없음 — 지금 화면 그대로 (스냅숏은 test/stockDetailFold)
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flag: undefined as boolean | undefined,
  stock: undefined as unknown,
  stockError: null as unknown,
  push: vi.fn(),
  navigate: vi.fn(),
  alert: vi.fn(),
  register: vi.fn(),
  remove: vi.fn(),
  refetch: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Alert: { alert: h.alert },
  Linking: { openURL: async () => undefined },
  Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => h.win,
  Animated: {
    Value: class {
      constructor(public v: number) {}
      setValue(v: number) {
        this.v = v;
      }
    },
    View: "AnimatedView",
    timing: () => ({ start: () => undefined }),
  },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 32, bottom: 48, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({
  Stack: { Screen: "StackScreen" },
  router: { back: vi.fn(), dismissTo: vi.fn(), push: h.push, navigate: h.navigate, replace: vi.fn(), setParams: vi.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ code: "005930" }),
  usePathname: () => "/stocks/005930",
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
const idle = { data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined };
vi.mock("@/api/hooks", () => ({
  useStock: () => ({ ...idle, data: h.stock, isError: h.stockError !== null, error: h.stockError, refetch: h.refetch }),
  useCandles: () => idle,
  useBriefings: () => ({ ...idle, data: [] }),
  useAnalysis: () => ({ ...idle, isLoading: true }),
  useStockNews: () => ({ ...idle, data: { news: [], newsError: null, disclosures: [], disclosuresError: null } }),
  useAnyMarketOpen: () => ({ open: false, fresh: false }),
  useStockMutations: () => ({ register: { mutate: h.register }, remove: { mutate: h.remove }, refreshAnalysis: { mutate: vi.fn(), isPending: false, isError: false, error: null } }),
  useFeature: (key: string, fallback = false) => (key === "foldLayout" ? (h.flag ?? fallback) : fallback),
  useApi: () => ({ listStocks: async () => [] }),
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false, afterCost: false, sort: "created", apiUrl: "http://x" }) }));
vi.mock("@/lib/holdingsNav", async (orig) => ({ ...(await orig<typeof import("@/lib/holdingsNav")>()), useHoldingsNav: () => null, useCachedRow: () => null }));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 }, parseCandlePeriod: () => "D" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: Date.parse("2026-09-25T12:00:00Z"), feedOk: true }) }));
vi.mock("@/components/Skeleton", () => ({ DetailSkeleton: "DetailSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen", Disclaimer: "Disclaimer" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", ErrorView: "ErrorView", LiveDot: "LiveDot", Loading: "Loading", Muted: "Muted", SectionTitle: "SectionTitle", Segmented: "Segmented", Stat: "Stat", StatGrid: "StatGrid" }));

const { default: StockDetailScreen } = await import("@/app/stocks/[code]/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { installHaptics, setHapticPolicy } = await import("@/lib/haptics");
const { ApiRequestError } = await import("@/api/client");
const { dark } = await import("@/tokens");

const samsung = () => ({ ...holding("005930", quote("005930", 84_300, { change: 1_200, changeRate: 1.44, prevClose: 83_100 }), 120, 71_000, {}, "삼성전자"), registered: true });
const watch = () => ({ ...holding("035720", quote("035720", 41_000, { change: -300, changeRate: -0.73 }), null, null, {}, "카카오"), registered: true });
const preview = () => ({ ...watch(), registered: false });

const haptics: string[] = [];
beforeEach(() => {
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flag = undefined;
  h.stockError = null;
  for (const f of [h.push, h.navigate, h.alert, h.register, h.remove, h.refetch]) f.mockClear();
  haptics.length = 0;
  installHaptics({ selectionAsync: async () => undefined, impactAsync: async () => undefined, notificationAsync: async (s: never) => void haptics.push(`notify:${s}`) }, "ios");
  setHapticPolicy({ oneHand: true, user: true });
  forgetWindowClass();
});

const open = (stock: RegisteredWithQuote & { registered?: boolean }, oneHand = true, emptyGuide = false) => {
  h.stock = stock;
  return render(
    <UxFlagsContext.Provider value={{ oneHand, firstRun: false, emptyGuide }}>
      <StockDetailScreen />
    </UxFlagsContext.Provider>,
  );
};
const screen = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "Screen")!;
const stack = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "StackScreen")!.props.options as Record<string, unknown>;
const bar = (r: ReturnType<typeof render>) => render(screen(r).props.bottom as React.ReactElement);
const flush = () => new Promise((res) => setTimeout(res, 0));
const layout = (n: HostNode, y: number, height: number) => (n.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y, width: 475, height } } });
const scroll = (r: ReturnType<typeof render>, y: number) => r.act(() => (screen(r).props.onScroll as (e: unknown) => void)({ nativeEvent: { contentOffset: { x: 0, y } } }));

describe("꺼져 있으면 지금 화면 그대로", () => {
  it("막대·스크롤 속성·머리 제목 없음", () => {
    const r = open(samsung(), false);
    const s = screen(r);
    for (const k of ["bottom", "onScroll", "scrollEventThrottle"]) expect(s.props).not.toHaveProperty(k);
    expect(stack(r)).not.toHaveProperty("headerTitle");
    expect(r.all().filter((n) => n.type === "View" && "onLayout" in n.props)).toHaveLength(0);
  });
});

describe("휴대폰·접은 화면 아래 고정 막대 (관심 · 차트)", () => {
  it("보유 종목: '보유 수정' · '차트 크게' (둘 다 44dp, 이름표)", () => {
    const r = open(samsung());
    const b = bar(r);
    expect(b.has("보유 정보 수정")).toBe(true);
    expect(b.has("차트 전체 화면")).toBe(true);
    for (const n of b.all().filter((x) => x.type === "Pressable")) {
      const style = (n.props.style as (s: { pressed: boolean }) => unknown[])({ pressed: false });
      expect(Object.assign({}, ...style.filter(Boolean))).toMatchObject({ minHeight: 44 });
    }
    b.act(() => (b.byLabel("보유 정보 수정").props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/stocks/005930/edit");
    b.act(() => (b.byLabel("차트 전체 화면").props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/stocks/005930/chart?period=D");
  });

  it("미등록 종목: '관심 추가' → 등록, 끝나면 햅틱", async () => {
    const r = open(preview());
    const b = bar(r);
    expect(b.text()).toContain("관심 추가");
    b.act(() => (b.byLabel("관심 종목에 추가").props.onPress as () => void)());
    expect(h.register).toHaveBeenCalledTimes(1);
    (h.register.mock.calls[0]![1] as { onSuccess: () => void }).onSuccess();
    await flush();
    expect(haptics).toEqual(["notify:success"]);
  });

  it("관심 종목: '관심 해제' → 확인 창 → 지우고 다시 받음 (미등록 종목으로)", () => {
    const r = open(watch());
    const b = bar(r);
    const btn = b.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith("관심 종목에서 빼기"))!;
    expect(btn.props.accessibilityState).toMatchObject({ checked: true });
    b.act(() => (btn.props.onPress as () => void)());
    expect(h.remove).not.toHaveBeenCalled();
    const [title, , buttons] = h.alert.mock.calls[0]! as [string, string, { text: string; onPress?: () => void }[]];
    expect(title).toBe("관심 해제");
    buttons[1]!.onPress!();
    expect(h.remove).toHaveBeenCalledWith("035720", expect.anything());
    (h.remove.mock.calls[0]![1] as { onSuccess: () => void }).onSuccess();
    expect(h.refetch).toHaveBeenCalled();
  });

  it("넓은 창(펼친 폴드8 가로)에는 막대·머리 현재가를 두지 않는다 (합친 머리·차트가 늘 보임)", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flag = true;
    const r = open(samsung());
    for (const s of r.all().filter((n) => n.type === "Screen")) {
      expect(s.props).not.toHaveProperty("bottom");
      expect(s.props).not.toHaveProperty("onScroll");
    }
  });
});

describe("스크롤하면 머리에 현재가 (값 = 시세 머리)", () => {
  it("가격 줄이 가려질 때만 한 번 바뀌고, 글은 시세 머리의 현재가·등락률과 같다", () => {
    const r = open(samsung());
    const s = screen(r);
    expect(s.props.scrollEventThrottle).toBe(16);
    const title = () => render((stack(r).headerTitle as () => React.ReactElement)());
    expect(title().text()).toBe("삼성전자");
    // 시세 머리: 머리 칸(y 0) 안 가격 줄(y 20, 높이 60) → 80 을 지나면
    const views = r.all().filter((n) => n.type === "View" && "onLayout" in n.props);
    expect(views).toHaveLength(2);
    const [head, price] = views as [HostNode, HostNode];
    expect(price.props.accessible).toBe(true);
    layout(head, 0, 180);
    layout(price, 20, 60);
    scroll(r, 50);
    expect(title().text()).toBe("삼성전자");
    scroll(r, 81);
    const shown = title();
    // 시세 머리의 현재가(FlashPrice 글)·등락률과 같은 글
    const headPrice = r.all().find((n) => n.type === "FlashPrice")!.props.text as string;
    expect(shown.text()).toBe(`삼성전자${headPrice}+1.44%`);
    expect(headPrice).toBe("84,300");
    const texts = shown.all().filter((n) => n.type === "Text");
    expect(texts[1]!.props.style).toMatchObject({ color: dark.up });
    expect(shown.all()[0]!.props.accessibilityLabel).toContain("현재가 84,300원");
    // 더 스크롤해도 그대로, 다시 올리면 이름만
    scroll(r, 300);
    expect(title().text()).toBe(`삼성전자${headPrice}+1.44%`);
    scroll(r, 10);
    expect(title().text()).toBe("삼성전자");
  });
});

describe("emptyGuide: 연결 오류에 '설정 열기'", () => {
  it("처음 불러오기 실패(토큰): 오류 화면에 설정 열기, 끊김 띠에도", () => {
    h.stockError = new ApiRequestError(401, "UNAUTHORIZED", "API 토큰이 틀리거나 비어 있습니다.");
    const r = open(undefined as never, false, true);
    const err = r.all().find((n) => n.type === "ErrorView")!;
    (err.props.onOpenSettings as () => void)();
    expect(h.navigate).toHaveBeenCalledTimes(1);
    h.stockError = null;
    const ok = open(samsung(), false, true);
    expect(typeof (screen(ok).props.top as React.ReactElement<{ onOpenSettings?: unknown }>).props.onOpenSettings).toBe("function");
  });
});
