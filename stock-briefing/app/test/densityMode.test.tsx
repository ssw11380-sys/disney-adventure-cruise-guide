import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 잔고 촘촘 모드 (3-39 PR 1, 기능 플래그 densityMode + 설정 '잔고 표시 촘촘' — 잔고 화면).
 *  - 끔(서버 플래그 없음 = 앱 fallback 꺼짐): 저장된 값이 '촘촘'이어도 지금 화면 그대로
 *  - 켬 + 기본: 끔과 한 글자도 같은 나무
 *  - 켬 + 촘촘: 지수 띠 두 줄 칸 · 계좌 요약 세 줄 · 구역 머리 44(보유에 비중 버튼, 누르는 곳이 머리 안) · 종목 줄 dense,
 *    넓은 창은 계좌 띠에만 dense (표 줄은 그대로). 화면 읽기 문장은 기본과 같다
 * 부품(StockRow·MarketStrip·AccountBand)은 이름만 있는 가짜 — 받은 속성으로 본다. 시각은 고정(useFeedState 가짜)
 */
const NOW = Date.parse("2026-09-28T10:30:00+09:00");
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean | undefined>,
  density: undefined as string | undefined,
  stocks: undefined as unknown,
  setSort: vi.fn(),
  push: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Modal: "Modal",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {} },
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
  SORT_OPTIONS: [
    { value: "created", label: "등록순" },
    { value: "changeRate", label: "등락률" },
  ],
  useSettings: () => ({ afterCost: false, showKrw: false, sort: "created", setSort: h.setSort, density: h.density }),
}));
vi.mock("@/api/hooks", () => ({
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useStocks: () => ({ data: h.stocks, isError: false, error: null, refetch: async () => undefined, dataUpdatedAt: 1 }),
  useHealth: () => ({ data: undefined }),
  useAnyMarketOpen: () => ({ open: false, label: "장 마감" }),
  useStockMutations: () => ({ remove: { mutate: vi.fn() } }),
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
vi.mock("@/components/AccountBand", async (orig) => ({ ...(await orig<typeof import("@/components/AccountBand")>()), AccountBand: "AccountBand" }));

const { default: StocksScreen } = await import("@/app/(tabs)/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { forgetHoldingsAnchor } = await import("@/lib/holdingsAnchor");
const { space, touch, font } = await import("@/tokens");

// ── 가짜 종목: 보유 15 (국내 10 · 미국 5) · 관심 3 ──
// 국내 i=1..10: 현재가 10,000·i, 10주, 평단 9,000·i, 전일 대비 +100·i → 평가 5,500,000 · 매입 4,950,000 · 당일 +55,000
// 미국 j=1..5: 현재가 $100·j, 10주, 평단 $90·j(원화 매입 1,170,000·j — 매수 당시 환율 1,300), 전일 대비 +$1·j, 환율 1,400
//   → 평가 21,000,000 · 매입 17,550,000 · 당일 +210,000
// 합계: 평가 26,500,000 · 매입 22,500,000 → 평가손익 +4,000,000 (+17.78%), 당일 +265,000
const FX = 1400;
const KR = Array.from({ length: 10 }, (_, k) => {
  const i = k + 1;
  const code = String(100_000 + i).padStart(6, "0");
  return holding(code, quote(code, 10_000 * i, { change: 100 * i, changeRate: 1 }), 10, 9_000 * i, undefined, `국내${i}`);
});
const US = Array.from({ length: 5 }, (_, k) => {
  const j = k + 1;
  const code = `US${j}`;
  return holding(code, quote(code, 100 * j, { currency: "USD", change: j, changeRate: 1, fxRate: FX }), 10, 90 * j, { costBasisKrw: 1_170_000 * j, krwCostSource: "exact" }, `미국${j}`);
});
const WATCH = [
  holding("200001", quote("200001", 50_000, { change: -500, changeRate: -0.99 }), null, null, undefined, "관심1"),
  holding("200002", quote("200002", 7_000, { change: 70, changeRate: 1.01 }), null, null, undefined, "관심2"),
  holding("WATCH3", quote("WATCH3", 12.5, { currency: "USD", change: 0.25, changeRate: 2.04, fxRate: FX }), null, null, undefined, "관심3"),
];
const STOCKS: RegisteredWithQuote[] = [...KR, ...US, ...WATCH];
/** 계좌 셋째 줄 (위 가짜 종목으로 직접 계산한 값) */
const THIRD = "평가손익 +4,000,000원 +17.78% · 당일 +265,000원";
/** 1억 넘는 손익: 평단 1억 · 현재가 223,456,789 · 1주 → +123,456,789원 (+123.46%), 당일 +1,000,000 */
const BIG = [holding("300001", quote("300001", 223_456_789, { change: 1_000_000, changeRate: 0.45 }), 1, 100_000_000, undefined, "큰종목")];
const BIG_THIRD = "평가손익 +123,456,789원 +123.46% · 당일 +1,000,000원";

const SIZES = { "접은 475×751": [475, 751], "펼친 세로 704×933": [704, 933], "펼친 가로 933×704": [933, 704] } as const;

beforeEach(() => {
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { allocationView: true };
  h.density = undefined;
  h.stocks = STOCKS;
  h.setSort.mockReset();
  h.push.mockReset();
});

type R = ReturnType<typeof render>;
const size = (w: number, hh: number, fontScale = 1) => {
  h.win = { width: w, height: hh, scale: 2.625, fontScale };
};
const draw = (): R => {
  // 창 크기 등급·이어 보기 기억을 비우고 그린다 (그리기마다 같은 출발점)
  forgetWindowClass();
  forgetHoldingsAnchor();
  return render(<StocksScreen />);
};
/** 함수 속성을 뺀 트리 글 (두 화면이 한 글자도 같은지) */
const treeText = (tree: unknown) => JSON.stringify(tree, (k, v) => (typeof v === "function" ? undefined : v));
const byType = (r: R, type: string): HostNode[] => r.all().filter((n) => n.type === type);
const flat = (v: unknown): Record<string, unknown> => Object.assign({}, ...[v].flat(Infinity).filter(Boolean));
const all = (n: HostNode): HostNode[] => [n, ...n.children.flatMap((c) => (typeof c === "string" ? [] : all(c)))];
const textIn = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textIn).join(""));
const parentOf = (r: R, node: HostNode): HostNode => r.all().find((n) => n.children.includes(node))!;
/** 휴대폰 목록 맨 위 머리(지수 띠 + 계좌 패널) → 계좌 패널 */
const panelOf = (r: R): HostNode => {
  const head = byType(r, "ScrollView")[0]!.children[0] as HostNode;
  expect((head.children[0] as HostNode).type).toBe("MarketStrip");
  return head.children[1] as HostNode;
};
/** 구역 머리 줄 (제목 글자의 부모) — 보유 · 관심 */
const sectionBars = (r: R): HostNode[] =>
  r
    .all()
    .filter((n) => n.type === "Text" && n.props.accessibilityRole === "header" && /^(보유|관심) \d+$/.test(textIn(n)))
    .map((title) => parentOf(r, title));
const allocationPressables = (r: R) => r.all().filter((n) => n.type === "Pressable" && n.props.accessibilityLabel === "비중 보기");
const allocationButtons = (r: R) => byType(r, "Button").filter((n) => n.props.accessibilityLabel === "비중 보기");
const sortButtons = (r: R) => r.all().filter((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").startsWith("정렬 바꾸기"));
/** 계좌 요약 한 문장 (accessible 묶음) */
const summaryLabel = (panel: HostNode) => {
  const hits = all(panel).filter((n) => n.props.accessible === true && String(n.props.accessibilityLabel ?? "").startsWith("총 평가금액"));
  expect(hits).toHaveLength(1);
  return String(hits[0]!.props.accessibilityLabel);
};
/** 계좌 셋째 줄 ('평가손익 … · 당일 …' 로 시작하는 바깥 글자) */
const thirdLine = (panel: HostNode) => {
  const hits = all(panel).filter((n) => n.type === "Text" && textIn(n).startsWith("평가손익 "));
  expect(hits).toHaveLength(1);
  return hits[0]!;
};

/** '끔' 모양 확인 (새 함수·상수를 부르지 않는다 — 3-39 이전 main 에서도 돈다) */
const expectBasicPhone = (r: R) => {
  const strips = byType(r, "MarketStrip");
  expect(strips).toHaveLength(1);
  expect(strips[0]!.props).not.toHaveProperty("dense");
  const rows = byType(r, "StockRow");
  expect(rows).toHaveLength(18);
  for (const row of rows) expect(row.props).not.toHaveProperty("dense");
  const panel = panelOf(r);
  const text = textIn(panel);
  for (const s of ["매입금액", "국내", "해외", "토스 적용 환율"]) expect(text).toContain(s);
  // 비중 버튼: 계좌 패널 안 Button, 구역 머리에는 없음
  const buttons = allocationButtons(r);
  expect(buttons).toHaveLength(1);
  expect(all(panel)).toContain(buttons[0]);
  expect(allocationPressables(r)).toHaveLength(0);
  // 구역 머리: 위 여백 12, 정렬 버튼 hitSlop 은 지금 값 (위 14 · 아래 6 · 좌우 8)
  const bars = sectionBars(r);
  expect(bars).toHaveLength(2);
  for (const bar of bars) expect(flat(bar.props.style)).toMatchObject({ paddingTop: space.md });
  const sorts = sortButtons(r);
  expect(sorts).toHaveLength(2);
  for (const s of sorts) expect(s.props.hitSlop).toEqual({ top: 14, bottom: space.s, left: space.sm, right: space.sm });
  return { panel };
};

describe("끔 — 지금 그대로", () => {
  it("1. 플래그 없음 + 저장값 '촘촘' (475×751): 지수 띠·줄에 dense 없음, 계좌 패널 전체(매입금액·국내·해외·환율 안내·비중 버튼), 구역 머리 지금 모양", () => {
    h.density = "dense";
    expectBasicPhone(draw());
  });

  it("1-1. 접은 화면 창(foldLayout 켬)이어도 같다", () => {
    h.density = "dense";
    h.flags = { allocationView: true, foldLayout: true };
    expectBasicPhone(draw());
  });

  it("2. 넓은 창 704×933 (foldLayout 켬) + 저장값 '촘촘': 계좌 띠에 dense 없음, 표 줄에도 없음", () => {
    h.density = "dense";
    h.flags = { allocationView: true, foldLayout: true };
    size(704, 933);
    const r = draw();
    const band = byType(r, "AccountBand");
    expect(band).toHaveLength(1);
    expect(band[0]!.props.oneLine).toBe(false);
    expect(band[0]!.props).not.toHaveProperty("dense");
    for (const row of byType(r, "StockRow")) {
      expect(row.props.columns).toBeTruthy();
      expect(row.props).not.toHaveProperty("dense");
    }
  });
});

describe("켬", () => {
  it("3. 켬 + '기본': 끔과 같은 결과, 트리 글이 끔(저장값 '촘촘')과 한 글자도 같다 — 475×751 · 704×933 · 933×704", () => {
    // 휴대폰(foldLayout 꺼짐)
    h.density = "dense";
    h.flags = { allocationView: true };
    const off = treeText(draw().tree);
    h.density = "basic";
    h.flags = { allocationView: true, densityMode: true };
    const on = draw();
    expectBasicPhone(on);
    expect(treeText(on.tree)).toBe(off);
    // 접은 화면 · 펼친 세로 · 펼친 가로 (foldLayout 켬)
    for (const [w, hh] of Object.values(SIZES)) {
      size(w, hh);
      h.density = "dense";
      h.flags = { allocationView: true, foldLayout: true };
      const offTree = treeText(draw().tree);
      h.density = "basic";
      h.flags = { allocationView: true, foldLayout: true, densityMode: true };
      expect(treeText(draw().tree), `${w}×${hh}`).toBe(offTree);
    }
    // 저장값이 없으면(처음) 기본
    h.density = undefined;
    h.flags = { allocationView: true, densityMode: true };
    size(475, 751);
    expect(treeText(draw().tree)).toBe(off);
  });

  it("4. 켬 + '촘촘' (475×751): 지수 띠·모든 줄 dense, 계좌 세 줄, 보유 구역 머리에 비중 버튼, 머리 높이 44 안에 누르는 곳", () => {
    h.density = "basic";
    const basicLabel = summaryLabel(panelOf(draw()));
    h.density = "dense";
    h.flags = { allocationView: true, densityMode: true };
    const r = draw();
    // 지수 띠 두 줄 칸, 보유·관심 줄 모두 dense
    expect(byType(r, "MarketStrip")[0]!.props).toEqual({ dense: true });
    const rows = byType(r, "StockRow");
    expect(rows).toHaveLength(18);
    for (const row of rows) {
      expect(row.props.dense).toBe(true);
      expect(row.props).not.toHaveProperty("columns");
    }
    // 계좌 패널: 윗줄('총 평가금액' + 상태) · 총액 · 셋째 줄
    const panel = panelOf(r);
    const text = textIn(panel);
    expect(text).toContain("총 평가금액");
    expect(all(panel).some((n) => n.type === "LiveStatus")).toBe(true);
    const total = all(panel).find((n) => n.type === "Text" && textIn(n) === "26,500,000 원")!;
    expect(total).toBeTruthy();
    expect(flat(total.props.style)).toMatchObject({ fontSize: font.h2, fontWeight: "800" });
    expect(textIn(thirdLine(panel))).toBe(THIRD);
    for (const s of ["매입금액", "국내", "해외", "토스 적용 환율"]) expect(text).not.toContain(s);
    expect(allocationButtons(r)).toHaveLength(0);
    // 화면 읽기 문장은 기본과 같다 (숨긴 매입금액·국내·해외도 문장에는 남음)
    expect(summaryLabel(panel)).toBe(basicLabel);
    expect(basicLabel).toContain("매입금액");
    // 구역 머리: 보유에만 비중 버튼, 정렬 버튼 앞
    const [held, watch] = sectionBars(r);
    expect(textIn(held!)).toContain("보유 15");
    expect(textIn(watch!)).toContain("관심 3");
    const alloc = allocationPressables(r);
    expect(alloc).toHaveLength(1);
    expect(alloc[0]!.props.accessibilityRole).toBe("button");
    expect(all(held!)).toContain(alloc[0]);
    expect(all(watch!).some((n) => n.props.accessibilityLabel === "비중 보기")).toBe(false);
    const heldPress = all(held!).filter((n) => n.type === "Pressable");
    expect(heldPress.map((n) => n.props.accessibilityLabel)).toEqual(["비중 보기", "정렬 바꾸기, 지금 등록순"]);
    (alloc[0]!.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/portfolio/allocation");
    // 누르는 크기: 머리 줄 최소 높이 44 · 위아래 여백 없음, 두 버튼 보이는 높이 44 · 위아래 hitSlop 0 → 누르는 곳이 머리 안
    for (const bar of [held!, watch!]) {
      const s = flat(bar.props.style);
      expect(s.minHeight).toBe(touch.min);
      expect(s.paddingTop ?? 0).toBe(0);
      expect(s.paddingBottom ?? 0).toBe(0);
      expect(s.paddingVertical ?? 0).toBe(0);
    }
    for (const p of [...heldPress, ...all(watch!).filter((n) => n.type === "Pressable")]) {
      const s = flat(p.props.style);
      const slop = p.props.hitSlop as { top: number; bottom: number; left: number; right: number };
      expect(s.minHeight).toBe(touch.min);
      expect(slop.top).toBe(0);
      expect(slop.bottom).toBe(0);
      // 좌우 hitSlop 합이 두 버튼 사이 간격 이하 (서로 겹치지 않음)
      const end = flat(parentOf(r, p).props.style);
      expect(slop.left + slop.right).toBeLessThanOrEqual(end.gap as number);
    }
  });

  it("5. 켬 + '촘촘' + 비중 보기(allocationView) 꺼짐: 비중 버튼이 어디에도 없다", () => {
    h.density = "dense";
    h.flags = { densityMode: true };
    const r = draw();
    expect(allocationPressables(r)).toHaveLength(0);
    expect(allocationButtons(r)).toHaveLength(0);
    expect(r.all().some((n) => n.props.accessibilityLabel === "비중 보기")).toBe(false);
  });

  it.each([1.3, 2])("6. 켬 + '촘촘' + 글자 %s배: 셋째 줄은 말줄임 없이 (1억 넘는 손익도)", (scale) => {
    h.density = "dense";
    h.flags = { allocationView: true, densityMode: true };
    size(475, 751, scale);
    for (const [list, expected] of [
      [STOCKS, THIRD],
      [BIG, BIG_THIRD],
    ] as const) {
      h.stocks = list;
      const line = thirdLine(panelOf(draw()));
      expect(textIn(line)).toBe(expected);
      for (const k of ["numberOfLines", "ellipsizeMode", "adjustsFontSizeToFit"]) expect(line.props).not.toHaveProperty(k);
    }
  });

  it.each([
    [704, 933],
    [933, 704],
  ])("7. 넓은 창 %s×%s + '촘촘': 계좌 띠에 dense, 표 줄은 columns 그대로이고 dense 없음", (w, hh) => {
    h.density = "dense";
    h.flags = { allocationView: true, foldLayout: true, densityMode: true };
    size(w, hh);
    const r = draw();
    const band = byType(r, "AccountBand");
    expect(band).toHaveLength(1);
    expect(band[0]!.props.dense).toBe(true);
    expect(band[0]!.props.oneLine).toBe(w === 933);
    const rows = byType(r, "StockRow");
    expect(rows).toHaveLength(18);
    for (const row of rows) {
      expect(row.props.columns).toBeTruthy();
      expect(row.props).not.toHaveProperty("dense");
    }
    // 넓은 창 맨 위 띠는 지금처럼 dense(+ 시장 상태·검색) — 휴대폰 띠는 없음
    const strips = byType(r, "MarketStrip");
    expect(strips).toHaveLength(1);
    expect(strips[0]!.props.dense).toBe(true);
    expect(strips[0]!.props.trailing).toBeTruthy();
  });

  it("불러오는 중(뼈대) 화면의 지수 띠도 두 줄 칸 — 꺼져 있으면 지금 그대로", () => {
    h.stocks = undefined;
    h.density = "dense";
    expect(byType(draw(), "MarketStrip")[0]!.props).toEqual({});
    h.flags = { allocationView: true, densityMode: true };
    expect(byType(draw(), "MarketStrip")[0]!.props).toEqual({ dense: true });
  });

  it("합계 제외 경고 줄(주황)은 촘촘에서도 보인다", () => {
    h.density = "dense";
    h.flags = { allocationView: true, densityMode: true };
    // 평단 없는 보유 1종목 → 합계에서 빠짐
    h.stocks = [...STOCKS, holding("400001", quote("400001", 1_000), 3, null, undefined, "평단없음")];
    const panel = panelOf(draw());
    expect(textIn(panel)).toContain("제외");
    expect(textIn(thirdLine(panel))).toBe(THIRD);
  });
});
