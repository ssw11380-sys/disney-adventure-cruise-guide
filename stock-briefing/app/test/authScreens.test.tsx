import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/api/client";
import { DISCLAIMER } from "@/lib/disclaimer";
import {
  currentSession,
  initialPasswordPromptPending,
  installSessionStorage,
  isFailOpen,
  lastEndReason,
  requestInitialPasswordPrompt,
  resetSessionForTests,
  saveSession,
  SESSION_KEY,
  sessionFor,
  type AccountUser,
} from "@/lib/session";
import { flatStyle } from "./fakeAnimated";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 로그인·회원가입·설정 '계정' 칸 (계정 A단계). 실제 화면을 최소 렌더러로 그리고, RN 부품은 문자열 요소, API 는 가짜.
 *  - 화면 읽기 이름('아이디'·'비밀번호'·'비밀번호 보기'·'자동 로그인, 선택됨'·'로그인'·'회원가입'·'서버 설정'), 기본 자동 로그인 켬
 *  - 자동 로그인 켬/끔에 따른 저장, 처음 비밀번호 권유, 예전 서버(404)는 로그인 없이, 인터넷 오류는 세션을 만들지 않음
 *  - 회원가입은 네 칸만 + 이메일 한 줄, 칸별 오류
 *  - 설정 '계정' 칸: 처음 비밀번호 띠, 모든 기기에서 로그아웃(확인 창), 실패하면 로그아웃하지 않음
 */
const SERVER = "https://prod.test";
const OWNER: AccountUser = { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: true };
const MEMBER: AccountUser = { id: 7, loginId: "newbie", email: "n@example.com", isOwner: false, usingInitialPassword: false };

const h = vi.hoisted(() => ({
  win: { width: 360, height: 752, scale: 3, fontScale: 1 },
  flag: true,
  api: {} as Record<string, ReturnType<typeof vi.fn>>,
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  alert: vi.fn(),
  announce: vi.fn(),
  store: new Map<string, string>(),
}));

vi.mock("react-native", async () => {
  const { makeFakeAnimated } = await import("./fakeAnimated");
  const fake = makeFakeAnimated();
  return {
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  ActivityIndicator: "ActivityIndicator",
  Modal: "Modal",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: { position: "absolute" } },
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
  Animated: fake.Animated,
  Easing: fake.Easing,
  AccessibilityInfo: { announceForAccessibility: h.announce, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove: () => undefined }) },
  Alert: { alert: h.alert },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  PixelRatio: { roundToNearestPixel: (v: number) => v },
  Platform: { OS: "android" },
  useWindowDimensions: () => h.win,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 28, bottom: 24, left: 0, right: 0 }) }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("react-native-svg", () => ({ Svg: "Svg", Defs: "Defs", Ellipse: "Ellipse", LinearGradient: "SvgLinearGradient", Line: "Line", Mask: "Mask", Path: "Path", RadialGradient: "RadialGradient", Rect: "Rect", Stop: "Stop", Text: "SvgText" }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("expo-device", () => ({ modelName: "SM-F966N" }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, replace: h.replace, back: h.back, canGoBack: () => true } }));
vi.mock("@/api/hooks", () => ({ useApi: () => h.api, useFeature: (key: string, fallback = false) => (key === "accounts" ? h.flag : fallback) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: SERVER, apiToken: "", ready: true }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle" }));

const { default: LoginScreen } = await import("@/app/login");
const { default: SignupScreen } = await import("@/app/signup");
const { AccountCard } = await import("@/components/AccountCard");
const { MemberNotice } = await import("@/components/MemberNotice");
const { InitialPasswordSheet } = await import("@/components/auth/InitialPasswordSheet");
const { setBeforeLogout } = await import("@/lib/logout");
const { gateOf } = await import("@/lib/authGate");

type Screen = ReturnType<typeof render>;
const settle = async (r: Screen) => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};
const typeIn = (r: Screen, label: string, v: string) => r.act(() => (r.byLabel(label).props.onChangeText as (v: string) => void)(v));
const blur = (r: Screen, label: string) => r.act(() => (r.byLabel(label).props.onBlur as (e: unknown) => void)({}));
const press = (r: Screen, label: string) => r.act(() => (r.byLabel(label).props.onPress as () => void)());
const byTitle = (r: Screen, title: string): HostNode => {
  const hits = r.all().filter((n) => n.props.title === title);
  if (hits.length !== 1) throw new Error(`"${title}" 버튼이 ${hits.length}개`);
  return hits[0]!;
};
const authResult = (user: AccountUser, token = "gzs1_new") => ({ token, user, session: { id: 3, remember: true, expiresAt: "2027-09-28T10:00:00+09:00" } });
const apiErr = (status: number, code: string, body?: Record<string, unknown>) => new ApiRequestError(status, code, "x", "/api/auth/login", SERVER, body);

beforeEach(() => {
  cleanupRenders();
  resetSessionForTests();
  h.store.clear();
  installSessionStorage({ getItem: async (k) => h.store.get(k) ?? null, setItem: async (k, v) => void h.store.set(k, v), removeItem: async (k) => void h.store.delete(k) });
  h.win = { width: 360, height: 752, scale: 3, fontScale: 1 };
  h.flag = true;
  h.api = { login: vi.fn(), signup: vi.fn(), logout: vi.fn(async () => undefined), logoutAll: vi.fn(async () => undefined), changeEmail: vi.fn(), me: vi.fn() };
  for (const f of [h.push, h.replace, h.back, h.alert, h.announce]) f.mockReset();
});
afterEach(() => {
  cleanupRenders();
  resetSessionForTests();
  setBeforeLogout(null);
});

describe("로그인 화면", () => {
  it("칸·버튼 이름(화면 읽기), 자동 로그인 기본 켬, 그림 자리·로고·고지 문구", () => {
    const r = render(<LoginScreen />);
    for (const label of ["아이디", "비밀번호", "비밀번호 보기", "로그인", "회원가입", "서버 설정", "가즈아 불기둥"]) expect(r.has(label), label).toBe(true);
    const box = r.byLabel("자동 로그인");
    expect(box.props.accessibilityRole).toBe("checkbox");
    expect(box.props.accessibilityState).toEqual({ checked: true });
    expect(r.byLabel("비밀번호").props.secureTextEntry).toBe(true);
    expect(r.all().filter((n) => n.props.testID === "login-hero")).toHaveLength(1);
    const text = r.text();
    expect(text).toContain("시세 · 브리핑 · 지표");
    expect(text).toContain(DISCLAIMER);
    // 투자 권유로 읽히는 말·느낌표 없음
    expect(text).not.toMatch(/수익|추천|보장|대박|!/);
    // 눈 모양: 누르면 비밀번호가 보이고 이름이 '숨기기'로
    press(r, "비밀번호 보기");
    expect(r.byLabel("비밀번호").props.secureTextEntry).toBe(false);
    expect(r.has("비밀번호 숨기기")).toBe(true);
    press(r, "회원가입");
    expect(h.push).toHaveBeenCalledWith("/signup");
    press(r, "서버 설정");
    expect(h.push).toHaveBeenCalledWith("/server");
  });

  it("화면 읽기 순서: 아이디 → 비밀번호 → 보기 → 자동 로그인 → 로그인 → 회원가입 → 서버 설정 → 고지", () => {
    const r = render(<LoginScreen />);
    const order = r
      .all()
      .map((n) => n.props.accessibilityLabel as string | undefined)
      .filter((l): l is string => ["아이디", "비밀번호", "비밀번호 보기", "자동 로그인", "로그인", "회원가입", "서버 설정"].includes(l ?? ""));
    expect(order).toEqual(["아이디", "비밀번호", "비밀번호 보기", "자동 로그인", "로그인", "회원가입", "서버 설정"]);
    const t = r.text();
    expect(t.indexOf("회원가입")).toBeLessThan(t.indexOf("서버 설정"));
    expect(t.indexOf("서버 설정")).toBeLessThan(t.indexOf(DISCLAIMER));
  });

  it("입력 칸 모양: 입력 중이면 금색 테두리 + 바깥 3dp 옅은 금색, 오류 칸은 주황 테두리 + 아이콘, 버튼은 눌리면 어두워진다", async () => {
    const { authColors: C } = await import("@/tokens");
    const r = render(<LoginScreen />);
    const box = () => r.all().find((n) => n.type === "View" && n.children.some((c) => typeof c !== "string" && c.props.accessibilityLabel === "아이디"))!;
    const ring = () => r.all().filter((n) => flatStyle(n.props.style).borderWidth === 3);
    expect(ring()).toHaveLength(0);
    r.act(() => (r.byLabel("아이디").props.onFocus as (e: unknown) => void)({}));
    expect(ring()).toHaveLength(1);
    expect(flatStyle(ring()[0]!.props.style).borderColor).toBe(C.focusRing);
    expect(flatStyle(box().props.style)).toMatchObject({ borderColor: C.fieldFocus, backgroundColor: C.fieldActive });
    r.act(() => (r.byLabel("아이디").props.onBlur as (e: unknown) => void)({}));
    expect(ring()).toHaveLength(0);
    press(r, "로그인");
    expect(flatStyle(box().props.style).borderColor).toBe(C.danger);
    expect(r.all().filter((n) => n.type === "Ionicons" && n.props.name === "alert-circle")).toHaveLength(2);
    // [로그인] 금색 그러데이션: 누르는 동안 한 단계 어둡게
    const fill = () => r.all().find((n) => n.type === "LinearGradient" && (n.props.colors as string[])[0]?.startsWith("#") && ((n.props.colors as string[])[0] === C.primaryTop || (n.props.colors as string[])[0] === C.primaryPressedTop))!;
    expect(fill().props.colors).toEqual([C.primaryTop, C.primaryBottom]);
    r.act(() => (r.byLabel("로그인").props.onPressIn as () => void)());
    expect(fill().props.colors).toEqual([C.primaryPressedTop, C.primaryPressedBottom]);
    r.act(() => (r.byLabel("로그인").props.onPressOut as () => void)());
    expect(fill().props.colors).toEqual([C.primaryTop, C.primaryBottom]);
  });

  it("빈 칸으로 누르면 칸 아래 오류 (서버에 묻지 않음, 화면 읽기로 알림)", () => {
    const r = render(<LoginScreen />);
    press(r, "로그인");
    expect(r.text()).toContain("아이디를 넣어 주세요");
    expect(r.text()).toContain("비밀번호를 넣어 주세요");
    expect(h.api.login).not.toHaveBeenCalled();
    expect(h.announce).toHaveBeenCalledWith("아이디를 넣어 주세요");
  });

  it("자동 로그인 켬: 로그인하면 세션을 기기에 저장, 처음 비밀번호면 권유를 한 번", async () => {
    h.api.login!.mockResolvedValue(authResult(OWNER));
    const r = render(<LoginScreen />);
    typeIn(r, "아이디", " 서성원 ");
    typeIn(r, "비밀번호", "1111");
    press(r, "로그인");
    await settle(r);
    expect(h.api.login).toHaveBeenCalledWith({ loginId: "서성원", password: "1111", remember: true, deviceName: "SM-F966N" });
    expect(sessionFor(SERVER)).toMatchObject({ token: "gzs1_new", remember: true, user: { loginId: "서성원", isOwner: true } });
    expect(JSON.parse(h.store.get(SESSION_KEY)!).token).toBe("gzs1_new");
    expect(initialPasswordPromptPending()).toBe(true);
  });

  it("자동 로그인 끔: 작은 안내가 보이고, 세션은 메모리에만 (앱을 닫으면 다시 로그인)", async () => {
    h.api.login!.mockResolvedValue(authResult({ ...OWNER, usingInitialPassword: false }));
    const r = render(<LoginScreen />);
    press(r, "자동 로그인");
    expect(r.byLabel("자동 로그인").props.accessibilityState).toEqual({ checked: false });
    expect(r.text()).toContain("앱을 완전히 닫으면 다시 로그인해요");
    typeIn(r, "아이디", "서성원");
    typeIn(r, "비밀번호", "newpass99");
    press(r, "로그인");
    await settle(r);
    expect(h.api.login!.mock.calls[0]![0]).toMatchObject({ remember: false });
    expect(sessionFor(SERVER)?.remember).toBe(false);
    expect(h.store.has(SESSION_KEY)).toBe(false);
    expect(initialPasswordPromptPending()).toBe(false);
  });

  it("자동 로그인 체크는 로그인 화면을 열 때마다 늘 켬 (지난번에 끄고 로그인했어도 — 검증 4차, 선택을 기기에 적지 않는다)", async () => {
    h.api.login!.mockResolvedValue(authResult({ ...OWNER, usingInitialPassword: false }));
    const r = render(<LoginScreen />);
    press(r, "자동 로그인");
    typeIn(r, "아이디", "서성원");
    typeIn(r, "비밀번호", "newpass99");
    press(r, "로그인");
    await settle(r);
    expect(sessionFor(SERVER)?.remember).toBe(false);
    const { clearSession } = await import("@/lib/session");
    await clearSession("logout");
    const again = render(<LoginScreen />);
    expect(again.byLabel("자동 로그인").props.accessibilityState).toEqual({ checked: true });
    expect(again.text()).not.toContain("앱을 완전히 닫으면 다시 로그인해요");
    expect([...h.store.keys()].some((k) => k.startsWith("auth.rememberPref"))).toBe(false);
  });

  it("잠김(429): 서버가 준 남은 시간(retryAfterSec)으로 몇 분 뒤인지 (검증 4차 — 예전에는 늘 '10분 뒤')", async () => {
    const r = render(<LoginScreen />);
    typeIn(r, "아이디", "서성원");
    typeIn(r, "비밀번호", "1234");
    for (const [sec, text] of [[360, "여러 번 틀려서 잠시 막아 두었어요. 6분 뒤에 다시 해 주세요"], [30, "여러 번 틀려서 잠시 막아 두었어요. 1분 뒤에 다시 해 주세요"], [600, "여러 번 틀려서 잠시 막아 두었어요. 10분 뒤에 다시 해 주세요"]] as const) {
      h.api.login!.mockRejectedValueOnce(apiErr(429, "TOO_MANY_ATTEMPTS", { code: "too_many_attempts", message: "여러 번 틀려서 잠시 막아 두었어요. 10분 뒤에 다시 해 주세요", retryAfterSec: sec }));
      press(r, "로그인");
      await settle(r);
      expect(r.text()).toContain(text);
    }
    // IP 제한(요청이 너무 잦음)도 남은 분
    h.api.login!.mockRejectedValueOnce(apiErr(429, "TOO_MANY_ATTEMPTS", { code: "too_many_attempts", message: "요청이 너무 잦아요. 잠시 뒤에 다시 해 주세요", retryAfterSec: 125 }));
    press(r, "로그인");
    await settle(r);
    expect(r.text()).toContain("요청이 너무 잦아요. 3분 뒤에 다시 해 주세요");
  });

  it("틀림·인터넷 오류·API 토큰 오류는 알맞은 문구, 세션은 만들지 않는다", async () => {
    const r = render(<LoginScreen />);
    typeIn(r, "아이디", "서성원");
    typeIn(r, "비밀번호", "1234");
    for (const [e, text] of [
      [apiErr(400, "BAD_CREDENTIALS", { code: "bad_credentials", message: "아이디 또는 비밀번호가 맞지 않아요" }), "아이디 또는 비밀번호가 맞지 않아요"],
      [apiErr(0, "NETWORK"), "서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요"],
      [apiErr(429, "TOO_MANY_ATTEMPTS", { code: "too_many_attempts", message: "여러 번 틀려서 잠시 막아 두었어요. 10분 뒤에 다시 해 주세요" }), "10분 뒤에 다시 해 주세요"],
      [apiErr(503, "HTTP_503"), "서버에 잠시 문제가 있어요"],
    ] as const) {
      h.api.login!.mockRejectedValueOnce(e);
      press(r, "로그인");
      await settle(r);
      expect(r.text()).toContain(text);
      expect(currentSession()).toBeNull();
    }
    h.api.login!.mockRejectedValueOnce(apiErr(401, "UNAUTHORIZED", { error: "UNAUTHORIZED" }));
    press(r, "로그인");
    await settle(r);
    expect(r.text()).toContain("서버 연결 설정을 확인해 주세요 (API 토큰)");
    press(r, "서버 설정 열기");
    expect(h.push).toHaveBeenCalledWith("/server");
  });

  it("예전 서버(로그인 주소 404)면 로그인 없이 지금처럼 들어간다 (fail-open)", async () => {
    h.api.login!.mockRejectedValueOnce(apiErr(404, "NOT_FOUND", { error: "NOT_FOUND", message: "없는 주소입니다" }));
    const r = render(<LoginScreen />);
    typeIn(r, "아이디", "서성원");
    typeIn(r, "비밀번호", "1111");
    press(r, "로그인");
    await settle(r);
    expect(isFailOpen(SERVER)).toBe(true);
    expect(gateOf({ settingsReady: true, loaded: true, flag: true, seen: true, failOpen: isFailOpen(SERVER), session: null }).needsLogin).toBe(false);
  });

  it("다른 기기에서 비밀번호를 바꿔 세션이 끝났으면 '다시 로그인해 주세요'", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_old", remember: true, user: OWNER });
    const { handleSessionInvalid } = await import("@/lib/session");
    handleSessionInvalid(SERVER, "gzs1_old");
    await settle(render(<View />));
    expect(lastEndReason()).toBe("invalid");
    expect(render(<LoginScreen />).text()).toContain("다시 로그인해 주세요");
  });

  it("펼친 폴드 933×704: 왼쪽 그림(513) · 오른쪽 입력 두 칸, 704×933 은 한 칸", () => {
    h.win = { width: 933, height: 704, scale: 2.6, fontScale: 1 };
    const wide = render(<LoginScreen />);
    const hero = wide.all().find((n) => n.props.testID === "login-hero")!;
    expect(hero.props.style).toMatchObject({ width: 513, height: 704 });
    h.win = { width: 704, height: 933, scale: 2.6, fontScale: 1 };
    const tall = render(<LoginScreen />);
    expect(tall.all().find((n) => n.props.testID === "login-hero")!.props.style).toMatchObject({ width: 704, height: 380 });
  });
});

const View = "View" as unknown as React.ComponentType;

describe("회원가입 화면", () => {
  it("네 칸만 (아이디·비밀번호·비밀번호 확인·이메일) + 이메일 쓰임 한 줄", () => {
    const r = render(<SignupScreen />);
    expect(r.all().filter((n) => n.type === "TextInput").map((n) => n.props.accessibilityLabel)).toEqual(["아이디", "비밀번호", "비밀번호 확인", "이메일"]);
    expect(r.text()).toContain("이메일은 비밀번호를 잃어버렸을 때 확인용으로만 씁니다.");
    expect(r.text()).toContain("2~20자, 한글·영문·숫자·밑줄(_)");
    expect(r.text()).toContain("8자 이상, 영문과 숫자를 함께");
    expect(r.has("가입하고 시작하기")).toBe(true);
    expect(r.text()).toContain(DISCLAIMER);
    // 머리: 금색 로고 + 작은 정지 계단(꾸밈 — 화면 읽기에서 뺌), 제목 아래 한 줄
    expect(r.byLabel("가즈아 불기둥").props.accessibilityRole).toBe("header");
    const hasSvg = (n: HostNode): boolean => n.children.some((c) => typeof c !== "string" && (c.type === "Svg" || hasSvg(c)));
    expect(r.all().some((n) => n.props.importantForAccessibility === "no-hide-descendants" && hasSvg(n))).toBe(true);
    expect(r.text()).toContain("아이디 · 비밀번호 · 이메일만 있으면 돼요");
    expect(r.text()).not.toMatch(/수익|추천|보장|대박|!/);
  });

  it("칸을 떠날 때·보낼 때 서버와 같은 규칙으로 칸 아래 오류", () => {
    const r = render(<SignupScreen />);
    press(r, "가입하고 시작하기");
    for (const t of ["아이디를 넣어 주세요", "비밀번호를 넣어 주세요", "비밀번호를 한 번 더 넣어 주세요", "이메일을 넣어 주세요"]) expect(r.text()).toContain(t);
    typeIn(r, "아이디", "a");
    blur(r, "아이디");
    expect(r.text()).toContain("2~20자, 한글·영문·숫자·밑줄(_)만 쓸 수 있어요");
    typeIn(r, "비밀번호", "abcdefgh");
    blur(r, "비밀번호");
    expect(r.text()).toContain("영문과 숫자를 함께 넣어 주세요");
    typeIn(r, "비밀번호", "abcd1234");
    typeIn(r, "비밀번호 확인", "abcd12345");
    blur(r, "비밀번호 확인");
    expect(r.text()).toContain("비밀번호가 서로 달라요");
    typeIn(r, "이메일", "bad");
    blur(r, "이메일");
    expect(r.text()).toContain("이메일 모양을 확인해 주세요");
    expect(h.api.signup).not.toHaveBeenCalled();
  });

  it("서버가 준 칸별 오류(아이디 중복)를 그 칸 아래에, 성공하면 바로 로그인(자동 로그인 켬, 주인 아님)", async () => {
    const r = render(<SignupScreen />);
    typeIn(r, "아이디", "서성원");
    typeIn(r, "비밀번호", "abcd1234");
    typeIn(r, "비밀번호 확인", "abcd1234");
    typeIn(r, "이메일", "N@Example.com");
    h.api.signup!.mockRejectedValueOnce(apiErr(409, "LOGIN_ID_TAKEN", { code: "login_id_taken", message: "이미 쓰고 있는 아이디예요", fields: { loginId: "login_id_taken" } }));
    press(r, "가입하고 시작하기");
    await settle(r);
    expect(r.byLabel("아이디").props.accessibilityHint).toBe("이미 쓰고 있는 아이디예요");
    typeIn(r, "아이디", "newbie");
    h.api.signup!.mockResolvedValueOnce(authResult(MEMBER, "gzs1_member"));
    press(r, "가입하고 시작하기");
    await settle(r);
    expect(h.api.signup!.mock.calls[1]![0]).toEqual({ loginId: "newbie", password: "abcd1234", passwordConfirm: "abcd1234", email: "n@example.com", remember: true, deviceName: "SM-F966N" });
    expect(sessionFor(SERVER)).toMatchObject({ token: "gzs1_member", remember: true, user: { isOwner: false } });
  });
});

describe("설정 '계정' 칸 · 주인 아닌 계정 안내 · 처음 비밀번호 권유", () => {
  it("플래그가 꺼져 있거나 로그인 전이면 없다 (지금 화면 그대로)", async () => {
    expect(render(<AccountCard />).tree).toEqual([]);
    await saveSession({ apiUrl: SERVER, token: "gzs1_o", remember: true, user: OWNER });
    h.flag = false;
    expect(render(<AccountCard />).tree).toEqual([]);
    expect(render(<MemberNotice />).tree).toEqual([]);
  });

  it("주인: 처음 비밀번호 띠 + [바꾸기], 아이디·'주인'·이메일 없음, 비밀번호 바꾸기·로그아웃 버튼", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_o", remember: true, user: OWNER });
    const r = render(<AccountCard />);
    const text = r.text();
    for (const t of ["처음 비밀번호를 쓰고 있어요", "계정"]) expect(text).toContain(t);
    const title = r.all().find((n) => n.type === "SectionTitle")!;
    expect((title.props.right as React.ReactElement<{ children: string }>).props.children).toBe("주인");
    const rows = Object.fromEntries(r.all().filter((n) => n.type === "Row").map((n) => [n.props.label, n.props.value]));
    expect(rows).toEqual({ 아이디: "서성원", 이메일: "없음", "자동 로그인": "켬 · 1년 유지" });
    press(r, "처음 비밀번호 바꾸기");
    expect(h.push).toHaveBeenCalledWith("/account/password");
    for (const title of ["이메일 등록", "비밀번호 바꾸기", "로그아웃", "모든 기기에서 로그아웃"]) byTitle(r, title);
    // 주인 아닌 계정 안내는 주인에게 없다
    expect(render(<MemberNotice />).tree).toEqual([]);
  });

  it("이메일 등록·변경: 지금 비밀번호를 함께 넣어야 하고 서버에 둘 다 보낸다 (세션만으로는 못 바꾸게). 틀리면 비밀번호 칸 아래에", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_o", remember: true, user: { ...OWNER, usingInitialPassword: false } });
    const r = render(<AccountCard />);
    r.act(() => (byTitle(r, "이메일 등록").props.onPress as () => void)());
    expect(r.byLabel("지금 비밀번호").props.secureTextEntry).toBe(true);
    typeIn(r, "이메일", "me@example.com");
    press(r, "이메일 저장");
    expect(r.text()).toContain("지금 비밀번호를 넣어 주세요");
    expect(h.api.changeEmail).not.toHaveBeenCalled();
    typeIn(r, "지금 비밀번호", "0000");
    h.api.changeEmail!.mockRejectedValueOnce(apiErr(400, "BAD_CURRENT_PASSWORD", { code: "bad_current_password", message: "지금 비밀번호가 맞지 않아요", fields: { current: "bad_current_password" } }));
    press(r, "이메일 저장");
    await settle(r);
    expect(h.api.changeEmail).toHaveBeenLastCalledWith("me@example.com", "0000");
    expect(r.text()).toContain("지금 비밀번호가 맞지 않아요");
    typeIn(r, "지금 비밀번호", "1111");
    h.api.changeEmail!.mockResolvedValueOnce({ user: { ...OWNER, email: "me@example.com", usingInitialPassword: false } });
    press(r, "이메일 저장");
    await settle(r);
    expect(h.api.changeEmail).toHaveBeenLastCalledWith("me@example.com", "1111");
    expect(sessionFor(SERVER)?.user.email).toBe("me@example.com");
    // 저장하면 칸을 닫고 넣은 비밀번호를 남기지 않는다
    expect(r.all().some((n) => n.props.accessibilityLabel === "지금 비밀번호")).toBe(false);
  });

  it("모든 기기에서 로그아웃: 확인 창 뒤 서버에 알리고(주인은 알림 등록부터 빼고) 세션을 지운다. 서버에 닿지 않으면 지우지 않는다", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_o", remember: true, user: { ...OWNER, usingInitialPassword: false } });
    const unregister = vi.fn(async () => undefined);
    setBeforeLogout(unregister);
    const r = render(<AccountCard />);
    // 실패: 인터넷 오류
    h.api.logoutAll!.mockRejectedValueOnce(apiErr(0, "NETWORK"));
    r.act(() => (byTitle(r, "모든 기기에서 로그아웃").props.onPress as () => void)());
    expect(h.alert.mock.calls[0]![1]).toBe("이 기기를 포함해 모든 기기에서 로그아웃해요.");
    const confirm = (h.alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[]).find((b) => b.text === "로그아웃")!;
    confirm.onPress!();
    await settle(r);
    expect(sessionFor(SERVER)?.token).toBe("gzs1_o");
    expect(h.alert).toHaveBeenLastCalledWith("로그아웃하지 못했어요", "서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요");
    // 성공
    h.alert.mockClear();
    r.act(() => (byTitle(r, "모든 기기에서 로그아웃").props.onPress as () => void)());
    (h.alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[]).find((b) => b.text === "로그아웃")!.onPress!();
    await settle(r);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(h.api.logoutAll).toHaveBeenCalledTimes(2);
    expect(sessionFor(SERVER)).toBeNull();
    expect(h.store.has(SESSION_KEY)).toBe(false);
    expect(lastEndReason()).toBe("logout");
  });

  it("이 기기만 로그아웃: 서버가 실패해도 이 기기에서는 로그아웃", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_m", remember: true, user: MEMBER });
    h.api.logout!.mockRejectedValueOnce(apiErr(0, "NETWORK"));
    const r = render(<AccountCard />);
    r.act(() => (byTitle(r, "로그아웃").props.onPress as () => void)());
    (h.alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[]).find((b) => b.text === "로그아웃")!.onPress!();
    await settle(r);
    expect(sessionFor(SERVER)).toBeNull();
  });

  it("주인 아닌 계정: 잔고·브리핑 탭 안내 '개인 종목 기능은 준비 중이에요 — 시장·종목 정보는 지금 볼 수 있어요'", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_m", remember: true, user: MEMBER });
    const r = render(<MemberNotice />);
    expect(r.text()).toBe("개인 종목 기능은 준비 중이에요 — 시장·종목 정보는 지금 볼 수 있어요");
    expect(r.byLabel("개인 종목 기능은 준비 중이에요 — 시장·종목 정보는 지금 볼 수 있어요")).toBeTruthy();
    expect(render(<AccountCard />).text()).not.toContain("처음 비밀번호");
  });

  it("플래그가 꺼져도(관리 API · 비상 끄기) 지금 서버에 주인 아닌 계정 세션이 있으면 안내 띠 — 서버가 그 계정으로 막으므로 빈 잔고 대신", async () => {
    const { accountViewOf } = await import("@/lib/account");
    const { activeSession, noteActiveServer } = await import("@/lib/session");
    await saveSession({ apiUrl: SERVER, token: "gzs1_m", remember: true, user: MEMBER });
    h.flag = false;
    noteActiveServer(SERVER);
    expect(render(<MemberNotice />).text()).toBe("개인 종목 기능은 준비 중이에요 — 시장·종목 정보는 지금 볼 수 있어요");
    // 로그인 화면은 꺼짐 그대로 (on·session 없음)
    expect(accountViewOf(false, currentSession(), activeSession())).toEqual({ on: false, session: null, member: true });
    // 설정 '계정' 칸은 보인다 — 아이디와 안내 한 줄만, **버튼 없음** (검증 5차: 비상 모드에서 [로그아웃]을 누르면 서버 404 → 세션만 잊고
    // API 토큰만 = 주인이 되어 그 폰에 주인 잔고가 보였다. 세션을 계속 보내야 서버가 그 계정으로 막는다)
    const card = render(<AccountCard />);
    expect(card.text()).toContain("로그인 기능이 잠시 꺼져 있어요. 다시 켜지면 여기에서 로그아웃할 수 있어요.");
    expect(Object.fromEntries(card.all().filter((n) => n.type === "Row").map((n) => [n.props.label, n.props.value]))).toEqual({ 아이디: "newbie" });
    expect(card.all().filter((n) => n.type === "Button")).toEqual([]);
    expect(card.text()).not.toContain("이 기기에서 로그아웃할 수 있어요");
    expect(sessionFor(SERVER)?.token).toBe("gzs1_m");
    // 다른 서버로 바꿨으면 그 서버는 세션을 받지 않으므로 안내 없음
    noteActiveServer("https://other.test");
    expect(render(<MemberNotice />).tree).toEqual([]);
    // 주인 세션·세션 없음은 지금 그대로
    noteActiveServer(SERVER);
    await saveSession({ apiUrl: SERVER, token: "gzs1_o", remember: true, user: OWNER });
    expect(render(<MemberNotice />).tree).toEqual([]);
    expect(accountViewOf(false, null, null)).toEqual({ on: false, session: null, member: false });
  });

  it("비상 모드(서버가 로그아웃 주소를 모름 — 404)에서 주인 아닌 계정의 로그아웃은 세션을 지우지 않는다 (검증 5차 — 지우면 API 토큰만 = 주인 잔고가 보임)", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_m", remember: true, user: MEMBER });
    // 플래그가 막 꺼져 설정 칸이 아직 보통 모습일 때 누른 경우
    h.api.logout!.mockRejectedValueOnce(apiErr(404, "NOT_FOUND"));
    const r = render(<AccountCard />);
    r.act(() => (byTitle(r, "로그아웃").props.onPress as () => void)());
    (h.alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[]).find((b) => b.text === "로그아웃")!.onPress!();
    await settle(r);
    expect(sessionFor(SERVER)?.token).toBe("gzs1_m");
    expect(h.store.has(SESSION_KEY)).toBe(true);
    expect(h.alert.mock.calls.at(-1)![0]).toBe("로그아웃하지 못했어요");
    expect(h.alert.mock.calls.at(-1)![1]).toBe("로그인 기능이 잠시 꺼져 있어 지금은 로그아웃할 수 없어요. 다시 켜지면 로그아웃할 수 있어요.");
    // 주인은 404 여도 이 기기에서 로그아웃 (비상 모드에서 주인은 API 토큰만으로도 주인 — 잊어도 드러나는 것이 없다)
    await saveSession({ apiUrl: SERVER, token: "gzs1_o", remember: true, user: OWNER });
    h.api.logout!.mockRejectedValueOnce(apiErr(404, "NOT_FOUND"));
    const o = render(<AccountCard />);
    o.act(() => (byTitle(o, "로그아웃").props.onPress as () => void)());
    (h.alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[]).find((b) => b.text === "로그아웃")!.onPress!();
    await settle(o);
    expect(sessionFor(SERVER)).toBeNull();
  });

  it("비상 모드로 막 바뀐 순간의 [모든 기기에서 로그아웃](404)도 같은 안내 — 세션은 그대로 (검증 6차 — 예전에는 '잠시 뒤 다시 해 주세요')", async () => {
    for (const user of [MEMBER, OWNER]) {
      await saveSession({ apiUrl: SERVER, token: "gzs1_x", remember: true, user });
      h.api.logoutAll!.mockRejectedValueOnce(apiErr(404, "NOT_FOUND"));
      const r = render(<AccountCard />);
      r.act(() => (byTitle(r, "모든 기기에서 로그아웃").props.onPress as () => void)());
      (h.alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[]).find((b) => b.text === "로그아웃")!.onPress!();
      await settle(r);
      expect(sessionFor(SERVER)?.token, user.loginId).toBe("gzs1_x");
      expect(h.alert.mock.calls.at(-1)!.slice(0, 2)).toEqual(["로그아웃하지 못했어요", "로그인 기능이 잠시 꺼져 있어 지금은 로그아웃할 수 없어요. 다시 켜지면 로그아웃할 수 있어요."]);
    }
  });

  it("처음 비밀번호 권유 시트: 로그인 직후 한 번, [나중에] 로 닫고 다시 뜨지 않음", async () => {
    await saveSession({ apiUrl: SERVER, token: "gzs1_o", remember: true, user: OWNER });
    expect(render(<InitialPasswordSheet />).tree).toEqual([]);
    requestInitialPasswordPrompt();
    const r = render(<InitialPasswordSheet />);
    expect(r.text()).toContain("처음 비밀번호를 쓰고 있어요");
    // 로그인 화면과 같은 어두운 색 (앱 테마와 상관없이 — 검증 4차): 시트 바탕·가림막·금색 [비밀번호 바꾸기] 그러데이션
    const { authColors: C } = await import("@/tokens");
    const bgs = r.all().map((n) => flatStyle(n.props.style).backgroundColor).filter(Boolean);
    expect(bgs).toContain(C.sheet);
    expect(bgs).toContain(C.scrim);
    expect(r.all().some((n) => n.type === "LinearGradient" && (n.props.colors as string[])[0] === C.primaryTop)).toBe(true);
    expect(r.text()).toContain("다른 사람도 알 수 있는 비밀번호예요. 지금 바꾸는 것을 권해요.");
    press(r, "나중에");
    expect(initialPasswordPromptPending()).toBe(false);
    expect(r.tree).toEqual([]);
    requestInitialPasswordPrompt();
    const r2 = render(<InitialPasswordSheet />);
    press(r2, "비밀번호 바꾸기");
    expect(h.push).toHaveBeenCalledWith("/account/password");
  });
});

describe("로그인 화면을 보일지 (gateOf)", () => {
  const base = { settingsReady: true, loaded: true, flag: true as boolean | null, seen: false, failOpen: false, session: null };
  it("세션이 있으면 인터넷·플래그와 상관없이 앱 (로그아웃되지 않음)", () => {
    const session = { apiUrl: SERVER, token: "t", remember: true, user: OWNER, savedAt: 0 };
    expect(gateOf({ ...base, session }).needsLogin).toBe(false);
    expect(gateOf({ ...base, flag: null, seen: true, session }).needsLogin).toBe(false);
  });
  it("세션 없음: 플래그 켜짐 → 로그인, 플래그 꺼짐·모름(예전 서버) → 지금처럼, 모르면 이 기기가 본 적 있는지", () => {
    expect(gateOf(base).needsLogin).toBe(true);
    expect(gateOf({ ...base, flag: false, seen: true }).needsLogin).toBe(false);
    expect(gateOf({ ...base, flag: null }).needsLogin).toBe(false);
    expect(gateOf({ ...base, flag: null, seen: true }).needsLogin).toBe(true);
    expect(gateOf({ ...base, failOpen: true }).needsLogin).toBe(false);
  });
  it("설정·세션을 읽기 전에는 로그인 화면으로 바꾸지 않는다 (스플래시가 가림)", () => {
    expect(gateOf({ ...base, loaded: false })).toMatchObject({ ready: false, needsLogin: false });
    expect(gateOf({ ...base, settingsReady: false })).toMatchObject({ ready: false, needsLogin: false });
  });
});
