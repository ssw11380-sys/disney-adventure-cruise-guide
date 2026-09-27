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
  dismissTo: vi.fn(),
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
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({
  Stack: { Screen: "StackScreen" },
  // 종목 상세는 루트 스택 위 (잔고 탭 위에 쌓임) → canDismiss 참
  router: { back: vi.fn(), dismissTo: h.dismissTo, push: h.push, navigate: h.navigate, replace: vi.fn(), setParams: vi.fn(), canGoBack: () => true, canDismiss: () => true },
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
  for (const f of [h.push, h.navigate, h.dismissTo, h.alert, h.register, h.remove, h.refetch]) f.mockClear();
  haptics.length = 0;
  installHaptics({ selectionAsync: async () => undefined, impactAsync: async () => undefined, notificationAsync: async (s: never) => void haptics.push(`notify:${s}`) }, "ios");
  setHapticPolicy({ oneHand: true, user: true });
  forgetWindowClass();
});

const open = (stock: RegisteredWithQuote & { registered?: boolean }, oneHand = true, emptyGuide = false) => {
  h.stock = stock;
  return render(
    <UxFlagsContext.Provider value={{ oneHand, firstRun: false, emptyGuide, connectionGuide: emptyGuide, flagsMissing: false }}>
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
    // 동작 버튼: 역할 button, 체크 상태 없음 (TalkBack 이 '선택됨'을 함께 읽지 않게)
    expect(btn.props.accessibilityRole).toBe("button");
    expect(btn.props.accessibilityState).not.toHaveProperty("checked");
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
    // 단위도 시세 머리와 같은 글 ('원' — 달러 종목은 'USD')
    expect(shown.text()).toBe(`삼성전자${headPrice}원+1.44%`);
    expect(headPrice).toBe("84,300");
    const texts = shown.all().filter((n) => n.type === "Text");
    expect(texts[1]!.props.style).toMatchObject({ color: dark.up });
    expect(shown.all()[0]!.props.accessibilityLabel).toContain("현재가 84,300원");
    // 더 스크롤해도 그대로, 다시 올리면 이름만
    scroll(r, 300);
    expect(title().text()).toBe(`삼성전자${headPrice}원+1.44%`);
    scroll(r, 10);
    expect(title().text()).toBe("삼성전자");
  });

  it("가격 줄이 다시 재어지면(글자 크기·줄 수가 바뀜) 스크롤 없이 지금 위치로 다시 판정한다", () => {
    const r = open(samsung());
    const title = () => render((stack(r).headerTitle as () => React.ReactElement)()).text();
    const [head, price] = r.all().filter((n) => n.type === "View" && "onLayout" in n.props) as [HostNode, HostNode];
    r.act(() => layout(head, 0, 180));
    r.act(() => layout(price, 20, 60));
    scroll(r, 100);
    expect(title()).toBe("삼성전자84,300원+1.44%");
    // 가격 줄이 두 줄로 늘어 아래 끝이 20+120=140 → 스크롤 100 에서는 아직 보인다 → 머리는 이름만
    r.act(() => layout(price, 20, 120));
    expect(title()).toBe("삼성전자");
    // 다시 줄어들면(60) 가려진 것 → 현재가
    r.act(() => layout(price, 20, 60));
    expect(title()).toBe("삼성전자84,300원+1.44%");
    // 시세 머리 칸이 아래로 밀려도(위에 띠가 생김) 다시 판정
    r.act(() => layout(head, 40, 180));
    expect(title()).toBe("삼성전자");
  });

  it("접기·펴기로 휴대폰↔넓은 창이 바뀌면 머리 현재가를 처음 상태로 (새 스크롤 칸은 맨 위에서 시작)", () => {
    h.flag = true;
    const r = open(samsung());
    const title = () => render((stack(r).headerTitle as () => React.ReactElement)()).text();
    const [head, price] = r.all().filter((n) => n.type === "View" && "onLayout" in n.props) as [HostNode, HostNode];
    r.act(() => layout(head, 0, 180));
    r.act(() => layout(price, 20, 60));
    scroll(r, 300);
    expect(title()).toBe("삼성전자84,300원+1.44%");
    // 펼침 (933dp) → 넓은 창 배치
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    r.rerender();
    r.rerender();
    expect(r.all().filter((n) => n.type === "Screen").every((n) => !("onScroll" in n.props))).toBe(true);
    // 다시 접음 (475dp) → 휴대폰 화면: 가격 줄이 보이는 맨 위 → 이름만
    h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
    r.rerender();
    r.rerender();
    expect(screen(r).props.onScroll).toBeTypeOf("function");
    expect(title()).toBe("삼성전자");
    // 새 스크롤 칸이 가격 줄을 다시 재기 전에는 스크롤해도 바뀌지 않고, 잰 뒤 지나가면 현재가
    scroll(r, 300);
    expect(title()).toBe("삼성전자");
    const [head2, price2] = r.all().filter((n) => n.type === "View" && "onLayout" in n.props) as [HostNode, HostNode];
    r.act(() => layout(head2, 0, 180));
    r.act(() => layout(price2, 20, 60));
    expect(title()).toBe("삼성전자84,300원+1.44%");
  });
});

describe("emptyGuide: 연결 오류에 '설정 열기'", () => {
  it("처음 불러오기 실패(토큰): 오류 화면에 설정 열기, 끊김 띠에도", () => {
    h.stockError = new ApiRequestError(401, "UNAUTHORIZED", "API 토큰이 틀리거나 비어 있습니다.");
    const r = open(undefined as never, false, true);
    const err = r.all().find((n) => n.type === "ErrorView")!;
    (err.props.onOpenSettings as () => void)();
    // 스택 위 화면: 탭 묶음을 하나 더 쌓지 않고 기존 설정 탭까지 닫고 간다 (dismissTo)
    expect(h.dismissTo).toHaveBeenCalledTimes(1);
    expect(h.dismissTo.mock.calls[0]![0]).toMatchObject({ pathname: "/settings", params: { open: "server" } });
    expect(h.navigate).not.toHaveBeenCalled();
    h.stockError = null;
    const ok = open(samsung(), false, true);
    expect(typeof (screen(ok).props.top as React.ReactElement<{ onOpenSettings?: unknown }>).props.onOpenSettings).toBe("function");
  });
});

describe("머리 현재가: 오른쪽 버튼 실제 폭을 빼고, 달러 종목은 단위 USD", () => {
  const maxW = (el: React.ReactElement) => {
    const t = render(el);
    const box = t.all()[0]!;
    return Object.assign({}, ...(box.props.style as object[]).filter(Boolean)).maxWidth as number;
  };

  it("미등록 종목의 '☆ 관심 추가' 글자 버튼 폭을 재어 제목 최대 폭에서 뺀다 (재기 전은 아이콘 하나 44)", () => {
    const r = open(preview());
    const title0 = (stack(r).headerTitle as () => React.ReactElement)();
    // 475 − 제목 시작 72 − 44 − 24
    expect(maxW(title0)).toBe(335);
    const right = render((stack(r).headerRight as () => React.ReactElement)());
    const box = right.all()[0]!;
    expect(box.type).toBe("View");
    r.act(() => (box.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 112.4, height: 44 } } }));
    // 475 − 72 − 112 − 24
    expect(maxW((stack(r).headerTitle as () => React.ReactElement)())).toBe(267);
    // 꺼져 있으면 재지 않는다 (오른쪽 버튼을 감싸지 않음 — 지금 그대로)
    const off = open(preview(), false);
    expect(render((stack(off).headerRight as () => React.ReactElement)()).all()[0]!.type).toBe("Pressable");
  });

  it("달러 종목 머리 현재가 옆 단위 USD (시세 머리와 같은 글)", () => {
    const apple = { ...holding("AAPL", quote("AAPL", 254.4, { currency: "USD", change: -4.1, changeRate: -1.59, fxRate: 1400 }), 30, 180, {}, "애플"), registered: true };
    const r = open(apple);
    const views = r.all().filter((n) => n.type === "View" && "onLayout" in n.props);
    layout(views[0]!, 0, 180);
    layout(views[1]!, 20, 60);
    scroll(r, 200);
    const shown = render((stack(r).headerTitle as () => React.ReactElement)());
    expect(shown.text()).toContain("USD");
    expect(shown.text()).toMatch(/^애플254\.40USD-1\.59%$/);
  });

  it("411dp·글자 130% 의 긴 미등록 이름: 이름이 한 글자로 줄지 않게 단위·등락률을 빼고 현재가만 (화면 읽기는 전부)", () => {
    h.win = { width: 411, height: 960, scale: 2.625, fontScale: 1.3 };
    const long = { ...holding("950220", quote("950220", 12_340, { change: 150, changeRate: 1.23 }), null, null, {}, "디엔에이링크우선주"), registered: false };
    const r = open(long);
    // 글자 130% 의 '☆ 관심 추가' 글자 버튼 (약 128)
    const right = render((stack(r).headerRight as () => React.ReactElement)());
    r.act(() => (right.all()[0]!.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 128, height: 44 } } }));
    const views = r.all().filter((n) => n.type === "View" && "onLayout" in n.props);
    layout(views[0]!, 0, 180);
    layout(views[1]!, 20, 60);
    scroll(r, 200);
    const shown = render((stack(r).headerTitle as () => React.ReactElement)());
    const headPrice = r.all().find((n) => n.type === "FlashPrice")!.props.text as string;
    // 현재가는 시세 머리 값 그대로, 단위·등락률은 뺌 → 이름 칸이 약 4자 폭을 가진다
    expect(shown.text()).toBe(`디엔에이링크우선주${headPrice}`);
    expect(shown.all()[0]!.props.accessibilityLabel).toContain("현재가 12,340원");
    // 같은 이름도 475dp·글자 100% 면 전부 (예전과 같음)
    h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    const wide = open(long);
    const v2 = wide.all().filter((n) => n.type === "View" && "onLayout" in n.props);
    layout(v2[0]!, 0, 180);
    layout(v2[1]!, 20, 60);
    scroll(wide, 200);
    expect(render((stack(wide).headerTitle as () => React.ReactElement)()).text()).toBe(`디엔에이링크우선주${headPrice}원+1.23%`);
  });
});
