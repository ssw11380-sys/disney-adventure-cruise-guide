import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, AccountBriefingWithData, AccountData, MarketSummary, MarketSummaryData } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 브리핑 2차 4 — 틀린 문장·되풀이 정리 (플래그 briefingTrim, 앱만 · 앱 fallback 꺼짐).
 *  - 꺼짐(앱 기본): 탭 휴장 줄 '국내 종목 브리핑 없음', 카드 '오늘 한국 휴장', 상세 '무엇이 계좌를 움직였나'·'지수·환율 영향'·'숫자로 만든 기본 설명' 그대로
 *  - 켬: 보이는 시장 요약이 한국 휴장을 말하면 탭 휴장 줄을 숨기고, 그 밖에는 '국내 종목은 직전 거래일 등락'. 카드·상세 휴장 줄에 브리핑 날짜.
 *    계좌 상세(기본 설명)에서 되풀이 설명 카드가 빠지고 제목·배지가 바뀜. 시장 요약 상세 '내 보유 종목과 지수' 머리의 되풀이 줄이 빠짐. 업종 말은 부호대로
 * 시계는 고정 (useNow), RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-25T16:20:00+09:00"),
  market: undefined as unknown,
  summaries: [] as unknown[],
  summaryDetail: null as unknown,
  accounts: [] as unknown[],
  accountDetail: null as unknown,
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
vi.mock("expo-router", () => ({ router: { push: vi.fn(), dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, Tabs: { Screen: "TabsScreen" }, useLocalSearchParams: () => ({ id: "12" }) }));
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
  // 목록에는 직전 거래일(9/23) 국내 종목 브리핑이 있다 — 그래서 '국내 종목 브리핑 없음'은 틀린 말
  const LATEST = [{ code: "005930", name: "삼성전자", latest: { id: 1, code: "005930", name: "삼성전자", session: "afternoon", date: "2026-09-23", status: "ok", summary: "요약", detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: "2026-09-23T16:10:00+09:00" } }];
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useMarketSummaries: (enabled: boolean) => q(enabled ? h.summaries : undefined),
    useMarketSummary: (_id: number, enabled: boolean) => q(enabled ? h.summaryDetail : undefined),
    useAccountBriefings: (enabled: boolean) => q(enabled ? h.accounts : undefined),
    useAccountBriefing: (_id: number, enabled: boolean) => q(enabled ? h.accountDetail : undefined),
    useLatestBriefings: () => q(LATEST),
    useRegisteredStocks: () => q([]),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q(h.market),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
    useBriefing: () => q(undefined),
    useBriefings: () => q(undefined),
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { AccountBriefingBody } = await import("@/components/AccountBriefingBody");
const { AccountBriefingRow } = await import("@/components/AccountBriefingCard");
const { MarketSummaryBody } = await import("@/components/MarketSummaryBody");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { holdingsAux, holdingsSegs, speakText } = await import("@/lib/marketSummary");

const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: Array<{ data: MarketSummaryData }> };
const summaryItem = (id: number, data: MarketSummaryData, status: "ok" | "failed" = "ok"): MarketSummary => ({ id, date: data.date, session: data.session, market: data.market, status, summary: status === "ok" ? "요약" : "지수를 받지 못했습니다", createdAt: data.asOf, data: status === "ok" ? data : null });
/** 월요일 아침 미국 요약 (한국 휴장일 아침에도 이런 '밤사이 미국' 요약이 보인다) */
const US_MORNING = summaryItem(7, shared.cases[0]!.data);
/** 한국 휴장(추석) 오후 요약 — 요약 카드가 한국 휴장을 이미 말한다 */
const KR_HOLIDAY = summaryItem(8, shared.cases[2]!.data);

const KR_LINE_OLD = "오늘 한국 휴장 · 국내 종목은 직전 거래일 등락";
const KR_LINE_NEW = "9/25(금) 한국 휴장 · 국내 종목은 직전 거래일 등락";

/** 금 9/25 16:07 오후 계좌 브리핑 (추석 휴장 — 국내 종목은 직전 거래일 등락). 서버가 저장한 요약 셋째 줄은 '오늘 한국 휴장 · …' */
const DATA: AccountData = {
  version: 1, session: "afternoon", date: "2026-09-25", asOf: "2026-09-25T16:07:00+09:00", basis: "앱 잔고 화면과 같은 기준", afterCost: true, holdings: 17, stale: 0,
  totalValue: 93_218_349, totalCost: 72_205_618, totalProfit: 21_012_731, totalProfitRate: 29.1, dayPnl: 795_300, dayRate: 0.86,
  contributions: [
    { code: "005930", name: "삼성전자", currency: "KRW", amount: 348_000, changeRate: 3.56, value: 10_120_000 },
    { code: "SOXL", name: "SOXL", currency: "USD", amount: 299_659, changeRate: 5.11, value: 6_163_000 },
  ],
  others: { count: 15, amount: 147_641 },
  markets: { kr: { count: 5, value: 1, day: 331_500, dayRate: 1.38 }, us: { count: 12, value: 1, day: 463_800, dayRate: 0.68 } },
  excluded: [],
  fx: { status: "computed", reason: null, usdKrw: { value: 1359, change: 3.5, changeRate: 0.26, stale: false }, appliedRate: 1359, usdHoldingsKrwChange: 640_384, priceEffect: 463_800, fxEffect: 176_584 },
  indices: [{ code: "KOSPI", name: "코스피", value: 7080.92, change: 63.01, changeRate: 0.9, open: false, stale: false }],
  missingIndices: [],
  schedule: { kr: { date: "2026-09-25", tradingDay: false, now: "한국 휴장일", hours: null, nextOpen: "2026-09-28T00:00:00.000Z" }, us: { date: "2026-09-25", tradingDay: true, now: "미국 주간거래", hours: "정규장 9/25 22:30~9/26 05:00 (한국 시간)" }, disclosures: [] },
  narrative: { source: "template", reason: null },
  krPreviousDay: true,
};
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-09-25", session: "afternoon", status: "ok",
  summary: `당일 +795,300원 (+0.86%) · 기여 1위 삼성전자 +348,000원\n총 평가금액 93,218,349원 · 환율 효과 +176,584원\n${KR_LINE_OLD}`,
  detail: "- 오후 기준 당일 손익은 +795,300원(+0.86%)입니다.", model: "template", template: true, createdAt: "2026-09-25T16:07:00+09:00",
  headline: { totalValue: 93_218_349, dayPnl: 795_300, dayRate: 0.86, holdings: 17, top: [{ code: "005930", name: "삼성전자", amount: 348_000, changeRate: 3.56 }], krPreviousDay: true },
};
const DETAIL: AccountBriefingWithData = { ...ACCOUNT, data: DATA };
/** 모델 설명(accountBriefingLlm 을 켜서 검사를 통과한 설명) */
const LLM: AccountBriefingWithData = { ...DETAIL, template: false, model: "m", data: { ...DATA, narrative: { source: "llm", reason: null } } };

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
/** 흐린 글(Muted) 하나하나 */
const muted = (r: R) => ofType(r, "Muted").map(rawOf);
/** 줄바꿈 덩어리 줄(SegText·Words)을 ' '로 이은 한 줄 */
const wordRows = (r: R) => r.all().filter((n) => n.type === "View" && n.props.testID === "words").map((row) => row.children.filter((c): c is HostNode => typeof c !== "string").map(rawOf).join(" "));
const labels = (r: R) => r.all().map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");
const titles = (r: R) => ofType(r, "SectionTitle").map(rawOf);
const badges = (r: R) => ofType(r, "Badge").map(rawOf);
/** 접은 화면 탭 휴장 줄 */
const tabHoliday = (r: R) => muted(r).filter((x) => x.startsWith("한국 휴장일"));
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
  h.flags = { accountBriefing: true, marketSummary: true };
  h.now = Date.parse("2026-09-25T16:20:00+09:00");
  // 금 9/25 추석 — 한국 휴장, 다음 개장 9/28(월) 09:00
  h.market = { KR: { isTradingDay: false, opensAt: "2026-09-28T09:00:00+09:00" }, US: { isTradingDay: true } };
  h.summaries = [KR_HOLIDAY];
  h.summaryDetail = US_MORNING;
  h.accounts = [ACCOUNT];
  h.accountDetail = DETAIL;
  h.store.clear();
  forgetWindowClass();
});

describe("꺼짐 (앱 기본 — 플래그 없음 = 꺼짐): 지금 글 그대로", () => {
  it("한국 휴장일 탭: 탭 휴장 줄 '국내 종목 브리핑 없음', 계좌 카드 '오늘 한국 휴장 · …'·'숫자로 만든 기본 설명', 업종 '강/약'", async () => {
    const r = await tab();
    expect(tabHoliday(r)).toEqual(["한국 휴장일 · 국내 종목 브리핑 없음 · 다음 개장 9월 28일 (월) 09:00"]);
    expect(muted(r)).toContain(KR_LINE_OLD);
    expect(muted(r)).toContain("숫자로 만든 기본 설명 · 매매 권유가 아닙니다");
    expect(muted(r)).not.toContain(KR_LINE_NEW);
    expect(wordRows(r)).toContain("9/23 기준 · 강 석유와가스 +3.13% · 반도체와반도체장비 +2.80%");
    expect(labels(r).some((l) => l.includes("오늘 한국 휴장, 국내 종목은 직전 거래일 등락"))).toBe(true);
    // 플래그를 false 로 받은 것과 받지 못한 것(앱 기본)은 같은 화면
    const base = JSON.stringify(r.tree);
    h.flags = { ...h.flags, briefingTrim: false };
    expect(JSON.stringify((await tab()).tree)).toBe(base);
  });

  it("계좌 상세: '무엇이 계좌를 움직였나'·'지수·환율 영향'·'숫자로 만든 기본 설명', 요약·기여 표 설명의 '오늘 한국 휴장'", () => {
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const text = r.text();
    for (const s of ["무엇이 계좌를 움직였나", "지수·환율 영향", "숫자로 만든 기본 설명", KR_LINE_OLD, " 오늘 한국은 휴장이라 국내 종목은 직전 거래일 등락입니다(작성 당시 종목 시세 기준 추정)."]) expect(text, s).toContain(s);
    expect(labels(r).find((l) => l.startsWith("요약,"))).toContain("오늘 한국 휴장, 국내 종목은 직전 거래일 등락");
  });

  it("시장 요약 상세: '내 보유 종목과 지수' 머리 첫 줄(요약 줄과 같은 말)이 그대로 있다", () => {
    const r = render(<MarketSummaryBody numId={7} layout="stack" />);
    const first = holdingsSegs(US_MORNING.data!, { mine: false })!.map((s) => s.text).join("");
    expect(wordRows(r)).toContain(first);
    expect(wordRows(r)).toContain(holdingsAux(US_MORNING.data!.holdings!));
    expect(wordRows(r).some((x) => x.startsWith("강한 업종 산업재"))).toBe(true);
  });

  it("넓은 창 계좌 줄 배지 '기본 설명'", () => {
    const r = render(<AccountBriefingRow briefing={ACCOUNT} selected={false} onPress={() => undefined} role="button" />);
    expect(badges(r)).toEqual(["기본 설명"]);
  });
});

describe("켬: 탭 휴장 줄", () => {
  beforeEach(() => {
    h.flags.briefingTrim = true;
  });

  it("보이는 요약이 한국 휴장 한국 요약이면 탭 휴장 줄을 숨긴다 (요약 카드 배너가 이미 말함) · 계좌 카드는 브리핑 날짜 줄", async () => {
    const r = await tab();
    expect(tabHoliday(r)).toEqual([]);
    expect(r.text()).not.toContain("국내 종목 브리핑 없음");
    // 요약 카드의 휴장 배너는 그대로
    expect(wordRows(r)).toContain("오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준");
    expect(muted(r)).toContain(KR_LINE_NEW);
    expect(muted(r)).not.toContain(KR_LINE_OLD);
    expect(muted(r)).toContain("숫자로 만든 요약 · 매매 권유가 아닙니다");
    const card = labels(r).find((l) => l.startsWith("내 계좌 브리핑"))!;
    expect(card).toContain("9월 25일 (금) 한국 휴장, 국내 종목은 직전 거래일 등락");
    expect(card).not.toContain("오늘 한국 휴장");
  });

  it("한국 휴장일 아침('밤사이 미국' 요약)·요약 꺼짐·없음·실패: 탭 휴장 줄은 남고 글만 '국내 종목은 직전 거래일 등락'", async () => {
    const LINE = "한국 휴장일 · 국내 종목은 직전 거래일 등락 · 다음 개장 9월 28일 (월) 09:00";
    h.summaries = [US_MORNING];
    expect(tabHoliday(await tab())).toEqual([LINE]);
    h.summaries = [];
    expect(tabHoliday(await tab())).toEqual([LINE]);
    h.summaries = [summaryItem(9, shared.cases[2]!.data, "failed")];
    expect(tabHoliday(await tab())).toEqual([LINE]);
    h.summaries = [KR_HOLIDAY];
    h.flags.marketSummary = false;
    const r = await tab();
    expect(tabHoliday(r)).toEqual([LINE]);
    expect(r.text()).not.toContain("국내 종목 브리핑 없음");
    // 다음 개장 시각을 모르면 그 부분 없이
    h.market = { KR: { isTradingDay: false, opensAt: null }, US: { isTradingDay: true } };
    expect(tabHoliday(await tab())).toEqual(["한국 휴장일 · 국내 종목은 직전 거래일 등락"]);
  });

  it("거래일에는 탭 휴장 줄이 없다 (켜도 꺼도)", async () => {
    h.market = { KR: { isTradingDay: true, opensAt: null }, US: { isTradingDay: true } };
    expect(tabHoliday(await tab())).toEqual([]);
  });
});

describe("켬: 계좌 카드·줄", () => {
  beforeEach(() => {
    h.flags.briefingTrim = true;
  });

  it("월요일 아침 9/28 08:58 에 금요일 오후 브리핑이 남아 있어도 틀린 말이 아니다: '9/25(금) 한국 휴장 · …' ('오늘 한국 휴장' 0건)", async () => {
    h.now = Date.parse("2026-09-28T08:58:00+09:00");
    h.market = { KR: { isTradingDay: true, opensAt: null }, US: { isTradingDay: true } };
    h.summaries = [];
    const r = await tab();
    expect(muted(r)).toContain(KR_LINE_NEW);
    expect(r.text()).not.toContain("오늘 한국 휴장");
    expect(labels(r).join("\n")).not.toContain("오늘 한국 휴장");
  });

  it("끝줄: 기본 설명 '숫자로 만든 요약 · 매매 권유가 아닙니다', 모델 설명 '숫자로 만든 요약 · 설명은 AI가 쓴 글 · 매매 권유가 아닙니다'", async () => {
    expect(muted(await tab())).toContain("숫자로 만든 요약 · 매매 권유가 아닙니다");
    h.accounts = [{ ...ACCOUNT, template: false, model: "m" }];
    const r = await tab();
    expect(muted(r)).toContain("숫자로 만든 요약 · 설명은 AI가 쓴 글 · 매매 권유가 아닙니다");
    expect(r.text()).not.toContain("무엇이 계좌를 움직였는지");
  });

  it("넓은 창 계좌 줄 배지 '숫자 요약'·화면 읽기 날짜 (탭이 넘긴 trim)", () => {
    const r = render(<AccountBriefingRow briefing={ACCOUNT} selected={false} onPress={() => undefined} role="button" trim />);
    expect(badges(r)).toEqual(["숫자 요약"]);
    expect(labels(r)[0]).toContain("9월 25일 (금) 한국 휴장, 국내 종목은 직전 거래일 등락");
  });
});

describe("켬: 계좌 상세", () => {
  beforeEach(() => {
    h.flags.briefingTrim = true;
  });

  const checkTemplate = (r: R) => {
    // 넓은 창(pane·split)은 요약 줄을 ' · ' 묶음째 그린다 ('… 휴장 ·' | '국내 …') — 이은 글로 본다
    const text = r.text().replace(/ ·(?=\S)/g, " · ");
    // 되풀이 설명 카드가 없다 (제목·기본 설명 배지·안내 모두)
    expect(text).not.toContain("무엇이 계좌를 움직였나");
    expect(text).not.toContain("모델이 쓴 설명");
    expect(ofType(r, "MarkdownView")).toHaveLength(0);
    expect(text).not.toContain("위 숫자로 만든 기본 설명입니다.");
    expect(badges(r)).toContain("숫자로 만든 요약");
    expect(badges(r)).not.toContain("숫자로 만든 기본 설명");
    expect(badges(r)).not.toContain("기본 설명");
    expect(titles(r)).toContain("보유분·지수·환율");
    expect(titles(r)).not.toContain("지수·환율 영향");
    // 요약 셋째 줄(서버가 저장한 '오늘 한국 휴장 · …')은 브리핑 날짜 줄로 그린다
    expect(text).toContain(KR_LINE_NEW);
    expect(text).not.toContain("오늘 한국");
    expect(text).toContain(" 9/25(금) 한국 휴장이라 국내 종목은 직전 거래일 등락입니다(작성 당시 종목 시세 기준 추정).");
    expect(labels(r).find((l) => l.startsWith("요약,"))).toContain("9월 25일 (금) 한국 휴장, 국내 종목은 직전 거래일 등락");
    // 기준 줄(기준·계산 시각)은 남는다
    expect(muted(r).some((x) => x.startsWith("기준: 작성 당시 종목 시세 기준 추정 · "))).toBe(true);
  };

  it("기본 설명(template): 폰(stack)·2단 오른쪽 칸(pane) — 설명 카드 없음, 배지 '숫자로 만든 요약', 제목 '보유분·지수·환율', 휴장 날짜", () => {
    checkTemplate(render(<AccountBriefingBody numId={12} layout="stack" />));
    checkTemplate(render(<AccountBriefingBody numId={12} layout="pane" />));
  });

  it("넓은 창 세 칸(933)·두 칸(704)도 설명 카드 없이 이어진다 — 세 칸 왼쪽은 머리·요약·총 평가 띠·기준 줄", () => {
    h.win = { width: 933, height: 632, scale: 2.625, fontScale: 1 };
    const three = render(<AccountBriefingBody numId={12} layout="split" />);
    const cols = ofType(three, "ScrollView");
    expect(cols).toHaveLength(3);
    checkTemplate(three);
    const left = cols[0]!.children.filter((c): c is HostNode => typeof c !== "string");
    expect(left.map((n) => n.type)).toEqual(["View", "Card", "Card", "Muted"]);
    expect(rawOf(left[3]!)).toMatch(/^기준: /);
    h.win = { width: 704, height: 861, scale: 2.625, fontScale: 1 };
    const two = render(<AccountBriefingBody numId={12} layout="split" />);
    expect(ofType(two, "ScrollView")).toHaveLength(2);
    checkTemplate(two);
  });

  it("모델 설명(검사를 통과한 설명)이면 카드를 남기고 제목만 '모델이 쓴 설명'", () => {
    h.accountDetail = LLM;
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    expect(titles(r)).toContain("모델이 쓴 설명");
    expect(titles(r)).not.toContain("무엇이 계좌를 움직였나");
    expect(ofType(r, "MarkdownView")).toHaveLength(1);
    expect(badges(r)).not.toContain("숫자로 만든 요약");
    h.win = { width: 933, height: 632, scale: 2.625, fontScale: 1 };
    expect(titles(render(<AccountBriefingBody numId={12} layout="split" />))).toContain("모델이 쓴 설명");
  });

  it("휴장이 아닌 날 요약 줄은 저장한 글 그대로 (정확히 '오늘 한국 휴장 · …'인 줄만 바꾼다)", () => {
    const plain = "당일 +795,300원 (+0.86%) · 기여 1위 삼성전자 +348,000원\n총 평가금액 93,218,349원 · 환율 효과 +176,584원";
    h.accountDetail = { ...DETAIL, summary: plain, data: { ...DATA, krPreviousDay: false } };
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    expect(ofType(r, "Text").map(rawOf)).toEqual(expect.arrayContaining(plain.split("\n")));
    expect(r.text()).not.toContain("한국 휴장 ·");
    expect(r.text()).not.toContain("휴장이라");
  });
});

describe("켬: 시장 요약 상세·카드", () => {
  beforeEach(() => {
    h.flags.briefingTrim = true;
  });

  it("'내 보유 종목과 지수' 머리: 첫 줄(바로 위 요약 줄과 같은 말)을 빼고 둘째 줄만, 화면 읽기도 둘째 줄만", () => {
    const r = render(<MarketSummaryBody numId={7} layout="stack" />);
    const d = US_MORNING.data!;
    const first = holdingsSegs(d, { mine: false })!.map((s) => s.text).join("");
    const aux = holdingsAux(d.holdings!);
    expect(wordRows(r)).not.toContain(first);
    expect(wordRows(r)).toContain(aux);
    expect(labels(r)).toContain(speakText(aux));
    // 요약 줄의 '내 미국 12종목 · 지수보다 높음 …'은 그대로 (한 번은 말한다)
    expect(wordRows(r).some((x) => x.startsWith("내 미국 12종목 · 지수보다 높음"))).toBe(true);
    // 업종 줄은 부호대로 (보통 날: 위 모두 +, 아래 모두 −)
    expect(wordRows(r)).toContain("오른 업종 산업재 +0.95% · 기술 +0.80% / 내린 업종 커뮤니케이션 -0.90% · 에너지 -0.89% (섹터 ETF 기준)");
    expect(wordRows(r).some((x) => x.includes("강한 업종"))).toBe(false);
  });

  it("모두 내린 날 탭 카드 업종: '덜 내림'/'많이 내림' (강한 업종 0건), 화면 읽기도 같은 말", async () => {
    const base = shared.cases[2]!.data;
    const s = base.sectors!;
    const down: MarketSummaryData = {
      ...base,
      sectors: { ...s, strong: [{ ...s.strong[0]!, changeRate: -0.1 }, { ...s.strong[1]!, changeRate: -0.3 }], weak: [{ ...s.weak[0]!, changeRate: -2.1 }, { ...s.weak[1]!, changeRate: -1.9 }] },
    };
    h.summaries = [summaryItem(8, down)];
    const r = await tab();
    const rows = wordRows(r);
    expect(rows).toContain(`9/23 기준 · 덜 내림 ${s.strong[0]!.name} -0.10% · ${s.strong[1]!.name} -0.30%`);
    expect(rows).toContain(`많이 내림 ${s.weak[0]!.name} -2.10% · ${s.weak[1]!.name} -1.90%`);
    expect(rows.some((x) => /^(9\/23 기준 · )?[강약] /.test(x))).toBe(false);
    const card = labels(r).find((l) => l.includes("숫자로 만든 요약, 매매 권유가 아닙니다"))!;
    expect(card).toContain("덜 내린 업종");
    expect(card).not.toContain("강한 업종");
  });
});

/**
 * 합친 모습 리뷰 (예전부터 — 3차 줄들과 무관): 360·200% 에서 계좌 줄 제목이 '내 계좌 브…', 475·360 200% 에서 시장 줄 제목이 '금요일(9/25) 미국 …'로
 * 말줄임됐다 (제목은 글자 상한 fontCap.row 인데 배지만 200% 로 커져 폭을 차지). 머리를 세 묶음(지갑·제목 | 배지 | 날짜 ›)으로 나눠
 * 모자라면 뒤 묶음째 다음 줄로, 배지도 같은 상한. 한 줄에 들어가면 같은 모양 (묶음 사이 간격 = 예전 칸 사이 간격)
 */
describe("넓은 창·접은 화면 계좌 줄·시장 줄 머리: 제목을 말줄임하지 않고 묶음째 줄바꿈", () => {
  const kidsOf = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
  const headOf = (r: R, title: string) => {
    const hits = r.all().filter((n) => n.type === "View" && (n.props.style as { flexWrap?: string } | undefined)?.flexWrap === "wrap" && kidsOf(n).some((k) => rawOf(k).startsWith(title)));
    expect(hits.length).toBeGreaterThan(0);
    return hits.at(-1)!;
  };
  const check = (head: HostNode, icon: string) => {
    expect(head.props.style).toMatchObject({ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 6 });
    const [title, badge, end] = kidsOf(head);
    expect(kidsOf(head).map((k) => k.type)).toEqual(["View", "Badge", "View"]);
    // 지갑·지구 아이콘과 제목은 한 묶음 (제목만 다음 줄로 떨어지지 않게), 이 묶음만 줄어든다
    expect(kidsOf(title!).map((k) => k.type)).toEqual(["Ionicons", "Text"]);
    expect(kidsOf(title!)[0]!.props.name).toBe(icon);
    expect(title!.props.style).toMatchObject({ flexDirection: "row", flexShrink: 1 });
    // 배지는 제목·날짜와 같은 글자 상한
    expect(badge!.props.cap).toBe(1.4);
    // 날짜 ›: 한 묶음, 오른쪽 끝 (줄이 바뀌면 다음 줄 오른쪽)
    expect(kidsOf(end!).map((k) => k.type)).toEqual(["Text", "Ionicons"]);
    expect(kidsOf(end!)[1]!.props.name).toBe("chevron-forward");
    expect(end!.props.style).toMatchObject({ marginLeft: "auto", flexShrink: 0 });
  };

  it("계좌 줄", () => {
    const r = render(<AccountBriefingRow briefing={ACCOUNT} selected={false} onPress={() => undefined} role="button" trim />);
    check(headOf(r, "내 계좌 브리핑"), "wallet-outline");
    expect(badges(r)).toEqual(["숫자 요약"]);
    // 배지가 없는 브리핑(모델 설명)은 두 묶음
    const llm = render(<AccountBriefingRow briefing={{ ...ACCOUNT, template: false, model: "m" }} selected={false} onPress={() => undefined} role="link" />);
    expect(kidsOf(headOf(llm, "내 계좌 브리핑")).map((k) => k.type)).toEqual(["View", "View"]);
  });

  it("시장 줄", async () => {
    const { MarketSummaryRow } = await import("@/components/MarketSummaryCard");
    const r = render(<MarketSummaryRow summary={US_MORNING} selected={false} onPress={() => undefined} role="button" />);
    const head = r.all().find((n) => n.type === "View" && kidsOf(n).some((k) => k.type === "View" && kidsOf(k).some((x) => x.type === "Ionicons" && x.props.name === "globe-outline")))!;
    check(head, "globe-outline");
  });
});
