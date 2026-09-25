/** 한국 시간(Asia/Seoul) 관련 헬퍼. 서버의 TZ 설정과 무관하게 동작한다. */

const SEOUL = "Asia/Seoul";

function parts(date: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: SEOUL,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** YYYY-MM-DD (한국 기준 날짜) */
export function seoulDate(date: Date = new Date()): string {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * 시각 문자열(오프셋 무관: Z, +09:00 …)의 한국 날짜 YYYY-MM-DD. 못 읽으면 앞 10글자 그대로.
 * 구글 RSS·네이버 검색 뉴스는 Z(UTC) 로 와서 앞 10글자만 자르면 한국 00:00~08:59 기사가 전날이 된다
 */
export function seoulDateOf(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso.slice(0, 10) : seoulDate(new Date(t));
}

/** YYYYMMDD (KIS API 등 날짜 파라미터용) */
export function seoulDateCompact(date: Date = new Date()): string {
  return seoulDate(date).replace(/-/g, "");
}

/** ISO 8601 + 한국 오프셋 (예: 2026-09-22T08:30:00+09:00) */
export function seoulIso(date: Date = new Date()): string {
  const p = parts(date);
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}+09:00`;
}

/** n일 전 날짜를 YYYYMMDD 로 */
export function seoulDateCompactDaysAgo(days: number, from: Date = new Date()): string {
  return seoulDateCompact(new Date(from.getTime() - days * 86_400_000));
}
