import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, AccountBriefingWithData, AccountData, AccountEvents } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 브리핑 3차 5 — 다가오는 일정 (플래그 holdingEvents, 앱 fallback 꺼짐) 화면.
 *  - 계좌 상세: '오늘 일정' 카드 바로 아래 '다가오는 일정 (보유 종목 · 30일 안)' 카드 (넓은 창은 오른쪽 칸 '오늘 일정' 아래) — 줄마다 화면 읽기 한 문장, 누르는 곳 없음, 색 없음
 *  - 브리핑 탭: 접은 화면 계좌 줄·큰 카드·카드 격자 계좌 줄에 '이번 주 일정 · …' 한 줄 (그 주 첫 오전 브리핑 — headline.week, 2단 계좌 줄에는 없음)
 *  - 꺼짐·예전 기록(칸 없음): 그림 트리가 지금과 같음
 * 시계는 고정 (월 10/26 08:40), RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-10-26T08:40:00+09:00"),
  accounts: [] as unknown[],
  detail: null as unknown,
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
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => h.win.fontScale };
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
  const B = (id: number, code: string, name: string) => ({ id, code, name, session: "morning", date: "2026-10-26", status: "ok", summary: `${name} 요약`, detail: "## 한 줄", missing: [], model: "m", error: null, createdAt: "2026-10-26T08:32:00+09:00" });
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useMarketSummaries: () => q(undefined),
    useMarketSummary: () => q(undefined),
    useAccountBriefings: (enabled: boolean) => q(enabled ? h.accounts : undefined),
    useAccountBriefing: (_id: number, enabled: boolean) => q(enabled ? h.detail : undefined),
    useLatestBriefings: () => q([{ code: "MSFT", name: "마이크로소프트", latest: B(501, "MSFT", "마이크로소프트") }, { code: "005930", name: "삼성전자", latest: B(502, "005930", "삼성전자") }]),
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
const { dark, space, fontCap } = await import("@/tokens");

type Case = { name: string; events: AccountEvents; app: { title: string; sub: string; lines: string[]; empty: string | null; notes: string[]; basis: string; speech: { head: string; lines: string[]; basis: string } } };
type WeekCase = { name: string; week: NonNullable<NonNullable<AccountBriefing["headline"]>["week"]>; app: { text: string; speech: string } };
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/holdingEvents.json", import.meta.url), "utf8")) as { cases: Case[]; week: WeekCase[] };
const OCT = fixture.cases.find((c) => c.name === "oct26Earnings")!;
const NONE = fixture.cases.find((c) => c.name === "none")!;
const FAILED = fixture.cases.find((c) => c.name === "allFailed")!;
const PARTIAL = fixture.cases.find((c) => c.name === "partial")!;
const WEEK = fixture.week.find((c) => c.name === "oct26")!;
/** 묶음 끝 ' ·' 의 공백 = 줄바꿈 없는 공백 */
const NBSP = " ";

/** 월 10/26 08:38 오전 계좌 브리핑 */
const DATA: AccountData = {
  version: 1, session: "morning", date: "2026-10-26", asOf: "2026-10-26T08:38:00+09:00", basis: "앱 잔고 화면과 같은 기준", afterCost: true, holdings: 6, stale: 0,
  totalValue: 10_000_000, totalCost: 8_400_000, totalProfit: 1_600_000, totalProfitRate: 19.05, dayPnl: 212_000, dayRate: 2.16,
  contributions: [
    { code: "MSFT", name: "마이크로소프트", currency: "USD", amount: 150_000, changeRate: 2.1, value: 3_500_000 },
    { code: "005930", name: "삼성전자", currency: "KRW", amount: 62_000, changeRate: 1.83, value: 1_500_000 },
  ],
  others: null,
  markets: { kr: { count: 1, value: 1_500_000, day: 62_000, dayRate: 4.3 }, us: { count: 5, value: 8_500_000, day: 150_000, dayRate: 1.8 } },
  excluded: [],
  fx: { status: "none", reason: "미국 종목이 없어 환율 효과가 없습니다", usdKrw: null, appliedRate: null, usdHoldingsKrwChange: null, priceEffect: null, fxEffect: null },
  indices: [{ code: "KOSPI", name: "코스피", value: 3412.35, change: 27.5, changeRate: 0.81, open: false, stale: false }],
  missingIndices: [],
  schedule: { kr: { date: "2026-10-26", tradingDay: true, now: "개장 전", hours: "정규장 09:00~15:30", nextOpen: null }, us: { date: "2026-10-26", tradingDay: true, now: "미국 휴장 시간", hours: "정규장 10/26 22:30~10/27 05:00 (한국 시간)" }, disclosures: [] },
  narrative: { source: "template", reason: null },
};
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-10-26", session: "morning", status: "ok", summary: "당일 +212,000원 (+2.16%) · 기여 1위 마이크로소프트 +150,000원\n총 평가금액 10,000,000원",
  detail: "- 설명", model: "template", template: true, createdAt: "2026-10-26T08:38:00+09:00",
  headline: { totalValue: 10_000_000, dayPnl: 212_000, dayRate: 2.16, holdings: 6, top: [{ code: "MSFT", name: "마이크로소프트", amount: 150_000, changeRate: 2.1 }] },
};
const detailOf = (e: AccountEvents | undefined): AccountBriefingWithData => ({ ...ACCOUNT, data: e === undefined ? DATA : { ...DATA, events: e } });
const withWeek = (w: WeekCase["week"] | undefined): AccountBriefing => (w ? { ...ACCOUNT, headline: { ...ACCOUNT.headline!, week: w } } : ACCOUNT);

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const allOf = (n: HostNode): HostNode[] => [n, ...kids(n).flatMap(allOf)];
const labels = (r: R) => r.all().map((n) => n.props.accessibilityLabel).filter((x): x is string => typeof x === "string");
const flat = (s: unknown): Record<string, unknown> => (Array.isArray(s) ? Object.assign({}, ...s.map(flat)) : ((s as Record<string, unknown>) ?? {}));
const treeOf = (r: R) =>
  JSON.stringify(r.tree, function (this: unknown, k: string, v: unknown) {
    if (k === "query") return undefined;
    if (k === "children" && !(this && typeof this === "object" && "type" in this && "props" in this)) return undefined;
    return v;
  });
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
/** 카드 이름 (제목 또는 첫 글) */
const cardName = (c: HostNode) => {
  const title = allOf(c).find((n) => n.type === "SectionTitle");
  if (title) return rawOf(title);
  const first = allOf(c).find((n) => n.type === "Muted");
  return first ? rawOf(first).slice(0, 12) : "?";
};
const cardNames = (list: HostNode[]) => list.filter((n) => n.type === "Card").map(cardName);
const upcoming = (r: R) => ofType(r, "Card").filter((c) => cardName(c).startsWith("다가오는 일정"));
/** 일정 줄: 글만 둘 이상 담은 View 를 ' '로 이은 글 (묶음 끝 줄바꿈 없는 공백은 보통 공백으로) */
const chunkRows = (n: HostNode) =>
  allOf(n)
    .filter((v) => v.type === "View" && kids(v).length > 1 && kids(v).every((k) => k.type === "Text" || k.type === "Muted"))
    .map((v) => kids(v).map(rawOf).join(" ").split(`${NBSP}·`).join(" ·"));

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { accountBriefing: true, briefingTrim: true, holdingEvents: true };
  h.now = Date.parse("2026-10-26T08:40:00+09:00");
  h.accounts = [withWeek(WEEK.week)];
  h.detail = detailOf(OCT.events);
  h.store.clear();
  forgetWindowClass();
  pick.forgetPick();
  readStore.forgetRead();
});

describe("계좌 상세: '다가오는 일정' 카드", () => {
  it("폰(stack): '오늘 일정' 카드 바로 아래 · 제목·줄(묶음째)·작은 글·기준 · 화면 읽기는 제목 묶음·줄마다·기준 한 문장씩", () => {
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const names = cardNames(kids(ofType(r, "Screen")[0]!));
    expect(names[names.indexOf("오늘 일정") + 1]).toBe(OCT.app.title);
    const card = upcoming(r)[0]!;
    expect(chunkRows(card)).toEqual(OCT.app.lines);
    const muted = allOf(card).filter((n) => n.type === "Muted").map(rawOf);
    expect(muted).toEqual([OCT.app.sub, ...OCT.app.notes, OCT.app.basis]);
    const spoken = allOf(card).filter((n) => n.props.accessible === true).map((n) => n.props.accessibilityLabel);
    expect(spoken).toEqual([OCT.app.speech.head, ...OCT.app.speech.lines, OCT.app.speech.basis]);
  });

  it("누르는 곳이 없다 (링크·버튼 없음 — 44dp 대상 없음) · 등락 색 없음 · 날짜 묶음만 굵게", () => {
    const card = upcoming(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!;
    expect(allOf(card).some((n) => n.type === "Pressable" || n.props.accessibilityRole === "link" || n.props.accessibilityRole === "button")).toBe(false);
    const texts = allOf(card).filter((n) => n.type === "Text");
    for (const t of texts) expect([dark.up, dark.down]).not.toContain(flat(t.props.style).color);
    const first = texts.find((t) => rawOf(t).startsWith("10/29(목) 오전 5시 이후"))!;
    expect(flat(first.props.style).fontWeight).toBe("600");
    expect(rawOf(first)).toBe(`10/29(목) 오전 5시 이후${NBSP}·`);
  });

  it("2단 오른쪽 칸(pane): '오늘 일정' 바로 아래", () => {
    const r = render(<AccountBriefingBody numId={12} layout="pane" />);
    const names = cardNames(kids(ofType(r, "Screen")[0]!));
    expect(names[names.indexOf("오늘 일정") + 1]).toBe(OCT.app.title);
  });

  it.each([
    ["세 칸 933×704", { width: 933, height: 704 }],
    ["두 칸 704×933", { width: 704, height: 933 }],
  ])("넓은 창 %s: 오른쪽 칸 '오늘 일정' 아래", (_n, size) => {
    h.win = { ...size, scale: 2.625, fontScale: 1 };
    const r = render(<AccountBriefingBody numId={12} layout="split" />);
    const panes = ofType(r, "ScrollView");
    const right = panes.at(-1)!;
    const names = cardNames(kids(right));
    expect(names[names.indexOf("오늘 일정") + 1]).toBe(OCT.app.title);
    expect(upcoming(r)).toHaveLength(1);
    expect(chunkRows(upcoming(r)[0]!)).toEqual(OCT.app.lines);
  });

  it("없음·받지 못함·일부만: 한 줄 또는 작은 글", () => {
    h.detail = detailOf(NONE.events);
    const none = upcoming(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!;
    expect(allOf(none).filter((n) => n.type === "Muted").map(rawOf)).toEqual([NONE.app.sub, NONE.app.empty, NONE.app.basis]);
    expect(chunkRows(none)).toEqual([]);
    cleanupRenders();
    h.detail = detailOf(FAILED.events);
    const failed = upcoming(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!;
    expect(allOf(failed).filter((n) => n.type === "Muted").map(rawOf)).toEqual([FAILED.app.sub, FAILED.app.empty, ...FAILED.app.notes, FAILED.app.basis]);
    cleanupRenders();
    h.detail = detailOf(PARTIAL.events);
    const part = upcoming(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!;
    expect(chunkRows(part)).toEqual(PARTIAL.app.lines);
    expect(allOf(part).filter((n) => n.type === "Muted").map(rawOf)).toEqual([PARTIAL.app.sub, ...PARTIAL.app.notes, PARTIAL.app.basis]);
  });

  it("줄이 많으면 8줄 + '외 N건'", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ code: `C${i}`, name: `종목${i}`, kind: "exDividend" as const, date: `2026-11-${String(i + 1).padStart(2, "0")}`, usDate: true, source: "toss" as const }));
    h.detail = detailOf({ ...OCT.events, items, earnings: false });
    const card = upcoming(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!;
    expect(chunkRows(card)).toHaveLength(8);
    expect(allOf(card).filter((n) => n.type === "Muted").map(rawOf)).toContain("외 2건");
  });

  it.each([
    [360, 752, 1],
    [360, 752, 1.3],
    [360, 752, 2],
    [475, 751, 1],
    [475, 751, 1.3],
    [475, 751, 2],
  ])("글자 크기 %s×%s %s배: 줄 수 제한·글자 줄이기 없이 묶음째 줄바꿈, 묶음 사이는 글자 크기에 맞춰 넓힘", (width, height, fontScale) => {
    h.win = { width, height, scale: 2.625, fontScale };
    const card = upcoming(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!;
    const rows = allOf(card).filter((v) => v.type === "View" && kids(v).length > 1 && kids(v).every((k) => k.type === "Text"));
    expect(rows).toHaveLength(OCT.app.lines.length);
    for (const row of rows) {
      expect(flat(row.props.style)).toMatchObject({ flexDirection: "row", flexWrap: "wrap", columnGap: fontScale >= 1.75 ? space.sm : fontScale >= 1.25 ? space.s : space.xs });
      for (const t of kids(row)) {
        expect(t.props.numberOfLines).toBeUndefined();
        expect(t.props.adjustsFontSizeToFit).toBeUndefined();
      }
    }
    for (const t of allOf(card).filter((n) => n.type === "Muted")) expect(t.props.numberOfLines).toBeUndefined();
  });
});

describe("꺼짐·예전 기록: 지금 그대로", () => {
  it.each(["stack", "pane", "split"] as const)("꺼짐(%s): events 칸이 와도 그림 트리가 칸이 없는 것과 같다", (layout) => {
    h.flags.holdingEvents = false;
    if (layout === "split") h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const withData = treeOf(render(<AccountBriefingBody numId={12} layout={layout} />));
    h.detail = detailOf(undefined);
    sameTree(treeOf(render(<AccountBriefingBody numId={12} layout={layout} />)), withData);
    expect(withData).not.toContain("다가오는 일정");
  });

  it.each(["stack", "pane", "split"] as const)("켬 + 예전 기록(칸 없음) %s: 그림 트리가 꺼진 것과 같다", (layout) => {
    if (layout === "split") h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    h.detail = detailOf(undefined);
    const old = treeOf(render(<AccountBriefingBody numId={12} layout={layout} />));
    h.flags.holdingEvents = false;
    h.detail = detailOf(OCT.events);
    sameTree(old, treeOf(render(<AccountBriefingBody numId={12} layout={layout} />)), "예전 기록");
  });

  it("브리핑 탭(접은 화면·큰 카드·2단·격자): headline.week 가 와도 꺼져 있으면 그림 트리가 지금과 같다", async () => {
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
      h.accounts = [withWeek(WEEK.week)];
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
      expect(withData).not.toContain("이번 주 일정");
    }
  });
});

describe("브리핑 탭 계좌 카드·줄 '이번 주 일정' 한 줄", () => {
  /** 이번 주 줄 (묶음 끝 줄바꿈 없는 공백은 보통 공백으로 읽어 픽스처와 견줌) */
  const lineOf = (r: R) => r.all().filter((n) => n.type === "View" && kids(n).some((k) => k.type === "Text" && rawOf(k).startsWith("이번 주 일정"))).map((v) => kids(v).map(rawOf).join(" ").split(NBSP).join(" "));

  it("접은 화면 맨 위 계좌 줄(475×751): '이번 주 일정 · 마이크로소프트 실적 10/29(목) · 메타 실적 10/29(목) 외 1건' · 화면 읽기 조각은 기여 뒤·'자세히 보기' 앞", async () => {
    h.flags.briefingCompactTop = true;
    const r = render(<BriefingsScreen />);
    await settle(r);
    expect(lineOf(r)).toEqual([WEEK.app.text]);
    const label = labels(r).find((l) => l.startsWith("내 계좌 브리핑"))!;
    expect(label).toContain(`기여 1위 마이크로소프트 150,000원 이익, ${WEEK.app.speech}, 자세히 보기`);
  });

  it("큰 카드(briefingCompactTop 끔, 360×752): 숫자 아래 같은 한 줄 · 글자 크기 상한 없음(카드)", async () => {
    h.win = { width: 360, height: 752, scale: 2.625, fontScale: 1 };
    const r = render(<BriefingsScreen />);
    await settle(r);
    expect(lineOf(r)).toEqual([WEEK.app.text]);
    expect(labels(r).find((l) => l.startsWith("내 계좌 브리핑"))).toContain(WEEK.app.speech);
    for (const t of r.all().filter((n) => n.type === "Text" && rawOf(n).startsWith("이번 주 일정"))) expect(t.props.maxFontSizeMultiplier).toBeUndefined();
  });

  it("넓은 창 2단(933×704): 계좌 줄에는 넣지 않는다 · 카드 격자(704×933): 넣는다", async () => {
    h.flags = { ...h.flags, foldLayout: true, briefingCompactTop: true };
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    h.store.set("briefings.read", "[]");
    const two = render(<BriefingsScreen />);
    await settle(two);
    // 2단은 오른쪽 칸에 계좌 상세(다가오는 일정 카드)가 열려 있을 수 있어 목록 줄 모양만 본다
    expect(lineOf(two)).toEqual([]);
    expect(labels(two).find((l) => l.startsWith("내 계좌 브리핑"))).not.toContain("이번 주 보유 종목 일정");
    cleanupRenders();
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    forgetWindowClass();
    const grid = render(<BriefingsScreen />);
    await settle(grid);
    expect(lineOf(grid)).toEqual([WEEK.app.text]);
  });

  it("자리: 기여(1위·상위 묶음)와 지난 브리핑 비교 줄 뒤, 휴장 줄 앞 · 계좌 줄 글은 다른 줄 글과 같은 상한(fontCap.row)", () => {
    const idxOf = (list: HostNode[], re: RegExp) => list.findIndex((n) => re.test(rawOf(n)));
    const item = { ...withWeek(WEEK.week), headline: { ...withWeek(WEEK.week).headline!, krPreviousDay: true, since: { date: "2026-10-23", session: "morning" as const, change: 50_000, qtyChanged: 0 } } };
    const row = render(<AccountBriefingRow briefing={item} selected={false} onPress={() => undefined} role="link" contributors since week holidayLines trim />);
    const rowKids = kids(ofType(row, "Pressable")[0]!);
    const since = idxOf(rowKids, /오전보다 총 평가/);
    expect(since).toBeGreaterThan(0);
    expect(idxOf(rowKids, /^이번 주 일정/)).toBe(since + 1);
    expect(idxOf(rowKids, /휴장/)).toBe(since + 2);
    for (const t of row.all().filter((n) => n.type === "Text" && rawOf(n).startsWith("이번 주 일정"))) expect(t.props.maxFontSizeMultiplier).toBe(fontCap.row);
    const card = render(<AccountBriefingCard briefing={item} week />);
    const cardKids = kids(ofType(card, "Pressable")[0]!);
    expect(idxOf(cardKids, /^이번 주 일정/)).toBe(idxOf(cardKids, /^기여 1위/) + 1);
  });

  it("그 주 첫 오전 브리핑이 아니거나(칸 없음) 실패한 브리핑은 줄 없음 · 색 없음", () => {
    expect(render(<AccountBriefingRow briefing={ACCOUNT} selected={false} onPress={() => undefined} role="link" week />).text()).not.toContain("이번 주");
    expect(render(<AccountBriefingCard briefing={{ ...withWeek(WEEK.week), status: "failed" }} week />).text()).not.toContain("이번 주");
    const r = render(<AccountBriefingCard briefing={withWeek(WEEK.week)} week />);
    for (const t of r.all().filter((n) => n.type === "Text" && /이번 주|실적/.test(rawOf(n)))) expect([dark.up, dark.down]).not.toContain(flat(t.props.style).color);
    // 묶음 끝 '·' 앞은 줄바꿈 없는 공백 · 마지막 묶음에는 '·' 없음
    const parts = r.all().filter((n) => n.type === "Text" && /^(이번 주 일정|마이크로소프트 실적|메타 실적)/.test(rawOf(n))).map(rawOf);
    expect(parts).toEqual([`이번 주 일정${NBSP}·`, `마이크로소프트 실적 10/29(목)${NBSP}·`, "메타 실적 10/29(목) 외 1건"]);
  });
});
