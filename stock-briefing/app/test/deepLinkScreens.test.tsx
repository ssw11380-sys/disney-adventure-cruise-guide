import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 딥링크로 여는 종목 화면의 주소 검증 (BH-36). 다른 앱·웹 페이지가 stockbriefing://stocks/<code>/chart 를 열 수 있어
 * code·period 는 누구나 넣을 수 있는 값이다 → 검증을 통과한 값만 서버 요청에 쓴다 (상세 화면과 같은 규칙)
 */
const h = vi.hoisted(() => ({
  params: {} as { code?: string | string[]; period?: string | string[] },
  stockCodes: [] as string[],
  candleArgs: [] as unknown[][],
  dismissTo: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ Stack: { Screen: "StackScreen" }, router: { back: vi.fn(), dismissTo: h.dismissTo, push: vi.fn() }, useLocalSearchParams: () => h.params }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/api/hooks", () => ({
  useStock: (code: string) => {
    h.stockCodes.push(code);
    return { data: undefined, isLoading: !!code, isError: false, error: null, refetch: vi.fn() };
  },
  useCandles: (...args: unknown[]) => {
    h.candleArgs.push(args);
    return { data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() };
  },
}));
vi.mock("@/components/CandleChart", () => ({ CandleChart: "CandleChart" }));
vi.mock("@/components/Freshness", () => ({ ChartNotice: "ChartNotice" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ ChangeText: "ChangeText", ErrorView: "ErrorView" }));

const { default: ChartScreen } = await import("@/app/stocks/[code]/chart");
const { createApi } = await import("@/api/client");

const ATTACK = "AAPL/analysis/company?refresh=1#";

beforeEach(() => {
  h.stockCodes.length = 0;
  h.candleArgs.length = 0;
  h.dismissTo.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("BH-36: 전체 화면 차트 딥링크", () => {
  const open = (params: typeof h.params) => {
    h.params = params;
    return render(<ChartScreen />);
  };
  const chart = (r: ReturnType<typeof open>) => r.all().find((n) => n.type === "CandleChart");

  it("검증을 통과하지 못한 종목 코드는 서버에 묻지 않고 안내만 한다 (재현)", () => {
    const r = open({ code: ATTACK });
    expect(h.stockCodes.every((c) => c === "")).toBe(true);
    expect(h.candleArgs.every((a) => a[0] === "")).toBe(true);
    const err = r.all().find((n) => n.type === "ErrorView");
    expect(err).toBeDefined();
    expect((err!.props.error as Error).message).toBe("종목 주소가 올바르지 않습니다");
    expect(chart(r)).toBeUndefined();
    r.act(() => (err!.props.onRetry as () => void)());
    expect(h.dismissTo).toHaveBeenCalledWith("/");
  });

  it("모르는 기간·여러 번 넣은 기간은 일봉으로 연다 (첫 렌더 오류 없이)", () => {
    for (const period of ["X", "constructor", ["D", "W"]]) {
      h.candleArgs.length = 0;
      const r = open({ code: "AAPL", period });
      expect(chart(r)!.props.period).toBe("D");
      expect(h.candleArgs.at(-1)).toEqual(["AAPL", "D", 800]);
    }
  });

  it("정상 링크는 그 종목·기간으로 연다", () => {
    const r = open({ code: "005930", period: "W" });
    expect(h.stockCodes.at(-1)).toBe("005930");
    expect(h.candleArgs.at(-1)).toEqual(["005930", "W", 260]);
    expect(chart(r)!.props.period).toBe("W");
  });
});

describe("BH-36: API 요청 주소 — 종목 코드가 경로·쿼리를 바꾸지 못한다", () => {
  const capture = () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response("{}", { status: 200 });
    });
    return urls;
  };

  it("코드 안의 / ? # 는 한 경로 칸으로 인코딩한다", async () => {
    const urls = capture();
    const api = createApi("https://server.test");
    await api.getStock(ATTACK);
    await api.getCandles(ATTACK, "D", 800);
    await api.getQuote(ATTACK, true);
    await api.getAnalysis(ATTACK, "company");
    await api.getStockNews(ATTACK);
    await api.updateStock(ATTACK, { memo: null });
    await api.removeStock(ATTACK).catch(() => undefined);
    const enc = encodeURIComponent(ATTACK);
    expect(urls).toEqual([
      `https://server.test/api/stocks/${enc}`,
      `https://server.test/api/stocks/${enc}/candles?period=D&count=800`,
      `https://server.test/api/stocks/${enc}/quote?fresh=1`,
      `https://server.test/api/stocks/${enc}/analysis/company`,
      `https://server.test/api/stocks/${enc}/news`,
      `https://server.test/api/stocks/${enc}`,
      `https://server.test/api/stocks/${enc}`,
    ]);
    for (const u of urls) expect(new URL(u).pathname.startsWith("/api/stocks/AAPL%2F")).toBe(true);
  });

  it("정상 코드(국내 6자리·점 들어간 미국 티커)는 그대로", async () => {
    const urls = capture();
    const api = createApi("https://server.test");
    await api.getStock("BRK.B");
    await api.getCandles("005930", "M", 120);
    expect(urls).toEqual(["https://server.test/api/stocks/BRK.B", "https://server.test/api/stocks/005930/candles?period=M&count=120"]);
  });
});
