import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 계정 A단계 검증 5차: 자동 로그인을 끈 주인 세션(앱을 닫으면 로그아웃되는 폰)에는 서버가 푸시를 보내지 않는다.
 * 설정 > 알림 칸에 그 까닭을 한 줄로 보인다 — 스위치를 켰는데 알림이 오지 않는다고 헷갈리지 않게. 자동 로그인 켬·계정 전은 지금 그대로
 */
const h = vi.hoisted(() => ({ flags: {} as Record<string, boolean | undefined> }));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
}));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-community/datetimepicker", () => ({ DateTimePickerAndroid: { open: vi.fn() } }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});
vi.mock("@/api/hooks", () => ({
  useApi: () => ({}),
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useNotificationMutations: () => ({ updateSettings: { mutate: vi.fn() }, sendTest: { mutate: vi.fn(), isPending: false } }),
  useNotificationSettings: () => ({ data: undefined, isLoading: false, isError: false, refetch: async () => ({ data: undefined }) }),
  useRegisteredStocks: () => ({ data: undefined }),
}));
vi.mock("@/lib/backgroundBriefings", () => ({
  briefingTrigger: () => null,
  disableLocalBriefingAlerts: async () => undefined,
  enableLocalBriefingAlerts: async () => undefined,
  isLocalModeEnabled: async () => false,
  runBriefingCheck: async () => undefined,
}));
vi.mock("@/lib/notifications", () => ({
  getStoredToken: async () => null,
  PushSetupError: class extends Error {},
  registerForPush: async () => "t",
  unregisterPush: async () => undefined,
}));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Loading: "Loading", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Toggle: "Toggle" }));

const { NotificationSettingsCard, SHORT_SESSION_PUSH_NOTE } = await import("@/components/NotificationSettingsCard");
const session = await import("@/lib/session");

const OWNER = { id: 1, loginId: "서성원", email: null, isOwner: true, usingInitialPassword: false };
const SERVER = "https://prod.test";

beforeEach(() => {
  session.resetSessionForTests();
  h.flags = { accounts: true };
});

describe("설정 > 알림: 자동 로그인을 끈 세션 (검증 5차)", () => {
  it("자동 로그인 끔이면 '이 기기로 알림이 오지 않아요' 한 줄", async () => {
    await session.saveSession({ apiUrl: SERVER, token: "gzs1_short", remember: false, user: OWNER });
    expect(render(<NotificationSettingsCard />).text()).toContain(SHORT_SESSION_PUSH_NOTE);
  });

  it("자동 로그인 켬·계정 전(세션 없음)·플래그 꺼짐은 그 줄이 없다 (지금 그대로)", async () => {
    await session.saveSession({ apiUrl: SERVER, token: "gzs1_long", remember: true, user: OWNER });
    expect(render(<NotificationSettingsCard />).text()).not.toContain(SHORT_SESSION_PUSH_NOTE);
    session.resetSessionForTests();
    expect(render(<NotificationSettingsCard />).text()).not.toContain(SHORT_SESSION_PUSH_NOTE);
    await session.saveSession({ apiUrl: SERVER, token: "gzs1_short", remember: false, user: OWNER });
    h.flags = { accounts: false };
    expect(render(<NotificationSettingsCard />).text()).not.toContain(SHORT_SESSION_PUSH_NOTE);
  });
});
