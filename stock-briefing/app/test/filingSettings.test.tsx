import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationSettings } from "@/api/types";
import { cleanupRenders, render, type HostNode } from "./miniRender";

/**
 * 3-38 설정 > 알림 카드 '공시 알림' 줄 (플래그 filingAlerts, 앱 fallback 꺼짐).
 *  - 끔(또는 서버가 플래그를 모름): 카드 트리가 지금과 같다 (줄 없음)
 *  - 켬: '종목별 알림' 묶음 아래·[테스트 알림] 위 — 스위치(이 기기 저장, 기본 켬)·설명·조용한 시간·끈 종목·DART 키·마지막 알림 줄
 *  - '브리핑 알림'이 꺼져 있으면 스위치 흐리게(disabled) + '위 브리핑 알림을 켜야 이 기기에 알림이 옵니다.'
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  settings: null as unknown,
  local: true,
  sources: { financials: "없음(DART 키 없음) · edgar(미국)" } as Record<string, string>,
  store: new Map<string, string>(),
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ width: 475, height: 751, scale: 2.625, fontScale: 1 }),
}));
vi.mock("@react-native-community/datetimepicker", () => ({ DateTimePickerAndroid: { open: vi.fn() } }));
vi.mock("expo-notifications", () => ({ scheduleNotificationAsync: vi.fn(async () => undefined) }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));
vi.mock("@/lib/backgroundBriefings", () => ({
  briefingTrigger: () => null,
  disableLocalBriefingAlerts: vi.fn(async () => undefined),
  enableLocalBriefingAlerts: vi.fn(async () => undefined),
  isLocalModeEnabled: async () => h.local,
  runBriefingCheck: vi.fn(async () => 1),
}));
vi.mock("@/lib/notifications", () => ({
  getStoredToken: async () => null,
  PushSetupError: class extends Error {},
  registerForPush: vi.fn(),
  unregisterPush: vi.fn(),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Loading: "Loading", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Toggle: "Toggle" }));
vi.mock("@/api/hooks", () => ({
  useApi: () => ({}),
  useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback,
  useNotificationSettings: () => ({ data: h.settings, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useNotificationMutations: () => ({ updateSettings: { mutate: vi.fn() }, sendTest: { mutate: vi.fn(), isPending: false } }),
  useRegisteredStocks: () => ({ data: undefined, isError: false, isLoading: false }),
  useHealth: () => ({ data: { ok: true, time: "", schedule: null, sources: h.sources } }),
}));

const { NotificationSettingsCard } = await import("@/components/NotificationSettingsCard");
const F = await import("@/lib/filingAlerts");

const SETTINGS: NotificationSettings = {
  morningTime: "08:30", afternoonTime: "16:00", morningEnabled: true, afternoonEnabled: true, weekdaysOnly: true, pushEnabled: true,
  quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [], digest: true, schedule: null,
};

type R = ReturnType<typeof render>;
const rawOf = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(rawOf).join(""));
const kids = (n: HostNode) => n.children.filter((c): c is HostNode => typeof c !== "string");
const treeOf = (r: R) =>
  JSON.stringify(r.tree, function (this: unknown, k: string, v: unknown) {
    if (k === "children" && !(this && typeof this === "object" && "type" in this && "props" in this)) return undefined;
    return typeof v === "function" ? "fn" : v;
  });
const settle = async (r: R) => {
  for (let i = 0; i < 4; i++) await new Promise((res) => setTimeout(res, 0));
  r.rerender();
};
/** '공시 알림' 묶음 (스위치 줄을 담은 View 의 부모) */
const block = (r: R) => {
  const toggle = r.all().find((n) => n.type === "Toggle" && n.props.accessibilityLabel === F.SETTING_TITLE);
  if (!toggle) return null;
  return r.all().find((n) => n.type === "View" && kids(n).some((k) => kids(k).includes(toggle)))!;
};
const notes = (b: HostNode) => kids(b).filter((n) => n.type === "Muted").map(rawOf);

beforeEach(() => {
  cleanupRenders();
  h.flags = { filingAlerts: true };
  h.settings = SETTINGS;
  h.local = true;
  h.sources = { financials: "없음(DART 키 없음) · edgar(미국)" };
  h.store.clear();
});

describe("설정 '공시 알림' 줄", () => {
  it("끔(또는 서버가 모름): 줄이 없고 카드 트리가 줄이 없던 때와 같다", async () => {
    h.flags = {};
    const off = render(<NotificationSettingsCard />);
    await settle(off);
    expect(block(off)).toBeNull();
    expect(off.text()).not.toContain("공시");
    const offTree = treeOf(off);
    cleanupRenders();
    // 켬 트리에서 '공시 알림' 묶음만 빼면 같다
    h.flags = { filingAlerts: true };
    const on = render(<NotificationSettingsCard />);
    await settle(on);
    const b = block(on)!;
    const strip = (nodes: (HostNode | string)[]): (HostNode | string)[] => nodes.filter((n) => n !== b).map((n) => (typeof n === "string" ? n : { ...n, children: strip(n.children) }));
    expect(treeOf({ tree: strip(on.tree) } as R)).toBe(offTree);
  });

  it("켬: '종목별 알림' 묶음 아래·[테스트 알림] 위 · 스위치(기본 켬) · 설명 · 조용한 시간 · DART 키 한 줄", async () => {
    const r = render(<NotificationSettingsCard />);
    await settle(r);
    const card = r.all().find((n) => n.type === "Card")!;
    const order = kids(card).map((n) => (n === block(r) ? "공시" : n.type));
    expect(order.indexOf("공시")).toBe(order.indexOf("Button") - 1);
    const b = block(r)!;
    const toggle = r.all().find((n) => n.type === "Toggle" && n.props.accessibilityLabel === F.SETTING_TITLE)!;
    expect(toggle.props).toMatchObject({ value: true, disabled: false });
    expect(notes(b)).toEqual([F.SETTING_ABOUT, F.settingQuiet("22:00", "07:00"), F.KR_NO_KEY]);
    // 끄면 기기에 저장
    r.act(() => (toggle.props.onValueChange as (v: boolean) => void)(false));
    await settle(r);
    expect(h.store.get("filingAlerts.enabled")).toBe("0");
    expect(r.all().find((n) => n.type === "Toggle" && n.props.accessibilityLabel === F.SETTING_TITLE)!.props.value).toBe(false);
  });

  it("끈 종목이 있으면 한 줄 · 조용한 시간이 꺼져 있으면 그 줄 없음 · DART 키가 있는 서버 · 마지막 알림 줄", async () => {
    h.settings = { ...SETTINGS, quietEnabled: false, mutedCodes: ["MSFT"] };
    h.sources = { financials: "dart(한국) · edgar(미국)" };
    h.store.set("filingAlerts.log", JSON.stringify([{ accession: "0001193125-26-323632", acceptedAt: "2026-07-29T20:04:53Z", notifiedAt: "2026-07-29T22:03:00Z" }]));
    const r = render(<NotificationSettingsCard />);
    await settle(r);
    expect(notes(block(r)!)).toEqual([F.SETTING_ABOUT, F.SETTING_MUTED, F.KR_NOT_YET, "마지막 공시 알림 7/30(목) 07:03 · SEC에 올라온 뒤 1시간 58분"]);
  });

  it("'브리핑 알림'(이 기기)이 꺼져 있으면 스위치 흐리게 + 안내", async () => {
    h.local = false;
    const r = render(<NotificationSettingsCard />);
    await settle(r);
    const toggle = r.all().find((n) => n.type === "Toggle" && n.props.accessibilityLabel === F.SETTING_TITLE)!;
    expect(toggle.props.disabled).toBe(true);
    expect(notes(block(r)!)).toContain(F.SETTING_DEVICE_OFF);
  });
});
