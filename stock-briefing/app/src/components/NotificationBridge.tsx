import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { ensureAndroidChannel, refreshBriefingsFor, routeForNotification } from "@/lib/notifications";
import { useSettings } from "@/lib/settings";

/** 이미 처리한 알림 응답 (최근 HANDLED_MAX 개, 기기 저장) */
const HANDLED_KEY = "notifications.handled";
const HANDLED_MAX = 20;
/** 탭 화면 경로: 새로 쌓지 않고 기존 탭으로 돌아가 탭만 바꾼다 */
const TAB_PATHS: ReadonlySet<string> = new Set(["/", "/briefings", "/discover", "/settings"]);

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
 */
export function NotificationBridge() {
  const lastResponse = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  const qc = useQueryClient();
  const { apiUrl } = useSettings();
  // 알림을 누른 처리에서 쓸 캐시·서버 주소. 바뀌어도 그 effect 를 다시 돌리지 않는다 (다시 돌면 아직 안 간 이동 타이머가 지워진다)
  const cache = useRef({ qc, apiUrl });
  useEffect(() => {
    cache.current = { qc, apiUrl };
  }, [qc, apiUrl]);

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
    void claimResponse(key).then((first) => {
      // 루트 네비게이터가 준비된 뒤 이동
      if (first && !cancelled) timer = setTimeout(() => openNotificationPath(path), 50);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [lastResponse]);

  return null;
}
