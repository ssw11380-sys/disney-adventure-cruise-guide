import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JournalItem, JournalResponse, JournalReturns, JournalTax } from "@/api/types";
import { render, type HostNode } from "./miniRender";

/**
 * 매매일지 화면 (3-37, 기능 플래그 tradeJournal · tradeRecords): 위 탭(기록·수익률·양도세 추정), 기간·종목 칩, 요약, 날짜별 줄, 거래 상세(휴대폰 아래 창 / 폴드 가로 오른쪽 칸)와 메모,
 * 빈 화면 두 가지, 수익률 준비 전·뒤, 양도세 위 상자·합계·빠진 매도·받는 중. 서버 값은 가짜(예시 값 — 실제 계좌와 무관), 시계는 고정
 */
const NOW = Date.parse("2026-09-28T20:00:00+09:00");
const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  params: {} as Record<string, string>,
  journal: undefined as unknown,
  journalCalls: [] as Array<{ from: string; to: string; code?: string | null }>,
  returns: undefined as unknown,
  returnsCalls: [] as unknown[],
  tax: undefined as unknown,
  taxTries: 0,
  taxCalls: 0,
  health: { data: { tradeRecords: { toss: true, since: "2026-09-28", days: 1 } } } as unknown,
  save: vi.fn(),
  push: vi.fn(),
  pickerOpen: vi.fn(),
  kb: [] as { ev: string; fn: (e: { endCoordinates: { height: number } }) => void; removed: boolean }[],
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Modal: "Modal",
  Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: { position: "absolute" } },
  useWindowDimensions: () => h.win,
  Keyboard: {
    addListener: (ev: string, fn: (e: { endCoordinates: { height: number } }) => void) => {
      const sub = { ev, fn, removed: false, remove: () => void (sub.removed = true) };
      h.kb.push(sub);
      return sub;
    },
  },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }) }));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Path: "Path", Line: "Line" }));
vi.mock("@react-native-community/datetimepicker", () => ({ DateTimePickerAndroid: { open: h.pickerOpen } }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push }, useLocalSearchParams: () => h.params, usePathname: () => "/journal" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});
const idle = { isLoading: false, isError: false, error: null, refetch: async () => undefined };
vi.mock("@/api/hooks", () => ({
  useFeature: (k: string, fallback = false) => (k in h.flags ? h.flags[k] : fallback),
  useHealth: () => h.health,
  useJournal: (q: { from: string; to: string; code?: string | null }, enabled: boolean) => {
    if (enabled) h.journalCalls.push(q);
    return { ...idle, data: h.journal };
  },
  useJournalReturns: (q: unknown) => {
    h.returnsCalls.push(q);
    return { ...idle, data: h.returns };
  },
  useJournalTax: () => {
    h.taxCalls++;
    return { ...idle, data: h.tax, tries: h.taxTries };
  },
  useSaveTradeNote: () => ({ mutate: h.save, isPending: false }),
  useJournalStock: () => ({ ...idle, data: undefined }),
}));
vi.mock("@/lib/useNow", () => ({ useNow: () => NOW }));
vi.mock("@/lib/uxFlags", () => ({ useUx: () => ({ flagsMissing: false }) }));
vi.mock("@/lib/settingsLink", () => ({ useSettingsGuide: () => null }));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  return { Screen: ({ children, top }: { children: React.ReactNode; top?: React.ReactNode }) => R.createElement("Screen", null, R.createElement("Top", null, top), children) };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Chip: "Chip", Empty: "Empty", ErrorView: "ErrorView", Loading: "Loading", Segmented: "Segmented", Card: "Card", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle" }));

const { default: JournalScreen } = await import("@/app/journal/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const lib = await import("@/lib/journal");

const ON = { tradeJournal: true, tradeRecords: true };
/** 양도세 추정 탭까지 (하위 플래그 journalTax — 서버 기본 끔) */
const TAX_ON = { ...ON, journalTax: true };
const realized = (gross: number, rate: number): JournalItem["realized"] => ({
  status: "ok",
  reason: null,
  basis: "history-checked",
  anchorDate: "2026-09-25",
  avgCost: 34.0133,
  costAmount: 170.07,
  gross,
  rate,
  costs: { fee: null, tax: null, total: null, source: null },
  net: null,
  krw: { gross: 24_703, costKrw: 235_809, sellFx: 1389.4, fxSource: "toss", estimated: true, reason: null },
});
const item = (over: Partial<JournalItem>): JournalItem => ({
  key: "3:o3:0",
  kind: "fill",
  account: 3,
  accountLabel: null,
  orderId: "o3",
  code: "SOXL",
  name: "SOXL",
  market: "US",
  currency: "USD",
  side: "SELL",
  quantity: 5,
  orderQuantity: 5,
  amount: 187.5,
  price: 37.5,
  at: "2026-09-25T23:10:04+09:00",
  timeBasis: "filled",
  status: "CLOSED",
  part: null,
  realized: realized(17.43, 10.25),
  note: null,
  ...over,
});
const SELL = item({});
const BUY = item({ key: "3:o2:0", orderId: "o2", side: "BUY", quantity: 20, orderQuantity: 20, amount: 700, price: 35, at: "2026-09-23T23:00:00+09:00", realized: null, afterBuy: { avgCost: 34.0133, quantity: 30 } });
const LIST: JournalResponse = {
  enabled: true,
  from: "2026-08-28",
  to: "2026-09-28",
  recordSince: "2026-09-23",
  code: null,
  verified: { krRealized: false, usRealizedUsd: false, usRealizedKrw: false, headline: "gross" },
  summary: { orders: 2, buys: 1, sells: 1, realized: { KRW: null, USD: 17.43, krwTotal: 24_703, krwTotalEstimated: true, estimatedIncluded: false }, costs: { toss: 0, estimated: 0, none: 1 }, unknownSells: 0, truncated: [] },
  days: [
    { date: "2026-09-25", realized: { KRW: null, USD: 17.43, krwTotal: 24_703, krwTotalEstimated: true }, items: [SELL] },
    { date: "2026-09-23", realized: { KRW: null, USD: null, krwTotal: null, krwTotalEstimated: false }, items: [BUY] },
  ],
  stocks: [{ code: "SOXL", name: "SOXL", count: 2 }],
};

beforeEach(() => {
  h.win = { width: 475, height: 751, scale: 2.625, fontScale: 1 };
  h.flags = { ...ON };
  h.params = {};
  h.journal = LIST;
  h.journalCalls = [];
  h.returns = undefined;
  h.returnsCalls = [];
  h.tax = undefined;
  h.taxTries = 0;
  h.taxCalls = 0;
  h.health = { data: { tradeRecords: { toss: true, since: "2026-09-28", days: 1 } } };
  h.save.mockReset();
  h.push.mockReset();
  h.pickerOpen.mockReset();
  h.kb = [];
  forgetWindowClass();
});

type R = ReturnType<typeof render>;
const draw = (): R => {
  forgetWindowClass();
  return render(<JournalScreen />);
};
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const byLabel = (r: R, label: string, type?: string) => {
  const hit = r.all().filter((n) => n.props.accessibilityLabel === label && (!type || n.type === type));
  if (hit.length !== 1) throw new Error(`"${label}" ${hit.length}개`);
  return hit[0]!;
};
const press = (r: R, n: HostNode) => r.act(() => (n.props.onPress as () => void)());
const last = <T,>(xs: T[]): T => xs[xs.length - 1]!;

describe("켜고 끄기", () => {
  it("꺼져 있으면(두 플래그 중 하나라도) 안내만, 서버를 부르지 않는다", () => {
    const cases: Array<Record<string, boolean>> = [{}, { tradeJournal: true }, { tradeRecords: true }];
    for (const flags of cases) {
      h.flags = flags;
      const r = draw();
      expect(r.all().find((n) => n.type === "Empty")!.props.title).toBe("지금은 매매일지를 쓸 수 없습니다");
      expect(h.journalCalls).toEqual([]);
    }
  });

  it("양도세 추정(journalTax)이 꺼져 있으면(기본) '기록'·'수익률' 두 탭만 — tab=tax 로 열어도 기록 탭, 양도세 화면·요청 0건 · 켜면 세 탭", () => {
    h.params = { tab: "tax" };
    h.tax = { enabled: true, year: 2026, years: [2026] } as JournalTax;
    const r = draw();
    const seg = r.all().find((n) => n.type === "Segmented")!;
    expect(seg.props.value).toBe("list");
    expect((seg.props.options as Array<{ value: string }>).map((o) => o.value)).toEqual(["list", "returns"]);
    expect(h.taxCalls).toBe(0);
    expect(r.all().some((n) => String(n.props.testID ?? "").startsWith("tax-"))).toBe(false);
    expect(r.text()).not.toContain("양도세");
    expect(h.journalCalls.length).toBeGreaterThan(0);
    // 켜면 세 탭 · tab=tax 는 양도세 탭
    h.flags = TAX_ON;
    const on = draw();
    const seg2 = on.all().find((n) => n.type === "Segmented")!;
    expect((seg2.props.options as Array<{ value: string }>).map((o) => o.value)).toEqual(["list", "returns", "tax"]);
    expect(seg2.props.value).toBe("tax");
    expect(h.taxCalls).toBeGreaterThan(0);
  });
});

describe("기록 탭", () => {
  it("기본은 1달(한국 날짜)·모든 종목, 요약 카드와 날짜별 줄 — 줄은 한 줄 한 문장", () => {
    const r = draw();
    expect(r.all().find((n) => n.type === "Segmented")!.props.value).toBe("list");
    expect(last(h.journalCalls)).toEqual({ from: "2026-08-28", to: "2026-09-28", code: null });
    const text = r.text();
    expect(text).toContain("8월 28일 ~ 9월 28일");
    expect(text).toContain("+$17.43 (원화 약 +24,703원, 추정)");
    expect(text).toContain("매수 1건 · 매도 1건 · 체결 2건");
    expect(text).toContain("9월 23일부터 저장한 기록이에요.");
    expect(r.all().filter((n) => n.props.accessibilityRole === "header" && /^9월 2[35]일/.test(String(n.props.accessibilityLabel))).map((n) => n.props.accessibilityLabel)).toEqual(["9월 25일 금요일, 실현손익 17.43달러 이익", "9월 23일 수요일"]);
    // 요약 줄 화면 읽기도 읽는 말로
    expect(r.all().some((n) => n.props.accessibilityLabel === "미국 실현손익 17.43달러 이익, 원화 약 24,703원 이익, 추정")).toBe(true);
    byLabel(r, lib.rowSpeech(SELL), "Pressable");
    byLabel(r, lib.rowSpeech(BUY), "Pressable");
  });

  it("줄을 누르면 거래 상세(아래 창): 실현손익 계산 · 원화로는 · 계산 방법 · 메모", () => {
    const r = draw();
    press(r, byLabel(r, lib.rowSpeech(SELL), "Pressable"));
    const sheet = r.all().find((n) => n.props.testID === "trade-detail-sheet")!;
    const t = textOf(sheet);
    expect(t).toContain("SOXL 매도");
    expect(t).toContain("실현손익 계산");
    expect(t).toContain("− 평균 구매가 $34.0133 × 5주");
    expect(t).toContain("+$17.43 (+10.25%)");
    expect(t).toContain("약 +24,703원 (추정)");
    expect(t).toContain(lib.JOURNAL.method);
    expect(t).toContain("0/200");
  });

  it("메모: 200자에서 멈추고, 저장하면 '메모를 저장했어요.', 실패하면 입력 그대로 + 안내", () => {
    const r = draw();
    press(r, byLabel(r, lib.rowSpeech(SELL), "Pressable"));
    const input = () => r.all().find((n) => n.props.testID === "note-input")!;
    r.act(() => (input().props.onChangeText as (v: string) => void)("가".repeat(250)));
    expect([...String(input().props.value)].length).toBe(200);
    r.act(() => (input().props.onChangeText as (v: string) => void)("실적 발표 뒤 일부 정리"));
    press(r, byLabel(r, "메모 저장"));
    expect(h.save).toHaveBeenCalledTimes(1);
    const [body, cb] = h.save.mock.calls[0] as [unknown, { onSuccess: (x: unknown) => void; onError: () => void }];
    expect(body).toEqual({ account: 3, orderId: "o3", note: "실적 발표 뒤 일부 정리" });
    r.act(() => cb.onError());
    expect(r.text()).toContain("메모를 저장하지 못했어요. 다시 해 주세요.");
    expect(input().props.value).toBe("실적 발표 뒤 일부 정리");
    r.act(() => cb.onSuccess({ account: 3, orderId: "o3", note: "실적 발표 뒤 일부 정리", updatedAt: "x" }));
    expect(r.text()).toContain("메모를 저장했어요.");
  });

  it("회귀: 메모 [지우기]는 입력 칸만 비운다 — 서버에 보내지 않고, 비운 채 [저장]을 눌러야 지우고 '메모를 지웠어요.'", () => {
    h.journal = { ...LIST, days: [{ ...LIST.days[0]!, items: [{ ...SELL, note: "실적 발표 뒤 일부 정리" }] }, LIST.days[1]!] };
    const r = draw();
    press(r, byLabel(r, lib.rowSpeech({ ...SELL, note: "실적 발표 뒤 일부 정리" }), "Pressable"));
    const input = () => r.all().find((n) => n.props.testID === "note-input")!;
    expect(input().props.value).toBe("실적 발표 뒤 일부 정리");
    press(r, byLabel(r, "메모 입력 칸 비우기"));
    expect(h.save).not.toHaveBeenCalled();
    expect(input().props.value).toBe("");
    expect(r.text()).toContain(lib.JOURNAL.noteEmptyHint);
    expect(byLabel(r, "메모 입력 칸 비우기").props.disabled).toBe(true);
    press(r, byLabel(r, "메모 저장"));
    expect(h.save).toHaveBeenCalledTimes(1);
    const [body, cb] = h.save.mock.calls[0] as [unknown, { onSuccess: (x: unknown) => void }];
    expect(body).toEqual({ account: 3, orderId: "o3", note: "" });
    r.act(() => cb.onSuccess({ account: 3, orderId: "o3", note: null, updatedAt: "x" }));
    expect(r.text()).toContain("메모를 지웠어요.");
  });

  it("회귀: 휴대폰에서 메모 자판이 열리면 아래 창을 위쪽에 붙이고 높이를 자판 위까지 줄인 뒤 끝(메모 칸·[저장])까지 내린다, 닫으면 아래로, 창을 닫으면 구독을 뗀다", () => {
    h.win = { width: 360, height: 752, scale: 3, fontScale: 1 };
    const r = draw();
    press(r, byLabel(r, lib.rowSpeech(SELL), "Pressable"));
    const flat = (n: HostNode) => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
    const sheet = () => r.all().find((n) => n.props.testID === "trade-detail-sheet")!;
    const backdrop = () => r.all().find((n) => n.children.includes(sheet()))!;
    expect(flat(backdrop())).toMatchObject({ justifyContent: "flex-end" });
    expect(flat(sheet()).maxHeight).toBeCloseTo(752 * 0.85);
    // 자판 300dp
    const scroll = sheet().children.find((c): c is HostNode => typeof c !== "string" && c.type === "ScrollView")!;
    const scrollToEnd = vi.fn();
    (scroll.props.ref as { current: unknown }).current = { scrollToEnd };
    r.act(() => h.kb.find((k) => k.ev === "keyboardDidShow")!.fn({ endCoordinates: { height: 300 } }));
    expect(flat(backdrop())).toMatchObject({ justifyContent: "flex-start", paddingTop: 0 + 12 });
    expect(flat(sheet()).maxHeight).toBe(752 - 300 - 0 - 12 * 2);
    // 창이 줄어든 뒤 끝까지 내린다 (메모 칸·[저장]이 자판 위에 보이게)
    const scroll2 = sheet().children.find((c): c is HostNode => typeof c !== "string" && c.type === "ScrollView")!;
    r.act(() => (scroll2.props.onLayout as () => void)());
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    r.act(() => h.kb.find((k) => k.ev === "keyboardDidHide")!.fn({ endCoordinates: { height: 0 } }));
    expect(flat(backdrop())).toMatchObject({ justifyContent: "flex-end" });
    // 자판이 닫힌 채로는 끝으로 내리지 않는다
    scrollToEnd.mockReset();
    r.act(() => (sheet().children.find((c): c is HostNode => typeof c !== "string" && c.type === "ScrollView")!.props.onLayout as () => void)());
    expect(scrollToEnd).not.toHaveBeenCalled();
    press(r, byLabel(r, "거래 상세 닫기"));
    expect(r.all().some((n) => n.props.testID === "trade-detail-sheet")).toBe(false);
    expect(h.kb.length).toBeGreaterThan(0);
    expect(h.kb.every((k) => k.removed)).toBe(true);
  });

  it("회귀: 200% 글씨에서는 종목 이름을 두 줄까지 (100% 는 한 줄)", () => {
    const long = { ...SELL, name: "프로셰어즈 울트라프로 QQQ 3배" };
    h.journal = { ...LIST, days: [{ ...LIST.days[0]!, items: [long] }] };
    const nameLines = (r: R) => r.all().find((n) => n.type === "Text" && n.children.join("") === long.name)!.props.numberOfLines;
    expect(nameLines(draw())).toBe(1);
    h.win = { width: 360, height: 752, scale: 3, fontScale: 2 };
    expect(nameLines(draw())).toBe(2);
  });

  it("회귀: 기간 칩(1주·1달 …)은 누르는 폭 44 이상", () => {
    const r = draw();
    for (const p of lib.PERIODS) expect(byLabel(r, `기간 ${p.label}`).props.minWidth).toBeGreaterThanOrEqual(44);
  });

  it("매수 상세는 '이 매수 뒤 평균 구매가'", () => {
    const r = draw();
    press(r, byLabel(r, lib.rowSpeech(BUY), "Pressable"));
    expect(textOf(r.all().find((n) => n.props.testID === "trade-detail-sheet")!)).toContain("이 매수 뒤 평균 구매가 $34.0133 · 30주");
  });

  it("기간 칩: 1년 → 1년 전부터 · 직접 → 기간 고르기(날짜 고르기, 400일 넘으면 적용 못 함)", () => {
    const r = draw();
    press(r, byLabel(r, "기간 1년"));
    expect(last(h.journalCalls)).toEqual({ from: "2025-09-28", to: "2026-09-28", code: null });
    press(r, byLabel(r, "기간 직접"));
    const modal = r.all().find((n) => n.type === "Modal")!;
    expect(textOf(modal)).toContain("기간 고르기");
    press(r, byLabel(r, "시작 날짜 바꾸기"));
    expect(h.pickerOpen).toHaveBeenCalledTimes(1);
    const opts = h.pickerOpen.mock.calls[0]![0] as { mode: string; onChange: (e: { type: string }, d?: Date) => void };
    expect(opts.mode).toBe("date");
    // 2025-01-01 을 고르면 400일 넘음 → 적용 버튼 꺼짐
    r.act(() => opts.onChange({ type: "set" }, new Date(2025, 0, 1, 12)));
    expect(r.text()).toContain("기간은 400일까지 고를 수 있어요.");
    expect(r.all().find((n) => n.type === "Button" && n.props.title === "적용")!.props.disabled).toBe(true);
    r.act(() => opts.onChange({ type: "set" }, new Date(2026, 8, 1, 12)));
    press(r, r.all().find((n) => n.type === "Button" && n.props.title === "적용")!);
    expect(last(h.journalCalls)).toEqual({ from: "2026-09-01", to: "2026-09-28", code: null });
  });

  it("종목 칩: 고르면 그 종목만, ✕ 로 거르기 지우기 · 주소 code 로 열면 처음부터 그 종목", () => {
    const r = draw();
    press(r, byLabel(r, "모든 종목, 종목 고르기"));
    press(r, byLabel(r, "SOXL · 2건"));
    expect(last(h.journalCalls).code).toBe("SOXL");
    press(r, byLabel(r, "종목 거르기 지우기"));
    expect(last(h.journalCalls).code).toBeNull();
    h.params = { code: "tsla" };
    h.journalCalls = [];
    draw();
    expect(h.journalCalls[0]!.code).toBe("TSLA");
  });

  it("빈 화면: 토스 연동 없음 → [설정 열기] · 기간 안 0건 → [기간 1년으로 보기]", () => {
    h.journal = { ...LIST, days: [], stocks: [] };
    let r = draw();
    let empty = r.all().find((n) => n.type === "Empty")!;
    expect(empty.props.title).toBe("이 기간에 저장된 체결이 없어요.");
    r.act(() => ((empty.props.action as React.ReactElement<{ onPress: () => void }>).props.onPress)());
    expect(last(h.journalCalls).from).toBe("2025-09-28");
    h.health = { data: { tradeRecords: { toss: false, since: null, days: 0 } } };
    r = draw();
    empty = r.all().find((n) => n.type === "Empty")!;
    expect(empty.props.title).toBe("토스증권을 연동하면 장 마감 뒤부터 매매 기록이 쌓여요.");
    r.act(() => ((empty.props.action as React.ReactElement<{ onPress: () => void }>).props.onPress)());
    expect(h.push).toHaveBeenCalledWith("/settings");
  });

  it("폴드 가로(933×704): 왼쪽 목록 · 오른쪽 거래 상세 (고른 것이 없으면 안내 한 줄), 아래 창은 쓰지 않는다", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags = { ...ON, foldLayout: true };
    const r = draw();
    expect(r.text()).toContain("왼쪽에서 체결을 고르면 계산이 보여요.");
    press(r, byLabel(r, lib.rowSpeech(SELL), "Pressable"));
    expect(r.all().some((n) => n.props.testID === "trade-detail-sheet")).toBe(false);
    expect(r.text()).toContain("실현손익 계산");
    expect(r.text()).not.toContain("왼쪽에서 체결을 고르면 계산이 보여요.");
    expect(byLabel(r, lib.rowSpeech(SELL), "Pressable").props.accessibilityState).toEqual({ selected: true });
  });
});

describe("수익률 탭", () => {
  const notReady: JournalReturns = { enabled: true, ready: false, tradingDays: 3, needDays: 10, recordSince: "2026-09-28", actual: { from: "2026-09-28", to: "2026-09-30" } };
  it("10거래일 전: 숫자 대신 안내 한 줄 (§4.6)", () => {
    h.params = { tab: "returns" };
    h.returns = notReady;
    const r = draw();
    expect(r.all().find((n) => n.type === "Segmented")!.props.value).toBe("returns");
    expect(r.all().find((n) => n.props.testID === "returns-not-ready")!.props.accessibilityLabel).toBe(lib.returnsNotReady(notReady));
    expect(h.returnsCalls[0]).toEqual({ preset: "1M", market: "ALL" });
  });

  it("준비 뒤: 큰 숫자 '수익률 (시간가중)' · 기간 손익 · 계산 방법 펼침 · 시장 칩", () => {
    h.params = { tab: "returns" };
    h.returns = { ...notReady, ready: true, tradingDays: 10, actual: { from: "2026-09-28", to: "2026-10-12" }, clippedToRecordStart: true, market: "ALL", currency: "KRW", twr: 3.42, pnl: 456_000, startValue: 12_340_000, endValue: 12_800_000, buys: 0, sells: 0, transfersEstimated: 0, gaps: [], doubtedSkipped: [], priceBasis: { regularClose: 1, priceFallback: 0, fallbackCodes: [] }, series: [{ date: "2026-09-28", cum: 0 }, { date: "2026-10-12", cum: 3.42 }] };
    const r = draw();
    const box = r.all().find((n) => n.props.testID === "returns-ready")!;
    expect(textOf(box)).toContain("+3.42%수익률 (시간가중)기간 손익 +456,000원");
    expect(r.text()).not.toContain("현금 입출금과 배당은 넣지 않았어요.");
    press(r, byLabel(r, "계산 방법"));
    expect(r.text()).toContain("현금 입출금과 배당은 넣지 않았어요.");
    expect(r.all().some((n) => n.props.testID === "return-line")).toBe(true);
    // 선 그림 제목·양 끝 날짜
    expect(textOf(r.all().find((n) => n.props.testID === "return-line")!)).toBe("날짜별 누적 수익률9월 28일10월 12일");
    // 요약 묶음 화면 읽기: 보이는 줄을 다 읽는다
    expect(r.all().some((n) => n.props.accessibilityLabel === lib.returnsSpeech(h.returns as JournalReturns) && String(n.props.accessibilityLabel).includes("시작 평가금액 12,340,000원에서 끝 12,800,000원"))).toBe(true);
    press(r, byLabel(r, "시장 미국"));
    expect(last(h.returnsCalls)).toEqual({ preset: "1M", market: "US" });
  });
});

describe("양도세 추정 탭", () => {
  const TAX: JournalTax = {
    enabled: true,
    year: 2026,
    years: [2026],
    rules: { rate: 0.22, nationalRate: 0.2, localRateOfNational: 0.1, deduction: 2_500_000, method: "moving-average", lawYear: 2026 },
    totals: { gains: 4_000_000, losses: -550_000, net: 3_450_000, base: 950_000, nationalTax: 190_000, localTax: 19_000, tax: 209_000, sells: 12 },
    complete: false,
    fxPending: 0,
    excluded: [{ code: "TSLA", name: "테슬라", count: 2, reason: "기록 시작 전에 산 몫이라 취득가를 몰라요" }],
    items: [{ key: "k", code: "SOXL", name: "SOXL", tradeDate: "2026-09-25", settleDate: "2026-09-29", settleSource: "estimated", quantity: 5, proceedsUsd: 187.5, costsUsd: null, fxSell: { rate: 1389.4, source: "smbs", date: "2026-09-29", provisional: false }, proceedsKrw: 260_512, costKrw: 235_809, costsKrw: null, gainKrw: 24_703 }],
    kr: { securitiesTax: { amount: null, sells: 1, source: null } },
  };
  it("맨 위 '참고용 추정' 상자(늘) · 합계·공제·세율·예상 세액 · 빠진 매도 · 계산 기준 7줄(확인 필요 규칙 포함) · 국내 · 고지", () => {
    h.params = { tab: "tax" };
    h.flags = TAX_ON;
    h.tax = TAX;
    const r = draw();
    expect(textOf(r.all().find((n) => n.props.testID === "tax-notice")!)).toBe(lib.TAX.notice);
    const totals = textOf(r.all().find((n) => n.props.testID === "tax-totals")!);
    expect(totals).toContain("해외주식 양도세 추정 · 2026년");
    expect(totals).toContain("예상 세액 (추정)209,000원");
    expect(textOf(r.all().find((n) => n.props.testID === "tax-excluded")!)).toBe("계산에서 뺀 매도 2건이 있어 실제와 다를 수 있어요.테슬라 2건 · 기록 시작 전에 산 몫이라 취득가를 몰라요");
    for (const rule of lib.TAX.rules) expect(r.text()).toContain(rule);
    expect(r.text()).toContain(lib.TAX.krAssumption);
    expect(r.text()).toContain(lib.TAX.notAdvice);
    // 매도별 계산은 접힌 채
    expect(r.text()).not.toContain("양도가액 260,512원");
    press(r, byLabel(r, "매도별 계산 보기"));
    expect(r.text()).toContain("양도가액 260,512원 − 취득가액 235,809원 = +24,703원");
  });

  it("환율 받는 중: 안내 · 다시 묻기를 다 쓰면(5번) 빠진 매도로", () => {
    h.params = { tab: "tax" };
    h.flags = TAX_ON;
    h.tax = { ...TAX, excluded: [], fxPending: 2 };
    let r = draw();
    expect(textOf(r.all().find((n) => n.props.testID === "tax-pending")!)).toBe("환율을 받는 중이에요 (2건). 잠시 뒤 다시 계산해요.");
    h.taxTries = 5;
    r = draw();
    expect(r.all().some((n) => n.props.testID === "tax-pending")).toBe(false);
    expect(textOf(r.all().find((n) => n.props.testID === "tax-excluded")!)).toContain("계산에서 뺀 매도 2건");
  });

  it("폴드 가로: 왼쪽 합계·기준 | 오른쪽 매도별 계산(늘 펼침)", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags = { ...TAX_ON, foldLayout: true };
    h.params = { tab: "tax" };
    h.tax = TAX;
    const r = draw();
    expect(r.text()).toContain("양도가액 260,512원 − 취득가액 235,809원 = +24,703원");
    expect(r.all().filter((n) => n.props.testID === "tax-per-sell")).toHaveLength(1);
    expect(r.all().some((n) => n.props.testID === "tax-per-sell-none")).toBe(false);
  });

  it("회귀: 폴드 가로에서 계산에 넣은 해외 매도가 0건이면 오른쪽 칸에 안내 한 줄 (빈 화면이 아니게)", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags = { ...TAX_ON, foldLayout: true };
    h.params = { tab: "tax" };
    h.tax = { ...TAX, items: [], excluded: [], totals: { gains: 0, losses: 0, net: 0, base: 0, nationalTax: 0, localTax: 0, tax: 0, sells: 0 } };
    const r = draw();
    expect(r.all().some((n) => n.props.testID === "tax-per-sell")).toBe(false);
    expect(textOf(r.all().find((n) => n.props.testID === "tax-per-sell-none")!)).toBe("2026년 계산에 넣은 해외주식 매도가 없어요.");
  });

  it("검토 반영 4차: 순서를 몰라 합계에서 뺀 매도 — 빠진 매도 상자에 추정 양도차익 줄 · 매도별 계산에 '합계에서 뺌'으로 따로 (폴드 가로 오른쪽 칸도)", () => {
    const u = { key: "u", code: "SOXL", name: "SOXL", tradeDate: "2026-09-28", settleDate: "2026-09-30", settleSource: "estimated" as const, quantity: 15, proceedsUsd: 1800, costsUsd: null, fxSell: { rate: 1350, source: "smbs", date: "2026-09-30", provisional: false }, proceedsKrw: 2_430_000, costKrw: 2_025_000, costsKrw: null, gainKrw: 405_000, estimate: { status: "order-uncertain" as const, reason: "x" } };
    const reason = "같은 날 사고판 순서를 몰라 취득가가 확실하지 않아 합계에서 뺐어요";
    const tax: JournalTax = { ...TAX, items: [], excluded: [{ code: "SOXL", name: "SOXL", count: 1, reason }], totals: { gains: 0, losses: 0, net: 0, base: 0, nationalTax: 0, localTax: 0, tax: 0, sells: 0 }, uncertainExcluded: 1, uncertainGainKrw: 405_000, uncertainItems: [u] };
    h.params = { tab: "tax" };
    h.flags = TAX_ON;
    h.tax = tax;
    let r = draw();
    expect(textOf(r.all().find((n) => n.props.testID === "tax-excluded")!)).toBe(`계산에서 뺀 매도 1건이 있어 실제와 다를 수 있어요.SOXL 1건 · ${reason}사고판 순서를 몰라 뺀 매도 1건의 추정 양도차익은 +405,000원이에요.`);
    press(r, byLabel(r, "매도별 계산 보기"));
    expect(r.text()).toContain("환율 1,350.00원 · 합계에서 뺌");
    expect(r.text()).toContain("양도가액 2,430,000원 − 취득가액 2,025,000원 = +405,000원");
    // 폴드 가로: 오른쪽 칸에 그 매도 (빈 칸 안내가 아니라)
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags = { ...TAX_ON, foldLayout: true };
    r = draw();
    expect(r.all().filter((n) => n.props.testID === "tax-per-sell")).toHaveLength(1);
    expect(r.text()).toContain("합계에서 뺌");
  });
});

describe("검토 반영 (3-37 다듬기) — 화면", () => {
  const flat = (n: HostNode, key = "style") => Object.assign({}, ...[n.props[key]].flat(Infinity).filter(Boolean)) as Record<string, unknown>;

  it("회귀: 메모 [저장]은 바뀐 것이 있을 때만 켜진다 (빈칸만·같은 글은 꺼짐), 저장 뒤 다시 꺼지고, 저장한 메모를 비우면 '메모를 지웠어요.'", () => {
    const r = draw();
    press(r, byLabel(r, lib.rowSpeech(SELL), "Pressable"));
    const input = () => r.all().find((n) => n.props.testID === "note-input")!;
    const saveBtn = () => byLabel(r, "메모 저장");
    expect(saveBtn().props.disabled).toBe(true);
    r.act(() => (input().props.onChangeText as (v: string) => void)("  \n "));
    expect(saveBtn().props.disabled).toBe(true);
    r.act(() => (input().props.onChangeText as (v: string) => void)("실적"));
    expect(saveBtn().props.disabled).toBe(false);
    press(r, saveBtn());
    const [, cb] = h.save.mock.calls[0] as [unknown, { onSuccess: (x: unknown) => void }];
    r.act(() => cb.onSuccess({ account: 3, orderId: "o3", note: "실적", updatedAt: "x" }));
    expect(r.text()).toContain("메모를 저장했어요.");
    expect(saveBtn().props.disabled).toBe(true);
    // 저장한 메모를 비우고 저장 → 지웠어요
    press(r, byLabel(r, "메모 입력 칸 비우기"));
    expect(saveBtn().props.disabled).toBe(false);
    press(r, saveBtn());
    const [, cb2] = h.save.mock.calls[1] as [unknown, { onSuccess: (x: unknown) => void }];
    r.act(() => cb2.onSuccess({ account: 3, orderId: "o3", note: null, updatedAt: "x" }));
    expect(r.text()).toContain("메모를 지웠어요.");
    expect(saveBtn().props.disabled).toBe(true);
  });

  it("회귀: 폴드 가로(933×704) 오른쪽 거래 상세도 메모 자판이 열리면 자판 높이만큼 아래 여백을 두고 끝(메모 칸·[저장])까지 내린다, 닫으면 여백 없음", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    h.flags = { ...ON, foldLayout: true };
    const r = draw();
    press(r, byLabel(r, lib.rowSpeech(SELL), "Pressable"));
    const pane = () => r.all().find((n) => n.props.testID === "trade-detail-pane")!;
    expect(pane().type).toBe("ScrollView");
    expect(pane().props.keyboardShouldPersistTaps).toBe("handled");
    const scrollToEnd = vi.fn();
    (pane().props.ref as { current: unknown }).current = { scrollToEnd };
    const base = Number(flat(pane(), "contentContainerStyle").paddingBottom ?? 0);
    r.act(() => h.kb.find((k) => k.ev === "keyboardDidShow" && !k.removed)!.fn({ endCoordinates: { height: 300 } }));
    expect(Number(flat(pane(), "contentContainerStyle").paddingBottom)).toBeGreaterThanOrEqual(300);
    expect(scrollToEnd).toHaveBeenCalled();
    // 메모 칸이 늘어나도(여러 줄) 끝을 따라간다
    scrollToEnd.mockReset();
    r.act(() => (pane().props.onContentSizeChange as () => void)());
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    r.act(() => h.kb.find((k) => k.ev === "keyboardDidHide" && !k.removed)!.fn({ endCoordinates: { height: 0 } }));
    expect(Number(flat(pane(), "contentContainerStyle").paddingBottom ?? 0)).toBe(base);
    scrollToEnd.mockReset();
    r.act(() => (pane().props.onContentSizeChange as () => void)());
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it("회귀: 누적 수익률 선의 '0%' 글자 높이는 글자 배율만큼 — 200% 에서도 0% 선 위, 그림 안 (아래 날짜와 겹치지 않음)", async () => {
    const { RETURN_LINE_H, zeroLabelTop, zeroLabelH } = await import("@/components/journal/ReturnLine");
    for (const fs of [1, 1.3, 2]) {
      h.win = { width: 360, height: 752, scale: 3, fontScale: fs };
      h.params = { tab: "returns" };
      h.returns = { enabled: true, ready: true, tradingDays: 10, recordDays: 10, needDays: 10, recordSince: "2026-09-28", actual: { from: "2026-09-28", to: "2026-10-12" }, market: "ALL", currency: "KRW", twr: 3, pnl: 1, startValue: 1, endValue: 1, buys: 0, sells: 0, transfersEstimated: 0, gaps: [], doubtedSkipped: [], priceBasis: { regularClose: 1, priceFallback: 0, fallbackCodes: [] }, series: [{ date: "2026-09-28", cum: 0 }, { date: "2026-10-01", cum: 1 }, { date: "2026-10-12", cum: 3 }] } as JournalReturns;
      const r = draw();
      const line = r.all().find((n) => n.props.testID === "return-line")!;
      const box = r.all(line.children).find((n) => typeof n.props.onLayout === "function")!;
      r.act(() => (box.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { width: 300 } } }));
      const zero = r.all().find((n) => n.type === "Text" && n.children.join("") === "0%")!;
      const st = flat(zero);
      const hgt = zeroLabelH(fs);
      expect(hgt).toBeGreaterThanOrEqual(Math.ceil(11 * 1.4 * fs) - 1);
      expect(st.top).toBe(zeroLabelTop(RETURN_LINE_H - 4, fs));
      // 0% 선(아래 끝 근처) 위에 글자 전체, 그림 높이 안
      expect(Number(st.top) + hgt).toBeLessThanOrEqual(RETURN_LINE_H - 4);
      expect(Number(st.top)).toBeGreaterThanOrEqual(0);
    }
  });

  it("양도세: 순서 모름 매도를 합계에 넣었으면(includeUncertain) 합계 줄 '추정 포함' · 따로 상자 · 매도별 계산 첫 줄 '추정 포함'", () => {
    h.params = { tab: "tax" };
    h.flags = TAX_ON;
    h.tax = {
      enabled: true,
      year: 2026,
      years: [2026],
      rules: { rate: 0.22, nationalRate: 0.2, localRateOfNational: 0.1, deduction: 2_500_000, method: "moving-average", lawYear: 2026 },
      totals: { gains: 0, losses: 0, net: 0, base: 0, nationalTax: 0, localTax: 0, tax: 0, sells: 1 },
      complete: true,
      fxPending: 0,
      excluded: [],
      estimatedIncluded: 1,
      estimatedSells: [{ code: "SOXL", name: "SOXL", count: 1, reason: "같은 날 사고판 순서를 몰라 추정했어요." }],
      items: [{ key: "k", code: "SOXL", name: "SOXL", tradeDate: "2026-09-28", settleDate: "2026-09-30", settleSource: "estimated", quantity: 5, proceedsUsd: 125, costsUsd: null, fxSell: { rate: 1350, source: "smbs", date: "2026-09-30", provisional: false }, proceedsKrw: 168_750, costKrw: 168_750, costsKrw: null, gainKrw: 0, estimate: { status: "order-uncertain", reason: "x" } }],
      kr: { securitiesTax: { amount: null, sells: 0, source: null } },
    } as JournalTax;
    const r = draw();
    expect(textOf(r.all().find((n) => n.props.testID === "tax-totals")!)).toContain("양도차익 합계 (이익 − 손실, 추정 포함)");
    expect(textOf(r.all().find((n) => n.props.testID === "tax-totals")!)).toContain("매도 1건 (추정 포함 1건)");
    expect(textOf(r.all().find((n) => n.props.testID === "tax-estimated")!)).toBe("평균 구매가를 추정한 매도 1건이 합계에 들어 있어요.SOXL 1건 · 같은 날 사고판 순서를 몰라 추정했어요.");
    press(r, byLabel(r, "매도별 계산 보기"));
    expect(r.text()).toContain("환율 1,350.00원 · 추정 포함");
  });

  it("수익률: 전체(원화)에서 미국 평가 환율이 없으면 그 까닭 한 줄 (기간을 늘리라고 하지 않음)", () => {
    h.params = { tab: "returns" };
    h.returns = { enabled: true, ready: false, tradingDays: 0, recordDays: 30, needDays: 10, recordSince: "2026-09-28", market: "ALL", usFxMissing: true, actual: null };
    const r = draw();
    expect(r.all().find((n) => n.props.testID === "returns-not-ready")!.props.accessibilityLabel).toBe("미국 계좌 기록에 평가 환율이 없어 전체(원화) 수익률을 계산할 수 없어요. 한국·미국은 따로 볼 수 있어요.");
  });
});

describe("검토 반영 10차 — 확인이 필요한 매도 (그해 주문 내역으로 설명되지 않는 변화가 있던 종목)", () => {
  const R = "그해 이 종목에 주문 내역으로 설명되지 않는 변화가 있어 이 매도의 손익을 계산하지 않았어요.";
  const EXCL = item({
    key: "3:s1:0",
    orderId: "s1",
    code: "005930",
    name: "삼성전자",
    currency: "KRW",
    market: "KR",
    at: "2026-09-24T10:00:00+09:00",
    realized: { ...realized(0, 0)!, status: "unexplained", reason: R, change: "9월 24일 기록: 수량 10 → 35주 · 기록된 매매대로라면 5주", guess: "1→4 분할로 보여요(추정)", gross: null, rate: null, avgCost: null, costAmount: null, krw: null },
  });
  const CHG: JournalItem = {
    ...SELL,
    key: "chg:3:005930:2026-09-24T16:05:00+09:00",
    kind: "change",
    orderId: null,
    side: null,
    code: "005930",
    name: "삼성전자",
    quantity: 30,
    realized: null,
    note: null,
    timeBasis: "seen",
    at: "2026-09-24T16:05:00+09:00",
    change: { kind: "unexplained", text: "수량 10 → 35주 · 기록된 매매대로라면 5주", guess: "1→4 분할로 보여요(추정)", qty: 30 },
  };
  const withExcl = (): JournalResponse => ({
    ...LIST,
    summary: {
      ...LIST.summary!,
      sells: 2,
      excludedSells: [{ key: "3:s1:0", code: "005930", name: "삼성전자", date: "2026-09-24", quantity: 5, currency: "KRW", reason: R, change: "9월 24일 기록: 수량 10 → 35주 · 기록된 매매대로라면 5주", guess: "1→4 분할로 보여요(추정)" }],
    },
    days: [LIST.days[0]!, { date: "2026-09-24", realized: { KRW: null, USD: null, krwTotal: null, krwTotalEstimated: false }, items: [CHG, EXCL] }, LIST.days[1]!],
  });

  it("요약 카드 아래 '확인이 필요한 매도 1건' 상자(그해 있었던 일·이름표·토스증권 앱 안내) · 줄 오른쪽 '확인 필요' · 기록과 다름 줄(누를 수 없음, 제목은 잘리지 않게 줄바꿈)", () => {
    h.journal = withExcl();
    h.win = { width: 360, height: 752, scale: 3, fontScale: 2 };
    const r = draw();
    expect(textOf(r.all().find((n) => n.props.testID === "journal-excluded")!)).toBe(
      "확인이 필요한 매도 1건9/24 삼성전자 5주 · 9월 24일 기록: 수량 10 → 35주 · 기록된 매매대로라면 5주 · 1→4 분할로 보여요(추정)그해 주문 내역으로 설명되지 않는 변화(분할·병합·무상증자·입고·출고·분사·큰 주가 변화 등)가 있던 종목의 그해 매도라 위 실현손익 합계에 넣지 않았어요. 실제 손익은 토스증권 앱의 거래 내역에서 확인해 주세요.",
    );
    expect(r.text()).toContain("확인 필요");
    const title = r.all().find((n) => n.type === "Text" && n.children.join("") === "[기록과 다름] 삼성전자")!;
    expect(title.props.numberOfLines).toBeUndefined();
    expect(r.text()).toContain("그해 이 종목의 매도 손익과 이 종목이 든 기간의 수익률은 계산하지 않았어요.");
    expect(r.all().some((n) => n.props.testID === `trade-${CHG.key}`)).toBe(false);
  });

  it("확인이 필요한 매도를 누르면 상세: 실현손익 '확인 필요' + 까닭·그해 있었던 일·토스증권 앱 안내 (숫자 없음)", () => {
    h.journal = withExcl();
    const r = draw();
    press(r, r.all().find((n) => n.props.testID === "trade-3:s1:0")!);
    const t = r.text();
    expect(t).toContain("확인 필요");
    expect(t).toContain("그해 있었던 일: 9월 24일 기록: 수량 10 → 35주 · 기록된 매매대로라면 5주");
    expect(t).toContain(lib.JOURNAL.excludedToss);
    expect(t).not.toContain("= 실현손익");
  });

  it("수익률: 건너뛴 날을 큰 숫자 아래 한 줄로 · 모두 건너뛰면 숫자 대신 안내", () => {
    h.params = { tab: "returns" };
    h.returns = { enabled: true, ready: true, tradingDays: 10, recordDays: 10, needDays: 10, recordSince: "2026-09-28", actual: { from: "2026-09-28", to: "2026-10-12" }, market: "KR", currency: "KRW", twr: 1, pnl: 1000, startValue: 100_000, endValue: 101_000, buys: 0, sells: 0, gaps: [], doubtedSkipped: [], uncertainSkipped: ["2026-10-07"], priceBasis: { regularClose: 1, priceFallback: 0, fallbackCodes: [] }, series: [] } as JournalReturns;
    let r = draw();
    expect(textOf(r.all().find((n) => n.props.testID === "returns-ready")!)).toContain("확인이 필요한 종목이 든 1일(10/7)은 수익률·기간 손익에서 뺐어요.");
    h.returns = { enabled: true, ready: false, allSkipped: true, uncertainSkipped: ["2026-10-07"], tradingDays: 3, recordDays: 20, needDays: 10, recordSince: "2026-09-28", actual: { from: "2026-10-06", to: "2026-10-08" } } as JournalReturns;
    r = draw();
    expect(r.all().find((n) => n.props.testID === "returns-not-ready")!.props.accessibilityLabel).toContain("모두 확인이 필요한 종목이 든 기간이라");
  });

  it("양도세: '확인이 필요한 매도' 상자 — 매도마다 한 줄(판매 금액·그해 있었던 일·이름표) + 토스증권 앱 안내", () => {
    h.params = { tab: "tax" };
    h.flags = TAX_ON;
    h.tax = {
      enabled: true,
      year: 2026,
      years: [2026],
      totals: { gains: 0, losses: 0, net: 0, base: 0, nationalTax: 0, localTax: 0, tax: 0, sells: 0 },
      complete: false,
      fxPending: 0,
      excluded: [{ code: "SOXL", name: "SOXL", count: 1, reason: "그해 이 종목에 주문 내역으로 설명되지 않는 변화가 있어 확인이 필요한 매도라 계산하지 않았어요" }],
      items: [],
      unexplainedSells: [{ key: "3:x1:0", code: "SOXL", name: "SOXL", tradeDate: "2026-09-28", settleDate: "2026-09-30", quantity: 4000, proceedsUsd: 100_000, reason: R, change: "9월 28일 기록: 기록된 매도가 그때 가진 수량보다 많았어요 · 수량 1,000 → 0주", guess: "1→4 분할로 보여요(추정)" }],
      kr: { securitiesTax: { amount: null, sells: 0, source: null } },
    } as JournalTax;
    const r = draw();
    expect(textOf(r.all().find((n) => n.props.testID === "tax-unexplained")!)).toBe(
      "확인이 필요한 매도9/28 SOXL 4,000주 · 판매 금액 $100,000.00 · 9월 28일 기록: 기록된 매도가 그때 가진 수량보다 많았어요 · 수량 1,000 → 0주 · 1→4 분할로 보여요(추정)그해 주문 내역으로 설명되지 않는 변화가 있던 종목의 매도라 위 합계에 넣지 않았어요. 실제 양도차익은 토스증권 앱에서 확인해 주세요.",
    );
  });
});
