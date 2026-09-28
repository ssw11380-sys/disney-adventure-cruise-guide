import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconcileBadgeBody, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 잔고 계좌 합계 옆 '숫자 기준' 점 (3-32 PR 1, 기능 플래그 numberBasis — 잔고 화면).
 *  - 끔(플래그 없음 = 앱 fallback 꺼짐 · 서버 끔): 점·창이 없고 배지 조회 0번, 계좌 패널 숫자 네 칸은 지금처럼 요약 문장 묶음 안, 계좌 띠에 basis 속성 없음
 *  - 켬 475×751: 총액 줄 오른쪽 끝에 점 + 짧은 글(새 줄 없음), 요약 문장 밖, 누르는 칸 44×44 · hitSlop 없음. 누르면 '숫자 기준' 창, 닫기
 *  - 켬 933×704: 넓은 한 줄 띠는 '비중' 바로 앞, 좁은 한 줄 띠(국내·해외 수익률을 빼는 폭)는 점만 (누르는 칸은 그대로 44×44)
 *  - 켬 + 보유 0: 점 없음 / 켬 + 촘촘(3-39): 촘촘 요약 묶음 오른쪽, 넓은 두 줄 띠 촘촘은 '비중' 앞
 * 부품(StockRow·MarketStrip·LiveStatus)은 이름만 있는 가짜, 계좌 띠(AccountBand)는 진짜를 그리되 받은 속성을 적어 둔다. 시각은 고정
 */
const NOW = Date.parse("2026-09-28T14:03:30+09:00");
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean | undefined>,
  density: undefined as string | undefined,
  stocks: undefined as unknown,
  badge: undefined as unknown,
  badgeCalls: 0,
  bandProps: [] as Record<string, unknown>[],
  push: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Modal: "Modal",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: { position: "absolute" } },
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, navigate: vi.fn(), dismissTo: vi.fn(), canDismiss: () => false }, usePathname: () => "/" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  useSettings: () => ({ afterCost: true, showKrw: false, sort: "created", setSort: vi.fn(), density: h.density }),
}));
vi.mock("@/lib/useNow", () => ({ useNow: () => NOW }));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useStocks: () => ({ data: h.stocks, isError: false, error: null, refetch: async () => undefined, dataUpdatedAt: 1 }),
  useHealth: () => ({ data: undefined }),
  useAnyMarketOpen: () => ({ open: false, label: "장 마감" }),
  useStockMutations: () => ({ remove: { mutate: vi.fn() } }),
  useReconcileBadge: () => {
    h.badgeCalls += 1;
    return { data: h.badge };
  },
}));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  const Screen = ({ children, top }: { children: React.ReactNode; top?: React.ReactNode }) => R.createElement("Screen", null, R.createElement("Top", null, top), children);
  return { Screen };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", ErrorView: "ErrorView", TableHead: "TableHead" }));
vi.mock("@/components/Freshness", () => ({ LiveStatus: "LiveStatus", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: NOW, feedOk: true }) }));
vi.mock("@/components/MarketStrip", () => ({ MarketStrip: "MarketStrip" }));
vi.mock("@/components/Skeleton", () => ({ HoldingsSkeleton: "HoldingsSkeleton" }));
vi.mock("@/components/StockRow", () => ({ StockRow: "StockRow" }));
vi.mock("@/components/SwipeRow", () => ({ SwipeRow: "SwipeRow", closeOpenRow: () => false }));
vi.mock("@/components/TossImportButton", () => ({ TossImportButton: "TossImportButton" }));
vi.mock("@/components/StockLine", () => ({ PRICE_HEAD: "현재가·등락률", useLineCols: () => ({ rank: 30, price: 100, right: 108 }) }));
vi.mock("@/components/HoldingsTableHead", () => ({ TableHeadRow: "TableHeadRow" }));
// 계좌 띠: 진짜를 그리되 받은 속성을 적어 둔다 (끄면 basis 속성 자체가 없는지 본다)
vi.mock("@/components/AccountBand", async (orig) => {
  const m = await orig<typeof import("@/components/AccountBand")>();
  const R = await import("react");
  const AccountBand = (p: Parameters<typeof m.AccountBand>[0]) => {
    h.bandProps.push(p as unknown as Record<string, unknown>);
    return R.createElement(m.AccountBand, p);
  };
  return { ...m, AccountBand };
});

const { default: StocksScreen } = await import("@/app/(tabs)/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { forgetHoldingsAnchor } = await import("@/lib/holdingsAnchor");
const { dark, space, touch } = await import("@/tokens");

const FX = 1_390;
const KR = [1, 2, 3].map((i) => holding(`10000${i}`, quote(`10000${i}`, 10_000 * i, { change: 100, changeRate: 1, priceBasis: "KRX+NXT 통합", asOf: `2026-09-28T14:0${i}:00+09:00` }), 10, 9_000 * i, undefined, `국내${i}`));
const US = [1, 2].map((j) =>
  holding(`US${j}`, quote(`US${j}`, 100 * j, { currency: "USD", change: 1, changeRate: 1, fxRate: FX, priceBasis: "주간거래", asOf: "2026-09-28T14:01:00+09:00" }), 10, 90 * j, { costBasisKrw: 1_200_000 * j, krwCostSource: "exact" }, `미국${j}`),
);
const WATCH = [holding("200001", quote("200001", 50_000, { priceBasis: "KRX+NXT 통합" }), null, null, undefined, "관심1")];
const STOCKS: RegisteredWithQuote[] = [...KR, ...US, ...WATCH];

const SYNC = { enabled: true, intervalMin: 10, idleIntervalMin: 60, lastRunAt: "2026-09-28T14:00:00+09:00", nextRunAt: "2026-09-28T14:10:00+09:00" };
const BADGE_OK: ReconcileBadgeBody = {
  on: true,
  status: { last: { at: "2026-09-28T14:00:00+09:00", diffKrw: -1_234, diffPct: -0.01, missing: 0, n: 17 }, streakOver: 0, qtyStreak: 0, week: { n: 10, withinPct: 100 }, alert: false },
  intraday: { n: 42, withinPct: 97.6, skipped: 0 },
  sync: SYNC,
};
const OK_LABEL = "숫자 기준 보기, 토스 계좌와 0.1% 이내, 같은 종목 17개 비교, 14시 대조";

beforeEach(() => {
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { allocationView: true };
  h.density = undefined;
  h.stocks = STOCKS;
  h.badge = BADGE_OK;
  h.badgeCalls = 0;
  h.bandProps = [];
  h.push.mockReset();
});

type R = ReturnType<typeof render>;
const size = (w: number, hh: number, fontScale = 1) => {
  h.win = { width: w, height: hh, scale: 2.625, fontScale };
};
const draw = (): R => {
  forgetWindowClass();
  forgetHoldingsAnchor();
  return render(<StocksScreen />);
};
const flat = (v: unknown): Record<string, unknown> => Object.assign({}, ...[v].flat(Infinity).filter(Boolean));
const all = (n: HostNode): HostNode[] => [n, ...n.children.flatMap((c) => (typeof c === "string" ? [] : all(c)))];
const textIn = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textIn).join(""));
const parentOf = (r: R, node: HostNode): HostNode => r.all().find((n) => n.children.includes(node))!;
const marks = (r: R) => r.all().filter((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").startsWith("숫자 기준 보기"));
const summaries = (r: R) => r.all().filter((n) => n.props.accessible === true && String(n.props.accessibilityLabel ?? "").startsWith("총 평가금액"));
const allocation = (r: R) => r.all().filter((n) => n.type === "Button" && n.props.accessibilityLabel === "비중 보기");
/** 휴대폰 목록 맨 위 머리(지수 띠 + 계좌 패널) → 계좌 패널 */
const panelOf = (r: R): HostNode => {
  const head = r.all().find((n) => n.type === "ScrollView")!.children[0] as HostNode;
  return head.children[1] as HostNode;
};
/** 누르는 칸 44×44 · 좌우 hitSlop 은 없거나 space.sm / 2 이하 ('비중' 칸 앞 간격과 겹치지 않음) */
const expectTouch = (mark: HostNode) => {
  const s = flat(mark.props.style);
  expect(s.minWidth as number).toBeGreaterThanOrEqual(touch.min);
  expect(s.minHeight as number).toBeGreaterThanOrEqual(touch.min);
  const slop = mark.props.hitSlop as { left?: number; right?: number } | undefined;
  if (slop) {
    expect(slop.left ?? 0).toBeLessThanOrEqual(space.sm / 2);
    expect(slop.right ?? 0).toBeLessThanOrEqual(space.sm / 2);
  }
};
const KPIS = ["평가손익", "수익률", "매입금액", "당일손익"];

describe("끔 — 지금 그대로", () => {
  it.each([[{}], [{ numberBasis: false }]])("플래그 %j: 점·창 없음, 배지 조회 0번, 숫자 네 칸은 요약 문장 묶음 안 (휴대폰 475·넓은 933)", (extra) => {
    h.flags = { allocationView: true, ...extra };
    const r = draw();
    expect(marks(r)).toHaveLength(0);
    expect(r.has("숫자 기준 닫기")).toBe(false);
    expect(h.badgeCalls).toBe(0);
    const [summary] = summaries(r);
    expect(summaries(r)).toHaveLength(1);
    const inside = all(summary!).filter((n) => n.type === "Text").map(textIn);
    for (const k of KPIS) expect(inside).toContain(k);
    expect(r.all().some((n) => n.props.importantForAccessibility === "no-hide-descendants" && all(n).some((c) => textIn(c) === "평가손익"))).toBe(false);

    h.flags = { allocationView: true, foldLayout: true, ...extra };
    size(933, 704);
    const wide = draw();
    expect(marks(wide)).toHaveLength(0);
    expect(h.badgeCalls).toBe(0);
    expect(h.bandProps.length).toBeGreaterThan(0);
    for (const p of h.bandProps) expect(p).not.toHaveProperty("basis");
  });
});

describe("켬 — 폰·접은 화면 475×751", () => {
  it("총액 줄 오른쪽 끝에 점 + '토스와 0.1% 이내' (새 줄 없음), 요약 문장 밖, 누르는 칸 44×44", () => {
    h.flags = { allocationView: true, numberBasis: true };
    const r = draw();
    const found = marks(r);
    expect(found).toHaveLength(1);
    const mark = found[0]!;
    expect(mark.props.accessibilityLabel).toBe(OK_LABEL);
    expect(mark.props.accessibilityRole).toBe("button");
    expect(h.badgeCalls).toBeGreaterThan(0);
    expectTouch(mark);
    expect(mark.props.hitSlop).toBeUndefined();
    // 점(View · 지름 6 · accent) + 글
    const dot = mark.children[0] as HostNode;
    expect(dot.type).toBe("View");
    expect(flat(dot.props.style)).toMatchObject({ width: 6, height: 6, backgroundColor: dark.accent });
    expect(textIn(mark)).toBe("토스와 0.1% 이내");
    // 요약 문장 묶음 밖, 같은 줄의 오른쪽 형제 (총액 줄 = 요약 묶음 | 점)
    const [summary] = summaries(r);
    expect(summaries(r)).toHaveLength(1);
    expect(all(summary!)).not.toContain(mark);
    const row = parentOf(r, mark);
    expect(row.children.indexOf(summary!)).toBe(0);
    expect(row.children.indexOf(mark)).toBeGreaterThan(0);
    expect(flat(row.props.style)).toMatchObject({ flexDirection: "row" });
    expect(textIn(summary!)).toContain("원");
    // 숫자 네 칸은 요약 문장에 이미 있다 → 화면 읽기에서 숨긴 칸으로 (보이는 줄 수·배치는 그대로)
    const panel = panelOf(r);
    const hidden = all(panel).filter((n) => n.props.importantForAccessibility === "no-hide-descendants" && n.props.accessibilityElementsHidden === true);
    expect(hidden.some((n) => KPIS.every((k) => all(n).some((c) => c.type === "Text" && textIn(c) === k)))).toBe(true);
    for (const k of KPIS) expect(String(summary!.props.accessibilityLabel)).toContain(k);
  });

  it("누르면 '숫자 기준' 창 (시세·평가금액·토스 대조 줄), '숫자 기준 닫기'로 닫힘", () => {
    h.flags = { allocationView: true, numberBasis: true };
    const r = draw();
    const sheet = () => r.all().find((n) => n.type === "Modal" && all(n).some((c) => c.props.accessibilityRole === "header" && textIn(c) === "숫자 기준"))!;
    expect(sheet().props.visible).toBe(false);
    r.act(() => (marks(r)[0]!.props.onPress as () => void)());
    expect(sheet().props.visible).toBe(true);
    const rows = all(sheet()).filter((n) => n.props.accessible === true).map((n) => String(n.props.accessibilityLabel));
    expect(rows).toEqual([
      "시세, 국내 3종목 · NXT 포함 · 14:01~14:03, 미국 2종목 · 주간거래 · 14:01",
      "평가금액, 수수료·세금 예상액을 뺀 값 (설정 '수수료·세금 차감 평가' 켬)",
      expect.stringMatching(/^원화 환산, 토스 적용 환율 1,390원/),
      "당일손익, 종목마다 전일 대비 × 수량 (미국 종목은 적용 환율로 원화 환산 — 환율 변동은 넣지 않음)",
      "토스 대조, 차이 -1,234원 (-0.01%) · 9월 28일 (월) 14:00, 같은 종목 17개의 토스 평가금액(수수료·세금 차감)과 비교, 최근 7일 장중(정규장) 42회 중 97.6%가 0.1% 이내, 토스 동기화 때마다 대조합니다 (장중 10분, 장 밖 60분마다)",
    ]);
    expect(textIn(sheet())).toContain("앱이 받은 시세로 계산한 숫자입니다 · 매매 권유가 아닙니다");
    // 닫기 (뒤 바탕·머리 버튼 둘 다 같은 이름표)
    const closes = all(sheet()).filter((n) => n.type === "Pressable" && n.props.accessibilityLabel === "숫자 기준 닫기");
    expect(closes).toHaveLength(2);
    for (const c of closes) expect(c.props.accessibilityRole).toBe("button");
    r.act(() => (closes[1]!.props.onPress as () => void)());
    expect(sheet().props.visible).toBe(false);
    r.act(() => (marks(r)[0]!.props.onPress as () => void)());
    r.act(() => (all(sheet()).filter((n) => n.props.accessibilityLabel === "숫자 기준 닫기")[0]!.props.onPress as () => void)());
    expect(sheet().props.visible).toBe(false);
  });

  it("대조 상태에 따라 점 색·글이 바뀐다 (받기 전 '숫자 기준' · 차이 0.12% 경고색)", () => {
    h.flags = { allocationView: true, numberBasis: true };
    h.badge = undefined;
    let mark = marks(draw())[0]!;
    expect(textIn(mark)).toBe("숫자 기준");
    expect(mark.props.accessibilityLabel).toBe("숫자 기준 보기, 토스 대조 없음");
    expect(flat((mark.children[0] as HostNode).props.style).backgroundColor).toBe(dark.muted);
    h.badge = { ...BADGE_OK, status: { ...BADGE_OK.status!, last: { ...BADGE_OK.status!.last!, diffPct: 0.12 } } };
    mark = marks(draw())[0]!;
    expect(textIn(mark)).toBe("토스와 차이 0.12%");
    expect(flat((mark.children[0] as HostNode).props.style).backgroundColor).toBe(dark.warn);
  });

  it("보유 0(관심만)이면 계좌 패널이 없으므로 점도 없다", () => {
    h.flags = { allocationView: true, numberBasis: true };
    h.stocks = WATCH;
    expect(marks(draw())).toHaveLength(0);
    h.flags = { allocationView: true, numberBasis: true, foldLayout: true };
    size(933, 704);
    expect(marks(draw())).toHaveLength(0);
  });
});

describe("켬 — 넓은 창 계좌 띠", () => {
  it("933×704: 넓은 한 줄 띠는 '비중 보기' 바로 앞 (같은 부모의 앞 형제), 점 + 글", () => {
    h.flags = { allocationView: true, numberBasis: true, foldLayout: true };
    size(933, 704);
    const r = draw();
    expect(h.bandProps.at(-1)).toMatchObject({ oneLine: true, rates: true });
    const [mark] = marks(r);
    expect(marks(r)).toHaveLength(1);
    expect(textIn(mark!)).toBe("토스와 0.1% 이내");
    expectTouch(mark!);
    const line = parentOf(r, mark!);
    const button = allocation(r)[0]!;
    const next = line.children[line.children.indexOf(mark!) + 1] as HostNode;
    expect(all(next)).toContain(button);
    // 요약 문장 묶음 밖
    expect(all(summaries(r)[0]!)).not.toContain(mark);
  });

  it("좁은 한 줄 띠(국내·해외 수익률을 빼는 폭)는 글 없는 점, 누르는 칸은 그대로 44×44 · '비중' 앞", () => {
    h.flags = { allocationView: true, numberBasis: true, foldLayout: true };
    // 창 폭을 줄여 가며 한 줄 띠인데 수익률을 빼는 폭(bandRates 거짓)을 찾는다 (폭 숫자를 박지 않는다)
    let r: R | null = null;
    for (let w = 933; w >= 800 && !r; w -= 4) {
      size(w, 704);
      h.bandProps = [];
      const drawn = draw();
      const p = h.bandProps.at(-1);
      if (p?.oneLine === true && p.rates === false) r = drawn;
    }
    expect(r).not.toBeNull();
    const [mark] = marks(r!);
    expect(marks(r!)).toHaveLength(1);
    expect(textIn(mark!)).toBe("");
    expect(mark!.children.filter((c) => typeof c !== "string" && c.type === "Text")).toHaveLength(0);
    expect(mark!.props.accessibilityLabel).toBe(OK_LABEL);
    expectTouch(mark!);
    const line = parentOf(r!, mark!);
    const next = line.children[line.children.indexOf(mark!) + 1] as HostNode;
    expect(all(next)).toContain(allocation(r!)[0]);
    // '비중' 칸 앞 간격(space.sm)과 누르는 곳이 겹치지 않는다 (점 칸 hitSlop 없음)
    expect(flat(next.props.style).paddingLeft).toBe(space.sm);
    expect(mark!.props.hitSlop).toBeUndefined();
  });
});

describe("켬 + 촘촘 (3-39)", () => {
  it("475×751 촘촘: 점(글 있음)이 촘촘 요약 묶음의 오른쪽 형제, 패널 안 줄 수는 촘촘 그대로", () => {
    h.density = "dense";
    h.flags = { allocationView: true, densityMode: true };
    const before = panelOf(draw()).children.length;
    h.flags = { allocationView: true, densityMode: true, numberBasis: true };
    const r = draw();
    const panel = panelOf(r);
    expect(panel.children.length).toBe(before);
    const [mark] = marks(r);
    expect(marks(r)).toHaveLength(1);
    expect(textIn(mark!)).toBe("토스와 0.1% 이내");
    const row = parentOf(r, mark!);
    const summary = row.children[0] as HostNode;
    expect(summary.props.accessible).toBe(true);
    expect(String(summary.props.accessibilityLabel)).toMatch(/^총 평가금액/);
    // 촘촘 요약 묶음 = 총액 한 줄 + '평가손익 · 당일' 한 줄 (그대로)
    expect(textIn(summary)).toContain("평가손익 ");
    expect(textIn(summary)).toContain(" · 당일 ");
    expect(row.children.indexOf(mark!)).toBeGreaterThan(0);
    // 윗줄(총 평가금액 · 상태)에는 두지 않는다
    const top = panel.children[0] as HostNode;
    expect(all(top)).not.toContain(mark);
    expectTouch(mark!);
  });

  it("704×933 넓은 두 줄 띠 촘촘(첫 줄만): 점이 '비중' 앞", () => {
    h.density = "dense";
    h.flags = { allocationView: true, densityMode: true, numberBasis: true, foldLayout: true };
    size(704, 933);
    const r = draw();
    expect(h.bandProps.at(-1)).toMatchObject({ oneLine: false, dense: true });
    const [mark] = marks(r);
    expect(marks(r)).toHaveLength(1);
    const line = parentOf(r, mark!);
    const next = line.children[line.children.indexOf(mark!) + 1] as HostNode;
    expect(all(next)).toContain(allocation(r)[0]);
  });

  it("704×933 두 줄 띠(기본): 둘째 줄 '비중' 앞", () => {
    h.flags = { allocationView: true, numberBasis: true, foldLayout: true };
    size(704, 933);
    const r = draw();
    expect(h.bandProps.at(-1)).toMatchObject({ oneLine: false });
    const [mark] = marks(r);
    const line = parentOf(r, mark!);
    const next = line.children[line.children.indexOf(mark!) + 1] as HostNode;
    expect(all(next)).toContain(allocation(r)[0]);
    expect(textIn(mark!)).toBe("토스와 0.1% 이내");
  });
});
