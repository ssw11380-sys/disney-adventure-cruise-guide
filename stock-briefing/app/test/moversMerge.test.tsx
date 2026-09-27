import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, Briefing, MarketSummary, MarketSummaryData } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 브리핑 2차 3 — 변동 카드 합치기 (플래그 moversMerge, 앱만 · 앱 fallback 꺼짐).
 *  - 꺼짐(앱 기본): 접은 화면 '변동 큰 종목' 카드, 계좌 카드·줄 '기여 1위 …', 넓은 창 2단 기준 줄은 목록 끝 — 지금 그대로
 *  - 켬 + 합치기 가능(계좌 브리핑 성공 + 기여 상위 있음): '변동 큰 종목' 카드 없음, 목록 1~3위 카드에 순위, 순위 1 바로 위 기준 줄 한 번,
 *    계좌 카드(또는 briefingCompactTop 이면 계좌 줄)에 '당일 손익 기여 상위 (오른 종목) · HH:MM 기준' 묶음 (원화 금액만)
 *  - 켬 + 합치기 불가(계좌 브리핑 없음·실패·기여 없음): 접은 화면은 지금 그대로
 *  - 넓은 창 2단: 계좌 브리핑과 상관없이 기준 줄을 첫 줄 바로 위로, 넓은 창 계좌 줄은 그대로
 * 시계는 고정 (useNow), RN 부품·공용 UI·종목 카드는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-28T08:40:00+09:00"),
  summaries: [] as unknown[],
  accounts: [] as unknown[],
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
    useMarketSummaries: (enabled: boolean) => q(enabled ? h.summaries : undefined),
    useMarketSummary: () => q(undefined),
    useAccountBriefings: (enabled: boolean) => q(enabled ? h.accounts : undefined),
    useAccountBriefing: () => q(undefined),
    useLatestBriefings: () => q(h.latest),
    useRegisteredStocks: () => q(h.stocks),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q({ KR: { isTradingDay: true, opensAt: null }, US: { isTradingDay: true } }),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
    useBriefing: () => q(undefined),
    useBriefings: () => q(undefined),
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { AccountBriefingCard, AccountBriefingRow, ContributorsBlock } = await import("@/components/AccountBriefingCard");
const { BriefingCard: RealBriefingCard } = await vi.importActual<typeof import("@/components/BriefingCard")>("@/components/BriefingCard");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const pick = await import("@/lib/briefingPick");
const readStore = await import("@/lib/briefingRead");
const { speakClock } = await import("@/lib/a11y");
const { accountCardSpeech, contributorsHead } = await import("@/lib/accountBriefing");

const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: Array<{ data: MarketSummaryData }> };
const d0 = shared.cases[0]!.data;
/** 월 9/28 아침 미국 요약 */
const US_MORNING: MarketSummary = { id: 7, date: d0.date, session: d0.session, market: d0.market, status: "ok", summary: "요약", createdAt: d0.asOf, data: d0 };

const B = (id: number, code: string, name: string, date: string, session: "morning" | "afternoon"): Briefing => ({
  id, code, name, session, date, status: "ok", summary: `${name} 요약`, detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: `${date}T${session === "morning" ? "08:32" : "16:10"}:00+09:00`,
});
/** 등록순: 삼성전자 · 마이크로소프트 · 메타 · RGTX · SOXL — 변동 큰 순이면 RGTX · SOXL · 마이크로소프트 · 삼성전자 · 메타 */
const LIST = [
  { code: "005930", name: "삼성전자", latest: B(504, "005930", "삼성전자", "2026-09-25", "afternoon") },
  { code: "MSFT", name: "마이크로소프트", latest: B(503, "MSFT", "마이크로소프트", "2026-09-28", "morning") },
  { code: "META", name: "메타", latest: B(505, "META", "메타", "2026-09-28", "morning") },
  { code: "RGTX", name: "RGTX", latest: B(501, "RGTX", "RGTX", "2026-09-28", "morning") },
  { code: "SOXL", name: "SOXL", latest: B(502, "SOXL", "SOXL", "2026-09-28", "morning") },
];
const STOCKS = [
  { code: "RGTX", quote: { changeRate: -6.44 } },
  { code: "SOXL", quote: { changeRate: 4.17 } },
  { code: "MSFT", quote: { changeRate: 3.66 } },
  { code: "005930", quote: { changeRate: 3.56 } },
  { code: "META", quote: { changeRate: -3.33 } },
];

/** 월 9/28 08:38 오전 계좌 브리핑 (목업 숫자) */
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-09-28", session: "morning", status: "ok",
  summary: "당일 +718,599원 (+0.77%) · 기여 1위 삼성전자 +348,000원", detail: "- 설명", model: "template", template: true, createdAt: "2026-09-28T08:38:00+09:00",
  headline: {
    totalValue: 93_786_000, dayPnl: 718_599, dayRate: 0.77, holdings: 17,
    top: [
      { code: "005930", name: "삼성전자", amount: 348_000, changeRate: 3.56 },
      { code: "MSFT", name: "마이크로소프트", amount: 304_088, changeRate: 3.66 },
      { code: "SOXL", name: "SOXL", amount: 257_494, changeRate: 4.17 },
    ],
  },
};
const withTop = (top: NonNullable<AccountBriefing["headline"]>["top"], over: Partial<NonNullable<AccountBriefing["headline"]>> = {}): AccountBriefing => ({ ...ACCOUNT, headline: { ...ACCOUNT.headline!, ...over, top } });

const CRITERION = "변동 큰 순 = 전일 대비 등락률 크기 순 · 매매 권유가 아닙니다";
/** 작업지시 4.2 의 예 문장 (월 08:38, 오른 날) */
const SPEECH =
  "내 계좌 브리핑, 9월 28일 (월) 오전, 당일손익 718,599원 이익, 0.77% 상승, 총 평가금액 93,786,000원, 당일 손익 기여 상위 오른 종목, 삼성전자 348,000원 이익, 마이크로소프트 304,088원 이익, SOXL 257,494원 이익, 8시 38분 기준, 자세히 보기";

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const all = (n: HostNode): HostNode[] => [n, ...kids(n).flatMap(all)];
const screenKids = (r: R) => kids(ofType(r, "Screen")[0]!);
const cards = (r: R) => ofType(r, "BriefingCard");
const criterionCount = (r: R) => r.all().filter((n) => rawOf(n) === CRITERION && (n.type === "Muted" || n.type === "Text")).length;
/** 기여 상위 묶음 (머리 글로 찾는다) */
const blockOf = (root: HostNode[]) => {
  const all2 = root.flatMap(all);
  const head = all2.find((n) => n.type === "Text" && rawOf(n).startsWith("당일 손익 기여 상위"));
  if (!head) return null;
  // 머리 글 → 머리 줄 View → 묶음 View
  const headRow = all2.find((n) => n.type === "View" && kids(n).includes(head))!;
  return all2.find((n) => n.type === "View" && kids(n).includes(headRow))!;
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
  h.flags = { accountBriefing: true, marketSummary: true, briefingTabMovers: true };
  h.now = Date.parse("2026-09-28T08:40:00+09:00");
  h.summaries = [US_MORNING];
  h.accounts = [ACCOUNT];
  h.latest = LIST;
  h.stocks = STOCKS;
  h.push.mockReset();
  h.store.clear();
  forgetWindowClass();
  pick.forgetPick();
  readStore.forgetRead();
});

describe("speakClock (화면 읽기 시각)", () => {
  it("'08:38' → '8시 38분', '09:00' → '9시', '16:05' → '16시 5분', 모양이 다르면 그대로", () => {
    expect(speakClock("08:38")).toBe("8시 38분");
    expect(speakClock("09:00")).toBe("9시");
    expect(speakClock("16:05")).toBe("16시 5분");
    expect(speakClock("00:00")).toBe("0시");
    for (const s of ["", "8시", "25:00", "08:61", "8:3", "오전 8:38"]) expect(speakClock(s)).toBe(s);
  });
});

describe("꺼짐 (앱 기본): 지금 그대로", () => {
  it("'변동 큰 종목' 카드 있음 · 순위·기준 줄 없음 · 계좌 카드 '기여 1위', 끔을 받은 것과 같은 화면", async () => {
    const r = await tab();
    expect(r.text()).toContain("변동 큰 종목");
    expect(criterionCount(r)).toBe(0);
    expect(cards(r).some((c) => "rank" in c.props)).toBe(false);
    expect(r.text()).toContain("기여 1위 ");
    expect(r.text()).not.toContain("당일 손익 기여 상위");
    const base = JSON.stringify(r.tree);
    h.flags.moversMerge = false;
    expect(JSON.stringify((await tab()).tree)).toBe(base);
  });

  it("briefingCompactTop 만 켬: 계좌 줄 둘째 줄 '기여 1위 …' 그대로, 아래는 '변동 큰 종목' 카드·순위 없음", async () => {
    h.flags.briefingCompactTop = true;
    const r = await tab();
    const row = kids(screenKids(r)[0]!)[0]!;
    expect(rawOf(row)).toContain("기여 1위 삼성전자 +348,000원");
    expect(rawOf(row)).not.toContain("당일 손익 기여 상위");
    expect(r.text()).toContain("변동 큰 종목");
    expect(criterionCount(r)).toBe(0);
    expect(cards(r).some((c) => "rank" in c.props)).toBe(false);
  });
});

describe("켬 + 합치기 가능 (접은 화면)", () => {
  beforeEach(() => {
    h.flags.moversMerge = true;
  });

  const checkList = (r: R) => {
    expect(r.text()).not.toContain("변동 큰 종목");
    // 기준 줄은 정확히 한 번, 첫 종목 카드 바로 앞
    expect(criterionCount(r)).toBe(1);
    const ks = screenKids(r);
    const first = ks.findIndex((n) => n.type === "BriefingCard");
    expect(ks[first - 1]!.type).toBe("Muted");
    expect(rawOf(ks[first - 1]!)).toBe(CRITERION);
    // 보기 탭 바로 뒤
    expect(ks[first - 2]!.type).toBe("Segmented");
    // 카드 1~3 순위 1·2·3 (변동 큰 순 RGTX · SOXL · 마이크로소프트), 4번째부터 없음
    const cs = cards(r);
    expect(cs.map((c) => (c.props.briefing as Briefing).code)).toEqual(["RGTX", "SOXL", "MSFT", "005930", "META"]);
    expect(cs.map((c) => c.props.rank)).toEqual([1, 2, 3, undefined, undefined]);
    expect("rank" in cs[3]!.props).toBe(false);
  };

  it("briefingCompactTop 끔: '변동 큰 종목' 카드 없음 · 순위 1 바로 위 기준 줄 한 번 · 순위 1~3 · 큰 계좌 카드에 기여 상위 묶음", async () => {
    const r = await tab();
    checkList(r);
    // 시장 요약 카드는 지금 그대로 (맨 위 카드 두 장)
    expect(screenKids(r).slice(0, 2).map((n) => n.type)).toEqual(["Card", "Card"]);
    const card = screenKids(r)[1]!;
    expect(rawOf(card)).not.toContain("기여 1위");
    const block = blockOf([card])!;
    expect(block).not.toBeNull();
    // 큰 카드 화면 읽기: 예 문장 그대로
    expect(all(card).find((n) => n.type === "Pressable")!.props.accessibilityLabel).toBe(SPEECH);
  });

  it("briefingCompactTop 켬 (4.1 그대로): 계좌 줄 → 시장 줄 → 안내 한 줄, 계좌 줄 안 기여 상위 묶음 · 줄 전체가 링크 하나", async () => {
    h.flags.briefingCompactTop = true;
    const r = await tab();
    checkList(r);
    const top = screenKids(r)[0]!;
    expect(top.type).toBe("View");
    const [row, market, note] = kids(top);
    expect(row!.props.accessibilityRole).toBe("link");
    expect(String(market!.props.accessibilityLabel)).toMatch(/^금요일\(9\/25\) 미국 시장/);
    expect(rawOf(note!)).toBe("시장·계좌 요약은 숫자로 만든 것 · 매매 권유가 아닙니다");
    // 둘째 줄의 '기여 1위' 묶음은 빠지고 기여 상위 묶음으로
    expect(rawOf(row!)).not.toContain("기여 1위");
    const block = blockOf([row!])!;
    expect(block).not.toBeNull();
    // 누르는 곳은 줄 하나뿐 (묶음 안에 Pressable 없음)
    expect(all(row!).filter((n) => n.type === "Pressable")).toHaveLength(1);
    expect(all(block).some((n) => n.type === "Pressable" || n.props.onPress !== undefined)).toBe(false);
    expect(row!.props.accessibilityLabel).toBe(SPEECH);
    r.act(() => (row!.props.onPress as () => void)());
    expect(h.push).toHaveBeenLastCalledWith("/briefings/account/12");
  });

  it("'등록순'이면 순위·기준 줄 없음 (카드도 없음)", async () => {
    const r = await tab();
    const sort = ofType(r, "Segmented").find((n) => (n.props.options as { value: string }[]).some((o) => o.value === "movers"))!;
    r.act(() => (sort.props.onChange as (v: string) => void)("registered"));
    expect(criterionCount(r)).toBe(0);
    expect(cards(r).some((c) => "rank" in c.props)).toBe(false);
    expect(r.text()).not.toContain("변동 큰 종목");
    expect(cards(r).map((c) => (c.props.briefing as Briefing).code)).toEqual(["005930", "MSFT", "META", "RGTX", "SOXL"]);
  });

  it("등락률을 못 받았으면(briefingTabMovers 꺼짐 포함) 순위·기준 줄 없음", async () => {
    h.flags.briefingTabMovers = false;
    const r = await tab();
    expect(criterionCount(r)).toBe(0);
    expect(cards(r).some((c) => "rank" in c.props)).toBe(false);
  });
});

describe("켬 + 합치기 불가 → 접은 화면은 지금 그대로 ('변동 큰 종목' 카드)", () => {
  const cases: [string, () => void][] = [
    ["계좌 브리핑 없음", () => void (h.accounts = [])],
    ["계좌 브리핑 꺼짐", () => void (h.flags.accountBriefing = false)],
    ["계좌 브리핑 실패", () => void (h.accounts = [{ ...ACCOUNT, status: "failed", headline: null, summary: "잔고를 받지 못했습니다" }])],
    ["기여 상위 빈 배열", () => void (h.accounts = [withTop([])])],
  ];
  it.each(cases)("%s", async (_name, setup) => {
    setup();
    const off = JSON.stringify((await tab()).tree);
    h.flags.moversMerge = true;
    const r = await tab();
    expect(JSON.stringify(r.tree)).toBe(off);
    expect(r.text()).toContain("변동 큰 종목");
    expect(criterionCount(r)).toBe(0);
    // briefingCompactTop 을 켜도 아래(변동 카드)는 끈 것과 같다
    h.flags.briefingCompactTop = true;
    const onTop = JSON.stringify((await tab()).tree);
    h.flags.moversMerge = false;
    expect(JSON.stringify((await tab()).tree)).toBe(onTop);
  });
});

describe("기여 상위 묶음 (ContributorsBlock)", () => {
  const texts = (r: R) => ofType(r, "Text").map(rawOf);

  it("머리 '당일 손익 기여 상위 (오른 종목)' · '08:38 기준' · 세 줄 이름 | 원화 금액 — 등락률(%)·순위 번호 없음, 금액은 줄이지 않는다", () => {
    const r = render(<ContributorsBlock briefing={ACCOUNT} />);
    expect(texts(r)).toEqual(["당일 손익 기여 상위 (오른 종목)", "08:38 기준", "삼성전자", "+348,000원", "마이크로소프트", "+304,088원", "SOXL", "+257,494원"]);
    expect(r.text()).not.toContain("%");
    expect(r.text()).not.toMatch(/[123]위/);
    expect(r.text()).not.toContain("가장 많이");
    const amounts = ofType(r, "Text").filter((n) => /원$/.test(rawOf(n)));
    expect(amounts).toHaveLength(3);
    for (const a of amounts) {
      expect(a.props.adjustsFontSizeToFit).toBeUndefined();
      expect(a.props.numberOfLines).toBe(1);
      expect(a.props.maxFontSizeMultiplier).toBe(1.4);
    }
    // 이름만 말줄임 (한 줄), 글자 확대 상한
    const names = ofType(r, "Text").filter((n) => ["삼성전자", "마이크로소프트", "SOXL"].includes(rawOf(n)));
    for (const n of names) expect(n.props).toMatchObject({ numberOfLines: 1, maxFontSizeMultiplier: 1.4 });
    expect(ofType(r, "Pressable")).toHaveLength(0);
  });

  it("당일 손익 음수 → '(내린 종목)', 0 → 괄호 없이, 기여 1개 → 한 줄, 없으면 그리지 않음", () => {
    const down = withTop([{ code: "RGTX", name: "RGTX", amount: -268_838, changeRate: -6.44 }], { dayPnl: -250_267, dayRate: -2.66 });
    let r = render(<ContributorsBlock briefing={down} />);
    expect(texts(r)).toEqual(["당일 손익 기여 상위 (내린 종목)", "08:38 기준", "RGTX", "-268,838원"]);
    r = render(<ContributorsBlock briefing={withTop(ACCOUNT.headline!.top, { dayPnl: 0, dayRate: 0 })} />);
    expect(texts(r)[0]).toBe("당일 손익 기여 상위");
    // 0원으로 보이는 아주 작은 손익도 방향 말 없이
    expect(contributorsHead(0.4)).toBe("당일 손익 기여 상위");
    expect(render(<ContributorsBlock briefing={withTop([])} />).tree).toEqual([]);
    expect(render(<ContributorsBlock briefing={{ ...ACCOUNT, status: "failed", headline: null }} />).tree).toEqual([]);
  });

  it("화면 읽기: 내린 날은 '내린 종목'·손실, 0 이면 방향 말 없이 — 옵션 없으면 예전 문장('기여 1위 …')", () => {
    const down = withTop([{ code: "RGTX", name: "RGTX", amount: -268_838, changeRate: -6.44 }], { dayPnl: -250_267, dayRate: -2.66 });
    expect(accountCardSpeech(down, { contributors: true })).toContain("당일 손익 기여 상위 내린 종목, RGTX 268,838원 손실, 8시 38분 기준, 자세히 보기");
    expect(accountCardSpeech(withTop(ACCOUNT.headline!.top, { dayPnl: 0 }), { contributors: true })).toContain("총 평가금액 93,786,000원, 당일 손익 기여 상위, 삼성전자 348,000원 이익");
    expect(accountCardSpeech(ACCOUNT)).toBe("내 계좌 브리핑, 9월 28일 (월) 오전, 당일손익 718,599원 이익, 0.77% 상승, 총 평가금액 93,786,000원, 기여 1위 삼성전자 348,000원 이익, 자세히 보기");
    // 기여가 없으면 옵션을 줘도 예전 문장
    expect(accountCardSpeech(withTop([]), { contributors: true })).toBe(accountCardSpeech(withTop([])));
  });

  it("큰 계좌 카드·계좌 줄: contributors 를 넘기지 않으면 지금 모양 ('기여 1위 …')", () => {
    const card = render(<AccountBriefingCard briefing={ACCOUNT} />);
    expect(card.text()).toContain("기여 1위 삼성전자 +348,000원 (+3.56%)");
    expect(blockOf(card.tree.filter((n): n is HostNode => typeof n !== "string"))).toBeNull();
    const row = render(<AccountBriefingRow briefing={ACCOUNT} selected={false} onPress={() => undefined} role="link" />);
    expect(row.text()).toContain("기여 1위 삼성전자 +348,000원");
    expect(row.text()).not.toContain("당일 손익 기여 상위");
  });
});

describe("종목 카드 순위 (BriefingCard rank)", () => {
  const b = LIST[3]!.latest;

  it("rank 가 있으면 이름 앞 순위 네모 + 화면 읽기 '변동 큰 순 1위' (넓은 창 줄과 같은 말)", () => {
    const r = render(<RealBriefingCard briefing={b} mode="summary" rate={-6.44} rank={1} />);
    const head = ofType(r, "Pressable")[0]!;
    expect(String(head.props.accessibilityLabel)).toMatch(/^변동 큰 순 1위, RGTX, 9월 28일 \(월\) 오전 브리핑, 6\.44% 하락/);
    // 순위 네모(글 '1')가 이름보다 앞
    const t = ofType(r, "Text").map(rawOf);
    expect(t.indexOf("1")).toBeGreaterThan(-1);
    expect(t.indexOf("1")).toBeLessThan(t.indexOf("RGTX"));
  });

  it("rank 가 없으면 지금 그대로 (순위 네모·'변동 큰 순' 말 없음)", () => {
    const r = render(<RealBriefingCard briefing={b} mode="summary" rate={-6.44} />);
    expect(String(ofType(r, "Pressable")[0]!.props.accessibilityLabel)).toMatch(/^RGTX, 9월 28일/);
    expect(ofType(r, "Text").map(rawOf)).not.toContain("1");
  });
});

describe("넓은 창 2단 (foldLayout 켬 933×632)", () => {
  const open = async () => {
    h.flags.foldLayout = true;
    h.store.set("briefings.read", "[]");
    h.win = { width: 933, height: 632, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    const r = render(<BriefingsScreen />);
    await settle(r);
    return r;
  };
  const rowIdx = (r: R) => r.all().findIndex((n) => n.type === "Pressable" && /^(읽지 않음, )?변동 큰 순 1위/.test(String(n.props.accessibilityLabel ?? "")));
  const critIdx = (r: R) => r.all().findIndex((n) => n.type === "Muted" && rawOf(n) === CRITERION);

  it("끔: 기준 줄은 목록 끝 (지금 그대로)", async () => {
    const r = await open();
    expect(criterionCount(r)).toBe(1);
    expect(critIdx(r)).toBeGreaterThan(rowIdx(r));
  });

  it.each([
    ["계좌 브리핑 있음", () => undefined],
    ["계좌 브리핑 없음", () => void (h.accounts = [])],
  ])("켬 (%s): 기준 줄이 첫 목록 줄 바로 위 (한 번), 넓은 창 계좌 줄은 '기여 1위' 그대로", async (_name, setup) => {
    setup();
    h.flags.moversMerge = true;
    const r = await open();
    expect(criterionCount(r)).toBe(1);
    const c = critIdx(r);
    expect(c).toBeGreaterThan(-1);
    expect(c).toBeLessThan(rowIdx(r));
    // 기준 줄과 첫 줄은 같은 스크롤 안 (기준 줄 바로 다음이 첫 줄)
    const scroll = ofType(r, "ScrollView").find((s) => kids(s).some((n) => n.type === "Muted" && rawOf(n) === CRITERION))!;
    const inScroll = kids(scroll);
    const at = inScroll.findIndex((n) => n.type === "Muted" && rawOf(n) === CRITERION);
    expect(String(inScroll[at + 1]!.props.accessibilityLabel)).toMatch(/변동 큰 순 1위, RGTX/);
    if (h.accounts.length) {
      expect(r.text()).toContain("기여 1위 ");
      expect(r.text()).not.toContain("당일 손익 기여 상위");
    }
  });
});
