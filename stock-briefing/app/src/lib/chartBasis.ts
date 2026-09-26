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

// ── 그림 안쪽 글자(평단 · 52주 최고·최저 · 벗어난 이동평균) 자리 ──

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
  /** 선 없이 가장자리에 고정한 글자 (범위 밖 평단 · 벗어난 이동평균 표시): 위아래로 옮기지 않고 가로로만 옮긴다 */
  fixed?: boolean;
  /** 자리가 마땅치 않아도 빼지 않는다 (평단 — 보유자에게 가장 중요한 표시). 나머지는 최신 봉을 덮거나 다른 글자와 겹칠 수밖에 없으면 글자를 빼고 선만 둔다 */
  keep?: boolean;
  /** 글자 앞 표시(색 네모)의 폭 — 있으면 글자는 늘 왼쪽 맞춤 (표시 → 글자 차례) */
  lead?: number;
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
export const LABEL_PAD = 3;
const LABEL_EDGE = 2;
/** 글자(font.tiny) 상자: 기준선 위 10 · 아래 3. 선 위에 적을 때 기준선은 선 4 위, 선 아래에 적을 때는 선 12 아래 */
const LABEL_ASCENT = 10;
const LABEL_DESCENT = 3;
const LABEL_ABOVE = 4;
const LABEL_BELOW = 12;
/** 가로로 자리를 찾을 때 한 번에 옮기는 거리 (px) */
const LABEL_STEP = 4;
/** 글자 상자끼리 가로로 띄우는 거리 (나란히 놓인 두 글자가 한 글자처럼 붙어 보이지 않게) */
const LABEL_GAP = 4;
/**
 * 글자가 덮지 않게 지키는 최신 봉 수 (그림 오른쪽 끝부터). 사용자가 가장 먼저 보는 봉이라, 이 봉을 덮는 자리밖에 없으면
 * 글자를 빼고 선만 둔다 (평단은 빼지 않는다)
 */
export const LABEL_GUARD_BARS = 5;
/** 가장 나은 자리도 지난 봉을 이만큼 이상 덮으면(봉이 빽빽한 줄) 글자를 빼고 선만 둔다 (평단은 빼지 않는다) */
export const LABEL_DROP_BARS = 8;
/**
 * 자리 점수 (낮을수록 좋다): label 다른 글자와 겹침 · guard 최신 봉 하나 ·
 * current 부르는 쪽이 준 선(현재가선)이 글자를 가로지름 — 글자 바탕 상자가 그 선을 끊어 '52주 최저'가 현재가선에 붙은 글자처럼 읽히던 것(RGTX) ·
 * bar 지난 봉 하나 · line 다른 글자의 선(평단·52주)이 글자를 가로지름 · below 선 아래(예전 자리는 선 위) · far 먼저 쪽 끝에서 그림 폭만큼 떨어짐(비례)
 */
const COST = { label: 100, current: 40, guard: 25, bar: 1, line: 3, below: 0.25, far: 2 } as const;

const overlaps = (a: Box, b: Box, gap = 0) => a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom && b.top < a.bottom;

/** 상자가 덮는 봉 수 (지난 봉 · 최신 봉). bars 는 왼쪽부터 차례로 (보이는 봉) — 상자 폭 안의 봉만 본다. guardFrom 부터는 최신 봉 */
function barHits(bars: readonly Box[], box: Box, guardFrom: number): { old: number; latest: number } {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.right <= box.left) lo = mid + 1;
    else hi = mid;
  }
  let old = 0, latest = 0;
  for (let i = lo; i < bars.length && bars[i]!.left < box.right; i++)
    if (overlaps(bars[i]!, box)) {
      if (i >= guardFrom) latest++;
      else old++;
    }
  return { old, latest };
}

/** 그림 안 글자 상자 폭 (글자 + 앞 표시 + 좌우 여백) */
export function insideLabelWidth(l: Pick<InsideLabel, "text" | "lead">): number {
  return textWidth(l.text) + (l.lead ?? 0) + LABEL_PAD * 2;
}

/**
 * 평단·52주·벗어난 이동평균 글자를 놓을 자리 (순수 함수 → 단위 테스트). 놓지 않으면 null (선만 그린다).
 * 글자 상자는 plotTop(과거 구간 안내 버튼 자리 — 그 위는 비워 둔다) ~ plotH + bottomSlack(가격 칸 아래 틈 — 거래량 칸·날짜 줄 앞) 안에만 놓는다.
 *
 * 글자마다 선 위·선 아래(fixed 면 그 줄) × 그림 왼쪽 끝부터 오른쪽 끝까지 LABEL_STEP 간격의 자리를 모두 보고, 점수(COST)가 가장 낮은 곳을 고른다 —
 * 봉·다른 글자·다른 가로선을 가리지 않고, 최신 봉(오른쪽 끝 LABEL_GUARD_BARS 개)은 특히 덮지 않고, 되도록 예전 자리(평단 왼쪽 위, 52주 오른쪽 위) 가까이.
 * 차례로(평단 → 52주 → 이동평균) 놓은 뒤 두 번 더 돌며 서로를 보고 다시 고른다 (먼저 놓은 평단이 자리를 막아 52주가 최신 봉을 덮던 것 — RGTX).
 * 가장 나은 자리도 최신 봉을 덮거나, 다른 글자와 겹치거나, 현재가선(lines)이 가로지르거나, 지난 봉을 LABEL_DROP_BARS 개 이상 덮으면 글자를 뺀다 (keep 인 평단은 빼지 않는다).
 * 예전에는 네 자리(양쪽 × 선 위·아래)만 보고 차례로 정해, 오늘 52주 신저가인 RGTX 에서 '52주 최저'가 최신 봉 16개를 덮었다.
 *
 * bars 는 왼쪽부터 차례로 (보이는 봉의 몸통·꼬리 상자), lines 는 글자가 가로지르지 않았으면 하는 다른 가로선 y (현재가선)
 */
export function placeInsideLabels(o: {
  plotW: number;
  plotH: number;
  bars: readonly Box[];
  labels: readonly InsideLabel[];
  lines?: readonly number[];
  guard?: number;
  /** 글자 상자 위 끝의 한계 (기본 0). 과거 구간 안내 버튼이 있으면 그 아래 */
  plotTop?: number;
  /** 가격 칸 아래로 글자 상자가 넘어가도 되는 폭 (기본 0 — 거래량 칸 앞 틈). 오늘 52주 신저가처럼 선이 바닥에 붙어도 선 아래에 적을 수 있게 */
  bottomSlack?: number;
}): (LabelSpot | null)[] {
  const guardFrom = o.bars.length - (o.guard ?? LABEL_GUARD_BARS);
  const plotTop = o.plotTop ?? 0;
  const plotBottom = o.plotH + (o.bottomSlack ?? 0);
  // 다른 글자의 선 (fixed 가 아닌 것): 글자가 자기 선이 아닌 선을 가로지르면 조금 감점. 부르는 쪽이 준 선(현재가선)은 크게 감점하고, 그래도 가로지르면 뺀다
  const lineYs = o.labels.map((l) => (l.fixed ? null : l.y));
  const strong = o.lines ?? [];
  type Cand = { spot: LabelSpot; base: number; old: number; latest: number; cross: number };
  const cands = o.labels.map((l, idx): Cand[] => {
    const w = insideLabelWidth(l);
    const maxLeft = o.plotW - LABEL_EDGE - w;
    const lefts: number[] = [];
    if (maxLeft >= LABEL_EDGE) {
      for (let x = LABEL_EDGE; x < maxLeft; x += LABEL_STEP) lefts.push(x);
      lefts.push(maxLeft);
    } else if (l.keep) lefts.push(LABEL_EDGE); // 폭이 모자라도 평단은 왼쪽 끝에 (글자가 조금 넘친다)
    const prefLeft = l.prefer === "left" ? LABEL_EDGE : Math.max(LABEL_EDGE, maxLeft);
    const weak = lineYs.filter((_, j) => j !== idx);
    const baselines: [number, number][] = l.fixed ? [[l.y, 0]] : [[l.y - LABEL_ABOVE, 0], [l.y + LABEL_BELOW, COST.below]];
    const list: Cand[] = [];
    for (const [ty, extra] of baselines) {
      const top = ty - LABEL_ASCENT, bottom = ty + LABEL_DESCENT;
      // 그림 밖(안내 버튼 자리 · 아래 칸)으로 나가는 줄은 후보가 아니다
      if (top < plotTop || bottom > plotBottom) continue;
      for (const left of lefts) {
        const box = { left, right: left + w, top, bottom };
        const hit = barHits(o.bars, box, guardFrom);
        let base = extra + (Math.abs(left - prefLeft) / Math.max(o.plotW, 1)) * COST.far + hit.old * COST.bar + hit.latest * COST.guard;
        for (const y of weak) if (y !== null && y > top && y < bottom) base += COST.line;
        const cross = strong.filter((y) => y > top && y < bottom).length;
        base += cross * COST.current;
        const side: "left" | "right" = l.lead || left + w / 2 < o.plotW / 2 ? "left" : "right";
        list.push({ base, old: hit.old, latest: hit.latest, cross, spot: { side, ty, x: side === "left" ? left + LABEL_PAD : box.right - LABEL_PAD, box } });
      }
    }
    return list;
  });
  const placed: (Cand | null)[] = o.labels.map(() => null);
  const clash = (i: number, box: Box) => placed.some((p, j) => j !== i && p !== null && overlaps(p.spot.box, box, LABEL_GAP));
  // 차례로 놓고(0), 서로를 보며 두 번 더 고른다(1·2). 같은 점수면 먼저 본 자리
  for (let round = 0; round < 3; round++)
    for (let i = 0; i < o.labels.length; i++) {
      let best: { c: Cand; cost: number } | null = null;
      for (const c of cands[i]!) {
        let total = c.base;
        for (let j = 0; j < placed.length; j++) if (j !== i && placed[j] && overlaps(placed[j]!.spot.box, c.spot.box, LABEL_GAP)) total += COST.label;
        if (!best || total < best.cost - 1e-9) best = { c, cost: total };
      }
      placed[i] = best?.c ?? null;
    }
  // 빼는 글자: 최신 봉을 덮거나, 지난 봉을 너무 많이 덮거나, 현재가선이 가로지르거나, 다른 글자와 겹친다 (평단은 남긴다). 뺀 글자는 다른 글자의 겹침으로 세지 않도록 차례로
  const out: (LabelSpot | null)[] = placed.map((p) => p?.spot ?? null);
  for (let i = 0; i < o.labels.length; i++) {
    const p = placed[i];
    if (!p || o.labels[i]!.keep) continue;
    if (p.latest > 0 || p.old >= LABEL_DROP_BARS || p.cross > 0 || clash(i, p.spot.box)) {
      out[i] = null;
      placed[i] = null;
    }
  }
  return out;
}

/** 과거 구간 안내 버튼 자리 */
export type OverlayAlign = "center" | "left" | "right";

/**
 * 그림 위쪽에 덧그리는 상자(과거 구간 안내 버튼)를 가운데·왼쪽·오른쪽 중 어디에 둘지 (순수 함수 → 단위 테스트).
 * 폭 width · 위에서 bottom 까지의 상자가 가리는 봉(하나에 1)과 그림 안 글자(평단·52주·이동평균 표시 — 하나에 weight, 기본 20)가 가장 적은 곳, 같으면 가운데 → 왼쪽 → 오른쪽.
 * 급등한 봉 꼭대기(RGTX 6월)·최신 봉·범위 밖 평단 글자('평단(범위 위) …', 왼쪽 위)를 버튼이 덮지 않게 한다. cost 는 그 자리의 점수 (0 = 아무것도 덮지 않음).
 * PriceChart 는 버튼이 보이는 동안 가격 칸 위쪽을 비워 두므로(봉·글자가 bottom 아래에만 있다) 보통 가운데(점수 0)이고, 가격 칸이 작아 다 비우지 못했을 때만 옆으로 간다
 */
export function topOverlayAlign(o: { plotW: number; width: number; bottom: number; bars: readonly Box[]; labels?: readonly (Box & { weight?: number })[]; edge?: number }): {
  align: OverlayAlign;
  cost: number;
} {
  const edge = o.edge ?? LABEL_EDGE;
  const w = Math.min(o.width, o.plotW - edge * 2);
  const lefts = { center: (o.plotW - w) / 2, left: edge, right: o.plotW - edge - w } as const;
  let best: { align: OverlayAlign; cost: number } | null = null;
  for (const align of ["center", "left", "right"] as const) {
    const box = { left: lefts[align], right: lefts[align] + w, top: 0, bottom: o.bottom };
    let cost = o.bars.filter((b) => overlaps(b, box)).length;
    for (const l of o.labels ?? []) if (overlaps(l, box)) cost += l.weight ?? 20;
    if (!best || cost < best.cost) best = { align, cost };
  }
  return best!;
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
