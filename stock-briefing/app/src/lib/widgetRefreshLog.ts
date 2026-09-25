import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * 위젯 자동 갱신 기록 (위젯 리뷰 2, 3-26 실측용). 앱을 닫아 두면 위젯이 실제로 몇 분마다 바뀌는지 기기 안에 짧게 적는다.
 *  - background: 백그라운드 작업(WorkManager, 15분 이상 간격 — lib/backgroundBriefings runBriefingCheck)
 *  - periodic: 위젯 주기 갱신(안드로이드 updatePeriodMillis 30분 — widgets/widgetTaskHandler WIDGET_UPDATE)
 *  - app: 앱이 떠 있을 때 위젯을 바로 그림(widgets/data pushWidgetData) · button: 위젯의 ↻
 *  - 결과: ok(그림) · skipped(두 시장이 닫혀 서버를 묻지 않음) · failed(조회 실패)
 * 기록은 이 기기 AsyncStorage 에만 두고(서버로 보내지 않음) 최근 REFRESH_LOG_MAX 줄·3일만 남긴다. 적기는 늘 하고,
 * 설정 화면에 보여 주는 것만 플래그 widgetRefreshLog 뒤에 둔다. 적다가 실패해도 갱신 자체에는 영향이 없다
 */

export type RefreshSource = "background" | "periodic" | "app" | "button";
export type RefreshResult = "ok" | "skipped" | "failed";

export interface RefreshEntry {
  /** 시각 (ms) */
  t: number;
  s: RefreshSource;
  r: RefreshResult;
  /** 실패 사유 (짧은 한국어, 예: "갱신 실패 · 연결 안 됨") */
  e?: string;
  /** 짧은 사이에 같은 출처·결과가 몰려 한 줄로 합친 수 (2 이상일 때만) */
  n?: number;
}

export const REFRESH_LOG_KEY = "widget.refreshLog";
export const REFRESH_LOG_MAX = 150;
const KEEP_MS = 3 * 86_400_000;
/** 같은 출처·결과를 한 줄로 합치는 간격: 위젯 4개의 주기 갱신이 거의 같이 온다 (1분). 앱 즉시 갱신은 켜 둔 동안 1분마다 오므로 15분 */
const MERGE_MS: Record<RefreshSource, number> = { background: 60_000, periodic: 60_000, button: 60_000, app: 15 * 60_000 };

const SOURCES: readonly RefreshSource[] = ["background", "periodic", "app", "button"];
const RESULTS: readonly RefreshResult[] = ["ok", "skipped", "failed"];

/** 한 줄 더한 목록 (순수 함수): 바로 앞 줄과 출처·결과가 같고 가까우면 합친다, 3일 넘은 줄과 넘치는 앞 줄은 버린다 */
export function appendRefresh(list: readonly RefreshEntry[], entry: RefreshEntry): RefreshEntry[] {
  const last = list.at(-1);
  const merge = last && last.s === entry.s && last.r === entry.r && entry.t >= last.t && entry.t - last.t < MERGE_MS[entry.s];
  const next = merge ? [...list.slice(0, -1), { ...last, t: entry.t, n: (last.n ?? 1) + 1, ...(entry.e ? { e: entry.e } : {}) }] : [...list, entry];
  return next.filter((x) => entry.t - x.t <= KEEP_MS).slice(-REFRESH_LOG_MAX);
}

function clean(v: unknown): RefreshEntry[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): RefreshEntry[] => {
    const o = x as Partial<RefreshEntry> | null;
    if (!o || typeof o.t !== "number" || !Number.isFinite(o.t) || !SOURCES.includes(o.s as RefreshSource) || !RESULTS.includes(o.r as RefreshResult)) return [];
    return [{ t: o.t, s: o.s as RefreshSource, r: o.r as RefreshResult, ...(typeof o.e === "string" ? { e: o.e.slice(0, 60) } : {}), ...(typeof o.n === "number" && o.n > 1 ? { n: o.n } : {}) }];
  });
}

export async function readWidgetRefreshLog(): Promise<RefreshEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(REFRESH_LOG_KEY);
    return raw ? clean(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** 이 JS 실행 안에서 한 번에 하나씩 (읽고-더하고-쓰는 사이에 다른 기록이 사라지지 않게) */
let queue: Promise<unknown> = Promise.resolve();

/** 한 줄 적는다. 실패해도 조용히 (기록은 진단용) */
export function logWidgetRefresh(s: RefreshSource, r: RefreshResult, o: { at?: number; error?: string | null } = {}): Promise<void> {
  const entry: RefreshEntry = { t: o.at ?? Date.now(), s, r, ...(o.error ? { e: o.error.slice(0, 60) } : {}) };
  const run = queue.then(async () => {
    try {
      const next = appendRefresh(await readWidgetRefreshLog(), entry);
      await AsyncStorage.setItem(REFRESH_LOG_KEY, JSON.stringify(next));
    } catch {
      /* 기록 실패는 무시 */
    }
  });
  queue = run;
  return run;
}

/** 장중에 자동 갱신이 이만큼 없으면 경고 (백그라운드 작업은 15분 간격이라 네 번 넘게 빠진 것) */
export const STALE_AUTO_MS = 60 * 60_000;

export interface RefreshSummary {
  /** 마지막 자동 갱신 (백그라운드 성공·건너뜀, 위젯 주기 갱신 성공). 없으면 null */
  last: number | null;
  /** 오늘(한국 날짜) 자동 갱신 사이 평균 간격(분). 두 번 미만이면 null */
  avgGapMin: number | null;
  /** 오늘 자동 갱신 수 */
  todayCount: number;
  /** 오늘 백그라운드 갱신 실패 수 */
  failedToday: number;
  /** 장중인데 자동 갱신이 STALE_AUTO_MS 넘게 없음 (한 번도 없으면 기록이 시작된 때부터) */
  stale: boolean;
}

const kstDate = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
/** 자동 갱신으로 세는 줄: 작업이 제때 돌았다는 뜻 (건너뜀도 두 시장이 닫혀 일부러 묻지 않은 것) */
const isAuto = (e: RefreshEntry) => (e.s === "background" && (e.r === "ok" || e.r === "skipped")) || (e.s === "periodic" && e.r === "ok");

/** 설정 화면 요약 (순수 함수). marketOpen: 지금 한국·미국 중 달력으로 열린 시장이 있음 */
export function summarizeRefreshLog(list: readonly RefreshEntry[], now: number, marketOpen: boolean): RefreshSummary {
  const sorted = [...list].sort((a, b) => a.t - b.t);
  const autos = sorted.filter(isAuto);
  const today = kstDate(now);
  const todays = autos.filter((e) => kstDate(e.t) === today).map((e) => e.t);
  const gaps = todays.slice(1).map((t, i) => t - todays[i]!);
  const last = autos.at(-1)?.t ?? null;
  const since = last ?? sorted[0]?.t ?? null;
  return {
    last,
    avgGapMin: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 60_000) : null,
    todayCount: todays.length,
    failedToday: sorted.filter((e) => e.s === "background" && e.r === "failed" && kstDate(e.t) === today).length,
    stale: marketOpen && since !== null && now - since > STALE_AUTO_MS,
  };
}

/** "10:47", 오늘(한국 날짜)이 아니면 "9/23 23:50" */
function clock(ms: number, now: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return kstDate(ms) === kstDate(now) ? hm : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}`;
}

/** "마지막 자동 갱신 10:47 · 오늘 평균 간격 18분 · 실패 1회" */
export function refreshSummaryText(s: RefreshSummary, now: number): string {
  if (s.last === null) return s.failedToday ? `아직 자동 갱신 성공 기록이 없습니다 · 실패 ${s.failedToday}회` : "아직 자동 갱신 기록이 없습니다";
  const parts = [`마지막 자동 갱신 ${clock(s.last, now)}`];
  if (s.avgGapMin !== null) parts.push(`오늘 평균 간격 ${s.avgGapMin}분`);
  if (s.failedToday) parts.push(`실패 ${s.failedToday}회`);
  return parts.join(" · ");
}
