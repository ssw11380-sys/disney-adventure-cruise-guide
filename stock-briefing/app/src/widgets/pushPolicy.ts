/**
 * 앱 → 위젯 즉시 갱신 규칙 (순수 함수, 3-16).
 *  - 이번 실행에서 서버에서 받은 잔고만 넘긴다 (켜자마자 보이는 기기 저장값으로 위젯을 덮지 않게)
 *  - 시세만 바뀌면 1분에 한 번 (3초 폴링마다 위젯을 다시 그리지 않게)
 *  - 표시 설정(원화·비용 차감)이나 장 상태 칩이 바뀌면 바로, 앱을 떠날 때(백그라운드로)도 바로
 *    (휴장 중처럼 시세가 1분에 한 번 오는 때도 설정을 바꾸고 홈으로 나가면 바로 반영되게)
 */
export const PUSH_EVERY_MS = 60_000;

export function widgetPushDue(o: { now: number; fetchedThisSession: boolean; lastAt: number; lastKey: string; key: string; leaving?: boolean }): boolean {
  if (!o.fetchedThisSession) return false;
  if (o.leaving || o.key !== o.lastKey) return true;
  return o.now - o.lastAt >= PUSH_EVERY_MS;
}

/** 설정 화면 위젯 도움말 (3-26 실측과 맞춘다) */
export const WIDGET_REFRESH_HELP = "앱을 열면 즉시 · 닫혀 있으면 장중 약 15분, 휴장 2~4시간마다 · 위젯의 ↻ 로 즉시";
