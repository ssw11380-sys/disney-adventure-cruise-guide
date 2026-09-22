import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { routeForNotification } from "@/lib/notifications";

/**
 * 알림을 탭했을 때 해당 브리핑으로 이동한다.
 * 앱이 꺼진 상태에서 알림으로 켜진 경우(마지막 응답)와 실행 중 탭한 경우 둘 다 처리.
 */
export function NotificationBridge() {
  const lastResponse = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!lastResponse) return;
    const id = lastResponse.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const path = routeForNotification(lastResponse.notification.request.content.data as Record<string, unknown> | undefined);
    if (path) {
      // 루트 네비게이터가 준비된 뒤 이동
      const t = setTimeout(() => router.push(path as never), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [lastResponse]);

  return null;
}
