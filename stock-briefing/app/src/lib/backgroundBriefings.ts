import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import type { LatestBriefing } from "@/api/types";
import { DEFAULT_PREFS, planNotifications, type NotifyPrefs } from "@/lib/briefingDigest";
import { ANDROID_CHANNEL, ensureAndroidChannel } from "@/lib/notifications";
import { loadLatestBriefings, loadNotifyPrefs, loadWidgetData, readCachedPayload } from "@/widgets/data";
import { shouldSkipFetch } from "@/widgets/payload";
import { marketWidgetPlaced, refreshWidgets } from "@/widgets/refresh";

/**
 * FCM(원격 푸시) 없이도 브리핑 알림을 받기 위한 백그라운드 확인.
 * Android WorkManager 가 15분 이상 간격으로 이 태스크를 깨우면 서버에서 최신 브리핑을 받아,
 * 아직 알리지 않은 새 브리핑이 있으면 로컬 알림을 띄운다. 앱을 강제 종료하지 않는 한 앱이 꺼져 있어도 돈다.
 * (배터리 절약·네트워크 조건에 따라 시스템이 미룰 수 있어 정확한 시각은 보장되지 않는다. 즉시 알림은 FCM 설정 필요.)
 */
export const BRIEFING_TASK = "check-new-briefings";
const SEEN_KEY = "briefings.notified"; // JSON: number[] (알림 보낸 브리핑 id, 최근 200개)
/** "1" 이면 알림 기준(그때까지의 브리핑)을 이미 적었다. 브리핑이 0건이라 SEEN 이 비어 있어도 처음으로 보지 않게 (N3) */
const INIT_KEY = "briefings.notifyInit";
export const LOCAL_MODE_KEY = "push.localMode"; // "1" 이면 백그라운드 확인 방식으로 알림
/** 백그라운드 갱신 최소 간격(분). Android 가 허용하는 가장 짧은 값 */
export const BG_INTERVAL_MIN = 15;
const INTERVAL_KEY = "bg.intervalMin";
/** 알림 규칙을 연달아 못 받은 횟수. 3번이면 규칙 없이 예전처럼 종목마다 알린다 (알림이 끝없이 밀리지 않게) */
const PREFS_FAIL_KEY = "notify.prefsFail";
export const PREFS_FAIL_LIMIT = 3;

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

/** 알림 기준을 적었는지. 표시가 없던 예전 앱에서 올라온 기기는 본 기록이 있으면 적은 것으로 본다 */
async function initialized(seen: Set<number>): Promise<boolean> {
  if (seen.size > 0) return true;
  return (await AsyncStorage.getItem(INIT_KEY).catch(() => null)) === "1";
}

/** 아직 알리지 않은 브리핑 id 가 있는지 (기준을 아직 안 적었으면 true → 현재 상태를 기억하게) */
export async function hasUnseen(ids: number[]): Promise<boolean> {
  const seen = await seenIds();
  return !(await initialized(seen)) || ids.some((id) => !seen.has(id));
}

/**
 * 새 브리핑을 찾아 로컬 알림. 처음 실행(기준 없음)에는 알리지 않고 현재 상태만 기억한다.
 * 3-19: 세션(날짜·오전/오후)마다 1건으로 묶고, 조용한 시간에는 보내지 않으며, 알림을 끈 종목은 뺀다 (서버 알림과 같은 규칙).
 * 조용한 시간에 만들어진 브리핑도 "본 것"으로 적는다 — 아침에 한꺼번에 울리지 않게 (브리핑 탭에는 그대로 있다)
 */
export async function notifyNewBriefings(
  latest: LatestBriefing[],
  opts: { first?: boolean; prefs?: NotifyPrefs; rates?: Map<string, number | null>; now?: Date } = {},
): Promise<number> {
  const seen = await seenIds();
  const isFirst = opts.first ?? !(await initialized(seen));
  const now = opts.now ?? new Date();
  const fresh = [];
  for (const item of latest) {
    const b = item.latest;
    if (!b || b.status !== "ok" || seen.has(b.id)) continue;
    seen.add(b.id);
    if (isFirst) continue;
    // 하루 이상 지난 브리핑은 알리지 않는다 (오래 꺼져 있다 켠 경우 폭탄 방지)
    if (now.getTime() - Date.parse(b.createdAt) > 24 * 3_600_000) continue;
    fresh.push({ briefingId: b.id, code: b.code, name: item.name, summary: b.summary, changeRate: opts.rates?.get(b.code) ?? null, session: b.session, date: b.date });
  }
  const messages = fresh.length ? planNotifications(fresh, opts.prefs ?? DEFAULT_PREFS, now) : [];
  for (const m of messages) {
    await Notifications.scheduleNotificationAsync({
      content: { title: m.title, body: m.body, data: m.data, sound: "default", ...(Platform.OS === "android" ? { channelId: ANDROID_CHANNEL } : {}) },
      trigger: null,
    });
  }
  await saveSeen(seen);
  // 빈 목록이어도 기준을 적은 것으로 — 다음에 생기는 첫 브리핑을 알린다
  if (isFirst) await AsyncStorage.setItem(INIT_KEY, "1").catch(() => undefined);
  return messages.length;
}

/** 태스크 본체. 앱 진입점(index.js)에서 defineTask 로 전역 등록해야 한다 */
export async function runBriefingCheck(): Promise<BackgroundTask.BackgroundTaskResult> {
  try {
    // 두 시장이 모두 닫혀 있으면 2시간에 한 번만 서버에 묻는다 (휴장 중 위젯 트래픽을 줄이려고, 3-16)
    const cached = await readCachedPayload();
    if (shouldSkipFetch(cached ? { at: cached.at, market: cached.body.market } : null, Date.now())) return BackgroundTask.BackgroundTaskResult.Success;
    const local = (await AsyncStorage.getItem(LOCAL_MODE_KEY).catch(() => null)) === "1";
    // 지수·환율 위젯이 홈 화면에 있을 때만 판 9개를 함께 묻는다 (같은 요청 한 번, 없으면 응답이 예전과 같다)
    const data = await loadWidgetData({ stocks: true, briefings: true, board: await marketWidgetPlaced() });
    if (data.error) return BackgroundTask.BackgroundTaskResult.Failed;
    if (local) {
      // 새 서버는 최신 브리핑 id 만 준다 → 아직 알리지 않은 id 가 있을 때만 전체 목록과 알림 규칙을 받아 알린다 (예전 서버는 briefings 가 전체 목록)
      const unseen = await hasUnseen(data.latestIds ?? data.briefings.flatMap((b) => (b.latest ? [b.latest.id] : [])));
      if (unseen) {
        let prefs = await loadNotifyPrefs();
        const fails = prefs ? 0 : Number((await AsyncStorage.getItem(PREFS_FAIL_KEY).catch(() => null)) ?? 0) + 1;
        await AsyncStorage.setItem(PREFS_FAIL_KEY, String(fails)).catch(() => undefined);
        if (!prefs && fails >= PREFS_FAIL_LIMIT) prefs = { ...DEFAULT_PREFS, digest: false, running: false };
        // 규칙을 못 받았거나 서버가 아직 브리핑을 만드는 중이면(17종목 약 7분) 이번엔 넘긴다 — 한 세션이 두 알림으로 쪼개지지 않게.
        // "본 것"으로 적지 않으므로 다음 확인(15분 뒤)에서 한 번에 알린다. 묶음을 끈 서버는 예전처럼 바로
        if (prefs && !(prefs.digest && prefs.running)) {
          const latest = data.latestIds ? await loadLatestBriefings() : data.briefings;
          const rates = new Map(data.stocks.map((s) => [s.code, s.quote?.changeRate ?? null] as const));
          await notifyNewBriefings(latest, { prefs, rates });
        }
      }
    }
    await refreshWidgets({
      stocks: data.stocks,
      showKrw: data.showKrw,
      afterCost: data.afterCost,
      filled: data.filled,
      market: data.market,
      briefings: data.briefings,
      features: data.featuresAt !== undefined ? { at: data.featuresAt, flags: data.features } : null,
      indices: data.indices ? { at: data.indicesAt ?? data.fetchedAt, list: data.indices } : null,
      board: data.board ? { at: data.boardAt ?? data.fetchedAt, list: data.board } : null,
    });
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
  // 알림 기준을 새로 잡는다 — 꺼져 있던 동안의 옛 기록으로 판단하지 않게 (목록을 못 받으면 첫 확인이 기준을 잡는다)
  await AsyncStorage.removeItem(SEEN_KEY).catch(() => undefined);
  await AsyncStorage.removeItem(INIT_KEY).catch(() => undefined);
  await AsyncStorage.setItem(LOCAL_MODE_KEY, "1");
  await BackgroundTask.registerTaskAsync(BRIEFING_TASK, { minimumInterval: BG_INTERVAL_MIN });
  await AsyncStorage.setItem(INTERVAL_KEY, String(BG_INTERVAL_MIN)).catch(() => undefined);
  // 현재 브리핑 목록 전체를 "이미 본 것"으로 기록해 켜자마자 옛 브리핑이 쏟아지지 않게 한다
  // (위젯 응답의 브리핑은 상위 3종목뿐이라 전체 목록을 따로 받는다)
  const latest = await loadLatestBriefings().catch(() => null);
  if (latest) await notifyNewBriefings(latest, { first: true });
}

/** 백그라운드 확인 알림만 끈다. 같은 태스크가 위젯도 15분마다 갱신하므로 Android 에서는 태스크를 남긴다 (N2) */
export async function disableLocalBriefingAlerts(): Promise<void> {
  await AsyncStorage.removeItem(LOCAL_MODE_KEY).catch(() => undefined);
  if (Platform.OS === "android") return ensureBackgroundTaskRegistered();
  // 위젯이 없는 기기는 알림 때문에만 등록했으므로 해제
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
