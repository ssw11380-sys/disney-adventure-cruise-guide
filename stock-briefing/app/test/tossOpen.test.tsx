import { createHash } from "node:crypto";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Market, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 토스에서 열기 (3-48, 기능 플래그 tossOpen — 사용자 결정 A: 버튼만, 주문은 사용자가 토스 앱에서 직접).
 *  - 주소 만들기(lib/tossLink): 한국은 접두사 없는 코드(토스가 주식·ETF 는 A, ETN 은 Q 를 스스로 붙인다 — A 를 붙이면 ETN 은 없는 종목 창),
 *    미국은 토스 상품 코드가 있으면 그것, 없으면 티커(토스 공개 주소가 티커를 받는다). 지수·환율·시장 모름·하이픈 티커는 주소 없음 = 버튼 없음
 *  - 종목 상세 '시세' 칸 제목 줄 오른쪽 [↗ 토스에서 열기] (휴대폰 · 좌우 · 윗줄+아랫줄 · 펼침 세로 모두 같은 자리)
 *  - 끄면 트리가 지금과 한 글자도 같다 (바꾸기 전 코드에서 뜬 지문 — 휴대폰 화면은 stockDetailFold 스냅숏도 그대로)
 *  - 누르면 Linking.openURL(주소) 한 번, 못 열면 차분한 한국어 안내 창
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean | undefined>,
  stock: undefined as unknown,
  openURL: vi.fn(async (_url: string) => true as unknown),
  alert: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Alert: { alert: h.alert },
  Linking: { openURL: h.openURL },
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
  router: { back: vi.fn(), dismissTo: vi.fn(), push: vi.fn(), navigate: vi.fn(), replace: vi.fn(), setParams: vi.fn(), canGoBack: () => true, canDismiss: () => true },
  useLocalSearchParams: () => ({ code: "005930" }),
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
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false, afterCost: false, sort: "created", apiUrl: "http://x" }) }));
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
const { font, fontCap, foldDetail, space, touch } = await import("@/tokens");
const { estimateTextWidth } = await import("@/lib/chartLayout");
const { sideWidth, splitColumns, statColumns } = await import("@/lib/detailLayout");

// lib/tossLink 는 구현 전에는 없다 (테스트 먼저) — 없으면 이 파일 전체가 빨간불
const link = await import("@/lib/tossLink");
const { tossStockUrl, TOSS_OPEN } = link;

const A11Y = "토스증권에서 이 종목 열기";
const BASE = "https://www.tossinvest.com/stocks/";

/** 결과 트리를 비교할 수 있는 값으로 (stockDetailFold 와 같은 방식): 함수는 '[fn]', 속성으로 넘긴 요소는 이름과 속성만 */
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
/** 트리 지문 (바꾸기 전 코드에서 뜬 값과 같아야 한다) */
const print = (nodes: (HostNode | string)[]) => createHash("sha1").update(JSON.stringify(tree(nodes))).digest("hex");
const nodeText = (n: HostNode): string => n.children.map((c) => (typeof c === "string" ? c : nodeText(c))).join("");
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));

// ── 종목 ──
const FULL = { open: 83_500, high: 84_900, low: 82_800, prevClose: 83_100, volume: 14_832_110, marketCap: 503e12, per: 14.82, pbr: 1.41, eps: 5_688, bps: 59_786, high52w: 88_800, low52w: 53_000 };
type Detail = RegisteredWithQuote & { registered?: boolean };
const samsung = (): Detail => ({ ...holding("005930", quote("005930", 84_300, { ...FULL, change: 1_200, changeRate: 1.44 }), 120, 71_000, {}, "삼성전자"), registered: true });
const apple = (): Detail => ({
  ...holding("AAPL", quote("AAPL", 254.4, { currency: "USD", change: -4.1, changeRate: -1.59, fxRate: 1391.5, open: 256, high: 257, low: 253, prevClose: 258.5, volume: 48_210_000, marketCap: 3.78e12 }), 30, 180, {}, "애플"),
  market: "NASDAQ",
  registered: true,
});
const kakao = (): Detail => ({ ...holding("035720", quote("035720", 41_000, { change: -300, changeRate: -0.73 }), null, null, {}, "카카오"), registered: false });
const withMarket = (s: Detail, code: string, market: Market): Detail => ({ ...s, code, market, quote: s.quote ? { ...s.quote, code } : null });
const CASES = { samsung, apple, kakao } as const;

/** 창 크기 (앱이 쓰는 창) → 배치: 휴대폰 · 좌우(폴드8 펼침 가로) · 윗줄+아랫줄(울트라 펼침 세로) · 펼침 세로(폴드8) */
const SIZES = {
  phone360: [360, 752, false],
  phone475: [475, 751, false],
  split: [933, 704, true],
  rows: [859, 882, true],
  wide: [704, 861, true],
} as const;
type SizeKey = keyof typeof SIZES;

function open(stock: Detail, size: SizeKey, flags: Record<string, boolean | undefined> = {}, fontScale = 1) {
  const [width, height, fold] = SIZES[size];
  h.win = { width, height, scale: 2.625, fontScale };
  h.flags = { foldLayout: fold, ...flags };
  h.stock = stock;
  forgetWindowClass();
  return render(<StockDetailScreen />);
}
const buttons = (r: ReturnType<typeof render>) => r.all().filter((n) => n.props.accessibilityLabel === A11Y);

beforeEach(() => {
  h.flags = {};
  h.openURL.mockReset();
  h.openURL.mockImplementation(async () => true);
  h.alert.mockReset();
  forgetWindowClass();
});

// ───────────────────────────── 주소 만들기 ─────────────────────────────

describe("토스 종목 주소 (tossStockUrl)", () => {
  it("한국: 접두사 없는 코드 (주식·ETF·영문 섞인 새 코드·ETN 모두 — 토스가 A/Q 를 스스로 붙인다)", () => {
    expect(tossStockUrl({ code: "005930", market: "KOSPI" })).toBe(`${BASE}005930`);
    expect(tossStockUrl({ code: "247540", market: "KOSDAQ" })).toBe(`${BASE}247540`);
    expect(tossStockUrl({ code: "069500", market: "KOSPI" })).toBe(`${BASE}069500`);
    expect(tossStockUrl({ code: "0162Z0", market: "KOSPI" })).toBe(`${BASE}0162Z0`);
    // ETN: 'A530134' 는 토스에서 '지원하지 않거나 상장 폐지된 주식' 창 → A 를 붙이지 않는다
    expect(tossStockUrl({ code: "530134", market: "KOSPI" })).toBe(`${BASE}530134`);
    expect(tossStockUrl({ code: "005930", market: "KOSPI" })).not.toContain("A005930");
  });

  it("한국: 서버 상품 코드(A…)를 받아도 쓰지 않는다 (ETN 에서 틀린 주소가 된다)", () => {
    expect(tossStockUrl({ code: "530134", market: "KOSPI", productCode: "A530134" })).toBe(`${BASE}530134`);
    expect(tossStockUrl({ code: "005930", market: "KOSPI", productCode: "A005930" })).toBe(`${BASE}005930`);
  });

  it("미국: 상품 코드가 없으면 티커 (토스 공개 주소가 티커를 받아 상품 코드로 푼다)", () => {
    expect(tossStockUrl({ code: "TSLA", market: "NASDAQ" })).toBe(`${BASE}TSLA`);
    expect(tossStockUrl({ code: "AAPL", market: "NASDAQ" })).toBe(`${BASE}AAPL`);
    expect(tossStockUrl({ code: "JPM", market: "NYSE" })).toBe(`${BASE}JPM`);
    expect(tossStockUrl({ code: "SOXL", market: "AMEX" })).toBe(`${BASE}SOXL`);
    expect(tossStockUrl({ code: "O", market: "US" })).toBe(`${BASE}O`);
    // 점 표기(토스 마스터·검색이 주는 모양)는 토스가 그대로 푼다
    expect(tossStockUrl({ code: "BRK.B", market: "NYSE" })).toBe(`${BASE}BRK.B`);
  });

  it("미국: 토스 상품 코드가 있으면 그것 (US…·NAS…·AMX…·NYS…), 모양이 다르면 버리고 티커", () => {
    expect(tossStockUrl({ code: "TSLA", market: "NASDAQ", productCode: "US20100629001" })).toBe(`${BASE}US20100629001`);
    expect(tossStockUrl({ code: "TSLR", market: "NASDAQ", productCode: "NAS0230822008" })).toBe(`${BASE}NAS0230822008`);
    expect(tossStockUrl({ code: "SOXL", market: "AMEX", productCode: "AMX0100311002" })).toBe(`${BASE}AMX0100311002`);
    for (const bad of ["", "A005930", "US123", "us20100629001", "US20100629001/order", "../x", null, undefined]) {
      expect(tossStockUrl({ code: "TSLA", market: "NASDAQ", productCode: bad }), String(bad)).toBe(`${BASE}TSLA`);
    }
    // 상품 코드는 토스가 준 것이라 티커 모양(하이픈)과 상관없이 맞다
    expect(tossStockUrl({ code: "BRK-B", market: "NYSE", productCode: "US20100121001" })).toBe(`${BASE}US20100121001`);
  });

  it("주소를 확실히 만들 수 없으면 null (버튼 없음 — 틀린 종목 페이지를 추측해 열지 않는다)", () => {
    // 야후식 하이픈 티커: 토스는 'BRK-B' 를 모른다 (점으로 바꿔 추측하지 않는다)
    expect(tossStockUrl({ code: "BRK-B", market: "NYSE" })).toBeNull();
    // 지수·환율 (지수 화면 코드) — 시장이 무엇이든
    for (const code of ["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "DJI", "SOX", "USDKRW", "JPYKRW", "CNYKRW"]) {
      for (const market of ["KOSPI", "NASDAQ", "US", "UNKNOWN", null] as const) expect(tossStockUrl({ code, market }), `${code} ${market}`).toBeNull();
    }
    // 시장 모름 · 시장과 코드가 안 맞음
    expect(tossStockUrl({ code: "005930", market: "UNKNOWN" })).toBeNull();
    expect(tossStockUrl({ code: "TSLA", market: "UNKNOWN" })).toBeNull();
    expect(tossStockUrl({ code: "TSLA", market: null })).toBeNull();
    expect(tossStockUrl({ code: "TSLA", market: "KOSPI" })).toBeNull();
    expect(tossStockUrl({ code: "005930", market: "NASDAQ" })).toBeNull();
    // 이상한 코드 (소문자·빈 값·경로 문자)
    for (const code of ["", "tsla", "005930/../x", "TS LA", "A".repeat(11), "00593"]) {
      expect(tossStockUrl({ code, market: "NASDAQ" }), code).toBeNull();
      expect(tossStockUrl({ code, market: "KOSPI" }), code).toBeNull();
    }
  });

  it("버튼 글·화면 읽기 이름은 매수·매도 권유로 읽히지 않는다", () => {
    expect(TOSS_OPEN.label).toBe("토스에서 열기");
    expect(TOSS_OPEN.a11y).toBe(A11Y);
    for (const s of [TOSS_OPEN.label, TOSS_OPEN.a11y, TOSS_OPEN.failTitle, TOSS_OPEN.failBody]) expect(s).not.toMatch(/매수|매도|구매|주문|사세요|파세요/);
  });
});

// ───────────────────────────── 끄면 지금 그대로 ─────────────────────────────

describe("플래그 꺼짐(없음·false): 버튼이 없고 트리가 지금과 같다", () => {
  // 바꾸기 전 코드(main b081800)에서 뜬 트리 지문 — 휴대폰 두 크기·좌우·윗줄+아랫줄·펼침 세로 × 보유(KR)·미국·미등록
  it("다섯 배치 × 세 종목의 지문이 바꾸기 전과 같다", () => {
    const got: Record<string, string> = {};
    for (const size of Object.keys(SIZES) as SizeKey[]) {
      for (const [name, make] of Object.entries(CASES)) {
        const off = open(make(), size);
        expect(buttons(off), `${size} ${name}`).toHaveLength(0);
        expect(off.text(), `${size} ${name}`).not.toContain(TOSS_OPEN.label);
        const offFalse = open(make(), size, { tossOpen: false });
        expect(tree(offFalse.tree), `${size} ${name} false = 없음`).toEqual(tree(off.tree));
        got[`${size} ${name}`] = print(off.tree);
      }
    }
    expect(got).toMatchSnapshot();
  });
});

// ───────────────────────────── 켜면 '시세' 제목 줄에 버튼 ─────────────────────────────

describe("켜짐: '시세' 칸 제목 줄 오른쪽 [↗ 토스에서 열기]", () => {
  it("휴대폰 475·360: 버튼 하나, 역할 link · 이름 '토스증권에서 이 종목 열기' · 아이콘 open-outline · 글 '토스에서 열기'", () => {
    for (const size of ["phone475", "phone360"] as const) {
      const r = open(samsung(), size, { tossOpen: true });
      const b = buttons(r);
      expect(b, size).toHaveLength(1);
      expect(b[0]!.type).toBe("Pressable");
      expect(b[0]!.props.accessibilityRole).toBe("link");
      expect(nodeText(b[0]!)).toBe("토스에서 열기");
      const icon = b[0]!.children.find((c): c is HostNode => typeof c !== "string" && c.type === "Ionicons");
      expect(icon?.props.name).toBe("open-outline");
      // '시세' 제목과 같은 줄 (한 부모 아래 가로 줄)
      const row = r.all().find((n) => n.children.includes(b[0]!))!;
      expect(flat(row).flexDirection).toBe("row");
      expect(row.children.some((c) => typeof c !== "string" && nodeText(c) === "시세")).toBe(true);
    }
  });

  // 선언값 44. 아래 형제와 겹치는 몫(휴대폰 약 4.5 · 넓은 창 약 6.5)은 안드로이드에서 아래 칸이 받아 실제는 약 40 · 38 ('더 보기'와 같은 방식 — 문서에 그대로 적음)
  it("보이는 높이 + hitSlop 위아래 = 44 이상 (선언값)", () => {
    const b = buttons(open(samsung(), "phone475", { tossOpen: true }))[0]!;
    const slop = b.props.hitSlop as { top: number; bottom: number; left: number; right: number };
    const st = flat(b);
    const visible = font.small * 1.35 + ((st.paddingVertical as number) ?? 0) * 2;
    expect(visible + slop.top + slop.bottom).toBeGreaterThanOrEqual(touch.min);
    // 좌우는 이웃과 겹치지 않을 만큼만
    expect(slop.left).toBeLessThanOrEqual(space.sm);
  });

  it("좌우 · 윗줄+아랫줄 · 펼침 세로: 같은 버튼이 하나씩 ('시세' 칸 제목 줄)", () => {
    for (const size of ["split", "rows", "wide"] as const) {
      for (const [name, make] of Object.entries(CASES)) {
        const r = open(make(), size, { tossOpen: true });
        const b = buttons(r);
        expect(b, `${size} ${name}`).toHaveLength(1);
        const row = r.all().find((n) => n.children.includes(b[0]!))!;
        expect(row.children.some((c) => typeof c !== "string" && nodeText(c) === "시세"), `${size} ${name}`).toBe(true);
      }
    }
  });

  it("버튼 말고는 꺼짐과 같다: 켜짐 트리에서 버튼을 빼면 (휴대폰은 제목 줄을 풀면) 꺼짐 트리", () => {
    const strip = (nodes: (HostNode | string)[]): (HostNode | string)[] =>
      nodes.flatMap((n) => {
        if (typeof n === "string") return [n];
        if (n.props.accessibilityLabel === A11Y) return [];
        const kids = strip(n.children);
        // 휴대폰: 제목 줄 View 를 풀어 '시세' Text 만 남긴다
        if (n.props.testID === "toss-title-row") return kids;
        return [{ ...n, children: kids, props: { ...n.props, children: undefined } }];
      });
    const norm = (nodes: (HostNode | string)[]): unknown => tree(strip(nodes));
    for (const size of Object.keys(SIZES) as SizeKey[]) {
      for (const [name, make] of Object.entries(CASES)) {
        const on = open(make(), size, { tossOpen: true });
        const off = open(make(), size);
        expect(norm(on.tree), `${size} ${name}`).toEqual(norm(off.tree));
      }
    }
  });

  it("주소가 없는 종목(하이픈 티커 · 시장 모름)은 켜져 있어도 버튼이 없고 트리가 꺼짐과 같다", () => {
    const brk = () => withMarket(apple(), "BRK-B", "NYSE");
    const unknown = () => withMarket(samsung(), "005930", "UNKNOWN");
    for (const size of Object.keys(SIZES) as SizeKey[]) {
      for (const make of [brk, unknown]) {
        const on = open(make(), size, { tossOpen: true });
        expect(buttons(on), size).toHaveLength(0);
        expect(tree(on.tree), size).toEqual(tree(open(make(), size).tree));
      }
    }
  });

  it("휴대폰에서 시세를 못 받으면 '시세' 칸이 없어 버튼도 없다 (알려진 빈틈 — 시세 오류 글만)", () => {
    const noQuote = { ...samsung(), quote: null, quoteError: "시세 서버 오류", evaluation: null };
    const r = open(noQuote, "phone475", { tossOpen: true });
    expect(buttons(r)).toHaveLength(0);
    expect(r.text()).toContain("시세 서버 오류");
  });
});

// ───────────────────────────── 누르기 ─────────────────────────────

describe("누르면 토스증권 종목 주소를 연다", () => {
  const press = (r: ReturnType<typeof render>) => (buttons(r)[0]!.props.onPress as () => void)();
  const settle = () => new Promise((res) => setTimeout(res, 0));

  it("한국(삼성전자) · 미국(애플) · 미등록(카카오): Linking.openURL 에 그 종목 주소 한 번", async () => {
    const want = { samsung: `${BASE}005930`, apple: `${BASE}AAPL`, kakao: `${BASE}035720` } as const;
    for (const size of ["phone475", "split", "wide"] as const) {
      for (const [name, make] of Object.entries(CASES)) {
        h.openURL.mockClear();
        press(open(make(), size, { tossOpen: true }));
        await settle();
        expect(h.openURL.mock.calls, `${size} ${name}`).toEqual([[want[name as keyof typeof want]]]);
      }
    }
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("점 표기 미국 티커(BRK.B)는 그대로 연다", async () => {
    press(open(withMarket(apple(), "BRK.B", "NYSE"), "phone475", { tossOpen: true }));
    await settle();
    expect(h.openURL).toHaveBeenCalledWith(`${BASE}BRK.B`);
  });

  it("못 열면(받을 앱 없음) 앱을 끄지 않고 차분한 한국어 안내 창 하나", async () => {
    h.openURL.mockImplementation(async () => {
      throw new Error("No Activity found to handle Intent");
    });
    press(open(samsung(), "phone475", { tossOpen: true }));
    await settle();
    expect(h.alert).toHaveBeenCalledTimes(1);
    const [title, body] = h.alert.mock.calls[0]! as [string, string];
    expect(title).toBe("토스증권을 열지 못했습니다");
    expect(body).toMatch(/[가-힣]/);
    expect(body).not.toMatch(/Error|Intent|Activity|undefined/);
  });

  it("여는 함수(openTossPage): 성공 true · 실패 false + 안내 한 번", async () => {
    const fail = vi.fn();
    await expect(link.openTossPage(`${BASE}005930`, { open: async () => true, fail })).resolves.toBe(true);
    expect(fail).not.toHaveBeenCalled();
    await expect(link.openTossPage(`${BASE}005930`, { open: async () => Promise.reject(new Error("x")), fail })).resolves.toBe(false);
    expect(fail).toHaveBeenCalledWith(TOSS_OPEN.failTitle, TOSS_OPEN.failBody);
    // 동기로 던지는 경우도 삼킨다
    await expect(
      link.openTossPage(`${BASE}005930`, {
        open: () => {
          throw new Error("sync");
        },
        fail,
      }),
    ).resolves.toBe(false);
  });
});

// ───────────────────────────── 자리 어림 ─────────────────────────────

describe("버튼이 '시세' 제목 줄에 들어간다 (앱의 글자 폭 어림)", () => {
  /** 제목 '시세' + 간격 + [아이콘 + 간격 + 글] (버튼 글은 fontCap.chrome 까지만 커진다) */
  const need = (fontScale: number) => {
    const title = estimateTextWidth("시세", font.body * fontScale);
    const btn = link.tossButtonWidth(fontScale);
    return title + space.sm + btn;
  };

  it("버튼 폭 어림: 100% 약 100dp, 글자 150% 넘게 커지지 않는다", () => {
    expect(link.tossButtonWidth(1)).toBeGreaterThan(80);
    expect(link.tossButtonWidth(1)).toBeLessThan(115);
    expect(link.tossButtonWidth(2)).toBe(link.tossButtonWidth(fontCap.chrome));
  });

  it("휴대폰 360·475 (글자 100·130·200%) 시세 칸 안쪽 폭에 들어간다", () => {
    for (const w of [360, 411, 475]) for (const s of [1, 1.3, 2]) expect(need(s), `${w} ${s}`).toBeLessThanOrEqual(w - space.lg * 2);
  });

  it("좌우 · 윗줄+아랫줄 오른쪽 칸 (글자 100·130%)", () => {
    for (const s of [1, 1.3]) expect(need(s)).toBeLessThanOrEqual(sideWidth(s) - space.lg * 2);
  });

  it("폴드8 펼침 세로 첫 '시세' 칸 (보유 종목 · 글자 100·130%)", () => {
    for (const s of [1, 1.3]) {
      const inner = 704 - space.lg * 2;
      const n = statColumns(inner, s, 4);
      const holdCol = 1; // 원화 칸이 없는 한국 보유 종목
      const quoteCols = splitColumns(Array.from({ length: 14 }), Math.max(1, n - holdCol)).length;
      const flexSum = foldDetail.holdColFlex + quoteCols;
      const colW = (inner - space.lg * (holdCol + quoteCols - 1)) / flexSum;
      expect(need(s), `글자 ${s * 100}% · 칸 ${Math.round(colW)}`).toBeLessThanOrEqual(colW);
    }
  });
});
