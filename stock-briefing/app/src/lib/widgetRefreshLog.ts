import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * 위젯 자동 갱신 기록 (위젯 리뷰 2, 3-26 실측용). 앱을 닫아 두면 위젯이 실제로 몇 분마다 바뀌는지 기기 안에 짧게 적는다.
 *  - background: 백그라운드 작업(WorkManager, 15분 이상 간격 — lib/backgroundBriefings runBriefingCheck)
 *  - periodic: 위젯 주기 갱신(안드로이드 updatePeriodMillis 30분 — widgets/widgetTaskHandler WIDGET_UPDATE)
 *  - app: 앱이 떠 있을 때 위젯을 바로 그림(widgets/data pushWidgetData) · button: 위젯의 ↻
 *  - 결과: ok(서버에서 받아 그림) · skipped(서버를 부르지 않음 — 백그라운드는 두 시장이 닫혀 건너뜀, 주기 갱신은 받아 둔 응답을 다시 씀) · failed(조회 실패)
 * 기록은 이 기기 AsyncStorage 에만 두고(서버로 보내지 않음) 3일치만 남긴다 (줄 수 한도 REFRESH_LOG_MAX 는 안전장치 — 보통은 3일이 먼저 걸린다).
 * 적기는 늘 하고, 설정 화면에 보여 주는 것만 플래그 widgetRefreshLog 뒤에 둔다. 적다가 실패해도 갱신 자체에는 영향이 없다
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
/**
 * 줄 수 한도 (안전장치). 3일치가 먼저 걸리게 넉넉히: 백그라운드 15분(하루 96줄) + 주기 갱신 30분(위젯 여러 개는 1분 안에 한 줄로, 서버 조회·재사용 두 줄까지 하루 96줄)
 * + 앱 즉시 갱신(15분에 한 줄, 켜 둔 동안) ≈ 하루 300줄 이하 → 3일 900줄. 한 줄 약 45자라 약 45KB (예전 150줄은 하루치 남짓이었다 — 통합 검증 지적)
 */
export const REFRESH_LOG_MAX = 1000;
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
  /** 마지막 자동 갱신 — 백그라운드·주기 갱신이 서버에서 받아 그린 때 (건너뜀·재사용은 새 숫자가 아니라 세지 않는다). 없으면 null */
  last: number | null;
  /**
   * 오늘(한국 날짜) 자동 갱신이 서버에 물은 사이 평균 간격(분) — 백그라운드·주기 갱신의 성공·실패만 (통합 검증 지적: 건너뜀·받아 둔 응답 재사용·앱·↻ 를 섞으면
   * 실제로 숫자가 바뀌는 간격보다 짧게 보여 3-26 실측이 흐려졌다). 두 번 미만이면 null
   */
  avgGapMin: number | null;
  /** 오늘 자동 갱신이 서버에 물은 수 (성공·실패) */
  todayCount: number;
  /** 오늘 자동 갱신(백그라운드·주기 갱신) 실패 수 */
  failedToday: number;
  /**
   * 장중인데 자동 갱신 작업 자체가 STALE_AUTO_MS 넘게 돌지 않음 (성공·건너뜀·실패 어느 것도 없음 — 절전 의심).
   * 휴장 규칙으로 건너뛴 기록도 '작업이 돌았다'로 센다: 밤새 건너뛰다 개장 직후 거짓 경고가 뜨지 않게
   */
  stale: boolean;
  /** 작업은 도는데 최근 STALE_AUTO_MS 안에 실패가 있고 그동안 성공이 없음 → 절전 탓이 아니라 연결·서버·토큰 문제 */
  failing: boolean;
  /** 가장 최근 자동 갱신 실패 사유 (failing 일 때 보여 준다). 모르면 null */
  lastError: string | null;
}

const kstDate = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
/** 자동 갱신(앱·↻ 가 아닌 것): 백그라운드 작업·위젯 주기 갱신 */
const isAuto = (e: RefreshEntry) => e.s === "background" || e.s === "periodic";
/** 자동 갱신이 서버에 물은 줄 (성공·실패). 건너뜀은 서버를 부르지 않았다 */
const asked = (e: RefreshEntry) => isAuto(e) && (e.r === "ok" || e.r === "failed");

/** 설정 화면 요약 (순수 함수). marketOpen: 지금 한국·미국 중 달력으로 열린 시장이 있음 */
export function summarizeRefreshLog(list: readonly RefreshEntry[], now: number, marketOpen: boolean): RefreshSummary {
  const sorted = [...list].sort((a, b) => a.t - b.t);
  const today = kstDate(now);
  const todays = sorted.filter((e) => asked(e) && kstDate(e.t) === today).map((e) => e.t);
  const gaps = todays.slice(1).map((t, i) => t - todays[i]!);
  const last = sorted.filter((e) => isAuto(e) && e.r === "ok").at(-1)?.t ?? null;
  // 작업이 마지막으로 돈 때 (결과 상관없음). 한 번도 없으면 기록이 시작된 때부터
  const lastRun = sorted.filter(isAuto).at(-1)?.t ?? sorted[0]?.t ?? null;
  const stale = marketOpen && lastRun !== null && now - lastRun > STALE_AUTO_MS;
  // 최근 한 시간 안의 자동 갱신 실패: 작업은 도는데 서버에서 못 받는 것 (절전으로 작업이 멈추면 기록 자체가 없다)
  const recentFails = sorted.filter((e) => isAuto(e) && e.r === "failed" && now - e.t <= STALE_AUTO_MS);
  return {
    last,
    avgGapMin: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 60_000) : null,
    todayCount: todays.length,
    failedToday: sorted.filter((e) => isAuto(e) && e.r === "failed" && kstDate(e.t) === today).length,
    stale,
    failing: marketOpen && recentFails.length > 0 && (last === null || now - last > STALE_AUTO_MS),
    lastError: recentFails.at(-1)?.e ?? null,
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
