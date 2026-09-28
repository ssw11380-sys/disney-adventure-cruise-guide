import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Market, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 토스 앱 열기 (3-48, 기능 플래그 tossOpen — 사용자 결정 2026-09-28 '토스 앱만 열기').
 *  - 종목 상세 '시세' 칸 제목 줄 오른쪽 [↗ 토스 앱 열기] (휴대폰 · 좌우 · 윗줄+아랫줄 · 펼침 세로 모두 같은 자리). 이름이 있는 종목이면 모두, 지수·환율은 없음
 *  - 누르면 작은 시트: '토스 앱에서 찾기' · '토스 앱 → 증권 → 검색에서 "삼성전자"(005930)을 찾아 주세요. 주문은 토스 앱에서 직접 합니다.' · [토스 앱 열기] [닫기]
 *  - [토스 앱 열기] → Linking.openURL('supertoss://') 한 번 (토스 앱 자체만 — 종목 경로를 추측해 붙이지 않는다, 웹 주소 없음)
 *  - 못 열면 같은 시트에 '토스 앱을 열지 못했습니다. …' + [Play 스토어에서 보기] → market:// → 안 되면 https Play 주소
 *  - 끄면 트리가 지금과 한 글자도 같다 (바꾸기 전 main 코드에서 뜬 지문 — 휴대폰 화면은 stockDetailFold 스냅숏도 그대로)
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
  Modal: "Modal",
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
const lib = await import("@/lib/tossApp");
const { tossAppTarget, tossSheetBody, TOSS_APP } = lib;

const A11Y = "토스 앱 열기, 토스에서 이 종목을 직접 찾아야 합니다";
const TOSS_SCHEME = "supertoss://";
const STORE_APP = "market://details?id=viva.republica.toss";
const STORE_WEB = "https://play.google.com/store/apps/details?id=viva.republica.toss";
const FAIL = "토스 앱을 열지 못했습니다. 토스 앱이 설치되어 있는지 확인해 주세요.";

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
/** 트리 지문 (바꾸기 전 main 코드에서 뜬 값과 같아야 한다) */
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
const withMarket = (s: Detail, code: string, market: Market, name = s.name): Detail => ({ ...s, code, market, name, quote: s.quote ? { ...s.quote, code } : null });
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
type R = ReturnType<typeof render>;
const buttons = (r: R) => r.all().filter((n) => n.props.accessibilityLabel === A11Y);
const sheet = (r: R) => r.all().find((n) => n.type === "Modal") ?? null;
const sheetButtons = (r: R) => (sheet(r) ? [sheet(r)!, ...r.all(sheet(r)!.children)].filter((n) => n.type === "Button") : []);
const sheetButton = (r: R, title: string) => {
  const b = sheetButtons(r).find((n) => n.props.title === title);
  if (!b) throw new Error(`시트에 [${title}] 없음: ${sheetButtons(r).map((n) => n.props.title).join(", ")}`);
  return b;
};
/** 누르기 (버튼·시트 버튼) → 바뀐 상태로 다시 그림 */
const tap = (r: R, n: HostNode) => r.act(() => void (n.props.onPress as () => void)());
/** 여는 함수(Promise)가 끝나기를 기다린 뒤 다시 그림 */
const settle = async (r: R) => {
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));
  r.act(() => undefined);
};
const openSheet = (r: R) => {
  const b = buttons(r);
  expect(b).toHaveLength(1);
  tap(r, b[0]!);
  expect(sheet(r)).not.toBeNull();
};

beforeEach(() => {
  h.flags = {};
  h.openURL.mockReset();
  h.openURL.mockImplementation(async () => true);
  h.alert.mockReset();
  forgetWindowClass();
});

// ───────────────────────────── 누구에게 버튼을 두나 · 시트 글 ─────────────────────────────

describe("버튼을 둘 종목과 시트 글 (lib/tossApp)", () => {
  it("이름이 있는 종목은 모두 (한국 코드 · 미국 티커 · 하이픈 티커 · 시장 모름 상관없이)", () => {
    expect(tossAppTarget({ code: "005930", name: "삼성전자" })).toEqual({ name: "삼성전자", code: "005930" });
    expect(tossAppTarget({ code: "AAPL", name: "애플" })).toEqual({ name: "애플", code: "AAPL" });
    expect(tossAppTarget({ code: "530134", name: "삼성 인버스 2X WTI원유 선물 ETN" })).toEqual({ name: "삼성 인버스 2X WTI원유 선물 ETN", code: "530134" });
    expect(tossAppTarget({ code: "BRK-B", name: "버크셔 해서웨이 B" })).toEqual({ name: "버크셔 해서웨이 B", code: "BRK-B" });
    expect(tossAppTarget({ code: " 035720 ", name: " 카카오 " })).toEqual({ name: "카카오", code: "035720" });
  });

  it("이름이 티커뿐이면 시세가 준 사람이 읽는 이름, 없으면 티커 그대로 (이름을 지어내지 않는다)", () => {
    expect(tossAppTarget({ code: "RGTX", name: "RGTX", fullName: "Defiance Daily Target 2X Long RGTI ETF" })).toEqual({ name: "Defiance Daily Target 2X Long RGTI ETF", code: "RGTX" });
    expect(tossAppTarget({ code: "RGTX", name: "RGTX" })).toEqual({ name: "RGTX", code: "RGTX" });
    expect(tossAppTarget({ code: "BRK.B", name: "BRK-B", fullName: "-" })).toEqual({ name: "BRK-B", code: "BRK.B" });
  });

  it("이름이 없거나 지수·환율이면 null (버튼 없음)", () => {
    for (const name of [null, undefined, "", "  ", "-", "N/A"]) expect(tossAppTarget({ code: "005930", name }), String(name)).toBeNull();
    for (const code of ["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "DJI", "SOX", "VIX", "USDKRW", "JPYKRW", "CNYKRW", "kospi"]) expect(tossAppTarget({ code, name: "코스피" }), code).toBeNull();
    expect(tossAppTarget({ code: "", name: "삼성전자" })).toBeNull();
  });

  it("시트 글: 한국은 이름+코드, 미국은 이름+티커 (작업지시 문장 그대로)", () => {
    expect(tossSheetBody({ name: "삼성전자", code: "005930" })).toBe('토스 앱 → 증권 → 검색에서 "삼성전자"(005930)을 찾아 주세요. 주문은 토스 앱에서 직접 합니다.');
    expect(tossSheetBody({ name: "애플", code: "AAPL" })).toBe('토스 앱 → 증권 → 검색에서 "애플"(AAPL)을 찾아 주세요. 주문은 토스 앱에서 직접 합니다.');
    expect(TOSS_APP.sheetTitle).toBe("토스 앱에서 찾기");
    expect(TOSS_APP.label).toBe("토스 앱 열기");
    expect(TOSS_APP.a11y).toBe(A11Y);
    expect(TOSS_APP.fail).toBe(FAIL);
    expect(TOSS_APP.store).toBe("Play 스토어에서 보기");
  });

  it("여는 주소는 토스 앱 스킴 하나와 Play 스토어 두 개뿐 (종목 경로·웹 주소 없음)", () => {
    expect(lib.TOSS_APP_URL).toBe(TOSS_SCHEME);
    expect([...lib.PLAY_STORE_URLS]).toEqual([STORE_APP, STORE_WEB]);
    expect(Object.keys(lib)).not.toContain("tossStockUrl");
    expect(Object.keys(lib)).not.toContain("TOSS_STOCK_BASE");
  });
});

describe("문구: 투자 권유로 읽히지 않는다", () => {
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const texts = () => {
    const t = { name: "삼성전자", code: "005930" };
    return [TOSS_APP.label, TOSS_APP.a11y, TOSS_APP.sheetTitle, TOSS_APP.open, TOSS_APP.close, TOSS_APP.scrim, TOSS_APP.fail, TOSS_APP.store, TOSS_APP.storeFail, tossSheetBody(t)];
  };

  it("버튼·시트·안내 글에 매수·매도·구매·권유 말이 없다", () => {
    for (const s of texts()) expect(s).not.toMatch(/매수|매도|구매|사세요|파세요|추천|지금 사|수익/);
  });

  it("'주문' 은 '주문은 토스 앱에서 직접 합니다.' 한 문장에만 (이 앱이 주문하지 않는다는 사실)", () => {
    const hits = texts().filter((s) => s.includes("주문"));
    expect(hits).toEqual([tossSheetBody({ name: "삼성전자", code: "005930" })]);
    expect(TOSS_APP.note).toBe("주문은 토스 앱에서 직접 합니다.");
  });

  it("앱 소스에 토스 종목 웹 주소를 만드는 곳·canOpenURL 이 없다 (웹 주소는 폰에서 막다른 화면, canOpenURL 은 새 APK 필요)", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.(ts|tsx)$/.test(n) ? [join(dir, n)] : []));
    const src = files(SRC).map((f) => ({ f, text: readFileSync(f, "utf8") }));
    expect(src.filter((x) => /["'`]https:\/\/(www\.)?tossinvest\.com\/stocks/.test(x.text)).map((x) => x.f)).toEqual([]);
    for (const name of ["lib/tossApp.ts", "components/TossAppButton.tsx", "components/TossAppSheet.tsx"]) {
      const text = readFileSync(join(SRC, name), "utf8");
      expect(text, name).not.toMatch(/canOpenURL\(/);
      expect(text, name).not.toMatch(/fetch\(|useApi|api\./);
    }
  });
});

// ───────────────────────────── 끄면 지금 그대로 ─────────────────────────────

describe("플래그 꺼짐(없음·false): 버튼이 없고 트리가 지금과 같다", () => {
  // 바꾸기 전 코드(main 9206f1e — 이 기능이 없는 코드)에서 뜬 트리 지문 — 휴대폰 두 크기·좌우·윗줄+아랫줄·펼침 세로 × 보유(KR)·미국·미등록
  it("다섯 배치 × 세 종목의 지문이 바꾸기 전과 같다", () => {
    const got: Record<string, string> = {};
    for (const size of Object.keys(SIZES) as SizeKey[]) {
      for (const [name, make] of Object.entries(CASES)) {
        const off = open(make(), size);
        expect(buttons(off), `${size} ${name}`).toHaveLength(0);
        expect(off.text(), `${size} ${name}`).not.toContain(TOSS_APP.label);
        expect(sheet(off)).toBeNull();
        const offFalse = open(make(), size, { tossOpen: false });
        expect(tree(offFalse.tree), `${size} ${name} false = 없음`).toEqual(tree(off.tree));
        got[`${size} ${name}`] = print(off.tree);
      }
    }
    expect(got).toMatchSnapshot();
  });
});

// ───────────────────────────── 켜면 '시세' 제목 줄에 버튼 ─────────────────────────────

describe("켜짐: '시세' 칸 제목 줄 오른쪽 [↗ 토스 앱 열기]", () => {
  it("휴대폰 475·360: 버튼 하나, 역할 button · 이름 '토스 앱 열기, 토스에서 이 종목을 직접 찾아야 합니다' · 아이콘 open-outline · 글 '토스 앱 열기'", () => {
    for (const size of ["phone475", "phone360"] as const) {
      const r = open(samsung(), size, { tossOpen: true });
      const b = buttons(r);
      expect(b, size).toHaveLength(1);
      expect(b[0]!.type).toBe("Pressable");
      expect(b[0]!.props.accessibilityRole).toBe("button");
      expect(nodeText(b[0]!)).toBe("토스 앱 열기");
      const icon = b[0]!.children.find((c): c is HostNode => typeof c !== "string" && c.type === "Ionicons");
      expect(icon?.props.name).toBe("open-outline");
      // '시세' 제목과 같은 줄 (한 부모 아래 가로 줄)
      const row = r.all().find((n) => n.children.includes(b[0]!))!;
      expect(flat(row).flexDirection).toBe("row");
      expect(row.children.some((c) => typeof c !== "string" && nodeText(c) === "시세")).toBe(true);
      // 누르기 전에는 시트·주소 열기 없음
      expect(sheet(r)).toBeNull();
      expect(h.openURL).not.toHaveBeenCalled();
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

  it("하이픈 티커 · 시장 모름 종목도 이름이 있으면 버튼이 있다 (웹 주소를 만들지 않으니 막을 까닭이 없다)", () => {
    for (const size of ["phone475", "split", "wide"] as const) {
      expect(buttons(open(withMarket(apple(), "BRK-B", "NYSE", "버크셔 해서웨이 B"), size, { tossOpen: true })), size).toHaveLength(1);
      expect(buttons(open(withMarket(samsung(), "005930", "UNKNOWN"), size, { tossOpen: true })), size).toHaveLength(1);
    }
  });

  it("이름이 없는 종목 · 지수·환율 코드는 켜져 있어도 버튼이 없고 트리가 꺼짐과 같다", () => {
    const noName = () => withMarket(samsung(), "005930", "KOSPI", "");
    const index = () => withMarket(samsung(), "KOSPI", "KOSPI", "코스피");
    const fx = () => withMarket(apple(), "USDKRW", "UNKNOWN", "원/달러");
    for (const size of Object.keys(SIZES) as SizeKey[]) {
      for (const make of [noName, index, fx]) {
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

// ───────────────────────────── 시트 ─────────────────────────────

describe("누르면 '토스 앱에서 찾기' 시트", () => {
  it("한국(삼성전자)·미국(애플)·미등록(카카오): 제목 · 이름+코드/티커 문장 · 주문 안내 · [토스 앱 열기] [닫기] (주소는 아직 열지 않음)", () => {
    const want = { samsung: '"삼성전자"(005930)', apple: '"애플"(AAPL)', kakao: '"카카오"(035720)' } as const;
    for (const size of ["phone360", "phone475", "split", "rows", "wide"] as const) {
      for (const [name, make] of Object.entries(CASES)) {
        const r = open(make(), size, { tossOpen: true });
        openSheet(r);
        const m = sheet(r)!;
        expect(m.props.visible, `${size} ${name}`).toBe(true);
        expect(m.props.transparent).toBe(true);
        const text = nodeText(m);
        expect(text, `${size} ${name}`).toContain(`토스 앱 → 증권 → 검색에서 ${want[name as keyof typeof want]}을 찾아 주세요.`);
        expect(text).toContain("주문은 토스 앱에서 직접 합니다.");
        const title = r.all(m.children).find((n) => n.props.accessibilityRole === "header")!;
        expect(nodeText(title)).toBe("토스 앱에서 찾기");
        expect(sheetButtons(r).map((b) => b.props.title)).toEqual(["토스 앱 열기", "닫기"]);
        expect(text).not.toContain(FAIL);
      }
    }
    expect(h.openURL).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("이름+코드 부분은 굵게, 문장 전체는 한 글 덩어리 (화면 읽기가 한 번에 읽음)", () => {
    const r = open(apple(), "phone475", { tossOpen: true });
    openSheet(r);
    const body = r.all(sheet(r)!.children).find((n) => n.props.testID === "toss-app-find")!;
    expect(nodeText(body)).toBe('토스 앱 → 증권 → 검색에서 "애플"(AAPL)을 찾아 주세요.');
    const strong = body.children.find((c): c is HostNode => typeof c !== "string")!;
    expect(nodeText(strong)).toBe('"애플"(AAPL)');
    expect(flat(strong).fontWeight).toBe("700");
  });

  it("이름이 티커뿐인 미국 종목은 시세가 준 이름으로 안내", () => {
    const rgtx = (): Detail => ({ ...withMarket(apple(), "RGTX", "NASDAQ", "RGTX"), quote: { ...apple().quote!, code: "RGTX", fullName: "Defiance Daily Target 2X Long RGTI ETF" } });
    const r = open(rgtx(), "phone475", { tossOpen: true });
    openSheet(r);
    expect(nodeText(sheet(r)!)).toContain('검색에서 "Defiance Daily Target 2X Long RGTI ETF"(RGTX)을 찾아 주세요.');
  });

  it("휴대폰은 아래에 붙고, 넓은 창은 가운데 (가격 알림 시트와 같은 모양)", () => {
    const pos = (size: SizeKey) => {
      const r = open(samsung(), size, { tossOpen: true });
      openSheet(r);
      const backdrop = sheet(r)!.children.find((c): c is HostNode => typeof c !== "string")!;
      return flat(backdrop).justifyContent;
    };
    expect(pos("phone360")).toBe("flex-end");
    expect(pos("phone475")).toBe("flex-end");
    expect(pos("split")).toBe("center");
    expect(pos("wide")).toBe("center");
  });

  it("[닫기] · 바깥(어두운 곳) · 뒤로 가기로 닫힌다 (주소 열기 없음)", () => {
    const r = open(samsung(), "phone475", { tossOpen: true });
    openSheet(r);
    tap(r, sheetButton(r, "닫기"));
    expect(sheet(r)).toBeNull();
    openSheet(r);
    tap(r, r.byLabel("토스 앱 안내 닫기"));
    expect(sheet(r)).toBeNull();
    openSheet(r);
    r.act(() => (sheet(r)!.props.onRequestClose as () => void)());
    expect(sheet(r)).toBeNull();
    expect(h.openURL).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── 토스 앱 열기 · 못 열면 Play 스토어 ─────────────────────────────

describe("[토스 앱 열기] → supertoss://, 못 열면 Play 스토어", () => {
  it("열리면 Linking.openURL('supertoss://') 한 번이고 시트가 닫힌다 (한국·미국·미등록 · 휴대폰·좌우·펼침 세로)", async () => {
    for (const size of ["phone475", "split", "wide"] as const) {
      for (const [name, make] of Object.entries(CASES)) {
        h.openURL.mockClear();
        const r = open(make(), size, { tossOpen: true });
        openSheet(r);
        tap(r, sheetButton(r, "토스 앱 열기"));
        await settle(r);
        expect(h.openURL.mock.calls, `${size} ${name}`).toEqual([[TOSS_SCHEME]]);
        expect(sheet(r), `${size} ${name}`).toBeNull();
      }
    }
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("못 열면(토스 앱 없음) 시트에 안내 + [Play 스토어에서 보기] → market:// 로 열고 닫힌다", async () => {
    h.openURL.mockImplementation(async (url: string) => {
      if (url === TOSS_SCHEME) throw new Error("Could not open URL 'supertoss://': No Activity found to handle Intent");
      return true;
    });
    const r = open(samsung(), "phone475", { tossOpen: true });
    openSheet(r);
    tap(r, sheetButton(r, "토스 앱 열기"));
    await settle(r);
    expect(sheet(r)).not.toBeNull();
    const text = nodeText(sheet(r)!);
    expect(text).toContain(FAIL);
    // 안드로이드 오류 글은 보이지 않는다
    expect(text).not.toMatch(/Error|Intent|Activity|undefined|supertoss/);
    // 이름·코드 안내는 그대로 남는다
    expect(text).toContain('"삼성전자"(005930)');
    expect(sheetButtons(r).map((b) => b.props.title)).toEqual(["Play 스토어에서 보기", "닫기"]);
    // 화면 읽기가 바로 읽는 알림 영역
    const region = r.all(sheet(r)!.children).find((n) => n.props.accessibilityRole === "alert")!;
    expect(region.props.accessibilityLiveRegion).toBe("polite");
    expect(region.props.accessibilityLabel).toBe(FAIL);
    tap(r, sheetButton(r, "Play 스토어에서 보기"));
    await settle(r);
    expect(h.openURL.mock.calls).toEqual([[TOSS_SCHEME], [STORE_APP]]);
    expect(sheet(r)).toBeNull();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("Play 스토어 앱이 없으면 https Play 주소로 한 번 더", async () => {
    h.openURL.mockImplementation(async (url: string) => {
      if (url !== STORE_WEB) throw new Error("no");
      return true;
    });
    const r = open(apple(), "split", { tossOpen: true });
    openSheet(r);
    tap(r, sheetButton(r, "토스 앱 열기"));
    await settle(r);
    tap(r, sheetButton(r, "Play 스토어에서 보기"));
    await settle(r);
    expect(h.openURL.mock.calls).toEqual([[TOSS_SCHEME], [STORE_APP], [STORE_WEB]]);
    expect(sheet(r)).toBeNull();
  });

  it("셋 다 못 열면 앱을 끄지 않고 시트에 한 줄 더 (닫기로 닫힘)", async () => {
    h.openURL.mockImplementation(async () => {
      throw new Error("no");
    });
    const r = open(samsung(), "phone360", { tossOpen: true });
    openSheet(r);
    tap(r, sheetButton(r, "토스 앱 열기"));
    await settle(r);
    tap(r, sheetButton(r, "Play 스토어에서 보기"));
    await settle(r);
    expect(h.openURL.mock.calls).toEqual([[TOSS_SCHEME], [STORE_APP], [STORE_WEB]]);
    const text = nodeText(sheet(r)!);
    expect(text).toContain(FAIL);
    expect(text).toContain(TOSS_APP.storeFail);
    expect(r.all(sheet(r)!.children).find((n) => n.props.accessibilityRole === "alert")!.props.accessibilityLabel).toBe(`${FAIL} ${TOSS_APP.storeFail}`);
    tap(r, sheetButton(r, "닫기"));
    expect(sheet(r)).toBeNull();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("동기로 던져도 삼키고, 여는 동안 두 번 눌러도 한 번만 연다", async () => {
    let release: (v: unknown) => void = () => undefined;
    h.openURL.mockImplementation(() => new Promise((res) => (release = res)));
    const r = open(samsung(), "phone475", { tossOpen: true });
    openSheet(r);
    const b = sheetButton(r, "토스 앱 열기");
    tap(r, b);
    tap(r, b);
    expect(sheetButton(r, "토스 앱 열기").props.loading).toBe(true);
    release(true);
    await settle(r);
    expect(h.openURL).toHaveBeenCalledTimes(1);
    expect(sheet(r)).toBeNull();

    await expect(lib.openTossApp(() => { throw new Error("sync"); })).resolves.toBe(false);
    await expect(lib.openTossStore(() => { throw new Error("sync"); })).resolves.toBe(false);
  });
});

// ───────────────────────────── 자리 어림 ─────────────────────────────

describe("버튼이 '시세' 제목 줄에 들어간다 (앱의 글자 폭 어림)", () => {
  /** 제목 '시세' + 간격 + [아이콘 + 간격 + 글] (버튼 글은 fontCap.chrome 까지만 커진다) */
  const need = (fontScale: number) => {
    const title = estimateTextWidth("시세", font.body * fontScale);
    const btn = lib.tossButtonWidth(fontScale);
    return title + space.sm + btn;
  };

  it("버튼 폭 어림: 100% 약 100dp, 글자 150% 넘게 커지지 않는다", () => {
    expect(lib.tossButtonWidth(1)).toBeGreaterThan(70);
    expect(lib.tossButtonWidth(1)).toBeLessThan(115);
    expect(lib.tossButtonWidth(2)).toBe(lib.tossButtonWidth(fontCap.chrome));
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
