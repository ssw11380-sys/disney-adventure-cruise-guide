/**
 * '관심 그룹·순서' 화면의 끌어서 순서 바꾸기 (3-34) — 순수 함수. 줄 높이는 글자 크기에 따라 다를 수 있어 잰 값 목록으로 받는다.
 *  - 목표 칸: 끄는 줄의 가운데가 다른 줄의 가운데를 지날 때마다 한 칸씩 바뀐다
 *  - 다른 줄 비켜 주기: 끄는 줄이 지나간 줄들은 끄는 줄 높이만큼 위(아래로 끌 때) 또는 아래(위로 끌 때)로 비켜 보인다
 * 화면 끝 자동 스크롤은 없다 (긴 목록은 ↑·↓·맨 위로·맨 아래로)
 */

/** 줄마다 윗변 위치 */
function tops(heights: readonly number[]): number[] {
  let y = 0;
  return heights.map((h) => {
    const t = y;
    y += h;
    return t;
  });
}

/** 끄는 줄의 새 자리 (0부터). from 이 범위 밖이면 그대로 */
export function dragTarget(heights: readonly number[], from: number, dy: number): number {
  if (from < 0 || from >= heights.length || !Number.isFinite(dy)) return from;
  const top = tops(heights);
  const center = top[from]! + heights[from]! / 2 + dy;
  let target = 0;
  for (let j = 0; j < heights.length; j++) {
    if (j === from) continue;
    if (center > top[j]! + heights[j]! / 2) target++;
  }
  return target;
}

/** 끄는 동안 j 번째 줄이 비켜 보이는 거리 (끄는 줄 자신은 0 — 손가락을 따라가는 거리는 따로) */
export function dragShift(heights: readonly number[], from: number, to: number, j: number): number {
  if (j === from || from < 0 || from >= heights.length) return 0;
  const h = heights[from]!;
  if (from < to && j > from && j <= to) return -h;
  if (to < from && j >= to && j < from) return h;
  return 0;
}
