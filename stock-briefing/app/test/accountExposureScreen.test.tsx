import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefing, AccountBriefingWithData, AccountData, AccountExposure } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 브리핑 3차 4 — 비중 한 줄 (플래그 accountExposure, 앱 fallback 꺼짐) 화면.
 *  - 계좌 상세 총 평가 카드(폰)·총 평가 띠(2단 오른쪽 칸·넓은 창 두/세 칸)의 '보유 N종목 합계' 줄(과 '합계에서 뺀 종목' 줄) 아래 두 줄 — 한 묶음, 화면 읽기 한 문장
 *  - 판단하는 말·등락 색 없음, 좁은 칸·큰 글씨는 ' · ' 묶음째 줄바꿈 (줄 수 제한·글자 줄이기 없음)
 *  - 꺼짐·예전 기록(칸 없음)·null: 그림 트리가 지금과 같음. 브리핑 탭 카드·줄에는 넣지 않음
 * 시계는 고정 (월 9/28 08:40), RN 부품·공용 UI 는 문자열 요소로, API 훅은 가짜로 바꿔 끼운다
 */
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  now: Date.parse("2026-09-28T08:40:00+09:00"),
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
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const pick = await import("@/lib/briefingPick");
const readStore = await import("@/lib/briefingRead");
const { dark, space } = await import("@/tokens");

type Case = { name: string; expected: AccountExposure; app: { line1: string; line2: string; speech: string } };
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountExposure.json", import.meta.url), "utf8")) as { cases: Case[] };
const LEV = fixture.cases.find((c) => c.name === "levInv")!;
const NOLEV = fixture.cases.find((c) => c.name === "noLev")!;
const EXCL = fixture.cases.find((c) => c.name === "excludedGuessed")!;
const FX = fixture.cases.find((c) => c.name === "fxMissing")!;
const { EXPOSURE_ABOUT } = await import("@/lib/accountExposure");
/** 묶음 끝 ' ·' 의 공백 = 줄바꿈 없는 공백 (좁은 칸에서 '·' 하나만 다음 줄에 남지 않게) */
const NBSP = "\u00a0";

/** 월 9/28 08:38 오전 계좌 브리핑 (비중은 픽스처 levInv) */
const DATA: AccountData = {
  version: 1, session: "morning", date: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", basis: "앱 잔고 화면과 같은 기준", afterCost: true, holdings: 9, stale: 0,
  totalValue: 10_000_000, totalCost: 8_400_000, totalProfit: 1_600_000, totalProfitRate: 19.05, dayPnl: 212_000, dayRate: 2.16,
  contributions: [
    { code: "NVDA", name: "엔비디아", currency: "USD", amount: 150_000, changeRate: 5.87, value: 2_130_000 },
    { code: "005930", name: "삼성전자", currency: "KRW", amount: 62_000, changeRate: 1.83, value: 1_500_000 },
  ],
  others: null,
  markets: { kr: { count: 3, value: 3_760_000, day: 62_000, dayRate: 1.68 }, us: { count: 6, value: 6_240_000, day: 150_000, dayRate: 2.46 } },
  excluded: [],
  fx: { status: "none", reason: "미국 종목이 없어 환율 효과가 없습니다", usdKrw: null, appliedRate: null, usdHoldingsKrwChange: null, priceEffect: null, fxEffect: null },
  indices: [{ code: "KOSPI", name: "코스피", value: 3412.35, change: 27.5, changeRate: 0.81, open: false, stale: false }],
  missingIndices: [],
  schedule: { kr: { date: "2026-09-28", tradingDay: true, now: "개장 전", hours: "정규장 09:00~15:30", nextOpen: null }, us: { date: "2026-09-28", tradingDay: true, now: "미국 휴장 시간", hours: "정규장 9/28 22:30~9/29 05:00 (한국 시간)" }, disclosures: [] },
  narrative: { source: "template", reason: null },
};
const ACCOUNT: AccountBriefing = {
  id: 12, date: "2026-09-28", session: "morning", status: "ok", summary: "당일 +212,000원 (+2.16%) · 기여 1위 엔비디아 +150,000원\n총 평가금액 10,000,000원",
  detail: "- 설명", model: "template", template: true, createdAt: "2026-09-28T08:38:00+09:00",
  headline: { totalValue: 10_000_000, dayPnl: 212_000, dayRate: 2.16, holdings: 9, top: [{ code: "NVDA", name: "엔비디아", amount: 150_000, changeRate: 5.87 }] },
};
const detailOf = (e: AccountExposure | null | undefined, over: Partial<AccountData> = {}): AccountBriefingWithData => ({ ...ACCOUNT, data: e === undefined ? { ...DATA, ...over } : { ...DATA, ...over, exposure: e } });

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const ofType = (r: R, type: string) => r.all().filter((n) => n.type === type);
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const allOf = (n: HostNode): HostNode[] => [n, ...kids(n).flatMap(allOf)];
const flat = (s: unknown): Record<string, unknown> => (Array.isArray(s) ? Object.assign({}, ...s.map(flat)) : ((s as Record<string, unknown>) ?? {}));
/** 그림 트리 글 (끊김 띠의 query 속성과 그리기 전 요소 목록은 빼고) */
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
/** 비중 묶음: 화면 읽기 문장이 '비중,' 으로 시작하는 묶음 */
const block = (r: R) => r.all().filter((n) => n.props.accessible === true && String(n.props.accessibilityLabel ?? "").startsWith("비중,"));
/** 묶음째 줄바꿈하는 줄: 글(Text·Muted)만 둘 이상 담은 View 를 ' '로 이은 글 (묶음 끝 ' ·' 의 줄바꿈 없는 공백은 보통 공백으로 읽어 픽스처와 견줌) */
const chunkRows = (n: HostNode) =>
  allOf(n)
    .filter((v) => v.type === "View" && kids(v).length > 1 && kids(v).every((k) => k.type === "Text" || k.type === "Muted"))
    .map((v) => kids(v).map(rawOf).join(" ").split(NBSP).join(" "));
/** 총 평가 카드(띠): '보유 N종목 합계' 줄을 담은 카드 */
const totalsCard = (r: R) => ofType(r, "Card").find((c) => allOf(c).some((n) => n.type === "Muted" && /^보유 \d+종목 합계/.test(rawOf(n))))!;

beforeEach(() => {
  cleanupRenders();
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { accountBriefing: true, briefingTrim: true, accountExposure: true };
  h.now = Date.parse("2026-09-28T08:40:00+09:00");
  h.accounts = [ACCOUNT];
  h.detail = detailOf(LEV.expected);
  h.store.clear();
  forgetWindowClass();
  pick.forgetPick();
  readStore.forgetRead();
});

describe("계좌 상세: 총 평가 카드의 비중 두 줄", () => {
  it("폰(stack): '보유 N종목 합계' 줄 바로 아래 한 묶음 · 두 줄 글 · 화면 읽기 한 문장", () => {
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const card = totalsCard(r);
    const inner = kids(card);
    const at = inner.findIndex((n) => n.props.accessible === true && String(n.props.accessibilityLabel).startsWith("비중,"));
    expect(at).toBeGreaterThan(0);
    expect(rawOf(inner[at - 1]!)).toBe("보유 9종목 합계 · 작성 당시 종목 시세 기준 추정");
    expect(at).toBe(inner.length - 1);
    const b = block(r);
    expect(b).toHaveLength(1);
    expect(b[0]!.props.accessibilityLabel).toBe(LEV.app.speech);
    expect(chunkRows(b[0]!)).toEqual([LEV.app.line1, LEV.app.line2]);
  });

  it("색: 등락이 아니라 등락 색(빨강·파랑)이 없다 · 첫 묶음 '비중'만 조금 굵게", () => {
    const b = block(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!;
    const texts = allOf(b).filter((n) => n.type === "Text");
    for (const t of texts) {
      const c = flat(t.props.style).color;
      expect([dark.up, dark.down]).not.toContain(c);
    }
    expect(flat(texts[0]!.props.style).fontWeight).toBe("600");
    expect(rawOf(texts[0]!)).toBe(`비중${NBSP}·`);
  });

  it("묶음 끝 '·' 앞 공백은 줄바꿈 없는 공백 (검토 지적 — 704×933 글자 200% 에서 '·' 하나만 다음 줄 맨 앞에 남던 것) · 마지막 묶음에는 '·' 없음", () => {
    const b = block(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!;
    const rows = allOf(b).filter((v) => v.type === "View" && kids(v).length > 1 && kids(v).every((k) => k.type === "Text" || k.type === "Muted"));
    for (const row of rows) {
      const parts = kids(row).map(rawOf);
      for (const p of parts.slice(0, -1)) {
        expect(p.endsWith(`${NBSP}·`), p).toBe(true);
        expect(p.endsWith(" ·"), p).toBe(false);
      }
      expect(parts.at(-1)!.endsWith("·")).toBe(false);
    }
  });

  it("환율을 받지 못한 날 (검토 지적): '합계에서 뺀 종목: 엔비디아(환율…)·SOXL(…)' 아래에 '미국 상장 없음'이 아니라 '비중 알 수 없음' · 뺀 SOXL 은 '(3배, 계산에서 뺌)'", () => {
    h.detail = detailOf(FX.expected, {
      holdings: 4,
      excluded: [
        { code: "NVDA", name: "엔비디아", reason: "환율을 받지 못해 원화 합계에서 뺐습니다" },
        { code: "SOXL", name: "SOXL", reason: "환율을 받지 못해 원화 합계에서 뺐습니다" },
      ],
    });
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const b = block(r);
    expect(b).toHaveLength(1);
    expect(chunkRows(b[0]!)).toEqual([FX.app.line1, FX.app.line2]);
    expect(b[0]!.props.accessibilityLabel).toBe(FX.app.speech);
    const all = rawOf(totalsCard(r));
    expect(all).not.toContain("미국 상장 없음");
    expect(all).not.toContain("레버리지·인버스 없음");
  });

  it("화면 맨 아래 기준 줄 밑에 '비중'·'미국 상장'의 뜻 한 줄 (총 평가 카드 밖 — 첫 화면을 늘리지 않게) · 폰·넓은 창", () => {
    const about = (r: R) => ofType(r, "Muted").filter((n) => rawOf(n) === EXPOSURE_ABOUT);
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    expect(about(r)).toHaveLength(1);
    expect(allOf(totalsCard(r)).some((n) => rawOf(n) === EXPOSURE_ABOUT)).toBe(false);
    // 기준 줄 바로 아래
    const muted = ofType(r, "Muted").map(rawOf);
    const at = muted.indexOf(EXPOSURE_ABOUT);
    expect(muted[at - 1]).toMatch(/^기준: /);
    for (const size of [{ width: 933, height: 704 }, { width: 704, height: 933 }]) {
      cleanupRenders();
      forgetWindowClass();
      h.win = { ...size, scale: 2.625, fontScale: 1 };
      expect(about(render(<AccountBriefingBody numId={12} layout="split" />)), JSON.stringify(size)).toHaveLength(1);
    }
    // 비중이 null(값이 있는 종목 없음)이면 설명도 없음
    cleanupRenders();
    h.detail = detailOf(null);
    expect(about(render(<AccountBriefingBody numId={12} layout="stack" />))).toHaveLength(0);
  });

  it("합계에서 뺀 종목 줄이 있으면 그 줄 아래 (총 평가 설명 두 줄을 가르지 않게) · 시세 없는 종목·이름으로 구분한 종목 안내", () => {
    h.detail = detailOf(EXCL.expected, { excluded: [{ code: "TSLA", name: "테슬라", reason: "시세를 받지 못해 합계에서 뺐습니다" }], asOf: "2026-09-28T16:05:00+09:00", session: "afternoon" });
    const r = render(<AccountBriefingBody numId={12} layout="stack" />);
    const inner = kids(totalsCard(r));
    const at = inner.findIndex((n) => n.props.accessible === true && String(n.props.accessibilityLabel).startsWith("비중,"));
    expect(rawOf(inner[at - 1]!)).toMatch(/^합계에서 뺀 종목: 테슬라/);
    expect(rawOf(inner[at - 2]!)).toMatch(/^보유 \d+종목 합계/);
    expect(chunkRows(block(r)[0]!)).toEqual([EXCL.app.line1, EXCL.app.line2]);
  });

  it("레버리지·인버스 없음: 둘째 줄은 기준만", () => {
    h.detail = detailOf(NOLEV.expected);
    expect(chunkRows(block(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!)).toEqual([NOLEV.app.line1, NOLEV.app.line2]);
  });

  it("2단 오른쪽 칸(pane): 총 평가 띠에 같은 두 줄", () => {
    const r = render(<AccountBriefingBody numId={12} layout="pane" />);
    const card = totalsCard(r);
    expect(allOf(card).some((n) => n.props.accessibilityLabel === LEV.app.speech)).toBe(true);
    expect(chunkRows(block(r)[0]!)).toEqual([LEV.app.line1, LEV.app.line2]);
  });

  it.each([
    ["세 칸 933×704", { width: 933, height: 704 }],
    ["두 칸 704×933", { width: 704, height: 933 }],
  ])("넓은 창 %s: 왼쪽 칸 총 평가 띠 안", (_n, size) => {
    h.win = { ...size, scale: 2.625, fontScale: 1 };
    const r = render(<AccountBriefingBody numId={12} layout="split" />);
    const left = ofType(r, "ScrollView")[0]!;
    const card = kids(left).find((n) => n.type === "Card" && allOf(n).some((x) => x.type === "Muted" && /^보유 \d+종목 합계/.test(rawOf(x))))!;
    expect(card).toBeDefined();
    const b = allOf(card).filter((n) => n.props.accessibilityLabel === LEV.app.speech);
    expect(b).toHaveLength(1);
    expect(chunkRows(b[0]!)).toEqual([LEV.app.line1, LEV.app.line2]);
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
    const b = block(render(<AccountBriefingBody numId={12} layout="stack" />))[0]!;
    const rows = allOf(b).filter((v) => v.type === "View" && kids(v).length > 1 && kids(v).every((k) => k.type === "Text" || k.type === "Muted"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(flat(row.props.style)).toMatchObject({ flexDirection: "row", flexWrap: "wrap", columnGap: fontScale >= 1.75 ? space.sm : fontScale >= 1.25 ? space.s : space.xs });
      for (const t of kids(row)) {
        expect(t.props.numberOfLines).toBeUndefined();
        expect(t.props.adjustsFontSizeToFit).toBeUndefined();
      }
    }
    // 조각마다 따로 (한 조각이 너무 길어 한 줄을 넘으면 그 조각 안에서만 줄이 바뀐다)
    expect(kids(rows[0]!).map(rawOf)).toEqual([`비중${NBSP}·`, `가장 큰 종목 엔비디아 21.3%${NBSP}·`, `상위 3종목 48.2%${NBSP}·`, `레버리지·인버스 9.1%${NBSP}·`, "미국 상장 62.4%"]);
  });

  it("비중이 null(값이 있는 종목 없음)이면 묶음 없음", () => {
    h.detail = detailOf(null);
    expect(block(render(<AccountBriefingBody numId={12} layout="stack" />))).toHaveLength(0);
  });
});

describe("꺼짐·예전 기록: 지금 그대로", () => {
  it.each(["stack", "pane", "split"] as const)("꺼짐(%s): exposure 칸이 와도 그림 트리가 칸이 없는 것과 같다", (layout) => {
    h.flags.accountExposure = false;
    if (layout === "split") h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const withData = treeOf(render(<AccountBriefingBody numId={12} layout={layout} />));
    h.detail = detailOf(undefined);
    sameTree(treeOf(render(<AccountBriefingBody numId={12} layout={layout} />)), withData);
    expect(withData).not.toContain("비중,");
  });

  it.each(["stack", "pane", "split"] as const)("켬 + 예전 기록(칸 없음)·null(%s): 그림 트리가 꺼진 것과 같다", (layout) => {
    if (layout === "split") h.win = { width: 704, height: 933, scale: 2.625, fontScale: 1 };
    h.detail = detailOf(undefined);
    const old = treeOf(render(<AccountBriefingBody numId={12} layout={layout} />));
    h.detail = detailOf(null);
    const none = treeOf(render(<AccountBriefingBody numId={12} layout={layout} />));
    h.flags.accountExposure = false;
    h.detail = detailOf(LEV.expected);
    const off = treeOf(render(<AccountBriefingBody numId={12} layout={layout} />));
    sameTree(old, off, "예전 기록");
    sameTree(none, off, "null");
  });

  it("브리핑 탭(접은 화면·2단·격자)에는 넣지 않는다 — 켜도 비중 글이 없다", async () => {
    for (const [flags, win] of [
      [{ briefingCompactTop: true }, { width: 475, height: 751 }],
      [{ foldLayout: true, briefingCompactTop: true }, { width: 933, height: 704 }],
      [{ foldLayout: true, briefingCompactTop: true }, { width: 704, height: 933 }],
    ] as const) {
      cleanupRenders();
      h.flags = { accountBriefing: true, accountExposure: true, ...flags };
      h.win = { ...win, scale: 2.625, fontScale: 1 };
      forgetWindowClass();
      pick.forgetPick();
      const r = render(<BriefingsScreen />);
      await settle(r);
      // 2단은 오른쪽 칸에 계좌 상세가 열려 있을 수 있어 목록 쪽(계좌 줄)만 본다
      const row = r.all().find((n) => String(n.props.accessibilityLabel ?? "").startsWith("내 계좌 브리핑"));
      expect(row, JSON.stringify(win)).toBeDefined();
      expect(rawOf(row!)).not.toContain("비중 ·");
      expect(String(row!.props.accessibilityLabel)).not.toContain("비중,");
    }
  });
});
