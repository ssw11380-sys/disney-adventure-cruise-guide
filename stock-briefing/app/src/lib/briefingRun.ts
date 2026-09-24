import { byMove } from "./briefingDigest";

/**
 * 브리핑 수동 생성·브리핑 탭 정렬 (3-19). 순수 함수 (테스트용)
 *  - 수동 생성은 종목마다 모델 두 번(상세·요약)이라 종목당 약 25초 → 17종목이면 약 7분
 */
export const SECONDS_PER_STOCK = 25;

const SESSION_KO = { morning: "오전", afternoon: "오후" } as const;

/** "약 7분" / "약 30초" */
export function estimateText(stocks: number): string {
  const sec = Math.max(1, stocks) * SECONDS_PER_STOCK;
  return sec < 60 ? `약 ${Math.ceil(sec / 10) * 10}초` : `약 ${Math.round(sec / 60)}분`;
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
