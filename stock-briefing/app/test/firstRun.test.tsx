import React from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 첫 실행 안내 (3-24, 기능 플래그 firstRun).
 *  - 새 사용자에게만 한 번 저절로 연다: 이번 실행에서 서버에서 새로 받은 자료로 등록 종목 0개 + 토스 연동 없음.
 *    종목이 있거나 토스가 연결되어 있으면 열지 않고 '건너뜀'으로 적는다 (기존 사용자를 거치게 하지 않음)
 *  - 지난 실행의 캐시(받은 시각 < 이 JS 가 뜬 시각)·오프라인·토큰이 틀린 /health 로는 정하지 않고 아무것도 적지 않는다
 *  - 내비게이터가 준비된 뒤, 탭 첫 화면에 있을 때만 연다. 띄우기 직전에 기록을 다시 읽는다(설정 '다시 보기'와 겹치지 않게). 한 번 적으면 다시 묻지 않는다
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
    health: { data: undefined as unknown, isError: false, dataUpdatedAt: 0 },
    stocks: { data: undefined as unknown[] | undefined, isError: false, dataUpdatedAt: 0 },
    perm: { status: "undetermined", canAskAgain: true },
    requested: 0,
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
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
  // 첫 실행 판단: 등록 종목 목록 + /health 의 토스 연동 (받은 시각 dataUpdatedAt 으로 이번 실행에 받은 것인지 본다)
  useRegisteredStocks: () => h.stocks,
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
const { autoOpenPath, BOOT_AT, FIRST_RUN_KEY, forgetFirstRunClaim } = await import("@/lib/firstRun");
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
  h.health = { data: undefined, isError: false, dataUpdatedAt: 0 };
  h.stocks = { data: undefined, isError: false, dataUpdatedAt: 0 };
  h.perm = { status: "undetermined", canAskAgain: true };
  h.requested = 0;
  forgetFirstRunClaim();
});

const flush = () => new Promise((res) => setTimeout(res, 0));
/** 이번 실행에서 서버에서 받은 자료 (켠 지 2초 뒤에 받음) */
const AT = () => h.BOOT + 2_000;
const serverSays = (stocks: unknown[], toss: unknown = { configured: false, sync: null }) => {
  h.stocks = { data: stocks, isError: false, dataUpdatedAt: AT() };
  h.health = { data: { ok: true, tossOpenApi: toss }, isError: false, dataUpdatedAt: AT() };
};
const gate = (firstRun = true) =>
  render(
    <UxFlagsContext.Provider value={{ oneHand: false, firstRun, emptyGuide: false, connectionGuide: false, flagsMissing: false }}>
      <FirstRunGate />
    </UxFlagsContext.Provider>,
  );
/** 저장소 읽기(비동기)를 기다리며 다시 그린다 */
const settle = async (r: ReturnType<typeof render>) => {
  for (let i = 0; i < 4; i++) {
    await flush();
    r.rerender();
  }
};

describe("저절로 여는 조건 (이번 실행에서 받은 서버 자료)", () => {
  it("고정 시계: 이 JS 가 뜬 시각", () => {
    expect(BOOT_AT).toBe(h.BOOT);
  });

  it("새 사용자(종목 0개 + 토스 연동 없음): 한 번 연다, 같은 실행에서는 다시 열지 않는다", async () => {
    serverSays([]);
    const r = gate();
    await settle(r);
    expect(h.push).toHaveBeenCalledWith("/welcome");
    expect(h.push).toHaveBeenCalledTimes(1);
    const again = gate();
    await settle(again);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("보유·관심 종목이 있는 기존 사용자: 열지 않고 '건너뜀'으로 적는다 (토스 상태를 몰라도)", async () => {
    for (const stocks of [[{ code: "005930", quantity: 10 }], [{ code: "AAPL", quantity: null }]]) {
      h.store.clear();
      forgetFirstRunClaim();
      serverSays(stocks);
      h.health = { data: undefined, isError: true, dataUpdatedAt: 0 };
      await settle(gate());
      expect(h.push).not.toHaveBeenCalled();
      expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
    }
  });

  it("토스 연동 기록이 있으면(키 설정 · 동기화한 적 있음) 종목이 아직 0개여도 기존 사용자", async () => {
    for (const toss of [{ configured: true, sync: null }, { configured: false, sync: { lastRunAt: "2026-09-26T06:00:00Z" } }]) {
      h.store.clear();
      forgetFirstRunClaim();
      serverSays([], toss);
      await settle(gate());
      expect(h.push).not.toHaveBeenCalled();
      expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
    }
  });

  it("지난 실행의 캐시(받은 시각이 켜기 전)만 있으면 정하지 않는다: 새로 받으면 그때 연다", async () => {
    // APK 에 든 번들로 처음 켰을 때 적힌 캐시: 빈 목록
    h.stocks = { data: [], isError: false, dataUpdatedAt: h.BOOT - 600_000 };
    h.health = { data: { ok: true, tossOpenApi: { configured: false, sync: null } }, isError: false, dataUpdatedAt: h.BOOT - 600_000 };
    const r = gate();
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.store.get(FIRST_RUN_KEY)).toBeUndefined();
    serverSays([]);
    await settle(r);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("오프라인·토큰이 틀림(/health limited)·한쪽만 받음: 아무것도 적지 않고 기다린다", async () => {
    h.stocks = { data: undefined, isError: true, dataUpdatedAt: 0 };
    h.health = { data: undefined, isError: true, dataUpdatedAt: 0 };
    const r = gate();
    await settle(r);
    h.health = { data: { ok: true, limited: true }, isError: false, dataUpdatedAt: AT() };
    await settle(r);
    h.stocks = { data: [], isError: false, dataUpdatedAt: AT() };
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.store.get(FIRST_RUN_KEY)).toBeUndefined();
    // 연결이 돌아와 /health 상세를 받으면 연다
    serverSays([]);
    await settle(r);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("탭 첫 화면에 있을 때만 저절로 연다: 검색·종목 상세(알림으로 연 화면 등)에 있으면 기다렸다가 탭으로 돌아오면 연다", async () => {
    serverSays([]);
    h.path = "/stocks/005930";
    const r = gate();
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
    h.path = "/stocks/add";
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
    // 검색에서 종목을 추가해도(목록이 비지 않음) 한 번 '보임'으로 정한 것은 그대로 — 탭으로 돌아오면 연다
    h.stocks = { data: [{ code: "005930" }], isError: false, dataUpdatedAt: AT() + 5_000 };
    h.path = "/briefings";
    await settle(r);
    expect(h.push).toHaveBeenCalledTimes(1);
    for (const p of ["/", "/(tabs)", "/briefings", "/discover", "/settings"]) expect(autoOpenPath(p), p).toBe(true);
    for (const p of ["/welcome", "/stocks/005930", "/briefings/12", "/market/KOSPI", "/portfolio/allocation", "", null, undefined]) expect(autoOpenPath(p), String(p)).toBe(false);
  });

  it("내비게이터가 준비되기 전에는 열지 않는다", async () => {
    serverSays([]);
    h.navKey = undefined;
    const r = gate();
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
    h.navKey = "root";
    await settle(r);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("이미 본 사람·건너뛴 사람·플래그 꺼짐: 열지 않는다", async () => {
    serverSays([]);
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

  it("설정 '다시 보기'와 겹침: 게이트가 기록 없음을 읽은 뒤 사용자가 설정에서 안내를 먼저 열면, 저절로 다시 띄우지 않는다", async () => {
    // 게이트: 기록 없음을 읽음. 서버 자료는 아직 (정하기 전)
    const r = gate();
    await settle(r);
    // 설정 > 정보 '처음 사용 안내 다시 보기' → 안내 화면이 열린다 ('본 것' 적기 + 이번 실행 몫 가져가기)
    const w = render(<WelcomeScreen />);
    await flush();
    w.rerender();
    expect(h.store.get(FIRST_RUN_KEY)).toBe("seen");
    // (이번 실행 몫과 상관없이 '다시 읽기'만으로 그만두는지 보려고 몫을 되돌린다)
    forgetFirstRunClaim();
    // 이제 서버 자료가 도착해 '보임'으로 정해져도 띄우기 직전에 기록을 다시 읽어 그만둔다
    serverSays([]);
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("설정에서 연 안내가 기록을 못 적었어도(저장소 실패) 이번 실행 몫을 가져가 두 번째로 띄우지 않는다", async () => {
    const r = gate();
    await settle(r);
    render(<WelcomeScreen />);
    // 기록이 지워진 것처럼 (적기 실패)
    await flush();
    h.store.delete(FIRST_RUN_KEY);
    serverSays([]);
    await settle(r);
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe("안내 한 화면", () => {
  it("위젯 추가법 · 알림 · 토스 연동 세 칸, 서버 주소·토큰 입력 없음, 고지", async () => {
    h.health = { data: { ok: true, tossOpenApi: { configured: true, sync: { lastRunAt: "2026-09-27T01:12:00Z", lastChanges: { added: 0, updated: 0, removed: 0, holdings: 17 } } } }, isError: false, dataUpdatedAt: 0 };
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
    expect(r.text()).toContain("휴대폰 설정 > 애플리케이션 > 가즈아 불기둥 > 알림");
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
    h.health = { data: { ok: true, tossOpenApi: { configured: false } }, isError: false, dataUpdatedAt: 0 };
    expect(render(<WelcomeScreen />).text()).toContain("연결되지 않음 · 종목은 검색해서 직접 추가할 수 있습니다");
    h.health = { data: undefined, isError: true, dataUpdatedAt: 0 };
    expect(render(<WelcomeScreen />).text()).toContain("서버에 연결되지 않아 확인하지 못했습니다");
    h.health = { data: undefined, isError: false, dataUpdatedAt: 0 };
    expect(render(<WelcomeScreen />).text()).toContain("확인 중…");
    await flush();
  });
});
