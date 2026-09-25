import type { RegisteredWithQuote } from "@/api/types";
import { evalView } from "@/lib/liveTick";
import { fxOf, isHolding, sharedFx } from "@/lib/portfolio";
import type { SortKey } from "@/lib/settings";
import { clampScale } from "@/lib/textScale";
import { fontCap, layout, space } from "@/tokens";

/**
 * 넓은 잔고 표의 열 고르기 (3-42 웨이브 B, 기능 플래그 foldLayout).
 * React Native 를 불러오지 않는 순수 모듈 (테스트에서 폭·글자 배율별 열 목록을 그대로 확인한다).
 *
 * 규칙
 *  - 열은 휴대폰에서 보던 순서 그대로 두고, 넓어진 만큼 오른쪽에 더한다 (앞일수록 우선):
 *    종목 | 현재가 · 등락률 ‖ 평가손익 · 수익률 ‖ 당일손익 · 평가금액 · 비중 · 평단 · 수량
 *  - 열 폭은 tokens layout.cols (글자 100%). 큰 글씨는 배율(최대 fontCap.row = 140%)만큼 넓힌다 → 숫자는 잘리지 않는다
 *  - 이름 칸이 layout.nameMinW(146) 보다 좁아지면 숫자 열을 뒤에서부터 뺀다. 남는 폭은 모두 이름 칸
 *  - 열 묶음(시세 ‖ 평가손익 ‖ 그 밖)이 바뀌는 자리에 구분선 칸(layout.colGap)
 * 폭(width)은 창 폭이 아니라 표가 실제로 받은 폭이다 (왼쪽 세로 탭 막대·화면 여백을 뺀 값, 좌우 여백 포함)
 */

export type HeldCol = "price" | "rate" | "profit" | "profitRate" | "day" | "value" | "weight" | "avg" | "qty";
export type WatchCol = "price" | "rate" | "move" | "volume";
export type ColKey = HeldCol | WatchCol;

interface ColDef<K extends ColKey> {
  key: K;
  /** 열 묶음 번호: 번호가 바뀌는 자리에 구분선 칸 */
  group: number;
}

/** 보유 표 열 (앞일수록 우선 = 폭이 모자라면 뒤에서부터 뺀다) */
export const HELD_COLS: readonly ColDef<HeldCol>[] = [
  { key: "price", group: 0 },
  { key: "rate", group: 0 },
  { key: "profit", group: 1 },
  { key: "profitRate", group: 1 },
  { key: "day", group: 2 },
  { key: "value", group: 2 },
  { key: "weight", group: 2 },
  { key: "avg", group: 2 },
  { key: "qty", group: 2 },
];

/** 관심 표 열: 현재가 · 등락률 ‖ 전일대비 · 거래량 */
export const WATCH_COLS: readonly ColDef<WatchCol>[] = [
  { key: "price", group: 0 },
  { key: "rate", group: 0 },
  { key: "move", group: 1 },
  { key: "volume", group: 1 },
];

/** 열 머리 문구 */
export const COL_LABEL: Record<ColKey, string> = {
  price: "현재가",
  rate: "등락률",
  profit: "평가손익",
  profitRate: "수익률",
  day: "당일손익",
  value: "평가금액",
  weight: "비중",
  avg: "평단",
  qty: "수량",
  move: "전일대비",
  volume: "거래량",
};

/**
 * 열 머리를 누르면 바꿀 정렬 (설정의 정렬 값 그대로 — 정렬 창과 같은 값). 없는 열은 누를 수 없다.
 * 비중은 평가금액(원화 환산)에 비례하므로 같은 '평가금액' 정렬이다
 */
export const COL_SORT: Partial<Record<ColKey, SortKey>> = { rate: "changeRate", profit: "profit", value: "value", weight: "value" };

export interface PlannedCol<K extends ColKey = ColKey> {
  key: K;
  /** 열 폭 (dp, 글자 배율 반영) */
  width: number;
  /** 이 열 앞에 구분선 칸(layout.colGap)을 둔다 */
  divider: boolean;
}

export interface ColumnPlan<K extends ColKey = ColKey> {
  /** 표 좌우 여백 */
  pad: number;
  /** 종목 이름 칸 폭 (숫자 열을 뺀 나머지 전부) */
  nameW: number;
  cols: PlannedCol<K>[];
  /** 열 폭에 곱한 글자 배율 (1~fontCap.row) */
  scale: number;
}

/** 열 폭에 곱할 글자 배율: 줄 글자 확대 상한(140%)까지 */
export function colScale(fontScale: number): number {
  return clampScale(fontScale, fontCap.row);
}

function build<K extends ColKey>(defs: readonly ColDef<K>[], s: number): PlannedCol<K>[] {
  return defs.map((d, i) => ({ key: d.key, width: Math.ceil(layout.cols[d.key] * s), divider: i > 0 && defs[i - 1]!.group !== d.group }));
}

/** 숫자 열이 차지하는 폭 (구분선 칸 포함) */
export function usedWidth(cols: readonly PlannedCol[]): number {
  return cols.reduce((sum, c) => sum + c.width + (c.divider ? layout.colGap : 0), 0);
}

function plan<K extends ColKey>(width: number, fontScale: number, defs: readonly ColDef<K>[], nameMin: number): ColumnPlan<K> {
  const s = colScale(fontScale);
  const pad = space.md;
  const inner = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0) - pad * 2);
  // 뒤에서부터 빼며 이름 칸이 최소 폭 이상 남는 가장 많은 열. 최소 한 열(현재가)은 남긴다
  for (let n = defs.length; n >= 1; n--) {
    const cols = build(defs.slice(0, n), s);
    const rest = inner - usedWidth(cols);
    if (rest >= nameMin || n === 1) return { pad, nameW: Math.max(0, rest), cols, scale: s };
  }
  // 열 정의가 비었을 때만 닿는다
  return { pad, nameW: inner, cols: [], scale: s };
}

/**
 * 보유 표 열 고르기. width 는 표 폭(좌우 여백 포함), fontScale 은 시스템 글자 배율.
 * 예 (글자 100%): 853(펼친 폴드8 가로, 막대 뺀 폭)·859(울트라 펼침 세로) → 숫자 8칸(평단까지), 704(폴드8 펼침 세로) → 6칸(평가금액까지)
 */
export function pickCols(width: number, fontScale = 1): ColumnPlan<HeldCol> {
  return plan(width, fontScale, HELD_COLS, layout.nameMinW);
}

/**
 * 관심 표 열. 이름 칸을 보유 표와 같은 폭(heldNameW)으로 두어 현재가·등락률 열이 보유 표와 같은 자리에 오게 한다.
 * 그 폭으로 다 들어가지 않으면(아주 좁은 창) 이름 칸 최소 폭 기준으로 다시 고른다
 */
export function pickWatchCols(width: number, fontScale = 1, heldNameW?: number): ColumnPlan<WatchCol> {
  const aligned = heldNameW !== undefined ? plan(width, fontScale, WATCH_COLS, heldNameW) : null;
  if (aligned && aligned.cols.length === WATCH_COLS.length) return { ...aligned, nameW: heldNameW! };
  return plan(width, fontScale, WATCH_COLS, layout.nameMinW);
}

/** 계좌 띠를 한 줄로 쓸지: 표 폭이 layout.bandOneLineMin × 글자 배율 이상이면 한 줄, 아니면 두 줄 */
export function bandOneLine(width: number, fontScale = 1): boolean {
  return Number.isFinite(width) && width >= layout.bandOneLineMin * colScale(fontScale);
}

export interface Weights {
  /** 종목 코드 → 비중 % (소수 첫째 자리). 원화 환산 평가금액을 알 수 없는 종목은 없음 */
  byCode: Map<string, number>;
  /** 가장 큰 비중 (막대 길이 기준). 없으면 0 */
  max: number;
}

/**
 * 표의 비중 열: 종목 원화 환산 평가금액 ÷ 계좌 총 평가금액 (잔고 계좌 띠의 총 평가금액과 같은 기준 — portfolio.summarize 와 같은
 * evalView·환율·비용 차감 설정). total 은 화면에 보이는 총 평가금액(원화). 환율을 끝내 모르는 해외 종목이 있어 총액이 원화 종목만이면
 * (krwOnly) 원화 종목만 비중을 낸다 (해외 종목은 비중 없음 → '-').
 * 소수 첫째 자리로 반올림한다 → 체결마다 총액이 조금 바뀌어도 보이는 비중이 같으면 그 줄은 다시 그리지 않는다
 */
export function holdingWeights(list: RegisteredWithQuote[], afterCost: boolean, total: number, krwOnly = false): Weights {
  const byCode = new Map<string, number>();
  let max = 0;
  if (!(total > 0)) return { byCode, max };
  const shared = sharedFx(list);
  for (const s of list) {
    if (!isHolding(s) || !s.quote || !s.evaluation) continue;
    const cur = s.quote.currency ?? "KRW";
    if (krwOnly && cur !== "KRW") continue;
    const fx = fxOf(s) ?? (cur === "USD" ? shared : null);
    if (cur === "USD" && !fx) continue;
    const v = evalView(s.evaluation, { afterCost, toKrw: true, currency: cur, fx });
    if (!v) continue;
    const pct = Math.round((v.marketValue / total) * 1000) / 10;
    byCode.set(s.code, pct);
    if (pct > max) max = pct;
  }
  return { byCode, max };
}
