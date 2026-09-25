import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import type { AccountBriefing, LatestBriefing } from "@/api/types";
import { DEFAULT_PREFS, planNotifications, type NotifyPrefs } from "@/lib/briefingDigest";
import { INIT_KEY, initialized, saveSeen, SEEN_KEY, seenIds, withSeen } from "@/lib/briefingSeen";
import { ANDROID_CHANNEL, ensureAndroidChannel } from "@/lib/notifications";
import { loadAccountBriefings, loadLatestBriefings, loadNotifyPrefs, loadWidgetData, readCachedPayload } from "@/widgets/data";
import { shouldSkipFetch } from "@/widgets/payload";
import { marketWidgetPlaced, refreshWidgets } from "@/widgets/refresh";

/**
 * FCM(원격 푸시) 없이도 브리핑 알림을 받기 위한 백그라운드 확인.
 * Android WorkManager 가 15분 이상 간격으로 이 태스크를 깨우면 서버에서 최신 브리핑을 받아,
 * 아직 알리지 않은 새 브리핑이 있으면 로컬 알림을 띄운다. 앱을 강제 종료하지 않는 한 앱이 꺼져 있어도 돈다.
 * (배터리 절약·네트워크 조건에 따라 시스템이 미룰 수 있어 정확한 시각은 보장되지 않는다. 즉시 알림은 FCM 설정 필요.)
 */
export const BRIEFING_TASK = "check-new-briefings";
// 알림 보낸 브리핑 기록(SEEN_KEY)·알림 기준(INIT_KEY)은 lib/briefingSeen — 앱의 수동 실행도 같은 기록에 적는다 (BH-67)
/**
 * "1" 이면 계좌 브리핑(3-31)의 알림 기준을 적었다. 없으면(알림을 막 켬·3-31 전부터 켜 둔 기기) 그때 있는 계좌 브리핑을 알리지 않고 "본 것"으로만 적는다 —
 * 업데이트 직후 옛 계좌 브리핑이 따로 울리지 않게
 */
const ACCOUNT_INIT_KEY = "accountBriefings.notifyInit";
export const LOCAL_MODE_KEY = "push.localMode"; // "1" 이면 백그라운드 확인 방식으로 알림
/** 백그라운드 갱신 최소 간격(분). Android 가 허용하는 가장 짧은 값 */
export const BG_INTERVAL_MIN = 15;
const INTERVAL_KEY = "bg.intervalMin";
/** 알림 규칙을 연달아 못 받은 횟수. 3번이면 규칙 없이 예전처럼 종목마다 알린다 (알림이 끝없이 밀리지 않게) */
const PREFS_FAIL_KEY = "notify.prefsFail";
export const PREFS_FAIL_LIMIT = 3;
/**
 * 계좌 브리핑 목록(3-31)을 연달아 못 받은 횟수. 못 받으면 이번엔 넘긴다(세션 알림이 계좌 요약 없는 것·계좌 요약만 있는 것 두 건으로 쪼개지지 않게).
 * PREFS_FAIL_LIMIT 번이면 계좌 요약 없이 종목 브리핑만 알린다 — 계좌 브리핑은 '본 것'으로 적지 않아 목록을 받으면 알린다
 */
const ACCOUNTS_FAIL_KEY = "notify.accountsFail";

/**
 * 아직 알리지 않은 브리핑 id 가 있는지 (기준을 아직 안 적었으면 true → 현재 상태를 기억하게).
 * accountIds(3-31): 위젯 응답의 최근 계좌 브리핑 id — 종목 브리핑이 모두 실패하고 계좌 브리핑만 생긴 세션도 알아보게 (서버 푸시와 같게)
 */
export async function hasUnseen(ids: number[], accountIds: readonly number[] = []): Promise<boolean> {
  const seen = await seenIds();
  return !(await initialized(seen)) || ids.some((id) => !seen.has(id)) || accountIds.some((id) => !seen.has(-id));
}

/**
 * 로컬 알림을 바로 띄우는 trigger — 서버 푸시와 같은 '브리핑 알림' 채널로 (BH-28).
 * Android 는 채널을 trigger 에서만 읽는다: content 에 넣은 channelId 는 버려지고, trigger 가 null 이면 expo 기본 채널(Miscellaneous)로 가서
 * 기기 설정에서 '브리핑 알림'을 끄거나 소리를 바꿔도 로컬 알림에는 적용되지 않았다. 채널 trigger 도 바로 뜬다 (다른 플랫폼은 null 과 같다)
 */
export function briefingTrigger(): Notifications.NotificationTriggerInput {
  return Platform.OS === "android" ? { channelId: ANDROID_CHANNEL } : null;
}

interface NotifyOpts {
  first?: boolean;
  prefs?: NotifyPrefs;
  rates?: Map<string, number | null>;
  now?: Date;
  /** 최근 계좌 브리핑 목록 (3-31, 플래그가 켜져 있고 목록을 받았을 때만 넘긴다. 없으면 계좌 브리핑 기준을 적지 않는다) */
  accounts?: AccountBriefing[];
  /**
   * 위젯 응답의 최근 계좌 브리핑 id. 목록과 함께, 또는 묶음을 끈 채 플래그만 켜져 있을 때(계좌 요약을 쓰지 않음) "본 것"으로 적어 매번 다시 묻지 않게.
   * 목록을 받지 못했을 때는 넘기지 않는다 (그 계좌 브리핑의 알림이 사라지지 않게)
   */
  accountIds?: readonly number[];
  /** 등록한 모든 종목 코드. 모두 알림을 꺼 두었으면 계좌 요약도 보내지 않는다 (서버와 같은 규칙) */
  codes?: readonly string[];
}

/**
 * 새 브리핑을 찾아 로컬 알림. 처음 실행(기준 없음)에는 알리지 않고 현재 상태만 기억한다.
 * 3-19: 세션(날짜·오전/오후)마다 1건으로 묶고, 조용한 시간에는 보내지 않으며, 알림을 끈 종목은 뺀다 (서버 알림과 같은 규칙).
 * 조용한 시간에 만들어진 브리핑도 "본 것"으로 적는다 — 아침에 한꺼번에 울리지 않게 (브리핑 탭에는 그대로 있다).
 * 기록 읽기부터 쓰기까지는 수동 실행이 적는 기록(markRunSeen)과 겹치지 않게 한 번에 하나씩 (withSeen)
 */
export function notifyNewBriefings(latest: LatestBriefing[], opts: NotifyOpts = {}): Promise<number> {
  return withSeen(() => notifyUnseen(latest, opts));
}

async function notifyUnseen(latest: LatestBriefing[], opts: NotifyOpts): Promise<number> {
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
  // 3-31: 아직 알리지 않은 계좌 브리핑. 계좌 브리핑 기준을 처음 적을 때는 알리지 않는다(옛 계좌 브리핑이 따로 울리지 않게)
  const accountInfo = opts.accounts !== undefined || opts.accountIds !== undefined;
  const accountFirst = isFirst || (accountInfo && (await AsyncStorage.getItem(ACCOUNT_INIT_KEY).catch(() => null)) !== "1");
  const newAccountIds: number[] = [];
  for (const a of opts.accounts ?? []) {
    if (a.status !== "ok" || seen.has(-a.id)) continue;
    seen.add(-a.id);
    if (accountFirst) continue;
    if (now.getTime() - Date.parse(a.createdAt) > 24 * 3_600_000) continue;
    newAccountIds.push(a.id);
  }
  for (const id of opts.accountIds ?? []) seen.add(-id);
  // 같은 세션의 계좌 브리핑이 있으면 그 세션 알림 앞머리를 계좌 요약으로, 새 계좌 브리핑만 있는 세션도 1건 (여전히 세션당 1건)
  const messages =
    fresh.length || newAccountIds.length
      ? planNotifications(fresh, opts.prefs ?? DEFAULT_PREFS, now, opts.accounts ?? [], { newAccountIds, ...(opts.codes?.length ? { codes: opts.codes } : {}) })
      : [];
  for (const m of messages) {
    await Notifications.scheduleNotificationAsync({ content: { title: m.title, body: m.body, data: m.data, sound: "default" }, trigger: briefingTrigger() });
  }
  await saveSeen(seen);
  // 빈 목록이어도 기준을 적은 것으로 — 다음에 생기는 첫 브리핑을 알린다
  if (isFirst) await AsyncStorage.setItem(INIT_KEY, "1").catch(() => undefined);
  // 계좌 브리핑은 실제로 살펴본 뒤에만 기준을 적는다 (알림을 켤 때는 목록을 받지 않으므로 첫 확인에서 적는다)
  if (accountInfo) await AsyncStorage.setItem(ACCOUNT_INIT_KEY, "1").catch(() => undefined);
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
      // 계좌 브리핑 id(3-31 서버, 플래그 켜짐)도 함께 본다 — 계좌 브리핑만 새로 생긴 세션도 알리게
      const unseen = await hasUnseen(data.latestIds ?? data.briefings.flatMap((b) => (b.latest ? [b.latest.id] : [])), data.accountIds ?? []);
      if (unseen) {
        let prefs = await loadNotifyPrefs();
        const fails = prefs ? 0 : Number((await AsyncStorage.getItem(PREFS_FAIL_KEY).catch(() => null)) ?? 0) + 1;
        await AsyncStorage.setItem(PREFS_FAIL_KEY, String(fails)).catch(() => undefined);
        if (!prefs && fails >= PREFS_FAIL_LIMIT) prefs = { ...DEFAULT_PREFS, digest: false, running: false };
        // 규칙을 못 받았거나 서버가 아직 브리핑을 만드는 중이면(17종목 약 7분) 이번엔 넘긴다 — 한 세션이 두 알림으로 쪼개지지 않게.
        // "본 것"으로 적지 않으므로 다음 확인(15분 뒤)에서 한 번에 알린다. 묶음을 끈 서버는 예전처럼 바로
        if (prefs && !(prefs.digest && prefs.running)) {
          // 계좌 한 장 브리핑(3-31): 서버 플래그가 켜져 있고 묶음일 때만 묻는다. 끄면 요청 0, 계좌 브리핑 기록(본 것·기준)도 건드리지 않는다
          let accounts: AccountBriefing[] | null = null;
          let proceed = true;
          if (prefs.digest && prefs.accountBriefing === true) {
            accounts = await loadAccountBriefings();
            // 목록을 못 받음(끊김·5xx·시간 초과): 이번엔 넘기고 다음 확인에서 한 번에 1건. 연달아 PREFS_FAIL_LIMIT 번이면 계좌 요약 없이 알린다
            const fails = accounts ? 0 : Number((await AsyncStorage.getItem(ACCOUNTS_FAIL_KEY).catch(() => null)) ?? 0) + 1;
            await AsyncStorage.setItem(ACCOUNTS_FAIL_KEY, String(fails)).catch(() => undefined);
            proceed = accounts !== null || fails >= PREFS_FAIL_LIMIT;
          }
          if (proceed) {
            const latest = data.latestIds ? await loadLatestBriefings() : data.briefings;
            const rates = new Map(data.stocks.map((s) => [s.code, s.quote?.changeRate ?? null] as const));
            // 계좌 브리핑 기록('본 것'·기준): 목록을 받았을 때만 살펴보고 적는다 — 받지 못한 목록의 계좌 브리핑을 본 것으로 적으면 그 알림이 사라진다.
            // 묶음을 끈 채 플래그만 켜져 있으면(계좌 요약을 쓰지 않음) 위젯의 id 만 본 것으로 — 매번 다시 묻지 않게. 플래그가 꺼져 있으면 건드리지 않는다
            const accountOpts = accounts
              ? { accounts, ...(data.accountIds ? { accountIds: data.accountIds } : {}) }
              : !prefs.digest && prefs.accountBriefing === true && data.accountIds
                ? { accountIds: data.accountIds }
                : {};
            await notifyNewBriefings(latest, { prefs, rates, codes: data.stocks.map((s) => s.code), ...accountOpts });
          }
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
  await AsyncStorage.removeItem(ACCOUNT_INIT_KEY).catch(() => undefined);
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
