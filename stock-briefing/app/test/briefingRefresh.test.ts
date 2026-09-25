import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatestBriefing } from "@/api/types";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("expo-notifications", () => ({ setNotificationHandler: () => undefined }));
vi.mock("expo-device", () => ({ isDevice: true, modelName: "test" }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

const { latestBriefingsQuery } = await import("@/api/hooks");
const { refreshBriefingsFor } = await import("@/lib/notifications");

/**
 * BH-16: 브리핑 탭 목록을 처음 연 뒤 다시 받지 않았다. 탭은 가려져도 마운트된 채(freezeOnBlur)라 다시 마운트되지 않고,
 * 앱 기본값이 포커스 재조회 꺼짐이라 — 08:35 '오전 브리핑' 알림을 눌러 들어와도 08:00 에 받은 어제 오후 목록이 그대로였다.
 *  - 탭을 떠나면 구독을 끊었다가(subscribed) 돌아오면 30초 지난 목록을 다시 받는다
 *  - 앱으로 돌아오면(포커스) 30초 지난 목록을 다시 받는다
 *  - 브리핑 알림을 받거나 누르면 브리핑 목록 캐시를 무효화한다 → 열려 있는 탭도 바로 다시 받는다
 */
const API = "https://server.test";
const AT_0800 = Date.parse("2026-09-25T08:00:00+09:00");
const item = (id: number, session: "morning" | "afternoon", date: string): LatestBriefing =>
  ({ code: "005930", name: "삼성전자", latest: { id, code: "005930", name: "삼성전자", session, date, status: "ok", summary: `${date} ${session}`, detail: "", missing: [], model: "m", error: null, createdAt: `${date}T08:00:00+09:00` } }) as LatestBriefing;
const YESTERDAY_PM = [item(1, "afternoon", "2026-09-24")];
const TODAY_AM = [item(2, "morning", "2026-09-25")];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT_0800);
});
afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

/** 브리핑 탭과 같은 옵션의 쿼리를 08:00 에 구독한다 (앱처럼 QueryClient 를 붙여 포커스 이벤트를 받는다) */
async function mountTab(focused = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
  qc.mount();
  const server = { list: YESTERDAY_PM, calls: 0 };
  const api = {
    latestBriefings: async () => {
      server.calls++;
      return server.list;
    },
  };
  const observer = new QueryObserver(qc, latestBriefingsQuery(api, API, focused));
  let unsubscribe = observer.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  const shown = () => observer.getCurrentResult().data?.[0]?.latest?.id;
  return {
    qc,
    server,
    shown,
    observer,
    blur: () => unsubscribe(),
    focus: () => {
      unsubscribe = observer.subscribe(() => undefined);
    },
    unmount: () => {
      unsubscribe();
      qc.unmount();
    },
  };
}

describe("브리핑 탭 목록 다시 받기 (BH-16)", () => {
  it("탭이 가려지면 구독을 끊고(subscribed false), 보이면 다시 붙는다", () => {
    const api = { latestBriefings: async () => [] };
    expect(latestBriefingsQuery(api, API, false).subscribed).toBe(false);
    expect(latestBriefingsQuery(api, API, true).subscribed).toBe(true);
  });

  it("다른 탭에 있다가 35분 뒤 브리핑 탭으로 돌아오면 새 목록을 받는다", async () => {
    const tab = await mountTab();
    expect(tab.shown()).toBe(1);
    tab.blur(); // 잔고 탭으로 (subscribed false → 구독 끊김)
    tab.server.list = TODAY_AM;
    await vi.advanceTimersByTimeAsync(35 * 60_000);
    tab.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.server.calls).toBe(2);
    expect(tab.shown()).toBe(2);
    tab.unmount();
  });

  it("브리핑 탭을 보던 채로 폰을 잠갔다가 35분 뒤 앱으로 돌아오면 새 목록을 받는다", async () => {
    const tab = await mountTab();
    focusManager.setFocused(false);
    tab.server.list = TODAY_AM;
    await vi.advanceTimersByTimeAsync(35 * 60_000);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.server.calls).toBe(2);
    expect(tab.shown()).toBe(2);
    tab.unmount();
  });

  it("앱으로 금방(30초 안) 돌아오면 다시 받지 않는다", async () => {
    const tab = await mountTab();
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(10_000);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.server.calls).toBe(1);
    tab.unmount();
  });

  it("새 브리핑 알림(묶음·종목·계좌)을 받거나 누르면 열려 있는 브리핑 탭이 바로 새 목록을 받는다", async () => {
    const tab = await mountTab();
    tab.server.list = TODAY_AM;
    await vi.advanceTimersByTimeAsync(5_000); // staleTime 30초 안이어도
    expect(refreshBriefingsFor(tab.qc, API, { type: "briefing", digest: true, session: "morning", date: "2026-09-25", count: 17 })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.server.calls).toBe(2);
    expect(tab.shown()).toBe(2);
    // 브리핑 탭의 계좌 브리핑 카드·종목 지난 브리핑도 같은 "briefings" 아래라 함께 오래된 것으로
    tab.qc.setQueryData([API, "briefings", "account", "list"], []);
    refreshBriefingsFor(tab.qc, API, { type: "briefing", briefingId: 2, code: "005930" });
    expect(tab.qc.getQueryState([API, "briefings", "account", "list"])?.isInvalidated).toBe(true);
    tab.unmount();
  });

  it("브리핑이 아닌 알림(테스트)이나 데이터 없는 알림은 목록을 건드리지 않는다", async () => {
    const tab = await mountTab();
    expect(refreshBriefingsFor(tab.qc, API, { type: "test" })).toBe(false);
    expect(refreshBriefingsFor(tab.qc, API, undefined)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.server.calls).toBe(1);
    tab.unmount();
  });
});
