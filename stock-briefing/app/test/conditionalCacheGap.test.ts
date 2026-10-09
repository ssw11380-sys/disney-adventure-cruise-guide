import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";
import { condGet, condKey, condReset } from "@/api/condCache";
import { resetSessionForTests } from "@/lib/session";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));

beforeEach(() => { condReset(); resetSessionForTests(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T17:00:00+09:00")); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const A = "https://server-a.test";
const B = "https://server-b.test";
const json = (body: unknown, etag: string) => new Response(JSON.stringify(body), { headers: { etag } });

describe("조건부 캐시의 서버 전환과 많은 종목 순회", () => {
  it("두 서버의 같은 경로와 같은 ETag도 본문을 섞지 않고 각 서버의 기억을 쓴다", async () => {
    const requests: { host: string; etag: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const host = new URL(url).origin;
      const etag = new Headers(init.headers).get("if-none-match");
      requests.push({ host, etag });
      return etag ? new Response(null, { status: 304 }) : json([{ code: host === A ? "005930" : "TSLA" }], '"same-tag"');
    });
    const a = createApi(A, "", { saver: () => true });
    const b = createApi(B, "", { saver: () => true });
    expect(await a.listStocks()).toEqual([{ code: "005930" }]);
    expect(await b.listStocks()).toEqual([{ code: "TSLA" }]);
    expect(await a.listStocks()).toEqual([{ code: "005930" }]);
    expect(await b.listStocks()).toEqual([{ code: "TSLA" }]);
    expect(requests).toEqual([{ host: A, etag: null }, { host: B, etag: null }, { host: A, etag: '"same-tag"' }, { host: B, etag: '"same-tag"' }]);
  });

  it("캐시 한도를 넘는 종목을 순회해도 최근 종목은 유지하고 퇴출된 종목은 한 번의 전체 조회로 정확히 복구한다", async () => {
    const requests: { code: string; etag: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const code = new URL(url).pathname.split("/").at(-1)!;
      const etag = new Headers(init.headers).get("if-none-match");
      requests.push({ code, etag });
      return etag ? new Response(null, { status: 304 }) : json({ code, name: `종목${code}`, quote: { price: Number(code) } }, `"${code}"`);
    });
    const api = createApi(A, "", { saver: () => true });
    for (let i = 1; i <= 40; i++) await api.getStock(String(i));
    expect((await api.getStock("1")).quote?.price).toBe(1);
    await api.getStock("41");
    expect(condGet(condKey(A, "/api/stocks/2"))).toBeNull();
    expect(condGet(condKey(A, "/api/stocks/1"))).not.toBeNull();
    expect((await api.getStock("2")).quote?.price).toBe(2);
    expect(requests.at(-1)).toEqual({ code: "2", etag: null });
    expect(requests).toHaveLength(43);
    expect(Array.from({ length: 41 }, (_, i) => condGet(condKey(A, `/api/stocks/${i + 1}`))).filter(Boolean)).toHaveLength(40);
  });
});
