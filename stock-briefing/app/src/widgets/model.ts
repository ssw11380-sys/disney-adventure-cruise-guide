import type { RegisteredWithQuote } from "@/api/types";

/**
 * 위젯 화면 규칙 (순수 함수, RN·위젯 모듈 의존 없음 → 단위 테스트).
 *  - 보유 여부는 수량·평단으로 판단한다. 시세를 못 받았다고 "관심"으로 내려가지 않는다 (위젯-3)
 *  - 시세를 못 받은 보유 종목은 마지막으로 받은 값으로 채우고, 그것도 없으면 합계에서 뺀 수를 알린다
 *  - 서버 조회가 통째로 실패하면 마지막 값을 그대로 두고 "갱신 실패"만 회색으로 (위젯-1)
 *  - "기준" 시각은 휴대폰이 받은 시각이 아니라 시세 시각, 오늘이 아니면 날짜까지 (위젯-8)
 */

import { sentence, speakAmount, speakProfit, speakRate } from "@/lib/a11y";
import { formatIndexValue, formatPct } from "@/lib/format";
import { isKrCode, marketClock, marketDate, tradingDate } from "@/lib/marketTime";
import { WIDGET_COLORS, type WidgetPalette } from "./palette";
import { WIDGET_INDEX_CODES, type WidgetBrief, type WidgetMarket } from "./payload";

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

/**
 * 이번에 시세를 못 받은 보유 종목을 마지막으로 받은 값으로 채운다.
 *  - 수량·평단이 그대로일 때만 (매매 뒤 옛 평가를 쓰지 않게), 시세 시각이 7일 이내일 때만
 *  - 시세가 지금과 같은 거래일 것이 아니면 등락을 0 으로 둔다 → 지난 거래일 등락이 "오늘 손익"에 들어가지 않게.
 *    거래일은 종목 시장 기준(lib/marketTime tradingDate — 한국은 서울 08:00, 미국은 뉴욕 20:00 에 바뀜).
 *    예전에는 모든 종목을 한국 날짜로 봐서, 한국 자정이 지나면 같은 뉴욕 정규장인데도 미국 종목 등락이 0 이 됐다 (BH-40)
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
    const sameDay = tradingDate(p.quote.asOf, s.code) === tradingDate(new Date(now).toISOString(), s.code);
    const quote = sameDay ? p.quote : { ...p.quote, change: 0, changeRate: 0 };
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

/** dayLabel: 당일 손익 이름 (다듬은 잔고 위젯은 종목 줄의 "오늘"과 같은 말) */
export function pnlLine(mode: PnlMode, t: { value: number; profit: number; day: number }, money: (n: number) => string, pct: (n: number) => string, dayLabel = "당일"): PnlLine {
  const label = mode === "day" ? dayLabel : "누적";
  const value = mode === "day" ? t.day : t.profit;
  const r = mode === "day" ? dayRate(t.value, t.day) : cumulativeRate(t.value, t.profit);
  const valueText = money(value);
  const amount = `${label} ${valueText}`;
  const rate = r === null ? null : `(${pct(r)})`;
  return { mode, label, amount, rate, text: rate ? `${amount} ${rate}` : amount, valueText, sign: value, value, rateValue: r };
}

/**
 * 손익 전환 칸을 화면 읽기가 읽는 문장: 지금 무엇을 보여 주는지와 누르면 무엇으로 바뀌는지.
 * polish(다듬은 잔고 위젯): 끝을 "눌러서 당일 손익 보기"처럼 무엇을 하는 칸인지로
 */
export function pnlSpeech(p: PnlLine, toggle: boolean, polish = false): string {
  // 0 원이면 speakProfit 이 "손익 없음"이라 "당일 손익 손익 없음"이 되지 않게 "당일 손익 없음"
  const spoken = p.sign === 0 ? null : speakProfit(p.valueText, p.sign);
  const parts = [spoken ? `${p.label} 손익 ${spoken}` : `${p.label} 손익 없음`, p.rateValue === null ? null : `수익률 ${speakRate(p.rateValue)}`];
  const other = p.mode === "day" ? "누적" : "당일";
  if (toggle) parts.push(polish ? `눌러서 ${other} 손익 보기` : `누르면 ${other} 손익으로 바뀝니다`);
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
  /** 출처 조회가 실패해 마지막 값 (흐리게 + "지연"). 다듬은 모습은 지난 세션 값도 흐리게 */
  stale: boolean;
  /** 화면 읽기용 이름 ("원/달러" 그대로) */
  name: string;
  /** 흐린 값 뒤 글자 (다듬은 모습만): 지난 세션 값이면 그 날짜 "9/23", 출처 지연이면 "지연". 없으면(예전 모습) stale 일 때 "지연" */
  tag?: string | null;
  /** tag 를 화면 읽기가 읽는 말 ("9월 23일 값" · "시세 지연") */
  tagSpeech?: string | null;
  /** 다듬은 모습: 좁을 때 남기는 순서 · 값을 뺄 수 있음 · 값을 뺀 모양 (layout IndexInput) */
  keep?: number;
  canShort?: boolean;
  short?: boolean;
}

/** 위젯 한 줄에 맞춘 짧은 이름 (없는 코드는 서버 이름 그대로) */
export const INDEX_LABEL: Record<string, string> = { KOSPI: "코스피", NASDAQ: "나스닥", USDKRW: "환율" };

const isFx = (code: string) => /KRW$/.test(code);

/**
 * 받은 순서 그대로 (서버가 코스피·나스닥·원/달러 순으로 준다). 값·등락률 표기는 앱 지수 띠와 같은 함수.
 * 예전 모습의 세 항목만 (앱 지수 띠가 다듬은 모습용 다섯 개를 넘겨도 예전 줄 그대로)
 */
export function indexItems(list: readonly WidgetIndexLike[] | null | undefined): IndexItemText[] {
  return (list ?? [])
    .filter((i) => Number.isFinite(i.value) && (WIDGET_INDEX_CODES as readonly string[]).includes(i.code))
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

/** 지수 줄을 화면 읽기가 읽는 문장: "코스피 3,412.35 0.90% 상승, 나스닥 …, 원/달러 1,360.50" (다듬은 모습은 지난 세션 값에 "9월 23일 값") */
export function indexSpeech(items: readonly IndexItemText[]): string {
  // 값을 뺀 짧은 모양(다듬은 모습의 좁은 줄)은 보이는 대로 이름·등락률만
  return items.map((i) => [i.name, i.short ? null : i.value, i.rate ? speakRate(i.changeRate) : null, i.tagSpeech !== undefined ? i.tagSpeech : i.stale ? "시세 지연" : null].filter(Boolean).join(" ")).join(", ");
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

// ── 브리핑 위젯 안내 (BH-68) ──────────────────────────────────────────

/**
 * 보여 줄 브리핑이 없을 때 안내 문구. 조회 실패 → 다시 시도, 최신 브리핑이 실패함 → 실패를 알림(예전: "아직 없음"으로 숨김),
 * 아니면 서버 알림 설정의 브리핑 시간(예전: 늘 "평일 08:30·16:00"). 시간을 모르면(예전 서버) 시간을 지어내지 않는다
 */
export function briefingEmptyText(error: string | null, brief: WidgetBrief | null | undefined): string {
  if (error) return `${failureText(error)} · ↻ 로 다시 시도`;
  if (!brief) return "아직 브리핑이 없습니다. 설정한 브리핑 시간에 생성됩니다.";
  if (brief.failed > 0) return `브리핑 생성 실패 ${brief.failed}종목. 앱의 브리핑 탭에서 확인해 주세요.`;
  const times = [brief.morning, brief.afternoon].filter((x): x is string => !!x);
  if (!times.length) return "아직 브리핑이 없습니다. 자동 생성이 꺼져 있습니다.";
  return `아직 브리핑이 없습니다. ${brief.weekdaysOnly ? "평일" : "매일"} ${times.join("·")} 에 생성됩니다.`;
}

// ── 다듬은 잔고 위젯 (widgetPolish) ────────────────────────────────────

/** 당일 손익 이름: 종목 줄의 "오늘 +1.2%"와 합계 옆 손익이 같은 말 */
export const DAY_LABEL = "오늘";

/** 보유 종목이 속한 시장 (시세 통화가 없으면 코드로) */
const marketOf = (s: Pick<RegisteredWithQuote, "code" | "quote">): "KR" | "US" => (s.quote?.currency ? (s.quote.currency === "USD" ? "US" : "KR") : isKrCode(s.code) ? "KR" : "US");

/**
 * 머리 제목 후보 (긴 것부터): "보유 17 · 관심 1" → 좁으면 "보유 17". 관심이 없으면 "보유 17", 보유가 없으면 "관심 3".
 * 보유는 isHeld (수량·평단) — 시세를 못 받았다고 관심으로 내려가지 않는다
 */
export function holdingsTitles(stocks: readonly Pick<RegisteredWithQuote, "quantity" | "avgPrice">[]): { titles: string[]; speech: string } {
  const held = stocks.filter(isHeld).length;
  const watch = stocks.length - held;
  if (!watch) return { titles: [`보유 ${held}`], speech: `보유 ${held}종목` };
  if (!held) return { titles: [`관심 ${watch}`], speech: `관심 ${watch}종목` };
  return { titles: [`보유 ${held} · 관심 ${watch}`, `보유 ${held}`], speech: `보유 ${held}종목, 관심 ${watch}종목` };
}

/** 시장별 보유 평가금액 (원화 환산, 환율을 모르는 미국 종목은 1달러 = 1원으로 보지 않고 뺀다). 칩·지수 줄 순서를 고른다 */
export function accountMix(stocks: RegisteredWithQuote[], fxOf: (s: RegisteredWithQuote) => number | null): { kr: number; us: number } {
  const mix = { kr: 0, us: 0 };
  for (const s of stocks) {
    const v = s.evaluation?.marketValue;
    if (!isHeld(s) || v === undefined || !Number.isFinite(v)) continue;
    if (marketOf(s) === "KR") mix.kr += v;
    else {
      const fx = fxOf(s);
      if (fx) mix.us += v * fx;
    }
  }
  return mix;
}

/** 칩 글자 한 가지와 그 색 (open: 금색) */
export interface ChipText {
  text: string;
  open: boolean;
}

/**
 * 장 상태 칩 글자 후보 (긴 것부터): 보유 시장의 지금 세션을 원화 보유액이 큰 시장부터 "미국 주간거래 · 한국 휴장" → 좁으면 앞 시장만 "미국 주간거래".
 * 시장별 문구(market.markets)가 없으면(예전 서버·세션 모름) 예전 칩 한 개. 보유 종목이 없으면(관심만) 등록 종목의 시장 모두.
 * 색은 보이는 글자의 시장으로: 그중 토스 달력으로 열린 시장("한국 장중"·"미국 장중")이 있을 때만 금색 — 장중은 금색, 그 밖은 회색.
 * market.open 은 보유하지 않은 시장의 달력도 보므로(한국만 보유한 23:00 에 미국 정규장이 열려 있음) 쓰지 않는다 (검증 지적: '한국 장 마감'이 금색)
 */
export function chipTexts(market: WidgetMarket | null, stocks: readonly RegisteredWithQuote[], usFirst: boolean): ChipText[] {
  if (!market) return [];
  const held = new Set(stocks.filter(isHeld).map(marketOf));
  const parts = (market.markets ?? []).filter((m) => !held.size || held.has(m.market));
  if (!parts.length) return [{ text: market.label, open: market.open }];
  const rank = (m: "KR" | "US") => (m === "US" ? (usFirst ? 0 : 1) : usFirst ? 1 : 0);
  const sorted = [...parts].sort((a, b) => rank(a.market) - rank(b.market));
  const calOpen = (m: "KR" | "US") => (m === "KR" ? market.kr : market.us) === true;
  const all: ChipText = { text: sorted.map((p) => p.label).join(" · "), open: sorted.some((p) => calOpen(p.market)) };
  const first: ChipText = { text: sorted[0]!.label, open: calOpen(sorted[0]!.market) };
  return sorted.length > 1 ? [all, first] : [all];
}

/** 다듬은 지수 줄 이름 (환율은 무엇의 환율인지 보이게 "원/달러") */
export const LINE_LABEL: Record<string, string> = { KOSPI: "코스피", KOSDAQ: "코스닥", NASDAQ: "나스닥", SPX: "S&P500", USDKRW: "원/달러" };
/** 계좌 비중 순서: 미국 보유가 크면 미국 지수부터. 환율은 늘 끝 */
const LINE_ORDER = { kr: ["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "USDKRW"], us: ["NASDAQ", "SPX", "KOSPI", "KOSDAQ", "USDKRW"] } as const;
/**
 * LINE_ORDER 자리별로 좁을 때 남기는 순서 (layout planPolishedIndex, 작을수록 오래 남는다):
 * 첫 시장 대표 지수 → 원/달러 → 둘째 시장 대표 지수 → 첫 시장 둘째 지수 → 둘째 시장 둘째 지수. 시장마다 하나와 원/달러가 끝까지 남는다
 */
const LINE_KEEP = [0, 3, 2, 4, 1] as const;
/** 거래일 규칙을 고르는 대표 코드 (lib/marketTime 은 종목 코드로 한국·미국을 가린다). 원/달러는 서울 */
const KR_REF = "005930";
const US_REF = "AAPL";
/** 정규장이 열리는 현지 시각(분): 한국 09:00, 미국 09:30 */
const OPEN_MIN = { kr: 9 * 60, us: 9 * 60 + 30 } as const;

/** 지금까지 열린 가장 최근 정규장의 날짜 (시장 현지). 오늘 장이 아직 안 열렸으면 전 거래일 (주말·미국 휴장일은 건너뛴다) */
export function lastOpenedSession(now: number, ref: string): string | null {
  const clock = marketClock(new Date(now).toISOString(), ref);
  if (!clock) return null;
  const minutes = Number(clock.local.slice(11, 13)) * 60 + Number(clock.local.slice(14, 16));
  let date = clock.local.slice(0, 10);
  if (minutes < (isKrCode(ref) ? OPEN_MIN.kr : OPEN_MIN.us)) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    date = d.toISOString().slice(0, 10);
  }
  // 그 날 낮 12시(한국 08:00 뒤·뉴욕 20:00 전이라 날짜가 그대로)의 거래일 = 주말·휴장일이면 직전 거래일
  return tradingDate(`${date}T12:00:00${clock.offset}`, ref);
}

/**
 * 다듬은 지수 줄 항목: 계좌 비중 순서(미국 보유가 크면 나스닥·S&P500 먼저, 아니면 코스피·코스닥 먼저, 원/달러는 끝), 환율도 등락률.
 * 지금 세션 값이 아닌 것(가장 최근 열린 정규장보다 앞선 날의 값 — 예: 추석 휴장 중 9/23 코스피)은 흐리게 + 그 날짜,
 * 출처 조회가 실패한 값은 흐리게 + "지연". 좁으면 layout planPolishedIndex 가 keep 순서로 빼고 지수는 값을 빼(canShort) 시장마다 하나와 원/달러를 남긴다
 */
export function polishedIndexItems(list: readonly (WidgetIndexLike & { asOf?: string | null })[] | null | undefined, now: number, usFirst: boolean): IndexItemText[] {
  const byCode = new Map((list ?? []).filter((i) => Number.isFinite(i.value)).map((i) => [i.code, i]));
  return LINE_ORDER[usFirst ? "us" : "kr"].flatMap((code, pos) => {
    const i = byCode.get(code);
    if (!i) return [];
    const ref = code === "NASDAQ" || code === "SPX" ? US_REF : KR_REF;
    const valueDate = i.asOf ? marketDate(i.asOf, ref) : null;
    const opened = lastOpenedSession(now, ref);
    const past = !!valueDate && !!opened && valueDate < opened;
    const [, m, d] = (valueDate ?? "").split("-");
    const tag = past ? `${Number(m)}/${Number(d)}` : i.stale ? "지연" : null;
    return [
      {
        code,
        label: LINE_LABEL[code] ?? i.name,
        value: formatIndexValue(i.value),
        rate: formatPct(i.changeRate),
        change: i.change,
        changeRate: i.changeRate,
        stale: past || i.stale === true,
        name: i.name,
        tag,
        tagSpeech: past ? `${Number(m)}월 ${Number(d)}일 값` : i.stale ? "시세 지연" : null,
        keep: LINE_KEEP[pos],
        canShort: !isFx(code),
      },
    ];
  });
}

/** 잔고 한 줄을 화면 읽기가 읽는 문장 (다듬은 모습): "삼성전자 72,000원, 오늘 1.50% 상승, 수익 2.86% 상승". 시세가 없으면 "삼성전자 시세 없음" */
export function polishedRowSpeech(name: string, price: string | null, changeRate: number | null | undefined, profitRate: number | null | undefined): string {
  if (!price || price === "-") return `${name} 시세 없음`;
  const today = speakRate(changeRate);
  const profit = speakRate(profitRate);
  return sentence([`${name} ${speakAmount(price)}`, today ? `오늘 ${today}` : null, profit ? `수익 ${profit}` : null]);
}
