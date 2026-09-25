import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { ensureAndroidChannel, refreshBriefingsFor, routeForNotification } from "@/lib/notifications";
import { useSettings } from "@/lib/settings";

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
    const id = lastResponse.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const data = lastResponse.notification.request.content.data as Record<string, unknown> | undefined;
    refreshBriefingsFor(cache.current.qc, cache.current.apiUrl, data);
    const path = routeForNotification(data);
    if (path) {
      // 루트 네비게이터가 준비된 뒤 이동
      const t = setTimeout(() => router.push(path as never), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [lastResponse]);

  return null;
}
