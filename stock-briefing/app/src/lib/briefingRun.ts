import { byMove } from "./briefingDigest";

/**
 * 브리핑 수동 생성·브리핑 탭 정렬 (3-19). 순수 함수 (테스트용)
 *  - 수동 생성은 종목마다 모델 두 번(상세·요약)이라 종목당 약 25초 → 17종목이면 약 7분
 */
export const SECONDS_PER_STOCK = 25;

/**
 * 예약 실행 한 번이 시작부터 알림 판단까지 걸리는 예상 시간(초). 종목마다 약 25초에, 앞뒤 작업(실행 전 토스 잔고 읽기·실행 뒤 계좌 요약) 몫으로
 * 한 종목만큼 더한다 — 서버는 이것까지 끝난 시각으로 조용한 시간을 본다 (BH-58). 종목 수를 모르면(0) 0
 */
export function sessionSeconds(stocks: number): number {
  return stocks > 0 ? (stocks + 1) * SECONDS_PER_STOCK : 0;
}

const SESSION_KO = { morning: "오전", afternoon: "오후" } as const;

/** "약 7분" / "약 30초" */
export function estimateText(stocks: number): string {
  const sec = Math.max(1, stocks) * SECONDS_PER_STOCK;
  return sec < 60 ? `약 ${Math.ceil(sec / 10) * 10}초` : `약 ${Math.round(sec / 60)}분`;
}

/**
 * 빈 브리핑 탭의 '지금 만들기'가 먼저 고르는 세션 (3-24 emptyGuide — 오전·오후를 묻는 창을 한 번 줄인다): 한국 시각 정오 전이면 오전(장 시작 전 브리핑),
 * 정오부터는 오후(마감 뒤 브리핑). 확인 창에서 다른 세션으로 바꿀 수 있다 (runChoice)
 */
export function sessionNow(now: number): "morning" | "afternoon" {
  const kstHour = new Date(now + 9 * 3_600_000).getUTCHours();
  return kstHour < 12 ? "morning" : "afternoon";
}

/** 수동 생성 확인 창 문구 */
export function runConfirm(session: "morning" | "afternoon", stocks: number): { title: string; message: string } {
  const label = SESSION_KO[session];
  return {
    title: `${label} 브리핑 ${stocks}종목 새로 만들기`,
    message: `${stocks}종목, ${estimateText(stocks)} 걸리며 오늘 ${label} 브리핑을 덮어씁니다. 그동안 다른 생성은 할 수 없습니다.`,
  };
}

/**
 * 빈 브리핑 탭 '지금 만들기' 확인 창 (3-24 emptyGuide): 시각에 맞춘 세션(sessionNow)을 먼저 보이고, 다른 세션으로 바꾸는 버튼을 함께 둔다.
 * 빈 상태에서는 '수동 생성' 카드(오전·오후)·넓은 창 '⋯'를 숨기므로 다른 세션을 고를 곳이 이 창뿐이다 → 오전에 마감 뒤(오후) 브리핑도 만들 수 있게.
 * 바꾸기를 누르면 같은 창이 그 세션으로 다시 열린다 (다시 누르면 원래 세션으로)
 */
export function runChoice(session: "morning" | "afternoon", stocks: number): { title: string; message: string; other: "morning" | "afternoon"; switchLabel: string } {
  const c = runConfirm(session, stocks);
  const other = session === "morning" ? "afternoon" : "morning";
  // 받침: 오전 → '오전으로', 오후 → '오후로'
  const otherTo = other === "morning" ? "오전으로" : "오후로";
  return {
    title: c.title,
    message: `${c.message}\n\n${SESSION_KO[other]} 브리핑을 만들려면 '${otherTo} 바꾸기'를 누르세요.`,
    other,
    switchLabel: `${otherTo} 바꾸기`,
  };
}

/**
 * 브리핑 탭 순서. movers=true 면 등락률 절댓값이 큰 순(모르면 뒤, 같으면 등록순), 아니면 등록순 그대로.
 * top 은 등락률을 아는 상위 3종목 (첫 화면 요약용)
 */
export function orderForTab<T extends { code: string }>(items: T[], rates: Map<string, number | null | undefined>, movers: boolean): { list: T[]; top: T[] } {
  if (!movers) return { list: items, top: [] };
  const list = byMove(items, (i) => rates.get(i.code));
  const known = list.filter((i) => {
    const r = rates.get(i.code);
    return r !== null && r !== undefined && Number.isFinite(r);
  });
  return { list, top: known.slice(0, 3) };
}
