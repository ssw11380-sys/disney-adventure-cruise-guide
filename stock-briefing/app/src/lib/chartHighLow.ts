import type { Candle, CandlePeriod, ChartUnit } from "@/api/types";
import { speakAmount, speakClock } from "./a11y";
import { LABEL_PAD, textWidth, type Box } from "./chartBasis";
import { formatChartValue } from "./chartLayout";

/**
 * 차트 최고·최저가 표시 (3-46, 기능 플래그 chartHighLow + 설정 '차트 최고·최저가 표시') — React Native 를 불러오지 않는 순수 모듈.
 * 사용자 요청: 토스 NAVER 일봉 캡처처럼 보이는 구간의 가장 높은 고가에 빨간 ↓ 와 '255,000원 (-22.3%, 26.07.27)',
 * 가장 낮은 저가에 파란 ↑ 와 '181,100원 (+9.3%, 26.07.14)' (% = 현재가가 그 값보다 몇 % 높은지·낮은지).
 * PriceChart 가 보이는 봉(드래그·확대 뒤)으로 그릴 때마다 부른다 — 봉 path 를 만드는 것보다 가볍다 (드래그 한 걸음 +0.03ms 실측)
 */

type Bar = Pick<Candle, "date" | "time" | "high" | "low" | "close">;

// ── 1) 보이는 구간의 최고·최저 ──

export type HighLowMode = "candle" | "line";
export interface Extreme {
  /** 보이는 봉 안의 순서 (0 = 맨 왼쪽) */
  index: number;
  value: number;
}
export interface Extremes {
  high: Extreme;
  low: Extreme;
}

/**
 * 봉 모드: 가장 높은 고가·가장 낮은 저가, 선 모드: 종가의 최고·최저. 같은 값이 여럿이면 가장 최근(오른쪽) 봉.
 * 값이 있는 봉이 2개 미만이거나 최고 = 최저(한 줄로 평평)면 null — 표시하지 않는다
 */
export function visibleExtremes(bars: readonly Bar[], mode: HighLowMode = "candle"): Extremes | null {
  let hi: Extreme | null = null;
  let lo: Extreme | null = null;
  let count = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const h = mode === "line" ? b.close : b.high;
    const l = mode === "line" ? b.close : b.low;
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    count++;
    if (!hi || h >= hi.value) hi = { index: i, value: h };
    if (!lo || l <= lo.value) lo = { index: i, value: l };
  }
  if (count < 2 || !hi || !lo || !(hi.value > lo.value)) return null;
  return { high: hi, low: lo };
}

// ── 2) 글자 ──

/**
 * 현재가가 그 값보다 몇 % 높은지·낮은지: (현재가 − 값) / 값 × 100, 소수 한 자리에서 버림(0 쪽으로 — 토스 캡처 198,000 vs 255,000 = −22.35… → '-22.3%').
 * 보이는 값이 0.0 이면 부호 없이 '0.0%' (BH-38). 현재가·값을 모르면 null (괄호 안에서 뺀다)
 */
export function pctFromCurrent(current: number | null | undefined, value: number): string | null {
  if (current === null || current === undefined || !Number.isFinite(current) || current <= 0 || !Number.isFinite(value) || value <= 0) return null;
  const p = ((current - value) / value) * 100;
  // 1e-7: 12.3 이 12.299999… 로 계산돼 12.2 로 떨어지지 않게
  const a = Math.trunc(Math.abs(p) * 10 + 1e-7) / 10;
  const body = `${a >= 1000 ? a.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : a.toFixed(1)}%`;
  if (!/[1-9]/.test(body)) return body;
  return `${p > 0 ? "+" : "-"}${body}`;
}

/**
 * 화면 날짜: 일·주봉 'YY.MM.DD'(주봉은 x축과 같은 봉 날짜), 월봉 'YY.MM'(봉 날짜는 그 달의 한 날일 뿐 최고가가 난 날이 아니다),
 * 분봉 'HH:mm'(x축과 같은 봉 시각), 보이는 구간이 여러 날이면 'MM.DD HH:mm'. 분봉 여부는 봉에 time 이 있는지로 (x축 labelOf 와 같은 기준)
 */
export function extremeDate(bar: Pick<Candle, "date" | "time">, period: CandlePeriod, spansDays: boolean): string {
  const y = bar.date.slice(2, 4), m = bar.date.slice(5, 7), d = bar.date.slice(8, 10);
  if (bar.time && bar.time.length >= 16) {
    const hm = bar.time.slice(11, 16);
    return spansDays ? `${m}.${d} ${hm}` : hm;
  }
  if (period === "M") return `${y}.${m}`;
  return `${y}.${m}.${d}`;
}

/** 읽는 날짜: '7월 27일' (구간이 해를 넘으면 '2025년 7월 27일'), 주봉 '7월 27일 주', 월봉 '2026년 7월', 분봉 '14시 30분' (여러 날이면 '9월 25일 14시 30분') */
export function extremeDateSpeech(bar: Pick<Candle, "date" | "time">, period: CandlePeriod, o: { spansDays: boolean; spansYears: boolean }): string {
  const y = Number(bar.date.slice(0, 4)), m = Number(bar.date.slice(5, 7)), d = Number(bar.date.slice(8, 10));
  if (bar.time && bar.time.length >= 16) {
    const clock = speakClock(bar.time.slice(11, 16));
    return o.spansDays ? `${m}월 ${d}일 ${clock}` : clock;
  }
  if (period === "M") return `${y}년 ${m}월`;
  const day = `${o.spansYears ? `${y}년 ` : ""}${m}월 ${d}일`;
  return period === "W" ? `${day} 주` : day;
}

export interface HighLowTexts {
  high: string;
  low: string;
  /** 차트 그림의 화면 읽기 문장 */
  speech: string;
}

/**
 * '255,000원 (-22.3%, 26.07.27)' · '181,100원 (+9.3%, 26.07.14)' 와 화면 읽기 문장
 * '보이는 구간 최고 255,000원 7월 27일, 최저 181,100원 7월 14일. 현재가는 최고보다 22.3% 낮음, 최저보다 9.3% 높음'.
 * 뒤 문장은 화면의 %를 말로 (부호 대신 '낮음·높음' — 사실 비교만, 투자 권유로 읽힐 말 없음). 지수·환율(PT)은 '현재 값은', 현재가를 모르면 뒤 문장 없음
 */
export function highLowTexts(bars: readonly Bar[], ex: Extremes, o: { unit: ChartUnit; period: CandlePeriod; current: number | null | undefined }): HighLowTexts {
  const first = bars[0]!, last = bars[bars.length - 1]!;
  const spansDays = first.date !== last.date;
  const spansYears = first.date.slice(0, 4) !== last.date.slice(0, 4);
  const one = (e: Extreme) => {
    const bar = bars[e.index]!;
    const price = formatChartValue(e.value, o.unit);
    const pct = pctFromCurrent(o.current, e.value);
    return {
      text: `${price} (${pct ? `${pct}, ` : ""}${extremeDate(bar, o.period, spansDays)})`,
      said: `${speakAmount(price)} ${extremeDateSpeech(bar, o.period, { spansDays, spansYears })}`,
      pct,
    };
  };
  const h = one(ex.high), l = one(ex.low);
  const cmp = (pct: string | null, word: string) =>
    pct === null ? null : !/[1-9]/.test(pct) ? `${word}와 같음` : `${word}보다 ${pct.replace(/^[+-]/, "")} ${pct.startsWith("-") ? "낮음" : "높음"}`;
  const hc = cmp(h.pct, "최고"), lc = cmp(l.pct, "최저");
  const tail = hc && lc ? `. ${o.unit === "PT" ? "현재 값은" : "현재가는"} ${hc}, ${lc}` : "";
  return { high: h.text, low: l.text, speech: `보이는 구간 최고 ${h.said}, 최저 ${l.said}${tail}` };
}

// ── 3) 자리 ──

/** 세로 치수 (dp). 글자 상자 높이는 그림 안 글자(chartBasis 의 기준선 위 10 · 아래 3)와 같다 */
export const HL = {
  /** 꼬리 끝(고가·저가) ↔ 화살촉 끝 */
  ARROW_GAP: 2,
  /** 화살표 대 길이 */
  ARROW_LEN: 8,
  /** 화살촉 반폭·높이 */
  HEAD: 3,
  /** 화살표 뒤끝 ↔ 글자 상자 */
  TEXT_GAP: 1,
  ASCENT: 10,
  DESCENT: 3,
  /** 그림 좌우 가장자리 여백 (chartBasis 그림 안 글자와 같은 값) */
  EDGE: 2,
  /** 가격 칸 아래 틈으로 최저 글자 상자가 내려가도 되는 폭 (거래량 칸·날짜 줄 글자 앞) */
  BOTTOM_SLACK: 3,
  /** 이보다 낮은 가격 칸이면 표시하지 않는다 (여백을 내면 봉이 너무 눌린다 — 좁은 폰 + RSI·MACD) */
  MIN_PRICE_H: 120,
  /** 글자 상자끼리·피할 상자와 띄우는 거리 */
  GAP: 2,
} as const;
/** 꼬리 끝에서 글자 상자 먼 끝까지 (2 + 8 + 1 + 13) */
export const HL_REACH = HL.ARROW_GAP + HL.ARROW_LEN + HL.TEXT_GAP + HL.ASCENT + HL.DESCENT;
/** 가격 칸 위에 남길 픽셀: 최고 글자 상자 위 끝 ≥ 1 */
export const HL_HEAD_TOP = HL_REACH + 1;
/** 가격 칸 아래에 남길 픽셀: 최저 글자 상자 아래 끝 ≤ priceH + BOTTOM_SLACK */
export const HL_HEAD_BOTTOM = HL_REACH - HL.BOTTOM_SLACK;

/**
 * 최고·최저 글자가 들어갈 만큼만 가격 축 범위를 넓힌다 (priceDomain 결과 위에 — 기존 6% 여백이 이미 충분하면 그대로).
 * y(v) = priceH × (d1 − v) / (d1 − d0) 에서 y(hi) ≥ top, y(lo) ≤ priceH − bottom 이 되는 가장 좁은 [d0', d1'] (d0' ≤ d0, d1' ≥ d1).
 * 네 경우(그대로 · 위만 · 아래만 · 둘 다) 중 조건을 만족하는 첫 것. 칸이 너무 낮으면(top + bottom ≥ 칸의 60%) 그대로
 */
export function headroomDomain(domain: readonly [number, number], ex: { hi: number; lo: number }, o: { priceH: number; top: number; bottom: number }): [number, number] {
  const [d0, d1] = domain;
  const a = o.top / o.priceH, b = o.bottom / o.priceH;
  if (!(o.priceH > 0) || !(a >= 0) || !(b >= 0) || a + b >= 0.6 || !(d1 > d0)) return [d0, d1];
  const eps = 1e-9 * Math.max(Math.abs(d1), 1);
  const ok = (lo: number, hi: number) => hi - ex.hi >= a * (hi - lo) - eps && ex.lo - lo >= b * (hi - lo) - eps;
  if (ok(d0, d1)) return [d0, d1];
  // 위만 넓힘: hi' − ex.hi = a (hi' − d0)
  const topHi = (ex.hi - a * d0) / (1 - a);
  if (topHi >= d1 && ok(d0, topHi)) return [d0, topHi];
  // 아래만 넓힘: ex.lo − lo' = b (d1 − lo')
  const botLo = (ex.lo - b * d1) / (1 - b);
  if (botLo <= d0 && ok(botLo, d1)) return [botLo, d1];
  // 둘 다: 범위 폭 S = (hi − lo) / (1 − a − b)
  const s = (ex.hi - ex.lo) / (1 - a - b);
  return [Math.min(d0, ex.lo - b * s), Math.max(d1, ex.hi + a * s)];
}

export interface HighLowMark {
  kind: "high" | "low";
  /** 화살표: x 는 봉 가운데(꼬리 x), tip 은 꼬리 끝 쪽 화살촉 끝, tail 은 글자 쪽 */
  arrow: { x: number; tipY: number; tailY: number };
  /** 글자 바탕 상자 */
  box: Box;
  /** 글자 자리: textAnchor 와 x, 기준선 y */
  anchor: "start" | "middle" | "end";
  tx: number;
  ty: number;
  text: string;
  /** false 면 화살표만 (글자 자리가 없거나 평단 글자와 겹칠 수밖에 없을 때) */
  showText: boolean;
}

const overlap = (a: Box, b: Box, gap = 0) => a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;

/** 화살표 상자 (다른 글자가 피할 때) */
export function arrowBox(m: HighLowMark): Box {
  return { left: m.arrow.x - HL.HEAD - 1, right: m.arrow.x + HL.HEAD + 1, top: Math.min(m.arrow.tipY, m.arrow.tailY), bottom: Math.max(m.arrow.tipY, m.arrow.tailY) };
}

/**
 * 최고·최저 표시의 자리 (순수 함수). 글자 상자는 화살표 위(최고)·아래(최저)에 두고 가로는 차례로 해 본다:
 *  1) 화살표 가운데 (토스 캡처처럼) → 2) 그림 안쪽으로 (봉이 오른쪽 반이면 글자가 화살표에서 끝나고, 왼쪽 반이면 화살표에서 시작) → 3) 바깥쪽으로.
 * 어느 것이든 그림 [EDGE, plotW − EDGE] 안으로 밀어 넣는다 (오른쪽 가격 축·현재가 태그·화면 밖으로 나가지 않게).
 * avoid(평단 글자 등)나 먼저 놓은 최고 글자와 겹치지 않는 첫 자리. 셋 다 겹치거나 글자가 그림보다 넓으면 글자를 빼고 화살표만.
 * 글자 상자가 가격 칸 위(0) · 아래 한계(bottomLimit)를 넘으면(여백을 못 낸 아주 낮은 칸) 글자를 뺀다. 화살표 x 는 밀지 않는다(꼬리를 가리킨다)
 */
export function layoutHighLow(o: {
  plotW: number;
  bottomLimit: number;
  xOf: (i: number) => number;
  yOf: (v: number) => number;
  ex: Extremes;
  texts: Pick<HighLowTexts, "high" | "low">;
  avoid?: readonly Box[];
}): HighLowMark[] {
  const out: HighLowMark[] = [];
  for (const kind of ["high", "low"] as const) {
    const e = o.ex[kind];
    const text = o.texts[kind];
    const x = o.xOf(e.index);
    const y = o.yOf(e.value);
    const up = kind === "high";
    const tipY = up ? y - HL.ARROW_GAP : y + HL.ARROW_GAP;
    const tailY = up ? tipY - HL.ARROW_LEN : tipY + HL.ARROW_LEN;
    const top = up ? tailY - HL.TEXT_GAP - HL.ASCENT - HL.DESCENT : tailY + HL.TEXT_GAP;
    const bottom = top + HL.ASCENT + HL.DESCENT;
    const ty = top + HL.ASCENT;
    const w = textWidth(text) + LABEL_PAD * 2;
    const minL = HL.EDGE, maxL = o.plotW - HL.EDGE - w;
    const clampL = (l: number) => Math.min(Math.max(l, minL), maxL);
    const innerLeft = x >= o.plotW / 2;
    const lefts = [x - w / 2, innerLeft ? x + LABEL_PAD - w : x - LABEL_PAD, innerLeft ? x - LABEL_PAD : x + LABEL_PAD - w].map(clampL);
    const blocks = [...(o.avoid ?? []), ...out.filter((m) => m.showText).map((m) => m.box)];
    // 여백은 딱 맞게 내므로 소수 오차(197.00000000000003 > 197)로 글자가 빠지지 않게 0.5 까지 봐준다
    const fits = maxL >= minL && top >= -0.5 && bottom <= o.bottomLimit + 0.5;
    let chosen: number | null = null;
    if (fits)
      for (const l of lefts)
        if (!blocks.some((b) => overlap(b, { left: l, right: l + w, top, bottom }, HL.GAP))) {
          chosen = l;
          break;
        }
    const left = chosen ?? clampL(lefts[0]!);
    const box = { left, right: left + w, top, bottom };
    // 글자 자리: 가운데 자리가 그대로면 middle, 가장자리에 밀렸거나 한쪽으로 놓였으면 화살표 쪽 끝 기준
    const center = Math.abs(left - (x - w / 2)) < 0.5;
    const anchor: HighLowMark["anchor"] = center ? "middle" : left + w / 2 < x ? "end" : "start";
    const tx = anchor === "middle" ? left + w / 2 : anchor === "start" ? left + LABEL_PAD : left + w - LABEL_PAD;
    out.push({ kind, arrow: { x, tipY, tailY }, box, anchor, tx, ty, text, showText: fits && chosen !== null });
  }
  return out;
}

/** 화살표 경로 (SVG path): 대 + 꺾쇠 화살촉. 최고는 아래(꼬리 끝)를, 최저는 위(꼬리 끝)를 가리킨다 */
export function arrowPath(m: Pick<HighLowMark, "kind" | "arrow">): string {
  const { x, tipY, tailY } = m.arrow;
  const back = m.kind === "high" ? -HL.HEAD : HL.HEAD;
  const f = (v: number) => v.toFixed(1);
  return `M${f(x)} ${f(tailY)}V${f(tipY)}M${f(x - HL.HEAD)} ${f(tipY + back)}L${f(x)} ${f(tipY)}L${f(x + HL.HEAD)} ${f(tipY + back)}`;
}

/**
 * 그림 안 글자(chartBasis placeInsideLabels — 최고·최저 상자를 avoid 로 받아 놓은 결과)와 최고·최저 표시를 맞춘다 (순수 함수).
 * 평단(keep)은 자리가 없으면 겹쳐서라도 남으므로, 평단 글자가 최고·최저 글자와 겹치면 최고·최저를 relayout(평단 상자 피하기)으로 다시 놓고
 * (안쪽·바깥쪽 자리, 그래도 겹치면 화살표만), 새 자리와 겹치는 나머지 글자(52주·벗어난 이동평균)는 뺀다. 겹침이 없으면 받은 표시 그대로
 */
export function settleWithInside<P extends { box: Box }>(o: {
  marks: HighLowMark[];
  labels: readonly { keep?: boolean }[];
  placed: readonly (P | null)[];
  relayout: (avoid: Box[]) => HighLowMark[];
}): { marks: HighLowMark[]; placed: (P | null)[] } {
  const keepBoxes = o.placed.flatMap((p, i) => (p && o.labels[i]?.keep ? [p.box] : []));
  if (!keepBoxes.some((k) => o.marks.some((m) => m.showText && overlap(m.box, k, HL.GAP)))) return { marks: o.marks, placed: [...o.placed] };
  const marks = o.relayout(keepBoxes);
  const placed = o.placed.map((p, i) => (p && !o.labels[i]?.keep && marks.some((m) => (m.showText && overlap(m.box, p.box, HL.GAP)) || overlap(arrowBox(m), p.box)) ? null : p));
  return { marks, placed };
}
