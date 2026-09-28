import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 위젯·백그라운드 작업의 로그인 세션 (계정 A단계). 앱과 다른 JS 로 켜져도 기기에 저장한 세션(자동 로그인 켬)으로 묻고,
 * 서버가 401 session_invalid 를 줄 때만 저장한 세션을 지운다 (인터넷 오류·5xx 는 그대로)
 */
const SERVER = "https://server.test";
const h = vi.hoisted(() => ({ store: new Map<string, string>(), calls: [] as { url: string; headers: Record<string, string> }[] }));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, h.store.get(k) ?? null]),
    multiSet: async (pairs: [string, string][]) => void pairs.forEach(([k, v]) => h.store.set(k, v)),
  },
}));

const session = { apiUrl: SERVER, token: "gzs1_saved", remember: true, user: { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: false }, savedAt: 1 };
let reply: () => Response | Promise<Response> = () => new Response("[]", { status: 200 });

async function freshModules() {
  vi.resetModules();
  const s = await import("@/lib/session");
  const data = await import("@/widgets/data");
  const summaries = await import("@/lib/marketSummaryLoad");
  return { s, data, summaries };
}

beforeEach(() => {
  h.store.clear();
  h.calls = [];
  h.store.set("settings.apiUrl", SERVER);
  h.store.set("settings.apiToken", "api-secret");
  h.store.set("auth.session.v1", JSON.stringify(session));
  reply = () => new Response("[]", { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    h.calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return reply();
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("위젯·백그라운드의 세션", () => {
  it("기기에 저장한 세션을 머리글로 (앱을 켜지 않고 위젯만 돌아도)", async () => {
    const { data } = await freshModules();
    await data.loadLatestBriefings();
    expect(h.calls[0]!.headers).toMatchObject({ authorization: "Bearer api-secret", "x-session-token": "gzs1_saved" });
  });

  it("백그라운드 시장 요약도 세션을 붙인다", async () => {
    // 앱이 마지막으로 받은 플래그(기기 저장 캐시)에 marketSummary 가 켜져 있을 때만 묻는다
    h.store.set("rq.cache", JSON.stringify({ clientState: { queries: [{ queryKey: [SERVER, "features"], state: { data: { features: { marketSummary: true } } } }] } }));
    const { summaries } = await freshModules();
    await summaries.loadMarketSummaries();
    expect(h.calls[0]!.url).toBe(`${SERVER}/api/market-summaries?limit=4`);
    expect(h.calls[0]!.headers["x-session-token"]).toBe("gzs1_saved");
  });

  it("인터넷 오류·5xx·API 토큰 401 에는 세션을 지우지 않는다", async () => {
    const { data } = await freshModules();
    for (const r of [() => Promise.reject(new TypeError("Network request failed")), () => new Response("err", { status: 502 }), () => new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 })]) {
      reply = r;
      await data.loadLatestBriefings().catch(() => undefined);
      expect(h.store.has("auth.session.v1")).toBe(true);
    }
  });

  it("401 session_invalid 면 저장한 세션을 지운다 (앱과 같은 규칙)", async () => {
    const { data, s } = await freshModules();
    reply = () => new Response(JSON.stringify({ error: "SESSION_INVALID", code: "session_invalid", message: "다시 로그인해 주세요" }), { status: 401 });
    await expect(data.loadLatestBriefings()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.store.has("auth.session.v1")).toBe(false);
    expect(s.sessionFor(SERVER)).toBeNull();
  });
});
