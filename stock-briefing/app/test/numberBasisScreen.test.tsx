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
const { BasisMark } = await import("@/components/NumberBasis");
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
  it("토스 계좌 탭과 함께 쓰는 배지는 전체 계좌가 아니라 동일 종목 비교임을 닫힌 상태에서도 알린다", () => {
    h.flags = { tossAccountSnapshot: true };
    h.badge = { ...BADGE_OK, status: { ...BADGE_OK.status!, last: { ...BADGE_OK.status!.last!, n: 19, diffPct: 0.24 } } };
    const r = render(<BasisMark stocks={STOCKS} account={{ afterCost: true } as never} />);
    const mark = marks(r)[0]!;
    expect(textIn(mark)).toBe("동일 종목 차이 0.24%");
    expect(mark.props.accessibilityLabel).toContain("같은 종목 19개 비교");
    h.badge = BADGE_OK;
    r.rerender();
    expect(textIn(marks(r)[0]!)).toBe("동일 종목 0.1% 이내");
  });
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

// ── 큰 글씨면 점만 (3-32 다듬기 · 사용자가 맡긴 결정 A) ─────────────────────────────
// 점 + 글이 줄을 늘리는 자리(촘촘 휴대폰 · 704 두 줄 띠 130% · 넓은 촘촘 띠 130% · 폭 어림이 모자라는 곳)는 점만 — 누르는 칸 44 · 창 · 화면 읽기 문장은 그대로.
// 휴대폰 촘촘은 '평가손익 · 당일' 줄이 점 옆에서 한 줄(어림)일 때만 요약 옆, 아니면 점을 총액 줄 옆에 두고 그 줄은 꺼졌을 때와 같은 폭·같은 글자.
// 높이 비교: 같은 화면을 끄고/켜고 그려, 그려진 글(촘촘 '평가손익 · 당일' 줄 · 점 줄의 띠 칸)의 줄 수를 어림(lib/basisFit)으로 세어 켬 ≤ 끔.
// 켬·끔을 같은 어림으로만 세면 순환 검증이라, 실제 폭이 어림보다 좁은 경우(어림 ÷ 1.061 — 웹 미리보기 실측 · ÷ 1.08)로도 센다.
// 계좌 숫자는 웹 미리보기 가짜 서버와 같은 자릿수 (총 67,050,245원 · 평가손익 +6,627,011원 +10.97% · 당일 +517,450원 · 국내 -17.36% · 해외 $25,583.00 +55.20%),
// 큰 계좌는 수량 20배 (총 13억)
describe("큰 글씨면 점만 (결정 A) — 켜도 줄이 늘지 않는다", async () => {
  const fit = await import("@/lib/basisFit");
  const { font } = await import("@/tokens");
  const AT = "2026-09-28T14:02:00+09:00";
  const web = (q: number): RegisteredWithQuote[] => [
    holding("005930", quote("005930", 314_515, { change: 1_000, changeRate: 0.32, priceBasis: "KRX+NXT 통합", asOf: AT }), 100 * q, 380_584, undefined, "삼성전자"),
    holding("AAPL", quote("AAPL", 255.83, { currency: "USD", change: 3, changeRate: 1.19, fxRate: 1391.5, priceBasis: "주간거래", asOf: AT }), 100 * q, 164.84, { costBasisKrw: 22_364_834 * q, krwCostSource: "exact" }, "애플"),
    ...WATCH,
  ];
  const WEB = web(1);
  const BIG = web(20);
  /** 어림이 실제보다 넓은 정도: 1(어림 그대로) · 웹 미리보기 실측 · 더 좁은 글꼴 */
  const KS = [1, 1.061, 1.08];
  const LINE_RE = /^평가손익 [+−-]?\d/;
  const denseLineOf = (r: R) => r.all().find((n) => n.type === "Text" && LINE_RE.test(textIn(n)))!;
  const panelRoom = (w: number) => w - space.lg * 2;
  /** 촘촘 '평가손익 · 당일' 줄 수 (실제 폭 = 어림 ÷ k) — 점과 같은 줄이면 점 칸만큼 좁다. 이 줄은 켜도 줄이거나 한 줄로 묶지 않는다 */
  const denseLines = (r: R, w: number, fs: number, on: boolean, k = 1) => {
    const node = denseLineOf(r);
    expect(node.props.numberOfLines).toBeUndefined();
    expect(node.props.adjustsFontSizeToFit).toBeUndefined();
    const line = textIn(node);
    const size = (font.small * Math.max(fs, 1)) / k;
    const mark = on ? marks(r)[0]! : null;
    if (!mark || !all(parentOf(r, mark)).includes(node)) return fit.lineCount(line, panelRoom(w), size);
    const markW = textIn(mark) ? space.sm + fit.markTextWidth(fs) : fit.DOT_MARK_W;
    return fit.lineCount(line, panelRoom(w) - markW, size);
  };
  /** 띠 칸 한 칸의 글 (Cell: 이름 Text | 값 Text[값 · ' 원' · ' 등락률']) */
  const cellText = (cell: HostNode): import("@/lib/basisFit").BandCellText => {
    const [label, valueLine] = cell.children as HostNode[];
    const parts = (valueLine!.children as HostNode[]).filter((c) => typeof c !== "string").map((c) => textIn(c).trim());
    const [value, ...rest] = parts;
    return { label: textIn(label!), value: value!, unit: rest.find((p) => p === "원") ?? null, sub: rest.find((p) => p !== "원") ?? null, big: rest.includes("원"), first: !("borderLeftWidth" in flat(cell.props.style)) };
  };
  /** '비중' 버튼 줄의 칸 묶음 */
  const bandBox = (r: R) => {
    const button = allocation(r)[0]!;
    const row = parentOf(r, parentOf(r, button));
    return row.children.find((c) => typeof c !== "string" && c.type === "View" && !all(c).includes(button) && !String(c.props.accessibilityLabel ?? "").startsWith("숫자 기준")) as HostNode;
  };
  /** '비중' 버튼 줄의 칸 줄 수 (실제 폭 = 어림 ÷ k — flexWrap 이면 칸 자연 폭을 차례로 채움, 줄바꿈을 막았으면 1) */
  const bandRows = (r: R, w: number, fs: number, on: boolean, k = 1) => {
    const box = bandBox(r);
    if (flat(box.props.style).flexWrap !== "wrap") return 1;
    const mark = on ? marks(r)[0]! : null;
    const width = w - space.md * 2 - fit.bandActionWidth(fs) - (mark ? (textIn(mark) ? fit.markTextWidth(fs) : fit.DOT_MARK_W) : 0);
    let n = 1;
    let x = 0;
    for (const cell of box.children as HostNode[]) {
      const cw = fit.bandCellWidth(cellText(cell), fs) / k;
      if (x > 0 && x + cw > width) {
        n += 1;
        x = cw;
      } else x += cw;
    }
    return n;
  };
  const drawAt = (w: number, hh: number, fs: number, dense: boolean, on: boolean, stocks = WEB): R => {
    size(w, hh, fs);
    h.density = dense ? "dense" : undefined;
    h.stocks = stocks;
    h.flags = { allocationView: true, foldLayout: true, ...(dense ? { densityMode: true } : {}), ...(on ? { numberBasis: true } : {}) };
    h.bandProps = [];
    return draw();
  };
  /** 점이 총액 줄 옆일 때: 누르는 칸 44 와 총액 글 높이 어림(16 × 배율 × 1.5)의 차이 반만큼 위아래를 거두고, 점 줄은 점만·아래 줄은 누름을 받지 않는다 */
  const expectTucked = (r: R, fs: number) => {
    const row = parentOf(r, marks(r)[0]!);
    const tuck = Math.max(0, (touch.min - font.h2 * fs * fit.TOTAL_LINE) / 2);
    const st = flat(row.props.style);
    if (tuck > 0) expect(st.marginVertical).toBeCloseTo(-tuck, 5);
    else expect(st.marginVertical).toBeUndefined();
    expect(st.pointerEvents).toBe("box-none");
    const line = denseLineOf(r);
    const hidden = r.all().find((n) => n.props.importantForAccessibility === "no-hide-descendants" && all(n).includes(line))!;
    expect(hidden.props.accessibilityElementsHidden).toBe(true);
    expect(flat(hidden.props.style).pointerEvents).toBe("none");
  };

  // [폭, 높이, 글자, 촘촘, 점만, 촘촘 휴대폰 점 자리]
  const CASES: [number, number, number, boolean, boolean, ("group" | "total")?][] = [
    [360, 752, 1, false, false],
    [360, 752, 1.3, false, false],
    [360, 752, 2, false, true],
    [360, 752, 1, true, true, "group"],
    [360, 752, 1.3, true, true, "total"],
    [360, 752, 2, true, true, "total"],
    [475, 751, 1, false, false],
    [475, 751, 1.3, false, false],
    [475, 751, 2, false, false],
    [475, 751, 1, true, false, "group"],
    [475, 751, 1.3, true, true, "group"],
    [475, 751, 2, true, true, "total"],
    [704, 933, 1, false, false],
    [704, 933, 1.3, false, true],
    [704, 933, 2, false, true],
    [704, 933, 1, true, false],
    [704, 933, 1.3, true, true],
    [704, 933, 2, true, true],
    [933, 704, 1, false, false],
    [933, 704, 1.3, false, false],
    [933, 704, 2, false, false],
    [933, 704, 1, true, false],
    [933, 704, 1.3, true, false],
    [933, 704, 2, true, false],
  ];
  it.each(CASES)("%s×%s 글자 %s 촘촘 %s → 점만 %s (%s)", (w, hh, fs, dense, dotOnly, spot) => {
    const off = drawAt(w, hh, fs, dense, false);
    expect(marks(off)).toHaveLength(0);
    const wideBand = w >= 704;
    const oneLine = wideBand && h.bandProps.at(-1)?.oneLine === true;
    const offLines = (k: number) => (wideBand ? (oneLine ? 1 : bandRows(off, w, fs, false, k)) : dense ? denseLines(off, w, fs, false, k) : 1);

    const r = drawAt(w, hh, fs, dense, true);
    const found = marks(r);
    expect(found).toHaveLength(1);
    const mark = found[0]!;
    expect(textIn(mark)).toBe(dotOnly ? "" : "토스와 0.1% 이내");
    // 점만이어도 누르는 칸 44×44 · 화면 읽기는 같은 문장 · 버튼
    expect(mark.props.accessibilityLabel).toBe(OK_LABEL);
    expect(mark.props.accessibilityRole).toBe("button");
    expectTouch(mark);
    expect(mark.props.hitSlop).toBeUndefined();
    // 줄 수: 켬 ≤ 끔 (휴대폰 촘촘은 같음) — 어림 그대로 · 실제 폭이 어림보다 좁을 때(÷ 1.061 · ÷ 1.08) 모두
    for (const k of KS) {
      const onLines = wideBand ? (oneLine ? 1 : bandRows(r, w, fs, true, k)) : dense ? denseLines(r, w, fs, true, k) : 1;
      expect(onLines, `÷${k}`).toBeLessThanOrEqual(offLines(k));
      if (!wideBand && dense) expect(onLines, `÷${k}`).toBe(offLines(k));
    }
    if (!wideBand) {
      const row = parentOf(r, mark);
      // 점만이면 요약과 점 사이를 띄우지 않는다 (점이 44 칸 가운데라 이미 떨어져 보임)
      expect(flat(row.props.style).gap).toBe(dotOnly ? 0 : space.sm);
      if (dense) {
        const line = denseLineOf(r);
        expect(all(row).includes(line)).toBe(spot === "group");
        if (spot === "group") {
          // 요약 옆: 거두지 않는다
          expect(flat(row.props.style).marginVertical).toBeUndefined();
        } else {
          // 총액 줄 옆: 요약 문장은 총액 칸 하나가 읽고, '평가손익 · 당일' 줄은 꺼졌을 때와 같은 폭 · 화면 읽기에서 숨김
          const [summary] = summaries(r);
          expect(all(row)).toContain(summary);
          expect(String(summary!.props.accessibilityLabel)).toContain("평가손익");
          expect(all(summary!)).not.toContain(line);
          expectTucked(r, fs);
        }
      }
    }
    // 누르면 '숫자 기준' 창
    const sheet = () => r.all().find((n) => n.type === "Modal" && all(n).some((c) => c.props.accessibilityRole === "header" && textIn(c) === "숫자 기준"))!;
    r.act(() => (mark.props.onPress as () => void)());
    expect(sheet().props.visible).toBe(true);
  });

  it("점 + 글이었다면 줄이 늘던 자리(475 촘촘 130% · 704 두 줄 띠 130%)는 지금 줄 수 그대로", () => {
    // 475 × 130% 촘촘: 점 + 글 칸 옆이면 '평가손익 · 당일' 줄이 두 줄 → 점만(44)이면 한 줄
    const off = drawAt(475, 751, 1.3, true, false);
    expect(denseLines(off, 475, 1.3, false)).toBe(1);
    const line = textIn(denseLineOf(off));
    expect(fit.lineCount(line, panelRoom(475) - space.sm - fit.markTextWidth(1.3), font.small * 1.3)).toBe(2);
    expect(denseLines(drawAt(475, 751, 1.3, true, true), 475, 1.3, true)).toBe(1);
    // 704 × 130% 두 줄 띠 둘째 줄: 점 + 글이면 '매입금액' 칸이 다음 줄 → 점만이면 한 줄
    const band = drawAt(704, 933, 1.3, false, true);
    expect(bandRows(band, 704, 1.3, true)).toBe(1);
  });

  // 다듬기 1차에서 한 줄이 늘던 자리 (웹 미리보기 검증): 어림으로 센 끈 줄 수 = 점 옆 줄 수라 요약 옆에 두었는데, 실제 끈 줄이 어림보다 적었다
  it.each([
    ["384×854 촘촘 130% (1 → 2줄, +22dp)", 384, 854, 1.3, WEB],
    ["360×752 촘촘 200% · 13억 (2 → 3줄, +35dp)", 360, 752, 2, BIG],
  ])("%s → 점은 총액 줄 옆, '평가손익 · 당일' 줄은 꺼졌을 때와 같은 폭", (_name, w, hh, fs, stocks) => {
    const off = drawAt(w, hh, fs, true, false, stocks);
    const r = drawAt(w, hh, fs, true, true, stocks);
    const mark = marks(r)[0]!;
    expect(textIn(mark)).toBe("");
    expect(all(parentOf(r, mark)).includes(denseLineOf(r))).toBe(false);
    expectTucked(r, fs);
    for (const k of KS) expect(denseLines(r, w, fs, true, k), `÷${k}`).toBe(denseLines(off, w, fs, false, k));
    // 요약 옆(점 44 만큼 좁은 폭)이었다면 웹 미리보기 실측 폭(÷ 1.061)에서 한 줄이 늘었다
    const line = textIn(denseLineOf(r));
    const size = (font.small * fs) / 1.061;
    expect(fit.lineCount(line, panelRoom(w) - fit.DOT_MARK_W, size)).toBe(fit.lineCount(line, panelRoom(w), size) + 1);
  });

  // 다듬기 1차의 회귀 (웹 미리보기 검증): 끄면 칸이 다음 줄로 넘어가는 띠도 켜면 줄바꿈을 막아 칸 글자를 0.82~0.86배로 줄였다
  it.each([
    ["600×960 촘촘 130%", 600, 960, 1.3, true, WEB],
    ["600×960 두 줄 띠 200%", 600, 960, 2, false, WEB],
    ["704×933 촘촘 200% · 13억", 704, 933, 2, true, BIG],
  ])("끄면 줄바꿈하는 띠 %s → 켜도 줄바꿈 그대로 · 점만, 칸 줄 수 켬 = 끔", (_name, w, hh, fs, dense, stocks) => {
    const off = drawAt(w, hh, fs, dense, false, stocks);
    expect(h.bandProps.at(-1)?.oneLine).toBe(false);
    expect(flat(bandBox(off).props.style).flexWrap).toBe("wrap");
    const r = drawAt(w, hh, fs, dense, true, stocks);
    expect(textIn(marks(r)[0]!)).toBe("");
    // 칸 묶음은 끈 것과 같은 줄바꿈 (글자를 줄여 한 줄로 누르지 않는다)
    expect(flat(bandBox(r).props.style).flexWrap).toBe("wrap");
    for (const k of [fit.SLACK, 1.08]) {
      expect(bandRows(off, w, fs, false, k), `÷${k}`).toBe(2);
      expect(bandRows(r, w, fs, true, k), `÷${k}`).toBe(2);
    }
  });

  // 다듬기 2차 첫 캡처에서 찾은 것: '비중' 버튼 어림이 넓어 끄고 한 줄인 띠(웹 63dp)를 두 줄로 보고 줄바꿈을 두면 켜서 두 줄(124dp)
  it("끄고 한 줄에 거의 맞는 띠 673×841 촘촘 200% → 줄바꿈을 막아 켜도 한 줄", () => {
    const off = drawAt(673, 841, 2, true, false);
    expect(h.bandProps.at(-1)?.oneLine).toBe(false);
    const r = drawAt(673, 841, 2, true, true);
    expect(textIn(marks(r)[0]!)).toBe("");
    expect(flat(bandBox(r).props.style).flexWrap).toBeUndefined();
    expect(bandRows(r, 673, 2, true)).toBe(1);
    // 실제 폭이 어림보다 조금 좁으면(÷ 1.08) 끈 띠도 한 줄
    expect(bandRows(off, 673, 2, false, 1.08)).toBe(1);
  });
});
