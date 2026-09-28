import AsyncStorage from "@react-native-async-storage/async-storage";
import { useIsRestoring, useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router, usePathname } from "expo-router";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { FeatureFlags } from "@/api/types";
import { pickNotified } from "@/lib/briefingPick";
import { markBriefingRead } from "@/lib/briefingRead";
import { featureOn } from "@/lib/features";
import { ensureAndroidChannel, notificationNav, refreshBriefingsFor, routeForNotification, type NotificationNav } from "@/lib/notifications";
import { useSettings } from "@/lib/settings";
import { useFoldLayout } from "@/lib/useFoldLayout";

/** 이미 처리한 알림 응답 (최근 HANDLED_MAX 개, 기기 저장) */
const HANDLED_KEY = "notifications.handled";
const HANDLED_MAX = 20;
/** 탭 화면 경로: 새로 쌓지 않고 기존 탭으로 돌아가 탭만 바꾼다 */
const TAB_PATHS: ReadonlySet<string> = new Set(["/", "/briefings", "/discover", "/settings"]);
/**
 * 브리핑 3차 1 (notifBack): 앱이 꺼진 채 알림을 누르면(콜드 스타트) 저장된 캐시(기능 플래그)와 설정(서버 주소 — 플래그 캐시 키)을
 * 다 읽을 때까지 이동을 미룬다. 최대 1.5초 — 스플래시가 가리는 시간과 같다(_layout SplashGate). 그 뒤엔 아는 것으로(모르면 지금처럼)
 */
export const NAV_WAIT_MAX_MS = 1_500;

/**
 * 알림 이동이 남아 있는 동안 스플래시를 잡아 둔다 (_layout SplashGate 가 본다, 브리핑 3차 1). 예전에는 알림 응답을 받자마자(캐시 복원 전) 옮겨 가
 * 스플래시 아래에서 이동이 끝났는데, 이제 복원을 기다려 플래그를 읽으므로 그 사이 스플래시가 먼저 내려가면 잔고 탭이 잠깐 보였다 넘어간다.
 * 이동을 보낸 뒤 SPLASH_AFTER_NAV_MS(화면 전환 한 번) 지나서 놓는다. 스플래시의 최대 1.5초 한도(_layout)는 그대로라 놓지 못해도 내려간다.
 * 앱을 쓰던 중(스플래시가 이미 내려감)에는 아무 일도 하지 않는다
 */
export const SPLASH_AFTER_NAV_MS = 300;
let splashHold = false;
const holdListeners = new Set<() => void>();
function setSplashHold(v: boolean): void {
  if (splashHold === v) return;
  splashHold = v;
  for (const l of holdListeners) l();
}
function subscribeHold(l: () => void): () => void {
  holdListeners.add(l);
  return () => {
    holdListeners.delete(l);
  };
}
/** 스플래시를 잡아 두는 중인지 (테스트·SplashGate) */
export function splashHeld(): boolean {
  return splashHold;
}
export function useSplashHold(): boolean {
  return useSyncExternalStore(subscribeHold, splashHeld);
}

type Nav = Pick<typeof router, "canDismiss" | "dismissTo" | "navigate" | "push">;

/**
 * 알림이 가리키는 화면으로 이동. 탭 경로(묶음 알림 → 브리핑 탭)는 push 하지 않는다 — 종목 상세처럼 루트 스택에 쌓인 화면 위에서 push 하면
 * 탭 묶음 전체가 하나 더 쌓여 뒤로 가기가 새 탭 → 상세 → 원래 탭 순이 되고 탭마다 주기 요청이 겹친다 (BH-50).
 * 스택 위면 기존 탭까지 닫고(dismissTo), 탭 안이면 탭만 바꾼다(탭 안에서 dismissTo 는 처리되지 않음)
 */
export function openNotificationPath(path: string, nav: Nav = router): void {
  if (!TAB_PATHS.has(path)) nav.push(path as never);
  else if (nav.canDismiss()) nav.dismissTo(path as never);
  else nav.navigate(path as never);
}

/**
 * 브리핑 3차 1 (notifBack): notificationNav 가 정한 대로 옮겨 간다.
 *  - 브리핑 탭으로: 쌓인 화면(종목 상세 등)이 있으면 닫고(dismissTo), 탭 안이면 탭만 바꾼다 (openNotificationPath('/briefings') 와 같다)
 *  - tabThenPush: 그다음 상세를 쌓는다 → '뒤로' = 브리핑 탭. expo-router 는 이동을 줄 세워 차례대로 처리한다 (global-state/routingQueue)
 *  - pane: 2단 오른쪽 칸에서 고르고(종목 브리핑은 읽음으로) 브리핑 탭으로 — 새 화면을 쌓지 않는다
 */
export function runNotificationNav(nav: NotificationNav, r: Nav = router): void {
  if (nav.kind === "legacy") return openNotificationPath(nav.path, r);
  if (nav.kind === "pane") {
    pickNotified(nav.pick);
    if (nav.pick.kind === "stock") markBriefingRead(nav.pick.id);
  }
  openNotificationPath("/briefings", r);
  if (nav.kind === "tabThenPush") r.push(nav.path as never);
}

/** 응답 하나를 가리키는 값. 같은 식별자로 새로 올라온 알림(서버가 tag 를 정한 경우 등)은 올라온 시각으로 가른다 */
function responseKey(r: Notifications.NotificationResponse): string {
  return `${r.notification.request.identifier}@${r.notification.date}`;
}

/**
 * 이 알림 응답을 처음 처리하면 기록하고 true. OTA "지금 다시 시작"은 프로세스를 두고 JS 만 다시 띄우는데, 네이티브가 앱을 켰던 옛 응답을
 * 새 JS 에 다시 넘긴다(clearLastNotificationResponse 로도 막히지 않음) → 메모리가 아닌 기기에 기록해 다시 이동하지 않는다 (BH-64).
 * 기록을 읽지 못하면 처음 보는 것으로 본다 (이동을 놓치지 않게)
 */
export async function claimResponse(key: string): Promise<boolean> {
  let seen: string[] = [];
  try {
    const raw = await AsyncStorage.getItem(HANDLED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(v)) seen = v.filter((x): x is string => typeof x === "string");
  } catch {
    /* 처음 보는 것으로 */
  }
  if (seen.includes(key)) return false;
  await AsyncStorage.setItem(HANDLED_KEY, JSON.stringify([...seen, key].slice(-HANDLED_MAX))).catch(() => undefined);
  return true;
}

/**
 * 알림을 탭했을 때 해당 브리핑으로 이동한다.
 * 앱이 꺼진 상태에서 알림으로 켜진 경우(마지막 응답)와 실행 중 탭한 경우 둘 다 처리.
 * 브리핑 알림을 받거나 누르면 브리핑 목록을 다시 받게 한다 — 이미 열려 있던 브리핑 탭이 옛 목록을 보이지 않게 (BH-16)
 * 브리핑 3차 1 (플래그 notifBack): 켜져 있으면 브리핑 알림의 '뒤로'가 브리핑 탭이다 (lib/notifications notificationNav). 플래그는 누른 그때
 * 캐시에서 읽는다 — 콜드 스타트는 저장된 캐시를 되살린 뒤(최대 1.5초). 꺼져 있거나 모르면 지금 그대로
 */
export function NotificationBridge() {
  const lastResponse = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  const qc = useQueryClient();
  const { apiUrl, ready } = useSettings();
  const restoring = useIsRestoring();
  const { twoPane } = useFoldLayout();
  const pathname = usePathname();
  // 알림을 누른 처리에서 쓸 캐시·서버 주소·창·지금 화면. 바뀌어도 그 effect 를 다시 돌리지 않는다 (다시 돌면 아직 안 간 이동 타이머가 지워진다)
  const cache = useRef({ qc, apiUrl });
  useEffect(() => {
    cache.current = { qc, apiUrl };
  }, [qc, apiUrl]);
  const where = useRef({ twoPane, path: pathname as string | null });
  useEffect(() => {
    where.current = { twoPane, path: pathname ?? null };
  }, [twoPane, pathname]);

  // 이동을 미루는 문: 설정과 저장된 캐시를 다 읽으면(또는 1.5초 뒤) 열리고 다시 닫히지 않는다. 기다리던 이동은 열릴 때 한 번에 간다
  const gate = useRef<{ open: boolean; waiting: (() => void)[] }>({ open: false, waiting: [] });
  const openGate = useCallback(() => {
    const g = gate.current;
    if (g.open) return;
    g.open = true;
    for (const run of g.waiting.splice(0)) run();
  }, []);
  useEffect(() => {
    if (ready && !restoring) openGate();
  }, [ready, restoring, openGate]);
  useEffect(() => {
    const t = setTimeout(openGate, NAV_WAIT_MAX_MS);
    return () => clearTimeout(t);
  }, [openGate]);

  // 알림 채널(브리핑·가격)을 앱을 켤 때 만들어 둔다 — 기기 설정에서 채널별로 끌 수 있게 (3-19)
  useEffect(() => {
    void ensureAndroidChannel().catch(() => undefined);
  }, []);

  // 앱을 보는 중에 온 브리핑 알림 (서버 푸시·백그라운드 확인의 로컬 알림)
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener((n) => {
      refreshBriefingsFor(qc, apiUrl, n.request.content.data as Record<string, unknown> | undefined);
    });
    return () => sub.remove();
  }, [qc, apiUrl]);

  useEffect(() => {
    if (!lastResponse) return;
    const key = responseKey(lastResponse);
    if (handled.current === key) return;
    handled.current = key;
    const data = lastResponse.notification.request.content.data as Record<string, unknown> | undefined;
    refreshBriefingsFor(cache.current.qc, cache.current.apiUrl, data);
    const path = routeForNotification(data);
    if (!path) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release: ReturnType<typeof setTimeout> | undefined;
    // 콜드 스타트(문이 아직 닫힘): 옮겨 갈 때까지 스플래시를 잡아 둔다
    if (!gate.current.open) setSplashHold(true);
    const go = () => {
      const { qc: client, apiUrl: url } = cache.current;
      const back = featureOn(client.getQueryData<FeatureFlags>([url, "features"]), "notifBack", false);
      const nav = notificationNav(data, { back, ...where.current });
      if (nav) runNotificationNav(nav);
      release = setTimeout(() => setSplashHold(false), SPLASH_AFTER_NAV_MS);
    };
    const later = () => {
      // 루트 네비게이터가 준비된 뒤 이동
      if (!cancelled) timer = setTimeout(go, 50);
    };
    void claimResponse(key).then((first) => {
      // 정리된 뒤(cancelled)에는 정리가 이미 놓았다 — 다음 응답이 잡은 것을 놓지 않게 건드리지 않는다
      if (cancelled) return;
      if (!first) return setSplashHold(false);
      if (gate.current.open) later();
      else gate.current.waiting.push(later);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (release) clearTimeout(release);
      setSplashHold(false);
    };
  }, [lastResponse]);

  return null;
}
