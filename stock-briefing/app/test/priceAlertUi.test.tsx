import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceAlertRule, Quote, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 가격 알림 화면 (3-29, 플래그 priceAlerts): 종목 상세의 알림 버튼(아래 막대 · 휴대폰 머리 종 · 넓은 창 합친 머리 종), 알림 시트(터치 3번 · 값 조절 ·
 * 미국 종목 센트 · 이미 맞음 · 같은 조건 · 화면 읽기 · 지우기 확인 창 · 숫자 자판), 화면 위 카드, 설정 칸.
 * 화면은 문맥(PriceAlertContext)만 읽는다 — 제공자가 없으면 꺼짐 = 지금 화면 그대로 (기존 oneHandDetail·stockDetailFold 기대 그대로)
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flag: undefined as boolean | undefined,
  stock: undefined as unknown,
  push: vi.fn(),
  alert: vi.fn(),
  kb: [] as { ev: string; fn: (e: { endCoordinates: { height: number } }) => void; removed: boolean }[],
  now: Date.parse("2026-12-08T10:12:05+09:00"),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Modal: "Modal",
  TextInput: "TextInput",
  Alert: { alert: h.alert },
  Linking: { openURL: async () => undefined },
  Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: { position: "absolute" } },
  useWindowDimensions: () => h.win,
  Keyboard: {
    addListener: (ev: string, fn: (e: { endCoordinates: { height: number } }) => void) => {
      const sub = { ev, fn, removed: false };
      h.kb.push(sub);
      return { remove: () => void (sub.removed = true) };
    },
  },
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
  router: { back: vi.fn(), dismissTo: vi.fn(), push: h.push, navigate: vi.fn(), replace: vi.fn(), setParams: vi.fn(), canGoBack: () => true, canDismiss: () => true },
  useLocalSearchParams: () => ({ code: "005930" }),
  usePathname: () => "/stocks/005930",
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
vi.mock("@/lib/useNow", () => ({ useNow: () => h.now }));
const idle = { data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined };
vi.mock("@/api/hooks", () => ({
  useStock: () => ({ ...idle, data: h.stock }),
  useCandles: () => idle,
  useBriefings: () => ({ ...idle, data: [] }),
  useAnalysis: () => ({ ...idle, isLoading: true }),
  useStockNews: () => ({ ...idle, data: { news: [], newsError: null, disclosures: [], disclosuresError: null } }),
  useAnyMarketOpen: () => ({ open: false, fresh: false }),
  useStockMutations: () => ({ register: { mutate: vi.fn() }, remove: { mutate: vi.fn() }, refreshAnalysis: { mutate: vi.fn(), isPending: false, isError: false, error: null } }),
  useFeature: (key: string, fallback = false) => (key === "foldLayout" ? (h.flag ?? fallback) : fallback),
  useApi: () => ({ listStocks: async () => [] }),
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false, afterCost: false, sort: "created", apiUrl: "http://x" }) }));
vi.mock("@/lib/holdingsNav", async (orig) => ({ ...(await orig<typeof import("@/lib/holdingsNav")>()), useHoldingsNav: () => null, useCachedRow: () => null }));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 }, parseCandlePeriod: () => "D" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: Date.parse("2026-12-08T10:12:05+09:00"), feedOk: true }) }));
vi.mock("@/components/Skeleton", () => ({ DetailSkeleton: "DetailSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen", Disclaimer: "Disclaimer" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Chip: "Chip", ErrorView: "ErrorView", LiveDot: "LiveDot", Loading: "Loading", Muted: "Muted", SectionTitle: "SectionTitle", Segmented: "Segmented", Stat: "Stat", StatGrid: "StatGrid" }));

const { default: StockDetailScreen } = await import("@/app/stocks/[code]/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { PriceAlertContext, PRICE_ALERTS_OFF } = await import("@/lib/priceAlertContext");
const { PriceAlertSheet } = await import("@/components/PriceAlertSheet");
const { PriceAlertBanner } = await import("@/components/PriceAlertBanner");
const { PriceAlertSettingsCard, PriceAlertSettingsList } = await import("@/components/PriceAlertSettingsCard");
const { space } = await import("@/tokens");

type R = ReturnType<typeof render>;
const SESSION = { market: "KR" as const, phase: "regular", label: "한국 정규장", open: true, eligible: true, until: "2026-12-08T15:20:00+09:00" };
const kq = (price: number, extra: Partial<Quote> = {}) => quote("005930", price, { changeRate: 3.56, change: 2_900, prevClose: 81_400, asOf: "2026-12-08T10:12:00+09:00", session: SESSION, ...extra });
const samsung = (): RegisteredWithQuote & { registered?: boolean } => ({ ...holding("005930", kq(84_300), 120, 71_000, {}, "삼성전자"), registered: true });
const watch = (): RegisteredWithQuote & { registered?: boolean } => ({ ...holding("005930", kq(84_300), null, null, {}, "삼성전자"), registered: true });
const rule = (over: Partial<PriceAlertRule> = {}): PriceAlertRule => ({ id: 1, code: "005930", kind: "rateUp", value: 3, currency: null, createdAt: "2026-12-01T09:00:00+09:00", firedOn: "2026-12-08", firedAt: "2026-12-08T09:41:00+09:00", firedValue: 3.1, registered: true, ...over });
const TWO = [rule(), rule({ id: 2, kind: "priceAbove", value: 90_000, currency: "KRW", firedOn: null, firedAt: null })];

beforeEach(() => {
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flag = undefined;
  h.push.mockClear();
  h.alert.mockClear();
  h.kb = [];
  forgetWindowClass();
});

// ───────────────────────────── 종목 상세 ─────────────────────────────

const openDetail = (stock: unknown, opts: { alerts?: { rules: PriceAlertRule[]; openSheet: (s: { code: string; name: string; quote: Quote | null }) => void } | null; oneHand?: boolean } = {}) => {
  h.stock = stock;
  const ux = { oneHand: opts.oneHand ?? true, firstRun: false, emptyGuide: false, connectionGuide: false, flagsMissing: false };
  const screen = (
    <UxFlagsContext.Provider value={ux}>
      <StockDetailScreen />
    </UxFlagsContext.Provider>
  );
  if (!opts.alerts) return render(screen);
  return render(<PriceAlertContext.Provider value={{ on: true, rules: opts.alerts.rules, openSheet: opts.alerts.openSheet, remove: vi.fn(async () => undefined), nameOf: (c: string) => c }}>{screen}</PriceAlertContext.Provider>);
};
const screenOf = (r: R) => r.all().find((n) => n.type === "Screen")!;
const bar = (r: R) => render(screenOf(r).props.bottom as React.ReactElement);
const stackOptions = (r: R) => r.all().find((n) => n.type === "StackScreen")!.props.options as Record<string, unknown>;
const nodeText = (n: HostNode): string => n.children.map((c) => (typeof c === "string" ? c : nodeText(c))).join("");
const pressables = (r: R) => r.all().filter((n) => n.type === "Pressable");

describe("종목 상세: 알림 버튼 (등록 종목만)", () => {
  it("휴대폰 475×751 · oneHand: 아래 막대 3버튼, 가운데 '알림 2' · 이름표, 누르면 openSheet(코드·이름·시세)", () => {
    const openSheet = vi.fn();
    const r = openDetail(samsung(), { alerts: { rules: TWO, openSheet } });
    const b = bar(r);
    expect(pressables(b)).toHaveLength(3);
    const btn = b.byLabel("가격 알림 설정, 켜진 알림 2개");
    expect(nodeText(btn)).toBe("알림 2");
    expect(pressables(b).map((n) => n.props.accessibilityLabel)).toEqual(["보유 정보 수정", "가격 알림 설정, 켜진 알림 2개", "차트 전체 화면"]);
    // 44dp (내용 폭, 좌우 space.md)
    const style = Object.assign({}, ...((btn.props.style as (s: { pressed: boolean }) => unknown[])({ pressed: false }).filter(Boolean) as object[]));
    expect(style).toMatchObject({ minHeight: 44, flexGrow: 0, flexShrink: 0, paddingHorizontal: space.md });
    b.act(() => (btn.props.onPress as () => void)());
    expect(openSheet).toHaveBeenCalledWith({ code: "005930", name: "삼성전자", quote: samsung().quote });
  });

  it("조건이 없으면 '알림' · 이름표 '가격 알림 설정'. 좁고 큰 글씨면 종 아이콘만(폭 44)", () => {
    const r = openDetail(watch(), { alerts: { rules: [], openSheet: vi.fn() } });
    const btn = bar(r).byLabel("가격 알림 설정");
    expect(nodeText(btn)).toBe("알림");
    h.win = { width: 320, height: 700, scale: 2.625, fontScale: 1.5 };
    const small = bar(openDetail(watch(), { alerts: { rules: TWO, openSheet: vi.fn() } })).byLabel("가격 알림 설정, 켜진 알림 2개");
    expect(nodeText(small)).toBe("");
    const style = Object.assign({}, ...((small.props.style as (s: { pressed: boolean }) => unknown[])({ pressed: false }).filter(Boolean) as object[]));
    expect(style).toMatchObject({ width: 44, minHeight: 44 });
  });

  it("제공자 없음(꺼짐): 막대 버튼 2개 · 속성에 alert 없음 · 머리 오른쪽 그대로 (지금 화면)", () => {
    const r = openDetail(samsung());
    const b = bar(r);
    expect(pressables(b).map((n) => n.props.accessibilityLabel)).toEqual(["보유 정보 수정", "차트 전체 화면"]);
    expect((screenOf(r).props.bottom as React.ReactElement<Record<string, unknown>>).props).not.toHaveProperty("alert");
    const off = openDetail(samsung(), { oneHand: false });
    const right = render((stackOptions(off).headerRight as () => React.ReactElement)());
    expect(pressables(right).map((n) => n.props.accessibilityLabel)).toEqual(["보유 정보 수정"]);
    // 문맥 기본값은 꺼짐
    expect(PRICE_ALERTS_OFF.on).toBe(false);
  });

  it("미등록 종목(발견 탭에서 연 종목)은 켜져 있어도 알림 버튼·종이 없다", () => {
    const r = openDetail({ ...watch(), registered: false }, { alerts: { rules: TWO, openSheet: vi.fn() } });
    expect(pressables(bar(r)).some((n) => String(n.props.accessibilityLabel).startsWith("가격 알림"))).toBe(false);
    const off = openDetail({ ...watch(), registered: false }, { alerts: { rules: TWO, openSheet: vi.fn() }, oneHand: false });
    const right = render((stackOptions(off).headerRight as () => React.ReactElement)());
    expect(right.has("가격 알림 설정")).toBe(false);
  });

  it("oneHand 끔 + 켬: 머리 오른쪽 [종][수정] (종 44dp), 누르면 시트", () => {
    const openSheet = vi.fn();
    const r = openDetail(samsung(), { alerts: { rules: [], openSheet }, oneHand: false });
    const right = render((stackOptions(r).headerRight as () => React.ReactElement)());
    expect(pressables(right).map((n) => n.props.accessibilityLabel)).toEqual(["가격 알림 설정", "보유 정보 수정"]);
    const bell = right.byLabel("가격 알림 설정");
    expect(bell.props.hitSlop).toBeTruthy();
    right.act(() => (bell.props.onPress as () => void)());
    expect(openSheet).toHaveBeenCalledTimes(1);
  });

  it("넓은 창 933×704: 합친 머리에 종 버튼(수정 앞), 아래 막대 없음", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flag = true;
    const openSheet = vi.fn();
    const r = openDetail(samsung(), { alerts: { rules: TWO, openSheet } });
    const labels = pressables(r).map((n) => n.props.accessibilityLabel);
    const bell = labels.indexOf("가격 알림 설정, 켜진 알림 2개");
    expect(bell).toBeGreaterThan(-1);
    expect(labels[bell + 1]).toBe("보유 정보 수정");
    for (const s of r.all().filter((n) => n.type === "Screen")) expect(s.props).not.toHaveProperty("bottom");
    r.act(() => (r.byLabel("가격 알림 설정, 켜진 알림 2개").props.onPress as () => void)());
    expect(openSheet).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────── 알림 시트 ─────────────────────────────

const sheet = (o: { quote?: Quote | null; rules?: PriceAlertRule[]; code?: string; name?: string } = {}) => {
  const onSave = vi.fn();
  const onRemove = vi.fn();
  const onClose = vi.fn();
  const r = render(
    <PriceAlertSheet code={o.code ?? "005930"} name={o.name ?? "삼성전자"} quote={o.quote === undefined ? kq(84_300) : o.quote} rules={o.rules ?? []} volume={undefined} busy={false} onSave={onSave} onRemove={onRemove} onClose={onClose} />,
  );
  return { r, onSave, onRemove, onClose };
};
const saveBtn = (r: R) => r.all().find((n) => n.type === "Button")!;
const radio = (r: R, startsWith: string) => r.all().find((n) => n.props.accessibilityRole === "radio" && String(n.props.accessibilityLabel).startsWith(startsWith))!;
const press = (r: R, n: HostNode) => r.act(() => (n.props.onPress as () => void)());
const typeIn = (r: R, text: string) => r.act(() => (r.byLabel("알림 값").props.onChangeText as (t: string) => void)(text));
const inputValue = (r: R) => r.byLabel("알림 값").props.value;
const inside = (root: HostNode, target: HostNode): boolean => root === target || root.children.some((c) => typeof c !== "string" && inside(c, target));

describe("알림 시트", () => {
  it("터치 3번: (시트가 열린 상태에서) '88,600원 이상' 줄 → [알림 저장] → 저장 본문. 고르기 전에는 저장 꺼짐", () => {
    const { r, onSave } = sheet();
    expect(r.text()).toContain("가격 알림 · 삼성전자");
    expect(saveBtn(r).props.disabled).toBe(true);
    press(r, radio(r, "88,600원 이상"));
    expect(saveBtn(r).props.disabled).toBe(false);
    expect(saveBtn(r).props.title).toBe("알림 저장");
    press(r, saveBtn(r));
    expect(onSave).toHaveBeenCalledWith({ code: "005930", kind: "priceAbove", value: 88_600 });
    // [알림 저장]은 스크롤 밖 (글자가 커져도 늘 보임)
    const scroll = r.all().find((n) => n.type === "ScrollView")!;
    expect(inside(scroll, saveBtn(r))).toBe(false);
    expect(r.text()).toContain("앱을 켜 둔 동안 조건에 닿으면 화면 위 알림과 진동으로 알립니다 · 조건마다 하루 한 번 · 매매 권유가 아닙니다");
  });

  it("값 조절: [+] 한 번 → 89,400, 입력칸에 90000 → 90,000원 이상으로 저장", () => {
    const { r, onSave } = sheet();
    press(r, radio(r, "88,600원 이상"));
    press(r, r.byLabel("값 늘리기"));
    expect(inputValue(r)).toBe("89,400");
    expect(r.text()).toContain("89,400원 이상");
    typeIn(r, "90000");
    expect(r.text()).toContain("90,000원 이상");
    press(r, saveBtn(r));
    expect(onSave).toHaveBeenLastCalledWith({ code: "005930", kind: "priceAbove", value: 90_000 });
    expect(r.byLabel("알림 값").props.keyboardType).toBe("number-pad");
    expect(r.byLabel("알림 값").props.returnKeyType).toBe("done");
  });

  it("등락률 +6.2% 에서 '+5% 이상'을 직접 넣으면 '이미 맞음' 줄 (저장은 켜짐)", () => {
    const { r } = sheet({ quote: kq(89_500, { changeRate: 6.2 }) });
    press(r, radio(r, "전일 대비 10.00% 이상 상승"));
    typeIn(r, "5");
    expect(r.text()).toContain("지금 이미 이 조건에 맞아 저장하면 바로 한 번 알립니다");
    expect(saveBtn(r).props.disabled).toBe(false);
  });

  it("이미 있는 '80,000원 이하'를 고르면 '같은 알림이 이미 있습니다' · 저장 꺼짐", () => {
    const { r } = sheet({ rules: [rule({ id: 9, kind: "priceBelow", value: 80_000, currency: "KRW", firedOn: null, firedAt: null })] });
    press(r, radio(r, "80,000원 이하"));
    expect(r.text()).toContain("같은 알림이 이미 있습니다");
    expect(saveBtn(r).props.disabled).toBe(true);
  });

  it("한 종목 5개면 새 알림 줄 대신 '한 종목에 알림은 5개까지입니다'", () => {
    const five = [1, 2, 3, 4, 5].map((i) => rule({ id: i, kind: "priceAbove", value: 90_000 + i * 1000, currency: "KRW" }));
    const { r } = sheet({ rules: five });
    expect(r.text()).toContain("한 종목에 알림은 5개까지입니다");
    expect(r.all().filter((n) => n.props.accessibilityRole === "radio")).toHaveLength(0);
  });

  it("미국 종목 $11.34: '$12.00 이상' → [+] → 12.10 · 저장 켜짐 → 12.1 저장. $10.70 이하도 켜짐, 0.29 켜짐, 12.101 은 소수 오류", () => {
    const us = quote("AAPL", 11.34, { currency: "USD", changeRate: -1.2, asOf: "2026-12-08T23:40:00+09:00" });
    const { r, onSave } = sheet({ quote: us, code: "AAPL", name: "AAPL" });
    press(r, radio(r, "12.00달러 이상"));
    press(r, r.byLabel("값 늘리기"));
    expect(inputValue(r)).toBe("12.10");
    expect(saveBtn(r).props.disabled).toBe(false);
    press(r, saveBtn(r));
    expect(onSave).toHaveBeenCalledWith({ code: "AAPL", kind: "priceAbove", value: 12.1 });
    expect(r.byLabel("알림 값").props.keyboardType).toBe("decimal-pad");
    typeIn(r, "0.29");
    expect(saveBtn(r).props.disabled).toBe(false);
    typeIn(r, "12.101");
    expect(r.text()).toContain("소수 둘째 자리까지 넣어 주세요");
    expect(saveBtn(r).props.disabled).toBe(true);
    const r2 = sheet({ quote: us, code: "AAPL", name: "AAPL" }).r;
    press(r2, radio(r2, "10.70달러 이하"));
    expect(saveBtn(r2).props.disabled).toBe(false);
  });

  it("시세가 없으면 안내 한 줄과 거래량 줄만", () => {
    const { r } = sheet({ quote: null });
    expect(r.text()).toContain("시세를 받지 못해 가격·등락률 조건은 고를 수 없습니다");
    expect(r.all().filter((n) => n.props.accessibilityRole === "radio").map((n) => n.props.accessibilityLabel)).toEqual(["거래량 같은 시각 평균 3배 이상, 정규장 시간에 30분봉으로 확인합니다"]);
    press(r, radio(r, "거래량"));
    const chips = r.all().filter((n) => n.type === "Chip");
    expect(chips.map((c) => c.props.accessibilityLabel)).toEqual(["2배", "3배", "5배", "10배"]);
    expect(chips.find((c) => c.props.active)?.props.label).toBe("3배");
  });

  it("화면 읽기: 라디오 줄 · 지금 줄 · 켜진 알림 줄 · 지우기 버튼 이름표 (4.2 표 그대로)", () => {
    const { r } = sheet({ rules: [rule({ firedOn: null, firedAt: null, value: 3 }), rule({ id: 2, kind: "priceAbove", value: 88_600, currency: "KRW" })] });
    const radios = r.all().filter((n) => n.props.accessibilityRole === "radio");
    expect(radios.map((n) => n.props.accessibilityLabel)).toEqual([
      "88,600원 이상, 지금보다 5.10% 높음",
      "80,000원 이하, 지금보다 5.10% 낮음",
      "전일 대비 5.00% 이상 상승, 지금 전일 대비 3.56% 상승",
      "전일 대비 5.00% 이상 하락, 지금 전일 대비 3.56% 상승",
      "거래량 같은 시각 평균 3배 이상, 정규장 시간에 30분봉으로 확인합니다",
    ]);
    expect(radios.every((n) => (n.props.accessibilityState as { checked: boolean }).checked === false)).toBe(true);
    expect(r.has("지금 84,300원, 3.56% 상승, 10시 12분 기준")).toBe(true);
    expect(r.has("88,600원 이상, 오늘 9시 41분 울림")).toBe(true);
    expect(r.has("전일 대비 3.00% 이상 상승, 오늘 아직 울리지 않음")).toBe(true);
    expect(r.has("알림 지우기, 전일 대비 3.00% 이상 상승")).toBe(true);
    expect(r.text()).toContain("켜진 알림 2개");
    expect(r.text()).toContain("오늘 09:41 울림");
    for (const label of ["닫기", "알림 시트 닫기"]) expect(r.has(label)).toBe(true);
  });

  it("지우기 확인 창: 제목·글·버튼 → 확인해야 onRemove, 취소는 0번", () => {
    const target = rule({ firedOn: null, firedAt: null });
    const { r, onRemove } = sheet({ rules: [target] });
    press(r, r.byLabel("알림 지우기, 전일 대비 3.00% 이상 상승"));
    expect(h.alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = h.alert.mock.calls[0]! as [string, string, { text: string; style?: string; onPress?: () => void }[]];
    expect([title, message]).toEqual(["알림 지우기", "'전일 대비 +3.00% 이상' 알림을 지울까요?"]);
    expect(buttons.map((b) => b.text)).toEqual(["취소", "지우기"]);
    expect(onRemove).not.toHaveBeenCalled();
    buttons[0]!.onPress?.();
    expect(onRemove).not.toHaveBeenCalled();
    buttons[1]!.onPress!();
    expect(onRemove).toHaveBeenCalledWith(target);
  });

  it("숫자 자판이 열리면 시트를 위쪽에 붙이고 높이를 자판 위까지, 닫히면 아래로, 시트를 닫으면 구독을 뗀다", () => {
    const { r } = sheet();
    press(r, radio(r, "88,600원 이상"));
    const backdrop = () => r.all().find((n) => n.type === "Modal")!.children.find((c): c is HostNode => typeof c !== "string")!;
    const flat = (n: HostNode) => Object.assign({}, ...(n.props.style as object[]).filter(Boolean));
    expect(flat(backdrop())).toMatchObject({ justifyContent: "flex-end" });
    const show = h.kb.find((k) => k.ev === "keyboardDidShow")!;
    r.act(() => show.fn({ endCoordinates: { height: 300 } }));
    expect(flat(backdrop())).toMatchObject({ justifyContent: "flex-start" });
    const sheetBox = backdrop().children.filter((c): c is HostNode => typeof c !== "string")[1]!;
    expect(flat(sheetBox).maxHeight).toBe(751 - 300 - 32 - space.md * 2);
    expect(saveBtn(r)).toBeTruthy();
    r.act(() => h.kb.find((k) => k.ev === "keyboardDidHide")!.fn({ endCoordinates: { height: 0 } }));
    expect(flat(backdrop())).toMatchObject({ justifyContent: "flex-end" });
    r.unmount();
    expect(h.kb.every((k) => k.removed)).toBe(true);
  });

  it("넓은 창(933·704 폭)은 가운데 최대 560", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const { r } = sheet();
    const backdrop = r.all().find((n) => n.type === "Modal")!.children.find((c): c is HostNode => typeof c !== "string")!;
    expect(Object.assign({}, ...(backdrop.props.style as object[]))).toMatchObject({ justifyContent: "center" });
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    const r2 = sheet().r;
    const b2 = r2.all().find((n) => n.type === "Modal")!.children.find((c): c is HostNode => typeof c !== "string")!;
    expect(Object.assign({}, ...(b2.props.style as object[]))).toMatchObject({ justifyContent: "center" });
  });
});

// ───────────────────────────── 화면 위 카드 ─────────────────────────────

describe("화면 위 카드 (PriceAlertBanner)", () => {
  const hit = (id: number, name = "삼성전자") => ({
    rule: rule({ id, kind: "priceAbove", value: 88_600, currency: "KRW" }),
    code: "005930",
    name,
    date: "2026-12-08",
    firedValue: 88_700,
    quote: { price: 88_700, changeRate: 8.97, asOf: "2026-12-08T10:12:01+09:00", priceBasis: "KRX+NXT 통합", currency: "KRW" as const },
  });
  it("제목·본문·외 N건 · 닫기 44 · 줄 이름표 = hitSpeech · accessibilityLiveRegion 없음", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const r = render(<PriceAlertBanner hits={[hit(1), hit(2), hit(3), hit(4), hit(5)]} onOpen={onOpen} onClose={onClose} />);
    expect(r.text()).toContain("가격 알림");
    expect(r.text()).toContain("삼성전자 · 88,600원 이상");
    expect(r.text()).toContain("지금 88,700원 · 전일 대비 +8.97% · 10:12 기준 · NXT 포함");
    expect(r.text()).toContain("외 2건");
    const rows = r.all().filter((n) => n.props.accessibilityHint === "종목 화면 열기");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.props.accessibilityLabel).toBe("가격 알림, 삼성전자, 88,600원 이상에 닿음, 지금 88,700원, 8.97% 상승, 10시 12분 기준, NXT 포함");
    expect(rows[0]!.props.accessibilityRole).toBe("button");
    const close = r.byLabel("가격 알림 닫기");
    expect(close.props.style).toMatchObject({ width: 44, minHeight: 44 });
    expect(r.all().some((n) => "accessibilityLiveRegion" in n.props)).toBe(false);
    press(r, rows[0]!);
    expect(onOpen).toHaveBeenCalledWith("005930");
    press(r, close);
    expect(onClose).toHaveBeenCalled();
    expect(render(<PriceAlertBanner hits={[]} onOpen={onOpen} onClose={onClose} />).tree).toEqual([]);
  });
});

// ───────────────────────────── 설정 칸 ─────────────────────────────

describe("설정 '가격 알림' 칸", () => {
  const rules = [
    rule({ id: 2, kind: "priceAbove", value: 88_600, currency: "KRW" }),
    rule({ id: 3, code: "247540", kind: "priceBelow", value: 80_000, currency: "KRW", registered: false, firedOn: null, firedAt: null }),
  ];
  const names = { "005930": "삼성전자", "247540": "에코프로비엠" };
  it("속 부품: 목록 글 · 쉬는 중 글 · 줄 이름표 · 지우기는 같은 확인 창", () => {
    const onRemove = vi.fn();
    const r = render(<PriceAlertSettingsList rules={rules} names={names} nowMs={h.now} onRemove={onRemove} />);
    expect(r.text()).toContain("가격 알림");
    expect(r.text()).toContain("앱을 켜 둔 동안만 확인합니다. 조건은 종목 화면의 '알림'(종 모양)에서 만듭니다");
    expect(r.text()).toContain("삼성전자 · 88,600원 이상");
    expect(r.text()).toContain("오늘 09:41 울림");
    expect(r.text()).toContain("에코프로비엠 · 80,000원 이하");
    expect(r.text()).toContain("등록 종목이 아니라 확인하지 않음");
    expect(r.has("삼성전자, 88,600원 이상, 오늘 9시 41분 울림")).toBe(true);
    press(r, r.byLabel("알림 지우기, 88,600원 이상"));
    const [title, message, buttons] = h.alert.mock.calls[0]! as [string, string, { text: string; onPress?: () => void }[]];
    expect([title, message]).toEqual(["알림 지우기", "'88,600원 이상' 알림을 지울까요?"]);
    buttons[1]!.onPress!();
    expect(onRemove).toHaveBeenCalledWith(rules[0]);
  });

  it("빈 상태 글", () => {
    expect(render(<PriceAlertSettingsList rules={[]} names={{}} nowMs={h.now} onRemove={vi.fn()} />).text()).toContain("아직 만든 알림이 없습니다");
  });

  it("겉 부품은 문맥의 조건·이름으로 속 부품과 같은 글을 그린다 (쿼리 클라이언트 없이)", () => {
    const remove = vi.fn(async () => undefined);
    const outer = render(
      <PriceAlertContext.Provider value={{ on: true, rules, openSheet: vi.fn(), remove, nameOf: (c: string) => (names as Record<string, string>)[c] ?? c }}>
        <PriceAlertSettingsCard />
      </PriceAlertContext.Provider>,
    );
    const inner = render(<PriceAlertSettingsList rules={rules} names={names} nowMs={h.now} onRemove={vi.fn()} />);
    expect(outer.text()).toBe(inner.text());
    press(outer, outer.byLabel("알림 지우기, 80,000원 이하"));
    (h.alert.mock.calls.at(-1)![2] as { onPress?: () => void }[])[1]!.onPress!();
    expect(remove).toHaveBeenCalledWith(rules[1]);
  });
});
