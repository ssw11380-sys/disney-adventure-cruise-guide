import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndicatorScores, RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 종목 상세 '지표 점수' (3-44 1·2단계, 기능 플래그 indicatorScores — 앱 fallback 꺼짐. 가치·종합은 서버 플래그 valueScore).
 *  - 꺼져 있으면 서버에 묻지도 않고 탭 내용이 지금 그대로 (지금 화면 스냅숏은 stockDetailFold 테스트가 본다)
 *  - 켜지면 기업개요 탭 맨 위 요약 카드 + 'AI 기업개요 [AI가 쓴 글]', 가치분석 탭 맨 위 가치 상세 카드 + 'AI 가치분석 [AI가 쓴 글]',
 *    기술분석 탭 맨 위 추세 상세 카드 + 'AI 기술분석 [AI가 쓴 글]'
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
const { metricSpeech } = await import("@/lib/scoreView");
const NV = FX.cases["NVDA"]!.value;

const nvdaStock = () => ({ ...holding("NVDA", quote("NVDA", 178.2, { currency: "USD", change: 3.05, changeRate: 1.74, fxRate: 1391.5 }), 40, 120, {}, "엔비디아"), market: "NASDAQ" as const, registered: true });
const soxlStock = () => ({ ...holding("SOXL", quote("SOXL", 151.45, { currency: "USD", change: 2.2, changeRate: 1.47, fxRate: 1391.5 }), 30, 40, {}, "SOXL"), market: "AMEX" as const, registered: true });

function open(stock: RegisteredWithQuote, scoresCase: string | null, extra: { flag?: boolean; valueFlag?: boolean; tab?: string; size?: [number, number]; fontScale?: number } = {}) {
  h.stock = stock;
  h.scores = scoresCase ? FX.cases[scoresCase] : undefined;
  // 서버 /api/features 가 주는 두 플래그 (가치 끔 픽스처는 valueScore 도 꺼진 서버)
  h.flags = { indicatorScores: extra.flag ?? true, valueScore: extra.valueFlag ?? scoresCase !== "NVDA_valueOff", foldLayout: true };
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
  it("NVDA: 지표 점수 · 가치 67 높은 편 · 추세 69 다소 강함 · 종합 68(두 점수의 평균, 작게) · 날짜(가격·재무) · 예측 아님 · 펼침 · 고지 → 그 아래 AI 기업개요 [AI가 쓴 글]", () => {
    const r = open(nvdaStock(), "NVDA");
    expect(h.scoreCalls[0]).toEqual(["NVDA", true]);
    const s = FX.cases["NVDA"]!;
    const text = r.text();
    for (const need of ["지표 점수", "계산식 결과 · AI 글 아님", "가치 지표", "67", "높은 편", s.value.text, "추세 지표", "69", "다소 강함", s.trend.meaning!, "가격 9월 25일(금) 미국 종가 · 재무 2026년 7월까지 4분기", "점수는 과거·현재 숫자의 요약이며, 앞으로의 가격을 알려 주지 않습니다.", "구성·계산 방법 보기", "참고 정보이며 투자 권유가 아닙니다", "AI 기업개요", "AI가 쓴 글"])
      expect(text, need).toContain(need);
    // 종합: 두 점수 아래 작게 (띠 이름 없이 '두 점수의 평균')
    expect(text).toContain("종합 지표68두 점수의 평균");
    expect(text).not.toContain("계산 준비 중");
    const pos = order(r, "지표 점수", "가치 지표", "추세 지표", "종합 지표", "가격 9월 25일", "구성·계산 방법 보기", "참고 정보이며", "AI 기업개요");
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(pos.every((p) => p >= 0)).toBe(true);
    // 요약 카드에는 지난주 대비 변화 표시가 없다 (상세 카드만)
    expect(text).not.toContain("지난주");
    // 카드가 AI 분석(불러오는 중)보다 위
    const all = r.all();
    expect(all.findIndex((n) => n.type === "Card")).toBeLessThan(all.findIndex((n) => n.type === "Loading"));
    // 화면 읽기: 요약 한 문장 (설계 5.7-F), 숫자마다 '가치 지표 66점, 0에서 100 중, 가운데쯤' · '추세 지표 69점, 다소 강함'
    expect(r.has("지표 점수. 가치 지표 67점, 0에서 100 중, 높은 편. 추세 지표 69점, 다소 강함. 종합 지표 68점, 두 점수의 평균.")).toBe(true);
    expect(r.has("가치 지표 67점, 0에서 100 중, 높은 편")).toBe(true);
    // 새 앱은 score·band 를 쓰고 label('67점 · 높은 편' — 예전 앱용)은 보이지 않는다
    expect(text).not.toContain(s.value.label);
    expect(r.has("추세 지표 69점, 다소 강함")).toBe(true);
    expect(r.has("AI 기업개요, AI가 쓴 글")).toBe(true);
  });

  it("가치 플래그를 끈 서버(1단계와 같은 응답): 가치 '계산 준비 중 · 지금 계산하지 않습니다', 종합 '없음 · 가치 지표 점수가 없어 합치지 않습니다', 가치분석 탭 이동 줄 없음", () => {
    const r = open(nvdaStock(), "NVDA_valueOff");
    const text = r.text();
    expect(text).toContain("계산 준비 중");
    expect(text).toContain("가치 지표 점수는 지금 계산하지 않습니다.");
    expect(text).not.toContain("다음 단계");
    expect(text).toContain("가치 지표 점수가 없어 합치지 않습니다");
    expect(r.has("지표 점수. 가치 지표, 계산 준비 중. 추세 지표 69점, 다소 강함. 종합 지표 없음, 가치 지표 점수가 없어 합치지 않습니다.")).toBe(true);
    r.act(() => (r.byLabel("구성·계산 방법 보기").props.onPress as () => void)());
    expect(r.text()).not.toContain("가치분석 탭에서 지표별 값 보기");
    expect(r.text()).not.toContain("재무 SEC");
  });

  it("두 점수 차이가 30 이상이면 종합 아래 안내 한 줄 (예시 종목)", () => {
    const r = open({ ...nvdaStock(), code: "ZZGAP", name: "예시 종목" }, "ZZGAP");
    const text = r.text();
    expect(text).toContain("종합 지표50두 점수의 평균");
    expect(text).toContain("두 점수의 차이가 39점이라 평균만으로는 상태가 잘 드러나지 않습니다. 두 점수를 함께 보세요.");
    expect(order(r, "종합 지표", "두 점수의 차이가", "가격 9월 25일").every((p, i, a) => i === 0 || p > a[i - 1]!)).toBe(true);
  });

  it("한국 종목·SEC 재무 없음·받는 중: 가치 줄은 상태 글과 이유 (0점·50점으로 채우지 않음)", () => {
    const kr = open({ ...nvdaStock(), code: "005930", name: "삼성전자", market: "KOSPI" as const }, "005930");
    expect(kr.text()).toContain("계산 준비 중");
    expect(kr.text()).toContain("한국 종목 가치 지표 점수는 다음 단계에서 계산합니다.");
    const nof = open({ ...nvdaStock(), code: "ZZNOF", name: "예시 종목" }, "ZZNOF");
    expect(nof.text()).toContain("점수 없음");
    expect(nof.text()).toContain("SEC 재무제표를 찾지 못했습니다");
    const pend = open({ ...nvdaStock(), code: "ZZNOF", name: "예시 종목" }, "ZZNOF_pending");
    expect(pend.text()).toContain("계산 준비 중 — 재무제표를 처음 받는 중입니다 (보통 몇 분 안)");
    // 가치 막대는 점수가 있을 때만 (추세 막대 하나)
    expect(pend.all().filter((n) => flat(n).height === scores.barH && typeof flat(n).width === "string")).toHaveLength(1);
  });

  it("막대는 회색 한 가지 (채움 t.sub · 바탕 t.lineStrong · 50 눈금 t.muted), 채움 폭 = 점수 %", () => {
    const r = open(nvdaStock(), "NVDA");
    const fills = r.all().filter((n) => flat(n).height === scores.barH && typeof flat(n).width === "string");
    // 가치 67 · 추세 69 두 막대 모두 같은 회색
    expect(fills.map((n) => [flat(n).width, flat(n).backgroundColor])).toEqual([
      ["67%", light.sub],
      ["69%", light.sub],
    ]);
    const colors = new Set(r.all().filter((n) => flat(n).height === scores.barH || flat(n).height === scores.tickH).map((n) => flat(n).backgroundColor).filter(Boolean));
    expect([...colors].sort()).toEqual([light.lineStrong, light.muted, light.sub].sort());
    for (const c of [light.up, light.down, light.accent, light.live]) expect(colors.has(c)).toBe(false);
  });

  it("펼치면 가치 묶음 5개(비중·막대·점수)·표시 최대 2개·'가치분석 탭에서 지표별 값 보기' → 가치분석 탭의 상세 카드", () => {
    const r = open(nvdaStock(), "NVDA");
    expect(r.text()).not.toContain("가치 지표 구성");
    r.act(() => (r.byLabel("구성·계산 방법 보기").props.onPress as () => void)());
    const text = r.text();
    const v = FX.cases["NVDA"]!.value;
    expect(text).toContain("가치 지표 구성 · 묶음 비중");
    for (const f of v.families!) expect(r.has(`${f.name} ${f.score}점, 비중 ${f.weight}`), f.name).toBe(true);
    for (const f of v.flags!.slice(0, 2)) expect(text).toContain(`표시 · ${f.text}`);
    expect(order(r, "가치 지표 구성", "추세 지표 구성", "이 점수는 어떻게 만들었나").every((p, i, a) => i === 0 || p > a[i - 1]!)).toBe(true);
    expect(text).toContain(v.versionLine!);
    r.act(() => (r.byLabel("가치분석 탭에서 지표별 값 보기").props.onPress as () => void)());
    expect(segmented(r)[0]!.props.value).toBe("value");
    expect(r.text()).toContain(`가치 지표 점수 ${v.score}/100 · ${v.band}`);
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
    const barRow = big.all().filter((n) => flat(n).flexDirection === "row" && hasBar(n)).at(-1)!;
    expect(textOf(barRow)).toBe("다소 강함");
    // 가치 점수 줄도 같은 두 줄 (이름·숫자 / 막대·띠)
    const vRow = rowWith(big, "가치 지표");
    expect(hasBar(vRow)).toBe(false);
    expect(textOf(vRow)).toContain("67");
    expect(big.all().filter((n) => flat(n).flexDirection === "row" && hasBar(n)).map(textOf)).toEqual(["높은 편", "다소 강함"]);
    // 점수 없는 가치 줄(가치 끔): '가치 지표' 와 '계산 준비 중' 이 한 줄(row)에 붙지 않는다
    const off = open(nvdaStock(), "NVDA_valueOff", { fontScale: 1.3 });
    const nameNode = off.all().find((n) => n.type === "Text" && textOf(n) === "가치 지표")!;
    const parent = off.all().find((n) => n.children.includes(nameNode))!;
    expect(flat(parent).flexDirection).not.toBe("row");
    expect(parent.children.map((c) => (typeof c === "string" ? c : textOf(c)))).toEqual(["가치 지표", "계산 준비 중"]);
    // 100% 는 이름 칸 옆에 상태 글 (한 줄)
    const small = open(nvdaStock(), "NVDA_valueOff");
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
  it("NVDA 비교 지수를 받지 못했을 때: 추세는 점수·막대 없이 '점수 없음' + 이유, 가치 점수는 그대로, 종합 '추세 지표 점수가 없어 합치지 않습니다'", () => {
    const r = open(nvdaStock(), "NVDA_fetchFailed");
    const text = r.text();
    expect(text).toContain("점수 없음");
    expect(text).toContain("비교 지수(나스닥) 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다");
    // 막대는 가치 줄 하나뿐
    const fills = r.all().filter((n) => flat(n).height === scores.barH && typeof flat(n).width === "string");
    expect(fills.map((n) => flat(n).width)).toEqual(["67%"]);
    expect(text).toContain("추세 지표 점수가 없어 합치지 않습니다");
  });
});

describe("가치분석 탭 — 가치 지표 상세 카드 (2단계)", () => {
  it("NVDA: 머리 '가치 지표 점수 67/100 · 높은 편'(화면 읽기 '가치 지표 67점, 0에서 100 중, 높은 편') · 비교 대상 · 날짜 · 시세 표와 다를 수 있음 · 5묶음 · 표시 · 고지 → AI 가치분석 [AI가 쓴 글]", () => {
    const r = open(nvdaStock(), "NVDA", { tab: "value" });
    const v = FX.cases["NVDA"]!.value;
    const text = r.text();
    for (const need of [v.headline!, v.peerLine!, v.datesLine!, v.priceNote!, ...v.families!.map((f) => f.text), ...v.flags!.map((f) => `표시 · ${f.text}`), "과거·현재 숫자로 계산한 지표이며 앞으로의 가격이나 수익을 뜻하지 않습니다.", DISCLAIMER, v.versionLine!, "AI 가치분석", "AI가 쓴 글"])
      expect(text, need).toContain(need);
    expect(r.all().some((n) => n.props.accessibilityRole === "header" && n.props.accessibilityLabel === "가치 지표 67점, 0에서 100 중, 높은 편" && textOf(n) === "가치 지표 점수 67/100 · 높은 편")).toBe(true);
    // 요약 카드에 없는 지난주 대비 줄은 이 종목(5점 넘게 바뀌지 않음)에는 없다
    expect(text).not.toContain("지난주");
    for (const f of v.families!) expect(r.has(`${f.name} ${f.score}점, 비중 ${f.weight}`)).toBe(true);
    // 지표 줄은 '지표별 값 보기'를 눌러야 보인다
    expect(text).not.toContain("업종 가운데값");
    const toggle = r.byLabel("지표별 값 보기");
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    r.act(() => (toggle.props.onPress as () => void)());
    const t2 = r.text();
    const a1 = v.families![0]!.metrics.find((m) => m.key === "A1")!;
    for (const need of [a1.name, a1.value!, a1.peerMedian!, a1.positions!, a1.mix!, `→ ${a1.text}`, a1.meaning, a1.note!]) expect(t2, need).toContain(need);
    // 화면 읽기: 지표 줄 하나가 보이는 글을 모두 담은 한 문장 (리뷰 — 예전에는 위치 문장·가운데값·비교별 위치가 빠졌다)
    expect(r.has(metricSpeech(a1))).toBe(true);
    expect(metricSpeech(a1)).toContain(a1.text.replace(/\.$/, ""));
    expect(metricSpeech(a1)).toContain(a1.peerMedian!);
    // 같은 값이 많은 지표 안내 (무배당 0% 사이의 0.1%) — 주주환원 머리 문장은 배당이 아닌 주식 수 변화
    const e1 = v.families![4]!.metrics.find((m) => m.key === "E1")!;
    expect(t2).toContain(e1.note!);
    expect(v.families![4]!.text).not.toContain("배당이 많은 편");
    // 쓰지 않는 지표(시장 70% 규칙)는 흐린 글자로 까닭만
    const b3 = r.all().find((n) => n.type === "Text" && textOf(n) === "비교할 회사 자료가 모자라(70% 미만) 이 지표는 쓰지 않았습니다.")!;
    expect(flat(b3).color).toBe(light.muted);
    // 가치 막대는 회색 한 가지 (묶음 5개)
    const fills = r.all().filter((n) => flat(n).height === scores.barH && typeof flat(n).width === "string");
    expect(new Set(fills.map((n) => flat(n).backgroundColor))).toEqual(new Set([light.sub]));
    expect(fills).toHaveLength(5);
    // 카드가 AI 가치분석보다 위
    expect(order(r, "가치 지표 점수", "AI 가치분석")[0]).toBeLessThan(order(r, "가치 지표 점수", "AI 가치분석")[1]!);
  });

  it("JPM (은행): 금융사 묶음·비중(35·30·10·15·10)과 금융사 안내", () => {
    const r = open({ ...nvdaStock(), code: "JPM", name: "JP모건 체이스", market: "NYSE" as const }, "JPM", { tab: "value" });
    const v = FX.cases["JPM"]!.value;
    expect(v.families!.map((f) => f.weight)).toEqual([35, 30, 10, 15, 10]);
    for (const f of v.families!) expect(r.has(`${f.name} ${f.score}점, 비중 ${f.weight}`)).toBe(true);
    expect(r.text()).toContain("금융사(은행·보험 등)는 매출·현금흐름·부채비율의 뜻이 달라 금융사끼리 비교하고");
  });

  it("점수가 없으면 상태 글과 이유만: SOXL 대상 아님 · 한국 계산 준비 중 · SEC 재무 없음", () => {
    const soxl = open(soxlStock(), "SOXL", { tab: "value" });
    expect(soxl.text()).toContain("대상 아님");
    expect(soxl.text()).toContain("ETF는 여러 종목을 묶은 상품이라");
    expect(soxl.text()).not.toContain("지표별 값 보기");
    const kr = open({ ...nvdaStock(), code: "005930", name: "삼성전자", market: "KOSPI" as const }, "005930", { tab: "value" });
    expect(kr.text()).toContain("한국 종목 가치 지표 점수는 다음 단계에서 계산합니다.");
    // 계산하지 않은 카드에는 SEC·Nasdaq 출처 줄이 없다 (리뷰: 한국·ETF 카드가 SEC 자료로 계산한 것처럼 읽히지 않게)
    for (const t of [soxl.text(), kr.text()]) expect(t).not.toContain("재무 SEC");
    const nof = open({ ...nvdaStock(), code: "ZZNOF", name: "예시 종목" }, "ZZNOF", { tab: "value" });
    expect(nof.text()).toContain("SEC 재무제표를 찾지 못했습니다");
    expect(nof.text()).toContain(DISCLAIMER);
  });

  it("플래그가 꺼져 있으면 가치분석 탭은 예전 그대로 (카드·'AI 가치분석' 제목 없음)", () => {
    const r = open(nvdaStock(), "NVDA", { flag: false, tab: "value" });
    expect(r.text()).not.toContain("가치 지표 점수");
    expect(r.text()).not.toContain("AI가 쓴 글");
  });

  it("되돌리기 스위치 valueScore 를 끄면 가치분석 탭도 1단계 그대로 (리뷰): 상태만 있는 카드·'AI 가치분석' 제목 없음, 서버에 묻지 않음", () => {
    const r = open(nvdaStock(), "NVDA_valueOff", { tab: "value" });
    expect(h.flags).toMatchObject({ indicatorScores: true, valueScore: false });
    const text = r.text();
    expect(text).not.toContain("가치 지표 점수");
    expect(text).not.toContain("계산 준비 중");
    expect(text).not.toContain("AI 가치분석");
    expect(text).not.toContain("AI가 쓴 글");
    expect(h.scoreCalls).toEqual([]);
    expect(r.all().some((n) => n.type === "Loading")).toBe(true); // AI 가치분석 글 자리 그대로
    // 넓은 창 '가치' 탭도 같다
    const wide = open(nvdaStock(), "NVDA_valueOff", { size: [933, 704], tab: "value" });
    expect(wide.text()).not.toContain("AI 가치분석");
  });

  it("지난주 대비 바뀐 이유 (가치, 5점 넘게 바뀐 때만 — 서버가 낸 NVDA_change): 날짜 줄 아래 한 줄, 화면 읽기 '지난주 대비: …', 요약 카드에는 없음", () => {
    const c = FX.cases["NVDA_change"]!.value.change!;
    expect(c).toMatchObject({ from: "2026-09-18", diff: -10, family: "price" });
    const r = open(nvdaStock(), "NVDA_change", { tab: "value" });
    const text = r.text();
    expect(text).toContain(c.text);
    expect(c.text).toBe("지난주 9월 18일(금)보다 점수가 10점 낮아졌습니다. 가장 크게 바뀐 묶음은 주가 수준(−33점)이고, 비교 기준(업종 분포)이 9월 26일(토)에 새로 만들어졌습니다.");
    expect(r.has(`지난주 대비: ${c.text}`)).toBe(true);
    expect(order(r, FX.cases["NVDA_change"]!.value.datesLine!, c.text, "주가 수준")).toEqual([...order(r, FX.cases["NVDA_change"]!.value.datesLine!, c.text, "주가 수준")].sort((a, b) => a - b));
    // 회색 세로선만 (좋음·나쁨 색 없음)
    const box = r.all().find((n) => n.props.accessibilityLabel === `지난주 대비: ${c.text}`)!;
    expect(flat(box).borderLeftColor).toBe(light.lineStrong);
    // 요약 카드(기업개요 탭)에는 변화 표시를 두지 않는다
    const summary = open(nvdaStock(), "NVDA_change");
    expect(summary.text()).not.toContain("지난주");
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
    expect(r.has("가치 탭에서 지표별 값 보기")).toBe(true);
    // 오른쪽 칸 '가치' 탭: 가치 상세 카드 + 'AI 가치분석 [AI가 쓴 글]'
    const v = open(nvdaStock(), "NVDA", { size: [933, 704], tab: "value" });
    expect(v.text()).toContain(`가치 지표 점수 ${NV.score}/100 · ${NV.band}`);
    expect(v.has("AI 가치분석, AI가 쓴 글")).toBe(true);
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
