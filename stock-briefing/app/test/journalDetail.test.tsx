import { createHash } from "node:crypto";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 매매일지 입구 — 종목 상세 (3-37, 기능 플래그 tradeJournal · tradeRecords 둘 다 켜져 있을 때만).
 *  - 끔: 트리가 지금과 한 글자도 같다 (바꾸기 전 main 코드에서 뜬 지문 — 휴대폰 · 좌우 · 펼침 세로 · 윗줄+아랫줄)
 *  - 휴대폰 '잔고' 칸 맨 아래 '이 종목 매매 기록 ›' 한 줄(높이 44), 넓은 창은 '내 보유' 제목 오른쪽 '매매 기록 ›'
 *  - 지금 안 갖고 있지만 기록이 있는 종목: '시세' 칸 아래 작은 칸 '매매 기록 · 보유 없음 · 저장된 체결 3건 ›'
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean | undefined>,
  stock: undefined as unknown,
  journalStock: undefined as unknown,
  journalCalls: [] as string[],
  push: vi.fn(),
  afterCost: false,
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
  useLocalSearchParams: () => ({ code: (h.stock as { code?: string } | undefined)?.code ?? "005930" }),
  usePathname: () => "/stocks/005930",
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
const idle = { data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined };
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
  // 3-33 수급 탭 (main): 윗줄+아랫줄 배치는 아래 전체 폭 칸에 늘 그린다 — 받는 중으로
  useInvestorFlow: () => ({ ...idle, isLoading: true }),
  useJournalStock: (code: string, enabled: boolean) => {
    if (enabled) h.journalCalls.push(code);
    return { ...idle, data: enabled ? h.journalStock : undefined };
  },
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false, afterCost: h.afterCost, sort: "created", apiUrl: "http://x" }) }));
vi.mock("@/lib/holdingsNav", async (orig) => ({ ...(await orig<typeof import("@/lib/holdingsNav")>()), useHoldingsNav: () => null, useCachedRow: () => null }));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 }, parseCandlePeriod: () => "D" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: Date.parse("2026-09-28T10:12:05+09:00"), feedOk: true }) }));
vi.mock("@/components/Skeleton", () => ({ DetailSkeleton: "DetailSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen", Disclaimer: "Disclaimer" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Chip: "Chip", ErrorView: "ErrorView", LiveDot: "LiveDot", Loading: "Loading", Muted: "Muted", SectionTitle: "SectionTitle", Segmented: "Segmented", Stat: "Stat", StatGrid: "StatGrid" }));

const { default: StockDetailScreen } = await import("@/app/stocks/[code]/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");

const FULL = { open: 83_500, high: 84_900, low: 82_800, prevClose: 83_100, volume: 14_832_110, marketCap: 503e12, per: 14.82, pbr: 1.41, eps: 5_688, bps: 59_786, high52w: 88_800, low52w: 53_000 };
type Detail = RegisteredWithQuote & { registered?: boolean };
const samsung = (): Detail => ({ ...holding("005930", quote("005930", 84_300, { ...FULL, change: 1_200, changeRate: 1.44 }), 120, 71_000, {}, "삼성전자"), registered: true, memo: "장기 보유" });
const kakao = (): Detail => ({ ...holding("035720", quote("035720", 41_000, { change: -300, changeRate: -0.73 }), null, null, {}, "카카오"), registered: true });
const CASES = { samsung, kakao } as const;

const SIZES = {
  phone475: [475, 751, false],
  split: [933, 704, true],
  rows: [859, 882, true],
  wide: [704, 861, true],
} as const;
type SizeKey = keyof typeof SIZES;

type R = ReturnType<typeof render>;
function open(stock: Detail, size: SizeKey, flags: Record<string, boolean | undefined> = {}) {
  const [width, height, fold] = SIZES[size];
  h.win = { width, height, scale: 2.625, fontScale: 1 };
  h.flags = { foldLayout: fold, ...flags };
  h.stock = stock;
  forgetWindowClass();
  return render(<StockDetailScreen />);
}

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

beforeEach(() => {
  h.flags = {};
  h.afterCost = false;
  h.journalStock = undefined;
  h.journalCalls = [];
  h.push.mockReset();
  forgetWindowClass();
});

/** 바꾸기 전 main(2793cd1) 코드에서 뜬 지문 */
const BASE: Record<string, string> = {
  "phone475 samsung": "97949c9a13a15576edf3a6c848cf5b644720ebf8",
  "phone475 kakao": "9fa4f943d2e0dc564bea3939139bfa84de22226d",
  "split samsung": "6cabc519ac5b7076c17a3cff4af49feb976744c0",
  "split kakao": "286eb1f8c5a994e1c69d23eab4762ae88bce058e",
  "rows samsung": "ec455b80eb50078b4954b51e238563d7786ecddd",
  "rows kakao": "23869a162be1e8c563e66ce7c17403ad5e3d61cc",
  "wide samsung": "e2773836e60ca63fb7eaa2585ae5803dde05a03b",
  "wide kakao": "4b8495984d8b8933e02422d30ba6ca6e13d36cfd",
};

/** main fdce7e8 의 종목 상세를 이 틀로 그려 뜬 지문 — 3-33 '수급' 탭(flowTab)이 켜진 상세 */
const BASE_FLOW: Record<string, string> = {
  "phone475 samsung": "d6ba5beba24edf15aaa01bc91f011aeb8bc7a185",
  "split samsung": "a28ad42c5e2a209fb9b28042f77bfc991afd7e3f",
  "rows samsung": "f7ab6453396a68d1d22dcdc71fa530964a18bf1a",
  "wide samsung": "61ea8968267b860fa4bc4937d84690021bdd0aea",
};

describe("매매일지 입구를 끄면 '수급' 탭(main 3-33)이 켜진 종목 상세도 지금과 같다 (지문)", () => {
  for (const size of Object.keys(SIZES) as SizeKey[]) {
    it(`${size} samsung · flowTab`, () => {
      const off = print(open(samsung(), size, { flowTab: true }));
      const key = `${size} samsung`;
      // eslint-disable-next-line no-console
      if (!BASE_FLOW[key]) console.log(`BASE_FLOW ${JSON.stringify(key)}: ${JSON.stringify(off)},`);
      expect(off).toBe(BASE_FLOW[key]);
      expect(print(open(samsung(), size, { flowTab: true, tradeJournal: true }))).toBe(off);
      expect(print(open(samsung(), size, { flowTab: true, tradeRecords: true }))).toBe(off);
    });
  }
});

describe("매매일지 입구를 끄면 종목 상세가 지금과 같다 (지문)", () => {
  for (const size of Object.keys(SIZES) as SizeKey[]) {
    for (const [name, make] of Object.entries(CASES)) {
      it(`${size} ${name}`, () => {
        const off = print(open(make(), size));
        const key = `${size} ${name}`;
        // eslint-disable-next-line no-console
        if (!BASE[key]) console.log(`BASE ${JSON.stringify(key)}: ${JSON.stringify(off)},`);
        expect(off).toBe(BASE[key]);
        expect(print(open(make(), size, { tradeJournal: true }))).toBe(off);
        expect(print(open(make(), size, { tradeRecords: true }))).toBe(off);
        expect(h.journalCalls).toEqual([]);
      });
    }
  }
});

const ON = { tradeJournal: true, tradeRecords: true };
const A11Y = "이 종목 매매 기록 보기";
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const flat = (v: unknown): Record<string, unknown> => Object.assign({}, ...[v].flat(Infinity).filter(Boolean));
const pressStyle = (n: HostNode) => flat(typeof n.props.style === "function" ? (n.props.style as (s: { pressed: boolean }) => unknown)({ pressed: false }) : n.props.style);
const parentOf = (r: R, node: HostNode): HostNode => r.all().find((n) => n.children.includes(node))!;

describe("켜면: 종목 상세 입구 (§4.1 ③)", () => {
  it("휴대폰 '잔고' 칸 맨 아래(메모 줄 아래) '이 종목 매매 기록 ›' 한 줄 — 높이 44, 누르면 이 종목 기록으로 · 보유 종목은 서버에 묻지 않는다", () => {
    const r = open(samsung(), "phone475", ON);
    const row = r.all().find((n) => n.type === "Pressable" && n.props.accessibilityLabel === A11Y)!;
    expect(row).toBeTruthy();
    expect(pressStyle(row).minHeight).toBe(44);
    const panel = parentOf(r, row);
    const kids = panel.children.filter((c): c is HostNode => typeof c !== "string");
    expect(textOf(kids[0]!)).toBe("잔고");
    expect(kids.at(-1)).toBe(row);
    expect(textOf(kids.at(-2)!)).toBe("메모 장기 보유");
    r.act(() => (row.props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/journal?code=005930");
    expect(h.journalCalls).toEqual([]);
  });

  it("지금 안 갖고 있지만 기록이 있으면 '시세' 칸 아래 작은 칸 '매매 기록 · 보유 없음 · 저장된 체결 3건', 기록이 없으면 칸 없음", () => {
    h.journalStock = { enabled: true, code: "035720", name: "카카오", market: "KR", holding: null, orders: 3, buys: 2, sells: 1, realized: { amount: 12_000, currency: "KRW", sells: 1, unknown: 0 }, firstTrade: "2026-09-01", lastTrade: "2026-09-20", recordSince: "2026-09-28", memo: null };
    const r = open(kakao(), "phone475", ON);
    expect(h.journalCalls).toContain("035720");
    const panel = r.all().find((n) => n.props.testID === "journal-stock-panel")!;
    expect(textOf(panel)).toBe("매매 기록보유 없음 · 저장된 체결 3건");
    expect(r.all().some((n) => n.props.accessibilityLabel === A11Y)).toBe(false);
    h.journalStock = { ...(h.journalStock as object), orders: 0 };
    expect(open(kakao(), "phone475", ON).all().some((n) => n.props.testID === "journal-stock-panel")).toBe(false);
    h.journalStock = { enabled: false };
    expect(open(kakao(), "phone475", ON).all().some((n) => n.props.testID === "journal-stock-panel")).toBe(false);
  });

  for (const size of ["split", "rows", "wide"] as const) {
    it(`넓은 창(${size}): '내 보유' 제목 오른쪽 '매매 기록 ›'`, () => {
      const r = open(samsung(), size, ON);
      const link = r.all().filter((n) => n.props.testID === "journal-stock-link");
      expect(link).toHaveLength(1);
      expect(textOf(link[0]!)).toBe("매매 기록");
      const title = parentOf(r, link[0]!);
      expect(textOf(title).startsWith("내 보유")).toBe(true);
      r.act(() => (link[0]!.props.onPress as () => void)());
      expect(h.push).toHaveBeenLastCalledWith("/journal?code=005930");
    });

    it(`회귀: 넓은 창(${size})에서 '내 보유' 제목 줄에 숫자 기준 안내(매도 비용 차감)가 있으면 링크를 제목 줄에 넣지 않고 칸 맨 아래 한 줄로 — 안내가 잘리지 않게`, () => {
      h.afterCost = true;
      const cost = (): Detail => {
        const s = samsung();
        return { ...s, evaluation: { ...s.evaluation!, afterCost: { marketValue: 10_000_000, profit: 1_480_000, profitRate: 17.37 } } };
      };
      const r = open(cost(), size, ON);
      expect(r.all().some((n) => n.props.testID === "journal-stock-link")).toBe(false);
      // 안내 글이 있는 제목 줄에는 안내만 (다른 누를 것 없음)
      const note = r.all().find((n) => n.type === "Text" && /비용 차감/.test(textOf(n)) && n.props.numberOfLines === 1)!;
      expect(note).toBeTruthy();
      const titleRow = parentOf(r, note);
      expect(textOf(titleRow).startsWith("내 보유")).toBe(true);
      expect(titleRow.children.filter((c) => typeof c !== "string" && c.type === "Pressable")).toHaveLength(0);
      // 칸 맨 아래 '이 종목 매매 기록 ›' 한 줄 (높이 44)
      const row = r.all().filter((n) => n.props.testID === "journal-stock-row");
      expect(row).toHaveLength(1);
      expect(pressStyle(row[0]!).minHeight).toBe(44);
      r.act(() => (row[0]!.props.onPress as () => void)());
      expect(h.push).toHaveBeenLastCalledWith("/journal?code=005930");
      // 플래그를 끄면 줄도 없음
      expect(open(cost(), size, {}).all().some((n) => n.props.testID === "journal-stock-row")).toBe(false);
    });
  }
});
