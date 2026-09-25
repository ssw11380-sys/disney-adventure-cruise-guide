/**
 * 보유 수정·종목 등록 화면 규칙 (순수 함수 → 단위 테스트).
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

export type HoldingPatch = { quantity?: number | null; avgPrice?: number | null } | { error: string };
const BAD_NUMBER = "수량과 평균 단가는 0보다 큰 숫자여야 합니다.";

/**
 * 종목 등록 양식의 수량·평단 (둘 다 선택). 잘못된 값이면 error.
 * noAvg: 수량만 있고 평단이 없음 → 평가손익을 낼 수 없어 계좌 합계에서 빠지므로, 등록 전에 알리고 고르게 한다 (BH-26)
 */
export function holdingInput(quantity: string, avgPrice: string): { quantity: number | null; avgPrice: number | null; noAvg: boolean } | { error: string } {
  const qty = parseNum(quantity);
  const avg = parseNum(avgPrice);
  if ((qty !== null && !(qty > 0)) || (avg !== null && !(avg > 0))) return { error: BAD_NUMBER };
  return { quantity: qty, avgPrice: avg, noAvg: qty !== null && avg === null };
}

/** 평단 없이 수량만 넣었을 때의 안내 (등록 확인 창) */
export const NO_AVG_NOTE = "평균 단가가 없으면 평가손익을 계산할 수 없어 총 평가금액·손익 합계에서 빠집니다. 보유 종목으로는 표시되며, 평균 단가는 나중에 종목 상세의 보유 정보 수정에서 넣을 수 있습니다.";

/** 바뀐 칸만 담은 수정 내용. 잘못된 값이면 error */
export function holdingPatch(
  initial: { quantity: string; avgPrice: string },
  now: { quantity: string; avgPrice: string },
): HoldingPatch {
  const out: { quantity?: number | null; avgPrice?: number | null } = {};
  if (now.quantity.trim() !== initial.quantity.trim()) out.quantity = parseNum(now.quantity);
  if (now.avgPrice.trim() !== initial.avgPrice.trim()) out.avgPrice = parseNum(now.avgPrice);
  for (const v of [out.quantity, out.avgPrice]) if (v !== undefined && v !== null && !(v > 0)) return { error: BAD_NUMBER };
  return out;
}

/**
 * 체결 반영 저장 내용 (BH-55). 계산한 거래 후 수량·평단을 서버 값(전체 자리)과 숫자로 비교해 바뀐 것만 보낸다.
 * 칸 글자(평단은 미국 소수 2자리·국내 정수로 줄여 보임)와 비교하면 새 평단이 같은 글자로 줄어들 때 평단이 빠져
 * 서버에 예전 평단이 남는다 (예: $0.0537 1,000주 + $0.0463 1,000주 → 새 평단 0.05 가 칸의 "0.05" 와 같아 수량만 저장).
 * 수량 0(전부 매도)이면 수량·평단을 비운다. 숫자가 아니면(위 칸에 잘못 넣음) 보유를 지우지 않고 error
 */
export function tradePatch(
  server: { quantity: number | null; avgPrice: number | null },
  next: { quantity: number; avgPrice: number | null },
): HoldingPatch {
  const quantity = next.quantity === 0 ? null : next.quantity;
  const avgPrice = quantity === null ? null : next.avgPrice;
  for (const v of [quantity, avgPrice]) if (v !== null && !(v > 0 && Number.isFinite(v))) return { error: BAD_NUMBER };
  const out: { quantity?: number | null; avgPrice?: number | null } = {};
  if (quantity !== server.quantity) out.quantity = quantity;
  if (avgPrice !== server.avgPrice) out.avgPrice = avgPrice;
  return out;
}

/**
 * 서버 값에서 시작한 입력 칸 하나의 초안 (PF-07). base = 초안이 기준으로 삼은 서버 값.
 * stale = 고치는 사이 그 칸의 서버 값이 바뀜 → 저장하면 새 서버 값을 덮어쓰므로 화면에서 알린다
 */
export interface Draft {
  base: string;
  value: string;
  stale: boolean;
}

/** 같은 값인지 볼 때의 모양: 숫자 칸은 쉼표·단위를 뺀 숫자("1,350,000" = "1350000"), 메모는 앞뒤 공백 제외 (저장할 때와 같게) */
export type Norm = (s: string) => string;
export const normNum: Norm = (s) => {
  const t = s.replace(/[^0-9.]/g, "");
  return t ? String(Number(t)) : "";
};
export const normText: Norm = (s) => s.trim();

export function draftOf(server: string): Draft {
  return { base: server, value: server, stale: false };
}

/** 같은 종목의 서버 값이 바뀌면(토스 체결 동기화 등) 손대지 않은 칸만 새 값으로, 고치던 칸은 그대로. 바뀐 게 없으면 같은 객체 */
export function rebaseDraft(d: Draft, server: string, norm: Norm = (s) => s): Draft {
  if (d.base === server) return d;
  const v = norm(d.value);
  // 손대지 않았거나, 입력이 새 서버 값과 같다(방금 저장한 값을 다시 받음) → 서버 값으로
  if (v === norm(d.base) || v === norm(server)) return draftOf(server);
  return { base: server, value: d.value, stale: true };
}

/** 사용자가 칸을 고침. 서버 값과 같게 되돌리면 안내도 거둔다 */
export function editDraft(d: Draft, value: string, norm: Norm = (s) => s): Draft {
  return { ...d, value, stale: d.stale && norm(value) !== norm(d.base) };
}
