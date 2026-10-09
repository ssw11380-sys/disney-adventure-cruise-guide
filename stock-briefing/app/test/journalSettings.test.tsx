import { createHash } from "node:crypto";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";
import type { TradeRecordsHealth } from "@/api/types";

/**
 * 매매일지 입구 — 설정 (3-37, 기능 플래그 tradeJournal · tradeRecords 둘 다 켜져 있을 때만).
 *  - 끔: 트리가 지금과 한 글자도 같다 (바꾸기 전 main 코드에서 뜬 지문)
 *  - 켬: 토스증권 연동 카드 바로 아래 '매매일지' 카드 — 설명 한 줄 · '기록' 줄(3-36 과 같은 글) · [매매일지 열기]
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  health: { data: undefined as unknown, isError: false, error: null as unknown },
  push: vi.fn(),
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.5.0" } } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push }, useLocalSearchParams: () => ({}) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/lib/settings", () => ({
  SORT_OPTIONS: [{ value: "created", label: "등록순" }],
  THEME_OPTIONS: [{ value: "dark", label: "다크" }],
  WIDGET_ROW_OPTIONS: [],
  useSettings: () => ({ apiUrl: "http://server", apiToken: "", showKrw: false, afterCost: true, sort: "created", themeMode: "dark", widgetRowCurrency: "krw", haptics: true, setHaptics: vi.fn(), setCredentials: vi.fn() }),
}));
vi.mock("@/api/hooks", () => ({
  useHealth: () => ({ ...h.health, isFetching: false, refetch: async () => undefined }),
  useNotificationSettings: () => ({ data: undefined, refetch: async () => undefined }),
  useFeature: (k: string, fallback = false) => (k in h.flags ? h.flags[k] : fallback),
}));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, ticks: 0 }) }));
vi.mock("@/lib/errorReport", () => ({ flushErrors: async () => "empty", reportError: async () => undefined }));
vi.mock("@/components/Freshness", () => ({ usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/AppUpdateCard", () => ({ AppUpdateCard: "AppUpdateCard" }));
vi.mock("@/components/NotificationSettingsCard", () => ({ NotificationSettingsCard: "NotificationSettingsCard" }));
vi.mock("@/components/TossOpenApiCard", () => ({ TossOpenApiCard: "TossOpenApiCard" }));
vi.mock("@/components/ScreenInfoCard", () => ({ ScreenInfoCard: "ScreenInfoCard" }));
vi.mock("@/components/WidgetRefreshStatus", () => ({ WidgetRefreshStatus: "WidgetRefreshStatus" }));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  return { Screen: ({ children }: { children: React.ReactNode }) => R.createElement("Screen", null, children) };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
// 설정 묶음 화면(settingsSections): 칸 목록(sections — 제목·설명·내용 부품)을 속성 그대로 지문에 넣는다
vi.mock("@/components/SettingsSections", () => ({ SettingsSections: "SettingsSections" }));
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", Chip: "Chip", Muted: "Muted", Row: "Row", RowWrapContext: React.createContext(false), SectionTitle: "SectionTitle", Toggle: "Toggle" }));

const { default: SettingsScreen } = await import("@/app/(tabs)/settings");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");

const records = (over: Partial<TradeRecordsHealth> = {}): TradeRecordsHealth => ({ toss: true, since: "2026-09-28", days: 3, missing5: [], warning: null, trades: { count: 4 }, ...over });
const healthWith = (tr: TradeRecordsHealth | undefined) => ({ data: { ok: true, time: "2026-09-30T08:00:00Z", sources: {}, ...(tr ? { tradeRecords: tr } : {}) }, isError: false, error: null });

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
type R = ReturnType<typeof render>;
const print = (r: R) => createHash("sha1").update(JSON.stringify(tree(r.tree))).digest("hex");
const draw = (w: number, hh: number, flags: Record<string, boolean>) => {
  h.win = { width: w, height: hh, scale: 2.625, fontScale: 1 };
  h.flags = flags;
  forgetWindowClass();
  return render(<SettingsScreen />);
};

beforeEach(() => {
  h.flags = {};
  h.health = healthWith(records());
  h.push.mockReset();
});

/** [이름, 폭, 높이, 플래그] */
const LAYOUTS = [
  ["폰 475", 475, 751, { tradeRecords: false }],
  ["폰 475 매매 기록 줄", 475, 751, { tradeRecords: true }],
  ["넓은 933×704 두 칸", 933, 704, { foldLayout: true }],
  // 설정 묶음 화면 (main 의 settingsSections — '계정·증권사 연동' 칸에 매매일지 카드가 들어간다)
  ["폰 475 묶음", 475, 751, { settingsSections: true, tradeRecords: true }],
] as const;

/** 바꾸기 전 main 코드에서 뜬 지문 (main fdce7e8 위에 다시 맞출 때 그 main 의 settings.tsx 를 이 틀로 그려 다시 뜸 — 끈 트리와 같음) */
const BASE: Record<string, string> = {
  "폰 475": "d246c5ad73b4d85af04354d0bcd5a928bfef29f2",
  "폰 475 매매 기록 줄": "b3fdc1c00da09af642e57244c43b4443dabb2522",
  "넓은 933×704 두 칸": "c2889a0ab0aec336f59f5fc489a6f52db7d3d25e",
  "폰 475 묶음": "607dada512716cd83008add2ef715234647afc62",
};

describe("매매일지 카드를 끄면 설정이 지금과 같다 (지문)", () => {
  for (const [name, w, hh, flags] of LAYOUTS) {
    it(name, () => {
      const off = print(draw(w, hh, { ...flags }));
      // eslint-disable-next-line no-console
      if (!BASE[name]) console.log(`BASE ${JSON.stringify(name)}: ${JSON.stringify(off)},`);
      expect(off).toBe(BASE[name]);
      // tradeJournal 만 켜고 tradeRecords 가 꺼져 있어도 같다
      if (!("tradeRecords" in flags) || flags.tradeRecords === false) expect(print(draw(w, hh, { ...flags, tradeJournal: true }))).toBe(off);
    });
  }
});

const ON = { tradeJournal: true, tradeRecords: true };
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
/** 위에서부터 카드 차례 (가짜 부품 이름 · '매매일지' 카드) */
const order = (r: R) =>
  r
    .all()
    .filter((n) => ["TossOpenApiCard", "AppUpdateCard", "NotificationSettingsCard"].includes(n.type) || (n.type === "Card" && r.all(n.children).some((c) => c.type === "SectionTitle" && textOf(c) === "매매일지")))
    .map((n) => (n.type === "Card" ? "매매일지" : n.type));
const journalCard = (r: R) => r.all().find((n) => n.type === "Card" && r.all(n.children).some((c) => c.type === "SectionTitle" && textOf(c) === "매매일지")) ?? null;

describe("켜면: 설정 '매매일지' 카드 (§4.1 ①)", () => {
  it("토스증권 연동 카드 바로 아래 · 설명 · '기록' 줄(3-36 과 같은 글) · [매매일지 열기] → /journal", () => {
    const r = draw(475, 751, ON);
    expect(order(r)).toEqual(["NotificationSettingsCard", "TossOpenApiCard", "매매일지", "AppUpdateCard"]);
    const card = journalCard(r)!;
    const kids = r.all(card.children);
    // 양도세 추정(journalTax)은 기본 꺼짐 — 설명에 양도세 말이 없다 · 켜면 양도세(추정)까지
    expect(kids.filter((n) => n.type === "Muted").map(textOf)).toEqual(["토스 체결 기록으로 실현손익·기간 수익률을 봐요."]);
    const withTax = draw(475, 751, { ...ON, journalTax: true });
    expect(r.all(journalCard(withTax)!.children).filter((n) => n.type === "Muted").map(textOf)).toEqual(["토스 체결 기록으로 실현손익·기간 수익률·해외주식 양도세(추정)를 봐요."]);
    expect(kids.find((n) => n.type === "Row")!.props).toMatchObject({ label: "기록", value: "9/28부터 3거래일 저장" });
    const btn = kids.find((n) => n.type === "Button")!;
    expect(btn.props).toMatchObject({ title: "매매일지 열기", icon: "book-outline" });
    r.act(() => (btn.props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith("/journal");
  });

  it("토스 연동 전이면 '토스증권을 연동하면 장 마감 뒤부터 기록이 쌓여요.' (버튼은 그대로)", () => {
    h.health = healthWith(records({ toss: false, since: null, days: 0 }));
    const kids = draw(475, 751, ON).all(journalCard(draw(475, 751, ON))!.children);
    expect(kids.filter((n) => n.type === "Muted").map(textOf)).toContain("토스증권을 연동하면 장 마감 뒤부터 기록이 쌓여요.");
    expect(kids.some((n) => n.type === "Button")).toBe(true);
  });

  it("넓은 창 두 칸: 오른쪽 기둥 토스 카드 바로 아래", () => {
    const r = draw(933, 704, { ...ON, foldLayout: true });
    const o = order(r);
    expect(o.indexOf("매매일지")).toBe(o.indexOf("TossOpenApiCard") + 1);
  });

  it("설정 묶음 화면(settingsSections): '계정·증권사 연동' 칸의 토스 연동 카드 바로 아래 · 칸 설명 끝 '매매일지'", () => {
    type Section = { id: string; detail: string; content: React.ReactElement<{ children: React.ReactNode }> };
    const account = (flags: Record<string, boolean>) =>
      (draw(475, 751, { settingsSections: true, ...flags }).all().find((n) => n.type === "SettingsSections")!.props.sections as Section[]).find((x) => x.id === "account")!;
    const names = (sec: Section) => React.Children.toArray(sec.content.props.children).map((c) => ((c as React.ReactElement).type as { name?: string }).name ?? String((c as React.ReactElement).type));
    const on = account(ON);
    expect(on.detail).toBe("계정 정보, 토스 연동과 시세 대조, 매매일지");
    const kids = names(on);
    expect(kids.indexOf("TradeJournalCard")).toBe(kids.indexOf("TossOpenApiCard") + 1);
    // 끄면 칸 설명·내용이 지금 그대로
    const off = account({ tradeRecords: true });
    expect(off.detail).toBe("계정 정보, 토스 연동과 시세 대조");
    expect(names(off)).not.toContain("TradeJournalCard");
  });

  it("서버에 닿지 않거나 토큰이 틀려(상세 없는 /health) 알림·토스 칸이 비면 매매일지 카드도 없다", () => {
    h.health = { data: { ok: true, time: "x", sources: {}, limited: true }, isError: false, error: null };
    expect(journalCard(draw(475, 751, ON))).toBeNull();
  });
});
