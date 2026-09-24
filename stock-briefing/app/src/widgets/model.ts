import type { RegisteredWithQuote } from "@/api/types";

/**
 * 위젯 화면 규칙 (순수 함수, RN·위젯 모듈 의존 없음 → 단위 테스트).
 *  - 보유 여부는 수량·평단으로 판단한다. 시세를 못 받았다고 "관심"으로 내려가지 않는다 (위젯-3)
 *  - 시세를 못 받은 보유 종목은 마지막으로 받은 값으로 채우고, 그것도 없으면 합계에서 뺀 수를 알린다
 *  - 서버 조회가 통째로 실패하면 마지막 값을 그대로 두고 "갱신 실패"만 회색으로 (위젯-1)
 *  - "기준" 시각은 휴대폰이 받은 시각이 아니라 시세 시각, 오늘이 아니면 날짜까지 (위젯-8)
 */

export const WIDGET_COLORS = {
  ink: "#E8EAED",
  muted: "#7A828F",
  up: "#FF4B55",
  down: "#3D8EFF",
} as const;

export function tone(n: number): string {
  // 보합(0)은 앱과 같은 기본 글자색
  return n > 0 ? WIDGET_COLORS.up : n < 0 ? WIDGET_COLORS.down : WIDGET_COLORS.ink;
}

/** 보유 종목: 수량이 있고 평단이 있는 종목 (시세 유무와 무관) */
export function isHeld(s: Pick<RegisteredWithQuote, "quantity" | "avgPrice">): boolean {
  return s.quantity !== null && s.quantity > 0 && s.avgPrice !== null;
}

/** 이보다 오래된 마지막 값으로는 채우지 않는다 (긴 거래정지·장애 때 옛 값이 계속 남지 않게) */
export const FILL_MAX_AGE_MS = 7 * 86_400_000;

const kstDate = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * 이번에 시세를 못 받은 보유 종목을 마지막으로 받은 값으로 채운다.
 *  - 수량·평단이 그대로일 때만 (매매 뒤 옛 평가를 쓰지 않게), 시세 시각이 7일 이내일 때만
 *  - 시세가 오늘(한국 날짜) 것이 아니면 등락을 0 으로 둔다 → 지난 거래일 등락이 "오늘 손익"에 들어가지 않게
 */
export function fillFromLast(stocks: RegisteredWithQuote[], last: RegisteredWithQuote[] | null, now: number): { stocks: RegisteredWithQuote[]; filled: string[] } {
  if (!last?.length) return { stocks, filled: [] };
  const prev = new Map(last.map((s) => [s.code, s]));
  const filled: string[] = [];
  const out = stocks.map((s) => {
    if (s.quote || !isHeld(s)) return s;
    const p = prev.get(s.code);
    if (!p?.quote || !p.evaluation || p.quantity !== s.quantity || p.avgPrice !== s.avgPrice) return s;
    const at = Date.parse(p.quote.asOf);
    if (!Number.isFinite(at) || now - at > FILL_MAX_AGE_MS) return s;
    filled.push(s.code);
    const quote = kstDate(at) === kstDate(now) ? p.quote : { ...p.quote, change: 0, changeRate: 0 };
    return { ...s, quote, evaluation: p.evaluation };
  });
  return { stocks: out, filled };
}

/** 합계에서 빠진 보유 종목 수 (시세·평가가 끝내 없는 것) */
export function excludedCount(stocks: RegisteredWithQuote[]): number {
  return stocks.filter((s) => isHeld(s) && !(s.quote && s.evaluation)).length;
}

/** 위젯 목록 순서: 보유(원화 환산 평가금액 큰 순, 시세 없는 보유는 보유 맨 뒤) → 관심(이름 순) */
export function widgetOrder(stocks: RegisteredWithQuote[], fxOf: (s: RegisteredWithQuote) => number | null): RegisteredWithQuote[] {
  const krw = (s: RegisteredWithQuote) => {
    const v = s.evaluation?.marketValue;
    if (v === undefined) return Number.NEGATIVE_INFINITY;
    return (s.quote?.currency ?? "KRW") === "USD" ? v * (fxOf(s) ?? 1) : v;
  };
  const held = stocks.filter(isHeld).sort((a, b) => krw(b) - krw(a));
  const watch = stocks.filter((s) => !isHeld(s)).sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return [...held, ...watch];
}

/** 시세 기준 시각: 받은 시세 중 가장 늦은 asOf. 없으면 받은 시각 */
export function asOfMs(stocks: RegisteredWithQuote[], fetchedAt: number): number {
  let best = 0;
  for (const s of stocks) {
    const t = s.quote ? Date.parse(s.quote.asOf) : NaN;
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best > 0 ? best : fetchedAt;
}

/** "15:30 기준", 오늘(한국 날짜)이 아니면 "9/23 15:30 기준" */
export function asOfLabel(ms: number, now: number): string {
  const kst = (x: number) => new Date(x + 9 * 3_600_000);
  const d = kst(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  const today = d.toISOString().slice(0, 10) === kst(now).toISOString().slice(0, 10);
  return `${today ? hm : `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}`} 기준`;
}

/** 조회 실패 사유를 짧은 한국어로 (영어 오류 문구를 위젯에 그대로 보이지 않게) */
export function failureText(error: string | null): string | null {
  if (!error) return null;
  if (/HTTP 401|토큰/.test(error)) return "갱신 실패 · 토큰 확인";
  if (/abort|timeout|시간/i.test(error)) return "갱신 실패 · 응답 없음";
  if (/network|fetch|연결/i.test(error)) return "갱신 실패 · 연결 안 됨";
  if (/HTTP 5\d\d/.test(error)) return "갱신 실패 · 서버 오류";
  return "갱신 실패";
}

/** 자산 위젯 아랫줄: 오늘 손익과 총손익을 각자 부호 색으로 (위젯-2) */
export function assetLine(day: number, profit: number, fmt: (n: number) => string): { day: { text: string; color: string }; total: { text: string; color: string } } {
  return {
    day: { text: `오늘 ${fmt(day)}`, color: tone(day) },
    total: { text: `총 ${fmt(profit)}`, color: tone(profit) },
  };
}

/** 위젯·헤더를 누르면 잔고 탭으로 (마지막으로 보던 화면이 아니라) */
export const HOME_URI = "stockbriefing://";
