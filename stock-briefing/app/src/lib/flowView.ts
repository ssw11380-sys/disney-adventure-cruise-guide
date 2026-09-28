import type { FlowDay, FlowSum } from "@/api/types";
import { estimateTextWidth } from "@/lib/chartLayout";
import type { DetailTab } from "@/lib/detailLayout";
import { barsSpeechHead, barsSpeechRow, FLOW_NAMES, FLOW_TAB, sumSpeech } from "@/lib/flowText";
import { clampScale } from "@/lib/textScale";
import { font, fontCap, space } from "@/tokens";

/**
 * 종목 상세 '수급' 탭 (3-33, 플래그 flowTab) 화면 계산 — React Native 를 불러오지 않는 순수 모듈 (테스트용).
 * 탭 이름 고르기 · 주 수 모양 · 화면 읽기 문장 · 막대/선 좌표
 */

// ── 탭 이름 (설계서 3.1) ──

export interface TabOption {
  value: DetailTab;
  label: string;
  /** 화면 읽기 이름 (줄인 이름이 아니라 원래 이름). 없으면 label */
  a11y?: string;
}

/** 휴대폰 탭 — 꺼짐일 때 지금 화면이 쓰는 목록과 같은 내용 (a11y 칸 없음) */
export const PHONE_TABS: { value: DetailTab; label: string }[] = [
  { value: "company", label: "기업개요" },
  { value: "value", label: "가치분석" },
  { value: "technical", label: "기술분석" },
  { value: "news", label: "뉴스·공시" },
];
/** 넓은 창 탭 — 꺼짐일 때 지금 화면이 쓰는 목록과 같은 내용 */
export const WIDE_TABS_BASE: { value: DetailTab; label: string }[] = [
  { value: "briefing", label: "브리핑" },
  { value: "news", label: "뉴스·공시" },
  { value: "company", label: "기업개요" },
  { value: "value", label: "가치" },
  { value: "technical", label: "기술" },
];

type TabSet = "A" | "D" | "C";
/** 벌마다 줄인 이름 (A: 그대로 · D: '뉴스·공시' → '뉴스' · C: 두 글자) */
const SHORT: Record<TabSet, Partial<Record<DetailTab, string>>> = {
  A: {},
  D: { news: "뉴스" },
  C: { news: "뉴스", company: "기업", value: "가치", technical: "기술" },
};
const SETS: TabSet[] = ["A", "D", "C"];
/** 잰 폭의 소수점 오차 (이만큼 안쪽이면 꽉 찬 것으로 본다 — chartLayout 과 같은 값) */
const FIT_EPS = 0.5;

/**
 * 수급 탭을 더한 탭 목록 (켜졌을 때만 부른다). 탭 칸은 폭을 똑같이 나누고(Segmented) 글자는 기기 배율 그대로(상한 없음)라,
 * 모든 이름이 한 줄에 들어가는 첫 벌(A → D → C)을 고른다. 없으면 (가장 긴 칸의 줄 수, 두 줄 이상 칸 수)가 가장 적은 벌 (같으면 앞 벌).
 * 폭은 글자 폭 어림(estimateTextWidth — 실제 글꼴보다 조금 넓게). 화면 읽기 이름은 늘 원래 이름
 */
export function detailTabLabels(kind: "phone" | "wide", totalW: number, fontScale: number): { set: TabSet; options: TabOption[]; multi: number } {
  const base = kind === "phone" ? PHONE_TABS : WIDE_TABS_BASE;
  const s = clampScale(fontScale);
  const cell = totalW / (base.length + 1);
  const lines = (label: string) => {
    const w = estimateTextWidth(label, font.body * s);
    return w <= cell + FIT_EPS ? 1 : Math.ceil((w - FIT_EPS) / cell);
  };
  const build = (set: TabSet): TabOption[] => [
    ...base.map((b) => ({ value: b.value, label: SHORT[set][b.value] ?? b.label, a11y: b.label })),
    { value: "flow" as const, label: FLOW_TAB.label, a11y: FLOW_TAB.a11y },
  ];
  let best: { set: TabSet; options: TabOption[]; max: number; multi: number } | null = null;
  for (const set of SETS) {
    const options = build(set);
    const ls = options.map((o) => lines(o.label));
    const max = Math.max(...ls);
    const multi = ls.filter((l) => l > 1).length;
    if (max === 1) return { set, options, multi: 0 };
    if (!best || max < best.max || (max === best.max && multi < best.multi)) best = { set, options, max, multi };
  }
  return { set: best!.set, options: best!.options, multi: best!.multi };
}

// ── 숫자 모양 (설계서 3.4) ──

/** 절댓값 글자에 부호 (보이는 글자가 0 이면 부호 없음 — format.ts 와 같은 규칙) */
function withSign(n: number, body: string, sign: boolean): string {
  if (!/[1-9]/.test(body) || !sign) return body;
  return n > 0 ? `+${body}` : `-${body}`;
}

const trim1 = (x: number) => x.toFixed(1).replace(/\.0$/, "");

/**
 * 주 수: null → '—' · 0 → '0주' · 1만 미만 '+1,234주' · 1만~10만 '+1.3만 주' · 10만~1억 '+742만 주' · 1억 이상 '+1.2억 주'.
 * 경계는 반올림한 값 기준 (99,999 → '+10만 주', 99,999,999 → '+1억 주'). unit: false 면 '주' 없이, sign: false 면 부호 없이(화면 읽기)
 */
export function formatShares(n: number | null | undefined, o: { unit?: boolean; sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const unit = o.unit !== false;
  const sign = o.sign !== false;
  const a = Math.abs(n);
  let body: string;
  if (a >= 9_999.5e4) body = `${trim1(a / 1e8)}억${unit ? " 주" : ""}`;
  else if (a >= 9.995e4) body = `${Math.round(a / 1e4).toLocaleString("ko-KR")}만${unit ? " 주" : ""}`;
  else if (a >= 1e4) body = `${trim1(a / 1e4)}만${unit ? " 주" : ""}`;
  else body = `${Math.round(a).toLocaleString("ko-KR")}${unit ? "주" : ""}`;
  return withSign(n, body, sign);
}

/** 보이는 글자의 부호 (-1·0·1) — 색과 화면 읽기를 글자에 맞춘다 */
export function sharesSign(n: number | null | undefined): number {
  if (n === null || n === undefined || !Number.isFinite(n)) return 0;
  return /[1-9]/.test(formatShares(n)) ? Math.sign(n) : 0;
}

/** 보유율 '46.52%' (한도는 digits 1 — '49.0%') */
export function formatRatio(v: number, digits = 2): string {
  return `${v.toFixed(digits)}%`;
}

/** %p 차이 '+0.04%p' · '-0.23%p' · '0.00%p' */
export function formatPp(v: number): string {
  return withSign(v, `${Math.abs(v).toFixed(2)}%p`, true);
}

/** '2026-08-28' → '8월 28일' (막대 축 아래) */
export function shortDate(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${Number(m[1])}월 ${Number(m[2])}일` : date;
}

const WEEK = ["일", "월", "화", "수", "목", "금", "토"] as const;
const weekdayOf = (date: string) => WEEK[new Date(`${date}T12:00:00+09:00`).getUTCDay()] ?? "";

/** '2026-09-28' → '9월 28일 (월)' */
export function dateKo(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${shortDate(date)} (${weekdayOf(date)})` : date;
}

/** '2026-09-28' → '9월 28일 월요일' (화면 읽기) */
export function dateLong(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${shortDate(date)} ${weekdayOf(date)}요일` : date;
}

/** 시각 → 'HH:MM' (한국 시간). 못 읽으면 null */
export function hhmm(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 9 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** 시각 → '9월 28일 (월) 20:15' (한국 시간, 출처 줄) */
export function stampKo(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "-";
  const date = new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
  return `${dateKo(date)} ${hhmm(iso)}`;
}

// ── 합계 줄 ──

export type FlowKey = "individual" | "foreign" | "institution" | "otherCorp";

export interface SumRow {
  key: FlowKey;
  name: string;
  text: string;
  sign: number;
  speech: string;
}

/** 합계 네 줄 (네이버 자료는 기타법인이 없어 세 줄) */
export function flowSumRows(sum: FlowSum, period: number, withOther: boolean): SumRow[] {
  const keys: FlowKey[] = withOther ? ["individual", "foreign", "institution", "otherCorp"] : ["individual", "foreign", "institution"];
  return keys.map((key) => {
    const v = sum[key];
    const sign = sharesSign(v);
    return { key, name: FLOW_NAMES[key], text: formatShares(v), sign, speech: sumSpeech(FLOW_NAMES[key], period, v === null ? null : formatShares(v, { sign: false }), sign) };
  });
}

/** 합계를 칩 대신 세 기간 표(5일 | 20일 | 60일)로 한 번에 보일 만큼 넓은지 — 카드 안쪽 폭 ≥ 520 × 글자 배율 */
export function showSumTable(inner: number, fontScale: number): boolean {
  return inner >= 520 * clampScale(fontScale);
}

// ── 날짜별 숫자 표 ──

/** 날짜별 숫자 표 칸 사이 (FlowTab tableRow 의 columnGap 과 같은 값) */
export const DAY_TABLE_GAP = space.xs;
/** 가장 넓은 날짜 글 · 가장 넓은 칸 글 (칸에는 '주'를 쓰지 않고 표 위에 '단위: 주'를 한 번 — 1억 이상 '-12.3억'·1만 미만 '-9,999'는 이보다 좁다) */
const WIDEST_DATE = "12월 31일";
const WIDEST_CELL = "-9,999만";

/**
 * 날짜별 숫자 표 배치. 글자는 고정 폭 열 표 규칙대로 fontCap.row(1.4배)까지만 커진다.
 * dateW: 날짜 열 폭(가장 넓은 날짜가 한 줄에 들어가는 폭). fits: 날짜 + 세 칸이 한 줄에 들어가는지 —
 * 아니면 날짜를 한 줄 위에 따로 두고 세 칸이 폭을 나눈다 (숫자가 '만'·'주' 앞에서 두 줄로 갈라지지 않게)
 */
export function dayTableLayout(inner: number, fontScale: number): { dateW: number; fits: boolean } {
  const size = font.small * clampScale(fontScale, fontCap.row);
  const dateW = Math.ceil(estimateTextWidth(WIDEST_DATE, size));
  const cellW = estimateTextWidth(WIDEST_CELL, size);
  return { dateW, fits: inner >= dateW + 3 * (cellW + DAY_TABLE_GAP) };
}

// ── 막대 (설계서 3.6) ──

/** 막대 한 줄 높이 (가운데 0선, 위 +, 아래 −) */
export const BAR_ROW_H = 56;
/** 막대 최대 폭 — 칸이 넓어도(5일) 이보다 두껍게 그리지 않는다 (남는 곳은 빈 곳) */
export const BAR_MAX_W = 24;

/** 칸 폭 · 막대 폭 · 사이 (사이는 2, 칸이 좁으면 칸의 30% 까지) */
export function barLayout(width: number, n: number): { slot: number; bar: number; gap: number } {
  const slot = n > 0 && width > 0 ? width / n : 0;
  const gap = Math.min(2, slot * 0.3);
  return { slot, bar: Math.max(0, Math.min(BAR_MAX_W, slot - gap)), gap };
}

/** 누른 x → 칸 번호 (왼쪽 = 가장 오래된 날). x 를 모르면(NaN 등) 가장 최근 날 */
export function pickIndex(x: number | null | undefined, width: number, n: number): number {
  if (n <= 0 || !(width > 0)) return 0;
  if (typeof x !== "number" || !Number.isFinite(x)) return n - 1;
  return Math.min(n - 1, Math.max(0, Math.floor(x / (width / n))));
}

/** 고른 칸 번호 정리 (null·NaN·범위 밖 → 가장 최근 날) — 기간을 바꿔 막대 수가 줄어도 */
export function clampPick(pick: number | null, n: number): number {
  if (n <= 0) return 0;
  if (pick === null || !Number.isFinite(pick)) return n - 1;
  return Math.min(n - 1, Math.max(0, Math.floor(pick)));
}

/** 막대 높이 (눈금 max 에서 반 줄 높이까지, 0 이 아닌 값은 최소 1) */
export function barHeight(v: number | null, max: number, half: number): number {
  if (v === null || v === 0 || !(max > 0)) return 0;
  return Math.max(1, (Math.abs(v) / max) * half);
}

/** 세 줄 같은 눈금: 보이는 기간 세 줄의 |값| 가운데 가장 큰 것 */
export function barScale(days: readonly FlowDay[]): number {
  let max = 0;
  for (const d of days) for (const k of ["individual", "foreign", "institution"] as const) max = Math.max(max, Math.abs(d[k] ?? 0));
  return max;
}

/** 막대 그림 화면 읽기 요약 (days 는 최신순) */
export function barsSpeech(days: readonly FlowDay[]): string {
  if (!days.length) return "";
  const first = days[days.length - 1]!.date;
  const last = days[0]!.date;
  const rows = (["individual", "foreign", "institution"] as const).map((k) => {
    const up = days.filter((d) => (d[k] ?? 0) > 0).length;
    const down = days.filter((d) => (d[k] ?? 0) < 0).length;
    return barsSpeechRow(FLOW_NAMES[k], up, down);
  });
  return [barsSpeechHead(shortDate(first), shortDate(last), days.length), ...rows].join(" ");
}

// ── 보유율 선 ──

export interface Pt {
  x: number;
  y: number;
}

/** 선 점 좌표 (오래된 순 → 왼쪽부터). 높은 값이 위, 위아래 pad 여백. 값이 모두 같으면 가운데 한 줄 */
export function linePoints(series: readonly (readonly [string, number])[], w: number, h: number, pad: number): Pt[] {
  const n = series.length;
  if (!n) return [];
  const vals = series.map((s) => s[1]);
  const hi = Math.max(...vals);
  const lo = Math.min(...vals);
  return series.map(([, v], i) => ({
    x: n === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (n - 1),
    y: hi === lo ? h / 2 : pad + ((hi - v) / (hi - lo)) * (h - pad * 2),
  }));
}

/** 선분 (View 를 가운데에 놓고 돌려 그린다): 가운데·길이·각도(도) */
export interface Seg {
  cx: number;
  cy: number;
  len: number;
  deg: number;
}

/** 세 점이 한 직선 위에 있는지 (같은 방향으로 이어지는지) — 좌표 오차 여유 */
function collinear(a: Pt, b: Pt, c: Pt): boolean {
  const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
  return Math.abs(cross) < 1e-6 && dot > 0;
}

/**
 * 선분 목록. 같은 직선 위로 이어지는 점들(값이 그대로인 평평한 구간 등)은 선분 하나로 합친다 —
 * 짧은 선분을 여러 개 이으면 이음매가 점선처럼 보이기 때문 (외국인 한도가 다 찬 KT 처럼 값이 모두 같으면 가로선 하나)
 */
export function lineSegments(pts: readonly Pt[]): Seg[] {
  const out: Seg[] = [];
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    const next = pts[i + 1];
    if (next && collinear(pts[start]!, pts[i]!, next)) continue;
    const a = pts[start]!;
    const b = pts[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    out.push({ cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, len: Math.hypot(dx, dy), deg: (Math.atan2(dy, dx) * 180) / Math.PI });
    start = i;
  }
  return out;
}
