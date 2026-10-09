import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TossAccountSnapshotBody } from "@/api/types";

const h = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, PixelRatio: { getFontScale: () => 1 } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (k: string) => h.store.get(k) ?? null,
  setItem: async (k: string, v: string) => void h.store.set(k, v),
  removeItem: async (k: string) => void h.store.delete(k),
  multiGet: async (keys: string[]) => keys.map((k) => [k, h.store.get(k) ?? null]),
} }));
vi.mock("react-native-android-widget", async () => {
  const load = (p: string) => import(/* @vite-ignore */ p);
  const base = "react-native-android-widget/lib/commonjs/widgets/";
  const [flex, text, list] = await Promise.all([load(`${base}FlexWidget.js`), load(`${base}TextWidget.js`), load(`${base}ListWidget.js`)]);
  return { FlexWidget: flex.FlexWidget, TextWidget: text.TextWidget, ListWidget: list.ListWidget };
});
const load = (p: string) => import(/* @vite-ignore */ p);
const { buildWidgetTree } = await load("react-native-android-widget/lib/commonjs/api/build-widget-tree.js");
const { renderBoth, renderFor } = await import("@/widgets/render");
const { fromPayload } = await import("@/widgets/payload");
const { loadWidgetData, loadCachedWidgetData, pushWidgetData, clearWidgetAccountData, resetWidgetAccountSnapshot, widgetAccountSnapshotGeneration, readCachedPayload } = await import("@/widgets/data");
const AT = "2026-10-04T10:00:00+09:00", NOW = Date.parse("2026-10-04T10:02:00+09:00");
const account = (value = 800_000): TossAccountSnapshotBody => ({ on: true, snapshot: {
  source: "toss-openapi", scope: "all-toss-stock-holdings", excludesCash: true, includesExcludedHoldings: true,
  receivedFrom: AT, receivedAt: AT, accountCount: 1, holdingCount: 1, excludedHoldingCount: 0,
  gross: { krw: value, usd: 0 }, net: { krw: value - 100, usd: 0 }, displayFx: null,
  costBasis: { krw: 1_000_000, estimatedHoldingCount: 0, holdingCount: 1, source: "synced-holdings-cost-book" },
}, sync: { enabled: true, intervalMin: 10, idleIntervalMin: 60, lastRunAt: AT, nextRunAt: "2026-10-04T11:00:00+09:00", lastError: null } });
const payload = (body: TossAccountSnapshotBody | null = account(), enabled = true) => ({
  v: 1 as const, market: null, briefings: [],
  features: { widgetPnlToggle: true, widgetClarity: true, tossAccountSnapshot: enabled },
  stocks: [{ c: "005930", n: "시험 종목", qty: 10, avg: 100_000,
    q: [90_000, 100, 0.11, "KRW", "2026-10-04T10:01:00+09:00", null, 0] as [number, number, number, "KRW", string, null, 0],
    e: [900_000, 1_000_000, 899_900, null, null] as [number, number, number, null, null] }],
  ...(body ? { tossAccount: body } : {}),
});
const data = (body: TossAccountSnapshotBody | null = account(), enabled = true) => ({ ...fromPayload(payload(body, enabled)), showKrw: true, afterCost: false, fetchedAt: NOW, error: null, filled: [] });
type Tree = { props: Record<string, unknown>; children?: Tree[] };
const nodes = (t: Tree): Tree[] => [t, ...(t.children ?? []).flatMap(nodes)];
const tree = (body: TossAccountSnapshotBody | null = account(), mode: "cumulative" | "day" = "cumulative", name = "Holdings", enabled = true) =>
  buildWidgetTree(renderBoth(name, data(body, enabled), { width: 516, height: 300, fontScale: 1, now: NOW, pnlMode: mode }).dark) as Tree;
const words = (t: Tree) => nodes(t).flatMap((n) => typeof n.props.text === "string" ? [n.props.text] : []);

beforeEach(() => { h.store.clear(); vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("위젯의 계좌 기준 합계", () => {
  it("시세 추정과 다른 계좌 평가·손익을 표시하고 계좌 화면을 연다", () => {
    const t = tree(); const text = words(t).join(" ");
    expect(text).toContain("800,000원"); expect(text).toContain("-200,000원"); expect(text).not.toContain("900,000원");
    expect(text).toContain("토스 계좌");
    expect(nodes(t).filter((n) => n.props.clickAction === "OPEN_URI").some((n) => JSON.stringify(n.props.clickActionData).includes("valuation=account"))).toBe(true);
    expect(JSON.stringify(t)).not.toContain("valuation=live");
  });
  it("전일 대비 전환은 계좌 금액을 유지하고 시세 분모로 수익률을 계산한다", () => {
    const t = tree(account(), "day"); const text = words(t).join(" ");
    expect(text).toContain("800,000원"); expect(text).toContain("시세 전일 대비"); expect(text).toContain("+0.11%");
    expect(text).not.toContain("+0.13%");
  });
  it("계좌 수신 시각과 종목 시세 시각을 혼동하지 않는다", () => {
    expect(words(tree()).join(" ")).toContain("계좌 수신 10:00");
    expect(words(tree()).join(" ")).not.toContain("시세 10:01");
  });
  it("계좌 자료가 없으면 시세 평가를 계좌 금액으로 대신하지 않는다", () => {
    const t = tree({ on: true, snapshot: null, sync: null }); const text = words(t).join(" ");
    expect(text).toContain("계좌 확인 필요"); expect(text).not.toContain("900,000원");
    expect(nodes(t).filter((n) => n.props.clickAction === "PNL_TOGGLE")).toHaveLength(0);
    // 종목별 시세 손익은 유지하되 계좌 합계 자리에는 표시하지 않는다.
    expect(text).toContain("시세 손익 -10.00% -100,000원");
  });
  it("계좌 원가가 없으면 평가금액은 보여도 누적 손익을 지어내지 않는다", () => {
    const b = account(); b.snapshot!.costBasis = null;
    const text = words(tree(b)).join(" ");
    expect(text).toContain("800,000원"); expect(text).toContain("손익 확인 필요"); expect(text).not.toContain("-200,000원");
  });
  it("작은 자산 위젯도 계좌 손익을 우선하고 같은 기준을 연다", () => {
    const text = words(tree(account(), "cumulative", "Asset")).join(" ");
    expect(text).toContain("토스 계좌"); expect(text).toContain("800,000원"); expect(text).toContain("-200,000원");
    const small = buildWidgetTree(renderBoth("Asset", data(), { width: 240, height: 90, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark) as Tree;
    expect(words(small).join(" ")).toContain("평가손익 -200,000원");
  });
  it("플래그를 끄면 기존 시세 평가와 기존 링크를 보존한다", () => {
    const t = tree(account(), "cumulative", "Holdings", false);
    expect(words(t).join(" ")).toContain("900,000원"); expect(JSON.stringify(t)).toContain("valuation=live");
  });
  it("기존 위젯 요청 한 번으로 계좌 자료를 받아 같은 서버 캐시에 보존한다", async () => {
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify(payload()), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
    const d = await loadWidgetData();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(String(fetcher.mock.calls[0]?.[0])).toContain("account=1");
    expect(d).toHaveProperty("tossAccount.snapshot.gross.krw", 800_000);
    expect(await loadCachedWidgetData()).toHaveProperty("tossAccount.snapshot.gross.krw", 800_000);
  });
  it("앱의 더 늦은 계좌 수신을 유지하고 종목 시세 갱신만으로 되돌리지 않는다", async () => {
    const base = data();
    await pushWidgetData({ ...base, indices: null, board: null, features: { at: NOW, flags: base.features }, tossAccount: { at: NOW, body: account(810_000) } });
    const older = account(800_000); older.snapshot!.receivedAt = "2026-10-04T09:00:00+09:00";
    const next = await pushWidgetData({ ...base, indices: null, board: null, features: { at: NOW, flags: base.features }, fetchedAt: NOW + 1000, tossAccount: { at: NOW - 1000, body: older } });
    expect(next).toHaveProperty("tossAccount.snapshot.gross.krw", 810_000);
    await clearWidgetAccountData(); expect(await loadCachedWidgetData()).not.toHaveProperty("tossAccount.snapshot");
  });
  it("비용 차감·환율은 시세 값과 섞지 않고 동기화 회차 값을 사용한다", () => {
    const b = account(); b.snapshot!.gross = { krw: 100_000, usd: 500 }; b.snapshot!.net = { krw: 99_900, usd: 499 };
    b.snapshot!.displayFx = { usdKrw: 1400, receivedAt: AT, source: "app-display-fx", kind: "reference" };
    const d = { ...data(b), afterCost: true };
    const t = buildWidgetTree(renderBoth("Holdings", d, { width: 516, height: 300, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark) as Tree;
    expect(words(t).join(" ")).toContain("798,500원"); expect(words(t).join(" ")).toContain("-201,500원");
  });
  it("깨진 계좌 저장값은 확인 필요로 남기고 시세 합계로 대체하지 않는다", () => {
    const b = account(); b.snapshot!.gross = null as never;
    const text = words(tree(b)).join(" ");
    expect(text).toContain("계좌 확인 필요"); expect(text).not.toContain("900,000원");
  });
  it("계좌 조회 실패 경고를 같은 숫자와 함께 보존한다", async () => {
    const base = data();
    await pushWidgetData({ ...base, indices: null, board: null, features: { at: NOW, flags: base.features }, tossAccount: { at: NOW, body: account() } });
    const failed = account(); failed.sync!.lastError = "새로고침 실패";
    const d = await pushWidgetData({ ...base, indices: null, board: null, features: { at: NOW, flags: base.features }, tossAccount: { at: NOW + 1000, body: failed } });
    expect(d.tossAccount?.sync?.lastError).toBe("새로고침 실패");
    const t = buildWidgetTree(renderBoth("Holdings", d, { width: 516, height: 300, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark) as Tree;
    expect(words(t).join(" ")).toContain("계좌 갱신 확인"); expect(words(t).join(" ")).toContain("-200,000원");
  });
  it("늦은 응답이 과거 회차여도 최신 실패 상태와 새 계좌 숫자를 함께 유지한다", async () => {
    const base = data();
    await pushWidgetData({ ...base, indices: null, board: null, features: { at: NOW, flags: base.features }, tossAccount: { at: NOW, body: account(810_000) } });
    const failed = account(); failed.snapshot!.receivedAt = "2026-10-04T09:00:00+09:00"; failed.sync!.lastError = "새로고침 실패";
    const d = await pushWidgetData({ ...base, indices: null, board: null, features: { at: NOW, flags: base.features }, tossAccount: { at: NOW + 1000, body: failed } });
    expect(d.tossAccount?.sync?.lastError).toBe("새로고침 실패"); expect(d.tossAccount?.snapshot?.gross.krw).toBe(810_000);
    expect(d.tossAccountAt).toBe(NOW + 1000);
  });
  it.each([0, 100_000])("원화 표시를 끄면 국내 금액 %d와 외화 금액을 강제로 원화 합산하지 않는다", (krw) => {
    const b = account(); b.snapshot!.gross = { krw, usd: 500 }; b.snapshot!.net = { krw, usd: 499 };
    b.snapshot!.displayFx = { usdKrw: 1400, receivedAt: AT, source: "app-display-fx", kind: "reference" };
    for (const name of ["Holdings", "Asset"]) {
      const t = buildWidgetTree(renderBoth(name, { ...data(b), showKrw: false }, { width: 516, height: 300, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark) as Tree;
      const text = words(t).join(" ");
      expect(text).toContain("통화별 금액은 앱에서 확인"); expect(text).not.toContain("계좌 확인 필요");
      expect(text).not.toContain("800,000원"); expect(text).not.toContain("700,000원"); expect(text).not.toContain("-200,000원");
    }
    b.snapshot!.displayFx = null;
    const original = buildWidgetTree(renderBoth("Holdings", { ...data(b), showKrw: false }, { width: 516, height: 300, fontScale: 1, now: NOW, pnlMode: "cumulative" }).dark) as Tree;
    expect(words(original).join(" ")).toContain("통화별 금액은 앱에서 확인"); expect(words(original).join(" ")).not.toContain("계좌 확인 필요");
    expect(words(tree(b)).join(" ")).toContain("계좌 확인 필요");
  });
  it("보통 로딩 null은 독립 위젯 캐시를 유지하지만 인증 변경은 실제 캐시를 폐기한다", async () => {
    const base = data(); const inputs = { ...base, indices: null, board: null, features: { at: NOW, flags: base.features } };
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify(payload()), { headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
    await loadWidgetData();
    const oldGeneration = widgetAccountSnapshotGeneration();
    const kept = await pushWidgetData({ ...inputs, tossAccount: null });
    expect(kept.tossAccount?.snapshot?.gross.krw).toBe(800_000);
    await resetWidgetAccountSnapshot();
    const next = await pushWidgetData({ ...inputs, tossAccount: null });
    expect(next.tossAccount?.snapshot).toBeUndefined();
    expect((await readCachedPayload())?.body.tossAccount).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(pushWidgetData({ ...inputs, accountGeneration: oldGeneration, tossAccount: { at: NOW, body: account() } })).rejects.toThrow("계좌 연결 정보");
    await expect(renderFor("Holdings", kept, { width: 516, height: 300 }, { fontScale: 1, now: NOW, pnlMode: "cumulative" })).rejects.toThrow("계좌 연결 정보");
    const fresh = await pushWidgetData({ ...inputs, tossAccount: { at: NOW + 1000, body: account(820_000) } });
    expect(fresh.tossAccount?.snapshot?.gross.krw).toBe(820_000);
  });
  it("인증 변경 전에 시작한 늦은 서버 응답은 계좌 캐시를 되살리지 않는다", async () => {
    let respond!: (response: Response) => void;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => { started(); return new Promise<Response>((resolve) => { respond = resolve; }); }));
    const old = loadWidgetData();
    await fetching;
    await resetWidgetAccountSnapshot();
    const failed = expect(old).rejects.toThrow("계좌 연결 정보");
    respond(new Response(JSON.stringify(payload()), { headers: { "content-type": "application/json" } }));
    await failed;
    expect((await readCachedPayload())?.body.tossAccount).toBeUndefined();
    expect((await loadCachedWidgetData()).tossAccount).toBeUndefined();
  });
});
