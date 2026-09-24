/**
 * 보유 수정 화면 규칙 (순수 함수 → 단위 테스트).
 *  - 평단 칸은 미국 소수 2자리, 국내 정수로 보여 준다 (서버 값이 232555.333333 이어도)
 *  - 저장할 때는 사용자가 바꾼 칸만 보낸다 → 메모만 고치면 수량·평단은 그대로 (보여 주려고 반올림한 값으로 덮어쓰지 않음)
 */
export function avgText(avg: number | null | undefined, cur: "KRW" | "USD"): string {
  if (avg === null || avg === undefined) return "";
  return cur === "USD" ? avg.toFixed(2) : String(Math.round(avg));
}

export function qtyText(q: number | null | undefined): string {
  return q === null || q === undefined ? "" : String(q);
}

export function parseNum(s: string): number | null {
  const t = s.trim().replace(/,/g, "");
  return t ? Number(t) : null;
}

/** 바뀐 칸만 담은 수정 내용. 잘못된 값이면 error */
export function holdingPatch(
  initial: { quantity: string; avgPrice: string },
  now: { quantity: string; avgPrice: string },
): { quantity?: number | null; avgPrice?: number | null } | { error: string } {
  const out: { quantity?: number | null; avgPrice?: number | null } = {};
  if (now.quantity.trim() !== initial.quantity.trim()) out.quantity = parseNum(now.quantity);
  if (now.avgPrice.trim() !== initial.avgPrice.trim()) out.avgPrice = parseNum(now.avgPrice);
  for (const v of [out.quantity, out.avgPrice]) if (v !== undefined && v !== null && !(v > 0)) return { error: "수량과 평균 단가는 0보다 큰 숫자여야 합니다." };
  return out;
}
