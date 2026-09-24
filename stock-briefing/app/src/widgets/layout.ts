import { space } from "@/tokens";
import { WIDGET_FONT as F, WIDGET_TOTAL_FONTS as TOTAL_FONTS, WIDGET_TOUCH as TOUCH } from "./palette";

/**
 * 위젯 크기별 배치 (3-23, 순수 함수 → 단위 테스트).
 * 위젯은 글자를 비트맵으로 그려 두므로, 칸보다 긴 숫자는 잘리거나(…) 칸 밖으로 나간다.
 * 그래서 글자 폭을 보수적으로(실제 글꼴보다 넓게) 어림해, 숫자가 칸에 다 들어가는 배치를 미리 고른다.
 *  - 숫자는 자르지 않는다: 글자를 줄이거나(정해진 단계 안에서), 덜 중요한 칸(장 상태 칩·손익 금액·지수 항목)을 뺀다
 *  - 이름·브리핑 문장만 끝을 …로 줄일 수 있다
 *  - 높이도 어림해 위젯 밖으로 넘치지 않게 한다: 잔고 목록(ListWidget)은 높이가 0 이면 라이브러리가 그리지 못하므로(예외 → 위젯이 갱신되지 않음)
 *    첫 줄이 보일 높이가 없으면 넣지 않고, 브리핑 고지 한 줄은 늘 들어가게 종목 칸을 줄인다
 *  - 크기 단계: 목록 위젯(잔고·브리핑)은 높이, 자산 위젯(2×1)은 폭으로 compact · regular · large
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

/** 한 줄 글자 폭 어림 (dp) */
export function textWidth(text: string, font: number, scale: number, bold = false): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * font * scale * (bold ? BOLD : 1) + SLACK;
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
}

export interface IndexPlan<T extends IndexInput = IndexInput> {
  font: number;
  /** 줄마다 항목 (large 는 두 줄까지) */
  lines: T[][];
  height: number;
}

const ITEM_GAP = space.xs;

export function indexItemWidth(i: IndexInput, font: number, scale: number): number {
  const parts = [textWidth(i.label, font, scale), textWidth(i.value, font, scale, true)];
  if (i.rate) parts.push(textWidth(i.rate, font, scale, true));
  if (i.stale) parts.push(textWidth("지연", font, scale));
  return parts.reduce((a, b) => a + b, 0) + ITEM_GAP * (parts.length - 1);
}

/** 항목 사이 " · " 칸 폭 */
export function indexSepWidth(font: number, scale: number): number {
  return textWidth("·", font, scale) + ITEM_GAP * 2;
}

/** 앞에서부터 줄에 채운다. maxLines 안에 다 못 넣으면 null */
function pack<T extends IndexInput>(items: T[], font: number, width: number, scale: number, maxLines: number): T[][] | null {
  const lines: T[][] = [];
  let cur: T[] = [];
  let used = 0;
  for (const it of items) {
    const w = indexItemWidth(it, font, scale);
    const add = cur.length ? indexSepWidth(font, scale) + w : w;
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
}

const ROW_GAP = space.sm;

/**
 * 목록 줄 배치: [가격 등락률 한 줄, sm] → [가격/등락률 위아래, sm] → xs 순으로, 모든 줄의 손익이 온전히 들어가는 첫 배치.
 * 그런 배치가 없으면 줄마다 들어가는 가장 긴 손익(없으면 비움)
 */
export function planRows(rows: readonly RowInput[], width: number, scale: number): RowsPlan {
  // 등락률 칸은 정수 폭으로 그리므로 올림한 값으로 나머지를 나눈다
  const priceW = Math.ceil(Math.max(0, ...rows.map((r) => textWidth(r.price, F.base, scale, true))));
  const rateW = Math.ceil(Math.max(0, ...rows.map((r) => (r.rate ? textWidth(r.rate, F.md, scale, true) : 0))));
  const minName = textWidth("가나", F.base, scale, true);
  const rowH = lineHeight(F.base, scale) + lineHeight(F.sm, scale) + space.xs * 2 + 1;
  const make = (stacked: boolean, subFont: number): RowsPlan => {
    const right = stacked ? Math.max(priceW, rateW) : priceW + (rateW ? ROW_GAP + rateW : 0);
    const leftW = Math.floor(width - right - ROW_GAP);
    const sub = rows.map((r) => r.subs.find((s) => textWidth(s, subFont, scale) <= leftW) ?? null);
    return { stacked, leftW, rateW, subFont, sub, rowH };
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
