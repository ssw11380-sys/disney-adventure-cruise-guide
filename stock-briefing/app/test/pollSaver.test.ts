import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { condReset, condStats } from "@/api/condCache";
import { ApiRequestError, createApi } from "@/api/client";
import { pollInterval } from "@/lib/freshness";
import { applyJson, jsonHash, type Json } from "@/lib/jsonDelta";
import { capToBoundary } from "@/lib/liveDot";
import { reconnectMax } from "@/lib/liveStream";
import { resetPollBackoff, SAVER, saverInterval, saverLabel, unchangedStreak } from "@/lib/pollSaver";

/**
 * 끊겼을 때 데이터 절약 (플래그 pollSaver, 3-25 성능-16) — 앱 쪽.
 *  - 304 면 기억한 값 그대로(새 객체), 226 이면 기억한 값 + 차이 → 서버 해시가 맞을 때만. 틀리면 전체를 다시 받는다 (옛 값이 남지 않게)
 *  - 끄면 요청·응답 처리가 예전과 똑같다
 *  - 폴링 주기: 값이 그대로면 3초→4초(화면 지연 5초 안), 장이 닫히면 5분(경계에서 바로), 실패·스트림은 예전 그대로
 */

vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "https://server.test", apiToken: "", ready: true }) }));

const BASE = "https://server.test";

interface Seen {
  path: string;
  inm: string | null;
  aim: string | null;
}

/** 가짜 서버: 경로마다 (보낸 요청 → 응답) 을 차례로 준다 */
function server(replies: ((s: Seen) => Response)[]) {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    const s = { path: new URL(url).pathname + new URL(url).search, inm: h.get("if-none-match"), aim: h.get("a-im") };
    seen.push(s);
    const next = replies.shift();
    if (!next) throw new Error("응답이 더 없음");
    return next(s);
  });
  return seen;
}
const full = (body: unknown, etag?: string) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...(etag ? { etag } : {}) } });
const same = () => () => new Response(null, { status: 304, headers: { etag: '"e1"' } });
const delta = (base: string, etag: string, next: Json, patch: Json, h = jsonHash(next)) => () =>
  new Response(JSON.stringify({ $im: "json-delta", base, etag, h, p: patch }), { status: 226, headers: { "content-type": "application/json", etag, im: "json-delta" } });

const list0 = [
  { code: "005930", quote: { price: 84300, asOf: "2026-09-28T10:00:00+09:00" }, evaluation: { marketValue: 843000 } },
  { code: "AAPL", quote: { price: 254.4, asOf: "2026-09-28T10:00:01+09:00" }, evaluation: null },
];
const list1 = [{ ...list0[0]!, quote: { price: 84400, asOf: "2026-09-28T10:00:03+09:00" }, evaluation: { marketValue: 844000 } }, list0[1]!];
const patch01 = { "#": { "0": { quote: { price: 84400, asOf: "2026-09-28T10:00:03+09:00" }, evaluation: { marketValue: 844000 } } } };

beforeEach(() => condReset());
afterEach(() => vi.unstubAllGlobals());

describe("JSON 차이 적용 (서버와 같은 규칙)", () => {
  it("공용 픽스처: 서버 패치를 적용하면 다음 값과 같고, 해시도 서버와 같다", () => {
    const cases = JSON.parse(readFileSync(new URL("../../shared/fixtures/jsonDelta.json", import.meta.url), "utf8")) as { name: string; base: Json; next: Json; patch: Json; hash: string; baseHash: string }[];
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      const got = applyJson(c.base, c.patch);
      expect(got, c.name).toEqual(c.next);
      expect(jsonHash(got), c.name).toBe(c.hash);
      expect(jsonHash(c.base), c.name).toBe(c.baseHash);
    }
  });
});

describe("조건부 요청 (createApi saver)", () => {
  it("끄면(saver 없음·false): If-None-Match·A-IM 을 보내지 않고, 서버가 ETag 를 줘도 기억하지 않는다 (예전과 같음)", async () => {
    const seen = server([full(list0, '"e0"'), full(list1, '"e1"')]);
    const api = createApi(BASE, "", { saver: () => false });
    expect(await api.listStocks()).toEqual(list0);
    expect(await api.listStocks()).toEqual(list1);
    expect(seen.map((s) => [s.inm, s.aim])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(condStats().recent).toBe(0);
  });

  it("304: 기억한 값을 새 객체로 준다 — 화면이 받은 객체를 고쳐도 다음 304 값은 서버 값 그대로", async () => {
    const seen = server([full(list0, '"e0"'), () => new Response(null, { status: 304 }), () => new Response(null, { status: 304 })]);
    const api = createApi(BASE, "", { saver: () => true });
    const a = (await api.listStocks()) as unknown as typeof list0;
    const b = (await api.listStocks()) as unknown as typeof list0;
    expect(b).toEqual(list0);
    expect(b).not.toBe(a);
    b[0]!.quote.price = 1; // 누가 고쳐도
    expect(await api.listStocks()).toEqual(list0);
    expect(seen.slice(1).map((s) => [s.inm, s.aim])).toEqual([
      ['"e0"', "json-delta"],
      ['"e0"', "json-delta"],
    ]);
  });

  it("226: 기억한 값에 차이를 적용해 새 값, 다음 요청은 새 ETag 로", async () => {
    const seen = server([full(list0, '"e0"'), delta('"e0"', '"e1"', list1 as unknown as Json, patch01), () => new Response(null, { status: 304 })]);
    const api = createApi(BASE, "", { saver: () => true });
    await api.listStocks();
    expect(await api.listStocks()).toEqual(list1);
    expect(await api.listStocks()).toEqual(list1);
    expect(seen[2]!.inm).toBe('"e1"');
    expect(condStats()).toMatchObject({ recent: 3, full: 1, delta: 1, same: 1 });
  });

  it("해시가 다르면(옛 값이 섞일 위험) 차이를 버리고 조건 없이 전체를 다시 받는다", async () => {
    const seen = server([full(list0, '"e0"'), delta('"e0"', '"e1"', list1 as unknown as Json, patch01, "00000000"), full(list1, '"e1"')]);
    const api = createApi(BASE, "", { saver: () => true });
    await api.listStocks();
    expect(await api.listStocks()).toEqual(list1);
    expect(seen[2]).toMatchObject({ inm: null, aim: null });
    expect(condStats().totals.resync).toBe(1);
  });

  it("기준(base)이 기억한 ETag 와 다르거나 적용할 수 없는 차이·기억에 없는 304 도 전체를 다시 받는다", async () => {
    const api = createApi(BASE, "", { saver: () => true });
    let seen = server([full(list0, '"e0"'), delta('"zz"', '"e1"', list1 as unknown as Json, patch01), full(list1, '"e1"')]);
    await api.listStocks();
    expect(await api.listStocks()).toEqual(list1);
    expect(seen[2]!.inm).toBeNull();

    condReset();
    seen = server([full(list0, '"e0"'), delta('"e0"', '"e1"', list1 as unknown as Json, { "#": { "7": 1 } }), full(list1, '"e1"')]);
    await api.listStocks();
    expect(await api.listStocks()).toEqual(list1);
    expect(seen[2]!.inm).toBeNull();

    condReset();
    seen = server([same(), full(list1, '"e1"')]);
    expect(await api.listStocks()).toEqual(list1);
    expect(seen.map((s) => s.inm)).toEqual([null, null]);
  });

  it("예전 서버(ETag 없음)면 기억하지 않아 계속 전체 요청", async () => {
    const seen = server([full(list0), full(list0)]);
    const api = createApi(BASE, "", { saver: () => true });
    await api.listStocks();
    await api.listStocks();
    expect(seen.map((s) => s.inm)).toEqual([null, null]);
  });

  it("서버 오류는 예전처럼 ApiRequestError, 기억한 값은 그대로 두어 다음에 304 를 받을 수 있다", async () => {
    const seen = server([full(list0, '"e0"'), () => new Response(JSON.stringify({ error: "UPSTREAM", message: "출처 실패" }), { status: 502 }), () => new Response(null, { status: 304 })]);
    const api = createApi(BASE, "", { saver: () => true });
    await api.listStocks();
    await expect(api.listStocks()).rejects.toBeInstanceOf(ApiRequestError);
    expect(await api.listStocks()).toEqual(list0);
    expect(seen[2]!.inm).toBe('"e0"');
  });

  it("조건부는 자주 묻는 GET 만 (잔고·상세·지수·장 상태·플래그·/health) — 차트·분석·쓰기는 예전 그대로", async () => {
    const replies = Array.from({ length: 16 }, () => full({ ok: 1 }, '"x"'));
    const seen = server(replies);
    const api = createApi(BASE, "", { saver: () => true });
    for (let i = 0; i < 2; i++) {
      await api.health();
      await api.listStocks();
      await api.getStock("005930");
      await api.features();
      await api.marketStatus();
      await api.marketIndices();
      await api.getCandles("005930", "D", 120);
      await api.getStockNews("005930");
    }
    const second = seen.slice(8);
    expect(second.filter((s) => s.inm === '"x"').map((s) => s.path)).toEqual(["/health", "/api/stocks?quotes=1", "/api/stocks/005930", "/api/features", "/api/market/status", "/api/market/indices?stale=1"]);
    expect(second.filter((s) => s.inm === null).map((s) => s.path)).toEqual(["/api/stocks/005930/candles?period=D&count=120", "/api/stocks/005930/news"]);
  });
});

describe("폴링 주기 (saverInterval)", () => {
  it("장중·스트림 없음: 3초, 연달아 2번 그대로면 4초 · 값이 바뀌면 다시 3초", () => {
    const o = { open: true, streamFresh: false, failing: false };
    expect(saverInterval({ ...o, unchanged: 0 })).toBe(3_000);
    expect(saverInterval({ ...o, unchanged: 1 })).toBe(3_000);
    expect(saverInterval({ ...o, unchanged: 2 })).toBe(4_000);
    expect(saverInterval({ ...o, unchanged: 50 })).toBe(4_000);
  });

  it("화면 지연 5초 이하: 늦춘 주기(4초) + 응답 시간(1초 안)이 5초를 넘지 않는다", () => {
    expect(SAVER.quietMs + 1_000).toBeLessThanOrEqual(5_000);
  });

  it("실패·스트림은 예전 그대로, 장이 닫히면 5분(다음 세션 경계 1초 뒤에는 바로)", () => {
    for (const unchanged of [0, 5]) {
      expect(saverInterval({ open: true, streamFresh: false, failing: true, unchanged })).toBe(pollInterval({ open: true, streamFresh: false, failing: true }));
      expect(saverInterval({ open: false, streamFresh: false, failing: true, unchanged })).toBe(pollInterval({ open: false, streamFresh: false, failing: true }));
      expect(saverInterval({ open: true, streamFresh: true, failing: false, unchanged })).toBe(pollInterval({ open: true, streamFresh: true, failing: false }));
      expect(saverInterval({ open: false, streamFresh: false, failing: false, unchanged })).toBe(5 * 60_000);
    }
    // 08:58 에 닫혀 있어도 09:00 개장 1초 뒤에는 받는다 (5분을 기다리지 않음)
    const now = Date.parse("2026-09-28T08:58:00+09:00");
    const open = Date.parse("2026-09-28T09:00:00+09:00");
    expect(capToBoundary(SAVER.closedMs, open, now)).toBe(2 * 60_000 + 1_000);
  });

  it("연달아 그대로인 받기 수: 받을 때마다(dataUpdateCount) 같은 객체면 +1, 새 값이면 0, 사용자가 돌아오면 0", () => {
    const data0 = { v: 1 };
    const q = { state: { dataUpdateCount: 1, data: data0 as unknown } };
    expect(unchangedStreak(q)).toBe(0);
    expect(unchangedStreak(q)).toBe(0); // 받지 않았으면 그대로 (여러 번 불려도)
    q.state = { dataUpdateCount: 2, data: data0 };
    expect(unchangedStreak(q)).toBe(1);
    q.state = { dataUpdateCount: 3, data: data0 };
    expect(unchangedStreak(q)).toBe(2);
    expect(unchangedStreak(q)).toBe(2);
    q.state = { dataUpdateCount: 4, data: { v: 2 } };
    expect(unchangedStreak(q)).toBe(0);
    const d = q.state.data;
    q.state = { dataUpdateCount: 5, data: d };
    q.state = { dataUpdateCount: 6, data: d };
    expect(unchangedStreak(q)).toBe(1);
    resetPollBackoff();
    expect(unchangedStreak(q)).toBe(0);
  });

  it("react-query 구조 공유: 304 로 같은 값을 받으면 같은 객체라 그대로로 센다", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let n = 0;
    const bodies = [list0, JSON.parse(JSON.stringify(list0)), JSON.parse(JSON.stringify(list0)), list1];
    const fetchIt = () => qc.fetchQuery({ queryKey: ["s"], queryFn: async () => bodies[n++], staleTime: 0 });
    const q = () => qc.getQueryCache().find({ queryKey: ["s"] })!;
    await fetchIt();
    const streak = () => unchangedStreak(q() as unknown as { state: { dataUpdateCount: number; data: unknown } });
    expect(streak()).toBe(0);
    await fetchIt();
    expect(streak()).toBe(1);
    await fetchIt();
    expect(streak()).toBe(2);
    await fetchIt();
    expect(streak()).toBe(0);
    qc.clear();
  });
});

describe("웹소켓 다시 붙기 상한·설정 줄", () => {
  it("pollSaver 가 켜져 있으면 2분, 아니면 예전 30초", () => {
    const qc = new QueryClient();
    expect(reconnectMax(qc, BASE)).toBe(30_000);
    qc.setQueryData([BASE, "features"], { features: { pollSaver: false } });
    expect(reconnectMax(qc, BASE)).toBe(30_000);
    qc.setQueryData([BASE, "features"], { features: { pollSaver: true } });
    expect(reconnectMax(qc, BASE)).toBe(120_000);
  });

  it("설정 '시세 받기' 줄", () => {
    expect(saverLabel({ recent: 0, same: 0, delta: 0, full: 0 })).toBe("아직 없음");
    expect(saverLabel({ recent: 200, same: 124, delta: 60, full: 16 })).toBe("변화 없음 62% · 바뀐 것만 30% · 전체 8%");
    expect(saverLabel({ recent: 200, same: 124, delta: 60, full: 16, totals: { resync: 0 } })).toBe("변화 없음 62% · 바뀐 것만 30% · 전체 8%");
    expect(saverLabel({ recent: 10, same: 5, delta: 3, full: 2, totals: { resync: 1 } })).toBe("변화 없음 50% · 바뀐 것만 30% · 전체 20% · 다시 받음 1");
  });
});
