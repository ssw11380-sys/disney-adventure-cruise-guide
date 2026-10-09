import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 3-33 수급 탭 연결 (종목 상세 — 플래그 flowTab, 앱 fallback 꺼짐).
 *  - 꺼짐(없음·false): 탭 목록이 지금 그대로(휴대폰 4칸 · 넓은 창 5칸), 수급 칸 없음, 서버에 묻지 않음. 주소 tab=flow 로 열어도 기본 탭과 같은 트리
 *    (바꾸기 전 코드와 트리가 같은지는 tossOpen 테스트의 지문(다섯 배치 × 세 종목)과 stockDetailFold 스냅숏이 본다 — 둘 다 그대로 통과)
 *  - 켜짐: 휴대폰·좌우·펼침 세로 탭 끝 '수급'(자리가 모자라면 이름을 줄이고 화면 읽기는 원래 이름), 누르면 수급 탭, tab=flow 주소 복원,
 *    윗줄+아랫줄 배치는 아랫줄 다음 전체 폭 '수급' 칸. 미국 종목도 탭은 있고 부품이 '해당 없음'을 그린다
 */
const h = vi.hoisted(() => ({
  win: { width: 360, height: 752, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean | undefined>,
  params: { code: "005930" } as Record<string, string | undefined>,
  stock: undefined as unknown,
  setParams: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Modal: "Modal",
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: { position: "absolute" } },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 32, bottom: 48, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({
  Stack: { Screen: "StackScreen" },
  router: { back: vi.fn(), dismissTo: vi.fn(), push: vi.fn(), navigate: vi.fn(), replace: h.replace, setParams: h.setParams, canGoBack: () => true, canDismiss: () => true },
  useLocalSearchParams: () => h.params,
  usePathname: () => "/stocks/005930",
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
const idle = { data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined };
const flowCalls: string[] = [];
vi.mock("@/api/hooks", () => ({
  useStock: () => ({ ...idle, data: h.stock }),
  useCandles: () => idle,
  useBriefings: () => ({ ...idle, data: [] }),
  useAnalysis: () => ({ ...idle, isLoading: true }),
  useStockNews: () => ({ ...idle, data: { news: [], newsError: null, disclosures: [], disclosuresError: null } }),
  useAnyMarketOpen: () => ({ open: false, fresh: false }),
  useStockMutations: () => ({ register: { mutate: vi.fn() }, remove: { mutate: vi.fn() }, refreshAnalysis: { mutate: vi.fn(), isPending: false, isError: false, error: null } }),
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useApi: () => ({ listStocks: async () => [] }),
  useInvestorFlow: (code: string) => (flowCalls.push(code), idle),
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false, afterCost: false, sort: "created", apiUrl: "http://x" }) }));
vi.mock("@/lib/holdingsNav", async (orig) => ({ ...(await orig<typeof import("@/lib/holdingsNav")>()), useHoldingsNav: () => null, useCachedRow: () => null }));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 }, parseCandlePeriod: () => "D" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: Date.parse("2026-09-29T10:12:05+09:00"), feedOk: true }) }));
vi.mock("@/components/Skeleton", () => ({ DetailSkeleton: "DetailSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen", Disclaimer: "Disclaimer" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Chip: "Chip", ErrorView: "ErrorView", LiveDot: "LiveDot", Loading: "Loading", Muted: "Muted", SectionTitle: "SectionTitle", Segmented: "Segmented", Stat: "Stat", StatGrid: "StatGrid" }));
// 탭 내용 부품은 따로(flowTab 테스트) 본다 — 여기서는 어디에 어떤 값으로 놓이는지만
vi.mock("@/components/flow/FlowTab", () => ({ FlowTab: "FlowTab" }));

const { default: StockDetailScreen } = await import("@/app/stocks/[code]/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { sideWidth } = await import("@/lib/detailLayout");
const { detailTabLabels, PHONE_TABS, WIDE_TABS_BASE } = await import("@/lib/flowView");

const samsung = (): RegisteredWithQuote & { registered?: boolean } => ({ ...holding("005930", quote("005930", 270_000, { change: -15_500, changeRate: -5.43 }), 120, 71_000, {}, "삼성전자"), registered: true });
const apple = (): RegisteredWithQuote & { registered?: boolean } => ({
  ...holding("AAPL", quote("AAPL", 254.4, { currency: "USD", change: -4.1, changeRate: -1.59, fxRate: 1391.5 }), 30, 180, {}, "애플"),
  market: "NASDAQ",
  registered: true,
});

/** 휴대폰 360·475 · 좌우(폴드8 펼침 가로) · 윗줄+아랫줄(울트라 펼침 세로) · 펼침 세로(폴드8) */
const SIZES = { phone360: [360, 752, false], phone475: [475, 751, false], split: [933, 704, true], rows: [859, 882, true], wide: [704, 861, true] } as const;
type SizeKey = keyof typeof SIZES;

function open(size: SizeKey, o: { flow?: boolean; tab?: string; stock?: () => RegisteredWithQuote; fontScale?: number } = {}) {
  const [width, height, fold] = SIZES[size];
  h.win = { width, height, scale: 2.625, fontScale: o.fontScale ?? 1 };
  h.flags = { foldLayout: fold, ...(o.flow === undefined ? {} : { flowTab: o.flow }) };
  h.params = { code: (o.stock ?? samsung)().code, ...(o.tab ? { tab: o.tab } : {}) };
  h.stock = (o.stock ?? samsung)();
  forgetWindowClass();
  return render(<StockDetailScreen />);
}
type R = ReturnType<typeof render>;
const seg = (r: R) => r.all().find((n) => n.type === "Segmented") ?? null;
const flowTabs = (r: R) => r.all().filter((n) => n.type === "FlowTab");
const strip = (v: unknown): unknown => {
  if (typeof v === "function") return "[fn]";
  if (React.isValidElement(v)) return { el: String((v.type as { name?: string }).name ?? v.type), props: strip(v.props) };
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)]));
  return v;
};
const tree = (nodes: (HostNode | string)[]): unknown => nodes.map((n) => (typeof n === "string" ? n : { type: n.type, props: strip({ ...n.props, children: undefined }), children: tree(n.children) }));

beforeEach(() => {
  flowCalls.length = 0;
  h.setParams.mockClear();
  forgetWindowClass();
});

describe("꺼짐(없음·false): 지금 그대로", () => {
  it("다섯 배치: 탭 목록이 지금과 같은 내용, 수급 칸 없음, 서버에 묻지 않음", () => {
    for (const size of Object.keys(SIZES) as SizeKey[]) {
      for (const flow of [undefined, false]) {
        const r = open(size, { flow });
        expect(flowTabs(r), size).toHaveLength(0);
        expect(r.all().some((n) => n.props.testID === "rows-flow"), size).toBe(false);
        const s = seg(r);
        if (size === "rows") expect(s).toBeNull();
        else expect(s!.props.options, size).toEqual(size.startsWith("phone") ? PHONE_TABS : WIDE_TABS_BASE);
      }
    }
    expect(flowCalls).toEqual([]);
  });

  it("주소 tab=flow 로 열어도 기본 탭과 같은 트리 (휴대폰 기업개요 · 넓은 창 최근 브리핑)", () => {
    for (const size of Object.keys(SIZES) as SizeKey[]) {
      expect(tree(open(size, { tab: "flow" }).tree), size).toEqual(tree(open(size).tree));
      expect(tree(open(size, { tab: "flow", flow: false }).tree), size).toEqual(tree(open(size).tree));
    }
  });
});

describe("켜짐: 탭 끝 '수급'", () => {
  it("휴대폰 360: D 벌 이름 + 화면 읽기는 원래 이름, 누르면 수급 탭 (코드·한국·폭 360)", () => {
    const r = open("phone360", { flow: true });
    const s = seg(r)!;
    expect(s.props.options).toEqual(detailTabLabels("phone", 360, 1).options);
    expect((s.props.options as Array<{ label: string }>).map((o) => o.label)).toEqual(["기업개요", "가치분석", "기술분석", "뉴스", "수급"]);
    expect((s.props.options as Array<{ a11y: string }>).map((o) => o.a11y)).toEqual(["기업개요", "가치분석", "기술분석", "뉴스·공시", "수급, 투자자별 매매"]);
    expect(s.props.value).toBe("company");
    expect(flowTabs(r)).toHaveLength(0);
    r.act(() => (s.props.onChange as (v: string) => void)("flow"));
    expect(seg(r)!.props.value).toBe("flow");
    const f = flowTabs(r);
    expect(f).toHaveLength(1);
    expect(f[0]!.props).toMatchObject({ code: "005930", us: false, width: 360 });
    // 휴대폰은 주소 검색어에 남기지 않는다 (지금 다른 탭과 같게)
    expect(h.setParams).not.toHaveBeenCalled();
  });

  it("휴대폰 475 × 100% 는 A 벌 · 130% 는 D 벌 · 200% 는 C 벌", () => {
    const labels = (fontScale: number) => (seg(open("phone475", { flow: true, fontScale }))!.props.options as Array<{ label: string }>).map((o) => o.label).join(" · ");
    expect(labels(1)).toBe("기업개요 · 가치분석 · 기술분석 · 뉴스·공시 · 수급");
    expect(labels(1.3)).toBe("기업개요 · 가치분석 · 기술분석 · 뉴스 · 수급");
    expect(labels(2)).toBe("기업 · 가치 · 기술 · 뉴스 · 수급");
  });

  it("주소 tab=flow 로 열면 수급 탭 (휴대폰 · 좌우 오른쪽 칸 폭 · 펼침 세로 창 폭)", () => {
    expect(flowTabs(open("phone475", { flow: true, tab: "flow" }))[0]!.props).toMatchObject({ width: 475 });
    const split = open("split", { flow: true, tab: "flow" });
    expect(seg(split)!.props.value).toBe("flow");
    expect(flowTabs(split)[0]!.props).toMatchObject({ code: "005930", us: false, width: sideWidth(1) });
    expect((seg(split)!.props.options as Array<{ label: string }>).map((o) => o.label)).toEqual(["브리핑", "뉴스", "기업", "가치", "기술", "수급"]);
    const wide = open("wide", { flow: true, tab: "flow" });
    expect(flowTabs(wide)[0]!.props).toMatchObject({ width: 704 });
    expect((seg(wide)!.props.options as Array<{ label: string }>).map((o) => o.label)).toEqual(["브리핑", "뉴스·공시", "기업개요", "가치", "기술", "수급"]);
  });

  it("넓은 창에서 수급 탭을 고르면 주소 검색어에 tab=flow (접고 펼 때 이어지게)", () => {
    const r = open("wide", { flow: true });
    expect(seg(r)!.props.value).toBe("briefing");
    r.act(() => (seg(r)!.props.onChange as (v: string) => void)("flow"));
    expect(h.setParams).toHaveBeenCalledWith({ tab: "flow" });
    expect(flowTabs(r)).toHaveLength(1);
  });

  it("윗줄+아랫줄: 탭이 없어 아랫줄 다음에 전체 폭 '수급' 칸", () => {
    const r = open("rows", { flow: true });
    const block = r.all().find((n) => n.props.testID === "rows-flow")!;
    expect(block).toBeTruthy();
    const f = r.all(block.children).filter((n) => n.type === "FlowTab");
    expect(f).toHaveLength(1);
    expect(f[0]!.props).toMatchObject({ code: "005930", us: false, width: 859 });
    expect(r.all(block.children).some((n) => n.props.accessibilityRole === "header")).toBe(true);
  });

  it("미국 종목도 탭은 있고 us: true 로 (부품이 서버에 묻지 않고 '해당 없음')", () => {
    const f = flowTabs(open("phone360", { flow: true, tab: "flow", stock: apple }));
    expect(f[0]!.props).toMatchObject({ code: "AAPL", us: true });
  });

  it("켜진 채 tab=flow 로 열었다가 꺼지면 기본 탭", () => {
    const r = open("wide", { flow: true, tab: "flow" });
    expect(flowTabs(r)).toHaveLength(1);
    h.flags = { ...h.flags, flowTab: false };
    r.rerender();
    expect(flowTabs(r)).toHaveLength(0);
    expect(seg(r)!.props.value).toBe("briefing");
    expect(seg(r)!.props.options).toEqual(WIDE_TABS_BASE);
  });
});
