import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FilingLogEntry } from "@/lib/filingAlerts";

/**
 * 3-38 새 공시 알림의 기기 기록 (AsyncStorage 만 — 네이티브 모듈 없음, 백그라운드 태스크에서도 쓴다).
 *  - seen: 알렸거나 알리지 않기로 한 접수 번호 (최근 300개). 서버 줄 번호가 아니라 접수 번호라 서버 DB 를 새로 만들어도 겹치지 않는다
 *  - init: 기준을 잡았는지 ("1") — 첫 확인은 그때 있는 공시를 알리지 않고 '본 것'으로만
 *  - log: 알린 공시 (최근 20건) — 설정 '마지막 공시 알림 … · SEC에 올라온 뒤 …' (폰 확인의 20분 기준용 사실 기록)
 *  - enabled: 이 기기 '공시 알림' 스위치 (기본 켬, "0" 이면 끔)
 *  - viewed: '일정·공시' 화면에서 펼쳐 본 접수 번호 (최근 300개) — '새 공시' 칩을 지운다
 * 읽기~쓰기는 withFilingSeen 으로 한 번에 하나 (백그라운드 확인과 앞 화면 확인이 겹쳐도 두 번 울리지 않게 — briefingSeen.withSeen 과 같은 방식)
 */
export const FILING_SEEN_KEY = "filingAlerts.seen";
export const FILING_INIT_KEY = "filingAlerts.init";
export const FILING_LOG_KEY = "filingAlerts.log";
export const FILING_ENABLED_KEY = "filingAlerts.enabled";
export const FILING_VIEWED_KEY = "filingAlerts.viewed";
export const SEEN_MAX = 300;
export const LOG_MAX = 20;

async function readList(key: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 최근 것을 뒤에 두고 max 개만 (오래된 것부터 버린다) */
async function writeList(key: string, list: Iterable<string>, max: number): Promise<void> {
  const uniq: string[] = [];
  for (const x of list) {
    const i = uniq.indexOf(x);
    if (i >= 0) uniq.splice(i, 1);
    uniq.push(x);
  }
  await AsyncStorage.setItem(key, JSON.stringify(uniq.slice(-max))).catch(() => undefined);
}

export async function readFilingSeen(): Promise<string[]> {
  return readList(FILING_SEEN_KEY);
}

/** '본 것' 더하기 (이미 있는 것은 최근으로 옮김, 300개 넘으면 오래된 것부터) */
export async function addFilingSeen(accessions: readonly string[]): Promise<void> {
  if (!accessions.length) return;
  await writeList(FILING_SEEN_KEY, [...(await readFilingSeen()), ...accessions], SEEN_MAX);
}

export async function filingInit(): Promise<boolean> {
  return (await AsyncStorage.getItem(FILING_INIT_KEY).catch(() => null)) === "1";
}

export async function setFilingInit(): Promise<void> {
  await AsyncStorage.setItem(FILING_INIT_KEY, "1").catch(() => undefined);
}

/** 이 기기 '공시 알림' 스위치 (기본 켬) */
export async function filingAlertsEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(FILING_ENABLED_KEY).catch(() => null)) !== "0";
}

export async function setFilingAlertsEnabled(on: boolean): Promise<void> {
  await AsyncStorage.setItem(FILING_ENABLED_KEY, on ? "1" : "0").catch(() => undefined);
}

export async function readFilingLog(): Promise<FilingLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(FILING_LOG_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is FilingLogEntry => !!x && typeof (x as FilingLogEntry).accession === "string" && typeof (x as FilingLogEntry).notifiedAt === "string") : [];
  } catch {
    return [];
  }
}

export async function appendFilingLog(entries: readonly FilingLogEntry[]): Promise<void> {
  if (!entries.length) return;
  const log = [...(await readFilingLog()), ...entries].slice(-LOG_MAX);
  await AsyncStorage.setItem(FILING_LOG_KEY, JSON.stringify(log)).catch(() => undefined);
}

export async function readFilingViewed(): Promise<string[]> {
  return readList(FILING_VIEWED_KEY);
}

export async function addFilingViewed(accession: string): Promise<void> {
  await writeList(FILING_VIEWED_KEY, [...(await readFilingViewed()), accession], SEEN_MAX);
}

let turn: Promise<unknown> = Promise.resolve();

/** 기록 읽기~쓰기를 한 번에 하나씩 (앞 일이 실패해도 다음 일은 한다) */
export function withFilingSeen<T>(fn: () => Promise<T>): Promise<T> {
  const run = turn.then(fn);
  turn = run.catch(() => undefined);
  return run;
}
