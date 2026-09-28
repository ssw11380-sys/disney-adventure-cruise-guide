import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, AccountBriefingWithData, AccountData, AccountEvents, HoldingSchedule, ScheduleFilingItem, ScheduleFilings } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 3-38 '일정·공시' (플래그 holdingSchedule·filingAlerts, 앱 fallback 꺼짐):
 *  - 계좌 상세 '다가오는 일정'(없으면 '오늘 일정') 카드 맨 아래 '일정·공시 모두 보기 ›' 한 줄 (44dp · 이름 · 누르면 /schedule · 받아 둔 화면 값이 있으면 '· 새 공시 N건')
 *  - 꺼짐: 카드 트리가 지금과 같음
 *  - '일정·공시' 화면: 다가오는 일정 · 최근 공시 (미국) 줄·새 공시 칩·펼침·원문 버튼 · 한국 공시 안내 · 없음/받지 못함/멈춤 글 · 폭·글자 크기 · 두 칸(933×704)
 * 시계 고정 (목 7/30 07:03 KST), RN 부품·공용 UI 는 문자열 요소로, API 훅·화면 쿼리는 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  detail: null as unknown,
  schedule: undefined as unknown,
  scheduleError: false,
  cached: undefined as unknown,
  store: new Map<string, string>(),
  push: vi.fn(),
  openURL: vi.fn(async (_u: string) => undefined as unknown),
  scrollTo: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Linking: { openURL: (u: string) => h.openURL(u) },
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
vi.mock("expo-router", () => ({ router: { push: h.push, dismissTo: vi.fn(), replace: vi.fn() }, Stack: { Screen: "StackScreen" }, useLocalSearchParams: () => ({ id: "12" }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => h.win.fontScale };
});
vi.mock("@/components/Screen", () => ({
  Screen: ({ children, scrollRef, ...rest }: { children: React.ReactNode; scrollRef?: React.Ref<unknown> } & Record<string, unknown>) => {
    if (scrollRef && typeof scrollRef === "object") (scrollRef as { current: unknown }).current = { scrollTo: h.scrollTo };
    return React.createElement("Screen", rest, children);
  },
}));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/Freshness", () => ({ StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", Empty: "Empty", ErrorView: "ErrorView", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented", TableHead: "TableHead",
}));
vi.mock("@/api/hooks", () => {
  const q = (data: unknown) => ({ data, isError: false, error: null, isSuccess: data !== undefined, refetch: vi.fn(async () => undefined), dataUpdatedAt: 1, errorUpdatedAt: 0, fetchStatus: "idle" });
  return {
    useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
    useFeatures: () => ({ data: { features: h.flags }, isFetching: false, refetch: vi.fn() }),
    useAccountBriefing: (_id: number, enabled: boolean) => q(enabled ? h.detail : undefined),
  };
});
vi.mock("@/lib/scheduleQuery", () => ({
  useHoldingSchedule: (enabled: boolean) => ({
    data: enabled && !h.scheduleError ? h.schedule : undefined,
    isError: h.scheduleError,
    isRefetching: false,
    refetch: vi.fn(async () => undefined),
  }),
  useCachedSchedule: () => h.cached,
}));

const { AccountBriefingBody } = await import("@/components/AccountBriefingBody");
const { ScheduleScreen } = await import("@/components/ScheduleScreen");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { forgetFilingViewed } = await import("@/lib/filingViewed");
const F = await import("@/lib/filingAlerts");
const { dark, space, touch } = await import("@/tokens");

type EventCase = { name: string; events: AccountEvents; app: { title: string; sub: string; lines: string[]; empty: string | null; notes: string[]; basis: string } };
const EVENTS = JSON.parse(readFileSync(new URL("../../shared/fixtures/holdingEvents.json", import.meta.url), "utf8")) as { cases: EventCase[] };
const SEP = EVENTS.cases.find((c) => c.name === "sep28")!;
const FX = JSON.parse(readFileSync(new URL("../../shared/fixtures/filingAlerts.json", import.meta.url), "utf8")) as {
  items: ScheduleFilingItem[];
  app: { lines: Array<{ accession: string; head: string; speech: string; time: string; timeSpeech: string }> };
};
const MSFT_8K = FX.items.find((i) => i.form === "8-K" && i.code === "MSFT")!;
const TSM_6K = FX.items.find((i) => i.form === "6-K")!;
const FILINGS: ScheduleFilings = { items: FX.items, more: 0, watched: 5, notCovered: [], failed: [], pending: [], lastOkAt: "2026-07-30T07:03:00+09:00", warning: null };
const SCHEDULE: HoldingSchedule = { asOf: "2026-07-30T07:03:00+09:00", events: { ...SEP.events, week: null }, filings: FILINGS, kr: { filings: "noDartKey" } };

/** 목 7/30 07:03 계좌 브리핑 (다가오는 일정 칸 있음) */
const DATA: AccountData = {
  version: 1, session: "morning", date: "2026-07-30", asOf: "2026-07-30T07:03:00+09:00", basis: "앱 잔고 화면과 같은 기준", afterCost: true, holdings: 5, stale: 0,
  totalValue: 10_000_000, totalCost: 8_400_000, totalProfit: 1_600_000, totalProfitRate: 19.05, dayPnl: 212_000, dayRate: 2.16,
  contributions: [{ code: "MSFT", name: "마이크로소프트", currency: "USD", amount: 150_000, changeRate: 2.1, value: 3_500_000 }],
  others: null,
  markets: { kr: { count: 0, value: 0, day: 0, dayRate: null }, us: { count: 5, value: 10_000_000, day: 212_000, dayRate: 2.16 } },
  excluded: [],
  fx: { status: "none", reason: "미국 종목이 없어 환율 효과가 없습니다", usdKrw: null, appliedRate: null, usdHoldingsKrwChange: null, priceEffect: null, fxEffect: null },
  indices: [{ code: "KOSPI", name: "코스피", value: 3412.35, change: 27.5, changeRate: 0.81, open: false, stale: false }],
  missingIndices: [],
  schedule: { kr: { date: "2026-07-30", tradingDay: true, now: "개장 전", hours: "정규장 09:00~15:30", nextOpen: null }, us: { date: "2026-07-29", tradingDay: true, now: "미국 휴장 시간", hours: "정규장 7/29 22:30~7/30 05:00 (한국 시간)" }, disclosures: [] },
  narrative: { source: "template", reason: null },
};
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-07-30", session: "morning", status: "ok", summary: "당일 +212,000원 (+2.16%)\n총 평가금액 10,000,000원",
  detail: "- 설명", model: "template", template: true, createdAt: "2026-07-30T07:03:00+09:00",
  headline: { totalValue: 10_000_000, dayPnl: 212_000, dayRate: 2.16, holdings: 5, top: [] },
};
const detailOf = (e: AccountEvents | undefined): AccountBriefingWithData => ({ ...ACCOUNT, data: e === undefined ? DATA : { ...DATA, events: e } });

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const allOf = (n: HostNode): HostNode[] => [n, ...kids(n).flatMap(allOf)];
const flat = (s: unknown): Record<string, unknown> => (typeof s === "function" ? flat((s as (x: { pressed: boolean }) => unknown)({ pressed: false })) : Array.isArray(s) ? Object.assign({}, ...s.map(flat)) : ((s as Record<string, unknown>) ?? {}));
const treeOf = (r: R) =>
  JSON.stringify(r.tree, function (this: unknown, k: string, v: unknown) {
    if (k === "query") return undefined;
    if (k === "children" && !(this && typeof this === "object" && "type" in this && "props" in this)) return undefined;
    return v;
  });
const cardName = (c: HostNode) => {
  const title = allOf(c).find((n) => n.type === "SectionTitle");
  return title ? rawOf(title) : "?";
};
const card = (r: R, name: string) => ofType(r, "Card").find((c) => cardName(c) === name);
const settle = async (r: R) => {
  for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};
const link = (r: R) => r.all().filter((n) => n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").startsWith(F.SCHEDULE_LINK_SPEECH));

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { accountBriefing: true, holdingEvents: true, holdingSchedule: true, filingAlerts: true };
  h.detail = detailOf(SEP.events);
  h.schedule = SCHEDULE;
  h.scheduleError = false;
  h.cached = undefined;
  h.store.clear();
  h.push.mockClear();
  h.openURL.mockReset();
  h.openURL.mockImplementation(async () => undefined);
  h.scrollTo.mockClear();
  forgetWindowClass();
  forgetFilingViewed();
});

describe("계좌 상세 '일정·공시 모두 보기' 줄", () => {
  it("'다가오는 일정' 카드 기준 줄 바로 아래 · 44dp · 이름 · 누르면 /schedule · 등락 색 없음", () => {
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const up = card(r, "다가오는 일정")!;
    const children = kids(up);
    const last = children.at(-1)!;
    expect(last.type).toBe("Pressable");
    expect(rawOf(children.at(-2)!)).toBe(SEP.app.basis);
    expect(last.props.accessibilityRole).toBe("button");
    expect(last.props.accessibilityLabel).toBe("보유 종목 일정과 공시 모두 보기");
    expect(Number(flat(last.props.style).minHeight)).toBeGreaterThanOrEqual(touch.min);
    const text = allOf(last).find((n) => n.type === "Text")!;
    expect(rawOf(text)).toBe("일정·공시 모두 보기 ›");
    expect(flat(text.props.style)).toMatchObject({ color: dark.accent, fontWeight: "600" });
    (last.props.onPress as () => void)();
    expect(h.push).toHaveBeenCalledWith("/schedule");
    expect(link(r)).toHaveLength(1);
    // '오늘 일정' 카드에는 없다
    expect(allOf(card(r, "오늘 일정")!).some((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith(F.SCHEDULE_LINK_SPEECH))).toBe(false);
  });

  it("holdingEvents 가 꺼져 '다가오는 일정' 카드가 없으면 '오늘 일정' 카드 맨 아래", () => {
    h.flags.holdingEvents = false;
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    expect(card(r, "다가오는 일정")).toBeUndefined();
    expect(kids(card(r, "오늘 일정")!).at(-1)!.props.accessibilityLabel).toBe("보유 종목 일정과 공시 모두 보기");
    expect(link(r)).toHaveLength(1);
  });

  it("받아 둔 화면 값에 새 공시가 있으면 '· 새 공시 N건' (펼쳐 본 것은 빼고) — 받아 둔 값이 없으면 붙이지 않음 · filingAlerts 가 꺼져 있으면 붙이지 않음", async () => {
    let r = render(<AccountBriefingBody numId={12} layout="stack" />);
    expect(r.text()).not.toContain("새 공시");
    cleanupRenders();
    h.cached = SCHEDULE;
    r = render(<AccountBriefingBody numId={12} layout="stack" />);
    expect(link(r)[0]!.props.accessibilityLabel).toBe("보유 종목 일정과 공시 모두 보기, 새 공시 2건");
    // '일정·공시 모두 보기 ·' + 흐린 '새 공시 2건 ›' — '·'는 앞 묶음 끝(흐린 글), 꺾쇠는 뒤 묶음 끝 (200% 에서 둘째 줄이 '·'로 시작하거나 꺾쇠가 홀로 줄바꿈되지 않게)
    const texts = kids(kids(link(r)[0]!)[0]!);
    const plain = (n: HostNode) => rawOf(n).replace(/\u00a0/g, " ");
    expect(texts.map(plain)).toEqual(["일정·공시 모두 보기 ·", "새 공시 2건 ›"]);
    expect(rawOf(texts[0]!)).toMatch(/보기\u00a0·$/);
    expect(rawOf(texts[1]!)).toBe("새\u00a0공시\u00a02건\u00a0›");
    expect(rawOf(texts[1]!).startsWith("·")).toBe(false);
    expect(flat(texts[0]!.props.style)).toMatchObject({ color: dark.accent, fontWeight: "600" });
    expect(flat(kids(texts[0]!)[0]!.props.style)).toMatchObject({ color: dark.muted });
    expect(flat(texts[1]!.props.style)).toMatchObject({ color: dark.muted });
    expect(flat(kids(texts[1]!)[0]!.props.style)).toMatchObject({ color: dark.accent, fontWeight: "600" });
    h.store.set("filingAlerts.viewed", JSON.stringify([MSFT_8K.accession]));
    cleanupRenders();
    forgetFilingViewed();
    r = render(<AccountBriefingBody numId={12} layout="stack" />);
    await settle(r);
    expect(link(r)[0]!.props.accessibilityLabel).toBe("보유 종목 일정과 공시 모두 보기, 새 공시 1건");
    cleanupRenders();
    h.flags.filingAlerts = false;
    r = render(<AccountBriefingBody numId={12} layout="stack" />);
    expect(link(r)[0]!.props.accessibilityLabel).toBe("보유 종목 일정과 공시 모두 보기");
  });

  it.each([
    ["세 칸 933×704", { width: 933, height: 704 }],
    ["두 칸 704×933", { width: 704, height: 933 }],
  ])("넓은 창 %s: 오른쪽 칸 '다가오는 일정' 카드 끝에 한 줄", (_n, size) => {
    h.win = { ...size, scale: 2.625, fontScale: 1 };
    const r = render(<AccountBriefingBody numId={12} layout="split" />);
    expect(link(r)).toHaveLength(1);
    expect(kids(card(r, "다가오는 일정")!).at(-1)!.props.accessibilityLabel).toBe("보유 종목 일정과 공시 모두 보기");
  });

  it.each(["stack", "pane", "split"] as const)("holdingSchedule 꺼짐(%s): 카드 트리가 줄이 없는 것과 같다 ('다가오는 일정'·'오늘 일정' 둘 다)", (layout) => {
    if (layout === "split") h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags.holdingSchedule = false;
    const off = render(<AccountBriefingBody numId={12} layout={layout} />);
    const offTree = treeOf(off);
    expect(link(off)).toHaveLength(0);
    // 줄을 뺀 켬 트리와 같다
    cleanupRenders();
    h.flags.holdingSchedule = true;
    const on = render(<AccountBriefingBody numId={12} layout={layout} />);
    const strip = (nodes: (HostNode | string)[]): (HostNode | string)[] =>
      nodes.filter((n) => typeof n === "string" || !(n.type === "Pressable" && String(n.props.accessibilityLabel ?? "").startsWith(F.SCHEDULE_LINK_SPEECH))).map((n) => (typeof n === "string" ? n : { ...n, children: strip(n.children) }));
    expect(link(on)).toHaveLength(1);
    expect(treeOf({ tree: strip(on.tree) } as R)).toBe(offTree);
    expect(offTree).not.toContain("일정·공시");
    // holdingEvents 도 꺼진 '오늘 일정' 카드도 같다
    cleanupRenders();
    h.flags = { ...h.flags, holdingEvents: false, holdingSchedule: false };
    const a = treeOf(render(<AccountBriefingBody numId={12} layout={layout} />));
    expect(a).not.toContain("일정·공시");
  });
});

describe("'일정·공시' 화면", () => {
  const filingsCard = (r: R) => card(r, "최근 공시 (미국)")!;
  const rows = (r: R) => allOf(filingsCard(r)).filter((n) => n.type === "Pressable" && n.props.accessibilityHint === F.EXPAND_HINT);

  it("한 칸(475): ① 다가오는 일정(+ 미국 실적은 공시로 보인다는 글) ② 최근 공시 ③ 한국 공시 · 고지", () => {
    const r = render(<ScheduleScreen focus={null} />);
    const screen = ofType(r, "Screen")[0]!;
    expect(screen.props.disclaimer).toBe(true);
    expect(allOf(screen).filter((n) => n.type === "Card").map(cardName)).toEqual(["다가오는 일정", "최근 공시 (미국)", "한국 공시"]);
    // 한 칸: 두 칸 줄이 없다
    expect(ofType(r, "View").some((n) => flat(n.props.style).flexDirection === "row" && kids(n).length === 2 && kids(n).every((c) => flat(c.props.style).flex === 1))).toBe(false);
    const up = card(r, "다가오는 일정")!;
    const muted = allOf(up).filter((n) => n.type === "Muted").map(rawOf);
    expect(muted).toEqual([SEP.app.sub, ...SEP.app.notes, F.EARNINGS_AFTER_FILING, SEP.app.basis]);
    // 한국 공시: DART 키 안내 + 국내 공시는 계좌 상세 '오늘 일정' 카드에 있다는 한 줄 ('모두 보기'에서 국내 공시가 사라진 것처럼 보이지 않게)
    const krCard = card(r, "한국 공시")!;
    expect(allOf(krCard).filter((n) => n.type === "Muted").map(rawOf)).toEqual([F.KR_NO_KEY, F.KR_IN_ACCOUNT]);
    expect(kids(krCard)[0]!.props.accessibilityLabel).toBe(`${F.KR_HEAD}, ${F.KR_NO_KEY}, ${F.KR_IN_ACCOUNT}`);
    // 이 화면에는 계좌 상세 링크가 없다
    expect(link(r)).toHaveLength(0);
  });

  it("공시 줄: 첫 줄 '7/30(목) 05:04 · 마이크로소프트' + 제목, 화면 읽기 한 문장(공용 픽스처) · 새 공시 칩(테두리만, 등락 색 없음) · 44dp", () => {
    const r = render(<ScheduleScreen focus={null} />);
    const list = rows(r);
    expect(list).toHaveLength(FX.items.length);
    for (const want of FX.app.lines) {
      const row = list.find((p) => p.props.accessibilityLabel === want.speech)!;
      expect(row, want.accession).toBeDefined();
      expect(Number(flat(row.props.style).minHeight)).toBeGreaterThanOrEqual(touch.min);
      expect(row.props.accessibilityState).toEqual({ expanded: false });
    }
    const first = list[0]!;
    expect(allOf(first).filter((n) => n.type === "Text").map(rawOf)).toEqual(["7/30(목) 05:08 ·", "마이크로소프트", "새 공시", "연간 보고서", "(10-K)"]);
    // 8-K 제목: 서식 번호 묶음 안 공백은 줄바꿈 없는 공백 (좁은 칸·큰 글씨에서 '8-K' / '2.02' 로 갈라지지 않게)
    const k8 = list.find((p) => String(p.props.accessibilityLabel).includes("실적 발표, 8-K 2.02"))!;
    expect(allOf(k8).filter((n) => n.type === "Text").map(rawOf).slice(-2)).toEqual(["실적 발표", "(8-K 2.02)"]);
    const chip = allOf(first).find((n) => n.type === "View" && flat(n.props.style).borderWidth)!;
    expect(flat(chip.props.style)).toMatchObject({ borderColor: dark.accent });
    for (const t of allOf(filingsCard(r)).filter((n) => n.type === "Text")) expect([dark.up, dark.down]).not.toContain(flat(t.props.style).color);
    // 새 공시가 아닌 줄에는 칩이 없다
    const tsm = list.find((p) => String(p.props.accessibilityLabel).includes("TSMC"))!;
    expect(allOf(tsm).map(rawOf)).not.toContain("새 공시");
    expect(allOf(filingsCard(r)).filter((n) => n.type === "Muted").map(rawOf)).toEqual([F.filingsSub(30), F.TITLE_NOTE, "7/30 07:03 기준 · 출처 SEC EDGAR"]);
  });

  it("줄을 누르면 펼침(한국·미국 동부 시각 · 들어 있는 항목 · 원문 버튼), 펼치면 '새 공시' 칩이 사라진다(기기에 적음) · 원문은 SEC 주소를 한 번 연다", async () => {
    const r = render(<ScheduleScreen focus={null} />);
    const row8k = () => rows(r).find((p) => String(p.props.accessibilityLabel).includes("실적 발표, 8-K 2.02"))!;
    r.act(() => (row8k().props.onPress as () => void)());
    expect(row8k().props.accessibilityState).toEqual({ expanded: true });
    expect(row8k().props.accessibilityLabel).toBe("7월 30일 목요일 오전 5시 4분, 마이크로소프트, 실적 발표, 8-K 2.02");
    const want = FX.app.lines.find((l) => l.accession === MSFT_8K.accession)!;
    expect(r.has(want.timeSpeech)).toBe(true);
    // 접수 시각은 묶음째 줄바꿈 ('한국 …'·'미국 동부 …' 묶음 안은 줄바꿈 없는 공백, '·'는 앞 묶음 끝) — 이으면 같은 글
    const timeRow = r.byLabel(want.timeSpeech);
    expect(flat(timeRow.props.style)).toMatchObject({ flexDirection: "row", flexWrap: "wrap" });
    const parts = kids(timeRow).map(rawOf);
    expect(parts).toHaveLength(3);
    expect(parts.join(" ").replace(/\u00a0/g, " ")).toBe(want.time);
    for (const part of parts) expect(part).not.toMatch(/ /);
    expect(parts[1]).toMatch(/\u00a0·$/);
    expect(r.text()).toContain(F.ITEMS_HEAD);
    expect(r.has("2.02 실적 발표 — 분기·연간 실적 같은 영업 결과를 알림")).toBe(true);
    expect(r.has("9.01 재무제표·첨부 서류 — 다른 항목에 딸린 첨부 서류")).toBe(true);
    const open = r.byLabel(F.OPEN_ORIGINAL_SPEECH);
    expect(open.props.accessibilityRole).toBe("link");
    expect(Number(flat(open.props.style).minHeight)).toBeGreaterThanOrEqual(touch.min);
    r.act(() => (open.props.onPress as () => void)());
    expect(h.openURL).toHaveBeenCalledTimes(1);
    expect(h.openURL).toHaveBeenCalledWith(MSFT_8K.url);
    await settle(r);
    expect(JSON.parse(h.store.get("filingAlerts.viewed") ?? "[]")).toEqual([MSFT_8K.accession]);
    // 못 열면 같은 자리 '원문을 열지 못했습니다.'
    h.openURL.mockImplementation(async () => {
      throw new Error("no browser");
    });
    r.act(() => (r.byLabel(F.OPEN_ORIGINAL_SPEECH).props.onPress as () => void)());
    await settle(r);
    expect(r.text()).toContain(F.OPEN_FAILED);
    // 다시 누르면 접힘
    r.act(() => (row8k().props.onPress as () => void)());
    expect(r.has(F.OPEN_ORIGINAL_SPEECH)).toBe(false);
  });

  it("6-K 는 항목 대신 '원문을 봐야 안다'는 설명", () => {
    const r = render(<ScheduleScreen focus={TSM_6K.accession} />);
    expect(r.text()).toContain("외국 기업이 본국에서 알린 내용을 SEC에도 올린 것입니다. 무슨 내용인지는 원문을 봐야 알 수 있습니다.");
    expect(r.text()).not.toContain(F.ITEMS_HEAD);
  });

  it("알림에서 온 접수 번호(focus): 그 줄을 펼치고 화면 안으로 스크롤 · 펼쳐 본 것으로 적음", async () => {
    const r = render(<ScheduleScreen focus={MSFT_8K.accession} />);
    const row = rows(r).find((p) => String(p.props.accessibilityLabel).includes("실적 발표, 8-K 2.02"))!;
    expect(row.props.accessibilityState).toEqual({ expanded: true });
    // 배치 알림: 공시 카드 y 200 · 줄 y 150 → 350 - 여백
    const wrap = ofType(r, "View").find((n) => typeof n.props.onLayout === "function" && kids(n)[0]?.type === "Card")!;
    const line = ofType(r, "View").filter((n) => typeof n.props.onLayout === "function" && allOf(n).some((x) => x === row)).at(-1)!;
    expect(line).not.toBe(wrap);
    (wrap.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { y: 200 } } });
    (line.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { y: 150 } } });
    expect(h.scrollTo).toHaveBeenCalledWith({ y: 350 - space.md, animated: true });
    await settle(r);
    expect(JSON.parse(h.store.get("filingAlerts.viewed") ?? "[]")).toEqual([MSFT_8K.accession]);
  });

  it("받는 중 · 받지 못함 · 없음 · 미국 보유 없음 · 멈춤 · 일부 실패 · 대상 아님 · 한국 notYet", () => {
    h.schedule = undefined;
    let r = render(<ScheduleScreen focus={null} />);
    expect(r.text()).toContain(F.EVENTS_LOADING);
    cleanupRenders();
    h.scheduleError = true;
    r = render(<ScheduleScreen focus={null} />);
    // 요청 전체 실패: 일정도 같은 요청이라 '일정·공시를 받지 못했습니다' 한 줄 (배당락일 카드가 말없이 사라지지 않게)
    expect(r.text()).toBe(F.SCHEDULE_FAILED);
    expect(ofType(r, "Card")).toHaveLength(1);
    expect(r.has(F.SCHEDULE_FAILED)).toBe(true);
    cleanupRenders();
    h.scheduleError = false;
    h.schedule = { ...SCHEDULE, filings: { ...FILINGS, items: [] } };
    r = render(<ScheduleScreen focus={null} />);
    expect(r.text()).toContain("최근 30일 안에 올라온 공시가 없습니다.");
    cleanupRenders();
    h.schedule = { ...SCHEDULE, filings: { ...FILINGS, items: [], watched: 0 } };
    r = render(<ScheduleScreen focus={null} />);
    expect(r.text()).toContain(F.FILINGS_NO_US);
    cleanupRenders();
    h.schedule = {
      ...SCHEDULE,
      filings: { ...FILINGS, warning: "stale", lastOkAt: "2026-07-30T06:10:00+09:00", failed: [{ code: "TSLA", name: "테슬라" }], notCovered: [{ code: "QQQ", name: "QQQ", reason: "etf" }] },
      kr: { filings: "notYet" },
    };
    r = render(<ScheduleScreen focus={null} />);
    for (const t of ["SEC 공시 확인이 7/30 06:10 이후 되지 않았습니다. 서버가 다시 확인하면 채워집니다.", "공시를 받지 못한 종목: 테슬라 (다음 확인 때 다시 받습니다)", "공시를 확인하지 않는 종목: QQQ (ETF·ETN)", F.KR_NOT_YET]) expect(r.text()).toContain(t);
  });

  it("요청 전체 실패 글은 앱이 아는 서버 플래그로: 공시가 꺼졌으면 '일정을 …', 일정이 꺼졌으면 '공시 목록을 …'", () => {
    h.scheduleError = true;
    h.flags.filingAlerts = false;
    let r = render(<ScheduleScreen focus={null} />);
    expect(r.text()).toBe(F.EVENTS_FAILED_SCREEN);
    cleanupRenders();
    h.flags = { ...h.flags, filingAlerts: true, holdingEvents: false };
    r = render(<ScheduleScreen focus={null} />);
    expect(r.text()).toBe(F.FILINGS_FAILED);
  });

  it("서버가 한쪽만 받지 못함(eventsFailed·filingsFailed): 그 칸에 제목 + 한 줄, 다른 칸은 그대로", () => {
    h.schedule = { ...SCHEDULE, events: null, eventsFailed: true };
    let r = render(<ScheduleScreen focus={null} />);
    expect(ofType(r, "Card").map(cardName)).toEqual(["다가오는 일정", "최근 공시 (미국)", "한국 공시"]);
    const ev = card(r, "다가오는 일정")!;
    expect(kids(ev)[0]!.props.accessibilityLabel).toBe(`다가오는 일정, ${F.EVENTS_FAILED_SCREEN}`);
    expect(allOf(ev).filter((n) => n.type === "Muted").map(rawOf)).toEqual([F.EVENTS_FAILED_SCREEN]);
    // 국내 보유 수를 모르면 계좌 상세 안내 한 줄은 그대로
    expect(allOf(card(r, "한국 공시")!).filter((n) => n.type === "Muted").map(rawOf)).toEqual([F.KR_NO_KEY, F.KR_IN_ACCOUNT]);
    cleanupRenders();
    h.schedule = { ...SCHEDULE, filings: null, filingsFailed: true };
    r = render(<ScheduleScreen focus={null} />);
    expect(ofType(r, "Card").map(cardName)).toEqual(["다가오는 일정", "최근 공시 (미국)", "한국 공시"]);
    expect(allOf(card(r, "최근 공시 (미국)")!).filter((n) => n.type === "Muted").map(rawOf)).toEqual([F.FILINGS_FAILED]);
    // 공시 칸이 보이지 않으면 '미국 실적은 … 공시로 보입니다'도 붙이지 않는다
    expect(r.text()).not.toContain(F.EARNINGS_AFTER_FILING);
    cleanupRenders();
    // 둘 다 받지 못함: 빈 화면('볼 수 없습니다')이 아니라 두 칸 모두 받지 못했다고
    h.schedule = { ...SCHEDULE, events: null, filings: null, eventsFailed: true, filingsFailed: true };
    r = render(<ScheduleScreen focus={null} />);
    expect(ofType(r, "Empty")).toHaveLength(0);
    expect(r.text()).toContain(F.EVENTS_FAILED_SCREEN);
    expect(r.text()).toContain(F.FILINGS_FAILED);
  });

  it("국내 보유가 없다고 알면(일정 kr 0) 한국 공시 칸은 DART 한 줄만", () => {
    h.schedule = { ...SCHEDULE, events: { ...SCHEDULE.events!, kr: 0 } };
    const r = render(<ScheduleScreen focus={null} />);
    expect(allOf(card(r, "한국 공시")!).filter((n) => n.type === "Muted").map(rawOf)).toEqual([F.KR_NO_KEY]);
  });

  it("filingAlerts 가 꺼진 서버(filings null): 공시·한국 칸 없이 다가오는 일정만 ('미국 실적은 … 공시로 보입니다' 없음) · holdingEvents 도 꺼지면(events null) 일정 칸 없음", () => {
    h.schedule = { ...SCHEDULE, filings: null };
    let r = render(<ScheduleScreen focus={null} />);
    expect(ofType(r, "Card").map(cardName)).toEqual(["다가오는 일정"]);
    // 이 화면 어디에서도 그 공시를 볼 수 없으므로 붙이지 않는다
    expect(r.text()).not.toContain(F.EARNINGS_AFTER_FILING);
    expect(allOf(card(r, "다가오는 일정")!).filter((n) => n.type === "Muted").map(rawOf)).toEqual([SEP.app.sub, ...SEP.app.notes, SEP.app.basis]);
    cleanupRenders();
    h.schedule = { ...SCHEDULE, events: null };
    r = render(<ScheduleScreen focus={null} />);
    expect(ofType(r, "Card").map(cardName)).toEqual(["최근 공시 (미국)", "한국 공시"]);
  });

  it("서버가 일정·공시 둘 다 꺼 둠(events·filings null): 빈 화면 대신 한 줄", () => {
    h.schedule = { ...SCHEDULE, events: null, filings: null };
    const r = render(<ScheduleScreen focus={null} />);
    expect(ofType(r, "Empty")[0]!.props.title).toBe(F.SCHEDULE_OFF);
    expect(ofType(r, "Card")).toHaveLength(0);
  });

  it("두 칸(933×704)에서 알림으로 오면 두 칸 줄 y 까지 잰 뒤에 한 번 스크롤 (먼저 잰 카드·줄만으로 가지 않음)", () => {
    h.flags.foldLayout = true;
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const r = render(<ScheduleScreen focus={MSFT_8K.accession} />);
    const row = rows(r).find((p) => String(p.props.accessibilityLabel).includes("실적 발표, 8-K 2.02"))!;
    const cols = ofType(r, "View").find((n) => flat(n.props.style).flexDirection === "row" && typeof n.props.onLayout === "function")!;
    const wrap = ofType(r, "View").find((n) => typeof n.props.onLayout === "function" && kids(n)[0]?.type === "Card")!;
    const line = ofType(r, "View").filter((n) => typeof n.props.onLayout === "function" && allOf(n).some((x) => x === row)).at(-1)!;
    (wrap.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { y: 0 } } });
    (line.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { y: 150 } } });
    expect(h.scrollTo).not.toHaveBeenCalled();
    (cols.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { y: 40 } } });
    expect(h.scrollTo).toHaveBeenCalledTimes(1);
    expect(h.scrollTo).toHaveBeenCalledWith({ y: 40 + 150 - space.md, animated: true });
  });

  it("holdingSchedule 꺼짐(남은 주소로 들어옴): '지금은 일정·공시를 볼 수 없습니다' 한 줄", () => {
    h.flags.holdingSchedule = false;
    const r = render(<ScheduleScreen focus={null} />);
    expect(ofType(r, "Empty")[0]!.props.title).toBe(F.SCHEDULE_OFF);
    expect(ofType(r, "Card")).toHaveLength(0);
  });

  it("펼친 가로 933×704(foldLayout): 두 칸 (왼쪽 다가오는 일정·한국 공시, 오른쪽 최근 공시) · 704×933 은 한 칸", () => {
    h.flags.foldLayout = true;
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    let r = render(<ScheduleScreen focus={null} />);
    const cols = ofType(r, "View").find((n) => flat(n.props.style).flexDirection === "row" && kids(n).length === 2 && kids(n).every((c) => flat(c.props.style).flex === 1))!;
    expect(cols).toBeDefined();
    expect(kids(cols).map((c) => allOf(c).filter((n) => n.type === "Card").map(cardName))).toEqual([["다가오는 일정", "한국 공시"], ["최근 공시 (미국)"]]);
    cleanupRenders();
    forgetWindowClass();
    h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    r = render(<ScheduleScreen focus={null} />);
    expect(allOf(ofType(r, "Screen")[0]!).filter((n) => n.type === "Card").map(cardName)).toEqual(["다가오는 일정", "최근 공시 (미국)", "한국 공시"]);
    expect(ofType(r, "View").some((n) => flat(n.props.style).flexDirection === "row" && kids(n).length === 2 && kids(n).every((c) => flat(c.props.style).flex === 1))).toBe(false);
  });

  it.each([
    [360, 752, 1],
    [360, 752, 1.3],
    [360, 752, 2],
    [475, 751, 1],
    [475, 751, 1.3],
    [475, 751, 2],
    [933, 704, 1],
    [704, 933, 2],
  ])("%s×%s 글자 %s배: 줄 수 제한·글자 줄이기 없이 묶음째 줄바꿈, 누르는 곳 44dp 이상", (width, height, fontScale) => {
    h.win = { width, height, scale: 2.625, fontScale };
    h.flags.foldLayout = true;
    const r = render(<ScheduleScreen focus={MSFT_8K.accession} />);
    for (const t of r.all().filter((n) => n.type === "Text" || n.type === "Muted")) {
      expect(t.props.numberOfLines).toBeUndefined();
      expect(t.props.adjustsFontSizeToFit).toBeUndefined();
    }
    const heads = allOf(filingsCard(r)).filter((n) => n.type === "View" && flat(n.props.style).flexWrap === "wrap" && flat(n.props.style).columnGap !== undefined);
    const titles = allOf(filingsCard(r)).filter((n) => n.type === "View" && flat(n.props.style).flexWrap === "wrap" && flat(n.props.style).columnGap === undefined);
    expect(titles).toHaveLength(FX.items.length);
    expect(heads.length).toBeGreaterThanOrEqual(FX.items.length);
    for (const v of heads) expect(flat(v.props.style).columnGap).toBe(fontScale >= 1.75 ? space.sm : fontScale >= 1.25 ? space.s : space.xs);
    for (const p of r.all().filter((n) => n.type === "Pressable")) expect(Number(flat(p.props.style).minHeight), String(p.props.accessibilityLabel)).toBeGreaterThanOrEqual(touch.min);
  });
});
