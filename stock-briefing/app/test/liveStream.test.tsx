import React from "react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 실시간 웹소켓 연결 관리 (BH-15). RN 안드로이드 WebSocket 동작을 흉내 낸 가짜 소켓으로 실제 LiveStreamProvider 를 그린다.
 *  - 연결 중(CONNECTING) 소켓의 close() 는 네이티브가 무시한다 (연결이 끝나야 네이티브 맵에 들어가서). 나중에 열리면 readyState 가 OPEN 으로 돌아가고 open 이 온다
 *  - 열린 소켓의 close() 는 close 핸드셰이크를 거쳐 나중에 close 가 온다 (죽은 망에서는 오래 걸린다)
 */
const h = vi.hoisted(() => ({
  app: { currentState: "active" as string, listeners: [] as ((s: string) => void)[] },
  qc: null as unknown,
  settings: { apiUrl: "https://server.test", apiToken: "", ready: true },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    get currentState() {
      return h.app.currentState;
    },
    addEventListener: (_: string, fn: (s: string) => void) => {
      h.app.listeners.push(fn);
      return { remove: () => void (h.app.listeners = h.app.listeners.filter((f) => f !== fn)) };
    },
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("@/lib/settings", () => ({ useSettings: () => h.settings }));
vi.mock("@tanstack/react-query", async (orig) => ({ ...(await orig<object>()), useQueryClient: () => h.qc }));

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  /** 앱이 close() 를 불렀고 네이티브가 실제로 닫기 시작했다 (열린 소켓만) */
  closing = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("INVALID_STATE_ERR");
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 1) this.closing = true;
    // 연결 중이면 네이티브가 모르는 소켓이라 아무 일도 없다 (JS 쪽 readyState 만 CLOSING)
    if (this.readyState < 2) this.readyState = 2;
  }
  // ── 네이티브에서 오는 이벤트 ──
  open() {
    this.readyState = 1; // CLOSING 이었어도 OPEN 으로 돌아간다 (RN WebSocket.js websocketOpen)
    this.onopen?.();
  }
  message(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  closed() {
    this.readyState = 3;
    this.onclose?.();
  }
  /** 서버 입장에서 아직 붙어 있는 소켓 (열렸고 닫기 시작하지 않음) */
  get alive() {
    return this.readyState === 1 && !this.closing;
  }
}

const { LiveStreamProvider, useLiveStream } = await import("@/lib/liveStream");

let seen: { connected: boolean } = { connected: false };
function Probe() {
  seen = useLiveStream();
  return null;
}
const setAppState = (r: ReturnType<typeof render>, s: string) =>
  r.act(() => {
    h.app.currentState = s;
    for (const fn of [...h.app.listeners]) fn(s);
  });

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.all = [];
  h.app.currentState = "active";
  h.app.listeners = [];
  h.qc = new QueryClient();
  h.settings = { apiUrl: "https://server.test", apiToken: "", ready: true };
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = () =>
  render(
    <LiveStreamProvider>
      <Probe />
    </LiveStreamProvider>,
  );

describe("BH-15: 연결 중에 닫은 소켓이 나중에 열려도 좀비로 남지 않는다", () => {
  it("핸드셰이크 중 앱이 뒤로 가면, 늦게 열린 소켓을 바로 닫고 연결됨으로 보이지 않는다 (재현)", () => {
    const r = mount();
    const ws1 = FakeWS.all[0]!;
    expect(ws1.readyState).toBe(0);
    setAppState(r, "background");
    r.act(() => ws1.open()); // 뒤에서 핸드셰이크가 끝남
    expect(seen.connected).toBe(false);
    expect(ws1.sent).toEqual([]); // hello 를 보내지 않는다
    expect(ws1.alive).toBe(false); // 열리자마자 닫는다 → 서버 폴링이 멈춘다
    // 좀비가 보낸 체결로 캐시를 고치지 않는다
    const spy = vi.spyOn(h.qc as QueryClient, "setQueriesData");
    r.act(() => ws1.message({ type: "ticks", ticks: [{ type: "tick", code: "005930", price: 70000, change: 0, changeRate: 0, timestamp: new Date().toISOString() }] }));
    expect(spy).not.toHaveBeenCalled();
    // 앞으로 돌아오면 새 소켓 하나만 살아 있다
    setAppState(r, "active");
    const ws2 = FakeWS.all[1]!;
    r.act(() => ws2.open());
    expect(seen.connected).toBe(true);
    setAppState(r, "background");
    expect(FakeWS.all.filter((w) => w.alive)).toEqual([]);
  });

  it("옛 소켓의 close 가 새 연결이 열린 뒤 늦게 와도 새 연결을 끊김으로 굳히지 않는다", () => {
    const r = mount();
    const ws1 = FakeWS.all[0]!;
    r.act(() => ws1.open());
    expect(seen.connected).toBe(true);
    setAppState(r, "background"); // 열린 소켓 → close 핸드셰이크 시작 (close 이벤트는 나중)
    setAppState(r, "active");
    const ws2 = FakeWS.all[1]!;
    r.act(() => ws2.open());
    expect(seen.connected).toBe(true);
    r.act(() => ws1.closed()); // 옛 소켓 close 가 늦게 옴
    expect(seen.connected).toBe(true);
    r.act(() => vi.advanceTimersByTime(30_000));
    r.act(() => ws2.message({ type: "ping" }));
    expect(seen.connected).toBe(true);
    expect(FakeWS.all).toHaveLength(2); // 쓸데없이 다시 붙지도 않는다
  });

  it("연결 중에 닫힌 옛 소켓이 늦게 열려도 새 소켓의 감시 타이머를 다시 걸지 않는다 — 새 소켓이 죽으면 다시 붙는다", () => {
    const r = mount();
    const ws1 = FakeWS.all[0]!;
    setAppState(r, "background");
    setAppState(r, "active");
    const ws2 = FakeWS.all[1]!;
    r.act(() => ws2.open());
    r.act(() => ws1.open());
    // ws2 는 아무 메시지도 없이 죽었고 ws1(좀비)만 ping 을 받는다
    for (let i = 0; i < 3; i++) {
      r.act(() => vi.advanceTimersByTime(20_000));
      r.act(() => ws1.message({ type: "ping" }));
    }
    expect(ws2.closing).toBe(true); // 감시 타이머(45초)가 죽은 ws2 를 닫는다
  });

  it("연결 중에 서버 주소가 바뀌어도 옛 주소 소켓은 열리자마자 닫히고, 그 close 가 새 연결을 끊김으로 만들지 않는다", () => {
    const r = mount();
    const ws1 = FakeWS.all[0]!;
    h.settings = { ...h.settings, apiUrl: "https://other.test" };
    r.rerender();
    const ws2 = FakeWS.all[1]!;
    expect(ws2.url).toContain("other.test");
    r.act(() => ws2.open());
    r.act(() => ws1.open());
    expect(ws1.alive).toBe(false);
    expect(ws1.sent).toEqual([]);
    r.act(() => ws1.closed());
    expect(seen.connected).toBe(true);
  });

  it("감시 타이머가 죽은 연결을 닫으면 닫기 핸드셰이크를 기다리지 않고 다시 붙는다", () => {
    const r = mount();
    const ws1 = FakeWS.all[0]!;
    r.act(() => ws1.open());
    r.act(() => vi.advanceTimersByTime(45_000));
    expect(ws1.closing).toBe(true);
    expect(seen.connected).toBe(false);
    r.act(() => vi.advanceTimersByTime(1_000));
    const ws2 = FakeWS.all[1]!;
    r.act(() => ws2.open());
    r.act(() => ws1.closed()); // 죽은 망에서 한참 뒤에 온 close
    expect(seen.connected).toBe(true);
  });

  it("정상 흐름: 열리면 연결됨, 서버가 끊으면 끊김 후 다시 붙는다", () => {
    const r = mount();
    const ws1 = FakeWS.all[0]!;
    r.act(() => ws1.open());
    expect(seen.connected).toBe(true);
    expect(ws1.sent).toEqual([JSON.stringify({ type: "hello", batch: true })]);
    r.act(() => ws1.closed());
    expect(seen.connected).toBe(false);
    r.act(() => vi.advanceTimersByTime(1_000));
    const ws2 = FakeWS.all[1]!;
    r.act(() => ws2.open());
    expect(seen.connected).toBe(true);
  });
});
