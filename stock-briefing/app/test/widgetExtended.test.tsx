import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketStatus, QuoteSession } from "@/api/types";
import { holding, quote } from "./helpers";

/**
 * 위젯 리뷰 1번: 미국 프리마켓(저녁 8시~밤 10시 반)·애프터마켓(새벽)·한국 휴일 낮 주간거래에는 위젯이 최대 2시간 멈추는데 '지연'도 뜨지 않았다.
 * 서버 칩이 이 시간에 글자만 세션 이름으로 바꾸고 open 은 false 라, 앱이 휴장으로 보고
 *  - shouldSkipFetch: 2시간 동안 서버에 묻지 않고 (백그라운드 작업)
 *  - canReuse: 위젯 스스로 갱신할 때 2시간 전 응답을 다시 쓰고
 *  - openMarketAsOf: '지연'을 따지지 않았다.
 * 고침: 서버가 칩에 시장별 연장 세션 열림(ext)을 더하고(플래그 widgetExtended), 앱은 이것도 장중처럼 본다. 플래그가 꺼져 있거나 모르면 예전 그대로.
 */

vi.mock("react-native-android-widget", () => {
  const mk = (kind: string) => Object.assign((_: unknown) => null, { __widget: kind });
  return { FlexWidget: mk("Flex"), TextWidget: mk("Text"), ListWidget: mk("List") };
});
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
const store = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, store.get(k) ?? null]),
  },
}));

const { HoldingsWidget } = await import("@/widgets/widgets");
const { canReuse, extendedOpen, fromPayload, openMarketAsOf, payloadMarket, shouldSkipFetch, widgetFeatures } = await import("@/widgets/payload");
const { loadWidgetData, pushWidgetData } = await import("@/widgets/data");
const API = "https://server.test";

interface Node {
  kind: string;
  props: Record<string, unknown>;
  children: Node[];
}
function render(el: React.ReactNode): Node[] {
  if (el === null || el === undefined || typeof el === "boolean") return [];
  if (Array.isArray(el)) return el.flatMap(render);
  if (!React.isValidElement(el)) return [];
  const type = el.type as { __widget?: string } & ((p: unknown) => React.ReactNode);
  const props = el.props as Record<string, unknown>;
  if (type.__widget) return [{ kind: type.__widget, props, children: render(props.children as React.ReactNode) }];
  if (typeof type === "function") return render(type(props));
  return render(props.children as React.ReactNode);
}
const all = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...all(n.children)]);
const words = (nodes: Node[]) => all(nodes).filter((n) => n.kind === "Text").map((n) => String(n.props.text));

// 평일 21:00 KST: 한국 달력 닫힘(20:00 마감), 미국 프리마켓 (정규장 22:30 KST 개장)
const NOW = Date.parse("2026-09-22T21:00:00+09:00");
const PRE_END = "2026-09-22T13:30:00.000Z";
/** 서버가 새 앱(&sessions=1)에 주는 프리마켓 칩 (연장 세션 표시 포함) */
const preChip = (ext = true) => ({ label: "미국 프리마켓", open: false, kr: false, us: false, nextChangeAt: PRE_END, ...(ext ? { ext: { kr: false, us: true } } : {}) });

beforeEach(() => {
  store.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("공용 픽스처: 앱 extendedOpen = 서버 widgetPayload.extendedOpen", () => {
  interface ChipCase {
    name: string;
    now: string;
    status: MarketStatus;
    holdings: { code: string; session: QuoteSession | null }[];
  }
  const chips = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketChip.json", import.meta.url), "utf8")) as { cases: ChipCase[] };
  const expected = JSON.parse(readFileSync(new URL("../../shared/fixtures/widgetExtended.json", import.meta.url), "utf8")) as { cases: { name: string; ext: { kr: boolean; us: boolean } }[] };
  it("모든 사례에 답이 있다", () => expect(expected.cases.map((c) => c.name)).toEqual(chips.cases.map((c) => c.name)));
  for (const c of chips.cases) {
    it(`같은 답: ${c.name}`, () => {
      const want = expected.cases.find((x) => x.name === c.name)!.ext;
      expect(extendedOpen({ kr: c.status.KR.isOpen, us: c.status.US.isOpen }, c.holdings.map((h) => h.session), Date.parse(c.now))).toEqual(want);
    });
  }
});

describe("갱신 주기: 연장 세션이 열려 있으면 장중처럼 15분", () => {
  it("재현: 21:00 미국 프리마켓, 30분 전에 받은 응답 — 예전에는 2시간 동안 건너뛰었다", () => {
    expect(shouldSkipFetch({ at: NOW - 30 * 60_000, market: preChip() }, NOW)).toBe(false);
    // 칩에 연장 세션 표시가 없으면(예전 서버·플래그 꺼짐) 예전 휴장 규칙 그대로
    expect(shouldSkipFetch({ at: NOW - 30 * 60_000, market: preChip(false) }, NOW)).toBe(true);
    // 표시가 있어도 두 시장 모두 연장 세션이 아니면 휴장 규칙
    expect(shouldSkipFetch({ at: NOW - 30 * 60_000, market: { ...preChip(), ext: { kr: false, us: false } } }, NOW)).toBe(true);
  });

  it("위젯이 스스로 갱신할 때(주기·크기 변경)도 받아 둔 응답은 15분까지만 다시 쓴다", () => {
    expect(canReuse({ at: NOW - 10 * 60_000, market: preChip() }, NOW)).toBe(true);
    expect(canReuse({ at: NOW - 16 * 60_000, market: preChip() }, NOW)).toBe(false);
    expect(canReuse({ at: NOW - 16 * 60_000, market: preChip(false) }, NOW)).toBe(true); // 예전: 2시간
  });

  it("플래그(widgetExtended)가 꺼져 있거나 모르면(예전 서버) ext 를 보지 않는다 — fromPayload·payloadMarket 이 떼어 낸다", () => {
    const body = (features?: Record<string, boolean>) => ({ v: 1 as const, market: preChip(), stocks: [], briefings: [], latestIds: [], ...(features ? { features } : {}) });
    expect(widgetFeatures({ widgetExtended: true }).extended).toBe(true);
    expect(widgetFeatures({}).extended).not.toBe(true);
    expect(widgetFeatures(null).extended).not.toBe(true);
    expect(payloadMarket(body({ widgetExtended: true }))?.ext).toEqual({ kr: false, us: true });
    expect(payloadMarket(body({ widgetExtended: false }))).not.toHaveProperty("ext");
    expect(payloadMarket(body())).not.toHaveProperty("ext");
    expect(fromPayload(body({ widgetExtended: false })).market).not.toHaveProperty("ext");
    expect(shouldSkipFetch({ at: NOW - 30 * 60_000, market: payloadMarket(body({ widgetExtended: false })) }, NOW)).toBe(true);
    expect(shouldSkipFetch({ at: NOW - 30 * 60_000, market: payloadMarket(body({ widgetExtended: true })) }, NOW)).toBe(false);
  });

  it("위젯 스스로 갱신: 16분 전 프리마켓 응답은 다시 쓰지 않고 서버에 묻는다 (예전: 2시간 재사용)", async () => {
    const payload = { v: 1, market: preChip(), stocks: [], briefings: [], latestIds: [], features: { widgetExtended: true } };
    store.set("widget.payload", JSON.stringify({ at: NOW - 16 * 60_000, apiUrl: API, path: "/api/widget?indices=1&sessions=1&ui=2", etag: '"a"', body: payload }));
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(payload), { status: 200, headers: { etag: '"b"' } });
    });
    await loadWidgetData({ stocks: true, briefings: false, reuse: true });
    expect(urls).toHaveLength(1);
  });
});

describe("'지연': 연장 세션 시장의 시세도 본다", () => {
  const usAt = (asOf: string) => [holding("VRT", quote("VRT", 250, { currency: "USD", fxRate: 1_400, change: 1, changeRate: 0.4, asOf }), 2, 200, undefined, "버티브")];

  it("openMarketAsOf: 달력으로 닫혀 있어도 ext.us 면 미국 종목 시세 시각", () => {
    const at = "2026-09-22T20:20:00+09:00";
    expect(openMarketAsOf(usAt(at), preChip())).toBe(Date.parse(at));
    expect(openMarketAsOf(usAt(at), preChip(false))).toBeNull(); // 예전: 연장 세션을 몰라 '지연'을 따지지 않았다
    // 한국만 연장 세션이면 미국 종목은 보지 않는다
    expect(openMarketAsOf(usAt(at), { ...preChip(), ext: { kr: true, us: false } })).toBeNull();
  });

  it("재현: 21:00 프리마켓인데 위젯 숫자가 20:20 값이면 '지연' (예전: '미국 프리마켓' 칩만 보이고 지연 없음)", () => {
    const stocks = usAt("2026-09-22T20:20:00+09:00");
    const shown = words(render(<HoldingsWidget stocks={stocks} showKrw={false} afterCost={false} fetchedAt={NOW - 40 * 60_000} error={null} now={NOW} market={preChip()} />));
    expect(shown).toContain("미국 프리마켓");
    expect(shown).toContain("지연");
    // 20분 전 값이면 지연 아님
    const fresh = words(render(<HoldingsWidget stocks={usAt("2026-09-22T20:40:00+09:00")} showKrw={false} afterCost={false} fetchedAt={NOW} error={null} now={NOW} market={preChip()} />));
    expect(fresh).not.toContain("지연");
    // 표시가 없는 칩(플래그 꺼짐)은 예전처럼 지연을 따지지 않는다
    const off = words(render(<HoldingsWidget stocks={stocks} showKrw={false} afterCost={false} fetchedAt={NOW - 40 * 60_000} error={null} now={NOW} market={preChip(false)} />));
    expect(off).not.toContain("지연");
  });
});

describe("앱이 바로 그리는 칩(WidgetBridge → pushWidgetData)에도 같은 규칙으로 ext", () => {
  const pre: QuoteSession = { market: "US", phase: "pre", label: "미국 프리마켓", open: true, eligible: true, until: PRE_END };
  const stocks = [holding("VRT", quote("VRT", 250, { currency: "USD", fxRate: 1_400, asOf: "2026-09-22T20:59:00+09:00", session: pre }), 2, 200, undefined, "버티브")];
  const appChip = { label: "미국 프리마켓", open: false, kr: false, us: false, nextChangeAt: PRE_END };
  const flags = (extended: boolean) => ({ at: NOW - 10_000, flags: { ...widgetFeatures({ widgetPnlToggle: true, widgetIndexLine: true, widgetMarket: true, widgetExtended: extended }) } });

  it("위젯이 쓰는 플래그가 켜져 있으면 잔고 시세의 세션으로 ext 를 붙인다 (서버와 같은 답)", async () => {
    const d = await pushWidgetData({ stocks, filled: [], showKrw: false, afterCost: false, fetchedAt: NOW, market: appChip, features: flags(true) });
    expect(d.market?.ext).toEqual({ kr: false, us: true });
    expect(shouldSkipFetch({ at: NOW - 30 * 60_000, market: d.market }, NOW)).toBe(false);
  });

  it("꺼져 있으면 붙이지 않고, 받은 칩에 있던 ext 도 뗀다", async () => {
    const d = await pushWidgetData({ stocks, filled: [], showKrw: false, afterCost: false, fetchedAt: NOW, market: { ...appChip, ext: { kr: false, us: true } }, features: flags(false) });
    expect(d.market).not.toHaveProperty("ext");
  });
});
