import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, createApi } from "@/api/client";
import { connectionKind } from "@/lib/connectionError";
import {
  accountsSeenFor,
  clearSession,
  DEVICE_KEY,
  handleSessionInvalid,
  installSessionStorage,
  isFailOpen,
  lastEndReason,
  loadSession,
  markAccountsSeen,
  markFailOpen,
  onAccountChange,
  persistsPersonal,
  rememberPreference,
  REMEMBER_KEY,
  resetSessionForTests,
  saveSession,
  SESSION_KEY,
  sessionFor,
  sessionHeaders,
  setRememberPreference,
  subscribeSession,
  updateSessionUser,
  type AccountUser,
  type KeyValueStorage,
} from "@/lib/session";

/**
 * 로그인 세션 (계정 A단계). 가장 중요한 규칙: 서버가 401 + session_invalid 를 줄 때만 로그아웃.
 * 인터넷 오류·시간 초과·5xx·예전 서버 404·API 토큰 오류(401 UNAUTHORIZED)·403·429·503 은 세션을 지우지 않는다
 */
const SERVER = "https://prod.test";
const OWNER: AccountUser = { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: true };

function memoryStorage(init: Record<string, string> = {}): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => resetSessionForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  resetSessionForTests();
});

describe("세션 저장 (자동 로그인 켬·끔)", () => {
  it("켬: 기기에 저장해 다시 켜도(OTA·재시작) 그대로, 끔: 메모리에만 — 앱을 완전히 닫으면 없음", async () => {
    const st = memoryStorage();
    installSessionStorage(st);
    await loadSession();
    await saveSession({ apiUrl: `${SERVER}/`, token: "gzs1_on", remember: true, user: OWNER });
    expect(JSON.parse(st.map.get(SESSION_KEY)!)).toMatchObject({ apiUrl: SERVER, token: "gzs1_on", remember: true, user: { loginId: "서성원" } });
    expect(JSON.parse(st.map.get(DEVICE_KEY)!)).toEqual({ apiUrl: SERVER, accountsSeen: true });
    // 앱을 다시 켬 (같은 저장소)
    resetSessionForTests();
    installSessionStorage(st);
    await loadSession();
    expect(sessionFor(SERVER)?.token).toBe("gzs1_on");
    expect(accountsSeenFor(SERVER)).toBe(true);

    // 끔: 저장한 세션은 지우고 메모리에만
    await saveSession({ apiUrl: SERVER, token: "gzs1_off", remember: false, user: OWNER });
    expect(sessionFor(SERVER)?.token).toBe("gzs1_off");
    expect(st.map.has(SESSION_KEY)).toBe(false);
    resetSessionForTests();
    installSessionStorage(st);
    await loadSession();
    expect(sessionFor(SERVER)).toBeNull();
  });

  it("자동 로그인 끔이면 그 서버의 잔고 캐시를 기기에 적지 않는다 (persistsPersonal) — 켬·세션 없음·다른 서버는 지금처럼", async () => {
    installSessionStorage(memoryStorage());
    await loadSession();
    expect(persistsPersonal(SERVER)).toBe(true);
    await saveSession({ apiUrl: SERVER, token: "gzs1_off", remember: false, user: OWNER });
    expect(persistsPersonal(SERVER)).toBe(false);
    expect(persistsPersonal("https://other.test")).toBe(true);
    await saveSession({ apiUrl: SERVER, token: "gzs1_on", remember: true, user: OWNER });
    expect(persistsPersonal(SERVER)).toBe(true);
  });

  it("세션은 준 서버 주소로만 (끝 슬래시는 같은 주소)", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_a", remember: true, user: OWNER });
    expect(sessionFor(`${SERVER}/`)?.token).toBe("gzs1_a");
    expect(sessionFor("https://other.test")).toBeNull();
    expect(await sessionHeaders(SERVER)).toEqual({ "x-session-token": "gzs1_a" });
    expect(await sessionHeaders("https://other.test")).toEqual({});
  });

  it("깨진 저장값은 세션 없음으로 보되 지우지 않는다, 읽기 실패도 지우지 않는다", async () => {
    const st = memoryStorage({ [SESSION_KEY]: "{broken" });
    installSessionStorage(st);
    await loadSession();
    expect(sessionFor(SERVER)).toBeNull();
    expect(st.map.get(SESSION_KEY)).toBe("{broken");
    resetSessionForTests();
    installSessionStorage({ getItem: async () => Promise.reject(new Error("io")), setItem: async () => undefined, removeItem: async () => Promise.reject(new Error("no")) });
    await loadSession();
    expect(sessionFor(SERVER)).toBeNull();
  });

  it("session_invalid 는 보낸 토큰이 지금 토큰일 때만 지운다 (다시 로그인한 뒤 늦게 온 옛 응답은 무시)", async () => {
    const st = memoryStorage();
    installSessionStorage(st);
    await saveSession({ apiUrl: SERVER, token: "gzs1_new", remember: true, user: OWNER });
    expect(handleSessionInvalid(SERVER, "gzs1_old")).toBe(false);
    expect(handleSessionInvalid("https://other.test", "gzs1_new")).toBe(false);
    expect(handleSessionInvalid(SERVER, null)).toBe(false);
    expect(sessionFor(SERVER)?.token).toBe("gzs1_new");
    expect(handleSessionInvalid(SERVER, "gzs1_new")).toBe(true);
    await flush();
    expect(sessionFor(SERVER)).toBeNull();
    expect(st.map.has(SESSION_KEY)).toBe(false);
    expect(lastEndReason()).toBe("invalid");
    // 계정 모드 표시는 남는다 (다음에 로그인 화면)
    expect(accountsSeenFor(SERVER)).toBe(true);
  });

  it("사용자 정보 갱신·직접 로그아웃·자동 로그인 선택 기억·fail-open", async () => {
    const st = memoryStorage();
    installSessionStorage(st);
    await loadSession();
    expect(rememberPreference()).toBe(true);
    setRememberPreference(false);
    await flush();
    expect(st.map.get(REMEMBER_KEY)).toBe("0");
    await saveSession({ apiUrl: SERVER, token: "gzs1_x", remember: true, user: OWNER });
    await updateSessionUser(SERVER, { ...OWNER, usingInitialPassword: false, email: "o@example.com" });
    expect(JSON.parse(st.map.get(SESSION_KEY)!).user).toMatchObject({ usingInitialPassword: false, email: "o@example.com" });
    await updateSessionUser(SERVER, { ...OWNER, id: 99 }); // 다른 사람 정보는 무시
    expect(sessionFor(SERVER)?.user.id).toBe(1);
    await clearSession("logout");
    expect(sessionFor(SERVER)).toBeNull();
    expect(lastEndReason()).toBe("logout");
    markFailOpen(SERVER);
    expect(isFailOpen(SERVER)).toBe(true);
    expect(accountsSeenFor(SERVER)).toBe(false);
    markAccountsSeen(SERVER, true);
    expect(accountsSeenFor(SERVER)).toBe(true);
  });
});

describe("API 요청의 세션 머리글·로그아웃 규칙", () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let reply: () => Response | Promise<Response> = () => new Response("[]", { status: 200 });
  beforeEach(() => {
    calls.length = 0;
    reply = () => new Response("[]", { status: 200 });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      return reply();
    });
  });
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("세션이 있으면 같은 서버 요청에 X-Session-Token (API 토큰도 그대로), 다른 서버·로그인·가입에는 안 붙인다", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_tok", remember: true, user: OWNER });
    await createApi(SERVER, "api-secret").listStocks();
    expect(calls[0]!.headers).toMatchObject({ authorization: "Bearer api-secret", "x-session-token": "gzs1_tok" });
    await createApi("https://other.test", "api-secret").listStocks();
    expect(calls[1]!.headers["x-session-token"]).toBeUndefined();
    reply = json(200, { token: "gzs1_new", user: OWNER, session: { id: 2, remember: true, expiresAt: "" } });
    await createApi(SERVER, "api-secret").login({ loginId: "서성원", password: "1111", remember: true });
    await createApi(SERVER, "api-secret").signup({ loginId: "a", password: "b", passwordConfirm: "b", email: "c", remember: true });
    expect(calls[2]!.headers["x-session-token"]).toBeUndefined();
    expect(calls[3]!.headers["x-session-token"]).toBeUndefined();
    expect(calls[2]!.headers.authorization).toBe("Bearer api-secret");
  });

  it("401 session_invalid 만 로그아웃 (연결 오류가 아님)", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_tok", remember: true, user: OWNER });
    reply = json(401, { error: "SESSION_INVALID", code: "session_invalid", message: "다시 로그인해 주세요" });
    const e = await createApi(SERVER, "").listStocks().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiRequestError);
    expect(e).toMatchObject({ status: 401, code: "SESSION_INVALID", message: "다시 로그인해 주세요" });
    expect(connectionKind(e)).toBeNull();
    await flush();
    expect(sessionFor(SERVER)).toBeNull();
  });

  const keepCases: Array<[string, () => Response | Promise<Response>, number, string]> = [
    ["인터넷 끊김", () => Promise.reject(new TypeError("Network request failed")), 0, "NETWORK"],
    ["서버 500", json(500, { error: "INTERNAL", message: "서버 오류" }), 500, "INTERNAL"],
    ["배포 중 502 (본문 없음)", () => new Response("Bad Gateway", { status: 502 }), 502, "HTTP_502"],
    ["세션 확인 잠시 불가 503", json(503, { error: "AUTH_UNAVAILABLE", code: "auth_unavailable", message: "잠시 뒤" }), 503, "AUTH_UNAVAILABLE"],
    ["예전 서버 404", json(404, { error: "NOT_FOUND", message: "없는 주소" }), 404, "NOT_FOUND"],
    ["API 토큰 틀림 401 UNAUTHORIZED", json(401, { error: "UNAUTHORIZED", message: "API 토큰이 필요합니다" }), 401, "UNAUTHORIZED"],
    ["주인 아닌 계정 403", json(403, { error: "PERSONAL_DATA_NOT_READY", code: "personal_data_not_ready", message: "준비 중" }), 403, "PERSONAL_DATA_NOT_READY"],
    ["너무 잦음 429", json(429, { error: "TOO_MANY_ATTEMPTS", code: "too_many_attempts", message: "잠시 뒤" }), 429, "TOO_MANY_ATTEMPTS"],
    ["401 인데 code 없음", json(401, { error: "SOMETHING" }), 401, "SOMETHING"],
  ];
  for (const [name, r, status, code] of keepCases) {
    it(`로그아웃하지 않음: ${name}`, async () => {
      await saveSession({ apiUrl: SERVER, token: "gzs1_keep", remember: true, user: OWNER });
      reply = r;
      const e = await createApi(SERVER, "").listStocks().catch((x: unknown) => x);
      expect(e).toMatchObject({ status, code });
      await flush();
      expect(sessionFor(SERVER)?.token).toBe("gzs1_keep");
    });
  }

  it("403 session_required 는 이 서버가 계정 모드라고 기억만 한다 (지울 세션 없음)", async () => {
    reply = json(403, { error: "SESSION_REQUIRED", code: "session_required", message: "로그인이 필요해요" });
    const e = await createApi(SERVER, "").listStocks().catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 403, code: "SESSION_REQUIRED" });
    expect(connectionKind(e)).toBeNull();
    expect(accountsSeenFor(SERVER)).toBe(true);
  });

  it("오류 본문(칸별 오류 fields)을 화면이 읽을 수 있다", async () => {
    reply = json(400, { error: "INVALID", code: "invalid", message: "확인", fields: { loginId: "login_id_format" } });
    const e = (await createApi(SERVER, "").signup({ loginId: "x", password: "", passwordConfirm: "", email: "", remember: true }).catch((x: unknown) => x)) as ApiRequestError;
    expect(e.body).toMatchObject({ code: "invalid", fields: { loginId: "login_id_format" } });
  });
});

describe("계정이 바뀔 때 (캐시·위젯 데이터 비우기, 계정 A단계 검증 지적)", () => {
  const MEMBER: AccountUser = { id: 7, loginId: "newbie", email: "n@example.com", isOwner: false, usingInitialPassword: false };
  it("다른 사람으로 로그인·로그아웃·세션 끊김이면 화면에 알리기(emit) **전에** 동기로 부른다. 같은 사람이 다시 로그인·켤 때 읽어 오기는 바뀜이 아니다", async () => {
    resetSessionForTests();
    installSessionStorage(memoryStorage({ [SESSION_KEY]: JSON.stringify({ apiUrl: SERVER, token: "gzs1_o", remember: true, user: OWNER, savedAt: 1 }) }));
    const order: string[] = [];
    const off = onAccountChange((next, prev) => order.push(`hook:${prev?.user.loginId ?? "-"}>${next?.user.loginId ?? "-"}`));
    subscribeSession(() => order.push("emit"));
    await loadSession();
    expect(order).toEqual(["emit"]);
    order.length = 0;
    // 같은 사람(주인)이 다시 로그인: 캐시를 버리지 않는다
    await saveSession({ apiUrl: SERVER, token: "gzs1_o2", remember: true, user: OWNER });
    expect(order).toEqual(["emit"]);
    order.length = 0;
    await clearSession("logout");
    expect(order).toEqual(["hook:서성원>-", "emit"]);
    order.length = 0;
    // 자동 로그인을 끈 채 앱을 닫아 세션이 없던 기기에 다른 사람이 로그인: 기기에 남은 캐시는 앞 사람 것일 수 있다
    await saveSession({ apiUrl: SERVER, token: "gzs1_m", remember: false, user: MEMBER });
    expect(order).toEqual(["hook:->newbie", "emit"]);
    order.length = 0;
    expect(handleSessionInvalid(SERVER, "gzs1_m")).toBe(true);
    expect(order).toEqual(["hook:newbie>-", "emit"]);
    off();
    await saveSession({ apiUrl: SERVER, token: "gzs1_o3", remember: true, user: OWNER });
    expect(order.filter((x) => x.startsWith("hook"))).toHaveLength(1);
  });

  it("비우는 쪽이 실패해도 로그인·로그아웃은 된다", async () => {
    resetSessionForTests();
    const off = onAccountChange(() => {
      throw new Error("비우기 실패");
    });
    await saveSession({ apiUrl: SERVER, token: "gzs1_x", remember: true, user: OWNER });
    expect(sessionFor(SERVER)?.token).toBe("gzs1_x");
    off();
  });
});
