import React from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 첫 실행 안내 (3-24, 기능 플래그 firstRun).
 *  - 이 기기에서 처음 쓰는 사람에게만 한 번 저절로 연다. 기기에 사용 흔적(지난 실행의 쿼리 캐시·바꾼 설정·연 브리핑 등)이 있으면
 *    열지 않고 '건너뜀'으로 적는다 (기존 사용자를 거치게 하지 않음). 서버의 등록 종목 수는 보지 않는다 — 토스 자동 동기화로
 *    새 사용자·새 휴대폰도 종목이 이미 있다
 *  - 흔적을 읽는 동안 기다린다. 내비게이터가 준비된 뒤에만 연다. 한 번 적으면 다시 묻지 않는다
 *  - 안내 한 화면: 위젯 추가법 · 알림 권한 · 토스 연동 상태. 서버 주소·토큰 입력 없음. '시작하기' 한 번으로 닫힘, 열리면 '본 것'으로 적음
 */
const h = vi.hoisted(() => {
  // 고정 시계: 이 JS 가 뜬 시각(lib/firstRun BOOT_AT) = 2026-09-27 09:00 (한국 시각). setTimeout 은 진짜
  const BOOT = Date.parse("2026-09-27T09:00:00+09:00");
  vi.useFakeTimers({ toFake: ["Date"], now: BOOT });
  return {
    BOOT,
    path: "/",
    store: new Map<string, string>(),
    navKey: "root" as string | undefined,
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    canGoBack: true,
    health: { data: undefined as unknown, isError: false },
    perm: { status: "undetermined", canAskAgain: true },
    requested: 0,
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    multiGet: async (keys: string[]) => keys.map((k) => [k, h.store.get(k) ?? null]),
  },
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  Switch: "Switch",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({
  router: { push: h.push, back: h.back, replace: h.replace, canGoBack: () => h.canGoBack },
  useRootNavigationState: () => (h.navKey ? { key: h.navKey } : undefined),
  usePathname: () => h.path,
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => h.perm,
  requestPermissionsAsync: async () => {
    h.requested += 1;
    h.perm = { status: "granted", canAskAgain: true };
    return h.perm;
  },
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});
vi.mock("@/api/hooks", () => ({
  // 첫 실행 판단은 서버 목록을 보지 않는다 (불리면 실패)
  useRegisteredStocks: () => {
    throw new Error("첫 실행 판단이 서버 목록을 물음");
  },
  useFeatures: () => ({ data: undefined, isError: false }),
  useHealth: () => h.health,
  useFeature: () => false,
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ haptics: true }) }));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  const Screen = ({ children, top, bottom, disclaimer, contentStyle }: { children: React.ReactNode; top?: React.ReactNode; bottom?: React.ReactNode; disclaimer?: boolean; contentStyle?: unknown }) =>
    R.createElement("Screen", { disclaimer, contentStyle }, R.createElement("Top", null, top), children, R.createElement("Bottom", null, bottom));
  return { Screen };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));

const { FirstRunGate } = await import("@/components/UxBridge");
const { default: WelcomeScreen } = await import("@/app/welcome");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { autoOpenPath, FIRST_RUN_KEY, forgetFirstRunClaim, rereadBootTraces } = await import("@/lib/firstRun");
const { WIDGET_STEPS } = await import("@/lib/welcome");

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  h.path = "/";
  h.store.clear();
  h.navKey = "root";
  h.push.mockReset();
  h.back.mockReset();
  h.replace.mockReset();
  h.canGoBack = true;
  h.health = { data: undefined, isError: false };
  h.perm = { status: "undetermined", canAskAgain: true };
  h.requested = 0;
  forgetFirstRunClaim();
});

const flush = () => new Promise((res) => setTimeout(res, 0));
/** 지금 저장소로 앱을 켠 것처럼: 흔적을 다시 읽고(앱을 켤 때 한 번 읽는 값) 게이트를 붙인다 */
const gate = async (firstRun = true) => {
  await rereadBootTraces();
  const r = render(
    <UxFlagsContext.Provider value={{ oneHand: false, firstRun, emptyGuide: false, connectionGuide: false, flagsMissing: false }}>
      <FirstRunGate />
    </UxFlagsContext.Provider>,
  );
  return r;
};
/** 저장소 읽기(비동기)를 기다린 뒤 다시 그린다 */
const settle = async (r: ReturnType<typeof render>) => {
  await flush();
  r.rerender();
  await flush();
  r.rerender();
};

describe("저절로 여는 조건 (이 기기의 사용 흔적)", () => {
  it("새 기기(흔적 없음): 한 번 연다, 같은 실행에서는 다시 열지 않는다", async () => {
    const r = await gate();
    await settle(r);
    expect(h.push).toHaveBeenCalledWith("/welcome");
    expect(h.push).toHaveBeenCalledTimes(1);
    r.rerender();
    const again = await gate();
    await settle(again);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("기존 사용자(바꾼 설정·연 브리핑·최근 검색 등): 열지 않고 '건너뜀'으로 적는다", async () => {
    for (const key of ["settings.sort", "settings.apiUrl", "briefings.read", "search.recent", "chartPrefs.v1"]) {
      h.store.clear();
      h.store.set(key, "x");
      forgetFirstRunClaim();
      await settle(await gate());
      expect(h.push).not.toHaveBeenCalled();
      expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
    }
  });

  it("지난 실행에 적힌 쿼리 캐시(마지막 잔고)는 흔적, 이번 실행에 막 적힌 캐시는 흔적이 아니다", async () => {
    h.store.set("rq.cache", JSON.stringify({ timestamp: h.BOOT - 86_400_000, buster: "v2", clientState: { queries: [], mutations: [] } }));
    await settle(await gate());
    expect(h.push).not.toHaveBeenCalled();
    expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
    h.store.clear();
    forgetFirstRunClaim();
    h.store.set("rq.cache", JSON.stringify({ timestamp: h.BOOT + 5_000, buster: "v2", clientState: { queries: [], mutations: [] } }));
    await settle(await gate());
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("앱을 켤 때 읽어 둔 흔적을 쓴다: 그 뒤 캐시가 이번 실행 것으로 덮여도(쿼리 캐시 저장기) 기존 사용자로 본다", async () => {
    h.store.set("rq.cache", JSON.stringify({ timestamp: h.BOOT - 3_600_000, buster: "v2", clientState: { queries: [], mutations: [] } }));
    await rereadBootTraces();
    // 켠 뒤 저장기가 바로 다시 적음 (플래그는 그 뒤 네트워크로 도착)
    h.store.set("rq.cache", JSON.stringify({ timestamp: h.BOOT + 1_000, buster: "v2", clientState: { queries: [], mutations: [] } }));
    const r = render(
      <UxFlagsContext.Provider value={{ oneHand: false, firstRun: true, emptyGuide: false, connectionGuide: false, flagsMissing: false }}>
        <FirstRunGate />
      </UxFlagsContext.Provider>,
    );
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
  });

  it("탭 첫 화면에 있을 때만 저절로 연다: 검색·종목 상세(알림으로 연 화면 등)에 있으면 기다렸다가 탭으로 돌아오면 연다", async () => {
    h.path = "/stocks/005930";
    const r = await gate();
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
    h.path = "/stocks/add";
    r.rerender();
    await flush();
    expect(h.push).not.toHaveBeenCalled();
    h.path = "/briefings";
    r.rerender();
    await flush();
    expect(h.push).toHaveBeenCalledTimes(1);
    for (const p of ["/", "/(tabs)", "/briefings", "/discover", "/settings"]) expect(autoOpenPath(p), p).toBe(true);
    for (const p of ["/welcome", "/stocks/005930", "/briefings/12", "/market/KOSPI", "/portfolio/allocation", "", null, undefined]) expect(autoOpenPath(p), String(p)).toBe(false);
  });

  it("내비게이터가 준비되기 전에는 열지 않는다", async () => {
    h.navKey = undefined;
    const r = await gate();
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
    h.navKey = "root";
    r.rerender();
    await flush();
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("이미 본 사람·건너뛴 사람·플래그 꺼짐: 열지 않는다", async () => {
    h.store.set(FIRST_RUN_KEY, "seen");
    await settle(await gate());
    h.store.set(FIRST_RUN_KEY, "existing");
    forgetFirstRunClaim();
    await settle(await gate());
    h.store.clear();
    forgetFirstRunClaim();
    await settle(await gate(false));
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe("안내 한 화면", () => {
  it("위젯 추가법 · 알림 · 토스 연동 세 칸, 서버 주소·토큰 입력 없음, 고지", async () => {
    h.health = { data: { ok: true, tossOpenApi: { configured: true, sync: { lastRunAt: "2026-09-27T01:12:00Z", lastChanges: { added: 0, updated: 0, removed: 0, holdings: 17 } } } }, isError: false };
    const r = render(<WelcomeScreen />);
    await flush();
    r.rerender();
    const text = r.text();
    expect(text).toContain("처음 사용 안내");
    expect(text).toContain("1. 홈 화면에 위젯 추가");
    expect(text).toContain("2. 알림");
    expect(text).toContain("3. 토스증권 연동");
    for (const step of WIDGET_STEPS) expect(text).toContain(step);
    expect(text).toContain("'내 종목 시세' · '오늘의 브리핑' · '총 평가금액' · '지수·환율'");
    expect(text).toContain("연결됨 · 마지막 동기화");
    expect(text).toContain("보유 17종목 자동 등록");
    expect(text).toContain("아직 허용하지 않음");
    // 서버 주소·토큰 입력 단계 없음
    expect(r.all().some((n) => n.type === "TextInput")).toBe(false);
    expect(text).not.toMatch(/서버 주소|API 토큰|토큰 입력/);
    expect(r.all().find((n) => n.type === "Screen")!.props.disclaimer).toBe(true);
    // 넓은 창(933dp 등)에서 카드·버튼이 창 폭 전체로 늘어나지 않게 읽기 폭 720 까지 (휴대폰은 창이 더 좁아 그대로)
    expect(r.all().find((n) => n.type === "Screen")!.props.contentStyle).toMatchObject({ maxWidth: 720, alignSelf: "center" });
    // 열리면 본 것으로
    expect(h.store.get(FIRST_RUN_KEY)).toBe("seen");
  });

  it("'알림 허용'은 휴대폰 권한 창을 부르고, 허용되면 버튼이 사라진다", async () => {
    const r = render(<WelcomeScreen />);
    await flush();
    r.rerender();
    const btn = r.byLabel("알림 허용");
    (btn.props.onPress as () => void)();
    await flush();
    r.rerender();
    expect(h.requested).toBe(1);
    expect(r.has("알림 허용")).toBe(false);
    expect(r.text()).toContain("허용됨");
    // 권한만으로는 브리핑 알림이 오지 않는다는 것을 분명히 (설정 > 알림 '브리핑 알림' 스위치)
    expect(r.text()).toContain("설정 > 알림에서 '브리핑 알림'을 켜세요");
  });

  it("다시 물을 수 없게 꺼져 있으면 버튼 대신 휴대폰 설정 경로", async () => {
    h.perm = { status: "denied", canAskAgain: false };
    const r = render(<WelcomeScreen />);
    await flush();
    r.rerender();
    expect(r.has("알림 허용")).toBe(false);
    expect(r.text()).toContain("휴대폰 설정 > 애플리케이션 > 주식 브리핑 > 알림");
  });

  it("'시작하기' 한 번으로 닫힌다 (뒤로 갈 곳이 없으면 잔고로)", async () => {
    const r = render(<WelcomeScreen />);
    await flush();
    (r.byLabel("안내 닫고 시작하기").props.onPress as () => void)();
    expect(h.back).toHaveBeenCalledTimes(1);
    h.canGoBack = false;
    (r.byLabel("안내 닫고 시작하기").props.onPress as () => void)();
    expect(h.replace).toHaveBeenCalledWith("/");
  });

  it("토스 상태: 연결 안 됨 · 서버 연결 실패 · 확인 중", async () => {
    h.health = { data: { ok: true, tossOpenApi: { configured: false } }, isError: false };
    expect(render(<WelcomeScreen />).text()).toContain("연결되지 않음 · 종목은 검색해서 직접 추가할 수 있습니다");
    h.health = { data: undefined, isError: true };
    expect(render(<WelcomeScreen />).text()).toContain("서버에 연결되지 않아 확인하지 못했습니다");
    h.health = { data: undefined, isError: false };
    expect(render(<WelcomeScreen />).text()).toContain("확인 중…");
    await flush();
  });
});
