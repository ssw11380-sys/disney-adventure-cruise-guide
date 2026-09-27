import { focusManager } from "@tanstack/react-query";

/**
 * 끊겼을 때 데이터 절약 (플래그 pollSaver, 3-25 성능-16) — 현재가 폴링 주기. 순수 함수 (RN 의존 없음 → 단위 테스트).
 * 켜져 있을 때만 쓴다 (끄면 lib/freshness 의 pollInterval 그대로).
 *  - 요청이 실패하는 중: 예전과 같다 (장중 3초, 아니면 5초)
 *  - 모든 세션이 닫힘: 5분 (예전 1분). 다음 세션 경계 1초 뒤에는 hooks 의 capToBoundary 가 바로 다시 받게 한다 → 열리는 순간은 놓치지 않는다
 *  - 장중 + 체결 스트림이 값을 주는 중: 보정용 30초 (예전과 같다)
 *  - 장중 + 스트림 없음(웹소켓이 막힘): 3초. 받은 값이 연달아 2번 그대로면(서버가 304) 4초로 늦춘다.
 *    값이 바뀌거나 사용자가 앱으로 돌아오거나 당겨서 새로고침하면 다시 3초.
 *    늦춘 주기의 상한 4초 = 화면 지연 5초 이하(로드맵 완료 기준): 주기 4초 + 응답 시간이 5초를 넘지 않게. 그 이상 늦추면 값이 바뀐 뒤 화면에 늦게 보인다
 */
export const SAVER = {
  baseMs: 3_000,
  quietMs: 4_000,
  /** 연달아 그대로인 응답이 이만큼이면 quietMs */
  quietAfter: 2,
  closedMs: 5 * 60_000,
  streamMs: 30_000,
  /**
   * 웹소켓 다시 붙기 간격 상한 (예전 30초). 끊긴 동안은 폴링이 값을 주므로(지연 5초 안) 헛된 연결 시도를 줄인다 —
   * 막힌 망에서는 시도마다 새 연결(TLS 인증서 교환 수 KB)이 들어 30초마다면 시간당 120번. 앱으로 돌아오면 1초부터 다시
   */
  reconnectMaxMs: 120_000,
} as const;

export function saverInterval(o: { open: boolean; streamFresh: boolean; failing: boolean; unchanged: number }): number {
  if (o.failing) return o.open ? 3_000 : 5_000;
  if (!o.open) return SAVER.closedMs;
  if (o.streamFresh) return SAVER.streamMs;
  return o.unchanged >= SAVER.quietAfter ? SAVER.quietMs : SAVER.baseMs;
}

/** 설정 > 서버 '시세 받기' 줄: 최근 응답 중 변화 없음(304)·바뀐 것만(226)·전체(200) 비율 */
export function saverLabel(s: { recent: number; same: number; delta: number; full: number }): string {
  if (s.recent === 0) return "아직 없음";
  const pct = (n: number) => `${Math.round((n / s.recent) * 100)}%`;
  return `변화 없음 ${pct(s.same)} · 바뀐 것만 ${pct(s.delta)} · 전체 ${pct(s.full)}`;
}

/** react-query 쿼리에서 여기서 쓰는 부분 */
export interface PolledQuery {
  state: { dataUpdateCount: number; data: unknown };
}

/**
 * 쿼리마다 "연달아 그대로인 받기" 수. react-query 는 받은 값이 이전과 같으면(구조 공유) 같은 객체를 두므로, 받을 때마다(dataUpdateCount 증가)
 * 객체가 그대로인지로 센다. 체결로 값이 바뀌거나 새 값을 받으면 0. refetchInterval 함수가 여러 번 불려도 받기 한 번에 한 번만 센다
 */
const seen = new WeakMap<object, { count: number; data: unknown; streak: number; gen: number }>();
let generation = 0;
let listening = false;

/** 사용자가 앱으로 돌아오거나 당겨서 새로고침하면 늦춘 주기를 풀고 3초로 */
export function resetPollBackoff(): void {
  generation++;
}

export function unchangedStreak(q: PolledQuery): number {
  if (!listening) {
    listening = true;
    // 앱으로 돌아오면(react-query focusManager — _layout 이 AppState 로 맞춘다) 다시 3초부터
    focusManager.subscribe((focused) => {
      if (focused) resetPollBackoff();
    });
  }
  const s = q.state;
  const r = seen.get(q);
  if (!r || r.gen !== generation) {
    seen.set(q, { count: s.dataUpdateCount, data: s.data, streak: 0, gen: generation });
    return 0;
  }
  if (s.dataUpdateCount !== r.count) {
    r.streak = s.data === r.data ? r.streak + 1 : 0;
    r.count = s.dataUpdateCount;
    r.data = s.data;
  }
  return r.streak;
}
