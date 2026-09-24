/**
 * 통신이 끊기거나 늦을 때 화면을 어떻게 보여 줄지 정하는 순수 함수 모음 (RN 의존 없음 → 단위 테스트).
 *  - 한 번이라도 받은 값이 있으면 재조회가 실패해도 화면을 지우지 않는다(오류 화면은 처음 불러오기 실패 때만)
 *  - 값이 늦거나 끊겼으면 "HH:MM:SS 기준"으로 언제 값인지 보여 준다
 */

/** 화면 전체를 무엇으로 그릴지: 데이터가 있으면 무조건 데이터 */
export type ViewState = "loading" | "error" | "ready";

export function viewState(q: { data: unknown; isError: boolean }): ViewState {
  if (q.data !== undefined) return "ready";
  return q.isError ? "error" : "loading";
}

/** react-query 쿼리 상태 중 여기서 쓰는 부분 */
export interface QueryLike {
  data: unknown;
  isError: boolean;
  /** 'paused' = 오프라인이라 요청을 미뤄 둔 상태(웹) */
  fetchStatus: "fetching" | "paused" | "idle";
  dataUpdatedAt: number;
}

export interface Connection {
  /** 받은 값은 있는데 최근 요청이 실패했거나 오프라인이라 미뤄졌다 */
  offline: boolean;
  /** 받은 값이 maxAgeMs 보다 오래됐다 (요청은 되는데 늦는 경우 포함) */
  stale: boolean;
  /** 화면 값의 기준 시각(ms). 받은 값이 없으면 null */
  asOf: number | null;
}

export function connection(q: QueryLike, now: number, maxAgeMs: number): Connection {
  const has = q.data !== undefined && q.dataUpdatedAt > 0;
  if (!has) return { offline: false, stale: false, asOf: null };
  // 재시도까지 실패해 오류 상태가 됐거나(일시적 1회 실패로는 띠를 띄우지 않음), 오프라인이라 요청이 보류됐을 때
  const offline = q.isError || q.fetchStatus === "paused";
  const stale = now - q.dataUpdatedAt > maxAgeMs;
  return { offline, stale, asOf: q.dataUpdatedAt };
}

/** 실시간 체결이 이 시간보다 오래 없으면 "실시간"이라고 하지 않는다 */
export const LIVE_TICK_MAX_AGE_MS = 30_000;

/** 장중 시세가 이 시간보다 오래 안 바뀌면(3초 폴링 5번 이상 못 받음) 늦은 값으로 본다 */
export const OPEN_MAX_AGE_MS = 15_000;

/**
 * 장중 "지연" 판단 기준. 스트림이 값을 주는 동안은 폴링이 30초라 그보다 길게 잡는다
 * (그렇지 않으면 "실시간"과 "시세 지연"이 동시에 보인다)
 */
export function openMaxAge(fresh: boolean): number {
  return fresh ? LIVE_TICK_MAX_AGE_MS + OPEN_MAX_AGE_MS : OPEN_MAX_AGE_MS;
}

/** 체결 스트림이 지금 값을 주고 있는지: 연결돼 있고, 마지막 체결(없으면 연결 시각)이 30초 이내 */
export function streamFresh(s: { connected: boolean; lastTickAt: number | null; connectedAt: number | null }, now: number): boolean {
  if (!s.connected) return false;
  const last = Math.max(s.lastTickAt ?? 0, s.connectedAt ?? 0);
  return last > 0 && now - last <= LIVE_TICK_MAX_AGE_MS;
}

export type LiveTone = "live" | "delayed" | "offline" | "closed";

/**
 * 잔고 패널 상태 글자.
 *  - 끊김: "연결 끊김"
 *  - 장이 닫힘: 장 상태 라벨(장 마감·휴장 등)
 *  - 장중 + 체결 스트림이 값을 주는 중: "실시간"
 *  - 장중 + 3초 폴링이 제때 오는 중: "지연 3초"
 *  - 장중인데 값이 15초 넘게 안 바뀜: "지연"
 */
export function liveLabel(o: { open: boolean; closedLabel: string; streamFresh: boolean; offline: boolean; stale: boolean }): { text: string; tone: LiveTone } {
  if (o.offline) return { text: "연결 끊김", tone: "offline" };
  if (!o.open) return { text: o.closedLabel, tone: "closed" };
  if (o.streamFresh) return { text: "실시간", tone: "live" };
  return o.stale ? { text: "지연", tone: "delayed" } : { text: "지연 3초", tone: "delayed" };
}

/**
 * 현재가 폴링 주기.
 *  - 요청이 실패하는 중이면 5초마다 다시 시도(장이 닫혀 1분 주기여도 복구 후 5초 안에 돌아오게)
 *  - 장중 + 체결 스트림이 값을 주는 중이면 보정용 30초
 *  - 장중이면 3초, 아니면 1분
 * 서버 /health 한 번 실패로 주기를 1분에 묶어 두지 않는다 (예전 동작).
 */
export function pollInterval(o: { open: boolean; streamFresh: boolean; failing: boolean }): number {
  if (o.failing) return o.open ? 3_000 : 5_000;
  if (o.open && o.streamFresh) return 30_000;
  return o.open ? 3_000 : 60_000;
}

/** "14:03:21" (한국 시간). 오늘이 아니면 "9/23 14:03" */
export function clockLabel(ms: number, now: number): string {
  const kst = (x: number) => new Date(x + 9 * 3_600_000);
  const d = kst(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const sameDay = d.toISOString().slice(0, 10) === kst(now).toISOString().slice(0, 10);
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return sameDay ? `${hm}:${p(d.getUTCSeconds())}` : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}`;
}

/** 끊김·지연 띠 문구. 보여 줄 필요가 없으면 null */
export function staleBanner(c: Connection, o: { open: boolean; now: number }): string | null {
  if (c.asOf === null) return null;
  const at = `${clockLabel(c.asOf, o.now)} 기준`;
  if (c.offline) return `연결 끊김 · ${at} · 다시 연결 중`;
  if (o.open && c.stale) return `시세 지연 · ${at}`;
  return null;
}

/** 딥링크 파라미터 검증: 브리핑 id 는 양의 정수만 */
export function parseBriefingId(raw: string | string[] | undefined): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s || !/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/** 종목 코드 검증: 국내 6자리(영문 섞인 신규 코드 포함), 미국 티커(점·하이픈) */
export function parseStockCode(raw: string | string[] | undefined): string | null {
  const s = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!s || !/^[A-Za-z0-9][A-Za-z0-9.\-]{0,14}$/.test(s)) return null;
  return s;
}

/** 서버가 새로 받지 못한 마지막 시세(stale)로 보여 주는 종목 수 → 잔고 상단 "시세 지연 N" */
export function staleQuoteCount(list: readonly { quote: { stale?: boolean } | null }[] | undefined): number {
  return list ? list.filter((s) => s.quote?.stale === true).length : 0;
}

/** 잔고 상단 상태 줄 끝: "보유 17 · 관심 1 · 시세 지연 2" */
export function holdingsSuffix(o: { held: number; watch: number; stale: number }): string {
  return `보유 ${o.held}${o.watch ? ` · 관심 ${o.watch}` : ""}${o.stale ? ` · 시세 지연 ${o.stale}` : ""}`;
}

/** 설정 "토스 대조" 줄: "차이 -1,234원 (0.01%) · 9월 28일 (월) 10:20" (시세가 빠진 비교는 따로 표시) */
export function reconcileLabel(r: { last: { at: string; diffKrw: number; diffPct: number; missing: number } | null } | null | undefined, when: (iso: string) => string): string {
  if (!r?.last) return "아직 없음 (동기화 뒤 표시)";
  const l = r.last;
  if (l.missing > 0) return `시세 ${l.missing}종목을 못 받아 비교 제외 · ${when(l.at)}`;
  const sign = l.diffKrw > 0 ? "+" : l.diffKrw < 0 ? "-" : "";
  return `차이 ${sign}${Math.abs(l.diffKrw).toLocaleString("ko-KR")}원 (${sign}${Math.abs(l.diffPct).toFixed(2)}%) · ${when(l.at)}`;
}
