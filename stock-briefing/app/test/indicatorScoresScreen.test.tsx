import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndicatorScores, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 종목 상세 '지표 점수' (3-44 1단계, 기능 플래그 indicatorScores — 앱 fallback 꺼짐).
 *  - 꺼져 있으면 서버에 묻지도 않고 탭 내용이 지금 그대로 (지금 화면 스냅숏은 stockDetailFold 테스트가 본다)
 *  - 켜지면 기업개요 탭 맨 위 요약 카드 + 'AI 기업개요 [AI가 쓴 글]', 기술분석 탭 맨 위 추세 상세 카드 + 'AI 기술분석 [AI가 쓴 글]'
 *  - 접은 화면(475×751)·펼친 가로(933×704 좌우 배치)·펼친 세로(704×933 한 단)·울트라 펼침 세로(윗줄+아랫줄), 글자 100·130%
 * 서버 응답은 공용 픽스처(shared/fixtures/indicatorScores.json — 서버 테스트가 지금 서버 코드의 응답과 같은지 본다)
 */
const FX = JSON.parse(readFileSync(new URL("../../shared/fixtures/indicatorScores.json", import.meta.url), "utf8")) as { cases: Record<string, IndicatorScores> };

const h = vi.hoisted(() => ({
  win: { width: 475, height: 751, scale: 2.625, fontScale: 1 },
  flags: {} as Record<string, boolean>,
  params: { code: "NVDA" } as Record<string, string | undefined>,
  stock: undefined as unknown,
  scores: undefined as unknown,
  scoresError: false,
  scoreCalls: [] as Array<[string, boolean]>,
  push: vi.fn(),
  setParams: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  RefreshControl: "RefreshControl",
  Alert: { alert: () => undefined },
  Linking: { openURL: async () => undefined },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 32, bottom: 48, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({
  Stack: { Screen: "StackScreen" },
  router: { back: vi.fn(), dismissTo: vi.fn(), push: h.push, replace: vi.fn(), setParams: h.setParams, canGoBack: () => true },
  useLocalSearchParams: () => h.params,
  usePathname: () => "/stocks/NVDA",
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: (cap = Infinity) => Math.min(Math.max(h.win.fontScale || 1, 1), cap) };
});
const idle = { data: undefined, isLoading: false, isError: false, error: null, refetch: async () => undefined };
vi.mock("@/api/hooks", () => ({
  useStock: () => ({ ...idle, data: h.stock }),
  useCandles: () => idle,
  useBriefings: () => ({ ...idle, data: [] }),
  useAnalysis: () => ({ ...idle, isLoading: true }),
  useStockNews: () => ({ ...idle, data: { code: "NVDA", name: "엔비디아", news: [], newsError: null, disclosures: [], disclosuresError: null } }),
  useAnyMarketOpen: () => ({ open: false, fresh: false }),
  useStockMutations: () => ({ register: { mutate: vi.fn() }, remove: { mutate: vi.fn() }, refreshAnalysis: { mutate: vi.fn(), isPending: false, isError: false, error: null } }),
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useApi: () => ({ listStocks: async () => [] }),
  useIndicatorScores: (code: string, enabled: boolean) => {
    h.scoreCalls.push([code, enabled]);
    return { ...idle, data: h.scores, isError: h.scoresError };
  },
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ showKrw: false, afterCost: false, sort: "created", apiUrl: "http://x" }) }));
vi.mock("@/lib/holdingsNav", async (orig) => ({ ...(await orig<typeof import("@/lib/holdingsNav")>()), useHoldingsNav: () => null, useCachedRow: () => null }));
vi.mock("@/lib/chartPrefs", () => ({ CANDLE_COUNT: { D: 800, W: 520, M: 240 }, parseCandlePeriod: () => "D" }));
vi.mock("@/components/BriefingCard", () => ({ BriefingCard: "BriefingCard" }));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice", StaleBanner: "StaleBanner", usePull: () => ({ pulling: false, onPull: () => undefined }), useFeedState: () => ({ now: Date.parse("2026-09-28T01:00:00Z"), feedOk: true }) }));
vi.mock("@/components/Skeleton", () => ({ DetailSkeleton: "DetailSkeleton" }));
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen", Disclaimer: "Disclaimer" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge",
  Button: "Button",
  Card: "Card",
  ErrorView: "ErrorView",
  LiveDot: "LiveDot",
  Loading: "Loading",
  Muted: "Muted",
  SectionTitle: "SectionTitle",
  Segmented: "Segmented",
  Stat: "Stat",
  StatGrid: "StatGrid",
}));

const { default: StockDetailScreen } = await import("@/app/stocks/[code]/index");
const { forgetWindowClass } = await import("@/lib/useFoldLayout");
const { light, scores } = await import("@/tokens");
const { DISCLAIMER } = await import("@/lib/disclaimer");

const nvdaStock = () => ({ ...holding("NVDA", quote("NVDA", 178.2, { currency: "USD", change: 3.05, changeRate: 1.74, fxRate: 1391.5 }), 40, 120, {}, "엔비디아"), market: "NASDAQ" as const, registered: true });
const soxlStock = () => ({ ...holding("SOXL", quote("SOXL", 151.45, { currency: "USD", change: 2.2, changeRate: 1.47, fxRate: 1391.5 }), 30, 40, {}, "SOXL"), market: "AMEX" as const, registered: true });

function open(stock: RegisteredWithQuote, scoresCase: string | null, extra: { flag?: boolean; tab?: string; size?: [number, number]; fontScale?: number } = {}) {
  h.stock = stock;
  h.scores = scoresCase ? FX.cases[scoresCase] : undefined;
  h.flags = { indicatorScores: extra.flag ?? true, foldLayout: true };
  h.params = { code: stock.code, ...(extra.tab ? { tab: extra.tab } : {}) };
  const [width, height] = extra.size ?? [475, 751];
  h.win = { width, height, scale: 2.625, fontScale: extra.fontScale ?? 1 };
  return render(<StockDetailScreen />);
}

const segmented = (r: ReturnType<typeof render>) => r.all().filter((n) => n.type === "Segmented");
const textOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
/** 글자가 나오는 순서 */
const order = (r: ReturnType<typeof render>, ...needles: string[]) => needles.map((s) => r.text().indexOf(s));

beforeEach(() => {
  h.scoreCalls.length = 0;
  h.scoresError = false;
  h.push.mockReset();
  h.setParams.mockReset();
  forgetWindowClass();
});

describe("플래그 꺼짐", () => {
  it("서버에 묻지 않고(카드를 그리지 않음) 'AI 기업개요' 제목도 없다", () => {
    const r = open(nvdaStock(), "NVDA", { flag: false });
    expect(h.scoreCalls).toEqual([]);
    expect(r.text()).not.toContain("지표 점수");
    expect(r.text()).not.toContain("AI가 쓴 글");
    expect(r.all().some((n) => n.type === "Loading")).toBe(true); // AI 기업개요 탭 그대로
  });
});

describe("접은 화면 475×751 — 기업개요 탭 요약 카드", () => {
  it("NVDA: 지표 점수 · 가치 계산 준비 중 · 추세 69 다소 강함 · 날짜 · 예측 아님 · 펼침 · 고지 → 그 아래 AI 기업개요 [AI가 쓴 글]", () => {
    const r = open(nvdaStock(), "NVDA");
    expect(h.scoreCalls[0]).toEqual(["NVDA", true]);
    const s = FX.cases["NVDA"]!;
    const text = r.text();
    for (const need of ["지표 점수", "계산식 결과 · AI 글 아님", "가치 지표", "계산 준비 중", "추세 지표", "69", "다소 강함", s.trend.meaning!, "가격 9월 25일(금) 미국 종가", "점수는 과거·현재 숫자의 요약이며, 앞으로의 가격을 알려 주지 않습니다.", "구성·계산 방법 보기", "참고 정보이며 투자 권유가 아닙니다", "AI 기업개요", "AI가 쓴 글"])
      expect(text, need).toContain(need);
    // 종합: 없으면 없다고 (두 점수 아래 작게, 설계 5.4 · 목업 1)
    expect(text).toContain("종합 지표");
    expect(text).toContain("가치 지표 점수가 없어 합치지 않습니다");
    expect(order(r, "추세 지표", "종합 지표", "가격 9월 25일")).toEqual([...order(r, "추세 지표", "종합 지표", "가격 9월 25일")].sort((a, b) => a - b));
    const pos = order(r, "지표 점수", "추세 지표", "가격 9월 25일", "구성·계산 방법 보기", "참고 정보이며", "AI 기업개요");
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(pos.every((p) => p >= 0)).toBe(true);
    // 카드가 AI 분석(불러오는 중)보다 위
    const all = r.all();
    expect(all.findIndex((n) => n.type === "Card")).toBeLessThan(all.findIndex((n) => n.type === "Loading"));
    // 화면 읽기: 요약 한 문장, 추세 숫자는 '추세 지표 69점, 다소 강함'
    expect(r.has("지표 점수. 가치 지표, 계산 준비 중. 추세 지표 69점, 다소 강함. 종합 지표 없음, 가치 지표 점수가 없어 합치지 않습니다.")).toBe(true);
    expect(r.has("추세 지표 69점, 다소 강함")).toBe(true);
    expect(r.has("AI 기업개요, AI가 쓴 글")).toBe(true);
  });

  it("막대는 회색 한 가지 (채움 t.sub · 바탕 t.lineStrong · 50 눈금 t.muted), 채움 폭 = 점수 %", () => {
    const r = open(nvdaStock(), "NVDA");
    const fills = r.all().filter((n) => flat(n).height === scores.barH && typeof flat(n).width === "string");
    expect(fills.map((n) => [flat(n).width, flat(n).backgroundColor])).toEqual([["69%", light.sub]]);
    const colors = new Set(r.all().filter((n) => flat(n).height === scores.barH || flat(n).height === scores.tickH).map((n) => flat(n).backgroundColor).filter(Boolean));
    expect([...colors].sort()).toEqual([light.lineStrong, light.muted, light.sub].sort());
    for (const c of [light.up, light.down, light.accent, light.live]) expect(colors.has(c)).toBe(false);
  });

  it("펼치면 추세 묶음 5개(비중·막대·점수)와 계산 방법·계산 방식 줄, '기술분석 탭에서 항목별 사실 보기' → 기술분석 탭의 상세 카드", () => {
    const r = open(nvdaStock(), "NVDA");
    expect(r.text()).not.toContain("추세 지표 구성");
    r.act(() => (r.byLabel("구성·계산 방법 보기").props.onPress as () => void)());
    const text = r.text();
    expect(text).toContain("추세 지표 구성 · 묶음 비중");
    expect(r.has("추세 69점, 비중 35")).toBe(true);
    expect(r.has("거래량 뒷받침 54점, 비중 10")).toBe(true);
    for (const line of FX.cases["NVDA"]!.text.how) expect(text).toContain(line);
    expect(text).toContain("계산 방식 TREND-1 (보정 TREND-CAL-1) · 일봉 야후 · 비교 지수 나스닥(네이버)");
    expect(r.byLabel("구성·계산 방법 접기").props.accessibilityState).toEqual({ expanded: true });
    r.act(() => (r.byLabel("기술분석 탭에서 항목별 사실 보기").props.onPress as () => void)());
    expect(segmented(r)[0]!.props.value).toBe("technical");
    const t2 = r.text();
    expect(t2).toContain("추세 지표 점수 69/100 · 다소 강함");
    // 상세 카드 머리: 화면 읽기는 '69/100' 대신 '추세 지표 69점, 다소 강함'
    expect(r.all().some((n) => n.props.accessibilityRole === "header" && n.props.accessibilityLabel === "추세 지표 69점, 다소 강함" && textOf(n) === "추세 지표 점수 69/100 · 다소 강함")).toBe(true);
    expect(t2).toContain("주가가 200일 이동평균선보다 12.8% 위, 50일선보다 4.2% 위에 있습니다.");
    expect(t2).toContain(DISCLAIMER);
    expect(t2).toContain("과거 가격·거래량으로 계산한 지표이며 앞으로의 가격이나 수익을 뜻하지 않습니다.");
    expect(r.has("AI 기술분석, AI가 쓴 글")).toBe(true);
  });

  it("글자 130%: 이름·숫자 / 막대·띠 두 줄 (설계 4.3), 점수 없는 줄은 이름 / 상태 글 두 줄", () => {
    const rowWith = (r: ReturnType<typeof render>, label: string) => r.all().find((n) => flat(n).flexDirection === "row" && n.children.some((c) => typeof c !== "string" && textOf(c) === label))!;
    const hasBar = (n: HostNode) => n.children.some((c) => typeof c !== "string" && c.props.importantForAccessibility === "no-hide-descendants");
    expect(hasBar(rowWith(open(nvdaStock(), "NVDA"), "추세 지표"))).toBe(true);
    const big = open(nvdaStock(), "NVDA", { fontScale: 1.3 });
    const row = rowWith(big, "추세 지표");
    expect(hasBar(row)).toBe(false);
    expect(textOf(row)).toContain("69");
    expect(textOf(row)).not.toContain("다소 강함");
    // 둘째 줄: 막대 + 띠
    const barRow = big.all().find((n) => flat(n).flexDirection === "row" && hasBar(n))!;
    expect(textOf(barRow)).toBe("다소 강함");
    // 가치 지표 줄: '가치 지표' 와 '계산 준비 중' 이 한 줄(row)에 붙지 않는다
    const nameNode = big.all().find((n) => n.type === "Text" && textOf(n) === "가치 지표")!;
    const parent = big.all().find((n) => n.children.includes(nameNode))!;
    expect(flat(parent).flexDirection).not.toBe("row");
    expect(parent.children.map((c) => (typeof c === "string" ? c : textOf(c)))).toEqual(["가치 지표", "계산 준비 중"]);
    // 100% 는 이름 칸 옆에 상태 글 (한 줄)
    const small = open(nvdaStock(), "NVDA");
    const n1 = small.all().find((n) => n.type === "Text" && textOf(n) === "가치 지표")!;
    expect(flat(small.all().find((n) => n.children.includes(n1))!).flexDirection).toBe("row");
  });

  it("못 받으면 '지표 점수를 불러오지 못했습니다' + 다시 시도, 404(꺼짐·예전 서버)면 카드 없이 AI 글만", () => {
    h.scoresError = true;
    const r = open(nvdaStock(), null);
    expect(r.text()).toContain("지표 점수를 불러오지 못했습니다");
    expect(r.all().some((n) => n.type === "Button" && n.props.accessibilityLabel === "지표 점수 다시 불러오기")).toBe(true);
    h.scoresError = false;
    h.stock = nvdaStock();
    const none = open(nvdaStock(), null);
    h.scores = null;
    none.rerender();
    expect(none.text()).not.toContain("지표 점수");
  });
});

describe("레버리지 ETF (SOXL)", () => {
  it("가치 대상 아님 · 이 상품 자체 점수 없음 · 참고 줄[기초자산 기준] · 레버리지 주의 상자(수익률만 등락 색) · 기초자산 화면 보기", () => {
    const r = open(soxlStock(), "SOXL");
    const text = r.text();
    for (const need of ["대상 아님", "ETF는 여러 종목을 묶은 상품이라", "이 상품 자체 점수 없음", "참고: 기초자산 SOXX 추세 지표 73 · 강함", "기초자산 기준", "매일 3배를 다시 맞추는 상품이라", "SOXX는 같은 NYSE 반도체 지수를 1배로 따르는 ETF입니다.", "레버리지 상품 주의 · 계산한 사실", "−29.8%", "−2.9%", "−8.8%", "69.4%", "53.8%"])
      expect(text, need).toContain(need);
    expect(r.all().some((n) => n.type === "Badge" && textOf(n) === "기초자산 기준")).toBe(true);
    expect(text).toContain("가치 지표 점수가 없어 합치지 않습니다"); // 종합 없음 (목업 2)
    // 사실 상자 화면 읽기: 마침표가 겹치지 않는다
    const box = r.all().find((n) => typeof n.props.accessibilityLabel === "string" && (n.props.accessibilityLabel as string).startsWith("레버리지 상품 주의"))!;
    expect(box.props.accessibilityLabel as string).not.toMatch(/\.\./);
    // 수익률 세 숫자만 하락 파랑, 나머지 글은 기본 글자색
    const colored = r.all().filter((n) => n.type === "Text" && flat(n).color === light.down).map(textOf);
    expect(colored).toEqual(["−29.8%", "−2.9%", "−8.8%"]);
    // 막대 없음 (이 상품 점수가 없으니)
    expect(r.all().some((n) => n.props.importantForAccessibility === "no-hide-descendants")).toBe(false);
    r.act(() => (r.byLabel("기초자산 SOXX 화면 보기").props.onPress as () => void)());
    expect(h.push).toHaveBeenCalledWith({ pathname: "/stocks/[code]", params: { code: "SOXX" } });
  });

  it("기초자산 일봉을 받지 못했을 때(받기 실패): '기초자산을 확인하지 못함'이 아니라 '… 받지 못했습니다. 잠시 뒤 다시 계산합니다', 참고 줄·화면 보기 없이 상품 자체 사실만", () => {
    const r = open(soxlStock(), "SOXL_fetchFailed");
    const text = r.text();
    expect(text).toContain("이 상품 자체 점수 없음");
    expect(text).toContain("기초자산 SOXX 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다");
    expect(text).not.toContain("기초자산을 확인하지 못해");
    expect(text).not.toContain("기초자산 기준");
    expect(r.all().some((n) => n.props.accessibilityLabel === "기초자산 SOXX 화면 보기")).toBe(false);
    expect(text).toContain("이 상품은 NYSE 반도체 지수 하루 움직임의 3배를 따라가도록 만든 상품입니다.");
    expect(text).toContain("−29.8%");
  });

  it("기술분석 탭: 묶음 없이 상태·참고 줄·사실 상자·고지", () => {
    const r = open(soxlStock(), "SOXL", { tab: "technical" });
    segmented(r)[0] && r.act(() => (segmented(r)[0]!.props.onChange as (v: string) => void)("technical"));
    const text = r.text();
    expect(text).toContain("추세 지표 점수");
    expect(text).toContain("이 상품 자체 점수 없음");
    expect(text).toContain("레버리지 상품 주의 · 계산한 사실");
    expect(text).not.toContain("주가가 200일");
    expect(text).toContain(DISCLAIMER);
  });
});

describe("받기 실패 (보통 종목)", () => {
  it("NVDA 비교 지수를 받지 못했을 때: 점수·막대 없이 '점수 없음' + 이유 (지수 대비 항목을 뺀 다른 점수를 보이지 않음)", () => {
    const r = open(nvdaStock(), "NVDA_fetchFailed");
    const text = r.text();
    expect(text).toContain("점수 없음");
    expect(text).toContain("비교 지수(나스닥) 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다");
    expect(r.all().some((n) => n.props.importantForAccessibility === "no-hide-descendants")).toBe(false);
    expect(text).toContain("두 점수가 모두 없습니다");
  });
});

describe("넓은 창", () => {
  it("펼친 가로 933×704 (좌우 배치): 오른쪽 칸 탭 '기업개요'에서 요약 카드, 한 칸 (가치·추세 위아래)", () => {
    const r = open(nvdaStock(), "NVDA", { size: [933, 704], tab: "company" });
    expect(segmented(r)[0]!.props.value).toBe("company");
    expect(r.text()).toContain("추세 지표");
    expect(r.all().some((n) => flat(n).flexDirection === "row" && flat(n).gap === 20)).toBe(false);
    // 브리핑 탭(기본)에서는 카드가 없다 — 점수를 첫 화면 앞으로 끌어오지 않는다
    const first = open(nvdaStock(), "NVDA", { size: [933, 704] });
    expect(segmented(first)[0]!.props.value).toBe("briefing");
    expect(first.text()).not.toContain("지표 점수");
    // 넓은 창 탭 이름에 맞춘 이동 줄
    r.act(() => (r.byLabel("구성·계산 방법 보기").props.onPress as () => void)());
    expect(r.has("기술 탭에서 항목별 사실 보기")).toBe(true);
  });

  it("펼친 세로 704×933 (한 단): 가치 · 추세를 두 칸으로 나란히", () => {
    const r = open(nvdaStock(), "NVDA", { size: [704, 933], tab: "company" });
    const two = r.all().find((n) => flat(n).flexDirection === "row" && n.children.length === 2 && n.children.every((c) => typeof c !== "string" && flat(c).flex === 1));
    expect(two).toBeDefined();
    expect(textOf(two!)).toContain("가치 지표");
    expect(textOf(two!)).toContain("추세 지표");
  });

  it("울트라 펼침 세로 859×954 (윗줄+아랫줄): 오른쪽 칸 'AI 기업개요' 미리보기 바로 위에 요약 카드(테두리 없이)", () => {
    const r = open(nvdaStock(), "NVDA", { size: [859, 954] });
    const pos = order(r, "지표 점수", "AI 기업개요");
    expect(pos[0]).toBeGreaterThanOrEqual(0);
    expect(pos[0]).toBeLessThan(pos[1]!);
  });
});
