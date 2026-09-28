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

describe("로그인이 필요하면 위젯이 적어 둔 개인 데이터로 그리지 않는다 (계정 A단계 검증 지적)", () => {
  const ownerRow = { code: "005930", name: "삼성전자", market: "KOSPI", quantity: 123, avgPrice: 71111, memo: null, createdAt: "x", updatedAt: "x", quote: null };
  const seed = () => {
    h.store.set("widget.lastStocks", JSON.stringify({ at: 1, apiUrl: SERVER, stocks: [ownerRow] }));
    h.store.set("widget.view", JSON.stringify({ apiUrl: SERVER, view: { stocks: [ownerRow], briefings: [], fetchedAt: 1, error: null, filled: [], market: null, indices: null, board: null, features: {} } }));
    h.store.set("widget.payload", JSON.stringify({ at: 1, apiUrl: SERVER, path: "/api/widget?indices=1&sessions=1&ui=2&ms=1", etag: null, body: { v: 1, stocks: [ownerRow], briefings: [] } }));
  };
  // 로그인한 주인 아닌 계정에는 '로그인 필요'가 아니라 '개인 종목 기능은 준비 중' (검증 지적 — 이미 로그인해 있는데 로그인하라고 했다)
  const cases: [string, () => Response, "login" | "personal", string][] = [
    ["401 session_invalid (세션 끊김)", () => new Response(JSON.stringify({ error: "SESSION_INVALID", code: "session_invalid" }), { status: 401 }), "login", "로그인 필요 · 앱에서 로그인"],
    ["403 session_required (로그아웃 뒤)", () => new Response(JSON.stringify({ error: "SESSION_REQUIRED", code: "session_required" }), { status: 403 }), "login", "로그인 필요 · 앱에서 로그인"],
    ["403 personal_data_not_ready (주인 아닌 계정)", () => new Response(JSON.stringify({ error: "PERSONAL_DATA_NOT_READY", code: "personal_data_not_ready" }), { status: 403 }), "personal", "개인 종목 기능은 준비 중"],
  ];
  for (const [label, res, reason, shown] of cases) {
    it(`${label}: 잔고 없이 '${shown}', 마지막 잔고·응답·그린 데이터를 지운다`, async () => {
      seed();
      reply = res;
      const { data } = await freshModules();
      const { failureText } = await import("@/widgets/model");
      const d = await data.loadWidgetData();
      expect(d.stocks).toEqual([]);
      expect(d.error).toBe(reason === "login" ? data.LOGIN_NEEDED : data.PERSONAL_NOT_READY);
      expect(failureText(d.error)).toBe(shown);
      expect(h.store.has("widget.lastStocks")).toBe(false);
      expect(h.store.has("widget.payload")).toBe(false);
      expect(JSON.stringify(await data.loadCachedWidgetData())).not.toContain("삼성전자");
    });
  }

  it("인터넷 오류는 예전처럼 마지막 잔고를 둔다 (로그아웃이 아니다)", async () => {
    seed();
    reply = () => Promise.reject(new TypeError("Network request failed"));
    const { data } = await freshModules();
    const d = await data.loadWidgetData();
    expect(d.stocks.map((s) => s.code)).toEqual(["005930"]);
    expect(h.store.has("widget.lastStocks")).toBe(true);
  });

  it("clearWidgetAccountData: 계정이 바뀌면(앱 루트가 부른다) 적어 둔 개인 데이터를 지우고 손익 보기 설정은 남긴다", async () => {
    seed();
    h.store.set("widget.pnlMode", "day");
    const { data } = await freshModules();
    await data.clearWidgetAccountData();
    for (const k of ["widget.lastStocks", "widget.view", "widget.payload"]) expect(h.store.has(k)).toBe(false);
    expect(h.store.get("widget.pnlMode")).toBe("day");
    expect(data.signedOutWidgetData(5)).toMatchObject({ stocks: [], briefings: [], error: data.LOGIN_NEEDED, fetchedAt: 5 });
  });
});
