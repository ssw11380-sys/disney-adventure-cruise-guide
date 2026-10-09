import React from "react";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountBriefingWithData, BriefingWithData, MarketSummary, MarketSummaryData } from "@/api/types";
import { cleanupRenders, render } from "./miniRender";

// 화면·조회 훅·캐시는 제품 모듈 그대로, 외부 통신과 네이티브 부품만 가짜로 바꾼다.
const h = vi.hoisted(() => ({ api: {} as Record<string, unknown>, width: 933, height: 704, fontScale: 1 }));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", RefreshControl: "RefreshControl",
  Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() }, Platform: { OS: "android" },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: h.width, height: h.height, scale: 1, fontScale: h.fontScale }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ useIsFocused: () => true, usePathname: () => "/briefings", router: { push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn() } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("@/api/client", () => ({ createApi: () => h.api, ApiRequestError: class extends Error {} }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "https://report-display.test", apiToken: "", ready: true }) }));
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false }), withLastTick: (x: unknown) => x }));
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.now() }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.dark, useFontScale: () => h.fontScale }; });
vi.mock("@/components/MarkdownView", () => ({ MarkdownView: "MarkdownView" }));
vi.mock("@/components/BriefingSources", () => ({ BriefingSources: "BriefingSources" }));
vi.mock("@/components/Skeleton", () => ({ CardsSkeleton: "CardsSkeleton" }));
vi.mock("@/components/ui", () => ({
  Badge: "Badge", Button: "Button", Card: "Card", ChangeText: "ChangeText", ErrorView: "ErrorView", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented", TableHead: "TableHead", Empty: "Empty",
}));
const { BriefingBody } = await import("@/components/BriefingBody");
const { AccountBriefingBody } = await import("@/components/AccountBriefingBody");
const { MarketSummaryBody } = await import("@/components/MarketSummaryBody");
const { useBriefing, useStockMutations, useLatestBriefings } = await import("@/api/hooks");
const { resetSessionForTests } = await import("@/lib/session");

const API = "https://report-display.test";
const at = Date.parse("2026-12-28T08:30:00+09:00");
const old: BriefingWithData = { id: 12, code: "005930", name: "시험종목", session: "morning", date: "2026-12-28", status: "ok", summary: "이전 요약", detail: "이전 보고서 본문", missing: [], model: "fake", error: null, createdAt: "2026-12-28T08:00:00+09:00", data: null };
const fresh = { ...old, detail: "새 보고서 본문", summary: "새 요약", createdAt: "2026-12-28T08:30:00+09:00" };
const account: AccountBriefingWithData = {
  ...old, template: true, headline: null,
  data: {
    version: 1, session: "morning", date: old.date, asOf: old.createdAt, basis: "앱 잔고 화면과 같은 기준", afterCost: true,
    holdings: 0, stale: 0, totalValue: 0, totalCost: 0, totalProfit: 0, totalProfitRate: null, dayPnl: 0, dayRate: null,
    contributions: [], others: { count: 0, amount: 0 }, markets: { kr: null, us: null }, excluded: [],
    fx: { status: "computed", reason: null, usdKrw: null, appliedRate: null, usdHoldingsKrwChange: 0, priceEffect: 0, fxEffect: 0 },
    indices: [], missingIndices: [], narrative: { source: "template", reason: null },
    schedule: { kr: { date: old.date, tradingDay: false, now: "휴장", hours: null, nextOpen: null }, us: { date: old.date, tradingDay: false, now: "휴장", hours: null }, disclosures: [] },
  },
};
const marketData = (JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: Array<{ data: MarketSummaryData }> }).cases[0]!.data;
const market: MarketSummary = { id: old.id, date: marketData.date, session: marketData.session, market: marketData.market, status: "ok", summary: "기존 시장 요약", createdAt: marketData.asOf, data: marketData };
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(at); resetSessionForTests();
  h.width = 933; h.height = 704; h.fontScale = 1;
  h.api = { features: async () => ({ features: {} }), listBriefings: async () => [old] };
});
afterEach(() => { cleanupRenders(); clients.splice(0).forEach((qc) => qc.clear()); resetSessionForTests(); vi.useRealTimers(); });
const settle = () => vi.advanceTimersByTimeAsync(0);
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false }, mutations: { retry: false } } });
  clients.push(qc);
  qc.setQueryData([API, "features"], { features: {} });
  qc.setQueryData([API, "briefing", old.id], old);
  return qc;
}
const reports = {
  stock: { key: [API, "briefing", old.id], data: old, body: (layout: "stack" | "split" | "pane") => <BriefingBody id={old.id} layout={layout} /> },
  account: { key: [API, "briefings", "account", old.id], data: account, body: (layout: "stack" | "split" | "pane") => <AccountBriefingBody numId={old.id} layout={layout} /> },
  market: { key: [API, "briefings", "market", old.id], data: market, body: (layout: "stack" | "split" | "pane") => <MarketSummaryBody numId={old.id} layout={layout} /> },
};
function enableReports(qc: QueryClient, failing: () => boolean = () => false) {
  const flags = { accountBriefing: true, marketSummary: true };
  h.api.features = async () => ({ features: flags }); qc.setQueryData([API, "features"], { features: flags });
  for (const [method, data] of [["getBriefing", old], ["getAccountBriefing", account], ["getMarketSummary", market]] as const) {
    h.api[method] = async () => { if (failing()) throw new Error("상세만 실패"); return data; };
  }
}

describe("보고서 상세의 캐시와 갱신 실패 경계", () => {
  it.each(["stack", "split", "pane"] as const)("%s: 목록이 성공해도 상세 재조회만 실패하면 이전 본문과 실패 안내를 함께 표시한다", async (layout) => {
    const qc = setup(); h.api.getBriefing = async () => { throw new Error("상세만 실패"); };
    qc.setQueryData([API, "briefings", "latest"], [{ code: old.code, latest: fresh }]);
    const r = render(<QueryClientProvider client={qc}><BriefingBody id={old.id} layout={layout} /></QueryClientProvider>);
    await qc.invalidateQueries({ queryKey: [API, "briefing", old.id] }); await settle();
    expect(qc.getQueryState([API, "briefings", "latest"])?.status).toBe("success");
    expect(qc.getQueryState([API, "briefing", old.id])?.status).toBe("error");
    expect(r.text()).toContain("이전 보고서 본문");
    expect(r.text()).toContain("연결 끊김");
    expect(r.all().some((n) => n.props.accessibilityRole === "alert")).toBe(true);
  });

  it.each(["stack", "split", "pane"] as const)("%s: 같은 ID를 덮어쓰는 재생성 성공 후 열린 상세도 새 본문으로 바뀐다", async (layout) => {
    const qc = setup(); let saved = old;
    h.api.getBriefing = vi.fn(async () => saved);
    h.api.latestBriefings = async () => [{ code: old.code, latest: saved }];
    h.api.runBriefings = async () => {
      saved = fresh;
      return { results: [{ code: old.code, name: old.name, status: "ok", briefingId: old.id, error: null, summary: fresh.summary }] };
    };
    let run!: ReturnType<typeof useStockMutations>["run"];
    function Probe() { run = useStockMutations().run; useLatestBriefings(); return <BriefingBody id={old.id} layout={layout} />; }
    const r = render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
    await settle(); vi.mocked(h.api.getBriefing as ReturnType<typeof vi.fn>).mockClear();
    await run.mutateAsync({ session: "morning", codes: [old.code], force: true }); await settle();
    expect(qc.getQueryData<Array<{ latest: BriefingWithData }>>([API, "briefings", "latest"])?.[0]?.latest.detail).toBe("새 보고서 본문");
    expect(r.text()).toContain("새 보고서 본문");
    expect(r.text()).not.toContain("이전 보고서 본문");
    expect(h.api.getBriefing).toHaveBeenCalledTimes(1);
    expect(r.text()).not.toContain("연결 끊김");
  });

  it.each(["account", "market"] as const)("%s: 오른쪽 보고서의 독립적인 재조회 실패도 숨기지 않는다", async (kind) => {
    const qc = setup(); const flags = { accountBriefing: true, marketSummary: true };
    h.api.features = async () => ({ features: flags }); qc.setQueryData([API, "features"], { features: flags });
    h.api.getAccountBriefing = async () => { throw new Error("계좌 상세만 실패"); };
    h.api.getMarketSummary = async () => { throw new Error("시장 상세만 실패"); };
    const key = [API, "briefings", kind, old.id];
    qc.setQueryData(key, kind === "account" ? account : market);
    const r = render(<QueryClientProvider client={qc}>{kind === "account" ? <AccountBriefingBody numId={old.id} layout="pane" /> : <MarketSummaryBody numId={old.id} layout="pane" />}</QueryClientProvider>);
    await qc.invalidateQueries({ queryKey: key }); await settle();
    expect(qc.getQueryState(key)?.status).toBe("error");
    expect(r.text()).toContain("연결 끊김");
  });

  it("중복 성공 ID는 한 번만 조회하고 실패·건너뜀·무관한 상세는 그대로 두며 새 생성이나 조회 대기를 추가하지 않는다", async () => {
    const qc = setup();
    let finish!: (value: BriefingWithData) => void;
    const held = new Promise<BriefingWithData>((resolve) => { finish = resolve; });
    let checking = false;
    const get = vi.fn((id: number) => checking && id === old.id ? held : Promise.resolve({ ...old, id }));
    h.api.getBriefing = get;
    h.api.runBriefings = vi.fn(async () => ({ results: [
      { code: old.code, status: "ok", briefingId: old.id }, { code: old.code, status: "ok", briefingId: old.id },
      { code: "실패종목", status: "failed", briefingId: 13 }, { code: "건너뛴종목", status: "skipped", briefingId: 14 },
    ] }));
    let run!: ReturnType<typeof useStockMutations>["run"];
    function Probe() { run = useStockMutations().run; useBriefing(13); useBriefing(14); useBriefing(15); return <BriefingBody id={old.id} layout="pane" />; }
    const r = render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>);
    await settle(); get.mockClear(); checking = true;
    let completed = false;
    const generation = run.mutateAsync({ session: "morning", force: true }).then(() => { completed = true; });
    await settle();
    expect(completed).toBe(true);
    expect(h.api.runBriefings).toHaveBeenCalledTimes(1);
    expect(get.mock.calls).toEqual([[old.id]]);
    expect(r.text()).toContain("이전 보고서 본문");
    finish(fresh); await generation; await settle();
    expect(r.text()).toContain("새 보고서 본문");
  });

  it.each((Object.keys(reports) as Array<keyof typeof reports>).flatMap((kind) => (["stack", "split", "pane"] as const).map((layout) => ({ kind, layout }))))(
    "$kind/$layout: 정상 조회에는 실패 안내를 추가하지 않고 본문 스크롤을 유지한다",
    async ({ kind, layout }) => {
      const qc = setup(); enableReports(qc); const item = reports[kind]; qc.setQueryData(item.key, item.data);
      const r = render(<QueryClientProvider client={qc}>{item.body(layout)}</QueryClientProvider>); await settle();
      expect(r.text()).not.toContain("연결 끊김");
      expect(r.all().some((n) => n.props.accessibilityRole === "alert")).toBe(false);
      expect(r.all().some((n) => n.type === "ScrollView")).toBe(true);
      expect(r.text()).toContain("투자 판단의 책임은 본인에게");
    },
  );

  it.each(Object.keys(reports) as Array<keyof typeof reports>)("%s: 처음 상세 조회 실패의 재시도는 기존대로 데이터를 다시 받는다", async (kind) => {
    const qc = setup(); let failing = true; enableReports(qc, () => failing); const item = reports[kind]; qc.removeQueries({ queryKey: item.key, exact: true });
    const r = render(<QueryClientProvider client={qc}>{item.body("pane")}</QueryClientProvider>); await settle();
    const retry = r.all().find((n) => n.type === "ErrorView"); expect(retry).toBeDefined();
    failing = false; r.act(() => (retry!.props.onRetry as () => void)()); await settle();
    expect(r.all().some((n) => n.type === "ErrorView")).toBe(false);
    expect(qc.getQueryState(item.key)?.status).toBe("success");
    expect(r.text()).not.toContain("연결 끊김");
  });
});
