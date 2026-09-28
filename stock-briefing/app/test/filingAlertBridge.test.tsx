import { readFileSync } from "node:fs";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilingAlertItem } from "@/api/types";
import { cleanupRenders, render } from "./miniRender";

/**
 * 3-38 앱이 앞에 있을 때의 새 공시 확인 (FilingAlertBridge, 플래그 filingAlerts): 켤 때·앞으로 올 때·5분마다(4분 안이면 건너뜀) /api/filings/alerts → 알림 규칙.
 * 플래그가 꺼져 있거나 모르면·로컬 모드가 아니면 요청 0
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  local: true,
  calls: 0,
  notified: [] as unknown[],
  appState: null as ((s: string) => void) | null,
}));
vi.mock("react-native", () => ({ AppState: { addEventListener: (_e: string, fn: (s: string) => void) => ((h.appState = fn), { remove: () => (h.appState = null) }) }, Platform: { OS: "android" } }));
vi.mock("@/api/hooks", () => {
  const api = { filingAlerts: async () => (h.calls++, { asOf: "", items: FX.alerts }) };
  return { useFeature: (k: string, f = false) => h.flags[k] ?? f, useApi: () => api };
});
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ ready: true }) }));
vi.mock("@/lib/backgroundBriefings", () => ({ isLocalModeEnabled: async () => h.local }));
vi.mock("@/lib/notifications", () => ({ ensureFilingChannel: async () => undefined }));
vi.mock("@/lib/filingNotify", () => ({ notifyFilings: async (items: unknown) => void h.notified.push(items) }));
vi.mock("@/widgets/data", () => ({ loadNotifyPrefs: async () => ({ digest: true, quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [], running: false }) }));
const FX = vi.hoisted(() => ({ alerts: [] as FilingAlertItem[] }));
FX.alerts = (JSON.parse(readFileSync(new URL("../../shared/fixtures/filingAlerts.json", import.meta.url), "utf8")) as { alerts: FilingAlertItem[] }).alerts;

const { FilingAlertBridge, forgetFilingForeground, FOREGROUND_CHECK_MS } = await import("@/components/FilingAlertBridge");
const tick = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  cleanupRenders();
  forgetFilingForeground();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-07-30T07:03:00+09:00"));
  h.flags = { filingAlerts: true };
  h.local = true;
  h.calls = 0;
  h.notified = [];
});

describe("FilingAlertBridge", () => {
  it("플래그가 꺼져 있거나 모르면 요청 0", async () => {
    h.flags = {};
    render(<FilingAlertBridge />);
    await tick();
    vi.advanceTimersByTime(FOREGROUND_CHECK_MS * 2);
    await tick();
    expect(h.calls).toBe(0);
  });

  it("켤 때 한 번 → 알림 규칙으로 넘김, 5분마다 다시, 앞으로 올 때 4분 안이면 건너뜀", async () => {
    render(<FilingAlertBridge />);
    await tick();
    expect(h.calls).toBe(1);
    expect(h.notified).toEqual([FX.alerts]);
    vi.advanceTimersByTime(60_000);
    h.appState?.("active");
    await tick();
    expect(h.calls).toBe(1);
    vi.advanceTimersByTime(FOREGROUND_CHECK_MS - 60_000);
    await tick();
    expect(h.calls).toBe(2);
  });

  it("로컬 모드가 아니면(서버 푸시 기기·알림 꺼짐) 요청 0", async () => {
    h.local = false;
    render(<FilingAlertBridge />);
    await tick();
    expect(h.calls).toBe(0);
  });
});
