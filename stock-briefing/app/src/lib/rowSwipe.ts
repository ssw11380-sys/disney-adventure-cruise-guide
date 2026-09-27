import { fontCap, oneHand } from "@/tokens";

/**
 * 잔고 줄 스와이프 계산 (3-24, 기능 플래그 oneHand). 그리기(components/SwipeRow)와 떼어 둔 순수 함수 — 테스트가 숫자로 본다.
 *  - 줄을 왼쪽으로 밀면 오른쪽 끝에 버튼(수정 · 삭제 또는 동기화 제외)이 드러난다. 한 번 밀면 두 버튼이 함께 보인다
 *  - 가로로 swipeActiveX(14) 움직여야 시작하고, 그 전에 세로로 swipeFailY(10) 움직이면 포기 → 목록 스크롤 (차트 드래그와 같은 기준)
 *  - 놓을 때: 빠르게 튕겼으면 그 방향으로, 아니면 버튼 폭 합의 swipeOpenRatio(40%) 넘게 밀었는지로 열고 닫는다
 */

/** 드러나는 버튼 한 칸 폭: 큰 글씨는 배율만큼 넓힌다 (줄 글자 상한 fontCap.row 까지 — 줄과 같은 상한) */
export function swipeActionWidth(fontScale: number): number {
  const s = Math.min(Math.max(fontScale || 1, 1), fontCap.row);
  return Math.round(oneHand.swipeActionW * s);
}

/** 버튼 폭 합 (줄이 열렸을 때 왼쪽으로 밀린 거리) */
export function swipeOpenWidth(count: number, fontScale: number): number {
  return count * swipeActionWidth(fontScale);
}

/**
 * 끄는 동안 줄 위치 (0 = 제자리, -width = 다 열림). 열린 줄에서 시작하면 -width 부터 잰다.
 * 제자리보다 오른쪽으로, 다 열린 것보다 왼쪽으로는 가지 않는다 (버튼 뒤 빈 곳이 드러나지 않게)
 */
export function swipeOffset(dx: number, startOpen: boolean, width: number): number {
  const raw = (startOpen ? -width : 0) + dx;
  return Math.min(0, Math.max(-width, raw));
}

/** 놓았을 때 열어 둘지 (true = 열림). vx 는 손가락 가로 속도 (dp/초, 왼쪽이 음수) */
export function swipeSettleOpen(dx: number, vx: number, startOpen: boolean, width: number): boolean {
  if (width <= 0) return false;
  if (vx <= -oneHand.swipeFlingV) return true;
  if (vx >= oneHand.swipeFlingV) return false;
  return -swipeOffset(dx, startOpen, width) > width * oneHand.swipeOpenRatio;
}

/** 제스처 설정 값 (테스트가 차트 드래그와 같은 기준인지 본다) */
export const swipePanConfig = { activeX: oneHand.swipeActiveX, failY: oneHand.swipeFailY } as const;

/** 한쪽을 막을 때 쓰는 먼 거리 (제스처 라이브러리 범위 값 [왼쪽 ≤ 0, 오른쪽 ≥ 0]의 '끝없음') */
const FAR = 100_000;

/**
 * 가로로 이만큼 움직이면 스와이프를 시작하는 범위 [왼쪽, 오른쪽]. 닫힌 줄은 왼쪽으로만(오른쪽으로 밀면 잡지 않아 줄 누르기가 그대로),
 * 열린 줄은 양쪽 (오른쪽으로 밀어 닫는다)
 */
export function swipeActiveRange(open: boolean): [number, number] {
  return [-swipePanConfig.activeX, open ? swipePanConfig.activeX : FAR];
}
