import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 첫 실행 안내 (3-24, 기능 플래그 firstRun).
 *  - 새 사용자(등록 종목 0)에게만 한 번 저절로 연다. 이미 종목이 있으면 열지 않고 '건너뜀'으로 적는다 (기존 사용자를 거치게 하지 않음)
 *  - 목록을 모르면(받는 중·서버 연결 실패) 기다린다. 내비게이터가 준비된 뒤에만 연다. 한 번 적으면 다시 묻지 않는다
 *  - 안내 한 화면: 위젯 추가법 · 알림 권한 · 토스 연동 상태. 서버 주소·토큰 입력 없음. '시작하기' 한 번으로 닫힘, 열리면 '본 것'으로 적음
 */
const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  stocks: undefined as unknown[] | undefined,
  navKey: "root" as string | undefined,
  push: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  canGoBack: true,
  health: { data: undefined as unknown, isError: false },
  perm: { status: "undetermined", canAskAgain: true },
  requested: 0,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async (k: string) => h.store.get(k) ?? null, setItem: async (k: string, v: string) => void h.store.set(k, v) },
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
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({
  router: { push: h.push, back: h.back, replace: h.replace, canGoBack: () => h.canGoBack },
  useRootNavigationState: () => (h.navKey ? { key: h.navKey } : undefined),
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
  useRegisteredStocks: () => ({ data: h.stocks }),
  useHealth: () => h.health,
  useFeature: () => false,
}));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ haptics: true }) }));
vi.mock("@/components/Screen", async () => {
  const R = await import("react");
  const Screen = ({ children, top, bottom, disclaimer }: { children: React.ReactNode; top?: React.ReactNode; bottom?: React.ReactNode; disclaimer?: boolean }) =>
    R.createElement("Screen", { disclaimer }, R.createElement("Top", null, top), children, R.createElement("Bottom", null, bottom));
  return { Screen };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));

const { FirstRunGate } = await import("@/components/UxBridge");
const { default: WelcomeScreen } = await import("@/app/welcome");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { FIRST_RUN_KEY, forgetFirstRunClaim } = await import("@/lib/firstRun");
const { WIDGET_STEPS } = await import("@/lib/welcome");

beforeEach(() => {
  h.store.clear();
  h.stocks = undefined;
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
const gate = (firstRun = true) => {
  const r = render(
    <UxFlagsContext.Provider value={{ oneHand: false, firstRun, emptyGuide: false }}>
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

describe("저절로 여는 조건", () => {
  it("새 사용자(등록 종목 0): 한 번 연다, 두 번째 실행 기록 없이도 같은 실행에서는 다시 열지 않는다", async () => {
    h.stocks = [];
    const r = await (async () => {
      const x = gate();
      await settle(x);
      return x;
    })();
    expect(h.push).toHaveBeenCalledWith("/welcome");
    expect(h.push).toHaveBeenCalledTimes(1);
    r.rerender();
    const again = gate();
    await settle(again);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("기존 사용자(종목이 있음): 열지 않고 '건너뜀'으로 적는다", async () => {
    h.stocks = [{ code: "005930" }];
    await settle(gate());
    expect(h.push).not.toHaveBeenCalled();
    expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
  });

  it("목록을 모르면(받는 중·서버 연결 실패) 기다린다, 내비게이터가 준비되기 전에는 열지 않는다", async () => {
    const r = gate();
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
    h.stocks = [];
    h.navKey = undefined;
    r.rerender();
    await flush();
    expect(h.push).not.toHaveBeenCalled();
    h.navKey = "root";
    r.rerender();
    await flush();
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("이미 본 사람·건너뛴 사람·플래그 꺼짐: 열지 않는다", async () => {
    h.stocks = [];
    h.store.set(FIRST_RUN_KEY, "seen");
    await settle(gate());
    h.store.set(FIRST_RUN_KEY, "existing");
    forgetFirstRunClaim();
    await settle(gate());
    h.store.clear();
    forgetFirstRunClaim();
    await settle(gate(false));
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
