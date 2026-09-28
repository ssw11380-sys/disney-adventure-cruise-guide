import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, AccountBriefingWithData, AccountData, AccountSinceLast } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 브리핑 3차 3 — 지난 브리핑과 비교 (플래그 accountSinceLast, 앱 fallback 꺼짐) 화면.
 *  - 계좌 상세: 당일 손익 기여 표(2단 오른쪽 칸·넓은 창 두 칸도) 바로 아래 '지난 오전 브리핑과 비교' 카드 — 세 칸은 기여 표가 가운데 칸이라 왼쪽 칸 총 평가 띠 아래.
 *    비교할 브리핑이 없으면 한 줄, 예전 기록은 없음
 *  - 브리핑 탭: 접은 화면 계좌 줄·큰 카드·카드 격자 계좌 줄에 '9/25(금) 오전보다 총 평가 …' 한 줄 — 기여(1위·상위 묶음) 뒤, 휴장 줄 앞 (2단 계좌 줄에는 없음)
 *  - 꺼짐: 새 칸이 와도 그림 트리가 지금과 같음
 * 시계는 고정 (월 9/28 08:40), RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-28T08:40:00+09:00"),
  accounts: [] as unknown[],
  detail: null as unknown,
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
  const B = (id: number, code: string, name: string) => ({ id, code, name, session: "morning", date: "2026-09-28", status: "ok", summary: `${name} 요약`, detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: "2026-09-28T08:32:00+09:00" });
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useMarketSummaries: () => q(undefined),
    useMarketSummary: () => q(undefined),
    useAccountBriefings: (enabled: boolean) => q(enabled ? h.accounts : undefined),
    useAccountBriefing: (_id: number, enabled: boolean) => q(enabled ? h.detail : undefined),
    useLatestBriefings: () => q([{ code: "005930", name: "삼성전자", latest: B(501, "005930", "삼성전자") }, { code: "NVDA", name: "엔비디아", latest: B(502, "NVDA", "엔비디아") }]),
    useRegisteredStocks: () => q([]),
    useHealth: () => q({ llmConfigured: true, lastBriefing: null }),
    useMarketStatus: () => q({ KR: { isTradingDay: true, opensAt: null }, US: { isTradingDay: true } }),
    useStockMutations: () => ({ run: { mutate: vi.fn(), isPending: false, variables: undefined } }),
    useBriefing: () => q(undefined),
    useBriefings: () => q(undefined),
  };
});

const { default: BriefingsScreen } = await import("@/app/(tabs)/briefings");
const { AccountBriefingBody } = await import("@/components/AccountBriefingBody");
const { AccountBriefingCard, AccountBriefingRow } = await import("@/components/AccountBriefingCard");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const pick = await import("@/lib/briefingPick");
const readStore = await import("@/lib/briefingRead");
const { dark } = await import("@/tokens");

type Case = { name: string; expected: AccountSinceLast; app: { title: string; range: string; qty: string[] | null; weights: string[] | null; notes: string[]; headSpeech: string; line: string | null; lineSpeech: string | null } };
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountSinceLast.json", import.meta.url), "utf8")) as { cases: Case[] };
const MONDAY = fixture.cases.find((c) => c.name === "monday")!;
const FIRST = fixture.cases.find((c) => c.name === "firstDay")!;
const EXCLUDED = fixture.cases.find((c) => c.name === "excluded")!;
const MIXED = fixture.cases.find((c) => c.name === "mixedFirstDay")!;

/** 월 9/28 08:38 오전 계좌 브리핑 (숫자는 픽스처 monday 의 이번 브리핑) */
const DATA: AccountData = {
  version: 1, session: "morning", date: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", basis: "앱 잔고 화면과 같은 기준", afterCost: true, holdings: 6, stale: 0,
  totalValue: 11_926_340, totalCost: 10_146_340, totalProfit: 1_780_000, totalProfitRate: 17.54, dayPnl: 212_000, dayRate: 1.81,
  contributions: [
    { code: "NVDA", name: "엔비디아", currency: "USD", amount: 150_000, changeRate: 5.87, value: 2_706_900 },
    { code: "000660", name: "SK하이닉스", currency: "KRW", amount: 62_000, changeRate: 1.83, value: 3_450_000 },
  ],
  others: null,
  markets: { kr: { count: 3, value: 6_693_000, day: 62_000, dayRate: 0.93 }, us: { count: 3, value: 5_233_340, day: 150_000, dayRate: 2.95 } },
  excluded: [],
  fx: { status: "none", reason: "미국 종목이 없어 환율 효과가 없습니다", usdKrw: null, appliedRate: null, usdHoldingsKrwChange: null, priceEffect: null, fxEffect: null },
  indices: [{ code: "KOSPI", name: "코스피", value: 3412.35, change: 27.5, changeRate: 0.81, open: false, stale: false }],
  missingIndices: [],
  schedule: { kr: { date: "2026-09-28", tradingDay: true, now: "개장 전", hours: "정규장 09:00~15:30", nextOpen: null }, us: { date: "2026-09-28", tradingDay: true, now: "미국 휴장 시간", hours: "정규장 9/28 22:30~9/29 05:00 (한국 시간)" }, disclosures: [] },
  narrative: { source: "template", reason: null },
};
/** 서버 toBriefing·sinceHeadline 과 같은 값 (금액을 맞추지 못한 비교 — scope mixed — 는 한 줄 없음) */
const since = (s: AccountSinceLast) =>
  s.scope === "mixed"
    ? undefined
    : {
        date: s.prev.date, session: s.prev.session, change: s.value.change,
        qtyChanged: s.positions ? s.positions.added.length + s.positions.removed.length + s.positions.increased.length + s.positions.decreased.length : null,
        ...(s.scope === "common" && s.oneSide?.length ? { leftOut: s.oneSide.length } : {}),
      };
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-09-28", session: "morning", status: "ok", summary: "당일 +212,000원 (+1.81%) · 기여 1위 엔비디아 +150,000원\n총 평가금액 11,926,340원",
  detail: "- 설명", model: "template", template: true, createdAt: "2026-09-28T08:38:00+09:00",
  headline: { totalValue: 11_926_340, dayPnl: 212_000, dayRate: 1.81, holdings: 6, top: [{ code: "NVDA", name: "엔비디아", amount: 150_000, changeRate: 5.87 }] },
};
const withSince = (s: AccountSinceLast | null | undefined): { item: AccountBriefing; detail: AccountBriefingWithData } => {
  const data: AccountData = s === undefined ? DATA : { ...DATA, sinceLast: s, positions: [] };
  const head = s ? since(s) : undefined;
  const item = head ? { ...ACCOUNT, headline: { ...ACCOUNT.headline!, since: head } } : ACCOUNT;
  return { item, detail: { ...item, data } };
};

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const labels = (r: R) => r.all().map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");
/** 그림 트리 글: 그려진 호스트 노드·속성 (끊김 띠의 query 속성 — 받은 자료 그대로 — 와 그리기 전 요소 목록은 빼고) */
const treeOf = (r: R) =>
  JSON.stringify(r.tree, function (this: unknown, k: string, v: unknown) {
    if (k === "query") return undefined;
    // 호스트 요소의 props.children(그리기 전 요소 목록 — 빈 자리 null 포함)은 빼고 그려진 children 만 본다
    if (k === "children" && !(this && typeof this === "object" && "type" in this && "props" in this)) return undefined;
    return v;
  });
/** 두 그림 트리 글이 같은지 (다르면 처음 다른 곳 앞뒤를 보인다) */
const sameTree = (a: string, b: string, what = "") => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  expect(i === a.length && i === b.length ? "같음" : `${what} ${i}: …${a.slice(Math.max(0, i - 160), i + 80)}
≠ …${b.slice(Math.max(0, i - 160), i + 80)}`).toBe("같음");
};
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};
/** 비교 카드 (제목으로 찾는다) */
const sinceCard = (r: R) => ofType(r, "Card").find((c) => ofType({ all: () => allOf(c) } as R, "SectionTitle").some((t) => rawOf(t).startsWith("지난 ")));
const allOf = (n: HostNode): HostNode[] => [n, ...kids(n).flatMap(allOf)];
/** 묶음째 줄바꿈하는 줄: 글(Text·Muted)만 둘 이상 담은 View 를 ' '로 이은 글 */
const chunkRows = (n: HostNode) =>
  allOf(n)
    .filter((v) => v.type === "View" && kids(v).length > 1 && kids(v).every((k) => k.type === "Text" || k.type === "Muted"))
    .map((v) => kids(v).map(rawOf).join(" "));
/** 카드의 순서 (제목·첫 글로 이름을 붙인다) */
const cardNames = (list: HostNode[]) =>
  list
    .filter((n) => n.type === "Card")
    .map((c) => {
      const title = allOf(c).find((n) => n.type === "SectionTitle");
      if (title) return rawOf(title);
      const first = allOf(c).find((n) => n.type === "Muted");
      return first ? rawOf(first).slice(0, 12) : "?";
    });

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { accountBriefing: true, briefingTrim: true };
  h.now = Date.parse("2026-09-28T08:40:00+09:00");
  const m = withSince(MONDAY.expected);
  h.accounts = [m.item];
  h.detail = m.detail;
  h.push.mockReset();
  h.store.clear();
  forgetWindowClass();
  pick.forgetPick();
  readStore.forgetRead();
});

describe("계좌 상세: '지난 오전 브리핑과 비교' 카드", () => {
  beforeEach(() => {
    h.flags.accountSinceLast = true;
  });

  it("폰(stack): 당일 손익 기여 표 바로 아래(첫 화면에서 기여 표를 밀어내지 않게) · 제목·기간·금액·수량·비중·작은 글 · 화면 읽기 묶음 세 문장", () => {
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const screen = ofType(r, "Screen")[0]!;
    const names = cardNames(kids(screen));
    const at = names.indexOf("지난 오전 브리핑과 비교");
    expect(at).toBeGreaterThan(0);
    // 총 평가 카드 → 기여 표 → 비교 카드 → 보유분·지수·환율
    expect(names[at - 2]).toMatch(/^총 평가금액 · 비용/);
    expect(names[at - 1]).toBe("당일 손익 기여");
    expect(names[at + 1]).toBe("보유분·지수·환율");
    const card = sinceCard(r)!;
    const text = rawOf(card);
    for (const s of [MONDAY.app.range, "총 평가금액", "-419,338원", " (-3.40%)", "평가손익", "+546,000원", "수량이 바뀐 종목", "비중 변화가 큰 종목", ...MONDAY.app.notes]) expect(text, s).toContain(s);
    // 줄바꿈 묶음 줄(묶음마다 글 하나)을 ' '로 이은 한 줄
    const lines = chunkRows(card);
    expect(lines).toContain("12,345,678원 → 11,926,340원");
    expect(lines).toContain("+1,234,000원 → +1,780,000원");
    for (const l of MONDAY.app.qty!) expect(lines).toContain(l);
    for (const w of MONDAY.app.weights!) expect(lines).toContain(w);
    const groups = allOf(card).filter((n) => n.props.accessible === true).map((n) => String(n.props.accessibilityLabel));
    expect(groups).toHaveLength(3);
    expect(groups[0]).toBe(MONDAY.app.headSpeech);
    expect(groups[1]).toMatch(/^수량이 바뀐 종목 4개, 새 종목 삼성전자 10주/);
    expect(groups[2]).toMatch(/^비중 변화가 큰 종목, 엔비디아 18.2퍼센트에서 22.7퍼센트로/);
  });

  it("색: 변화 금액·%p 에만 (줄어듦 = 파랑, 늘어남 = 빨강), 지난 → 이번 숫자는 색 없음", () => {
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const card = sinceCard(r)!;
    const colorOf = (s: string) => {
      const n = allOf(card).filter((x) => x.type === "Text" && rawOf(x) === s);
      return n.map((x) => (Array.isArray(x.props.style) ? Object.assign({}, ...(x.props.style as object[])) : (x.props.style as { color?: string }))?.color);
    };
    expect(colorOf("-419,338원 (-3.40%)")).toEqual([dark.down]);
    expect(colorOf(" (-3.40%)")).toEqual([dark.down]);
    expect(colorOf("+546,000원")).toEqual([dark.up]);
    expect(colorOf("(+4.5%p)")).toEqual([dark.up]);
    const fromTo = allOf(card).find((x) => x.type === "Muted" && rawOf(x) === "12,345,678원")!;
    expect(JSON.stringify(fromTo.props.style ?? {})).not.toContain(dark.down);
  });

  it("비교할 브리핑이 없음(sinceLast null): '비교할 지난 오전 브리핑이 없습니다.' 한 줄 카드", () => {
    h.detail = withSince(null).detail;
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    expect(sinceCard(r)).toBeUndefined();
    const one = ofType(r, "Card").filter((c) => rawOf(c) === "비교할 지난 오전 브리핑이 없습니다.");
    expect(one).toHaveLength(1);
  });

  it("배포 첫날(지난 브리핑에 종목별 값 없음): 금액 두 줄과 '다음 브리핑부터' 안내, 수량·비중 묶음 없음", () => {
    h.detail = withSince(FIRST.expected).detail;
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const card = sinceCard(r)!;
    expect(rawOf(card)).toContain("종목별 변화는 다음 브리핑부터 보입니다 (이전 브리핑에 종목별 값이 없음).");
    expect(rawOf(card)).not.toContain("수량이 바뀐 종목");
    expect(allOf(card).filter((n) => n.props.accessible === true)).toHaveLength(1);
  });

  it("조용한 날(수량 그대로·비중 변화 작음): 머리 없이 '없음' 한 줄씩, 사고판 문장 없음", () => {
    const QUIET = fixture.cases.find((c) => c.name === "afternoonQuiet")!;
    h.detail = withSince(QUIET.expected).detail;
    const card = sinceCard(render(<AccountBriefingBody numId={12} layout="stack" />))!;
    const texts = allOf(card).filter((n) => n.type === "Text" || n.type === "Muted").map(rawOf);
    expect(texts).toContain("수량이 바뀐 종목 없음");
    expect(texts).toContain("비중이 0.5%p 이상 바뀐 종목 없음");
    expect(texts).not.toContain("수량이 바뀐 종목");
    expect(texts).not.toContain("비중 변화가 큰 종목");
    expect(rawOf(card)).not.toContain("사고판");
  });

  it("2단 오른쪽 칸(pane): 기여 표 바로 아래", () => {
    const r = render(<AccountBriefingBody numId={12} layout="pane" />);
    const names = cardNames(kids(ofType(r, "Screen")[0]!));
    const at = names.indexOf("지난 오전 브리핑과 비교");
    expect(names[at - 2]).toMatch(/^총 평가금액 · 비용/);
    expect(names[at - 1]).toBe("당일 손익 기여");
    expect(names[at + 1]).toBe("보유분·지수·환율");
  });

  it.each([
    ["세 칸 933×704", { width: 933, height: 704 }],
    ["두 칸 704×933", { width: 704, height: 933 }],
  ])("넓은 창 %s: 왼쪽 칸 (두 칸은 기여 표 아래, 세 칸은 기여 표가 가운데 칸이라 총 평가 띠 아래)", (_n, size) => {
    h.win = { ...size, scale: 2.625, fontScale: 1 };
    const r = render(<AccountBriefingBody numId={12} layout="split" />);
    const left = ofType(r, "ScrollView")[0]!;
    const names = cardNames(kids(left));
    const at = names.indexOf("지난 오전 브리핑과 비교");
    expect(at).toBeGreaterThan(0);
    if (size.width === 704) {
      expect(names[at - 2]).toMatch(/^총 평가금액 · 비용/);
      expect(names[at - 1]).toBe("당일 손익 기여");
      expect(at).toBe(names.length - 1);
    } else {
      expect(names[at - 1]).toMatch(/^총 평가금액 · 비용/);
      expect(names.includes("당일 손익 기여")).toBe(false); // 세 칸은 기여 표가 가운데 칸
    }
  });

  it("한쪽 브리핑 합계에서만 빠진 종목(리뷰 고침): 두 브리핑 모두 값이 있는 종목끼리의 금액·비중과 사실대로의 작은 글 ('비교에서 뺐습니다' 없음)", () => {
    h.detail = withSince(EXCLUDED.expected).detail;
    const card = sinceCard(render(<AccountBriefingBody numId={12} layout="stack" />))!;
    const text = rawOf(card);
    for (const s of ["+300,000원", " (+3.33%)", ...EXCLUDED.app.notes]) expect(text, s).toContain(s);
    expect(chunkRows(card)).toContain("9,000,000원 → 9,300,000원");
    for (const w of EXCLUDED.app.weights!) expect(chunkRows(card)).toContain(w);
    expect(text).not.toContain("비교에서 뺐습니다");
    expect(text).not.toContain("-1,000,000원");
    expect(allOf(card).find((n) => n.props.accessible === true)!.props.accessibilityLabel).toBe(EXCLUDED.app.headSpeech);
  });

  it("종목별 값이 없어 그 종목을 빼지 못한 비교(mixed): 카드에 금액 그대로 + 사실대로의 작은 글", () => {
    h.detail = withSince(MIXED.expected).detail;
    const card = sinceCard(render(<AccountBriefingBody numId={12} layout="stack" />))!;
    const text = rawOf(card);
    for (const s of ["-700,000원", ...MIXED.app.notes]) expect(text, s).toContain(s);
    expect(rawOf(card)).not.toContain("수량이 바뀐 종목");
  });

  it("예전 기록(칸 없음)은 켜도 카드가 없고 그림 트리가 꺼진 것과 같다", () => {
    h.detail = withSince(undefined).detail;
    const on = treeOf(render(<AccountBriefingBody numId={12} layout="stack" />));
    h.flags.accountSinceLast = false;
    sameTree(treeOf(render(<AccountBriefingBody numId={12} layout="stack" />)), on);
  });
});

describe("꺼짐 (앱 기본): 지금 그대로", () => {
  it.each(["stack", "pane", "split"] as const)("계좌 상세(%s): 비교 칸이 와도 그림 트리가 칸이 없는 것과 같다", (layout) => {
    if (layout === "split") h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const withData = treeOf(render(<AccountBriefingBody numId={12} layout={layout} />));
    h.detail = withSince(undefined).detail;
    sameTree(treeOf(render(<AccountBriefingBody numId={12} layout={layout} />)), withData);
    expect(withData).not.toContain("지난 오전 브리핑과 비교");
  });

  it("브리핑 탭(접은 화면·큰 카드·2단·격자): headline.since 가 와도 그림 트리가 지금과 같다", async () => {
    for (const [flags, win] of [
      [{ briefingCompactTop: true }, { width: 475, height: 751 }],
      [{}, { width: 360, height: 752 }],
      [{ foldLayout: true, briefingCompactTop: true }, { width: 933, height: 704 }],
      [{ foldLayout: true, briefingCompactTop: true }, { width: 704, height: 933 }],
    ] as const) {
      cleanupRenders();
      h.flags = { accountBriefing: true, ...flags };
      h.win = { ...win, scale: 2.625, fontScale: 1 };
      forgetWindowClass();
      pick.forgetPick();
      h.accounts = [withSince(MONDAY.expected).item];
      const a = render(<BriefingsScreen />);
      await settle(a);
      const withData = treeOf(a);
      cleanupRenders();
      forgetWindowClass();
      pick.forgetPick();
      h.accounts = [ACCOUNT];
      const b = render(<BriefingsScreen />);
      await settle(b);
      sameTree(treeOf(b), withData, JSON.stringify(win));
      expect(withData).not.toContain("오전보다 총 평가");
    }
  });
});

describe("브리핑 탭 계좌 카드·줄 한 줄", () => {
  beforeEach(() => {
    h.flags.accountSinceLast = true;
  });
  const lineOf = (r: R) => r.all().filter((n) => n.type === "View" && kids(n).some((k) => k.type === "Text" && rawOf(k).includes("오전보다 총 평가"))).map((v) => kids(v).map(rawOf).join(" "));

  it("접은 화면 맨 위 계좌 줄(475×751): 숫자 줄 아래 '9/25(금) 오전보다 총 평가 -419,338원 ·' + '수량 바뀐 종목 4' · 화면 읽기 조각은 기여 1위 뒤(보이는 순서)", async () => {
    h.flags.briefingCompactTop = true;
    const r = render(<BriefingsScreen />);
    await settle(r);
    expect(lineOf(r)).toEqual(["9/25(금) 오전보다 총 평가 -419,338원 · 수량 바뀐 종목 4"]);
    const label = labels(r).find((l) => l.startsWith("내 계좌 브리핑"))!;
    expect(label).toContain(`총 평가금액 11,926,340원, 기여 1위 엔비디아 150,000원 이익, ${MONDAY.app.lineSpeech}, 자세히 보기`);
    // 금액만 색 (줄어듦 = 파랑)
    const amount = r.all().find((n) => n.type === "Text" && rawOf(n) === "-419,338원")!;
    expect(JSON.stringify(amount.props.style)).toContain(dark.down);
  });

  it("큰 카드(briefingCompactTop 끔, 360×752): 숫자 아래 같은 한 줄", async () => {
    h.win = { width: 360, height: 752, scale: 2.625, fontScale: 1 };
    const r = render(<BriefingsScreen />);
    await settle(r);
    expect(lineOf(r)).toEqual(["9/25(금) 오전보다 총 평가 -419,338원 · 수량 바뀐 종목 4"]);
    expect(labels(r).find((l) => l.startsWith("내 계좌 브리핑"))).toContain(MONDAY.app.lineSpeech);
  });

  it("넓은 창 2단(933×704): 계좌 줄에는 넣지 않는다 (첫 화면 줄 수) · 카드 격자(704×933): 넣는다", async () => {
    h.flags = { ...h.flags, foldLayout: true, briefingCompactTop: true };
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    h.store.set("briefings.read", "[]");
    const two = render(<BriefingsScreen />);
    await settle(two);
    expect(lineOf(two)).toEqual([]);
    expect(labels(two).find((l) => l.startsWith("내 계좌 브리핑"))).not.toContain("오전 브리핑보다");
    cleanupRenders();
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    const grid = render(<BriefingsScreen />);
    await settle(grid);
    expect(lineOf(grid)).toEqual(["9/25(금) 오전보다 총 평가 -419,338원 · 수량 바뀐 종목 4"]);
  });

  it("자리(리뷰 고침): 기여 상위 묶음 뒤·휴장 줄 앞 — 당일 손익 묶음을 가르지 않고, 묶음 머리의 '08:38 기준'이 이 줄의 시각으로 읽히지 않게", () => {
    const item = withSince(MONDAY.expected).item;
    const idxOf = (list: HostNode[], re: RegExp) => list.findIndex((n) => re.test(rawOf(n)));
    // 접은 화면 계좌 줄 (기여 상위 묶음 켬)
    const row = render(<AccountBriefingRow briefing={item} selected={false} onPress={() => undefined} role="link" contributors since />);
    const rowKids = kids(ofType(row, "Pressable")[0]!);
    const contrib = idxOf(rowKids, /당일 손익 기여 상위/);
    expect(contrib).toBeGreaterThan(0);
    expect(idxOf(rowKids, /오전보다 총 평가/)).toBe(contrib + 1);
    // 큰 카드: 기여 상위 묶음 뒤, 한국 휴장 줄 앞
    const kr = { ...item, headline: { ...item.headline!, krPreviousDay: true } };
    const card = render(<AccountBriefingCard briefing={kr} contributors since />);
    const cardKids = kids(ofType(card, "Pressable")[0]!);
    const block = idxOf(cardKids, /당일 손익 기여 상위/);
    const line = idxOf(cardKids, /오전보다 총 평가/);
    expect(line).toBe(block + 1);
    expect(idxOf(cardKids, /휴장/)).toBe(line + 1);
    // 기여 1위 한 줄(묶음 끔)이면 그 줄 뒤
    const one = kids(ofType(render(<AccountBriefingCard briefing={item} since />), "Pressable")[0]!);
    expect(idxOf(one, /오전보다 총 평가/)).toBe(idxOf(one, /^기여 1위/) + 1);
  });

  it("금액 비교에서 뺀 종목이 있으면 '· 1종목 빼고 비교' 묶음 · 금액을 맞추지 못한 비교(mixed)는 줄 없음", async () => {
    h.flags.briefingCompactTop = true;
    h.accounts = [withSince(EXCLUDED.expected).item];
    const r = render(<BriefingsScreen />);
    await settle(r);
    expect(lineOf(r)).toEqual([EXCLUDED.app.line]);
    expect(labels(r).find((l) => l.startsWith("내 계좌 브리핑"))).toContain(EXCLUDED.app.lineSpeech!);
    cleanupRenders();
    h.accounts = [withSince(MIXED.expected).item];
    const m = render(<BriefingsScreen />);
    await settle(m);
    expect(lineOf(m)).toEqual([]);
    expect(labels(m).find((l) => l.startsWith("내 계좌 브리핑"))).not.toContain("오전 브리핑보다");
  });

  it("비교가 없는 브리핑·실패 브리핑은 줄 없음 · 수량 모름(첫날)은 수량 조각 없음", () => {
    expect(render(<AccountBriefingRow briefing={ACCOUNT} selected={false} onPress={() => undefined} role="link" since />).text()).not.toContain("오전보다");
    const failed = { ...withSince(MONDAY.expected).item, status: "failed" as const };
    expect(render(<AccountBriefingCard briefing={failed} since />).text()).not.toContain("오전보다");
    const first = render(<AccountBriefingCard briefing={withSince(FIRST.expected).item} since />);
    expect(lineOf(first)).toEqual(["9/25(금) 오전보다 총 평가 +544,322원"]);
  });

  it("계좌 줄의 글자 크기 상한: 줄 글은 다른 줄 글과 같은 상한(fontCap.row), 큰 카드는 상한 없음", async () => {
    const { fontCap } = await import("@/tokens");
    const row = render(<AccountBriefingRow briefing={withSince(MONDAY.expected).item} selected={false} onPress={() => undefined} role="link" since />);
    const texts = row.all().filter((n) => n.type === "Text" && /오전보다|수량 바뀐/.test(rawOf(n)) && rawOf(n) !== "-419,338원");
    expect(texts.length).toBe(2);
    for (const t of texts) expect(t.props.maxFontSizeMultiplier).toBe(fontCap.row);
    const card = render(<AccountBriefingCard briefing={withSince(MONDAY.expected).item} since />);
    for (const t of card.all().filter((n) => n.type === "Text" && /오전보다/.test(rawOf(n)))) expect(t.props.maxFontSizeMultiplier).toBeUndefined();
  });
});
