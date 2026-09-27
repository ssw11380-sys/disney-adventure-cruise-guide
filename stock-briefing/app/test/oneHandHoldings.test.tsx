import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 잔고 탭 3-24 (기능 플래그 oneHand·emptyGuide — 루트가 UxFlagsContext 로 내려 준다).
 *  - oneHand: 휴대폰·접은 화면은 줄마다 스와이프(수정 · 삭제/동기화 제외/관심 해제), 넓은 표는 스와이프 없이 길게 누르기 메뉴. 둘 다 화면 읽기 동작.
 *    지우기는 늘 확인 창을 한 번 더 거친다. 정렬·메뉴·결과에 햅틱
 *  - emptyGuide: 빈 잔고·빈 관심에 안내 + 버튼 하나, 연결 오류에 '설정 열기'
 *  - 둘 다 꺼져 있으면(제공자 없음 포함) 지금 화면 그대로
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean | undefined>,
  stocks: undefined as unknown,
  stocksError: null as unknown,
  health: undefined as unknown,
  setSort: vi.fn(),
  push: vi.fn(),
  navigate: vi.fn(),
  alert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Modal: "Modal",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {} },
  Alert: { alert: h.alert },
  Platform: { OS: "android" },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, navigate: h.navigate }, usePathname: () => "/" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [
    { value: "created", label: "등록순" },
    { value: "changeRate", label: "등락률" },
  ],
  useSettings: () => ({ afterCost: false, showKrw: false, sort: "created", setSort: h.setSort }),
}));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useStocks: () => ({ data: h.stocks, isError: h.stocksError !== null, error: h.stocksError, refetch: async () => undefined, dataUpdatedAt: 1 }),
  useHealth: () => ({ data: h.health }),
  useAnyMarketOpen: () => ({ open: false, label: "장 마감" }),
  useStockMutations: () => ({ remove: { mutate: h.remove } }),
}));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  const Screen = ({ children, top }: { children: React.ReactNode; top?: React.ReactNode }) => R.createElement("Screen", null, R.createElement("Top", null, top), children);
  return { Screen };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", ErrorView: "ErrorView", TableHead: "TableHead" }));
vi.mock("@/components/Freshness", () => ({ LiveStatus: "LiveStatus", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: vi.fn() }), useFeedState: () => ({ now: 0, feedOk: true }) }));
vi.mock("@/components/MarketStrip", () => ({ MarketStrip: "MarketStrip" }));
vi.mock("@/components/Skeleton", () => ({ HoldingsSkeleton: "HoldingsSkeleton" }));
vi.mock("@/components/StockRow", () => ({ StockRow: "StockRow" }));
vi.mock("@/components/SwipeRow", () => ({ SwipeRow: "SwipeRow" }));
vi.mock("@/components/StockLine", () => ({ PRICE_HEAD: "현재가·등락률", useLineCols: () => ({ rank: 30, price: 100, right: 108 }) }));
vi.mock("@/components/HoldingsTableHead", () => ({ TableHeadRow: "TableHeadRow" }));
vi.mock("@/components/AccountBand", async (orig) => ({ ...(await orig<typeof import("@/components/AccountBand")>()), AccountBand: "AccountBand" }));

const { default: StocksScreen } = await import("@/app/(tabs)/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { forgetHoldingsAnchor } = await import("@/lib/holdingsAnchor");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { installHaptics, setHapticPolicy } = await import("@/lib/haptics");
const { ApiRequestError } = await import("@/api/client");

const FX = 1400;
const samsung = { ...holding("005930", quote("005930", 84_300, { change: 1_200, changeRate: 1.44 }), 120, 71_000, undefined, "삼성전자"), tossSynced: true };
const naver = holding("035420", quote("035420", 232_000, { change: 3_000, changeRate: 1.31 }), 15, 200_000, undefined, "NAVER");
const apple = holding("AAPL", quote("AAPL", 254.4, { currency: "USD", change: -4.1, changeRate: -1.59, fxRate: FX }), 30, 180, { costBasisKrw: 7_000_000, krwCostSource: "exact" }, "애플");
const avgo = holding("AVGO", quote("AVGO", 345.2, { currency: "USD", change: 5.9, changeRate: 1.74, fxRate: FX }), null, null, undefined, "브로드컴");
const STOCKS: RegisteredWithQuote[] = [samsung, naver, apple, avgo];

const haptics: string[] = [];
const engine = {
  selectionAsync: async () => void haptics.push("selection"),
  impactAsync: async (s: never) => void haptics.push(`impact:${s}`),
  notificationAsync: async (s: never) => void haptics.push(`notify:${s}`),
  performAndroidHapticsAsync: async (s: never) => void haptics.push(`android:${s}`),
};

beforeEach(() => {
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { allocationView: true };
  h.stocks = STOCKS;
  h.stocksError = null;
  h.health = undefined;
  for (const f of [h.setSort, h.push, h.navigate, h.alert, h.remove]) f.mockReset();
  haptics.length = 0;
  installHaptics(engine, "android");
  setHapticPolicy({ oneHand: true, user: true });
  forgetWindowClass();
  forgetHoldingsAnchor();
});

const ux = (o: Partial<{ oneHand: boolean; firstRun: boolean; emptyGuide: boolean }>) => ({ oneHand: false, firstRun: false, emptyGuide: false, ...o, connectionGuide: !!o.emptyGuide });
const draw = (flags: Partial<{ oneHand: boolean; firstRun: boolean; emptyGuide: boolean }> = {}) =>
  render(
    <UxFlagsContext.Provider value={ux(flags)}>
      <StocksScreen />
    </UxFlagsContext.Provider>,
  );
const byType = (r: ReturnType<typeof render>, type: string): HostNode[] => r.all().filter((n) => n.type === type);
const flush = () => new Promise((res) => setTimeout(res, 0));
/**
 * 줄마다 스와이프 틀 (StockRow 가 받은 wrapRow 로 만든 틀 — 줄 안에서 감싸 체결이 온 줄만 다시 그린다). 틀이 없는 줄은 건너뛴다
 */
const swipes = (r: ReturnType<typeof render>) =>
  byType(r, "StockRow")
    .filter((n) => typeof n.props.wrapRow === "function")
    .map((n) => {
      const el = (n.props.wrapRow as (s: unknown, row: React.ReactElement, l?: unknown) => React.ReactElement)(n.props.stock, <View />, undefined);
      return el as React.ReactElement<{ actions: { label: string; danger?: boolean; onPress: () => void }[]; children: React.ReactNode }>;
    });
const View = "View" as unknown as React.ComponentType;
/** 마지막 Alert.alert 의 버튼 */
const lastButtons = () => h.alert.mock.calls.at(-1)![2] as { text: string; style?: string; onPress?: () => void }[];

describe("플래그가 꺼져 있으면(제공자 없음·꺼짐) 지금 잔고 화면 그대로", () => {
  it.each([["제공자 없음", null], ["모두 꺼짐", {}]] as const)("%s", (_n, flags) => {
    const r = flags === null ? render(<StocksScreen />) : draw(flags);
    expect(swipes(r)).toHaveLength(0);
    const rows = byType(r, "StockRow");
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(Object.keys(row.props).sort()).toEqual(["afterCost", "live", "onLongPress", "onPress", "showKrw", "stock"]);
    // 길게 누르기: 예전 메뉴 (보유 정보 수정 · 삭제 · 취소), 삭제는 바로 (확인 창 없음 — 지금 그대로)
    (rows[0]!.props.onLongPress as (s: RegisteredWithQuote) => void)(samsung);
    expect(h.alert.mock.calls[0]![0]).toBe("삼성전자");
    expect(lastButtons().map((b) => b.text)).toEqual(["보유 정보 수정", "삭제", "취소"]);
    expect(haptics).toEqual([]);
    // 끊김 띠·관심 빈 칸: 새 속성 없음
    expect(byType(r, "StaleBanner")[0]!.props).not.toHaveProperty("onOpenSettings");
  });
});

describe("oneHand: 휴대폰·접은 화면은 줄 스와이프", () => {
  it("줄마다 스와이프 틀: 수정 · 지우기(토스 종목은 동기화 제외, 보유는 삭제, 관심은 관심 해제)", () => {
    const r = draw({ oneHand: true });
    const all = swipes(r);
    expect(all).toHaveLength(4);
    // 틀은 components/SwipeRow, 안에 받은 줄 그대로
    expect(all[0]!.type).toBe("SwipeRow");
    expect((all[0]!.props.children as React.ReactElement).type).toBe("View");
    const labels = all.map((x) => x.props.actions.map((a) => a.label));
    expect(labels).toEqual([
      ["수정", "동기화 제외"],
      ["수정", "삭제"],
      ["수정", "삭제"],
      ["수정", "관심 해제"],
    ]);
    // 지우기 버튼만 경고색
    expect(all[0]!.props.actions.map((a) => !!a.danger)).toEqual([false, true]);
    // 줄은 스와이프 틀 안에 (줄 자체 속성: 화면 읽기 동작 onRowAction 이 더해진다)
    const rows = byType(r, "StockRow");
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(typeof row.props.onRowAction).toBe("function");
  });

  it("스와이프 '수정'은 수정 화면, '동기화 제외'는 확인 창을 거쳐 지운다 (성공하면 햅틱)", async () => {
    const r = draw({ oneHand: true });
    const [edit, del] = swipes(r)[0]!.props.actions;
    edit!.onPress();
    expect(h.push).toHaveBeenCalledWith("/stocks/005930/edit");
    del!.onPress();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.alert.mock.calls[0]![0]).toBe("동기화 제외하고 삭제");
    expect(h.alert.mock.calls[0]![1]).toContain("다시 나타나지 않습니다");
    const buttons = lastButtons();
    expect(buttons.map((b) => b.text)).toEqual(["취소", "동기화 제외"]);
    expect(buttons[1]!.style).toBe("destructive");
    buttons[1]!.onPress!();
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.remove.mock.calls[0]![0]).toBe("005930");
    (h.remove.mock.calls[0]![1] as { onSuccess: () => void }).onSuccess();
    await flush();
    expect(haptics).toEqual(["android:confirm"]);
  });

  it("지우기 실패: 오류 햅틱 + 실패 안내", async () => {
    const r = draw({ oneHand: true });
    swipes(r)[1]!.props.actions[1]!.onPress();
    lastButtons()[1]!.onPress!();
    (h.remove.mock.calls[0]![1] as { onError: (e: Error) => void }).onError(new Error("서버 오류"));
    await flush();
    expect(haptics).toEqual(["android:reject"]);
    expect(h.alert.mock.calls.at(-1)!.slice(0, 2)).toEqual(["삭제 실패", "서버 오류"]);
  });

  it("길게 누르기 메뉴: 수정 · 지우기 · 취소 (햅틱), 지우기는 한 번 더 확인", async () => {
    const r = draw({ oneHand: true });
    (byType(r, "StockRow")[3]!.props.onLongPress as (s: RegisteredWithQuote) => void)(avgo);
    await flush();
    expect(haptics).toEqual(["android:long-press"]);
    expect(h.alert.mock.calls[0]![0]).toBe("브로드컴");
    const menu = lastButtons();
    expect(menu.map((b) => b.text)).toEqual(["수정", "관심 해제", "취소"]);
    menu[1]!.onPress!();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.alert.mock.calls.at(-1)![0]).toBe("관심 해제");
  });

  it("화면 읽기 동작: 수정 · 지우기가 스와이프와 같은 일", () => {
    const r = draw({ oneHand: true });
    const act = byType(r, "StockRow")[1]!.props.onRowAction as (s: RegisteredWithQuote, a: "edit" | "remove") => void;
    act(naver, "edit");
    expect(h.push).toHaveBeenCalledWith("/stocks/035420/edit");
    act(naver, "remove");
    expect(h.alert.mock.calls.at(-1)![0]).toBe("종목 삭제");
  });

  it("정렬을 바꾸면 짧은 햅틱 (정렬 값은 그대로 저장)", async () => {
    const r = draw({ oneHand: true });
    const head = r.all().find((n) => n.props.accessibilityLabel === "등락률순 정렬")!;
    (head.props.onPress as () => void)();
    await flush();
    expect(h.setSort).toHaveBeenCalledWith("changeRate");
    expect(haptics).toEqual(["android:segment-tick"]);
  });
});

describe("oneHand: 넓은 표는 스와이프 없이 길게 누르기 메뉴 + 화면 읽기 동작", () => {
  it("펼친 폴드8 가로 933×704 (foldLayout 켜짐)", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags = { allocationView: true, foldLayout: true };
    const r = draw({ oneHand: true });
    expect(swipes(r)).toHaveLength(0);
    const rows = byType(r, "StockRow");
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.props.columns).toBeTruthy();
      expect(typeof row.props.onRowAction).toBe("function");
    }
    (rows[0]!.props.onLongPress as (s: RegisteredWithQuote) => void)(samsung);
    expect(lastButtons().map((b) => b.text)).toEqual(["수정", "동기화 제외", "취소"]);
  });
});

describe("emptyGuide: 빈 잔고·빈 관심은 안내 + 버튼 하나, 연결 오류는 '설정 열기'", () => {
  const buttonsIn = (r: ReturnType<typeof render>) => byType(r, "Button");

  it("등록 종목 0: 안내 문구 + '종목 검색' 하나 (예전: 토스 연동이면 버튼 둘)", () => {
    h.stocks = [];
    h.health = { tossOpenApi: { configured: true } };
    const before = render(<StocksScreen />);
    expect(buttonsIn(before)).toHaveLength(2);
    const r = draw({ emptyGuide: true });
    const buttons = buttonsIn(r);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.title).toBe("종목 검색");
    expect(r.text()).toContain("등록된 종목이 없습니다");
    expect(r.text()).toContain("설정 > 토스증권 연동");
    (buttons[0]!.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/stocks/add");
  });

  it("보유만 있고 관심이 없으면 목록 끝에 관심 빈 칸 (버튼 하나), 관심이 있으면 없음", () => {
    h.stocks = [samsung, naver];
    // 계좌 패널의 '비중' 버튼은 빼고 본다 (다른 기능)
    h.flags = {};
    const r = draw({ emptyGuide: true });
    expect(r.text()).toContain("관심 종목이 없습니다");
    const buttons = buttonsIn(r);
    expect(buttons.map((b) => b.props.title)).toEqual(["관심 종목 찾기"]);
    h.stocks = STOCKS;
    expect(draw({ emptyGuide: true }).text()).not.toContain("관심 종목이 없습니다");
    h.stocks = [samsung, naver];
    expect(render(<StocksScreen />).text()).not.toContain("관심 종목이 없습니다");
  });

  it("처음 불러오기가 서버 연결 오류면 오류 화면에 '설정 열기' (끊김 띠에도)", () => {
    h.stocks = undefined;
    h.stocksError = new ApiRequestError(0, "NETWORK", "서버에 연결할 수 없습니다: http://wrong");
    const r = draw({ emptyGuide: true });
    const err = byType(r, "ErrorView")[0]!;
    expect(typeof err.props.onOpenSettings).toBe("function");
    (err.props.onOpenSettings as () => void)();
    expect(h.navigate).toHaveBeenCalledTimes(1);
    expect(h.navigate.mock.calls[0]![0]).toMatchObject({ pathname: "/settings", params: { open: "server" } });
    // 꺼져 있으면 속성을 넘기지 않는다
    expect(byType(render(<StocksScreen />), "ErrorView")[0]!.props).not.toHaveProperty("onOpenSettings");
    h.stocks = STOCKS;
    expect(typeof byType(draw({ emptyGuide: true }), "StaleBanner")[0]!.props.onOpenSettings).toBe("function");
  });

  it("플래그를 한 번도 못 받은 채 서버에 닿지 않으면(connectionGuide 만): '설정 열기'는 있고 빈 화면 안내는 예전 그대로", () => {
    h.stocks = undefined;
    h.stocksError = new ApiRequestError(0, "NETWORK", "서버에 연결할 수 없습니다: http://wrong");
    const only = { oneHand: false, firstRun: false, emptyGuide: false, connectionGuide: true };
    const r = render(
      <UxFlagsContext.Provider value={only}>
        <StocksScreen />
      </UxFlagsContext.Provider>,
    );
    expect(typeof byType(r, "ErrorView")[0]!.props.onOpenSettings).toBe("function");
    h.stocks = [];
    h.stocksError = null;
    h.health = { tossOpenApi: { configured: true } };
    const e = render(
      <UxFlagsContext.Provider value={only}>
        <StocksScreen />
      </UxFlagsContext.Provider>,
    );
    expect(buttonsIn(e)).toHaveLength(2);
  });
});
