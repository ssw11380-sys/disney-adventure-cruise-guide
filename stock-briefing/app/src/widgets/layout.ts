import { space } from "@/tokens";
import { WIDGET_BOARD as BOARD, WIDGET_FONT as F, WIDGET_TOTAL_FONTS as TOTAL_FONTS, WIDGET_TOUCH as TOUCH } from "./palette";

/**
 * 위젯 크기별 배치 (3-23, 순수 함수 → 단위 테스트).
 * 위젯은 글자를 비트맵으로 그려 두므로, 칸보다 긴 숫자는 잘리거나(…) 칸 밖으로 나간다.
 * 그래서 글자 폭을 보수적으로(실제 글꼴보다 넓게) 어림해, 숫자가 칸에 다 들어가는 배치를 미리 고른다.
 *  - 숫자는 자르지 않는다: 글자를 줄이거나(정해진 단계 안에서), 덜 중요한 칸(장 상태 칩·손익 금액·지수 항목)을 뺀다
 *  - 이름·브리핑 문장만 끝을 …로 줄일 수 있다
 *  - 높이도 어림해 위젯 밖으로 넘치지 않게 한다: 잔고 목록(ListWidget)은 높이가 0 이면 라이브러리가 그리지 못하므로(예외 → 위젯이 갱신되지 않음)
 *    첫 줄이 보일 높이가 없으면 넣지 않고, 브리핑 고지 한 줄은 늘 들어가게 종목 칸을 줄인다
 *  - 크기 단계: 목록 위젯(잔고·브리핑·지수·환율)은 높이, 자산 위젯(2×1)은 폭으로 compact · regular · large
 * 폭·높이는 dp, 글자 크기는 sp (배율 scale = 시스템 글자 크기, 100% = 1)
 */

export type SizeClass = "compact" | "regular" | "large";

/** 위젯 안쪽 여백 (dp) */
export const PAD = space.md;
/** 굵은 글자는 이만큼 넓게 어림 */
const BOLD = 1.06;
/** 글자마다 더하는 여유 (dp) */
const SLACK = 2;
/** 줄 높이 = 글자 크기 × 이 값 (한글 대체 글꼴의 줄 간격까지 넉넉히) */
const LINE = 1.45;

/**
 * 글자 한 자의 폭 (em). Roboto·본고딕 실제 폭보다 조금 넓게:
 * 숫자 0.56 → 0.6, 쉼표·마침표 0.2~0.26 → 0.3, % 0.73 → 0.85, 한글 0.92 → 1
 */
export function charEm(ch: string): number {
  if (ch >= "0" && ch <= "9") return 0.6;
  switch (ch) {
    case ",":
    case ".":
    case ":":
    case " ":
      return 0.3;
    case "·":
      return 0.4;
    case "/":
      return 0.45;
    case "%":
      return 0.85;
    case "+":
    case "$":
    case "−":
      return 0.6;
    case "-":
      return 0.45;
    case "(":
    case ")":
      return 0.4;
  }
  if (ch >= "A" && ch <= "Z") return 0.72;
  if (ch >= "a" && ch <= "z") return 0.6;
  return 1; // 한글·기호
}

/** 글자 폭 합 (em) */
export function textEm(text: string): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em;
}

/** 한 줄 글자 폭 어림 (dp) */
export function textWidth(text: string, font: number, scale: number, bold = false): number {
  return textEm(text) * font * scale * (bold ? BOLD : 1) + SLACK;
}

/** 한 줄 높이 어림 (dp) */
export function lineHeight(font: number, scale: number): number {
  return Math.ceil(font * scale * LINE);
}

/** width 안에 한 줄로 들어가는 가장 큰 글자 크기 (max 이하, 정수). 어떤 크기도 안 되면 1 */
export function fitFont(text: string, width: number, max: number, scale: number, bold = false): number {
  for (let f = max; f > 1; f--) if (textWidth(text, f, scale, bold) <= width) return f;
  return 1;
}

/** 조각을 앞에서부터 넣을 수 있는 만큼 " · " 로 잇는다 (넘치는 조각은 뺀다 — 자르지 않는다) */
export function fitJoin(parts: readonly string[], width: number, font: number, scale: number): string | null {
  const kept: string[] = [];
  for (const p of parts) {
    const next = [...kept, p].join(" · ");
    if (textWidth(next, font, scale) <= width) kept.push(p);
  }
  return kept.length ? kept.join(" · ") : null;
}

/** 잔고·브리핑 위젯 크기 단계 (높이): 4×2 최소(110dp)는 compact, 4×4(250dp~)는 large */
export function listSize(height: number): SizeClass {
  return height < 150 ? "compact" : height < 240 ? "regular" : "large";
}

/** 자산 위젯(2×1, 가로로만 늘어남) 크기 단계 (폭) */
export function assetSize(width: number): SizeClass {
  return width < 150 ? "compact" : width < 220 ? "regular" : "large";
}

// ── 머리 줄 (잔고·브리핑) ──────────────────────────────────────────────

export interface HeaderInput {
  title: string;
  /** 장 상태 칩 글자 (없으면 null) */
  chip: string | null;
  /** 기준 시각 글자를 긴 것부터 (asOfVariants). 갱신 중이면 ["갱신 중"] */
  sub: string[];
  delayed: boolean;
}

export interface HeaderPlan {
  chip: boolean;
  sub: string | null;
  delayed: boolean;
}

const CHIP_EXTRA = space.xs * 2 + 2; // 좌우 여백 + 테두리
const HEADER_GAP = space.s;

/** 머리 왼쪽 묶음(제목·칩·기준 시각·지연)에 쓸 수 있는 폭: 오른쪽 ↻ 칸(48dp)은 위젯 오른쪽 끝에 붙는다 */
export function headerRoom(width: number): number {
  return width - PAD - TOUCH - space.xs;
}

function headerWidth(i: HeaderInput, p: HeaderPlan, scale: number): number {
  const parts = [textWidth(i.title, F.title, scale, true)];
  if (p.chip && i.chip) parts.push(textWidth(i.chip, F.xs, scale, true) + CHIP_EXTRA);
  if (p.sub) parts.push(textWidth(p.sub, F.sm, scale));
  if (p.delayed) parts.push(textWidth("지연", F.sm, scale, true));
  return parts.reduce((a, b) => a + b, 0) + HEADER_GAP * (parts.length - 1);
}

/** 기준 시각을 긴 것부터, 칩은 있는 쪽부터 넣어 보고 들어가는 첫 배치. 제목과 "지연"은 늘 남긴다 */
export function planHeader(i: HeaderInput, width: number, scale: number): HeaderPlan {
  const room = headerRoom(width);
  const candidates: HeaderPlan[] = [];
  for (const sub of i.sub) for (const chip of i.chip ? [true, false] : [false]) candidates.push({ chip, sub, delayed: i.delayed });
  candidates.push({ chip: false, sub: null, delayed: i.delayed });
  return candidates.find((p) => headerWidth(i, p, scale) <= room) ?? { chip: false, sub: null, delayed: i.delayed };
}

// ── 잔고 위젯 합계 줄 ──────────────────────────────────────────────────

/** 손익 글자: 금액과 수익률 */
export interface PnlText {
  /** "누적 -12,345,678원" */
  amount: string;
  /** "(-12.34%)" (없으면 null) */
  rate: string | null;
}

export interface TotalInput {
  /** "123,456,789원" */
  total: string;
  /** 전환 칸 없이 그릴 때의 손익 (누적 — 플래그를 끈 것과 같다) */
  fixed: PnlText;
  /** 손익을 눌러 누적·당일을 바꿀 수 있으면(widgetPnlToggle) 전환 칸에 보일 손익 (저장된 쪽). 꺼져 있으면 null */
  toggle: PnlText | null;
}

/** 합계 줄 한 가지 배치를 재는 입력: 손익 글자와 누르는 칸(48dp)을 둘지 */
export interface TotalLine extends PnlText {
  total: string;
  /** 손익을 눌러 누적·당일을 바꾸는 칸 (손익 칸이 48dp 높이) */
  toggle: boolean;
}

export interface TotalPlan {
  /** 합계와 손익을 한 줄에 (아니면 합계 아래에 손익) */
  inline: boolean;
  totalFont: number;
  pnlFont: number;
  /** 손익 줄: 한 줄이면 [금액 수익률], 두 줄이면 [금액], [수익률] */
  pnl: string[];
  /** 손익 칸 좌우 여백 (누르는 칸이 48dp 보다 좁지 않게) */
  pnlPadX: number;
  /** 손익 칸 높이 */
  pnlH: number;
  /** 합계 칸 높이 */
  totalH: number;
  /** 줄 전체 높이 (위아래 여백 제외) */
  height: number;
  /** 손익 전환 칸을 두는지 (플래그가 켜져 있어도 낮은 위젯에서는 뺄 수 있다) */
  toggle: boolean;
  /** 줄 위아래 여백. 전환 칸(48dp)은 안에 빈 곳이 있어 0 */
  gapY: number;
}

const TOTAL_GAP = space.sm;

function totalPlan(i: TotalLine, inline: boolean, totalFont: number, pnlFont: number, twoLines: boolean, scale: number): TotalPlan & { width: number } {
  const pnl = twoLines && i.rate ? [i.amount, i.rate] : [i.rate ? `${i.amount} ${i.rate}` : i.amount];
  const textW = Math.max(...pnl.map((l) => textWidth(l, pnlFont, scale, true)));
  const pnlPadX = i.toggle ? Math.max(0, Math.ceil((TOUCH - textW) / 2)) : 0;
  const pnlW = textW + pnlPadX * 2;
  const linesH = pnl.length * lineHeight(pnlFont, scale);
  const pnlH = i.toggle ? Math.max(TOUCH, linesH) : linesH;
  const tW = textWidth(i.total, totalFont, scale, true);
  const tLine = lineHeight(totalFont, scale);
  const height = inline ? Math.max(tLine, pnlH) : tLine + pnlH;
  return {
    inline,
    totalFont,
    pnlFont,
    pnl,
    pnlPadX,
    pnlH,
    totalH: inline ? height : tLine,
    height,
    toggle: i.toggle,
    gapY: i.toggle ? 0 : space.xs,
    width: inline ? tW + TOTAL_GAP + pnlW : Math.max(tW, pnlW),
  };
}

/**
 * 합계·손익 배치 후보 (폭에 들어가는 것만, 앞의 것이 더 좋은 배치):
 * 한 줄 → 손익 두 줄 → 합계 글자 줄이기 → 합계 아래로 내리기 → (낮은 위젯용) 합계·손익 글자를 줄여 높이 줄이기.
 * 하나도 안 들어가면 합계 아래로 내리고 글자를 칸에 맞게 줄인 한 가지 (숫자를 자르지 않는다)
 */
export function totalOptions(i: TotalLine, width: number, scale: number): TotalPlan[] {
  const [big, mid, small] = TOTAL_FONTS;
  const tries: [boolean, number, number, boolean][] = [
    [true, big, F.md, false],
    [true, big, F.md, true],
    [true, mid, F.md, true],
    [true, small, F.sm, true],
    [false, big, F.md, false],
    [false, big, F.sm, false],
    [false, big, F.sm, true],
    [false, mid, F.xs, true],
    // 낮은 위젯(4×2 최소·큰 글자): 합계 글자를 줄여 두 줄 높이를 줄인다
    [false, small, F.sm, false],
    [false, small, F.xs, false],
    [false, small, F.xs, true],
  ];
  const out: TotalPlan[] = [];
  for (const [inline, tf, pf, two] of tries) {
    const p = totalPlan(i, inline, tf, pf, two, scale);
    if (p.width <= width) out.push(strip(p));
  }
  if (out.length) return out;
  // 아주 좁으면 글자를 칸에 맞게
  const tf = fitFont(i.total, width, F.big, scale, true);
  const lines = i.rate ? [i.amount, i.rate] : [i.amount];
  const pf = Math.min(...lines.map((l) => fitFont(l, width, F.xs, scale, true)));
  return [strip(totalPlan(i, false, tf, pf, true, scale))];
}

/** 폭만 볼 때의 합계 배치 (가장 좋은 후보) */
export function planTotal(i: TotalLine, width: number, scale: number): TotalPlan {
  return totalOptions(i, width, scale)[0]!;
}

/** 합계 줄이 차지하는 높이 (위아래 여백 포함) */
export function totalBlock(t: TotalPlan | null): number {
  return t ? t.height + t.gapY * 2 : 0;
}

function strip<T extends { width: number }>(p: T): Omit<T, "width"> {
  const { width: _w, ...rest } = p;
  return rest;
}

// ── 지수·환율 한 줄 ───────────────────────────────────────────────────

export interface IndexInput {
  label: string;
  value: string;
  rate: string | null;
  stale: boolean;
  /** 흐린 값 뒤 글자 (다듬은 모습: 지난 세션 날짜 "9/23" · "지연"). 없으면 stale 일 때 "지연" */
  tag?: string | null;
  /** 다듬은 모습: 좁을 때 남기는 순서 (작을수록 오래 남는다 — planPolishedIndex) */
  keep?: number;
  /** 다듬은 모습: 값을 빼고 등락률만 보일 수 있다 (지수. 원/달러는 값이 중요해 아님) */
  canShort?: boolean;
  /** 값을 뺀 짧은 모양 ("나스닥 -1.13%") — planPolishedIndex 가 좁을 때 붙인다 */
  short?: boolean;
}

/** 지수 항목 끝의 흐린 글자: 다듬은 모습은 tag, 예전 모습은 stale 이면 "지연" */
export function indexTag(i: Pick<IndexInput, "stale" | "tag">): string | null {
  return i.tag !== undefined ? i.tag : i.stale ? "지연" : null;
}

export interface IndexPlan<T extends IndexInput = IndexInput> {
  font: number;
  /** 줄마다 항목 (large 는 두 줄까지) */
  lines: T[][];
  height: number;
}

const ITEM_GAP = space.xs;
/** 다듬은 지수 줄 항목 사이 여백 (항목 안은 ITEM_GAP) */
export const POLISH_SEP_GAP = space.xxs;

export function indexItemWidth(i: IndexInput, font: number, scale: number): number {
  const parts = [textWidth(i.label, font, scale)];
  if (!i.short) parts.push(textWidth(i.value, font, scale, true));
  if (i.rate) parts.push(textWidth(i.rate, font, scale, true));
  const tag = indexTag(i);
  if (tag) parts.push(textWidth(tag, font, scale));
  return parts.reduce((a, b) => a + b, 0) + ITEM_GAP * (parts.length - 1);
}

/** 항목 사이 " · " 칸 폭 */
export function indexSepWidth(font: number, scale: number): number {
  return textWidth("·", font, scale) + ITEM_GAP * 2;
}

/** 다듬은 지수 줄의 항목 사이 " · " 칸 폭: 항목끼리는 xxs 로 좁게 (항목 안은 ITEM_GAP) — 330dp 에 시장마다 하나 + 원/달러가 들어가게 */
export function polishedSepWidth(font: number, scale: number): number {
  return textWidth("·", font, scale) + POLISH_SEP_GAP * 2;
}

/** 앞에서부터 줄에 채운다. maxLines 안에 다 못 넣으면 null. sep: 항목 사이 칸 폭 */
function pack<T extends IndexInput>(items: T[], font: number, width: number, scale: number, maxLines: number, sep = indexSepWidth(font, scale)): T[][] | null {
  const lines: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const it of items) {
    const w = indexItemWidth(it, font, scale);
    const add = cur.length ? sep + w : w;
    if (used + add <= width) {
      cur.push(it);
      used += add;
      continue;
    }
    if (!cur.length || w > width) return null;
    lines.push(cur);
    cur = [it];
    used = w;
  }
  if (cur.length) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

/** 전부 → 뒤의 항목(환율, 그다음 나스닥)을 빼며, 글자는 sm → xs 로. 코스피 하나도 안 들어가면 줄을 감춘다 */
export function planIndexLine<T extends IndexInput>(items: T[], width: number, scale: number, maxLines: 1 | 2): IndexPlan<T> | null {
  for (let n = items.length; n > 0; n--) {
    for (const font of [F.sm, F.xs]) {
      const lines = pack(items.slice(0, n), font, width, scale, maxLines);
      if (lines) return { font, lines, height: lines.length * lineHeight(font, scale) };
    }
  }
  return null;
}

/**
 * 다듬은 지수 줄 (검증 지적: 뒤에서부터 빼면 늘 끝인 원/달러가 먼저 빠져 330~640dp 어디서도 보이지 않았다).
 * 보이는 순서는 받은 그대로(계좌 비중 순서, 원/달러 끝)이고, 좁으면 덜 중요한 것(keep 이 큰 것)부터 뺀다 —
 * 둘째 시장의 둘째 지수 → 첫 시장의 둘째 지수. 시장마다 하나 + 원/달러(셋)가 안 들어가면 지수의 값을 빼고 등락률만(short — 둘째 시장부터),
 * 그래도 안 되면 둘째 시장 지수를 뺀다. 각 단계에서 글자는 sm → xs. 항목 사이는 좁게(POLISH_SEP_GAP).
 * 예 (330dp, 글자 100%, 미국 비중이 큼): "나스닥 -1.13% · 코스피 +0.90% 9/23 · 원/달러 1,391.50 +0.38%"
 */
export function planPolishedIndex<T extends IndexInput>(items: T[], width: number, scale: number, maxLines: 1 | 2): IndexPlan<T> | null {
  const byKeep = [...items].sort((a, b) => (a.keep ?? 0) - (b.keep ?? 0));
  const tries: T[][] = [];
  for (let n = items.length; n > 0; n--) {
    const kept = new Set(byKeep.slice(0, n));
    let cur = items.filter((i) => kept.has(i));
    tries.push(cur);
    // 시장마다 하나 + 원/달러 이하로 줄었을 때만 짧은 모양을 쓴다 (넷·다섯이면 하나를 빼는 편이 읽기 쉽다)
    if (n > 3) continue;
    for (const s of cur.filter((i) => i.canShort).sort((a, b) => (b.keep ?? 0) - (a.keep ?? 0))) {
      cur = cur.map((i) => (i === s ? { ...i, short: true } : i));
      tries.push(cur);
    }
  }
  for (const t of tries)
    for (const font of [F.sm, F.xs]) {
      const lines = pack(t, font, width, scale, maxLines, polishedSepWidth(font, scale));
      if (lines) return { font, lines, height: lines.length * lineHeight(font, scale) };
    }
  return null;
}

// ── 잔고 목록 한 줄 ───────────────────────────────────────────────────

export interface RowInput {
  name: string;
  /** "72,000원" · "$12,345.67" · "-" */
  price: string;
  /** "+1.50%" (시세가 없으면 null) */
  rate: string | null;
  /** 이름 아래 줄을 긴 것부터 ("+12.34% +1,234,567원" → "+12.34%") */
  subs: string[];
}

export interface RowsPlan {
  /** 가격과 등락률을 위아래로 (아니면 한 줄에) */
  stacked: boolean;
  /** 왼쪽(이름·손익) 칸 폭 */
  leftW: number;
  /** 등락률 칸 폭 (줄마다 오른쪽 끝을 맞춘다) */
  rateW: number;
  subFont: number;
  /** 줄마다 고른 아래 줄 (어느 것도 안 들어가면 null → 비움) */
  sub: (string | null)[];
  /** 한 줄 높이 */
  rowH: number;
  /** 등락률 앞 작은 글자("오늘") 칸 폭 — 다듬은 모습만, 예전 모습은 0 */
  labelW: number;
}

const ROW_GAP = space.sm;

/**
 * 목록 줄 배치: [가격 등락률 한 줄, sm] → [가격/등락률 위아래, sm] → xs 순으로, 모든 줄의 손익이 온전히 들어가는 첫 배치.
 * 그런 배치가 없으면 줄마다 들어가는 가장 긴 손익(없으면 비움)
 */
export function planRows(rows: readonly RowInput[], width: number, scale: number): RowsPlan {
  return rowsPlan(rows, width, scale, { label: null, padY: space.xs });
}

/** 다듬은 잔고 위젯의 목록 줄: 등락률 앞에 작은 "오늘"(label), 줄 위아래 여백은 POLISH_ROW_PAD */
export function planRowsPolished(rows: readonly RowInput[], width: number, scale: number, label: string): RowsPlan {
  return rowsPlan(rows, width, scale, { label, padY: POLISH_ROW_PAD });
}

function rowsPlan(rows: readonly RowInput[], width: number, scale: number, o: { label: string | null; padY: number }): RowsPlan {
  // 등락률 칸은 정수 폭으로 그리므로 올림한 값으로 나머지를 나눈다
  const priceW = Math.ceil(Math.max(0, ...rows.map((r) => textWidth(r.price, F.base, scale, true))));
  const rateW = Math.ceil(Math.max(0, ...rows.map((r) => (r.rate ? textWidth(r.rate, F.md, scale, true) : 0))));
  const labelW = o.label && rateW ? Math.ceil(textWidth(o.label, F.xs, scale) + space.xxs) : 0;
  const minName = textWidth("가나", F.base, scale, true);
  const leftH = lineHeight(F.base, scale) + lineHeight(F.sm, scale);
  const make = (stacked: boolean, subFont: number): RowsPlan => {
    const rate = labelW + rateW;
    const right = stacked ? Math.max(priceW, rate) : priceW + (rateW ? ROW_GAP + rate : 0);
    const leftW = Math.floor(width - right - ROW_GAP);
    const sub = rows.map((r) => r.subs.find((s) => textWidth(s, subFont, scale) <= leftW) ?? null);
    // 다듬은 모습은 위아래로 쌓은 오른쪽(가격 / 오늘 등락률)이 왼쪽 두 줄보다 높을 수 있다
    const contentH = o.label !== null && stacked ? Math.max(leftH, lineHeight(F.base, scale) + lineHeight(F.md, scale)) : leftH;
    return { stacked, leftW, rateW, subFont, sub, rowH: contentH + o.padY * 2 + 1, labelW };
  };
  const tries = [make(false, F.sm), make(true, F.sm), make(false, F.xs), make(true, F.xs)].filter((p) => p.leftW >= minName);
  const full = tries.find((p) => p.sub.every((s, n) => s === rows[n]!.subs[0]));
  if (full) return full;
  const some = tries.find((p) => p.sub.every((s) => s !== null));
  return some ?? tries[tries.length - 1] ?? make(true, F.xs);
}

// ── 잔고 위젯 전체 ────────────────────────────────────────────────────

export interface HoldingsInput {
  width: number;
  height: number;
  scale: number;
  header: HeaderInput;
  total: TotalInput | null;
  /** 지수 줄에 넣을 항목 (플래그가 꺼져 있거나 서버가 주지 않으면 빈 배열) */
  indices: IndexInput[];
  rows: RowInput[];
  /** 합계 아래 회색 한 줄 조각 (갱신 실패·이전 값·일부 제외) */
  note: string[];
  /** 메모 줄이 들어갈 높이가 없을 때 머리 줄 기준 시각 자리에 대신 보일 짧은 글 ("갱신 실패"). 없으면 null */
  alert: string | null;
}

export interface HoldingsPlan<T extends IndexInput = IndexInput> {
  size: SizeClass;
  /** 본문 폭 (좌우 여백 뺀 폭) */
  content: number;
  header: HeaderPlan;
  total: TotalPlan | null;
  index: IndexPlan<T> | null;
  note: string | null;
  /**
   * 종목 목록(ListWidget)을 넣는지. 넣으면 목록 칸이 첫 줄(이름·가격)이 보이는 높이 이상이다 —
   * 라이브러리는 높이 0 인 목록을 그리지 못하고(예외), 그 예외는 네이티브가 삼켜 위젯이 아예 갱신되지 않는다
   */
  list: boolean;
  /** 목록 칸 높이 어림 (dp, 목록이 없으면 남는 높이) */
  listH: number;
  rows: RowsPlan;
}

/** 종목이 없을 때 안내 문구("등록된 종목이 없습니다" · 불러오지 못함)의 최대 줄 수 */
export const EMPTY_LINES = 2;

/** 목록을 넣을 최소 높이: 첫 줄의 이름·가격 줄이 온전히 보일 만큼 (위 여백 + 구분선 + 한 줄) */
export function listMinHeight(scale: number): number {
  return space.xs + 1 + lineHeight(F.base, scale);
}

/**
 * 잔고 위젯 배치. 폭(숫자 잘림 0)과 높이(위젯 밖으로 넘치지 않음)를 함께 본다.
 * 세로 순서: 머리 줄(48dp, ↻ 칸) → 합계 줄 → [지수 줄] → [메모] → 목록 (아래 여백 PAD).
 * 높이가 모자라면 덜 중요한 것부터 뺀다 — 목록 > 메모 > 손익 전환 칸 순으로 지킨다:
 *  1. 목록 + 메모 + 손익 전환 칸(48dp)   2. 목록 + 메모, 전환 칸 없이(누적만, 누르면 앱 — 플래그를 끈 것과 같다)
 *  3. 목록, 메모 없이(갱신 실패는 머리 줄 기준 시각 자리에) + 전환 칸   4. 목록만
 *  5~8. 같은 순서로 목록 없이   9. 마지막: 모두 빼고 합계 줄 여백 0 (가장 낮은 합계 배치)
 * 그래서 갱신이 실패해 메모가 생겨도 목록이 사라지지 않는다. 각 단계에서 합계 줄은 폭에 들어가는 후보(totalOptions) 중 높이가 들어가는 첫 것.
 * 지수 줄은 compact 가 아니고, 넣은 뒤에도 목록이 한 줄 이상 보일 때만. 종목이 없으면(목록 없음) 크기와 상관없이 안내 문구 두 줄이 남을 때.
 */
export function planHoldings<T extends IndexInput>(i: HoldingsInput & { indices: T[] }): HoldingsPlan<T> {
  const s = i.scale;
  const size = listSize(i.height);
  const content = i.width - PAD * 2;
  const rows = planRows(i.rows, content, s);
  const noteText = fitJoin(i.note, content, F.sm, s);
  const noteH = noteText ? lineHeight(F.sm, s) : 0;
  // 머리 줄은 위 끝에 붙고(위 여백 없음), 아래 여백은 PAD
  const avail = i.height - PAD - TOUCH;
  const hasRows = i.rows.length > 0;
  const listMin = listMinHeight(s);
  const t = i.total;
  const optionsFor = (toggle: boolean): (TotalPlan | null)[] => {
    if (!t) return [null];
    const pnl = toggle && t.toggle ? t.toggle : t.fixed;
    return totalOptions({ total: t.total, ...pnl, toggle: toggle && !!t.toggle }, content, s);
  };
  const toggles = t?.toggle ? [true, false] : [false];
  type Pick = { total: TotalPlan | null; list: boolean; note: boolean; room: number };
  const tryFit = (): Pick | null => {
    for (const list of hasRows ? [true, false] : [false])
      for (const note of noteText ? [true, false] : [true])
        for (const toggle of toggles)
          for (const total of optionsFor(toggle)) {
            const room = avail - totalBlock(total) - (note ? noteH : 0);
            if (room >= (list ? listMin : 0)) return { total, list, note, room };
          }
    return null;
  };
  let pick = tryFit();
  if (!pick) {
    // 마지막: 전환 칸·목록·메모 없이, 합계 줄 여백 0 으로 가장 낮은 배치
    const lowest = optionsFor(false)
      .map((p) => (p ? { ...p, gapY: 0 } : p))
      .reduce((a, b) => (totalBlock(b) < totalBlock(a) ? b : a));
    pick = { total: lowest, list: false, note: false, room: avail - totalBlock(lowest) };
  }
  const note = pick.note ? noteText : null;
  // 메모를 뺐으면 갱신 실패는 머리 줄 기준 시각 자리에 (옛 값인지 알 수 있게)
  const header = planHeader(!pick.note && noteText && i.alert ? { ...i.header, sub: [i.alert, ...i.header.sub] } : i.header, i.width, s);
  let listH = pick.room;
  let index: IndexPlan<T> | null = null;
  // 종목이 있으면 목록이 한 줄 이상 남을 때만(compact 는 목록 자리), 종목이 없으면 빈 목록 안내 두 줄이 남을 때만
  const keep = hasRows ? (pick.list && size !== "compact" ? rows.rowH : null) : EMPTY_LINES * lineHeight(F.md, s);
  if (keep !== null && i.indices.length) {
    const plan = planIndexLine(i.indices, content, s, size === "large" ? 2 : 1);
    if (plan && listH - (plan.height + space.xs) >= keep) {
      index = plan;
      listH -= plan.height + space.xs;
    }
  }
  return { size, content, header, total: pick.total, index, note, list: pick.list, listH, rows };
}

// ── 다듬은 잔고 위젯 (widgetPolish) ──────────────────────────────────
/*
 * 같은 크기에 종목이 더 보이게 세로 빈칸을 줄인다 (4×2 330×230dp: 약 2.5줄 → 3.5줄).
 *  - ↻(48×48)를 합계 줄 오른쪽 끝으로 옮겨, 48dp 누르는 칸 둘(↻·손익 전환)을 한 줄(48dp)에 모은다.
 *    그래서 머리 줄(48dp)은 글자 높이만큼의 제목 줄(보유 17 · 관심 1 · 칩 · 기준 시각)이 된다 — 누르면 앱(합계와 같은 곳)
 *  - 지수 줄 아래 여백 0 (위의 48dp 합계 줄 안에 빈 곳이 있다), 목록 줄 위아래 여백 xs → xxs, 아래 여백 PAD(12) → sm(8)
 *  - 합계가 없으면(보유 종목 시세 없음·관심만) 예전처럼 48dp 머리 줄에 ↻
 * 누르는 칸: ↻·손익 전환은 그대로 48×48dp 이상. 제목 줄은 위 여백까지 누르는 칸이고 바로 아래 합계 칸과 같은 곳(잔고 탭)을 연다.
 * 종목 줄은 약 38dp 라 줄마다 다른 종목을 열지 않고 목록 전체를 한 칸으로 묶어 잔고 탭을 연다 (widgets.tsx POLISHED_ROW_URI)
 */

/** 제목 줄 위 여백 */
export const POLISH_TOP = space.sm;
/** 목록 아래 여백 (예전 PAD) */
export const POLISH_BOTTOM = space.sm;
/** 목록 한 줄 위아래 여백 (예전 space.xs) */
export const POLISH_ROW_PAD = space.xxs;
/** 손익 전환 칸 앞 표시: 누르면 누적 ↔ 오늘이 바뀐다는 뜻 */
export const PNL_GLYPH = "⇅";
/** 표시와 손익 글자 사이 */
export const GLYPH_GAP = space.xxs;
/** 합계와 ⇅ 사이 최소 간격 (⇅ 가 없으면 TOTAL_GAP) */
export const GLYPH_LEAD = space.xs;
/** 칩 위아래 여백 (widgets.tsx Chip 과 같다) */
export const CHIP_PAD_Y = space.xxs;

/** 칩 높이: 글자 + 위아래 여백 + 테두리 */
export function chipHeight(scale: number): number {
  return lineHeight(F.xs, scale) + CHIP_PAD_Y * 2 + 2;
}

/** 제목 줄 높이 (제목 글자와 칩 중 높은 쪽) */
export function titleLineHeight(scale: number): number {
  return Math.max(lineHeight(F.title, scale), chipHeight(scale));
}

export interface TitleInput {
  /** 제목 후보 (긴 것부터): "보유 17 · 관심 1" → "보유 17" */
  titles: string[];
  /** 칩 후보 (긴 것부터): "미국 주간거래 · 한국 휴장" → "미국 주간거래". 칩이 없으면 [] */
  chips: string[];
  /** 기준 시각 후보 (긴 것부터, asOfVariants). 갱신 중이면 ["갱신 중"], 메모를 뺐으면 맨 앞에 "갱신 실패" */
  sub: string[];
  delayed: boolean;
}

export interface TitlePlan {
  title: string;
  chip: string | null;
  sub: string | null;
  delayed: boolean;
}

/** 제목 줄 폭: 제목 · 칩 · 기준 시각 · 지연 + 간격 */
export function titleWidth(p: TitlePlan, scale: number): number {
  const parts = [textWidth(p.title, F.title, scale, true)];
  if (p.chip) parts.push(textWidth(p.chip, F.xs, scale, true) + CHIP_EXTRA);
  if (p.sub) parts.push(textWidth(p.sub, F.sm, scale));
  if (p.delayed) parts.push(textWidth("지연", F.sm, scale, true));
  return parts.reduce((a, b) => a + b, 0) + HEADER_GAP * (parts.length - 1);
}

/**
 * 좁을 때 버리는 값 (작을수록 먼저 버린다): 기준 시각의 "기준" 1 < 제목의 "· 관심 N" 2 < 칩의 둘째 시장 4 < 기준 시각의 날짜 5
 * < 칩 전체 8 < 기준 시각 전체 12. 제목(짧은 것)과 "지연"은 늘 남긴다
 */
const TITLE_COST = { title: [0, 2], chip: [0, 4], noChip: 8, sub: [0, 1, 5], noSub: 12 } as const;

/** 제목 줄: 폭(room)에 들어가는 조합 중 버리는 값이 가장 작은 것 (같으면 긴 제목·긴 칩·긴 기준 시각 쪽) */
export function planTitle(i: TitleInput, room: number, scale: number): TitlePlan {
  const chips = [...i.chips.map((c, k) => ({ c, cost: TITLE_COST.chip[Math.min(k, 1)]! })), { c: null, cost: TITLE_COST.noChip }];
  const subs = [...i.sub.map((s, k) => ({ s, cost: TITLE_COST.sub[Math.min(k, 2)]! })), { s: null, cost: TITLE_COST.noSub }];
  let best: TitlePlan | null = null;
  let bestCost = Infinity;
  for (let k = 0; k < i.titles.length; k++)
    for (const c of chips)
      for (const s of subs) {
        const plan: TitlePlan = { title: i.titles[k]!, chip: c.c, sub: s.s, delayed: i.delayed };
        const cost = TITLE_COST.title[Math.min(k, 1)]! + c.cost + s.cost;
        if (cost < bestCost && titleWidth(plan, scale) <= room) {
          best = plan;
          bestCost = cost;
        }
      }
  return best ?? { title: i.titles[i.titles.length - 1] ?? "", chip: null, sub: null, delayed: i.delayed };
}

/** 합계 줄 한 가지 배치 (다듬은 모습): 손익 칸 앞 ⇅ 표시, 오른쪽 끝 ↻ 칸(48×48) */
export interface TopLine extends TotalLine {
  /** 손익 전환 칸의 ⇅ (전환 칸일 때만 그린다) */
  glyph: string;
}

/** refresh: 합계 줄 오른쪽 끝에 ↻ 칸(48×48)을 둔다 (아니면 예전처럼 48dp 머리 줄에) */
function topPlan(i: TopLine, inline: boolean, totalFont: number, pnlFont: number, twoLines: boolean, scale: number, refresh: boolean): TotalPlan & { width: number } {
  const pnl = twoLines && i.rate ? [i.amount, i.rate] : [i.rate ? `${i.amount} ${i.rate}` : i.amount];
  const textW = Math.max(...pnl.map((l) => textWidth(l, pnlFont, scale, true)));
  const glyphW = i.toggle ? textWidth(i.glyph, pnlFont, scale, true) + GLYPH_GAP : 0;
  const pnlPadX = i.toggle ? Math.max(0, Math.ceil((TOUCH - textW - glyphW) / 2)) : 0;
  const pnlW = textW + glyphW + pnlPadX * 2;
  const linesH = pnl.length * lineHeight(pnlFont, scale);
  const pnlH = i.toggle ? Math.max(TOUCH, linesH) : linesH;
  const tW = textWidth(i.total, totalFont, scale, true);
  const tLine = lineHeight(totalFont, scale);
  // ↻ 칸(48dp)이 같은 줄에 있으면 줄은 48dp 이상. 48dp 칸이 있는 줄은 위아래 여백을 두지 않는다 (칸 안에 빈 곳이 있다)
  const min = refresh ? TOUCH : 0;
  const height = inline ? Math.max(tLine, pnlH, min) : Math.max(tLine + pnlH, min);
  return {
    inline,
    totalFont,
    pnlFont,
    pnl,
    pnlPadX,
    pnlH,
    totalH: inline ? height : tLine,
    height,
    toggle: i.toggle,
    gapY: refresh || i.toggle ? 0 : space.xs,
    // ⇅ 가 합계와 손익 사이를 갈라 주므로 그 앞 최소 간격은 GLYPH_LEAD (그리는 쪽은 양 끝 정렬이라 남는 폭은 이 사이로 간다).
    // 8dp 를 두면 300dp·글자 130% 에서 ⇅ 때문에 합계가 두 줄로 내려가 예전보다 종목이 덜 보였다
    width: (inline ? tW + (glyphW ? GLYPH_LEAD : TOTAL_GAP) + pnlW : Math.max(tW, pnlW)) + (refresh ? TOTAL_GAP + TOUCH : 0),
  };
}

/**
 * 합계 줄 후보 (다듬은 모습, 앞의 것이 더 좋은 배치): totalOptions 와 같은 순서 (+ 오른쪽 ↻ 칸이면 그 폭).
 * 하나도 안 들어가면 합계 아래로 내리고 글자를 칸에 맞게
 */
export function topOptions(i: TopLine, width: number, scale: number, refresh = true): TotalPlan[] {
  const [big, mid, small] = TOTAL_FONTS;
  const tries: [boolean, number, number, boolean][] = [
    [true, big, F.md, false],
    [true, big, F.md, true],
    [true, mid, F.md, true],
    [true, small, F.sm, true],
    [true, small, F.xs, true],
    [false, big, F.md, false],
    [false, big, F.sm, false],
    [false, big, F.sm, true],
    [false, mid, F.xs, true],
    [false, small, F.sm, false],
    [false, small, F.xs, false],
    [false, small, F.xs, true],
  ];
  const out: TotalPlan[] = [];
  for (const [inline, tf, pf, two] of tries) {
    const p = topPlan(i, inline, tf, pf, two, scale, refresh);
    if (p.width <= width) out.push(strip(p));
  }
  if (out.length) return out;
  const room = width - (refresh ? TOTAL_GAP + TOUCH : 0);
  const tf = fitFont(i.total, room, F.big, scale, true);
  const lines = i.rate ? [i.amount, i.rate] : [i.amount];
  const glyph = i.toggle ? textWidth(i.glyph, F.xs, scale, true) + GLYPH_GAP : 0;
  const pf = Math.min(...lines.map((l) => fitFont(l, room - glyph, F.xs, scale, true)));
  return [strip(topPlan(i, false, tf, pf, true, scale, refresh))];
}

export interface PolishedInput<T extends IndexInput = IndexInput> {
  width: number;
  height: number;
  scale: number;
  title: TitleInput;
  total: TotalInput | null;
  /** 지수 줄 항목 (계좌 비중 순서, 플래그가 꺼져 있거나 서버가 주지 않으면 빈 배열) */
  indices: T[];
  rows: RowInput[];
  /** 종목 줄 등락률 앞 작은 글자 ("오늘") */
  rowLabel: string;
  note: string[];
  alert: string | null;
}

export interface PolishedPlan<T extends IndexInput = IndexInput> {
  size: SizeClass;
  content: number;
  /**
   * 제목 줄 + 합계 줄(↻ 포함) 모양. false 면 예전처럼 48dp 머리 줄에 ↻ — 합계가 없을 때, 또는 큰 글자·좁은 폭에서
   * ↻ 를 넣으면 합계 줄이 두 줄로 내려가 더 높아질 때 (48dp 머리 줄 + 한 줄 합계가 더 낮다)
   */
  compact: boolean;
  title: TitlePlan;
  total: TotalPlan | null;
  index: IndexPlan<T> | null;
  note: string | null;
  list: boolean;
  listH: number;
  rows: RowsPlan;
}

/** 다듬은 지수 줄을 두 줄로 쓰는 위젯: 두 줄을 넣고도 종목이 이만큼 넘게 보일 때 (4×3 이상. 4×2 는 한 줄) */
export const INDEX_TWO_LINE_ROWS = 4;
/** 다듬은 지수 줄을 넣는 위젯: 넣고도 종목이 이만큼 넘게 보일 때 (예전 모습은 한 줄) */
export const INDEX_MIN_ROWS = 1.5;

/** 다듬은 모습의 목록을 넣을 최소 높이: 첫 줄의 이름·가격 줄이 보일 만큼 */
export function polishedListMin(scale: number): number {
  return POLISH_ROW_PAD + 1 + lineHeight(F.base, scale);
}

/** 제목 줄(위 여백 포함) 또는 48dp 머리 줄 높이 */
export function polishedHeadHeight(compact: boolean, scale: number): number {
  return compact ? POLISH_TOP + titleLineHeight(scale) : TOUCH;
}

/**
 * 다듬은 잔고 위젯 배치 (planHoldings 와 같은 규칙: 숫자는 자르지 않고, 높이가 모자라면 목록 > 메모 > 손익 전환 칸 순으로 지킨다).
 * 세로 순서: [제목 줄 → 합계 줄(↻)] 또는 [48dp 머리 줄(↻) → 합계 줄] → [지수 줄] → [메모] → 목록 (아래 여백 POLISH_BOTTOM).
 * 합계 줄은 들어가는 후보 중 목록 자리가 가장 큰 것 (같으면 앞의 것): ↻ 를 합계 줄에 둔 한 줄 배치 → 48dp 머리 줄 + 한 줄 합계 → 합계 아래로 내린 배치.
 * 예전 모습과 같은 모양(48dp 머리 줄 + 한 줄 합계)도 후보라 같은 크기·글자에서 예전보다 목록이 줄지 않는다 (검증 지적: 330×180 130% — test/widgetLayout 전수 검사).
 * 지수 줄은 compact(낮은 위젯) 크기가 아니고 넣은 뒤에도 목록이 INDEX_MIN_ROWS 줄 넘게 보일 때만 (planPolishedIndex — 좁으면 덜 중요한 것부터 빼고
 * 시장마다 하나 + 원/달러를 남긴다). 두 줄을 넣고도 목록이 INDEX_TWO_LINE_ROWS 줄 넘게 보이는 큰 위젯은 두 줄까지
 */
export function planHoldingsPolished<T extends IndexInput>(i: PolishedInput<T>): PolishedPlan<T> {
  const s = i.scale;
  const size = listSize(i.height);
  const content = i.width - PAD * 2;
  const rows = planRowsPolished(i.rows, content, s, i.rowLabel);
  const noteText = fitJoin(i.note, content, F.sm, s);
  const noteH = noteText ? lineHeight(F.sm, s) : 0;
  const t = i.total;
  const hasRows = i.rows.length > 0;
  const listMin = polishedListMin(s);
  type Opt = { total: TotalPlan | null; compact: boolean };
  /** 머리(제목 줄 또는 48dp 머리 줄) + 합계 줄 */
  const headOf = (o: Opt) => polishedHeadHeight(o.compact, s) + totalBlock(o.total);
  const optionsFor = (toggle: boolean): Opt[] => {
    if (!t) return [{ total: null, compact: false }];
    const line = { total: t.total, ...(toggle && t.toggle ? t.toggle : t.fixed), toggle: toggle && !!t.toggle, glyph: PNL_GLYPH };
    // ↻ 를 합계 줄에 두면 왼쪽 여백만 (↻ 칸이 오른쪽 끝에 붙는다), 머리 줄에 두면 좌우 여백
    const compact = topOptions(line, i.width - PAD, s, true).map((total) => ({ total, compact: true }));
    const classic = topOptions(line, content, s, false).map((total) => ({ total, compact: false }));
    const inline = (o: Opt) => o.total?.inline === true;
    return [...compact.filter(inline), ...classic.filter(inline), ...compact.filter((o) => !inline(o)), ...classic.filter((o) => !inline(o))];
  };
  const toggles = t?.toggle ? [true, false] : [false];
  type Pick = Opt & { list: boolean; note: boolean; room: number };
  const tryFit = (): Pick | null => {
    for (const list of hasRows ? [true, false] : [false])
      for (const note of noteText ? [true, false] : [true])
        for (const toggle of toggles) {
          // 들어가는 배치 중 목록 자리가 가장 큰 것 (같으면 앞의 것 — 한 줄 · ↻ 를 합계 줄에). 예전 모습과 같은 모양(48dp 머리 줄 + 한 줄 합계)도 후보다
          let best: Pick | null = null;
          for (const o of optionsFor(toggle)) {
            const room = i.height - POLISH_BOTTOM - headOf(o) - (note ? noteH : 0);
            if (room >= (list ? listMin : 0) && (!best || room > best.room)) best = { ...o, list, note, room };
          }
          if (best) return best;
        }
    return null;
  };
  let pick = tryFit();
  if (!pick) {
    // 마지막: 전환 칸·목록·메모 없이 가장 낮은 배치
    const lowest = optionsFor(false).reduce((a, b) => (headOf(b) < headOf(a) ? b : a));
    pick = { ...lowest, list: false, note: false, room: i.height - POLISH_BOTTOM - headOf(lowest) };
  }
  const compact = pick.compact;
  const note = pick.note ? noteText : null;
  // 메모를 뺐으면 갱신 실패는 제목 줄 기준 시각 자리에
  const titleIn = !pick.note && noteText && i.alert ? { ...i.title, sub: [i.alert, ...i.title.sub] } : i.title;
  const title = planTitle(titleIn, compact ? content : headerRoom(i.width), s);
  let listH = pick.room;
  let index: IndexPlan<T> | null = null;
  // 지수 줄을 넣어도 종목이 INDEX_MIN_ROWS 줄 넘게 보일 때만 (낮은 위젯·큰 글자에서 예전보다 종목이 덜 보이지 않게 — 검증 지적 330×180 130%)
  const keep = hasRows ? (pick.list && size !== "compact" ? INDEX_MIN_ROWS * rows.rowH : null) : EMPTY_LINES * lineHeight(F.md, s);
  if (keep !== null && i.indices.length) {
    // 한 줄. 두 줄로 다 넣어도 종목이 INDEX_TWO_LINE_ROWS 줄 넘게 보이는 큰 위젯(4×3 이상)만 두 줄까지
    const two = hasRows ? planPolishedIndex(i.indices, content, s, 2) : null;
    const one = planPolishedIndex(i.indices, content, s, 1);
    const plan = two && two.lines.flat().length > (one?.lines.flat().length ?? 0) && listH - two.height >= INDEX_TWO_LINE_ROWS * rows.rowH ? two : one;
    if (plan && listH - plan.height >= keep) {
      index = plan;
      listH -= plan.height;
    }
  }
  return { size, content, compact, title, total: pick.total, index, note, list: pick.list, listH, rows };
}

// ── 브리핑 위젯 ───────────────────────────────────────────────────────

export interface BriefingPlan {
  size: SizeClass;
  header: HeaderPlan;
  /** 보여 줄 종목 수 (0~3) */
  items: number;
  /**
   * 한 종목 칸: "full" = 이름·날짜 줄 + 요약(summaryLines 줄),
   * "line" = 낮은 위젯에서 이름과 요약을 한 줄에 (날짜는 뺀다 — 자르지 않는다)
   */
  item: "full" | "line";
  /** 요약 줄 수 (large 에서 칸이 남으면 2) */
  summaryLines: 1 | 2;
  /** 종목이 없거나 조회에 실패했을 때 안내 문구 줄 수 (1~3) */
  messageLines: number;
  /** 안내 문구 위 여백 */
  messageGap: number;
}

/** 브리핑 한 종목 칸 높이 (flexGap 포함) */
export function briefingItemHeight(item: "full" | "line", summaryLines: number, scale: number): number {
  if (item === "line") return lineHeight(F.base, scale) + space.xxs;
  return lineHeight(F.sm, scale) + summaryLines * lineHeight(F.base, scale) + space.xxs;
}

/** 브리핑 위젯 고지 한 줄이 차지하는 높이 (위 여백 포함) */
export function disclaimerHeight(scale: number): number {
  return lineHeight(F.xs, scale) + space.xs;
}

/** 머리 줄·고지 줄·아래 여백을 뺀, 종목 칸(또는 안내 문구)에 쓸 수 있는 높이. 어림 오차를 space.xs 만큼 더 남긴다 */
export function briefingRoom(height: number, scale: number): number {
  return height - TOUCH - PAD - disclaimerHeight(scale) - space.xs;
}

/**
 * 브리핑 위젯: 고지 한 줄은 늘 들어가게 종목 칸 수·모양을 고른다.
 * large 에서 칸이 남으면 요약 두 줄, 한 종목(이름 줄 + 요약)도 안 들어가면 이름·요약 한 줄 모양, 그것도 안 되면 0개
 */
export function planBriefing(i: { width: number; height: number; scale: number; header: HeaderInput; count: number }): BriefingPlan {
  const s = i.scale;
  const size = listSize(i.height);
  const header = planHeader(i.header, i.width, s);
  const room = briefingRoom(i.height, s);
  const want = Math.min(3, Math.max(0, i.count));
  let item: "full" | "line" = "full";
  let summaryLines: 1 | 2 = 1;
  if (size === "large" && want && want * briefingItemHeight("full", 2, s) <= room) summaryLines = 2;
  else if (briefingItemHeight("full", 1, s) > room) item = "line";
  const items = Math.max(0, Math.min(want, Math.floor(room / briefingItemHeight(item, summaryLines, s))));
  // 안내 문구: 위 여백(space.s)과 함께 들어가는 줄 수. 한 줄도 여백과 함께 안 들어가면 여백 없이 한 줄
  const mLine = lineHeight(F.md, s);
  const withGap = Math.floor((room - space.s) / mLine);
  const messageLines = Math.max(1, Math.min(3, withGap));
  const messageGap = withGap >= 1 ? space.s : 0;
  return { size, header, items, item, summaryLines, messageLines, messageGap };
}

// ── 자산 위젯 (2×1) ───────────────────────────────────────────────────

export interface AssetInput {
  width: number;
  height: number;
  scale: number;
  /** "총 평가" */
  label: string;
  chip: string | null;
  /** 기준 시각을 긴 것부터 ("지연 · 15:30 기준" …) */
  asOf: string[];
  total: string | null;
  /** "오늘 +1,234,567원" / 값만 "+1,234,567원" */
  day: { text: string; value: string } | null;
  /** "총 -12,345,678원" */
  cum: string | null;
  note: string[];
}

export type AssetLineMode = "both" | "day" | "dayValue" | null;

export interface AssetPlan {
  size: SizeClass;
  pad: number;
  top: { label: boolean; chip: boolean; asOf: string | null } | null;
  totalFont: number;
  line: AssetLineMode;
  lineFont: number;
  note: string | null;
}

/** 오늘 · 총 사이 간격 (위젯의 flexGap) */
const ASSET_SEP = space.xs;

/**
 * 자산 위젯: 합계는 칸에 맞게 글자를 줄이고(최대 19), 아랫줄은 [오늘 · 총] → [오늘] → [오늘 값만] 순으로 들어가는 첫 배치.
 * 높이가 모자라면 아래쪽(메모 → 윗줄 → 손익 줄) 순으로 뺀다 (2×1 최소 높이 확장은 APK, 3-28)
 */
export function planAsset(i: AssetInput): AssetPlan {
  const size = assetSize(i.width);
  const pad = size === "compact" ? space.sm : PAD;
  const content = i.width - pad * 2;
  const s = i.scale;
  // 윗줄: [총 평가 · 칩] … [기준 시각]
  const labelW = textWidth(i.label, F.sm, s, true);
  const chipW = i.chip ? textWidth(i.chip, F.xs, s, true) + CHIP_EXTRA : 0;
  const tops: NonNullable<AssetPlan["top"]>[] = [];
  for (const asOf of i.asOf) {
    if (i.chip && size !== "compact") tops.push({ label: true, chip: true, asOf });
    tops.push({ label: true, chip: false, asOf });
  }
  for (const asOf of i.asOf) tops.push({ label: false, chip: false, asOf });
  tops.push({ label: true, chip: false, asOf: null });
  const top =
    tops.find((t) => {
      const left = (t.label ? labelW : 0) + (t.chip ? space.xs + chipW : 0);
      const right = t.asOf ? textWidth(t.asOf, F.xs, s) : 0;
      return left + (left && right ? space.xs : 0) + right <= content;
    }) ?? null;
  const totalFont = i.total ? fitFont(i.total, content, F.bigger, s, true) : F.bigger;
  let line: AssetLineMode = null;
  let lineFont: number = F.sm;
  if (i.day) {
    const both = i.cum ? textWidth(i.day.text, F.sm, s, true) + ASSET_SEP + textWidth("·", F.sm, s) + ASSET_SEP + textWidth(i.cum, F.sm, s, true) : Infinity;
    const tries: [AssetLineMode, number, number][] = [
      ["both", F.sm, both],
      ["both", F.xs, i.cum ? textWidth(i.day.text, F.xs, s, true) + ASSET_SEP + textWidth("·", F.xs, s) + ASSET_SEP + textWidth(i.cum, F.xs, s, true) : Infinity],
      ["day", F.sm, textWidth(i.day.text, F.sm, s, true)],
      ["day", F.xs, textWidth(i.day.text, F.xs, s, true)],
      ["dayValue", F.xs, textWidth(i.day.value, F.xs, s, true)],
    ];
    const hit = tries.find(([, , w]) => w <= content);
    if (hit) [line, lineFont] = [hit[0], hit[1]];
  }
  const note = fitJoin(i.note, content, F.xs, s);
  // 높이: 합계는 늘, 그다음 손익 줄 → 윗줄 → 메모
  let room = i.height - space.s * 2 - lineHeight(totalFont, s);
  const take = (h: number) => {
    if (h > room) return false;
    room -= h;
    return true;
  };
  const keepLine = line ? take(lineHeight(lineFont, s)) : false;
  const keepTop = top ? take(lineHeight(F.sm, s)) : false;
  const keepNote = note ? take(lineHeight(F.xs, s)) : false;
  return { size, pad, top: keepTop ? top : null, totalFont, line: keepLine ? line : null, lineFont, note: keepNote ? note : null };
}

// ── 지수·환율 위젯 (APK 1.4.0) ───────────────────────────────────────

/** 이름 옆 표시 (입력): 장중 초록 점 · 지연(출처 조회 실패로 마지막 값) · 없음 */
export type TileMarker = "live" | "stale" | null;

export interface BoardTileInput {
  code: string;
  label: string;
  /** "7,080.92" · "-" */
  value: string;
  /** 등락 줄 후보를 긴 것부터 ("▲63.01 +0.90%" → "+0.90%"). 값이 없으면 빈 배열 */
  changes: string[];
  marker: TileMarker;
}

export interface BoardColumnInput {
  key: string;
  /** "국내" · "미국" · "환율" */
  label: string;
  tiles: BoardTileInput[];
}

export interface MarketInput {
  width: number;
  height: number;
  scale: number;
  title: string;
  /** 제목 옆 글자 후보를 긴 것부터 (기준 시각 · "갱신 중" · "갱신 실패 …"). 없으면 [] */
  sub: string[];
  /** 구역(세로 칸): 국내 · 미국 · 환율. 빈 배열이면 판 없이 안내 문구만 */
  columns: BoardColumnInput[];
}

/**
 * 칸 모양:
 *  - full   = 이름 / 값 / 등락 줄 ("▲63.01 +0.90%", 한 칸이라도 안 들어가면 모두 등락률만)
 *  - inline = 이름 ··· 등락률 / 값 — 두 줄이라 4×3 처럼 칸이 많고 낮아도 등락률이 보인다
 *  - brief  = 이름 ··· ▲/▼ / 값 — 방향만(값의 색과 함께, 그것도 안 들어가면 색으로만). 등락률이 들어가는 배치가 하나도 없을 때만 (좁은 4×3 · 큰 글자)
 * inline·brief 의 지연 항목은 오른쪽 자리에 "지연" (안 들어가면 이름 뒤 경고색 점)
 */
export type TileShape = "full" | "inline" | "brief";

/**
 * 그릴 때 표시: 장중 초록 점(이름 뒤) · "지연" 글자(full 은 이름 뒤, inline·brief 는 오른쪽 자리) ·
 * 지연 점(경고색, 이름 뒤 — "지연" 글자가 안 들어갈 때, 앱 지수 띠와 같은 모양) · 없음
 */
export type TileMark = "live" | "staleText" | "staleDot" | null;

export interface MarketPlan {
  size: SizeClass;
  /** 제목 옆 글자 (들어가는 것 중 가장 긴 것, 없으면 null) */
  sub: string | null;
  shape: TileShape;
  /** 구역 이름 줄 (국내 · 미국 · 환율) */
  captions: boolean;
  /**
   * 구역마다 보여 줄 항목(위에서 아래로)과 글자 폭(구분선·여백 뺀 폭, 정수). 4×3 이상은 9개 모두, 4×2 는 구역마다 2개(3×2 격자), 더 낮으면 1개.
   * 폭은 구역마다 필요한 만큼(가장 긴 줄) 주고 남는 폭은 되도록 고르게 나눈다 — 이름이 긴 미국 구역이 조금 넓을 수 있다
   */
  columns: { key: string; label: string; codes: string[]; width: number }[];
  nameFont: number;
  valueFont: number;
  changeFont: number;
  /** 항목별 이름 칸 폭: 이름이 다 들어가면 null(글자 폭대로 — 표시가 이름 바로 뒤에 붙는다), 줄여야 하면(…) 그 폭 */
  nameW: Record<string, number | null>;
  /** 항목별 표시 (장중 점 · "지연" · 지연 점) */
  mark: Record<string, TileMark>;
  /** 항목별 등락: full 은 셋째 줄, inline 은 이름 줄 오른쪽 등락률, brief 는 오른쪽 ▲/▼. 값이 없거나 보합(brief)·inline·brief 의 지연 항목이면 null */
  change: Record<string, string | null>;
  /** 한 칸 높이 어림 */
  tileH: number;
  /** 같은 구역 안 칸 사이 구분선의 위아래 여백 (간격 토큰 단계, 남는 높이만큼 넓힌다) */
  rowPad: number;
  /** 구역 이름 줄 아래 여백 (간격 토큰 단계) */
  captionGap: number;
  /** 본문(구역 이름 줄 + 칸들) 높이 어림 */
  bodyH: number;
  /** 본문에 쓸 수 있는 높이 (머리 줄·아래 여백·테두리 뺀 높이) */
  room: number;
  /** 판이 없을 때(플래그 꺼짐·불러오지 못함) 안내 문구 줄 수 */
  messageLines: number;
}

/** 칸 사이: 구분선(1dp) 양옆 여백 */
export const BOARD_GAP = space.sm;
/** 같은 구역 칸 사이 구분선의 위아래 여백 단계 (간격 토큰, 작은 것부터). 남는 높이가 있으면 큰 단계로 — 본문이 위로 몰리지 않게 */
export const BOARD_ROW_PADS = [space.xxs, space.xs, space.s, space.sm, space.md] as const;
/** 구역 이름 줄 아래 여백 단계 (간격 토큰) */
export const CAPTION_GAPS = [space.xs, space.sm] as const;
/** 이름 옆 표시(장중 점·"지연") 앞 간격 */
export const MARKER_GAP = space.xs;
/** inline·brief 칸: 이름(과 점)과 오른쪽 글자 사이 최소 간격 */
export const INLINE_GAP = space.xs;
/** 출처 조회가 실패한 항목 표시 */
export const STALE_TEXT = "지연";
const HAIR = BOARD.hairline;
/** 카드 테두리 (라이트에서만 보이지만 두 벌의 배치가 같게 여백은 늘 잡는다) */
const EDGE = BOARD.border;

/** 본문 폭: 좌우 여백·테두리 뺀 폭 */
export function boardContent(width: number): number {
  return width - PAD * 2 - EDGE * 2;
}

/** 구역 n 개의 글자 폭 합: 본문 폭에서 구역 사이 구분선과 양옆 여백을 뺀다 */
export function boardTextRoom(width: number, n: number): number {
  return boardContent(width) - Math.max(0, n - 1) * (BOARD_GAP * 2 + HAIR);
}

/** 본문에 쓸 수 있는 높이: 머리 줄(48dp, ↻ 칸) · 아래 여백 · 위아래 테두리를 뺀다 */
export function boardRoom(height: number): number {
  return height - TOUCH - PAD - EDGE * 2;
}

/** 한 칸을 그리는 방법 (폭 어림·테스트가 같은 입력을 쓴다) */
export interface TileDraw {
  shape: TileShape;
  mark: TileMark;
  change: string | null;
  nameFont: number;
  valueFont: number;
  changeFont: number;
  /** 이름 칸 폭 (null·없음 = 이름 글자 폭 그대로) */
  nameW?: number | null;
}

/**
 * 한 칸에 필요한 글자 폭 = 가장 긴 줄 (이름 줄 · 값 줄 · 등락 줄). 칸의 글자는 모두 굵게 어림한다.
 * measure 는 배치 계산이 같은 어림을 기억해 두고 쓰려는 것 (기본은 textWidth 굵게)
 */
export function boardTileWidth(t: BoardTileInput, d: TileDraw, scale: number, measure: (text: string, font: number) => number = (x, f) => textWidth(x, f, scale, true)): number {
  const name = d.nameW ?? measure(t.label, d.nameFont);
  const value = measure(t.value, d.valueFont);
  if (d.shape === "full") {
    const mark = d.mark === "staleText" ? measure(STALE_TEXT, d.nameFont) + MARKER_GAP : d.mark ? BOARD.dot + MARKER_GAP : 0;
    return Math.max(name + mark, value, d.change ? measure(d.change, d.changeFont) : 0);
  }
  // inline·brief: 이름(+점) ··· 오른쪽(등락률 · ▲/▼ · "지연")
  const dot = d.mark === "live" || d.mark === "staleDot" ? BOARD.dot + MARKER_GAP : 0;
  const right = d.mark === "staleText" ? STALE_TEXT : d.change;
  return Math.max(name + dot + (right ? INLINE_GAP + measure(right, d.nameFont) : 0), value);
}

/** 한 칸 높이: 이름 줄 + 값 줄 (+ full 의 등락 줄). inline·brief 의 오른쪽 글자는 이름 줄에 같은 글자 크기로 들어간다 */
export function boardTileHeight(shape: TileShape, nameFont: number, valueFont: number, changeFont: number, scale: number): number {
  return lineHeight(nameFont, scale) + lineHeight(valueFont, scale) + (shape === "full" ? lineHeight(changeFont, scale) : 0);
}

/** 구역 이름 줄 높이 (아래 여백 포함) */
export function captionHeight(scale: number, gap: number = CAPTION_GAPS[0]): number {
  return lineHeight(F.xs, scale) + gap;
}

/** 본문 높이: [구역 이름 줄] + 가장 긴 구역의 칸들 + 칸 사이 구분선(위아래 여백 포함) */
export function boardBodyHeight(rows: number, tileH: number, rowPad: number, captions: boolean, scale: number, captionGap: number = CAPTION_GAPS[0]): number {
  return (captions ? captionHeight(scale, captionGap) : 0) + rows * tileH + Math.max(0, rows - 1) * (rowPad * 2 + HAIR);
}

/** 머리 왼쪽 묶음(금색 막대·제목·기준 시각) 폭 */
export function marketHeaderWidth(title: string, sub: string | null, scale: number): number {
  return BOARD.mark.width + HEADER_GAP + textWidth(title, F.title, scale, true) + (sub ? HEADER_GAP + textWidth(sub, F.sm, scale) : 0);
}

/** 머리 왼쪽 묶음에 쓸 수 있는 폭 (오른쪽 ↻ 칸 48dp, 테두리 제외) */
export function marketHeaderRoom(width: number): number {
  return headerRoom(width) - EDGE * 2;
}

/**
 * 구역 폭 나누기: 필요한 폭(올림)은 꼭 주고, 남는 폭은 넓게 필요한 구역부터 고정한 뒤 나머지를 똑같이 (되도록 고른 폭).
 * 필요한 폭의 합이 total 이하일 때만 부른다. 합은 total 이하, 모두 정수
 */
export function spreadWidths(needs: readonly number[], total: number): number[] {
  const want = needs.map((w) => Math.ceil(w));
  let rest = total;
  let k = want.length;
  for (const w of [...want].sort((a, b) => b - a)) {
    if (w <= rest / k) break;
    rest -= w;
    k--;
  }
  const even = k ? Math.floor(rest / k) : 0;
  return want.map((w) => Math.max(w, even));
}

/**
 * 배치 점수(값 글자 sp 로 환산한 가산점): 구역 이름 줄은 값 글자 3sp, 자세한 등락(full 의 등락폭 ▲63.01 · brief 의 ▲/▼)은 1·2sp,
 * "지연" 글자(점 대신)는 2sp 만큼과 바꾼다
 */
const CAPTION_BONUS = 3;
const DETAIL_BONUS: Record<TileShape, number> = { full: 1, inline: 0, brief: 2 };
const STALE_TEXT_BONUS = 2;

/**
 * 배치 후보를 보는 순서 (같은 점수면 앞의 것 — 더 많은 정보).
 * detail: full 은 등락 줄을 "▲63.01 +0.90%" 로(아니면 등락률만), brief 는 오른쪽에 ▲/▼ (아니면 색으로만)
 */
const LAYOUTS: readonly { shape: TileShape; detail: boolean; captions: boolean }[] = [
  { shape: "full", detail: true, captions: true },
  { shape: "inline", detail: false, captions: true },
  { shape: "full", detail: true, captions: false },
  { shape: "inline", detail: false, captions: false },
  { shape: "full", detail: false, captions: true },
  { shape: "full", detail: false, captions: false },
  { shape: "brief", detail: true, captions: true },
  { shape: "brief", detail: true, captions: false },
  { shape: "brief", detail: false, captions: true },
  { shape: "brief", detail: false, captions: false },
];

/** 표시: 지연 항목은 "지연" 글자(full 은 이름 뒤, inline·brief 는 오른쪽 자리), 안 들어가면 이름 뒤 경고색 점 */
function tileMark(t: BoardTileInput, staleText: boolean): TileMark {
  if (t.marker === "live") return "live";
  if (t.marker === "stale") return staleText ? "staleText" : "staleDot";
  return null;
}

function tileChange(t: BoardTileInput, shape: TileShape, detail: boolean): string | null {
  if (!t.changes.length) return null;
  if (shape === "full") return t.changes[detail ? 0 : t.changes.length - 1]!;
  // inline·brief 의 지연 항목은 오른쪽 자리를 "지연"(또는 비움)으로 — 마지막 값의 등락보다 지연이 먼저
  if (t.marker === "stale") return null;
  if (shape === "inline") return t.changes[t.changes.length - 1]!;
  if (!detail) return null;
  // brief: 방향만 ("▲63.01 +0.90%" 의 첫 글자, 보합이면 없음)
  const arrow = t.changes[0]!.charAt(0);
  return arrow === "▲" || arrow === "▼" ? arrow : null;
}

interface BoardCandidate {
  score: number;
  shape: TileShape;
  detail: boolean;
  captions: boolean;
  staleText: boolean;
  nameFont: number;
  changeFont: number;
  valueFont: number;
  depth: number;
}

/**
 * 지수·환율 위젯 배치 (숫자는 자르지 않는다). 구역이 세로 칸(국내 | 미국 | 환율)이고 같은 줄의 칸은 높이가 같다.
 *  - 보여 줄 개수: large(4×3 이상)는 9개 모두 → 구역마다 2개(4×2 의 3×2 격자) → 1개(코스피·나스닥·원/달러)
 *  - 같은 개수 안에서는 점수가 가장 높은 배치: 점수 = 값 글자(sp) + 구역 이름 3 + 등락폭(▲63.01) 1 · brief 의 ▲/▼ 2 + "지연" 글자 2.
 *    등락률이 보이는 full · inline 을 먼저 보고, 어느 것도 들어가지 않을 때만 brief (▲/▼ 방향만, 그것도 안 되면 색으로만)
 *  - 값 글자가 comfort(12sp) 이상인 첫 배치 → 없으면 min(9sp) → 없으면 1sp (있을 수 없을 만큼 긴 값). 4×3 이상은 9개 모두가 먼저
 *  - 이름은 줄이지 않는다("S&P5…"·"원/…"처럼 다른 이름으로 읽히지 않게). 지연 항목은 "지연" 글자가 안 들어가면 경고색 점
 *  - 값 글자는 모든 칸이 같은 크기. 남는 높이는 칸 사이·구역 이름 아래 여백으로 (간격 토큰 단계)
 */
export function planMarket(i: MarketInput): MarketPlan {
  const s = i.scale;
  const size = listSize(i.height);
  const room = boardRoom(i.height);
  const hRoom = marketHeaderRoom(i.width);
  const sub = i.sub.find((x) => marketHeaderWidth(i.title, x, s) <= hRoom) ?? null;
  const messageLines = Math.max(1, Math.min(3, Math.floor(room / lineHeight(F.md, s))));
  const base = { size, sub, room, messageLines };
  const n = i.columns.length;
  if (!n) {
    return { ...base, shape: "brief", captions: false, columns: [], nameFont: F.xs, valueFont: F.xs, changeFont: F.xs, nameW: {}, mark: {}, change: {}, tileH: 0, rowPad: BOARD_ROW_PADS[0], captionGap: CAPTION_GAPS[0], bodyH: 0 };
  }
  const total = boardTextRoom(i.width, n);
  const deepest = Math.max(...i.columns.map((c) => c.tiles.length));
  const depths = [...new Set((size === "large" ? [deepest, 2, 1] : [2, 1]).map((d) => Math.min(d, deepest)))];
  // 큰 위젯은 이름·등락 글자를 한 단계 크게까지 (남는 높이를 빈칸으로 두지 않게)
  const fonts = size === "large" ? [F.md, F.sm, F.xs] : [F.sm, F.xs];
  const colsAt = (depth: number) => i.columns.map((c) => ({ ...c, tiles: c.tiles.slice(0, depth) }));
  // 후보가 많아 같은 글자를 여러 번 잰다: 글자 폭 합(em)을 기억해 두고 textWidth(굵게)와 같은 식으로
  const ems = new Map<string, number>();
  const em = (text: string) => {
    let e = ems.get(text);
    if (e === undefined) ems.set(text, (e = textEm(text)));
    return e;
  };
  const measure = (text: string, font: number) => em(text) * font * s * BOLD + SLACK;
  /** 구역마다 필요한 글자 폭: 구역 이름 · 칸마다 가장 긴 줄 (boardTileWidth) */
  const needsOf = (cols: BoardColumnInput[], c: Omit<BoardCandidate, "score" | "depth">): number[] =>
    cols.map((col) =>
      Math.max(
        c.captions ? measure(col.label, F.xs) : 0,
        ...col.tiles.map((t) => boardTileWidth(t, { shape: c.shape, mark: tileMark(t, c.staleText), change: tileChange(t, c.shape, c.detail), nameFont: c.nameFont, valueFont: c.valueFont, changeFont: c.changeFont }, s, measure)),
      ),
    );
  const fits = (needs: number[]) => needs.reduce((a, w) => a + Math.ceil(w), 0) <= total;

  /** 한 개수(depth)의 모든 후보: 배치 × 지연 표시 × 이름·등락 글자마다 값 글자가 가장 큰 것 */
  const candidates = (depth: number): BoardCandidate[] => {
    const cols = colsAt(depth);
    const tiles = cols.flatMap((c) => c.tiles);
    const rows = Math.max(...cols.map((c) => c.tiles.length));
    const hasStale = tiles.some((t) => t.marker === "stale");
    // 구역마다 가장 긴 값 (값 줄 폭은 크기마다 이것으로)
    const valueEm = cols.map((col) => Math.max(0, ...col.tiles.map((t) => em(t.value))));
    const out: BoardCandidate[] = [];
    for (const L of LAYOUTS)
      for (const staleText of hasStale ? [true, false] : [true])
        for (const nameFont of fonts)
          for (const changeFont of L.shape === "full" ? fonts : [nameFont]) {
            const c = { ...L, staleText, nameFont, changeFont };
            // 값 줄을 뺀 폭 (값 글자 없이도 모자라면 — 이름·등락이 김 — 이 조합은 안 된다). 값 줄은 크기마다 더한다
            const fixed = needsOf(cols, { ...c, valueFont: 0 });
            if (!fits(fixed)) continue;
            for (let v = BOARD.value.max; v >= 1; v--) {
              const tileH = boardTileHeight(L.shape, nameFont, v, changeFont, s);
              if (boardBodyHeight(rows, tileH, BOARD_ROW_PADS[0], L.captions, s) > room) continue;
              if (!fits(fixed.map((f, k) => Math.max(f, valueEm[k]! * v * s * BOLD + SLACK)))) continue;
              const score = v + (L.captions ? CAPTION_BONUS : 0) + (L.detail ? DETAIL_BONUS[L.shape] : 0) + (hasStale && staleText ? STALE_TEXT_BONUS : 0);
              out.push({ ...c, valueFont: v, score, depth });
              break;
            }
          }
    return out;
  };

  const finish = (c: BoardCandidate): MarketPlan => {
    const cols = colsAt(c.depth);
    const tiles = cols.flatMap((col) => col.tiles);
    const rows = Math.max(...cols.map((col) => col.tiles.length));
    const widths = spreadWidths(needsOf(cols, c), total);
    const tileH = boardTileHeight(c.shape, c.nameFont, c.valueFont, c.changeFont, s);
    // 남는 높이: 칸 사이 여백을 큰 단계로, 그다음 구역 이름 아래 여백 (둘 다 간격 토큰)
    const body = (pad: number, gap: number) => boardBodyHeight(rows, tileH, pad, c.captions, s, gap);
    const rowPad = rows > 1 ? ([...BOARD_ROW_PADS].reverse().find((p) => body(p, CAPTION_GAPS[0]) <= room) ?? BOARD_ROW_PADS[0]) : BOARD_ROW_PADS[0];
    const captionGap = c.captions ? ([...CAPTION_GAPS].reverse().find((g) => body(rowPad, g) <= room) ?? CAPTION_GAPS[0]) : CAPTION_GAPS[0];
    return {
      ...base,
      shape: c.shape,
      captions: c.captions,
      columns: cols.map((col, k) => ({ key: col.key, label: col.label, codes: col.tiles.map((t) => t.code), width: widths[k]! })),
      nameFont: c.nameFont,
      valueFont: c.valueFont,
      changeFont: c.changeFont,
      nameW: Object.fromEntries(tiles.map((t) => [t.code, null])),
      mark: Object.fromEntries(tiles.map((t) => [t.code, tileMark(t, c.staleText)])),
      change: Object.fromEntries(tiles.map((t) => [t.code, tileChange(t, c.shape, c.detail)])),
      tileH,
      rowPad,
      captionGap,
      bodyH: body(rowPad, captionGap),
    };
  };

  const byDepth = new Map<number, BoardCandidate[]>();
  const at = (depth: number) => {
    let list = byDepth.get(depth);
    if (!list) byDepth.set(depth, (list = candidates(depth)));
    return list;
  };
  // 값 글자 하한 → 개수 → 등락률이 보이는 배치(full·inline) → brief 순. 같은 단계에서는 점수가 가장 높은 것 (같으면 먼저 본 것).
  // 4×3 이상은 9개 모두가 먼저 (값 글자가 min 이상이면 개수를 줄이지 않는다)
  const order: [number, number][] = [];
  if (size === "large") for (const floor of [BOARD.value.comfort, BOARD.value.min]) order.push([floor, deepest]);
  for (const floor of [BOARD.value.comfort, BOARD.value.min, 1]) for (const depth of depths) order.push([floor, depth]);
  for (const [floor, depth] of order)
    for (const brief of [false, true]) {
      let best: BoardCandidate | null = null;
      for (const c of at(depth)) if ((c.shape === "brief") === brief && c.valueFont >= floor && (!best || c.score > best.score)) best = c;
      if (best) return finish(best);
    }

  // 아주 좁은 위젯(이름도 다 안 들어감): 구역마다 1개, 이름 / 값만, 폭은 고르게. 이름은 끝을 줄이고(…) 값은 칸에 들어가는 크기 (숫자는 자르지 않는다)
  const cols = colsAt(1);
  const tiles = cols.flatMap((c) => c.tiles);
  const w = Math.floor(total / n);
  const vf = Math.max(1, Math.min(...tiles.map((t) => fitFont(t.value, w, BOARD.value.min, s, true))));
  const markOf = (t: BoardTileInput): TileMark => tileMark(t, false);
  const tileH = boardTileHeight("brief", F.xs, vf, F.xs, s);
  return {
    ...base,
    shape: "brief",
    captions: false,
    columns: cols.map((c) => ({ key: c.key, label: c.label, codes: c.tiles.map((t) => t.code), width: w })),
    nameFont: F.xs,
    valueFont: vf,
    changeFont: F.xs,
    nameW: Object.fromEntries(
      tiles.map((t) => {
        const nameRoom = w - (markOf(t) ? BOARD.dot + MARKER_GAP : 0);
        return [t.code, textWidth(t.label, F.xs, s, true) <= nameRoom ? null : Math.max(0, Math.floor(nameRoom))];
      }),
    ),
    mark: Object.fromEntries(tiles.map((t) => [t.code, markOf(t)])),
    change: Object.fromEntries(tiles.map((t) => [t.code, null])),
    tileH,
    rowPad: BOARD_ROW_PADS[0],
    captionGap: CAPTION_GAPS[0],
    bodyH: tileH,
  };
}
