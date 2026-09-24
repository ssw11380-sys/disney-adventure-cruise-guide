import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import type { LatestBriefing } from "@/api/types";
import { ANDROID_CHANNEL, ensureAndroidChannel } from "@/lib/notifications";
import { loadLatestBriefings, loadWidgetData, readCachedPayload } from "@/widgets/data";
import { shouldSkipFetch } from "@/widgets/payload";
import { refreshWidgets } from "@/widgets/refresh";

/**
 * FCM(원격 푸시) 없이도 브리핑 알림을 받기 위한 백그라운드 확인.
 * Android WorkManager 가 15분 이상 간격으로 이 태스크를 깨우면 서버에서 최신 브리핑을 받아,
 * 아직 알리지 않은 새 브리핑이 있으면 로컬 알림을 띄운다. 앱을 강제 종료하지 않는 한 앱이 꺼져 있어도 돈다.
 * (배터리 절약·네트워크 조건에 따라 시스템이 미룰 수 있어 정확한 시각은 보장되지 않는다. 즉시 알림은 FCM 설정 필요.)
 */
export const BRIEFING_TASK = "check-new-briefings";
const SEEN_KEY = "briefings.notified"; // JSON: number[] (알림 보낸 브리핑 id, 최근 200개)
export const LOCAL_MODE_KEY = "push.localMode"; // "1" 이면 백그라운드 확인 방식으로 알림
/** 백그라운드 갱신 최소 간격(분). Android 가 허용하는 가장 짧은 값 */
export const BG_INTERVAL_MIN = 15;
const INTERVAL_KEY = "bg.intervalMin";

async function seenIds(): Promise<Set<number>> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as number[]) : []);
  } catch {
    return new Set();
  }
}

async function saveSeen(ids: Set<number>): Promise<void> {
  try {
    await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    /* ignore */
  }
}

/** 아직 알리지 않은 브리핑 id 가 있는지 (처음 실행이면 true → 현재 상태를 기억하게) */
export async function hasUnseen(ids: number[]): Promise<boolean> {
  const seen = await seenIds();
  return seen.size === 0 || ids.some((id) => !seen.has(id));
}

/** 새 브리핑을 찾아 로컬 알림. 처음 실행(기록 없음)에는 알리지 않고 현재 상태만 기억한다 */
export async function notifyNewBriefings(latest: LatestBriefing[], opts: { first?: boolean } = {}): Promise<number> {
  const seen = await seenIds();
  const isFirst = opts.first ?? seen.size === 0;
  let sent = 0;
  for (const item of latest) {
    const b = item.latest;
    if (!b || b.status !== "ok" || seen.has(b.id)) continue;
    seen.add(b.id);
    if (isFirst) continue;
    // 하루 이상 지난 브리핑은 알리지 않는다 (오래 꺼져 있다 켠 경우 폭탄 방지)
    if (Date.now() - Date.parse(b.createdAt) > 24 * 3_600_000) continue;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${item.name} ${b.session === "morning" ? "오전" : "오후"} 브리핑`,
        body: b.summary,
        data: { type: "briefing", briefingId: b.id, code: b.code, session: b.session, date: b.date },
        sound: "default",
        ...(Platform.OS === "android" ? { channelId: ANDROID_CHANNEL } : {}),
      },
      trigger: null,
    });
    sent++;
  }
  await saveSeen(seen);
  return sent;
}

/** 태스크 본체. 앱 진입점(index.js)에서 defineTask 로 전역 등록해야 한다 */
export async function runBriefingCheck(): Promise<BackgroundTask.BackgroundTaskResult> {
  try {
    // 두 시장이 모두 닫혀 있으면 2시간에 한 번만 서버에 묻는다 (휴장 중 위젯 트래픽을 줄이려고, 3-16)
    const cached = await readCachedPayload();
    if (shouldSkipFetch(cached ? { at: cached.at, market: cached.body.market } : null, Date.now())) return BackgroundTask.BackgroundTaskResult.Success;
    const local = (await AsyncStorage.getItem(LOCAL_MODE_KEY).catch(() => null)) === "1";
    const data = await loadWidgetData({ stocks: true, briefings: true });
    if (data.error) return BackgroundTask.BackgroundTaskResult.Failed;
    if (local) {
      // 새 서버는 최신 브리핑 id 만 준다 → 아직 알리지 않은 id 가 있을 때만 전체 목록을 받아 알린다 (예전 서버는 briefings 가 전체 목록)
      if (!data.latestIds) await notifyNewBriefings(data.briefings);
      else if (await hasUnseen(data.latestIds)) await notifyNewBriefings(await loadLatestBriefings());
    }
    await refreshWidgets({ stocks: data.stocks, showKrw: data.showKrw, afterCost: data.afterCost, filled: data.filled, market: data.market, briefings: data.briefings });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

export function defineBriefingTask(): void {
  if (!TaskManager.isTaskDefined(BRIEFING_TASK)) TaskManager.defineTask(BRIEFING_TASK, runBriefingCheck);
}

/** 백그라운드 확인 켜기: 알림 권한 → 채널 → 태스크 등록(최소 15분) */
export async function enableLocalBriefingAlerts(): Promise<void> {
  await ensureAndroidChannel();
  const p = await Notifications.getPermissionsAsync();
  const status = p.status === "granted" ? p.status : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") throw new Error("알림 권한이 거부되었습니다. 기기 설정에서 이 앱의 알림을 허용해 주세요.");
  const s = await BackgroundTask.getStatusAsync();
  if (s === BackgroundTask.BackgroundTaskStatus.Restricted) throw new Error("이 기기에서는 백그라운드 작업이 제한되어 있습니다. 배터리 최적화에서 이 앱을 제외해 주세요.");
  await AsyncStorage.setItem(LOCAL_MODE_KEY, "1");
  await BackgroundTask.registerTaskAsync(BRIEFING_TASK, { minimumInterval: BG_INTERVAL_MIN });
  await AsyncStorage.setItem(INTERVAL_KEY, String(BG_INTERVAL_MIN)).catch(() => undefined);
  // 현재 브리핑 목록을 "이미 본 것"으로 기록해 켜자마자 옛 브리핑이 쏟아지지 않게 한다
  const data = await loadWidgetData({ stocks: false, briefings: true });
  if (!data.error) await notifyNewBriefings(data.briefings, { first: true });
}

export async function disableLocalBriefingAlerts(): Promise<void> {
  await AsyncStorage.removeItem(LOCAL_MODE_KEY).catch(() => undefined);
  try {
    if (await TaskManager.isTaskRegisteredAsync(BRIEFING_TASK)) await BackgroundTask.unregisterTaskAsync(BRIEFING_TASK);
  } catch {
    /* ignore */
  }
}

export async function isLocalModeEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(LOCAL_MODE_KEY).catch(() => null)) === "1";
}

/** 앱 시작 시: 위젯 갱신용으로 태스크는 항상 등록해 둔다 (알림은 localMode 일 때만) */
export async function ensureBackgroundTaskRegistered(): Promise<void> {
  try {
    if (Platform.OS !== "android") return;
    const s = await BackgroundTask.getStatusAsync();
    if (s !== BackgroundTask.BackgroundTaskStatus.Available) return;
    // 15분 간격 (예전 빌드는 30분으로 등록했으므로 한 번 다시 등록한다). 휴장 중에는 태스크가 스스로 2시간에 한 번만 서버에 묻는다
    const registered = await TaskManager.isTaskRegisteredAsync(BRIEFING_TASK);
    const interval = await AsyncStorage.getItem(INTERVAL_KEY).catch(() => null);
    if (registered && interval !== String(BG_INTERVAL_MIN)) await BackgroundTask.unregisterTaskAsync(BRIEFING_TASK);
    if (!registered || interval !== String(BG_INTERVAL_MIN)) {
      await BackgroundTask.registerTaskAsync(BRIEFING_TASK, { minimumInterval: BG_INTERVAL_MIN });
      await AsyncStorage.setItem(INTERVAL_KEY, String(BG_INTERVAL_MIN)).catch(() => undefined);
    }
  } catch {
    /* Expo Go 등 미지원 환경 */
  }
}
