import type { RegisteredWithQuote } from "@/api/types";

/**
 * 위젯 화면 규칙 (순수 함수, RN·위젯 모듈 의존 없음 → 단위 테스트).
 *  - 보유 여부는 수량·평단으로 판단한다. 시세를 못 받았다고 "관심"으로 내려가지 않는다 (위젯-3)
 *  - 시세를 못 받은 보유 종목은 마지막으로 받은 값으로 채우고, 그것도 없으면 합계에서 뺀 수를 알린다
 *  - 서버 조회가 통째로 실패하면 마지막 값을 그대로 두고 "갱신 실패"만 회색으로 (위젯-1)
 *  - "기준" 시각은 휴대폰이 받은 시각이 아니라 시세 시각, 오늘이 아니면 날짜까지 (위젯-8)
 */

import { speakAmount, speakProfit, speakRate } from "@/lib/a11y";
import { formatIndexValue, formatPct } from "@/lib/format";
import { WIDGET_COLORS, type WidgetPalette } from "./palette";

export { WIDGET_COLORS };

/** 등락 색 (팔레트를 주지 않으면 다크) */
export function tone(n: number, c: WidgetPalette = WIDGET_COLORS): `#${string}` {
  // 보합(0)은 앱과 같은 기본 글자색
  return n > 0 ? c.up : n < 0 ? c.down : c.ink;
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

/**
 * 누적 수익률(%) = 누적 손익 ÷ 매입금액. 매입금액은 평가금액 − 누적 손익 (토스 "내 투자"와 같은 기준, 비용 차감 설정도 합계와 같게 따른다).
 * 매입금액이 0 이하면 수익률을 낼 수 없어 null
 */
export function cumulativeRate(value: number, profit: number): number | null {
  const cost = value - profit;
  return cost > 0 ? (profit / cost) * 100 : null;
}

/** 잔고 위젯 합계 옆 한 줄: "누적 -5,901,231원 (-7.48%)" — 누적 손익 부호 색 */
export function cumulativeLine(value: number, profit: number, money: (n: number) => string, pct: (n: number) => string): { text: string; color: string } {
  const r = cumulativeRate(value, profit);
  return { text: `누적 ${money(profit)}${r === null ? "" : ` (${pct(r)})`}`, color: tone(profit) };
}

/**
 * 당일 수익률(%) = 당일 손익 ÷ 전일 평가금액(평가금액 − 당일 손익). 앱 잔고 요약의 "오늘" 수익률과 같은 기준.
 * 전일 평가금액이 0 이하면 수익률을 낼 수 없어 null (cumulativeRate 와 같은 규칙)
 */
export function dayRate(value: number, day: number): number | null {
  const base = value - day;
  return base > 0 ? (day / base) * 100 : null;
}

/** 잔고 위젯 합계 옆 손익: 누적(기본) 또는 당일 — 손익 전환 플래그(widgetPnlToggle)가 켜져 있을 때만 당일로 바꿀 수 있다 */
export type PnlMode = "cumulative" | "day";

export interface PnlLine {
  mode: PnlMode;
  /** "누적" · "당일" */
  label: string;
  /** "누적 -5,901,231원" */
  amount: string;
  /** "(-7.48%)" — 수익률을 낼 수 없으면 null */
  rate: string | null;
  /** 한 줄: "누적 -5,901,231원 (-7.48%)" */
  text: string;
  /** 금액만: "-5,901,231원" */
  valueText: string;
  /** 부호 (색·읽기용) */
  sign: number;
  /** 읽기용 원 숫자 */
  value: number;
  rateValue: number | null;
}

export function pnlLine(mode: PnlMode, t: { value: number; profit: number; day: number }, money: (n: number) => string, pct: (n: number) => string): PnlLine {
  const label = mode === "day" ? "당일" : "누적";
  const value = mode === "day" ? t.day : t.profit;
  const r = mode === "day" ? dayRate(t.value, t.day) : cumulativeRate(t.value, t.profit);
  const valueText = money(value);
  const amount = `${label} ${valueText}`;
  const rate = r === null ? null : `(${pct(r)})`;
  return { mode, label, amount, rate, text: rate ? `${amount} ${rate}` : amount, valueText, sign: value, value, rateValue: r };
}

/** 손익 전환 칸을 화면 읽기가 읽는 문장: 지금 무엇을 보여 주는지와 누르면 무엇으로 바뀌는지 */
export function pnlSpeech(p: PnlLine, toggle: boolean): string {
  const parts = [`${p.label} 손익 ${speakProfit(p.valueText, p.sign) ?? "없음"}`, p.rateValue === null ? null : `수익률 ${speakRate(p.rateValue)}`];
  if (toggle) parts.push(`누르면 ${p.mode === "day" ? "누적" : "당일"} 손익으로 바뀝니다`);
  return parts.filter(Boolean).join(", ");
}

/** 잔고 한 줄을 화면 읽기가 읽는 문장 (3-23): "삼성전자 72,000원 1.50% 상승". 시세가 없으면 "삼성전자 시세 없음" */
export function rowSpeech(name: string, price: string | null, changeRate: number | null | undefined): string {
  if (!price || price === "-") return `${name} 시세 없음`;
  return [name, speakAmount(price), speakRate(changeRate)].filter(Boolean).join(" ");
}

/** 지수 줄 한 항목 (서버 /api/widget 의 indices 한 줄을 화면 글자로) */
export interface WidgetIndexLike {
  code: string;
  name: string;
  value: number;
  change: number;
  changeRate: number;
  stale?: boolean;
}

export interface IndexItemText {
  code: string;
  /** "코스피" · "나스닥" · "환율" */
  label: string;
  /** 앱 지수 띠와 같은 표기 (formatIndexValue) */
  value: string;
  /** "+0.90%" — 환율은 값만 */
  rate: string | null;
  change: number;
  changeRate: number;
  /** 출처 조회가 실패해 마지막 값 (흐리게 + "지연") */
  stale: boolean;
  /** 화면 읽기용 이름 ("원/달러" 그대로) */
  name: string;
}

/** 위젯 한 줄에 맞춘 짧은 이름 (없는 코드는 서버 이름 그대로) */
export const INDEX_LABEL: Record<string, string> = { KOSPI: "코스피", NASDAQ: "나스닥", USDKRW: "환율" };

const isFx = (code: string) => /KRW$/.test(code);

/** 받은 순서 그대로 (서버가 코스피·나스닥·원/달러 순으로 준다). 값·등락률 표기는 앱 지수 띠와 같은 함수 */
export function indexItems(list: readonly WidgetIndexLike[] | null | undefined): IndexItemText[] {
  return (list ?? [])
    .filter((i) => Number.isFinite(i.value))
    .map((i) => ({
      code: i.code,
      label: INDEX_LABEL[i.code] ?? i.name,
      value: formatIndexValue(i.value),
      rate: isFx(i.code) ? null : formatPct(i.changeRate),
      change: i.change,
      changeRate: i.changeRate,
      stale: i.stale === true,
      name: i.name,
    }));
}

/** 지수 줄을 화면 읽기가 읽는 문장: "코스피 3,412.35 0.90% 상승, 나스닥 …, 원/달러 1,360.50" */
export function indexSpeech(items: readonly IndexItemText[]): string {
  return items.map((i) => [i.name, i.value, i.rate ? speakRate(i.changeRate) : null, i.stale ? "시세 지연" : null].filter(Boolean).join(" ")).join(", ");
}

/** 기준 시각 글자를 긴 것부터: "9/23 15:30 기준" → "9/23 15:30" → "15:30" (칸이 좁으면 뒤의 것으로) */
export function asOfVariants(ms: number, now: number): string[] {
  const full = asOfLabel(ms, now);
  const bare = full.replace(/ 기준$/, "");
  const time = bare.split(" ").pop() ?? bare;
  return [...new Set([full, bare, time])];
}

/** 위젯·헤더를 누르면 잔고 탭으로 (마지막으로 보던 화면이 아니라) */
export const HOME_URI = "stockbriefing://";
