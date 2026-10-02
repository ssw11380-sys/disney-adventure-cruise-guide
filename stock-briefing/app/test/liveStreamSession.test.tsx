import React from "react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markAccountsSeen, resetSessionForTests, saveSession, type AccountUser } from "@/lib/session";
import { streamUrl } from "@/lib/liveTick";
import { cleanupRenders, render } from "./miniRender";

/**
 * 실시간 스트림과 로그인 세션 (계정 A단계).
 *  - 주인 세션: 웹소켓 머리글에 X-Session-Token (안드로이드), 웹은 ?session=
 *  - 주인 아닌 계정: 스트림을 열지 않는다 (등록 종목·잔고 변경은 주인 것 — 서버도 403)
 *  - 계정 모드인데 로그인 전: 로그인할 때까지 붙지 않는다
 *  - 계정을 쓰지 않는 서버: 지금과 같다 (세션 머리글 없음)
 */
const SERVER = "https://server.test";
const OWNER: AccountUser = { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: false };
const h = vi.hoisted(() => ({ os: "android", qc: null as unknown }));

vi.mock("react-native", () => ({
  get Platform() {
    return { OS: h.os };
  },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: SERVER, apiToken: "api-secret", ready: true }) }));
vi.mock("@tanstack/react-query", async (orig) => ({ ...(await orig<object>()), useQueryClient: () => h.qc }));

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols?: unknown,
    readonly options?: { headers?: Record<string, string> },
  ) {
    FakeWS.all.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

const { LiveStreamProvider } = await import("@/lib/liveStream");
const mount = () => render(<LiveStreamProvider>{null}</LiveStreamProvider>);
const settle = async (r: ReturnType<typeof render>) => {
  await Promise.resolve();
  r.rerender();
};

beforeEach(() => {
  cleanupRenders();
  resetSessionForTests();
  FakeWS.all = [];
  h.os = "android";
  h.qc = new QueryClient();
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  cleanupRenders();
  vi.unstubAllGlobals();
  resetSessionForTests();
});

describe("실시간 스트림과 로그인 세션", () => {
  it("계정을 쓰지 않는 서버: 지금처럼 API 토큰만", () => {
    mount();
    expect(FakeWS.all).toHaveLength(1);
    expect(FakeWS.all[0]!.options).toEqual({ headers: { authorization: "Bearer api-secret" } });
    expect(FakeWS.all[0]!.url).toBe("wss://server.test/api/stream?token=api-secret");
  });

  it("주인 세션: 머리글에 세션 (주소에는 넣지 않음)", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_owner", remember: true, user: OWNER });
    mount();
    expect(FakeWS.all).toHaveLength(1);
    expect(FakeWS.all[0]!.options).toEqual({ headers: { authorization: "Bearer api-secret", "x-session-token": "gzs1_owner" } });
    expect(FakeWS.all[0]!.url).not.toContain("session=");
  });

  it("웹은 머리글을 못 붙여 ?session=", async () => {
    h.os = "web";
    await saveSession({ apiUrl: SERVER, token: "gzs1_owner", remember: true, user: OWNER });
    mount();
    expect(FakeWS.all[0]!.url).toBe("wss://server.test/api/stream?token=api-secret&session=gzs1_owner");
    expect(streamUrl(SERVER, "", "a b")).toBe("wss://server.test/api/stream?session=a%20b");
    expect(streamUrl(SERVER, "")).toBe("wss://server.test/api/stream");
  });

  it("주인 아닌 계정은 열지 않는다", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_member", remember: true, user: { ...OWNER, id: 9, isOwner: false } });
    mount();
    expect(FakeWS.all).toHaveLength(0);
  });

  it("계정 모드인데 로그인 전이면 기다렸다가, 주인이 로그인하면 붙는다", async () => {
    markAccountsSeen(SERVER, true);
    const r = mount();
    expect(FakeWS.all).toHaveLength(0);
    await saveSession({ apiUrl: SERVER, token: "gzs1_owner", remember: true, user: OWNER });
    await settle(r);
    expect(FakeWS.all).toHaveLength(1);
    expect(FakeWS.all[0]!.options?.headers?.["x-session-token"]).toBe("gzs1_owner");
  });
});
