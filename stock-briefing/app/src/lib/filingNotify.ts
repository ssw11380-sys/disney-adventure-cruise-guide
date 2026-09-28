import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { FilingAlertItem } from "@/api/types";
import { inQuietHours, type NotifyPrefs } from "@/lib/briefingDigest";
import { inEdgarHours, planFilingNotification } from "@/lib/filingAlerts";
import { addFilingSeen, appendFilingLog, filingAlertsEnabled, filingInit, readFilingSeen, setFilingInit, withFilingSeen } from "@/lib/filingSeen";
import { persistedFeatureOn } from "@/lib/marketSummaryLoad";
import { ensureFilingChannel, FILING_CHANNEL } from "@/lib/notifications";
import { PERSIST_STORAGE_KEY } from "@/lib/queryPersist";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";

/**
 * 3-38 새 공시 알림 — 로컬 알림 보내기 (백그라운드 확인 runBriefingCheck · 앱이 앞에 있을 때 FilingAlertBridge 가 같이 쓴다).
 * 규칙은 lib/filingAlerts planFilingNotification (순수 함수). 한 번 확인할 때 알림은 최대 1건(묶음), 채널 '공시 알림'
 */

/** Android 는 채널을 trigger 에서만 읽는다 (briefingTrigger 와 같은 까닭) */
export function filingTrigger(): Notifications.NotificationTriggerInput {
  return Platform.OS === "android" ? { channelId: FILING_CHANNEL } : null;
}

/**
 * 공시 알림에 쓰는 규칙: 조용한 시간은 서버 알림 묶음(briefingDigest)이 켜져 있을 때만 — 설정 화면도 그때만 조용한 시간과 '공시 알림'의 조용한 시간 줄을 보인다.
 * (묶음이 꺼진 서버는 브리핑에도 조용한 시간을 쓰지 않는다)
 */
export function filingRules(p: NotifyPrefs): NotifyPrefs {
  return p.digest === false ? { ...p, quietEnabled: false } : p;
}

async function granted(): Promise<boolean> {
  try {
    return (await Notifications.getPermissionsAsync()).status === "granted";
  } catch {
    return false;
  }
}

/**
 * 서버 알림 목록으로 알림 0~1건. 알림 권한이 없으면 아무것도 적지 않는다(권한을 다시 주면 24시간 안의 것만).
 * 기록 읽기~쓰기는 withFilingSeen 으로 한 번에 하나 (두 확인이 겹쳐도 한 번만 울린다). 보낸 알림 수
 */
export async function notifyFilings(items: readonly FilingAlertItem[], opts: { prefs: NotifyPrefs; now?: Date }): Promise<number> {
  if (!(await granted())) return 0;
  return withFilingSeen(async () => {
    const now = opts.now ?? new Date();
    const plan = planFilingNotification({ items, seen: new Set(await readFilingSeen()), init: await filingInit(), prefs: filingRules(opts.prefs), enabled: await filingAlertsEnabled(), now });
    if (plan.message) {
      await ensureFilingChannel().catch(() => undefined);
      await Notifications.scheduleNotificationAsync({ content: { title: plan.message.title, body: plan.message.body, data: plan.message.data, sound: "default" }, trigger: filingTrigger() });
    }
    await addFilingSeen(plan.markSeen);
    if (plan.init) await setFilingInit();
    if (plan.message) await appendFilingLog(plan.notified.map((i) => ({ accession: i.accession, acceptedAt: i.acceptedAt, notifiedAt: now.toISOString() })));
    return plan.message ? 1 : 0;
  });
}

export interface FilingLoaders {
  /** 알림 규칙 (조용한 시간·끈 종목). 받지 못하면 null → 이번엔 넘긴다 */
  prefs: () => Promise<NotifyPrefs | null>;
  /** 서버 알림 목록 (/api/filings/alerts). 받지 못하면 null */
  alerts: () => Promise<FilingAlertItem[] | null>;
}

/**
 * 백그라운드 확인: 위젯 응답의 filingIds 에 모르는 접수 번호가 있을 때만 규칙·목록 두 요청 → 알림 (없으면 추가 요청 0).
 * 조용한 시간이면 목록을 받지 않고 미룬다 (끝난 뒤 첫 확인에서 한 번에). 권한이 없으면 요청 0
 */
export async function checkFilingIds(ids: readonly string[] | undefined, load: FilingLoaders, now: Date = new Date()): Promise<number> {
  if (!ids?.length) return 0;
  const init = await filingInit();
  const seen = new Set(await readFilingSeen());
  if (init && ids.every((id) => seen.has(id))) return 0;
  if (!(await granted())) return 0;
  const prefs = await load.prefs();
  if (!prefs) return 0;
  if (init && inQuietHours(filingRules(prefs), now)) return 0;
  const items = await load.alerts();
  if (!items) return 0;
  return notifyFilings(items, { prefs, now });
}

/**
 * 백그라운드 확인이 휴장 건너뛰기(두 시장·연장 세션이 모두 닫히면 최대 2시간 — widgets/payload shouldSkipFetch)를 공시 때문에 하지 않을지.
 * SEC 접수 시간(미국 동부 평일 06:00~22:59)이고, 앱이 마지막으로 받은 서버 플래그(기기 저장본)에서 filingAlerts 가 켜져 있고, 이 기기 '공시 알림'이 켜져 있을 때 true.
 * 미국 증시는 쉬지만 SEC 는 공시를 받는 때(성금요일 · 금요일 20:00~22:59 동부 = 한국 토요일 오전 · 한국 휴일의 미국 애프터마켓 뒤)에도 15분 확인을 이어 가
 * '20분 안' 기준을 지키게. 부르는 쪽이 로컬 모드(알림을 켠 기기)인지 본다. 플래그를 모르거나 꺼져 있으면 false — 지금과 같다
 */
export async function filingWatchDue(now: number): Promise<boolean> {
  if (!inEdgarHours(now)) return false;
  if (!(await filingAlertsEnabled())) return false;
  const pairs = await AsyncStorage.multiGet([STORAGE_KEYS.apiUrl, PERSIST_STORAGE_KEY]).catch(() => [] as [string, string | null][]);
  const m = new Map(pairs);
  return persistedFeatureOn(m.get(PERSIST_STORAGE_KEY) ?? null, m.get(STORAGE_KEYS.apiUrl) || defaultApiUrl(), "filingAlerts");
}
