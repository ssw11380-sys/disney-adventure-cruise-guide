import type { TradeRecordsHealth } from "@/api/types";

/** YYYY-MM-DD → 'M/D' */
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/**
 * 설정 > 서버 '매매 기록' 한 줄 (3-36, 플래그 tradeRecords — 읽기만, 서버가 쌓는 일별 계좌 스냅샷 상태).
 *  - 기록이 있으면 '9/28부터 3거래일 저장', 최근 5거래일에 스냅샷이 빠진 날이 있으면 뒤에 ' · 최근 5거래일 중 1일 빠짐'(한국·미국 같은 날은 하루로)
 *  - 아직 기록 전이면 토스 연동 여부에 따라 '첫 기록은 다음 장 마감 뒤' / '토스 연동 뒤 시작'
 *  - 서버가 값을 주지 않으면(예전 서버·서버 플래그 꺼짐·모양이 다름) null → 줄을 그리지 않는다
 */
export function tradeRecordsLabel(s: TradeRecordsHealth | null | undefined): string | null {
  if (!s || typeof s.days !== "number") return null;
  if (!s.since) return s.toss ? "첫 기록은 다음 장 마감 뒤" : "토스 연동 뒤 시작";
  const base = `${md(s.since)}부터 ${s.days}거래일 저장`;
  const missing = new Set((s.missing5 ?? []).map((m) => m.date)).size;
  return missing > 0 ? `${base} · 최근 5거래일 중 ${missing}일 빠짐` : base;
}
