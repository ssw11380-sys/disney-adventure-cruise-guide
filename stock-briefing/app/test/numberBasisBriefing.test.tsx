import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, AccountBriefingWithData, AccountData, Briefing } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 숫자 기준 (3-32 PR 2, 플래그 numberBasis — 앱 fallback 꺼짐): 브리핑 탭 계좌 카드·줄의 'HH:MM 기준'과 계좌 브리핑 상세의 '시세 기준' 줄.
 *  - 꺼짐(앱 기본): 큰 카드 '당일 손익', 줄에 기준 글 없음, 상세에 '시세 기준:' 없음, 화면 읽기 지금 문장
 *  - 켬: 큰 카드 '당일 손익 · 08:38 기준', 넓은 창 줄 끝 '08:38 기준', 화면 읽기 '… 8시 38분 기준, 자세히 보기'.
 *    기여 상위 묶음(2+3)이 있는 줄·카드는 더하지 않음(묶음 머리에 이미 '08:38 기준' — 정확히 한 번). 실패 브리핑은 없음
 *  - 상세(stack·pane·split): 저장한 quoteBasis 가 있으면 '보유 N종목 합계' 아래 '시세 기준: 국내 NXT 포함 · 미국 정규장 · 08:38 계산',
 *    그 줄을 감싼 View 의 이름표로 한 번만 읽힘. 총 평가 묶음 이름표·'기준:' 줄은 켬·끔이 같다. 예전 기록(quoteBasis 없음)은 줄 없음
 * 시계는 고정 (useNow), RN 부품·공용 UI·종목 카드는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다 (briefingCompactTop.test.tsx·foldBriefings.test.tsx 방식)
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-28T08:40:00+09:00"),
  accounts: [] as unknown[],
  detail: null as unknown,
  latest: [] as unknown[],
  stocks: [] as unknown[],
  push: vi.fn(),
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
  Linking: { openURL: vi.fn() },
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
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, Tabs: { Screen: "TabsScreen" }, useLocalSearchParams: () => ({ id: "12" }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => 1 };
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
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useMarketSummaries: () => q(undefined),
    useMarketSummary: () => q(undefined),
    useAccountBriefings: (enabled: boolean) => q(enabled ? h.accounts : undefined),
    useAccountBriefing: (_id: number, enabled: boolean) => q(enabled ? h.detail : undefined),
    useLatestBriefings: () => q(h.latest),
    useRegisteredStocks: () => q(h.stocks),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q(undefined),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
    useBriefing: () => q(undefined),
    useBriefings: () => q(undefined),
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { AccountBriefingBody } = await import("@/components/AccountBriefingBody");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const pick = await import("@/lib/briefingPick");
const readStore = await import("@/lib/briefingRead");

const B = (id: number, code: string, name: string): Briefing => ({
  id, code, name, session: "morning", date: "2026-09-28", status: "ok", summary: `${name} 요약`, detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: "2026-09-28T08:32:00+09:00",
});
const LIST = [
  { code: "RGTX", name: "RGTX", latest: B(501, "RGTX", "RGTX") },
  { code: "SOXL", name: "SOXL", latest: B(502, "SOXL", "SOXL") },
  { code: "005930", name: "삼성전자", latest: B(504, "005930", "삼성전자") },
];
const STOCKS = [
  { code: "RGTX", quote: { changeRate: -6.44 } },
  { code: "SOXL", quote: { changeRate: 4.17 } },
  { code: "005930", quote: { changeRate: 3.56 } },
];

/** 월 9/28 08:38 오전 계좌 브리핑 */
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-09-28", session: "morning", status: "ok",
  summary: "당일 +718,599원 (+0.77%) · 기여 1위 삼성전자 +348,000원", detail: "- 설명", model: "template", template: true, createdAt: "2026-09-28T08:38:00+09:00",
  headline: {
    totalValue: 93_786_000, dayPnl: 718_599, dayRate: 0.77, holdings: 17,
    top: [
      { code: "005930", name: "삼성전자", amount: 348_000, changeRate: 3.56 },
      { code: "SOXL", name: "SOXL", amount: 257_494, changeRate: 4.17 },
    ],
  },
};
const FAILED: AccountBriefing = { ...ACCOUNT, status: "failed", headline: null, summary: "시세를 받지 못해 계좌 브리핑을 만들지 못했습니다" };
const DATA: AccountData = {
  version: 1, session: "morning", date: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", basis: "앱 잔고 화면과 같은 기준", afterCost: true, holdings: 17, stale: 0,
  totalValue: 93_786_000, totalCost: 80_000_000, totalProfit: 13_786_000, totalProfitRate: 17.23, dayPnl: 718_599, dayRate: 0.77,
  contributions: [{ code: "005930", name: "삼성전자", currency: "KRW", amount: 348_000, changeRate: 3.56, value: 9_900_000 }],
  others: { count: 16, amount: 370_599 },
  markets: { kr: { count: 9, value: 1, day: 400_000, dayRate: 0.62 }, us: { count: 8, value: 1, day: 318_599, dayRate: 0.58 } },
  excluded: [],
  fx: { status: "computed", reason: null, usdKrw: { value: 1391.5, change: 4.3, changeRate: 0.31, stale: false }, appliedRate: 1391.5, usdHoldingsKrwChange: 351_894, priceEffect: 228_888, fxEffect: 123_006 },
  indices: [{ code: "KOSPI", name: "코스피", value: 3478.12, change: 29.2, changeRate: 0.85, open: false, stale: false }],
  missingIndices: [],
  schedule: { kr: { date: "2026-09-28", tradingDay: true, now: "개장 전", hours: "정규장 09:00~15:30", nextOpen: null }, us: { date: "2026-09-28", tradingDay: true, now: "미국 주간거래", hours: "정규장" }, disclosures: [] },
  narrative: { source: "template", reason: null },
  quoteBasis: { kr: { count: 9, tags: [{ tag: "NXT", count: 9 }] }, us: { count: 8, tags: [{ tag: "정규장", count: 8 }] } },
};
const OLD_DATA: AccountData = (({ quoteBasis: _q, ...rest }) => rest)(DATA);

const LINE = "시세 기준: 국내 NXT 포함 · 미국 정규장 · 08:38 계산";
/** 큰 카드 화면 읽기의 '자세히 보기' 앞까지 (지금 문장) */
const CARD_SPEECH = "내 계좌 브리핑, 9월 28일 (월) 오전, 당일손익 718,599원 이익, 0.77% 상승, 총 평가금액 93,786,000원, 기여 1위 삼성전자 348,000원 이익";
const LINE_SPEECH = "시세 기준, 국내 NXT 포함, 미국 정규장, 8시 38분 계산";

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
const labels = (r: R) => r.all().map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");
const account = (r: R) => {
  const hits = r.all().filter((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").startsWith("내 계좌 브리핑"));
  expect(hits).toHaveLength(1);
  return hits[0]!;
};
const count = (s: string, part: string) => s.split(part).length - 1;
const size = (width: number, height: number) => {
  h.win = { width, height, scale: 2.625, fontScale: 1 };
  forgetWindowClass();
};
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};
const tab = async () => {
  const r = render(<BriefingsScreen />);
  await settle(r);
  return r;
};

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { accountBriefing: true, briefingTabMovers: true };
  h.now = Date.parse("2026-09-28T08:40:00+09:00");
  h.accounts = [ACCOUNT];
  h.detail = { ...ACCOUNT, data: DATA } satisfies AccountBriefingWithData;
  h.latest = LIST;
  h.stocks = STOCKS;
  h.push.mockReset();
  h.store.clear();
  forgetWindowClass();
  pick.forgetPick();
  readStore.forgetRead();
});

describe("꺼짐 (앱 기본 — 플래그 없음 = 꺼짐): 지금 그대로", () => {
  it("접은 화면 큰 카드: '당일 손익', 기준 글·시각 말 없음 — false 로 받은 것과 같은 화면", async () => {
    const r = await tab();
    const card = account(r);
    expect(ofType(r, "Muted").map(rawOf)).toContain("당일 손익");
    expect(rawOf(card)).not.toContain("08:38 기준");
    expect(String(card.props.accessibilityLabel)).not.toContain("8시 38분 기준");
    expect(card.props.accessibilityLabel).toBe(`${CARD_SPEECH}, 자세히 보기`);
    const base = JSON.stringify(r.tree);
    h.flags = { ...h.flags, numberBasis: false };
    expect(JSON.stringify((await tab()).tree)).toBe(base);
  });

  it("넓은 창 2단 줄: 기준 글 없음", async () => {
    h.flags.foldLayout = true;
    size(933, 632);
    const row = account(await tab());
    expect(rawOf(row)).not.toContain("기준");
    expect(String(row.props.accessibilityLabel)).not.toContain("8시 38분 기준");
  });

  it.each(["stack", "pane", "split"] as const)("상세 %s: '시세 기준:' 줄 없음", (layout) => {
    if (layout === "split") size(933, 632);
    const r = render(<AccountBriefingBody numId={12} layout={layout} />);
    expect(r.text()).not.toContain("시세 기준");
    expect(labels(r)).not.toContain(LINE_SPEECH);
    expect(r.text()).toContain("기준: 앱 잔고 화면과 같은 기준");
  });
});

describe("켬: 브리핑 탭 계좌 카드·줄 'HH:MM 기준'", () => {
  beforeEach(() => {
    h.flags.numberBasis = true;
  });

  it("접은 화면 큰 카드: '당일 손익 · 08:38 기준' (같은 Muted, 새 줄 없음), 화면 읽기 '8시 38분 기준, 자세히 보기'", async () => {
    const r = await tab();
    const card = account(r);
    expect(ofType(r, "Muted").map(rawOf)).toContain("당일 손익 · 08:38 기준");
    expect(ofType(r, "Muted").map(rawOf)).not.toContain("당일 손익");
    expect(card.props.accessibilityLabel).toBe(`${CARD_SPEECH}, 8시 38분 기준, 자세히 보기`);
    // 끈 것과 비교: Muted 글 하나와 이름표만 다르다 (배치 그대로)
    h.flags.numberBasis = false;
    const off = await tab();
    expect(ofType(r, "Muted")).toHaveLength(ofType(off, "Muted").length);
    expect(r.all()).toHaveLength(off.all().length);
  });

  it("넓은 창 2단 줄: 둘째 줄 끝에 '08:38 기준' 묶음, 앞 묶음 끝에 ' ·'", async () => {
    h.flags.foldLayout = true;
    size(933, 632);
    const row = account(await tab());
    const line = kids(row).find((n) => n.type === "View" && kids(n).length >= 2 && rawOf(n).startsWith("당일"))!;
    const groups = kids(line).map(rawOf);
    expect(groups.at(-1)).toBe("08:38 기준");
    expect(groups.at(-2)).toMatch(/ ·$/);
    expect(groups[0]).toMatch(/^당일 .* ·$/);
    expect(count(rawOf(row), "08:38 기준")).toBe(1);
    expect(String(row.props.accessibilityLabel)).toMatch(/, 8시 38분 기준, 자세히 보기$/);
    const last = kids(line).at(-1)!;
    expect(last.props.maxFontSizeMultiplier).toBeDefined();
  });

  it("넓은 창 카드 격자(704×861) 줄도 같다", async () => {
    h.flags.foldLayout = true;
    size(704, 861);
    const row = account(await tab());
    expect(count(rawOf(row), "08:38 기준")).toBe(1);
    expect(String(row.props.accessibilityLabel)).toContain("8시 38분 기준, 자세히 보기");
  });

  it("기여 상위 묶음(2+3: briefingCompactTop·moversMerge)이 있는 접은 화면 줄은 더하지 않는다 — '08:38 기준' 정확히 한 번", async () => {
    h.flags = { ...h.flags, briefingCompactTop: true, moversMerge: true };
    const row = account(await tab());
    expect(count(rawOf(row), "08:38 기준")).toBe(1);
    expect(count(String(row.props.accessibilityLabel), "8시 38분 기준")).toBe(1);
    // 큰 카드(compactTop 꺼짐 + moversMerge)도 묶음이 있으면 '당일 손익' 그대로
    h.flags.briefingCompactTop = false;
    const r = await tab();
    expect(ofType(r, "Muted").map(rawOf)).toContain("당일 손익");
    expect(count(rawOf(account(r)), "08:38 기준")).toBe(1);
  });

  it("묶음이 없는 접은 화면 줄(compactTop 만)은 둘째 줄 끝에 붙는다", async () => {
    h.flags.briefingCompactTop = true;
    const row = account(await tab());
    expect(count(rawOf(row), "08:38 기준")).toBe(1);
    expect(String(row.props.accessibilityLabel)).toContain("8시 38분 기준, 자세히 보기");
  });

  it("실패한 계좌 브리핑: 시각 없음", async () => {
    h.accounts = [FAILED];
    let r = await tab();
    expect(rawOf(account(r))).not.toContain("기준");
    expect(String(account(r).props.accessibilityLabel)).not.toContain("8시 38분");
    h.flags.foldLayout = true;
    size(933, 632);
    r = await tab();
    expect(rawOf(account(r))).not.toContain("기준");
  });
});

describe("켬: 계좌 브리핑 상세 '시세 기준' 줄", () => {
  it.each(["stack", "pane", "split"] as const)("%s: '보유 N종목 합계' 바로 아래 한 줄, 자기 이름표로 한 번만 읽힘", (layout) => {
    if (layout === "split") size(933, 632);
    const off = render(<AccountBriefingBody numId={12} layout={layout} />);
    h.flags.numberBasis = true;
    const r = render(<AccountBriefingBody numId={12} layout={layout} />);
    const lines = ofType(r, "Muted").map(rawOf);
    const at = lines.indexOf(LINE);
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe("보유 17종목 합계 · 앱 잔고 화면과 같은 기준");
    expect(lines.filter((l) => l === LINE)).toHaveLength(1);
    // 감싼 View 의 이름표 (Muted 는 이름표가 없음)
    const wrap = r.all().find((n) => n.type === "View" && n.props.accessibilityLabel === LINE_SPEECH)!;
    expect(wrap.props.accessible).toBe(true);
    expect(rawOf(wrap)).toBe(LINE);
    expect(labels(r).filter((l) => l.includes("시세 기준"))).toEqual([LINE_SPEECH]);
    // 총 평가 묶음 이름표(totalsSpeech)는 켬·끔이 같고, 그 묶음 안에 이 줄이 없다
    const totals = (x: R) => labels(x).filter((l) => l.startsWith("총 평가금액"));
    expect(totals(r)).toEqual(totals(off));
    expect(totals(r)).toHaveLength(1);
    expect(totals(r)[0]).not.toContain("시세 기준");
    // 기존 '기준:' 줄 그대로
    const basisLine = (x: R) => ofType(x, "Muted").map(rawOf).find((l) => l.startsWith("기준: "));
    expect(basisLine(r)).toBe(basisLine(off));
    expect(basisLine(r)).toContain("기준: 앱 잔고 화면과 같은 기준");
  });

  it.each(["stack", "pane", "split"] as const)("%s: 예전 기록(quoteBasis 없음)은 줄 없음", (layout) => {
    if (layout === "split") size(933, 632);
    h.flags.numberBasis = true;
    h.detail = { ...ACCOUNT, data: OLD_DATA } satisfies AccountBriefingWithData;
    const r = render(<AccountBriefingBody numId={12} layout={layout} />);
    expect(r.text()).not.toContain("시세 기준");
    expect(labels(r).some((l) => l.startsWith("시세 기준"))).toBe(false);
  });

  it("여럿이면 '말 수'를 가운뎃점으로, 화면 읽기는 'N종목' 을 쉼표로", () => {
    h.flags.numberBasis = true;
    h.detail = {
      ...ACCOUNT,
      data: { ...DATA, quoteBasis: { kr: DATA.quoteBasis!.kr, us: { count: 14, tags: [{ tag: "주간거래", count: 12 }, { tag: "정규장", count: 2 }] } } },
    } satisfies AccountBriefingWithData;
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    expect(ofType(r, "Muted").map(rawOf)).toContain("시세 기준: 국내 NXT 포함 · 미국 주간거래 12·정규장 2 · 08:38 계산");
    expect(labels(r)).toContain("시세 기준, 국내 NXT 포함, 미국 주간거래 12종목, 정규장 2종목, 8시 38분 계산");
  });
});
