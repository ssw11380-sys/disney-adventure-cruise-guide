import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketSummary, MarketSummaryData } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 시장 전체 요약 화면 (플래그 marketSummary): 브리핑 탭 맨 위 카드(접은 화면), 넓은 창 목록 맨 위 줄 → 오른쪽 칸 상세, 상세 화면.
 *  - 플래그가 꺼져 있으면(앱 기본) 카드가 없고 목록·상세를 요청하지 않는다
 *  - '밤사이/오늘'은 볼 때 날짜로 (useNow 를 고정 시각으로 바꿔 본다)
 * RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 679, scale: 2.625, fontScale: 1 },
  fontScale: 1,
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-28T08:31:00+09:00"),
  params: { id: "7" } as { id?: string },
  push: vi.fn(),
  openURL: vi.fn(),
  list: [] as unknown[],
  detail: null as unknown,
  listEnabled: [] as boolean[],
  detailEnabled: [] as boolean[],
  store: new Map<string, string>(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Linking: { openURL: h.openURL },
  Platform: { OS: "android" },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, Tabs: { Screen: "TabsScreen" }, useLocalSearchParams: () => h.params }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.fontScale, 1), cap) };
});
vi.mock("@/lib/useNow", () => ({ useNow: () => h.now }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/Freshness", () => ({ StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/BriefingSources", () => ({ BriefingSources: "BriefingSources" }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", Empty: "Empty", ErrorView: "ErrorView", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented", TableHead: "TableHead",
}));
vi.mock("@/api/hooks", () => {
  const q = (data: unknown) => ({ data, isError: false, error: null, isSuccess: data !== undefined, refetch: vi.fn(async () => undefined), dataUpdatedAt: 1, errorUpdatedAt: 0, fetchStatus: "idle" });
  const LATEST = [{ code: "005930", name: "삼성전자", latest: { id: 1, code: "005930", name: "삼성전자", session: "morning", date: "2026-09-28", status: "ok", summary: "요약", detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: "2026-09-28T08:40:00+09:00" } }];
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useMarketSummaries: (enabled: boolean) => {
      h.listEnabled.push(enabled);
      return q(enabled ? h.list : undefined);
    },
    useMarketSummary: (_id: number, enabled: boolean) => {
      h.detailEnabled.push(enabled);
      return q(enabled ? h.detail : undefined);
    },
    useAccountBriefings: () => q(undefined),
    useAccountBriefing: () => q(undefined),
    useLatestBriefings: () => q(LATEST),
    useRegisteredStocks: () => q([]),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q(undefined),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
    useBriefing: () => q(undefined),
    useBriefings: () => q(undefined),
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { default: MarketSummaryScreen } = await import("@/app/briefings/market/[id]");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const pick = await import("@/lib/briefingPick");
const { marketSummary: MS, touch } = await import("@/tokens");

const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: Array<{ data: MarketSummaryData }> };
const item = (id: number, data: MarketSummaryData): MarketSummary => ({ id, date: data.date, session: data.session, market: data.market, status: "ok", summary: "요약", createdAt: data.asOf, data });
const MORNING = item(7, shared.cases[0]!.data);
const KR_HOLIDAY = item(8, shared.cases[2]!.data);
const US_HOLIDAY = item(9, shared.cases[3]!.data);

type R = ReturnType<typeof render>;
/** 그린 글 그대로 */
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
/** 읽는 글 (보이지 않는 글자는 쓰지 않는다 — 덩어리 줄은 글자를 그대로 둔다) */
const textOf = rawOf;
/** 줄바꿈 덩어리 줄(SegText·Words: testID "words")들 — 덩어리 글들과, 그것을 ' '로 이은 한 줄 */
const wordRows = (r: R) => r.all().filter((n) => n.type === "View" && n.props.testID === "words");
const chunksOf = (row: HostNode) => row.children.filter((c): c is HostNode => typeof c !== "string").map(textOf);
/** 화면의 글: 글 요소 하나하나 + 덩어리 줄을 이은 한 줄 (줄은 덩어리로 나뉘어 그려진다) */
const texts = (r: R) => [...r.all().filter((n) => n.type === "Text" || n.type === "Muted").map(textOf), ...wordRows(r).map((row) => chunksOf(row).join(" "))];
const labels = (r: R) => r.all().map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");
/** 한 노드 아래 모든 노드 (자기 포함) */
const collect = (n: HostNode): HostNode[] => [n, ...n.children.flatMap((c) => (typeof c === "string" ? [] : collect(c)))];
/** 스타일 배열에서 숫자 폭 */
const widthOf = (n: HostNode): number | undefined => {
  const st = n.props.style;
  const list = (Array.isArray(st) ? st : [st]) as Array<{ width?: unknown } | undefined>;
  const w = list.find((x) => x && typeof x.width === "number");
  return w ? (w.width as number) : undefined;
};
/** 표 머리 글들 */
const headsOf = (r: R) => r.all().filter((n) => n.type === "TableHead").map((n) => n.children.filter((c): c is HostNode => typeof c !== "string").map(textOf));
const cardOf = (r: R) => r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").includes("숫자로 만든 요약"));
/** 지수 칸 (testID "index-cell") 의 이름 — 칸의 첫 글 */
const cellName = (c: HostNode) => textOf(c.children.find((x): x is HostNode => typeof x !== "string" && x.type === "Text")!);
/** 지수 칸 줄들: 줄마다 칸 이름 (한 줄 4칸이면 [[4개]], 2×2 면 [[2개],[2개]]) */
const cellRowsOf = (r: R) =>
  r
    .all()
    .filter((n) => n.type === "View" && n.children.some((c) => typeof c !== "string" && c.props.testID === "index-cell"))
    .map((row) => row.children.filter((c): c is HostNode => typeof c !== "string").map(cellName));
/** 누르는 칸(카드·목록 줄) 안에서 따로 화면 읽기에 잡히는 칸 (accessible 이거나 이름이 붙은 것) — 누르는 칸 하나가 한 문장으로 읽혀야 하므로 없어야 한다 */
const innerA11y = (press: HostNode) => collect(press).filter((n) => n !== press && (n.props.accessible === true || typeof n.props.accessibilityLabel === "string"));
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 679, scale: 2.625, fontScale: 1 };
  h.fontScale = 1;
  h.flags = {};
  h.now = Date.parse("2026-09-28T08:31:00+09:00");
  h.params = { id: "7" };
  h.list = [MORNING];
  h.detail = MORNING;
  h.listEnabled = [];
  h.detailEnabled = [];
  h.push.mockReset();
  h.openURL.mockReset();
  h.store.clear();
  pick.forgetPick();
  forgetWindowClass();
});

describe("브리핑 탭 맨 위 카드 (접은 화면)", () => {
  it("플래그가 꺼져 있으면(앱 기본) 카드가 없고 목록을 요청하지 않는다", () => {
    const r = render(<BriefingsScreen />);
    expect(cardOf(r)).toBeUndefined();
    expect(h.listEnabled.every((e) => !e)).toBe(true);
  });

  it("켜져 있으면 맨 위 카드: 월요일 제목은 '금요일(9/25) 미국 시장', 지수 4칸·이름표 줄·뉴스 제목 2개·고지, 누르면 상세", () => {
    h.flags = { marketSummary: true };
    const r = render(<BriefingsScreen />);
    const card = cardOf(r)!;
    expect(card).toBeDefined();
    const all = texts(r);
    expect(all).toContain("금요일(9/25) 미국 시장");
    expect(all).toContain("9/25(금) 뉴욕 장 마감 기준 · 주말 이틀 휴장");
    expect(all).toContain("9월 28일 (월) 오전");
    for (const l of ["환율·금리", "업종", "내 종목", "뉴스 3건"]) expect(all).toContain(l);
    expect(all).toContain("원/달러 1,359.00원 +3.50원 (9/23 고시) · 미 10년물 5.17% -0.01%p (미 재무부)");
    expect(all).toContain("약 커뮤니케이션 -0.90% · 에너지 -0.89% (섹터 ETF 기준)");
    expect(all.some((t) => t.startsWith("뉴스1 9/26 05:32 [예시]"))).toBe(true);
    expect(all.some((t) => t.startsWith("KBS 9/26 05:22"))).toBe(true);
    expect(all.some((t) => t.startsWith("한국경제"))).toBe(false); // 세 번째 제목은 상세에만
    expect(all).toContain("숫자로 만든 요약 · 뉴스 제목은 언론사 원문 · 매매 권유가 아닙니다");
    // 지수는 카드 한 문장이 읽는다 — 카드 안 지수 칸은 따로 읽히지 않는다 (TalkBack 이 같은 지수에서 한 번 더 멈추지 않게, 4차 검토)
    expect(String(card.props.accessibilityLabel)).toContain("나스닥 0.48% 상승, S&P500 0.51% 상승, 다우 0.93% 상승, 필라반도체 1.41% 상승");
    expect(r.all().filter((n) => n.props.testID === "index-cell")).toHaveLength(4);
    expect(innerA11y(card)).toEqual([]);
    // 계좌·종목 브리핑보다 위 (첫 누르는 칸)
    const firstPress = r.all().find((n) => n.type === "Pressable");
    expect(firstPress).toBe(card);
    r.act(() => (card.props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/briefings/market/7");
  });

  it("다음 날 아침에 보면 '밤사이'가 아니라 날짜로 — 휴장 오후 카드는 '휴장' 배지·배너·칸마다 거래일", () => {
    h.flags = { marketSummary: true };
    h.list = [KR_HOLIDAY];
    h.now = Date.parse("2026-09-25T16:05:00+09:00");
    const r = render(<BriefingsScreen />);
    const all = texts(r);
    expect(all).toContain("오늘 한국 시장");
    expect(all).toContain("오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준");
    // 칸마다 거래일: 이름 옆이 아니라 이름 아래 줄 (좁은 칸에서 날짜가 말줄임으로 잘리지 않게)
    expect(all).toContain("코스피");
    expect(all.filter((x) => x === "9/23")).toHaveLength(2);
    expect(String(cardOf(r)!.props.accessibilityLabel)).toContain("코스피 (9/23) 0.90% 상승, 코스닥 (9/23) 1.21% 상승");
    expect(innerA11y(cardOf(r)!)).toEqual([]);
    expect(r.all().some((n) => n.type === "Badge" && textOf(n) === "휴장")).toBe(true);
    expect(all).not.toContain("뉴스 3건");
    // 토요일에 다시 보면 날짜로
    h.now = Date.parse("2026-09-26T10:00:00+09:00");
    r.rerender();
    expect(texts(r)).toContain("9/25(금) 한국 시장");
    expect(texts(r)).toContain("9/25(금) 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준");
  });

  it("미국 휴장 다음 날(11/27) 카드: 제목은 숫자의 거래일 '수요일(11/25) 미국 시장', 지수 칸마다 날짜는 이름 아래 한 줄(울트라 411에서도 잘리지 않게)", () => {
    h.flags = { marketSummary: true };
    h.list = [US_HOLIDAY];
    h.now = Date.parse("2026-11-27T08:40:00+09:00");
    h.win = { width: 411, height: 960, scale: 2.625, fontScale: 1 };
    const r = render(<BriefingsScreen />);
    const all = texts(r);
    expect(all).toContain("수요일(11/25) 미국 시장");
    expect(all).not.toContain("밤사이 미국 시장");
    expect(all).toContain("지난밤 미국 휴장(추수감사절) · 아래는 직전 거래일 11/25(수) 기준");
    // 이름 줄(한 줄 말줄임)에는 날짜가 없고, 날짜는 4칸 모두 따로
    const nameLines = r.all().filter((n) => n.type === "Text" && n.props.numberOfLines === 1 && /^(나스닥|S&P500|다우|필라반도체)/.test(textOf(n)));
    expect(nameLines.map(textOf)).toEqual(["나스닥", "S&P500", "다우", "필라반도체"]);
    expect(all.filter((x) => x === "11/25")).toHaveLength(4);
    expect(all).toContain("원/달러 1,400.00원 -2.50원 (11/26 고시) · 미 10년물 4.90% +0.02%p (11/25 기준 · 미 재무부)");
  });

  it("큰 글씨(130%): 카드 이름표 칸이 글자만큼 넓어진다 ('환율·금리'가 두 줄로 쪼개지지 않게)", () => {
    h.flags = { marketSummary: true };
    h.fontScale = 1.3;
    const r = render(<BriefingsScreen />);
    const label = r.all().find((n) => n.type === "Text" && textOf(n) === "환율·금리")!;
    expect(widthOf(label)).toBe(Math.round(MS.labelW * 1.3));
  });

  it("울트라 411·글자 130%: 지수 4칸을 2×2 로 놓아 등락률이 '+0.4…'처럼 잘리지 않는다 (475·130%, 411·100% 는 4칸 그대로) — 숫자 칸은 글자를 줄여 넣기", () => {
    h.flags = { marketSummary: true };
    const rowsAt = (width: number, scale: number) => {
      cleanupRenders();
      h.win = { width, height: 900, scale: 2.625, fontScale: scale };
      h.fontScale = scale;
      return cellRowsOf(render(<BriefingsScreen />));
    };
    expect(rowsAt(411, 1.3)).toEqual([
      ["나스닥", "S&P500"],
      ["다우", "필라반도체"],
    ]);
    expect(rowsAt(475, 1.3)).toEqual([["나스닥", "S&P500", "다우", "필라반도체"]]);
    expect(rowsAt(411, 1)).toEqual([["나스닥", "S&P500", "다우", "필라반도체"]]);
    const r = render(<BriefingsScreen />);
    const rate = r.all().find((n) => n.type === "Text" && textOf(n) === "+0.48%")!;
    expect(rate.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.6 });
    const value = r.all().find((n) => n.type === "Text" && textOf(n) === "27,068.72")!;
    expect(value.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
  });

  it("카드 화면 읽기: 카드에 보이는 뉴스 제목 2개를 언론사·시각과 함께 읽는다 (카드 전체가 누르는 칸 하나라서)", () => {
    h.flags = { marketSummary: true };
    const label = String(cardOf(render(<BriefingsScreen />))!.props.accessibilityLabel);
    expect(label).toContain("뉴스 3건, 뉴스1 9/26 05:32, [예시] 뉴욕증시 3대 지수 상승 마감…나스닥 0.48%↑, KBS 9/26 05:22, [예시] 뉴욕증시, 기술주 강세 속 상승 마감, 외 1건");
    expect(label).not.toContain("[예시] 뉴욕증시 마감 시황"); // 세 번째 제목은 카드에 없다
  });

  it("줄은 낱말(덩어리) 사이에서만 바뀐다: 카드 줄마다 덩어리 글이 따로 — '미 10년물'·'비슷 7'·'(마이크로소프트 +3.66%,'·'지수와'가 음절 사이에서 갈라지지 않게 (3차 검토, 475·411·130%)", () => {
    h.flags = { marketSummary: true };
    for (const [width, scale] of [
      [475, 1],
      [411, 1],
      [411, 1.3],
      [475, 1.3],
    ] as const) {
      cleanupRenders();
      h.win = { width, height: 900, scale: 2.625, fontScale: scale };
      h.fontScale = scale;
      const r = render(<BriefingsScreen />);
      const rows = wordRows(r);
      const chunks = rows.flatMap(chunksOf);
      for (const c of ["미 10년물 5.17% -0.01%p", "(미 재무부)", "(9/23 고시) ·", "미국 12종목 ·", "높음 2", "(마이크로소프트 +3.66%,", "지수와", "차이 +3.18%p) ·", "낮음 3", "비슷 7", "(섹터 ETF 기준)", "강 산업재 +0.95% ·"]) expect(chunks, `${width}·${scale}: ${c}`).toContain(c);
      // 덩어리 줄은 옆으로 놓고 넘치면 다음 줄로 (간격 = 띄어쓰기 폭, 글자 배율만큼)
      for (const row of rows) {
        const st = row.props.style as Array<Record<string, unknown> | null>;
        expect(st.some((x) => x?.["flexWrap"] === "wrap")).toBe(true);
      }
      // 보이지 않는 묶음 글자(WJ·줄바꿈 없는 공백)는 쓰지 않는다 — 화면 읽기에 끼지 않게
      expect(chunks.some((c) => /[⁠ ]/.test(c))).toBe(false);
      // 카드 안 줄은 따로 읽히지 않는다 (카드 전체가 한 문장 — 누르는 칸 안에 화면 읽기 칸을 또 두지 않는다)
      const card = cardOf(r)!;
      expect(collect(card).filter((n) => n !== card && n.props.accessible === true && n.type === "View" && n.props.testID === "words")).toEqual([]);
    }
    // 간격은 글자 크기 × 배율의 띄어쓰기 폭
    const gapAt = (scale: number) => {
      cleanupRenders();
      h.win = { width: 475, height: 900, scale: 2.625, fontScale: scale };
      h.fontScale = scale;
      const row = wordRows(render(<BriefingsScreen />)).find((x) => chunksOf(x).includes("비슷 7"))!;
      return (row.props.style as Array<Record<string, unknown> | null>).find((y) => y?.["columnGap"] !== undefined)!["columnGap"];
    };
    expect(gapAt(1)).toBe(4);
    expect(gapAt(1.3)).toBe(5);
  });

  it("한국 휴장 카드: '9/23 기준 ·' 흐린 머리와 '비슷 2'·'차이 -3.39%p)'가 덩어리째 (예전 '비 / 슷 2')", () => {
    h.flags = { marketSummary: true };
    h.list = [KR_HOLIDAY];
    h.now = Date.parse("2026-09-25T16:05:00+09:00");
    h.win = { width: 411, height: 900, scale: 2.625, fontScale: 1.3 };
    h.fontScale = 1.3;
    const chunks = wordRows(render(<BriefingsScreen />)).flatMap(chunksOf);
    for (const c of ["9/23 기준 ·", "비슷 2", "거래일 9/23", "휴장(추석) ·", "반도체와반도체장비 +2.80%"]) expect(chunks).toContain(c);
  });

  it("예전 서버(404 → 빈 목록)면 카드가 없다", () => {
    h.flags = { marketSummary: true };
    h.list = [];
    expect(cardOf(render(<BriefingsScreen />))).toBeUndefined();
  });
});

describe("상세 화면 /briefings/market/<id>", () => {
  it("내 보유 종목과 지수(지수 표보다 위) → 주요 지수 → 업종 → 환율·금리 → 일정 → 뉴스(원문 링크) → 만든 기준", () => {
    h.flags = { marketSummary: true };
    const r = render(<MarketSummaryScreen />);
    const sections = r.all().filter((n) => n.type === "SectionTitle").map(textOf);
    expect(sections).toEqual(["내 보유 종목과 지수", "주요 지수", "업종 (섹터 ETF)", "환율·금리", "일정", "뉴스 3건", "이 요약을 만든 기준"]);
    const all = texts(r);
    expect(all).toContain("금요일(9/25) 미국 시장");
    expect(all).toContain("내 미국 12종목: 상승 8 · 하락 4 / 나스닥 +0.48% · S&P500 +0.51%");
    expect(all).toContain("지수보다 높음 (+1.00%p 이상) 2");
    expect(all).toContain("비슷 (±1.00%p 안) 7");
    expect(all).toContain("지수보다 낮음 (-1.00%p 이하) 3");
    expect(all).toContain("+3.18%p");
    expect(labels(r)).toContain("마이크로소프트, 3.66% 상승, 비교 지수 나스닥 0.48% 상승, 차이 3.18%포인트 높음");
    expect(all.some((t) => t.includes("다음: 10/2(금) 21:30 미국 9월 고용보고서 발표 (예정)"))).toBe(true);
    expect(all.some((t) => t.includes("AI(모델)가 쓴 문장은 없습니다"))).toBe(true);
    // 뉴스 원문 링크 3개 (제목 원문 그대로)
    const links = r.all().filter((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").includes("기사 원문 열기"));
    expect(links).toHaveLength(3);
    r.act(() => (links[0]!.props.onPress as () => void)());
    expect(h.openURL).toHaveBeenCalledWith("https://news.google.com/rss/articles/example-1");
    expect(r.all().some((n) => n.type === "StackScreen" && (n.props.options as { title?: string }).title === "시장 요약 · 오전")).toBe(true);
    expect(h.detailEnabled.at(-1)).toBe(true);
  });

  it("원/달러 '한국 휴장으로 갱신 없음'은 한국 휴장일 때만 — 미국 휴장 다음 날(11/27, 한국은 11/26 정상 고시)에는 붙이지 않는다", () => {
    h.flags = { marketSummary: true };
    h.detail = US_HOLIDAY;
    h.now = Date.parse("2026-11-27T08:40:00+09:00");
    const us = texts(render(<MarketSummaryScreen />));
    expect(us.some((t) => t.includes("하나은행 고시 매매기준율 · 11/26 고시값"))).toBe(true);
    expect(us.some((t) => t.includes("한국 휴장으로 갱신 없음"))).toBe(false);
    cleanupRenders();
    h.detail = KR_HOLIDAY;
    h.now = Date.parse("2026-09-25T16:05:00+09:00");
    const kr = texts(render(<MarketSummaryScreen />));
    expect(kr.some((t) => t.includes("9/23 고시값 (한국 휴장으로 갱신 없음)"))).toBe(true);
  });

  it("주요 지수 표에 출처 시각: 지수 이름 아래 '뉴욕 17:15'(나스닥)·'뉴욕 16:39'(S&P500), 한국은 '서울 20:15' — 화면 읽기에도", () => {
    h.flags = { marketSummary: true };
    const r = render(<MarketSummaryScreen />);
    const nas = r.all().find((n) => n.type === "View" && String(n.props.accessibilityLabel ?? "").startsWith("나스닥, "))!;
    expect(nas.props.accessibilityLabel).toBe("나스닥, 27,068.72, 0.48% 상승, 출처 시각 뉴욕 17:15");
    expect(collect(nas).filter((n) => n.type === "Text").map(textOf)).toEqual(expect.arrayContaining(["나스닥", "뉴욕 17:15"]));
    expect(texts(r)).toContain("뉴욕 16:39");
    expect(texts(r).some((t) => t.includes("지수 이름 아래는 출처 시각(현지) — 네이버 최종값은 뉴욕 17:15 무렵"))).toBe(true);
    cleanupRenders();
    h.detail = item(7, shared.cases[1]!.data);
    h.now = Date.parse("2026-09-23T16:05:00+09:00");
    expect(texts(render(<MarketSummaryScreen />))).toContain("서울 20:15");
  });

  it("보유 종목 표 아래 안내: 시세 없음은 까닭을 단정하지 않고('조회 실패 등'), 금현물 같은 원자재 ETF 는 '해외 지수·원자재 ETF'", () => {
    h.flags = { marketSummary: true };
    const d = shared.cases[0]!.data;
    h.detail = item(7, { ...d, holdings: { ...d.holdings!, excluded: { ...d.holdings!.excluded, noQuote: ["애플"], overseas: ["ACE KRX금현물"] } } });
    const all = texts(render(<MarketSummaryScreen />));
    const foot = all.find((t) => t.includes("시세 없음"))!;
    expect(foot).toContain("시세 없음 1(애플) — 같은 날 정규장 시세를 받지 못함(거래정지·지연·조회 실패 등)");
    expect(foot).not.toContain("거래정지·지연으로");
    expect(foot).toContain("해외 지수·원자재 ETF 1종목 제외(ACE KRX금현물)");
  });

  it("금리 화면 읽기: 전일 대비는 '하락/상승' (지수와의 차이처럼 '낮음'으로 읽지 않는다)", () => {
    h.flags = { marketSummary: true };
    const r = render(<MarketSummaryScreen />);
    expect(labels(r)).toContain("미국 10년물 금리, 5.17%, 0.01%포인트 하락, 미 재무부");
  });

  it("접은 화면(475): 보유 종목·주요 지수 표는 목업처럼 4칸, 업종 막대 길이는 칸 폭을 따르고(퍼센트) 이름은 두 줄까지", () => {
    h.flags = { marketSummary: true };
    const r = render(<MarketSummaryScreen />);
    expect(headsOf(r)).toEqual([
      ["종목", "등락률", "비교 지수", "차이"],
      ["지수", "종가", "전일 대비", "등락률"],
    ]);
    const widths = r.all().filter((n) => n.type === "View" && typeof (n.props.style as { width?: unknown } | undefined)?.width === "string").map((n) => (n.props.style as { width: string }).width);
    expect(widths).toHaveLength(11); // 섹터 ETF 11개
    expect(widths).toContain("100%"); // 가장 큰 등락률(산업재 +0.95%)이 반쪽 칸을 채운다
    expect(widths.every((w) => /^\d+%$/.test(w))).toBe(true);
    const sectorNames = r.all().filter((n) => n.type === "Text" && n.props.numberOfLines === 2 && /^(산업재|커뮤니케이션|헬스케어)/.test(textOf(n)));
    expect(sectorNames.map(textOf)).toEqual(expect.arrayContaining(["산업재 XLI", "헬스케어 XLV", "커뮤니케이션 XLC"]));
  });

  it("한국 업종: 구성 종목 수는 이름 아래 줄 ('반도체와반도체장비 90 / 종목'처럼 숫자와 '종목'이 갈라지지 않게)", () => {
    h.flags = { marketSummary: true };
    h.detail = item(7, shared.cases[1]!.data);
    h.now = Date.parse("2026-09-23T16:05:00+09:00");
    const all = texts(render(<MarketSummaryScreen />));
    expect(all).toContain("반도체와반도체장비");
    expect(all).toContain("90종목");
  });

  it("펼친 세로(704, 두 칸): 보유 종목 표는 비교 지수를 이름 아래로, 주요 지수 표는 전일 대비를 종가 아래로 내린 3칸 — 이름이 '마이크/로소…'처럼 쪼개지지 않게", () => {
    h.flags = { marketSummary: true, foldLayout: true };
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    const r = render(<MarketSummaryScreen />);
    expect(headsOf(r)).toEqual([
      ["종목 · 비교 지수", "등락률", "차이"],
      ["지수", "종가 · 전일 대비", "등락률"],
    ]);
    const ms = r.all().find((n) => n.type === "View" && String(n.props.accessibilityLabel ?? "").startsWith("마이크로소프트, "))!;
    const inRow = collect(ms).filter((n) => n.type === "Text").map(textOf);
    expect(inRow).toEqual(expect.arrayContaining(["마이크로소프트", "나스닥 +0.48%", "+3.66%", "+3.18%p"]));
    const diff = collect(ms).find((n) => n.type === "Text" && textOf(n) === "+3.18%p")!;
    expect(widthOf(diff)).toBe(MS.colDiff);
    const sox = r.all().find((n) => n.type === "View" && String(n.props.accessibilityLabel ?? "").startsWith("필라반도체, "))!;
    expect(collect(sox).filter((n) => n.type === "Text").map(textOf)).toEqual(expect.arrayContaining(["필라반도체", "12,668.93", "+176.39", "+1.41%"]));
  });

  it("큰 글씨(130%) 접은 화면: 숫자 칸 폭도 글자만큼 넓어지고('+3.18%p'가 두 줄로 쪼개지지 않게) 보유 종목 표는 3칸", () => {
    h.flags = { marketSummary: true };
    h.fontScale = 1.3;
    const r = render(<MarketSummaryScreen />);
    const heads = headsOf(r);
    expect(heads[0]).toEqual(["종목 · 비교 지수", "등락률", "차이"]);
    expect(heads[1]).toEqual(["지수", "종가", "전일 대비", "등락률"]);
    const ms = r.all().find((n) => n.type === "View" && String(n.props.accessibilityLabel ?? "").startsWith("마이크로소프트, "))!;
    const diff = collect(ms).find((n) => n.type === "Text" && textOf(n) === "+3.18%p")!;
    expect(widthOf(diff)).toBe(Math.round(MS.colDiff * 1.3));
    const rate = r.all().filter((n) => n.type === "Text" && textOf(n) === "+0.48%" && typeof widthOf(n) === "number");
    expect(rate.map(widthOf)).toContain(Math.round(MS.colRate * 1.3));
  });

  it("플래그가 꺼져 있으면 불러오지 않고 '볼 수 없습니다'", () => {
    const r = render(<MarketSummaryScreen />);
    expect(h.detailEnabled.every((e) => !e)).toBe(true);
    expect(r.all().some((n) => n.type === "Empty" && n.props.title === "시장 요약을 볼 수 없습니다")).toBe(true);
  });
});

describe("상세 화면 — 3차 검토 보정 (낱말 줄바꿈·화면 읽기·ETF 안내·원문 링크)", () => {
  it("'내 보유 종목과 지수' 머리 두 줄은 화면 읽기 한 칸 — 기호는 말로('+3.18%p' → '3.18%포인트 높음'), 보이지 않는 글자 없음", () => {
    h.flags = { marketSummary: true };
    const r = render(<MarketSummaryScreen />);
    const head = r.all().find((n) => n.type === "View" && n.props.accessible === true && String(n.props.accessibilityLabel ?? "").startsWith("미국 12종목, 지수보다 높음 2"))!;
    expect(head).toBeDefined();
    const label = String(head.props.accessibilityLabel);
    expect(label).toContain("(마이크로소프트 3.66% 상승, 지수와 차이 3.18%포인트 높음)");
    expect(label).toContain("비슷 7. 내 미국 12종목: 상승 8, 하락 4, 나스닥 0.48% 상승, S&P500 0.51% 상승");
    expect(label).not.toMatch(/[+±]|%p|[⁠ ]/);
    // 두 줄 모두 이 칸 안 (따로 읽히지 않는다)
    const inside = wordRows({ all: () => collect(head) } as unknown as R).map((row) => chunksOf(row).join(" "));
    expect(inside).toEqual(["미국 12종목 · 지수보다 높음 2 (마이크로소프트 +3.66%, 지수와 차이 +3.18%p) · 낮음 3 (메타 -3.33%, 차이 -3.81%p) · 비슷 7", "내 미국 12종목: 상승 8 · 하락 4 / 나스닥 +0.48% · S&P500 +0.51%"]);
    // 묶음 머리는 따로 적은 문장으로 ('+1.00%p' 를 '높음'으로 두 번 읽지 않게)
    expect(labels(r)).toContain("지수보다 높음, 차이 1%포인트 이상, 2종목");
    expect(labels(r)).toContain("비슷, 차이 플러스마이너스 1%포인트 안, 7종목");
  });

  it("상세의 안내 문단은 낱말 단위로 줄바꿈하고 한 문장으로 읽힌다 (덩어리마다 따로 읽히지 않게)", () => {
    h.flags = { marketSummary: true };
    const r = render(<MarketSummaryScreen />);
    const foot = wordRows(r).find((row) => chunksOf(row).join(" ").startsWith("정규장 종가 기준(애프터마켓 제외)"))!;
    expect(foot.props).toMatchObject({ accessible: true });
    expect(String(foot.props.accessibilityLabel)).toContain("정규장 종가 기준(애프터마켓 제외), 잔고 화면 값과 조금 다를 수 있습니다, 나스닥 상장 종목은 나스닥");
    expect(String(foot.props.accessibilityLabel)).not.toContain("받지 못함");
    // 요약 줄(요약 칸이 한 문장으로 읽는다)은 따로 읽히지 않는다
    const summaryRows = wordRows(r).filter((row) => chunksOf(row)[0]?.startsWith("나스닥 +0.48%"));
    expect(summaryRows.length).toBeGreaterThan(0);
    expect(summaryRows.every((row) => row.props.accessible !== true)).toBe(true);
    // 넓은 창 2단 오른쪽 칸(933)에서도 '낮음 3'·'에너지 -0.89%'·'지수와'가 덩어리째
    cleanupRenders();
    h.flags = { marketSummary: true, foldLayout: true };
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const chunks = wordRows(render(<MarketSummaryScreen />)).flatMap(chunksOf);
    for (const c of ["낮음 3", "에너지 -0.89%", "지수와", "차이 +3.18%p) ·", "비슷 7"]) expect(chunks).toContain(c);
  });

  it("비교 안내: 이름으로 알아보지 못한 ETF 는 지수와 그대로 비교된다는 안내를 늘 적는다 (뺀 ETF 가 없어도), 한국은 코스닥 추종 ETF 를 코스닥과 비교한다고", () => {
    h.flags = { marketSummary: true };
    const d = shared.cases[0]!.data;
    h.detail = item(7, { ...d, holdings: { ...d.holdings!, excluded: { leverage: [], overseas: [], bond: [], noQuote: [], noBenchmark: [] } } });
    const us = texts(render(<MarketSummaryScreen />)).find((t) => t.startsWith("정규장 종가 기준"))!;
    expect(us).toContain("알아보지 못한 ETF(금·변동성·채권 액티브·코인 ETF 등)는 지수와 그대로 비교됩니다");
    expect(us).not.toContain("종목 제외");
    cleanupRenders();
    h.detail = item(7, shared.cases[1]!.data);
    h.now = Date.parse("2026-09-23T16:05:00+09:00");
    const kr = texts(render(<MarketSummaryScreen />)).find((t) => t.startsWith("KRX 정규장 종가 기준"))!;
    expect(kr).toContain("코스피 상장 종목은 코스피, 코스닥 상장 종목과 코스닥 추종 ETF(코스피 시장 상장)는 코스닥과 비교");
    expect(kr).toContain("알아보지 못한 ETF(해외 종목을 담은 액티브·테마 ETF 등)는 지수와 그대로 비교됩니다");
    expect(kr).not.toContain("코스피 상장 종목은 코스피, 코스닥 상장 종목은 코스닥과 비교");
  });

  it("제목 아래 기준 줄: 만든 시각과 '생성'이 한 덩어리 ('… 08:30 / 생성'처럼 '생성'만 다음 줄로 넘어가지 않게, 933·704·475, 100%·130% — 4차 검토)", () => {
    for (const [width, height, scale, fold] of [
      [933, 704, 1, true],
      [933, 704, 1.3, true],
      [704, 933, 1.3, true],
      [475, 900, 1, false],
    ] as const) {
      cleanupRenders();
      h.flags = { marketSummary: true, ...(fold ? { foldLayout: true } : {}) };
      h.win = { width, height, scale: 2.625, fontScale: scale };
      h.fontScale = scale;
      const rows = wordRows(render(<MarketSummaryScreen />));
      const basis = rows.find((row) => chunksOf(row).join(" ").startsWith("9/25(금) 뉴욕 장 마감 기준"))!;
      expect(basis, `${width}·${scale}`).toBeDefined();
      const chunks = chunksOf(basis);
      expect(chunks.at(-1), `${width}·${scale}`).toMatch(/^\d{2}:\d{2} 생성$/);
      expect(chunks).not.toContain("생성");
      // 읽는 문장은 글자 그대로 한 줄 (덩어리로 나뉘어도)
      expect(String(basis.props.accessibilityLabel)).toMatch(/\d{2}:\d{2} 생성$/);
    }
  });

  it("뉴스 '원문'은 http(s) 주소만 연다 — javascript: 같은 주소의 기사는 제목만 보이고 원문 칸이 없다", () => {
    h.flags = { marketSummary: true };
    const d = shared.cases[0]!.data;
    h.detail = item(7, { ...d, news: { ...d.news, items: [{ ...d.news.items[0]!, url: "javascript:alert(1)" }, ...d.news.items.slice(1)] } });
    const r = render(<MarketSummaryScreen />);
    const links = r.all().filter((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").includes("기사 원문 열기"));
    expect(links).toHaveLength(2);
    expect(texts(r)).toContain(d.news.items[0]!.title);
    for (const l of links) r.act(() => (l.props.onPress as () => void)());
    expect(h.openURL.mock.calls.map((c) => c[0])).toEqual(["https://news.google.com/rss/articles/example-2", "https://news.google.com/rss/articles/example-3"]);
  });
});

describe("넓은 창 (펼친 폴드8 가로 2단, 플래그 foldLayout)", () => {
  it("목록 맨 위 줄(계좌 줄 위)을 누르면 오른쪽 칸에 요약 상세 — 처음 골라지는 브리핑 규칙은 그대로(첫 미확인 종목 브리핑)", async () => {
    h.flags = { marketSummary: true, foldLayout: true, accountBriefing: true };
    h.win = { width: 933, height: 632, scale: 2.625, fontScale: 1 };
    const r = render(<BriefingsScreen />);
    await settle(r);
    // 처음에는 종목 브리핑이 저절로 골라진다 (시장 요약이 아니라)
    expect(pick.currentPick().pick).toMatchObject({ kind: "stock", id: 1 });
    const row = r.all().find((n) => n.type === "Pressable" && n.props.accessibilityRole === "button" && String(n.props.accessibilityLabel ?? "").startsWith("금요일(9/25) 미국 시장"))!;
    expect(row).toBeDefined();
    expect(texts(r)).toContain("내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7");
    // 줄 안 작은 지수 칸 4개는 따로 읽히지 않는다 (줄 한 문장이 지수를 읽는다 — 4차 검토)
    expect(collect(row).filter((n) => n.props.testID === "index-cell")).toHaveLength(4);
    expect(innerA11y(row)).toEqual([]);
    expect(String(row.props.accessibilityLabel)).toContain("나스닥 0.48% 상승");
    expect(r.all().some((n) => n.type === "Badge" && textOf(n) === "9/25(금) 마감")).toBe(true);
    r.act(() => (row.props.onPress as () => void)());
    await settle(r);
    expect(pick.currentPick().pick).toEqual({ kind: "market", id: 7 });
    expect(h.push).not.toHaveBeenCalled(); // 주소는 그대로, 오른쪽 칸만
    expect(r.all().some((n) => n.type === "SectionTitle" && textOf(n) === "내 보유 종목과 지수")).toBe(true);
    const selected = r.all().find((n) => n === row || (n.type === "Pressable" && n.props.accessibilityState && (n.props.accessibilityState as { selected?: boolean }).selected && String(n.props.accessibilityLabel).startsWith("금요일")));
    expect(selected).toBeDefined();
  });

  it("줄 높이는 누르는 크기(44) 이상", () => {
    expect(MS.rowMinH).toBeGreaterThanOrEqual(touch.min);
  });
});
