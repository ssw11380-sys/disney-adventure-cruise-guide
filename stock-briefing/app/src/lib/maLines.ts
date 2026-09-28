/**
 * 이동평균선 선 6개 (3-39, 기능 플래그 maCustom): 기간(2~240) · 색(chart.maPalette 의 몇 번째) · 보이기.
 * 순수 모듈 — React·React Native·저장소를 부르지 않는다. 저장·읽기 훅은 lib/chartPrefs useMaLines, 새 화면은 app/chart-lines.
 * 처음 선은 지금 차트 칩(5·10·20·60·120·200 · 같은 색 · 지금 켠 기간)과 똑같아, 플래그를 켠 순간 차트가 달라지지 않는다
 */

/** 이동평균선 한 줄 (3-39, 기능 플래그 maCustom): 기간 · 색(chart.maPalette 의 몇 번째) · 보이기 */
export interface MaLine {
  period: number;
  color: number;
  on: boolean;
}
export const MA_SLOTS = 6;
export const MA_COLORS = 8;
export const MA_MIN = 2;
export const MA_MAX = 240;
/** 처음 선의 기간 (지금 칩과 같다) */
export const MA_DEFAULT_PERIODS = [5, 10, 20, 60, 120, 200] as const;

/** 기간 입력칸 오류: 범위·정수가 아님 */
export const PERIOD_RANGE_ERROR = `${MA_MIN}~${MA_MAX} 사이의 정수를 적어 주세요`;
/** 기간 입력칸 오류: 다른 선과 같은 기간 (slot = 0부터) */
export const periodTakenError = (slot: number) => `이미 선 ${slot + 1}의 기간입니다`;

/** 색 이름 (화면 읽기, 차례 = chart.maPalette 차례) */
const COLOR_NAMES = {
  dark: ["초록", "하늘", "주황", "자홍", "보라", "회색", "갈색", "분홍"],
  light: ["초록", "청록", "올리브", "자주", "보라", "회색", "갈색", "분홍"],
} as const;

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** 처음 선: 기간 5·10·20·60·120·200, 색 0~5, 보이기 = 지금 켠 기간(maPeriods)에 있는지 */
export function defaultMaLines(maPeriods: readonly number[]): MaLine[] {
  return MA_DEFAULT_PERIODS.map((period, i) => ({ period, color: i, on: maPeriods.includes(period) }));
}

/** 저장값 검사 (배열 6칸 · 기간 정수 2~240 · 색 정수 0~7 · 보이기 참/거짓 · 기간이 서로 다름). 하나라도 틀리면 null (부분 고치기 없음) */
export function maLinesOf(raw: unknown): MaLine[] | null {
  if (!Array.isArray(raw) || raw.length !== MA_SLOTS) return null;
  const out: MaLine[] = [];
  for (const x of raw as unknown[]) {
    if (!x || typeof x !== "object") return null;
    const { period, color, on } = x as Record<string, unknown>;
    if (!isInt(period, MA_MIN, MA_MAX) || !isInt(color, 0, MA_COLORS - 1) || typeof on !== "boolean") return null;
    out.push({ period, color, on });
  }
  if (new Set(out.map((l) => l.period)).size !== MA_SLOTS) return null;
  return out;
}

/** 칩 켜고 끄기: 그 칸의 on 만 바꾼 새 배열 (받은 배열은 그대로) */
export function withOn(lines: readonly MaLine[], slot: number, on: boolean): MaLine[] {
  return lines.map((l, i) => (i === slot ? { ...l, on } : l));
}

/**
 * 차트에 그릴 것. periods = 켠 선의 기간(작은 순). colors = **켠 선만** { 기간: palette[색 번호] } —
 * 끈 선의 기간은 키로 넣지 않는다 (처음 선·maPeriods [5,20,60,120] 이면 키는 정확히 5·20·60·120)
 */
export function drawnMa(lines: readonly MaLine[], palette: readonly string[]): { periods: number[]; colors: Record<number, string> } {
  const shown = lines.filter((l) => l.on);
  const colors: Record<number, string> = {};
  for (const l of shown) colors[l.period] = palette[l.color] ?? palette[0]!;
  return { periods: shown.map((l) => l.period).sort((a, b) => a - b), colors };
}

/** 색 이름 (화면 읽기) — 다크 '초록·하늘·주황·자홍·보라·회색·갈색·분홍', 라이트 '초록·청록·올리브·자주·보라·회색·갈색·분홍' */
export function maColorName(dark: boolean, color: number): string {
  return (dark ? COLOR_NAMES.dark : COLOR_NAMES.light)[color] ?? "";
}

// ── 새 화면의 초안 (3-39). 기간은 입력칸 글자가 원본이다 — 숫자로 바꿔 따로 들지 않는다 ──

export interface MaDraft {
  texts: string[];
  colors: number[];
  ons: boolean[];
}

/** 저장된(또는 처음) 선 → 초안: texts = String(기간) */
export function draftOf(lines: readonly MaLine[]): MaDraft {
  return { texts: lines.map((l) => String(l.period)), colors: lines.map((l) => l.color), ons: lines.map((l) => l.on) };
}

/** 기간 글자 → 정수: 앞뒤 공백을 지우고 /^\d{1,3}$/ 이고 2~240 이면 그 수, 아니면 null */
export function parsePeriod(text: string): number | null {
  const s = text.trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= MA_MIN && n <= MA_MAX ? n : null;
}

/**
 * 칸마다 오류 (6칸, 늘 지금 글자 6개로만 계산 — 저장값·예전 초안과 비교하지 않는다).
 * parsePeriod 가 null 이면 '2~240 사이의 정수를 적어 주세요'. 아니면 다른 칸 중 글자를 읽은 값이 같은 **첫 칸** j 가 있으면
 * '이미 선 {j+1}의 기간입니다' (겹친 두 칸 모두 오류 — 서로를 가리킴). 읽지 못한 칸(범위 오류)은 겹침 비교에서 뺀다. 없으면 null
 */
export function periodErrors(texts: readonly string[]): (string | null)[] {
  const values = texts.map(parsePeriod);
  return values.map((v, i) => {
    if (v === null) return PERIOD_RANGE_ERROR;
    const j = values.findIndex((w, k) => k !== i && w !== null && w === v);
    return j >= 0 ? periodTakenError(j) : null;
  });
}

/** 저장할 선: periodErrors 에 오류가 하나라도 있으면 null. 기간 = 글자를 읽은 값, 색·보이기 = 초안 */
export function linesOfDraft(d: MaDraft): MaLine[] | null {
  if (periodErrors(d.texts).some((e) => e !== null)) return null;
  return d.texts.map((text, i) => ({ period: parsePeriod(text)!, color: d.colors[i] ?? i, on: d.ons[i] ?? false }));
}

/** 처음 값으로: 글자 = 처음 기간(5·10·20·60·120·200), 색 = 0~5, 보이기는 칸마다 그대로 (받은 초안은 그대로) */
export function resetDraft(d: MaDraft): MaDraft {
  return { texts: MA_DEFAULT_PERIODS.map((p) => String(p)), colors: MA_DEFAULT_PERIODS.map((_, i) => i), ons: [...d.ons] };
}
