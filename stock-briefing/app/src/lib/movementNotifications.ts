import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { createApi } from "@/api/client";
import { persistedFeatureOn } from "@/lib/marketSummaryLoad";
import { PERSIST_STORAGE_KEY } from "@/lib/queryPersist";
import { assertSessionIdentity, backgroundSessionFor, personalBlocked, sessionIdentityVersion } from "@/lib/session";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";

export interface MovementEvent { id: string; title: string; body: string; data: Record<string, unknown>; createdAt: string }
const SEEN = "movement.seen.v1";
let running: Promise<number> | null = null;

/** 가격 사건 조회는 보고서 요청과 독립한다. 로컬 알림 모드에서만 기기에서 전달한다. */
export function checkMovementNotifications(): Promise<number> {
  if (running) return running;
  running = run().finally(() => { running = null; });
  return running;
}
async function run(): Promise<number> {
  if (await AsyncStorage.getItem("push.localMode") !== "1") return 0;
  const [url, token, flags] = await Promise.all([AsyncStorage.getItem(STORAGE_KEYS.apiUrl), AsyncStorage.getItem(STORAGE_KEYS.apiToken), AsyncStorage.getItem(PERSIST_STORAGE_KEY)]);
  const base = (url || defaultApiUrl()).trim().replace(/\/+$/, "");
  if (!persistedFeatureOn(flags, base, "watchlistSteps")) return 0;
  const auth = (token ?? process.env.EXPO_PUBLIC_API_TOKEN ?? "").trim();
  const session = await backgroundSessionFor(base);
  if (session.kind === "memory" || personalBlocked(base)) return 0;
  const identity = sessionIdentityVersion();
  if ((await Notifications.getPermissionsAsync()).status !== "granted") return 0;
  const api = createApi(base, auth);
  const { events } = await api.movementEvents();
  const raw = await AsyncStorage.getItem(SEEN);
  const saved = raw ? JSON.parse(raw) as { base: string; ids: string[] } : null;
  const known = new Set(saved?.base === base && Array.isArray(saved.ids) ? saved.ids : []);
  if (!saved || saved.base !== base) {
    // 처음 연결했을 때 과거 사건을 몰아서 알리지 않는다. 저장 실패 시 다음 확인에서 기준을 다시 만든다.
    await AsyncStorage.setItem(SEEN, JSON.stringify({ base, ids: events.map(e => e.id).slice(-2000) }));
    return 0;
  }
  const [presented, scheduled] = await Promise.all([Notifications.getPresentedNotificationsAsync(), Notifications.getAllScheduledNotificationsAsync()]);
  const osKnown = new Set([...presented.map(n => n.request.identifier), ...scheduled.map(n => n.identifier)]);
  let count = 0;
  for (const e of events) {
    if (known.has(e.id)) continue;
    assertSessionIdentity(identity);
    const [liveUrl, liveToken, mode] = await Promise.all([AsyncStorage.getItem(STORAGE_KEYS.apiUrl), AsyncStorage.getItem(STORAGE_KEYS.apiToken), AsyncStorage.getItem("push.localMode")]);
    if ((liveUrl || defaultApiUrl()).trim().replace(/\/+$/, "") !== base || (liveToken ?? process.env.EXPO_PUBLIC_API_TOKEN ?? "").trim() !== auth || mode !== "1") return count;
    const identifier = `movement:${encodeURIComponent(base)}:${e.id}`;
    if (!osKnown.has(identifier)) {
      await Notifications.scheduleNotificationAsync({ identifier, content: { title: e.title, body: e.body, data: e.data, sound: "default" }, trigger: Platform.OS === "android" ? { channelId: "prices" } : null });
      osKnown.add(identifier); count++;
    }
    known.add(e.id);
    assertSessionIdentity(identity);
    await AsyncStorage.setItem(SEEN, JSON.stringify({ base, ids: [...known].slice(-2000) }));
  }
  return count;
}
