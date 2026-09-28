import React from "react";
import { environmentManager, focusManager, isServer, QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceAlertRule, RegisteredWithQuote, VolumeStatus } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 가격 알림 엔진 (3-29, 플래그 priceAlerts): 실제 LiveStreamProvider(가짜 웹소켓) + 실제 QueryClient + 실제 PriceAlertProvider.
 * 시계는 2026-12-08 10:12:05 (서울) 고정 — 체결이 오면 그 자리에서(가짜 시계 0ms) 화면 위 카드·진동·알림 목록·서버 기록.
 * 옛 목록·뒤로 간 때·돌아온 순간은 울리지 않고, 조건마다 하루 한 번(서버 기록 · 기기 기록 · 제공자 인스턴스 메모리).
 * ListWatch 는 관찰자 수와 상관없이 활성 가격 조건이 있으면 주기로 잔고 목록을 받고, 잔고 탭과 함께 있어도 요청이 두 배가 되지 않는다
 */
const API = "https://server.test";
const T0 = Date.parse("2026-12-08T10:12:05+09:00");
const FIRED_KEY = "priceAlerts.fired.v1";

const h = vi.hoisted(() => ({
  app: { currentState: "active" as string, listeners: [] as ((s: string) => void)[] },
  settings: { apiUrl: "https://server.test", apiToken: "", ready: true },
  features: { features: { priceAlerts: true } } as { features: Record<string, boolean> } | undefined,
  api: null as unknown,
  store: new Map<string, string>(),
  firedReads: 0,
  reader: false,
  announce: [] as string[],
  alert: [] as unknown[],
  push: [] as string[],
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
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Modal: "Modal",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  ActivityIndicator: "ActivityIndicator",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {} },
  AccessibilityInfo: { isScreenReaderEnabled: async () => h.reader, announceForAccessibility: (s: string) => void h.announce.push(s) },
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
  Alert: { alert: (...a: unknown[]) => void h.alert.push(a) },
  useWindowDimensions: () => ({ width: 475, height: 751, scale: 2.625, fontScale: 1 }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: (p: string) => void h.push.push(p) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      if (k === "priceAlerts.fired.v1") h.firedReads++;
      return h.store.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => h.settings }));
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.now() }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});
vi.mock("@/api/hooks", () => ({
  useApi: () => h.api,
  useFeatures: () => ({ data: h.features }),
  useLivePoll: () => () => 30_000,
}));

const { LiveStreamProvider } = await import("@/lib/liveStream");
const { PriceAlertProvider } = await import("@/components/PriceAlertProvider");
const { installHaptics, setHapticPolicy } = await import("@/lib/haptics");
const { installPriceAlertNotifier, announceText } = await import("@/lib/priceAlerts");
const { ApiRequestError } = await import("@/api/client");

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const SESSION = { market: "KR" as const, phase: "regular", label: "한국 정규장", open: true, eligible: true, until: "2026-12-08T15:20:00+09:00" };
const samsung = (price = 84_300): RegisteredWithQuote => {
  const q = quote("005930", price, { prevClose: 81_400, change: price - 81_400, changeRate: Math.round(((price - 81_400) / 81_400) * 10_000) / 100, asOf: "2026-12-08T10:12:00+09:00", session: SESSION, priceBasis: "KRX 정규장" });
  return holding("005930", q, 10, 70_000, undefined, "삼성전자");
};
const hynix = (): RegisteredWithQuote => holding("000660", quote("000660", 351_000, { asOf: "2026-12-08T10:12:00+09:00", session: SESSION }), null, null, undefined, "SK하이닉스");
const rule = (over: Partial<PriceAlertRule> = {}): PriceAlertRule => ({ id: 12, code: "005930", kind: "priceAbove", value: 88_600, currency: "KRW", createdAt: "2026-12-01T09:00:00+09:00", firedOn: null, firedAt: null, firedValue: null, registered: true, ...over });
const vol = (over: Partial<VolumeStatus> = {}): VolumeStatus => ({ code: "005930", status: "ok", date: "2026-12-08", volume: 3_120_000, expected: 948_328, ratio: 3.29, days: 18, minutes: 72, asOf: "2026-12-08T10:12:00+09:00", reason: null, ...over });
const tick = (price: number, at = "2026-12-08T10:12:04+09:00", code = "005930") => ({ type: "ticks", ticks: [{ code, price, volume: 10, timestamp: at, source: "toss-openapi" }] });

/** 가짜 서버 */
function fakeApi() {
  const s = {
    rules: [rule()] as PriceAlertRule[],
    rulesError: null as unknown,
    list: [samsung()] as RegisteredWithQuote[],
    volume: [vol()] as VolumeStatus[],
    calls: { priceAlerts: 0, listStocks: 0 },
    volumeCodes: [] as string[][],
    fired: [] as [number, { date: string; at: string; value: number }][],
  };
  const api = {
    priceAlerts: async () => {
      s.calls.priceAlerts++;
      if (s.rulesError) throw s.rulesError;
      return { rules: s.rules.map((r) => ({ ...r })) };
    },
    listStocks: async () => {
      s.calls.listStocks++;
      return s.list;
    },
    priceAlertVolume: async (codes: string[]) => {
      s.volumeCodes.push(codes);
      return { items: s.volume };
    },
    priceAlertFired: async (id: number, body: { date: string; at: string; value: number }) => {
      s.fired.push([id, body]);
      return { first: true };
    },
    createPriceAlert: async () => rule(),
    deletePriceAlert: async () => undefined,
  };
  h.api = api;
  return s;
}

let haptics: string[] = [];
let notified: { title: string; body: string }[] = [];
let qc: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  environmentManager.setIsServer(() => false);
  FakeWS.all = [];
  h.app = { currentState: "active", listeners: [] };
  h.features = { features: { priceAlerts: true } };
  h.store.clear();
  h.firedReads = 0;
  h.reader = false;
  h.announce = [];
  h.alert = [];
  h.push = [];
  haptics = [];
  notified = [];
  installHaptics({ selectionAsync: async () => undefined, impactAsync: async () => undefined, notificationAsync: async (s: never) => void haptics.push(`notificationAsync:${s}`) }, "android");
  setHapticPolicy({ oneHand: false, user: true });
  installPriceAlertNotifier((c) => void notified.push(c));
  qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
  vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  environmentManager.setIsServer(() => isServer);
  installPriceAlertNotifier(null);
});

type R = ReturnType<typeof render>;
const tree = (client: QueryClient, live = true, key = "a") => (
  <QueryClientProvider client={client}>
    {live ? (
      <LiveStreamProvider>
        <PriceAlertProvider key={key}>{null}</PriceAlertProvider>
      </LiveStreamProvider>
    ) : (
      <PriceAlertProvider key={key}>{null}</PriceAlertProvider>
    )}
  </QueryClientProvider>
);
/** 시간을 보내고(가짜 시계) 밀린 상태 변경을 그린다 (약속·0ms 타이머가 이어지는 것까지 몇 번) */
async function settle(r: R, ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(0);
    r.act(() => undefined);
  }
}
const setList = (list: RegisteredWithQuote[], updatedAt?: number) => qc.setQueryData([API, "stocks"], list, updatedAt === undefined ? undefined : { updatedAt });
const bannerRows = (r: R) => r.all().filter((n) => n.type === "Pressable" && n.props.accessibilityHint === "종목 화면 열기");
const texts = (n: HostNode): string => n.children.map((c) => (typeof c === "string" ? c : texts(c))).join("|");
const ws = (r: R) => {
  const w = FakeWS.all.at(-1)!;
  r.act(() => w.open());
  return w;
};

describe("체결이 오면 그 자리에서 울린다 (3초 안)", () => {
  it("조건 88,600원 이상 · 체결 88,700원 → 카드 제목·본문, 진동 한 번, 알림 목록 한 줄, 서버 기록, 기기 기록", async () => {
    const srv = fakeApi();
    const r = render(tree(qc));
    setList([samsung()]);
    await settle(r);
    expect(bannerRows(r)).toHaveLength(0);
    const w = ws(r);
    r.act(() => w.message(tick(88_700)));
    await settle(r); // 가짜 시계로 0ms — 3초보다 한참 안
    expect(Date.now() - T0).toBeLessThan(3_000);
    expect(bannerRows(r).map(texts)).toEqual(["삼성전자 · 88,600원 이상|지금 88,700원 · 전일 대비 +8.97% · 10:12 기준"]);
    expect(haptics).toEqual(["notificationAsync:warning"]);
    expect(notified).toEqual([{ title: "가격 알림 · 삼성전자", body: "88,600원 이상 · 지금 88,700원 · 전일 대비 +8.97% · 10:12 기준", data: { type: "priceAlert", code: "005930", ruleId: 12 } }]);
    expect(srv.fired).toEqual([[12, { date: "2026-12-08", at: new Date(T0).toISOString(), value: 88_700 }]]);
    expect(JSON.parse(h.store.get(FIRED_KEY)!)).toEqual({ "12": "2026-12-08" });
    expect(h.announce).toEqual(["가격 알림, 삼성전자, 88,600원 이상에 닿음, 지금 88,700원, 8.97% 상승, 10시 12분 기준"]);
    // 카드에는 accessibilityLiveRegion 이 없다 (알림 말 한 번과 겹쳐 두 번 읽지 않게)
    expect(r.all().some((n) => "accessibilityLiveRegion" in n.props)).toBe(false);
    // 조건 목록 캐시는 바로 '오늘 울림'
    expect((qc.getQueryData([API, "priceAlerts"]) as { rules: PriceAlertRule[] }).rules[0]).toMatchObject({ firedOn: "2026-12-08", firedAt: new Date(T0).toISOString() });

    // 같은 날 다시 내려갔다 올라가도 한 번
    r.act(() => w.message(tick(88_500, "2026-12-08T10:12:05+09:00")));
    r.act(() => w.message(tick(88_900, "2026-12-08T10:12:06+09:00")));
    await settle(r);
    expect(bannerRows(r)).toHaveLength(1);
    expect(haptics).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect(srv.fired).toHaveLength(1);
    r.unmount();
  });

  it("설정 '누를 때 진동'을 끄면 카드는 뜨고 진동은 없다", async () => {
    fakeApi();
    setHapticPolicy({ oneHand: false, user: false });
    const r = render(tree(qc));
    setList([samsung()]);
    await settle(r);
    const w = ws(r);
    r.act(() => w.message(tick(88_700)));
    await settle(r);
    expect(bannerRows(r)).toHaveLength(1);
    expect(haptics).toEqual([]);
    r.unmount();
  });
});

describe("재시작 흉내 (새 QueryClient · 새 제공자 = 빈 메모리)", () => {
  async function fireOnce() {
    fakeApi();
    const r = render(tree(qc));
    setList([samsung()]);
    await settle(r);
    const w = ws(r);
    r.act(() => w.message(tick(88_700)));
    await settle(r);
    expect(haptics).toHaveLength(1);
    r.unmount();
  }
  async function restart(firedOn: string | null, device: Record<string, string> | null) {
    const srv = fakeApi();
    srv.rules = [rule({ firedOn })];
    h.store.clear();
    if (device) h.store.set(FIRED_KEY, JSON.stringify(device));
    haptics = [];
    qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
    const r = render(tree(qc, true, "b"));
    setList([samsung(88_700)]);
    await settle(r);
    r.unmount();
    return haptics.length;
  }

  it("(a) 서버·기기 기록이 비어 있으면 같은 값에 다시 울린다 — 메모리가 모듈 전역이 아니다", async () => {
    await fireOnce();
    expect(await restart(null, null)).toBe(1);
  });
  it("(b) 서버 firedOn 이 오늘이면 울리지 않는다", async () => {
    await fireOnce();
    expect(await restart("2026-12-08", null)).toBe(0);
  });
  it("(c) 기기 기록이 오늘이면 울리지 않는다 (서버에 못 보낸 경우)", async () => {
    await fireOnce();
    expect(await restart(null, { "12": "2026-12-08" })).toBe(0);
  });
});

describe("이번 실행 · 앱이 앞에 있을 때 받은 값만", () => {
  it("옛 목록(앱을 켜기 전에 받은 값)으로는 울리지 않고, 새로 받으면 울린다", async () => {
    fakeApi();
    const r = render(tree(qc, false));
    setList([samsung(88_700)], 1);
    await settle(r);
    expect(haptics).toEqual([]);
    r.act(() => void setList([samsung(88_700)]));
    await settle(r);
    expect(haptics).toHaveLength(1);
    r.unmount();
  });

  it("뒤에 있는 동안 들어온 값·돌아온 순간은 울리지 않고, 돌아온 뒤 새 값이 오면 울린다", async () => {
    fakeApi();
    const r = render(tree(qc, false));
    setList([samsung()]);
    await settle(r);
    const toState = (s: string) =>
      r.act(() => {
        h.app.currentState = s;
        for (const fn of [...h.app.listeners]) fn(s);
      });
    toState("background");
    r.act(() => void setList([samsung(88_700)]));
    await settle(r, 1_000);
    expect(haptics).toEqual([]);
    expect(h.store.get(FIRED_KEY)).toBeUndefined();
    toState("active");
    await settle(r);
    expect(haptics).toEqual([]);
    r.act(() => void setList([samsung(88_800)]));
    await settle(r);
    expect(haptics).toHaveLength(1);
    r.unmount();
  });

  it("조건 목록이 새로 오면 체결을 기다리지 않고 지금 캐시로 한 번 확인한다 (저장할 때 이미 맞음)", async () => {
    const srv = fakeApi();
    srv.rules = [];
    const r = render(tree(qc, false));
    setList([samsung()]);
    await settle(r);
    srv.rules = [rule({ id: 13, value: 84_000 })];
    await settle(r, 1_000); // 저장 버튼을 누르기까지 시간이 흐른다 (받은 시각이 바뀜)
    r.act(() => void qc.invalidateQueries({ queryKey: [API, "priceAlerts"], exact: true }));
    await settle(r);
    expect(bannerRows(r).map(texts)).toEqual(["삼성전자 · 84,000원 이상|지금 84,300원 · 전일 대비 +3.56% · 10:12 기준"]);
    r.unmount();
  });
});

describe("쉬는 중 (등록에서 뺀 종목)", () => {
  it("(a) 조건 registered 거짓 + 발견 탭 상세 폴링 값(registered 거짓)이 조건 위여도 울리지 않는다", async () => {
    const srv = fakeApi();
    srv.rules = [rule({ registered: false })];
    const r = render(tree(qc, false));
    setList([hynix()]);
    await settle(r);
    r.act(() => void qc.setQueryData([API, "stock", "005930"], { ...samsung(88_700), registered: false }));
    await settle(r);
    expect(haptics).toEqual([]);
    r.unmount();
  });

  it("(b) 목록에서 코드가 빠지면 조건 목록을 다시 받고, 그 뒤 체결이 와도 울리지 않는다", async () => {
    const srv = fakeApi();
    const r = render(tree(qc));
    setList([samsung(), hynix()]);
    qc.setQueryData([API, "stock", "005930"], { ...samsung(), registered: true });
    await settle(r);
    const before = srv.calls.priceAlerts;
    r.act(() => void setList([hynix()]));
    await settle(r);
    expect(srv.calls.priceAlerts).toBe(before + 1);
    const w = ws(r);
    r.act(() => w.message(tick(88_700)));
    await settle(r);
    expect(haptics).toEqual([]);
    r.unmount();
  });

  it("(c) 거래량 조건: 쉬는 중인 종목은 요청 코드에 넣지 않고, 그 종목 응답이 와도 울리지 않는다. 쉬는 중 하나뿐이면 요청 0", async () => {
    const srv = fakeApi();
    srv.rules = [rule({ id: 30, kind: "volume", value: 3, currency: null }), rule({ id: 31, code: "000660", kind: "volume", value: 3, currency: null, registered: false })];
    srv.volume = [vol({ ratio: 2 }), vol({ code: "000660", ratio: 3.5 })];
    const r = render(tree(qc, false));
    setList([samsung(), hynix()]);
    await settle(r);
    expect(srv.volumeCodes).toEqual([["005930"]]);
    expect(haptics).toEqual([]);
    r.unmount();

    const only = fakeApi();
    only.rules = [rule({ id: 31, code: "000660", kind: "volume", value: 3, currency: null, registered: false })];
    qc = new QueryClient();
    const r2 = render(tree(qc, false));
    setList([samsung(), hynix()]);
    await settle(r2, 60_000);
    expect(only.volumeCodes).toEqual([]);
    r2.unmount();
  });
});

describe("조건 목록 받기 실패", () => {
  it("500 이면 엔진을 시작하지 않고(목록·거래량 요청 0) 1분 뒤 다시 묻는다 → 받으면 시작해 지금 캐시로 확인", async () => {
    const srv = fakeApi();
    srv.rules = [rule({ value: 84_000 })];
    srv.rulesError = new ApiRequestError(500, "INTERNAL", "서버 오류");
    const r = render(tree(qc, false));
    setList([samsung()]);
    await settle(r, 5_000); // 첫 요청 + 재시도 1번
    expect(srv.calls.priceAlerts).toBe(2);
    expect(srv.calls.listStocks).toBe(0);
    expect(srv.volumeCodes).toEqual([]);
    expect(haptics).toEqual([]);
    srv.rulesError = null;
    r.act(() => void setList([samsung()]));
    await settle(r, 60_000);
    expect(srv.calls.priceAlerts).toBe(3);
    expect(haptics).toHaveLength(1);
    r.unmount();
  });

  it("404(예전 서버)면 조건 없음으로 보고 1분·5분이 지나도 다시 묻지 않는다", async () => {
    const srv = fakeApi();
    srv.rulesError = new ApiRequestError(404, "HTTP_404", "없음");
    const r = render(tree(qc, false));
    await settle(r, 1_000);
    expect(srv.calls.priceAlerts).toBe(1);
    await settle(r, 5 * 60_000);
    expect(srv.calls.priceAlerts).toBe(1);
    expect(srv.calls.listStocks).toBe(0);
    r.unmount();
  });
});

describe("화면 위 카드", () => {
  async function fired(extraRules: PriceAlertRule[] = []) {
    // 앞 실행의 기기 기록이 남지 않게 (새 설치처럼)
    h.store.clear();
    const srv = fakeApi();
    srv.rules = [rule(), ...extraRules];
    const r = render(tree(qc));
    setList([samsung()]);
    await settle(r);
    const w = ws(r);
    r.act(() => w.message(tick(88_700)));
    await settle(r);
    return r;
  }

  it("10초 뒤 저절로 닫힌다 · 화면 읽기가 켜져 있으면 닫히지 않는다", async () => {
    const r = await fired();
    await settle(r, 9_000);
    expect(bannerRows(r)).toHaveLength(1);
    await settle(r, 1_000);
    expect(bannerRows(r)).toHaveLength(0);
    r.unmount();
    h.reader = true;
    qc = new QueryClient();
    const r2 = await fired();
    await settle(r2, 60_000);
    expect(bannerRows(r2)).toHaveLength(1);
    r2.unmount();
  });

  it("닫기로 닫히고, 줄을 누르면 그 종목 상세로", async () => {
    const r = await fired();
    r.act(() => (r.byLabel("가격 알림 닫기").props.onPress as () => void)());
    expect(bannerRows(r)).toHaveLength(0);
    r.unmount();
    qc = new QueryClient();
    const r2 = await fired();
    r2.act(() => (bannerRows(r2)[0]!.props.onPress as () => void)());
    expect(h.push).toEqual(["/stocks/005930"]);
    expect(bannerRows(r2)).toHaveLength(0);
    r2.unmount();
  });

  it("조건 넷이 한 번에: 카드 3줄 + '외 1건', 진동 1번, 알림 목록 4번, 화면 읽기 알림 1번 (앞 3건 + '. 외 1건')", async () => {
    const r = await fired([rule({ id: 13, value: 85_000 }), rule({ id: 14, kind: "rateUp", value: 5, currency: null }), rule({ id: 15, kind: "rateUp", value: 8, currency: null })]);
    expect(bannerRows(r)).toHaveLength(3);
    expect(r.text()).toContain("외 1건");
    expect(haptics).toHaveLength(1);
    expect(notified).toHaveLength(4);
    expect(h.announce).toHaveLength(1);
    expect(h.announce[0]).toMatch(/\. 외 1건$/);
    expect(h.announce[0]!.split(". 가격 알림").length).toBe(3);
    expect(r.all().some((n) => "accessibilityLiveRegion" in n.props)).toBe(false);
    expect(bannerRows(r).map(texts).every((t) => t.startsWith("삼성전자 · "))).toBe(true);
    r.unmount();
  });
});

describe("거래량 급증", () => {
  it("응답의 ok 3.29 가 3배 조건을 울리고(값 3.29), 30초마다 다시 묻는다 · 모두 정규장 밖이면 5분마다", async () => {
    const srv = fakeApi();
    srv.rules = [rule({ id: 30, kind: "volume", value: 3, currency: null })];
    const r = render(tree(qc, false));
    setList([samsung()]);
    await settle(r);
    expect(srv.volumeCodes).toEqual([["005930"]]);
    expect(bannerRows(r).map(texts)).toEqual(["삼성전자 · 거래량 같은 시각 평균 3배 이상|오늘 거래량 312만주 · 최근 18거래일 같은 시각 평균의 3.2배 · 10:12 기준"]);
    expect(srv.fired).toEqual([[30, { date: "2026-12-08", at: new Date(T0).toISOString(), value: 3.29 }]]);
    await settle(r, 30_000);
    expect(srv.volumeCodes).toHaveLength(2);
    expect(haptics).toHaveLength(1); // 같은 날 두 번 울리지 않음
    srv.volume = [vol({ status: "closed", date: null, ratio: null, volume: null, expected: null, days: 0, minutes: null })];
    await settle(r, 30_000);
    expect(srv.volumeCodes).toHaveLength(3);
    await settle(r, 60_000);
    expect(srv.volumeCodes).toHaveLength(3);
    await settle(r, 240_000);
    expect(srv.volumeCodes).toHaveLength(4);
    r.unmount();
  });
});

describe("ListWatch (잔고 탭이 가려져도 목록을 받음 · 요청이 두 배가 되지 않음)", () => {
  /** 엔진이 준비된 뒤부터 센다. 목록은 그리기 직전에 넣어 붙는 순간 받지 않게 (staleTime 2초) */
  async function mount(rules: PriceAlertRule[], before?: () => void) {
    const srv = fakeApi();
    srv.rules = rules;
    before?.();
    setList([samsung()]);
    const r = render(tree(qc, false));
    await settle(r);
    srv.calls.listStocks = 0;
    return { r, srv };
  }
  const listFn = async () => [samsung()];

  it("1) enabled: false 관찰자(위젯 연결 모양)가 먼저 붙어 있어도 활성 가격 조건이 있으면 30초마다 받는다 (90초에 3번)", async () => {
    const { r, srv } = await mount([rule()], () => {
      new QueryObserver(qc, { queryKey: [API, "stocks"], queryFn: listFn, enabled: false }).subscribe(() => undefined);
    });
    await settle(r, 90_000);
    expect(srv.calls.listStocks).toBe(3);
    r.unmount();
  });

  it("2) 잔고 탭 같은 주기 관찰자가 함께 있어도 90초 동안 3번 (합쳐짐), 3) 그 관찰자가 빠져도 다음 30초 안에 받는다", async () => {
    const { r, srv } = await mount([rule()]);
    const tab = new QueryObserver(qc, { queryKey: [API, "stocks"], queryFn: () => (h.api as { listStocks: () => Promise<RegisteredWithQuote[]> }).listStocks(), staleTime: 2_000, refetchInterval: 30_000 });
    const off = tab.subscribe(() => undefined);
    await settle(r, 90_000);
    expect(srv.calls.listStocks).toBe(3);
    off();
    srv.calls.listStocks = 0;
    await settle(r, 30_000);
    expect(srv.calls.listStocks).toBeGreaterThanOrEqual(1);
    r.unmount();
  });

  it("4) 활성 가격 조건이 없으면(조건 없음·거래량만·쉬는 중만) 목록을 받지 않는다", async () => {
    for (const rules of [[], [rule({ id: 30, kind: "volume", value: 3, currency: null })], [rule({ registered: false })]]) {
      qc = new QueryClient();
      const { r, srv } = await mount(rules);
      await settle(r, 90_000);
      expect(srv.calls.listStocks, JSON.stringify(rules)).toBe(0);
      r.unmount();
    }
  });
});

describe("문맥 (설정 칸이 읽는 값)", () => {
  it("종목 이름: 목록을 받기 전에는 코드, 이번 실행에서 목록을 받으면 이름으로 다시 그린다 (설정 칸이 코드로 남지 않게)", async () => {
    // 활성 가격 조건이 없어 목록을 스스로 받지 않는 경우 (거래량 조건만 — 설정 탭을 먼저 연 때)
    const srv = fakeApi();
    srv.rules = [rule({ id: 30, kind: "volume", value: 3, currency: null })];
    srv.volume = [];
    const { PriceAlertContext } = await import("@/lib/priceAlertContext");
    const seen: string[] = [];
    function Probe() {
      const v = React.useContext(PriceAlertContext);
      seen.push(`${v.on}:${v.rules.length}:${v.nameOf("005930")}`);
      return null;
    }
    const r = render(
      <QueryClientProvider client={qc}>
        <PriceAlertProvider>
          <Probe />
        </PriceAlertProvider>
      </QueryClientProvider>,
    );
    await settle(r);
    expect(seen.at(-1)).toBe("true:1:005930");
    r.act(() => void setList([samsung()]));
    await settle(r);
    expect(seen.at(-1)).toBe("true:1:삼성전자");
    r.unmount();
  });
});

describe("꺼짐 (priceAlerts false 또는 받은 값 없음)", () => {
  it("같은 체결에도 카드·진동·알림 0, 조건·거래량·목록 요청 0, 기기 기록 읽기 0", async () => {
    const cases: ({ features: Record<string, boolean> } | undefined)[] = [{ features: { priceAlerts: false } }, { features: {} }, undefined];
    for (const flags of cases) {
      h.features = flags;
      const srv = fakeApi();
      qc = new QueryClient();
      const r = render(tree(qc));
      setList([samsung()]);
      await settle(r);
      const w = ws(r);
      r.act(() => w.message(tick(88_700)));
      await settle(r, 60_000);
      expect(bannerRows(r)).toHaveLength(0);
      expect(haptics).toEqual([]);
      expect(notified).toEqual([]);
      expect(srv.calls).toEqual({ priceAlerts: 0, listStocks: 0 });
      expect(srv.volumeCodes).toEqual([]);
      expect(h.firedReads).toBe(0);
      r.unmount();
    }
  });

  it("announceText 는 한 번의 확인에서 울린 것들을 한 번에 (1건이면 그대로)", () => {
    expect(announceText([])).toBe("");
  });
});
