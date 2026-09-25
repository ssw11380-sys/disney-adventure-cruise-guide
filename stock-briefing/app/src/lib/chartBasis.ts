import type { Candle, CandlePeriod } from "@/api/types";
import { font } from "@/tokens";

/**
 * 차트 읽기 줄의 등락 기준 (순수 함수 → 단위 테스트).
 *  - 최신 일봉은 십자선이 올라가 있어도 현재가 머리와 같은 기준(전일 종가 = 거래소 기준가). 통합 봉의 직전 종가와 다를 수 있다
 *  - 지난 일봉·주봉·월봉은 직전 봉 종가 기준 (전일·전주·전월 대비)
 *  - 분봉은 그 봉의 시가 기준 (봉 안의 움직임)
 * 기준 문구를 함께 돌려 화면에 적는다.
 */
export function readoutBasis(o: {
  period: CandlePeriod;
  /** 보고 있는 봉이 전체 시계열의 마지막(최신) 봉인지 */
  isLatest: boolean;
  /** 현재가 머리의 전일 종가 (일봉에서만 씀) */
  latestBase: number | null | undefined;
  /** 직전 봉의 종가 */
  prevClose: number | null | undefined;
  open: number;
  /** 보고 있는 봉의 날짜 (YYYY-MM-DD) */
  candleDate?: string;
  /** 시세(전일 종가)의 거래일. 알면 마지막 봉 날짜와 같을 때만 전일 종가를 쓴다 (봉 목록이 하루 늦게 캐시된 경우) */
  latestDate?: string | null;
}): { base: number | null; label: string } {
  if (o.period !== "D" && o.period !== "W" && o.period !== "M") return { base: o.open || null, label: "봉 시가 대비" };
  const sameDay = !o.latestDate || !o.candleDate || o.latestDate === o.candleDate;
  if (o.period === "D" && o.isLatest && o.latestBase && sameDay) return { base: o.latestBase, label: "전일 대비" };
  const label = o.period === "D" ? "전일 대비" : o.period === "W" ? "전주 대비" : "전월 대비";
  return { base: o.prevClose ?? o.open ?? null, label };
}

/**
 * 차트 글자(font.tiny) 폭 어림 (굵은 글자도 들어가게 조금 넉넉히). 10pt 기준 숫자·영문 약 6, 쉼표·마침표 약 3, 한글 약 10 을
 * 글자 크기에 비례해 늘린다 (3-20 에 차트 글자를 9·10pt 에서 토큰 11pt 로 맞춤)
 */
export function textWidth(label: string): number {
  let w = 0;
  for (const ch of label) w += /[가-힣]/.test(ch) ? 10 : /[,.]/.test(ch) ? 3 : 6;
  return (w * font.tiny) / 10;
}

/**
 * 가격 축 폭: 가장 긴 눈금·태그 글자에 맞춘다 (고정 폭이면 짧은 값에서 오른쪽이 비고 긴 값은 잘린다).
 * 작은 글자는 [글자, 배율] 로 (거래량 9pt → 0.9). 왼쪽 여백 4 + 오른쪽 3, 2px 단위로 올림 → 이동·확대 중 자릿수가 바뀌어도 폭이 덜 흔들린다
 */
export function axisWidth(labels: (string | [string, number])[], min = 32, max = 80): number {
  const longest = labels.reduce<number>((m, l) => Math.max(m, typeof l === "string" ? textWidth(l) : textWidth(l[0]) * l[1]), 0);
  return Math.min(max, Math.max(min, Math.ceil((longest + 7) / 2) * 2));
}

// ── 가격 축 범위 ──

/**
 * 이동평균·볼린저 선이 봉(과 현재가) 범위 밖으로 가격 축을 넓힐 수 있는 한도 (그 범위 폭에 대한 비율).
 * 넘는 부분은 가격 칸에서 잘라 그린다 (PriceChart ClipPath). 예전에는 선 값을 모두 넣어, 크게 떨어진 종목(RGTX)은
 * 120일선의 옛 값(110,000원) 때문에 봉(13,000~16,000원)이 차트 아래 6분의 1에 눌려 있었다
 */
export const LINE_OVERSHOOT = 0.1;
/** 평단이 범위 폭의 이 비율 안쪽이면 축을 넓혀 선으로 그린다 (밖이면 가장자리 글자로만 — 축을 망가뜨리지 않게) */
export const AVG_BAND = 0.25;
/** 가격 축 위아래 여백 (범위 폭 비율) */
export const DOMAIN_PAD = 0.06;

/**
 * 가격 칸의 값 범위 [아래, 위] (순수 함수 → 단위 테스트).
 *  1) 보이는 봉의 저가~고가, 최신 구간을 볼 때는 현재가(current — 과거로 옮겼으면 부르는 쪽이 넘기지 않는다)
 *  2) 선(이동평균·볼린저 — 보이는 구간 값만)은 그 범위에서 폭의 LINE_OVERSHOOT 까지만 넓힌다
 *  3) 평단은 ±AVG_BAND 안쪽일 때만 넣는다 (예전 규칙 그대로)
 *  4) 위아래 DOMAIN_PAD 여백
 * 선이 봉 범위 안에 있으면(보통 종목) 예전 계산과 결과가 같다
 */
export function priceDomain(o: {
  bars: readonly { low: number; high: number }[];
  lines?: readonly (readonly (number | null | undefined)[])[];
  current?: number | null;
  avg?: number | null;
}): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const c of o.bars) {
    if (Number.isFinite(c.low)) lo = Math.min(lo, c.low);
    if (Number.isFinite(c.high)) hi = Math.max(hi, c.high);
  }
  if (!(lo <= hi)) return [0, 1];
  if (o.current && Number.isFinite(o.current)) {
    lo = Math.min(lo, o.current);
    hi = Math.max(hi, o.current);
  }
  let lineLo = Infinity, lineHi = -Infinity;
  for (const s of o.lines ?? [])
    for (const v of s)
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        lineLo = Math.min(lineLo, v);
        lineHi = Math.max(lineHi, v);
      }
  if (lineLo <= lineHi) {
    const room = (hi - lo) * LINE_OVERSHOOT || Math.abs(hi) * 0.01;
    lo = Math.min(lo, Math.max(lineLo, lo - room));
    hi = Math.max(hi, Math.min(lineHi, hi + room));
  }
  const band = (hi - lo) * AVG_BAND;
  if (o.avg && o.avg > lo - band && o.avg < hi + band) {
    lo = Math.min(lo, o.avg);
    hi = Math.max(hi, o.avg);
  }
  const pad = (hi - lo) * DOMAIN_PAD || Math.abs(hi) * 0.01 || 1;
  return [lo - pad, hi + pad];
}

// ── 그림 안쪽 글자(평단 · 52주 최고·최저) 자리 ──

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface InsideLabel {
  /** 선의 y (fixed 면 글자 기준선 y 그대로) */
  y: number;
  text: string;
  /** 먼저 놓아 볼 쪽 (평단은 왼쪽, 52주는 오른쪽 — 예전 자리) */
  prefer: "left" | "right";
  /** 선 없이 가장자리에 고정한 글자 (범위 밖 평단): 위아래로 옮기지 않고 좌우만 바꾼다 */
  fixed?: boolean;
}

export interface LabelSpot {
  side: "left" | "right";
  /** 글자 기준선 y */
  ty: number;
  /** 글자 x (left 면 textAnchor start, right 면 end) */
  x: number;
  /** 바탕 상자 */
  box: Box;
}

/** 글자 바탕 상자의 좌우 안쪽 여백 · 그림 가장자리에서 띄우는 거리 (예전 Tag 와 같은 값) */
const LABEL_PAD = 3;
const LABEL_EDGE = 2;
/** 글자(font.tiny) 상자: 기준선 위 10 · 아래 3. 선 위에 적을 때 기준선은 선 4 위, 선 아래에 적을 때는 선 12 아래 */
const LABEL_ASCENT = 10;
const LABEL_DESCENT = 3;
const LABEL_ABOVE = 4;
const LABEL_BELOW = 12;

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * 평단·52주 글자를 놓을 자리 (순수 함수 → 단위 테스트). 글자를 차례로(평단 → 52주 최고 → 52주 최저) 놓으며
 * 후보 네 곳 [먼저 쪽 선 위, 먼저 쪽 선 아래, 반대쪽 선 위, 반대쪽 선 아래] 중
 *   그림 밖으로 나가지 않고(1000) · 먼저 놓은 글자와 겹치지 않고(100) · 가리는 봉이 가장 적은(봉 하나에 1) 곳을 고른다.
 * 점수가 같으면 앞 후보 (보통은 예전 자리 그대로 — 선 위 왼쪽 평단, 선 위 오른쪽 52주).
 * 예전에는 평단 글자가 늘 왼쪽 위라 앞쪽 봉을 가리고, 52주 최저는 평단과 가까우면 최신 봉 위에 겹쳐 적었다 (RGTX 화면)
 */
export function placeInsideLabels(o: { plotW: number; plotH: number; bars: readonly Box[]; labels: readonly InsideLabel[] }): LabelSpot[] {
  const placed: LabelSpot[] = [];
  for (const l of o.labels) {
    const w = textWidth(l.text) + LABEL_PAD * 2;
    const sides: ("left" | "right")[] = l.prefer === "left" ? ["left", "right"] : ["right", "left"];
    const baselines = l.fixed ? [l.y] : [l.y - LABEL_ABOVE, l.y + LABEL_BELOW];
    let best: { spot: LabelSpot; cost: number } | null = null;
    for (const side of sides)
      for (const ty of baselines) {
        const left = side === "left" ? LABEL_EDGE : o.plotW - LABEL_EDGE - w;
        const box = { left, right: left + w, top: ty - LABEL_ASCENT, bottom: ty + LABEL_DESCENT };
        let cost = box.top < 0 || box.bottom > o.plotH ? 1000 : 0;
        for (const p of placed) if (overlaps(p.box, box)) cost += 100;
        for (const b of o.bars) if (overlaps(b, box)) cost += 1;
        if (!best || cost < best.cost) best = { cost, spot: { side, ty, x: side === "left" ? left + LABEL_PAD : box.right - LABEL_PAD, box } };
      }
    placed.push(best!.spot);
  }
  return placed;
}

/**
 * 그림 위쪽에 덧그리는 상자(과거 구간 안내 버튼)를 가운데·왼쪽·오른쪽 중 어디에 둘지 (순수 함수 → 단위 테스트).
 * 폭 width · 위에서 bottom 까지의 상자가 가리는 봉이 가장 적은 곳, 같으면 가운데 → 왼쪽 → 오른쪽.
 * 급등한 봉 꼭대기(RGTX 6월)나 최신 봉을 버튼이 덮지 않게 한다
 */
export function topOverlayAlign(o: { plotW: number; width: number; bottom: number; bars: readonly Box[]; edge?: number }): "center" | "left" | "right" {
  const edge = o.edge ?? LABEL_EDGE;
  const w = Math.min(o.width, o.plotW - edge * 2);
  const lefts = { center: (o.plotW - w) / 2, left: edge, right: o.plotW - edge - w } as const;
  let best: { align: "center" | "left" | "right"; hits: number } | null = null;
  for (const align of ["center", "left", "right"] as const) {
    const box = { left: lefts[align], right: lefts[align] + w, top: 0, bottom: o.bottom };
    const hits = o.bars.filter((b) => overlaps(b, box)).length;
    if (!best || hits < best.hits) best = { align, hits };
  }
  return best!.align;
}

/**
 * 거래량 막대 경로(SVG path). 상승·하락 막대는 거래량 비율 높이로 채우고, 거래량을 아직 모르는 임시 봉(volumeUnknown — 실시간 체결로 만든 봉)은
 * 0 처럼 비워 두지 않고 pane 높이의 점선 빈 막대(unknown)로 따로 준다 (PF-04, 서버 봉을 다시 받으면 채워진다)
 */
export function volumeBars(
  candles: Pick<Candle, "open" | "close" | "volume" | "volumeUnknown">[],
  o: { maxVol: number; top: number; height: number; barW: number; xOf: (i: number) => number },
): { up: string; down: string; unknown: string } {
  let up = "", down = "", unknown = "";
  const bottom = o.top + o.height;
  candles.forEach((c, i) => {
    const left = (o.xOf(i) - o.barW / 2).toFixed(1);
    if (c.volumeUnknown) {
      unknown += `M${left} ${bottom.toFixed(1)}V${o.top.toFixed(1)}h${o.barW.toFixed(1)}V${bottom.toFixed(1)}`;
      return;
    }
    const h = Math.max((c.volume / o.maxVol) * o.height, c.volume > 0 ? 1 : 0);
    const d = `M${left} ${(bottom - h).toFixed(1)}h${o.barW.toFixed(1)}v${h.toFixed(1)}h${(-o.barW).toFixed(1)}z`;
    if (c.close >= c.open) up += d;
    else down += d;
  });
  return { up, down, unknown };
}
