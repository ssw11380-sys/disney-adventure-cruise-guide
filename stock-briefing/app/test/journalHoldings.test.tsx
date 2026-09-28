import { createHash } from "node:crypto";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 매매일지 입구 — 잔고 탭 (3-37, 기능 플래그 tradeJournal · tradeRecords 둘 다 켜져 있을 때만).
 *  - 끔: 트리가 지금과 한 글자도 같다 (바꾸기 전 main 코드에서 뜬 지문)
 *  - 기본 모양: 계좌 패널의 '비중' 줄에 [매매일지]를 비중 앞에 (새 줄 없음). 비중이 꺼져 있으면 매매일지 버튼만으로 그 줄이 생김
 *  - 촘촘(3-39): 보유 구역 머리의 '비중' 앞에 아이콘만 44×44 · 넓은 계좌 띠: '비중' 뒤에 아이콘만 44×44
 * 부품(StockRow·MarketStrip·LiveStatus)은 이름만 있는 가짜. 시각은 고정
 */
const NOW = Date.parse("2026-09-28T14:03:30+09:00");
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean | undefined>,
  density: undefined as string | undefined,
  stocks: undefined as unknown,
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
  useReconcileBadge: () => ({ data: undefined }),
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

const { default: StocksScreen } = await import("@/app/(tabs)/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { forgetHoldingsAnchor } = await import("@/lib/holdingsAnchor");

const FX = 1_390;
const KR = [1, 2, 3].map((i) => holding(`10000${i}`, quote(`10000${i}`, 10_000 * i, { change: 100, changeRate: 1, priceBasis: "KRX+NXT 통합", asOf: `2026-09-28T14:0${i}:00+09:00` }), 10, 9_000 * i, undefined, `국내${i}`));
const US = [1, 2].map((j) =>
  holding(`US${j}`, quote(`US${j}`, 100 * j, { currency: "USD", change: 1, changeRate: 1, fxRate: FX, priceBasis: "주간거래", asOf: "2026-09-28T14:01:00+09:00" }), 10, 90 * j, { costBasisKrw: 1_200_000 * j, krwCostSource: "exact" }, `미국${j}`),
);
const WATCH = [holding("200001", quote("200001", 50_000, { priceBasis: "KRX+NXT 통합" }), null, null, undefined, "관심1")];
const STOCKS: RegisteredWithQuote[] = [...KR, ...US, ...WATCH];

beforeEach(() => {
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = {};
  h.density = undefined;
  h.stocks = STOCKS;
  h.push.mockReset();
});

type R = ReturnType<typeof render>;
const draw = (w: number, hh: number, flags: Record<string, boolean>, opts: { dense?: boolean; fontScale?: number } = {}): R => {
  h.win = { width: w, height: hh, scale: 2.625, fontScale: opts.fontScale ?? 1 };
  h.flags = flags;
  h.density = opts.dense ? "dense" : undefined;
  forgetWindowClass();
  forgetHoldingsAnchor();
  return render(<StocksScreen />);
};

/** 결과 트리를 비교할 수 있는 값으로 (tossOpen 과 같은 방식): 함수는 '[fn]', 속성으로 넘긴 요소는 이름과 속성만 */
function ser(v: unknown): unknown {
  if (typeof v === "function") return "[fn]";
  if (React.isValidElement(v)) {
    const e = v as React.ReactElement<Record<string, unknown>>;
    const name = typeof e.type === "string" ? e.type : ((e.type as { name?: string }).name ?? "?");
    return { el: name, key: e.key, props: ser(e.props) };
  }
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)]));
  return v;
}
const tree = (nodes: (HostNode | string)[]): unknown =>
  nodes.map((n) => {
    if (typeof n === "string") return n;
    const { children: _c, ...props } = n.props;
    return { type: n.type, props: ser(props), children: tree(n.children) };
  });
const print = (r: R) => createHash("sha1").update(JSON.stringify(tree(r.tree))).digest("hex");

/** 배치: [이름, 폭, 높이, 플래그, 촘촘, 글자] */
const LAYOUTS = [
  ["폰 475 기본 · 비중 켬", 475, 751, { allocationView: true }, false, 1],
  ["폰 360 기본 · 비중 끔", 360, 752, {}, false, 1],
  ["폰 360 기본 200%", 360, 752, { allocationView: true }, false, 2],
  ["폰 475 촘촘", 475, 751, { allocationView: true, densityMode: true }, true, 1],
  ["넓은 933×704 한 줄 띠", 933, 704, { allocationView: true, foldLayout: true }, false, 1],
  ["넓은 704×933 두 줄 띠", 704, 933, { allocationView: true, foldLayout: true }, false, 1],
  ["넓은 704×933 촘촘 띠", 704, 933, { allocationView: true, foldLayout: true, densityMode: true }, true, 1],
] as const;

/** 바꾸기 전 main(2793cd1) 코드에서 뜬 지문 — 매매일지를 끄면(두 플래그 중 하나라도) 이 값과 같아야 한다 */
const BASE: Record<string, string> = {
  "폰 475 기본 · 비중 켬": "e7da3785151c8c2974a0e33cf777a3325320a4fe",
  "폰 360 기본 · 비중 끔": "734b30123e11b18a7927121b77ac794074645783",
  "폰 360 기본 200%": "e7da3785151c8c2974a0e33cf777a3325320a4fe",
  "폰 475 촘촘": "51d9456ba8fbd6c01956db53c23b1239d3cf278d",
  "넓은 933×704 한 줄 띠": "c68cda32886efd278ce656de9f1a66175f42c09a",
  "넓은 704×933 두 줄 띠": "4d0c83426ec31656679c3f782d1368d5e818232e",
  "넓은 704×933 촘촘 띠": "f081f5a5373c479d90bac465c807c043f8bc2506",
};

describe("매매일지 입구를 끄면 잔고 탭이 지금과 같다 (지문)", () => {
  for (const [name, w, hh, flags, dense, fs] of LAYOUTS) {
    it(name, () => {
      const off = print(draw(w, hh, { ...flags }, { dense, fontScale: fs }));
      const halfOn = print(draw(w, hh, { ...flags, tradeJournal: true }, { dense, fontScale: fs }));
      const recordsOnly = print(draw(w, hh, { ...flags, tradeRecords: true }, { dense, fontScale: fs }));
      // eslint-disable-next-line no-console
      if (!BASE[name]) console.log(`BASE ${JSON.stringify(name)}: ${JSON.stringify(off)},`);
      expect(off).toBe(BASE[name]);
      expect(halfOn).toBe(off);
      expect(recordsOnly).toBe(off);
    });
  }
});

const ON = { tradeJournal: true, tradeRecords: true };
const OPEN = "매매일지 열기";
const parentOf = (r: R, node: HostNode): HostNode => r.all().find((n) => n.children.includes(node))!;
const flat = (v: unknown): Record<string, unknown> => Object.assign({}, ...[v].flat(Infinity).filter(Boolean));
const count = (r: R, type: string, label: string) => r.all().filter((n) => n.type === type && n.props.accessibilityLabel === label).length;

describe("켜면: 입구 자리 (§4.1 ②)", () => {
  it("폰 기본: 계좌 패널 '비중' 줄에 [매매일지]를 비중 앞에 — 새 줄 없음, 누르면 /journal", () => {
    const off = draw(475, 751, { allocationView: true });
    const on = draw(475, 751, { allocationView: true, ...ON });
    const btn = on.all().find((n) => n.type === "Button" && n.props.accessibilityLabel === OPEN)!;
    expect(btn.props).toMatchObject({ title: "매매일지", icon: "book-outline", variant: "secondary", compact: true });
    const row = parentOf(on, btn);
    const kids = row.children.filter((c): c is HostNode => typeof c !== "string");
    expect(kids.map((k) => k.props.accessibilityLabel)).toEqual([OPEN, "비중 보기"]);
    expect(flat(row.props.style)).toMatchObject({ flexDirection: "row", justifyContent: "flex-end" });
    // 줄 수는 그대로: 버튼 줄(View) 개수가 켜기 전과 같다
    const rows = (r: R) => r.all().filter((n) => n.type === "View" && n.children.some((c) => typeof c !== "string" && c.type === "Button" && c.props.accessibilityLabel === "비중 보기")).length;
    expect(rows(on)).toBe(rows(off));
    on.act(() => (btn.props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/journal");
  });

  it("비중이 꺼져 있으면 매매일지 버튼만으로 그 줄이 생긴다 (켰을 때만의 변화)", () => {
    const on = draw(360, 752, { ...ON });
    const btn = on.all().find((n) => n.type === "Button" && n.props.accessibilityLabel === OPEN)!;
    expect(parentOf(on, btn).children.filter((c) => typeof c !== "string")).toHaveLength(1);
    expect(count(on, "Button", "비중 보기")).toBe(0);
  });

  it("촘촘: 보유 구역 머리의 '비중' 앞에 아이콘만 44×44 (hitSlop 없음), 계좌 패널에는 버튼 없음", () => {
    const on = draw(475, 751, { allocationView: true, densityMode: true, ...ON }, { dense: true });
    expect(count(on, "Button", OPEN)).toBe(0);
    const icons = on.all().filter((n) => n.type === "Pressable" && n.props.accessibilityLabel === OPEN);
    expect(icons).toHaveLength(1);
    expect(flat(icons[0]!.props.style instanceof Function ? (icons[0]!.props.style as (s: { pressed: boolean }) => unknown)({ pressed: false }) : icons[0]!.props.style)).toMatchObject({ width: 44, minHeight: 44 });
    expect(icons[0]!.props.hitSlop).toBeUndefined();
    const bar = parentOf(on, icons[0]!);
    const labels = bar.children.filter((c): c is HostNode => typeof c !== "string").map((c) => c.props.accessibilityLabel);
    expect(labels.indexOf(OPEN)).toBeLessThan(labels.indexOf("비중 보기"));
  });

  /** 계좌 띠 (넓은 창 목록 맨 위 머리) — 비중 버튼이 든 줄 */
  const bandRow = (r: R) => {
    const b = r.all().find((n) => n.type === "Button" && n.props.accessibilityLabel === "비중 보기")!;
    return parentOf(r, parentOf(r, b));
  };
  const iconIn = (r: R, row: HostNode) => r.all(row.children).filter((n) => n.type === "Pressable" && n.props.accessibilityLabel === OPEN);

  it("넓은 창 933×704 한 줄 띠: '비중' 뒤에 아이콘만 44×44 (한 줄 띠는 칸이 줄바꿈하지 않는다) · 칸 묶음 속성 그대로", () => {
    const flags = { allocationView: true, foldLayout: true };
    const off = draw(933, 704, flags);
    const on = draw(933, 704, { ...flags, ...ON });
    const rowOn = bandRow(on);
    const kids = rowOn.children.filter((c): c is HostNode => typeof c !== "string");
    // [칸 묶음, 비중, 매매일지]
    expect(kids.length).toBe(bandRow(off).children.filter((c) => typeof c !== "string").length + 1);
    const icons = iconIn(on, rowOn);
    expect(icons).toHaveLength(1);
    expect(flat((icons[0]!.props.style as (s: { pressed: boolean }) => unknown)({ pressed: false }))).toMatchObject({ width: 44, minHeight: 44 });
    expect(icons[0]!.props.hitSlop).toBeUndefined();
    expect(JSON.stringify(kids[0]!.props.style)).toBe(JSON.stringify((bandRow(off).children[0] as HostNode).props.style));
    // 넓은 창에는 계좌 패널 버튼이 없다
    expect(count(on, "Button", OPEN)).toBe(0);
    on.act(() => (icons[0]!.props.onPress as () => void)());
    expect(h.push).toHaveBeenLastCalledWith("/journal");
  });

  it("넓은 창 두 줄·촘촘 띠: 칸 묶음이 아이콘과 한 줄에 들 때만 (어림 bandJournalFits) — 안 들면 그 띠에는 두지 않는다", async () => {
    const { bandJournalFits } = await import("@/lib/basisFit");
    const cells = [
      { label: "국내", value: "60,000", sub: "+11.11%", first: true },
      { label: "해외 · 환율 1,390", value: "$300.00", sub: "+11.11%" },
      { label: "매입금액", value: "3,834,000원" },
    ];
    const at = (width: number, fontScale: number) => bandJournalFits({ width, pad: 14, fontScale, cells, action: true, mark: null });
    // 칸 글자는 표 줄과 같은 상한(1.4배)이라 704 는 200% 에서도 든다. 좁은 띠(520)는 130% 부터 들지 않는다
    expect(at(704, 1)).toBe(true);
    expect(at(704, 2)).toBe(true);
    expect(at(600, 1.5)).toBe(false);
    expect(at(520, 1.3)).toBe(false);
    // 점(숫자 기준)이 글과 함께 있으면 그만큼 좁아진다
    expect(bandJournalFits({ width: 520, pad: 14, fontScale: 1, cells, action: true, mark: "text" })).toBe(false);
    for (const [extra, dense] of [
      [{}, false],
      [{ densityMode: true }, true],
    ] as const) {
      for (const fs of [1, 1.3, 2]) {
        const flags = { allocationView: true, foldLayout: true, ...extra };
        const off = draw(704, 933, flags, { dense, fontScale: fs });
        const on = draw(704, 933, { ...flags, ...ON }, { dense, fontScale: fs });
        const icons = iconIn(on, bandRow(on));
        // 칸 묶음의 줄바꿈 속성은 켜기 전과 같다 (아이콘이 칸 글자를 줄이거나 줄을 막지 않는다)
        const cellsStyle = (r: R) => JSON.stringify((bandRow(r).children[0] as HostNode).props.style);
        expect(cellsStyle(on)).toBe(cellsStyle(off));
        expect(icons.length <= 1).toBe(true);
      }
    }
  });
});
