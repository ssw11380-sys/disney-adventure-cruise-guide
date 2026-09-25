import type { CandlePeriod, ChartUnit } from "@/api/types";
import { formatPrice } from "@/lib/format";
import type { Series } from "@/lib/indicators";
import { clampScale, LINE } from "@/lib/textScale";
import { font, fontCap, layout, space, touch } from "@/tokens";

/**
 * 차트 화면 배치 계산 (3-42 접는 폰 · 폴드 진단 8·22·24·25·6·7번). React Native 를 불러오지 않는 순수 모듈 (테스트용).
 *  - candleChartSize: 종목·지수 상세 차트 그림의 폭·높이
 *  - chartHeaderLayout: 전체 화면 차트 머리 (이름·가격·등락을 한 줄에 둘지, 가격·등락을 둘째 줄로 내릴지, 머리 높이)
 *  - maLegendItems: 차트 아래 이동평균 값 줄의 항목 (한 항목이 두 줄로 나뉘지 않게)
 *  - fadeEdges: 옆으로 넘기는 칩 띠에서 흐리게 칠할 가장자리
 * 기준 숫자는 tokens.ts 의 layout·space·font (폰 실측 전 추정값은 토큰만 바꾼다)
 */

// ── 상세 차트 크기 ──

/** 상세 차트를 담은 패널의 좌우 안쪽 여백 (종목 상세·지수 상세 panel 의 paddingHorizontal). 폭을 재기 전 첫 그림의 어림에만 쓴다 */
export const CHART_PANEL_PAD = space.lg;

export interface ChartSizeInput {
  /** 차트 묶음이 실제로 받은 폭 (onLayout). 아직 재지 못했으면 null → 창 폭 − 패널 좌우 여백으로 어림 */
  box: number | null;
  /** 창 크기 (useWindowDimensions) */
  window: { width: number; height: number };
  /** 넓은 창 배치: foldLayout 이 켜져 있고 폭 등급이 중간 이상 (좁은 창·플래그 꺼짐이면 false) */
  wide: boolean;
  /** 부르는 쪽이 정한 폭·높이 (전체 화면 차트). 있으면 그대로 쓴다 */
  width?: number;
  height?: number;
}

/**
 * 상세 차트 그림 크기.
 *  - 폭은 창 폭이 아니라 차트 묶음이 실제로 받은 폭(패널 안쪽)이다. 예전에는 창 폭에서 패널 여백을 두 번 빼서(− 56)
 *    모든 크기에서 오른쪽 28dp 가 비었다 (진단 22번, 버그 수정 — 플래그와 상관없음)
 *  - 좁은 창이거나 foldLayout 이 꺼져 있으면 지금처럼 폭 layout.chartMaxW(720) 에서 멈추고 높이 = 폭 × chartAspect(0.62)
 *  - 넓은 창(wide)이면 폭 상한 없이 다 쓰고, 높이 = min(폭 × 0.62, 창 높이 × chartMaxHRatio(0.5)) →
 *    낮고 넓은 창(펼친 폴드8 가로 933×704)에서도 날짜 줄까지 첫 화면에 들어온다 (진단 6·7번)
 */
export function candleChartSize(o: ChartSizeInput): { width: number; height: number } {
  if (o.width !== undefined) return { width: o.width, height: o.height ?? Math.round(o.width * layout.chartAspect) };
  const measured = o.box !== null && Number.isFinite(o.box) && o.box > 0 ? o.box : o.window.width - CHART_PANEL_PAD * 2;
  // 소수점 폭은 내림 (그림이 패널 밖으로 1px 넘치지 않게)
  const room = Math.max(0, Math.floor(Number.isFinite(measured) ? measured : 0));
  const width = o.wide ? room : Math.min(room, layout.chartMaxW);
  const natural = Math.round(width * layout.chartAspect);
  const cap = o.wide && o.window.height > 0 ? Math.round(o.window.height * layout.chartMaxHRatio) : Infinity;
  return { width, height: o.height ?? Math.min(natural, cap) };
}

// ── 전체 화면 차트 머리 ──

/** 전체 화면 차트 머리의 둥근 아이콘 버튼(가로로 보기·닫기) 크기. 누르는 영역은 hitSlop 으로 44 */
export const CHART_ICON_BTN = 34;
/** 머리 한 줄에서 이름이 줄어들어도 남기는 글자 수. 이만큼도 남지 않으면 가격·등락을 둘째 줄로 내린다 */
export const NAME_MIN_CHARS = 4;
/** 글자 폭 어림 여유 (실제 글꼴보다 조금 넓게 잡아, 한 줄에 들어간다고 본 것은 폰에서도 들어가게) */
const WIDTH_SLACK = 1.05;

/** 글자 한 자의 폭 (글자 크기 대비). Roboto·삼성 기본 글꼴 값보다 조금 넓게 */
function charEm(ch: string): number {
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch)) return 1;
  if (/[0-9]/.test(ch)) return 0.6;
  if (/[,.:;'!|]/.test(ch) || ch === " " || ch === " ") return 0.3;
  if (/[()[\]]/.test(ch)) return 0.36;
  if (ch === "%") return 0.85;
  if (/[+\-$]/.test(ch)) return 0.62;
  if (/[A-Z]/.test(ch)) return 0.72;
  if (/[a-z]/.test(ch)) return 0.58;
  // 그 밖의 기호·한자·말줄임(…)은 넓게
  return 1;
}

/** 글자 폭 어림 (dp). size 는 글자 배율을 곱한 실제 글자 크기 */
export function estimateTextWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * size * WIDTH_SLACK;
}

export interface ChartHeaderInput {
  /** 머리가 쓰는 폭 (차트 판의 좌우 여백을 뺀 값) */
  width: number;
  /** 시스템 글자 배율 (1 = 100%). 머리는 fontCap.chrome(150%) 까지만 커진다 */
  fontScale: number;
  name: string;
  /** 가격·등락 글자 (시세가 없으면 null) */
  price: string | null;
  change: string | null;
  /** 오른쪽 둥근 버튼 수 (가로로 보기 + 닫기 = 2, 가로 창에서 가로로 보기를 숨기면 1) */
  buttons: number;
}

export interface ChartHeaderLayout {
  /** 가격·등락을 이름 아래 둘째 줄로 내린다 (좁은 창 + 큰 글씨) */
  twoLines: boolean;
  /** 머리 최소 높이: 44 와 글자 배율(fontCap.chrome 까지)에 맞춘 줄 높이 중 큰 값 → 아래 도구 줄과 겹치지 않는다 */
  height: number;
}

/**
 * 전체 화면 차트 머리 배치 (진단 8번, 버그 수정).
 * 이름이 길면(한화에어로스페이스) 이름만 '…'로 줄이고 가격·등락은 줄이지 않는다. 그래도 이름이 NAME_MIN_CHARS 자도
 * 남지 않으면(좁은 바깥 화면 + 글자 130% 등) 가격·등락을 둘째 줄로 내린다 → 가격이 '912,000 / 원'처럼 쪼개지지 않는다.
 * 머리 높이는 고정 44 대신 최소 44 에 글자 배율을 반영한다 (두 줄이면 두 줄 높이)
 */
export function chartHeaderLayout(o: ChartHeaderInput): ChartHeaderLayout {
  const s = clampScale(o.fontScale, fontCap.chrome);
  // 첫 줄: 이름(h2)과 둥근 버튼 중 높은 쪽. 둘째 줄: 가격(body) 한 줄 + 도구 줄과의 틈
  const line1 = Math.max(CHART_ICON_BTN, Math.ceil(font.h2 * LINE * s));
  const one = Math.max(touch.min, line1);
  const two = Math.max(touch.min, line1 + space.xxs + Math.ceil(font.body * LINE * s) + space.xs);
  const quote = [o.price ? estimateTextWidth(o.price, font.body * s) : null, o.change ? estimateTextWidth(o.change, font.small * s) : null].filter(
    (w): w is number => w !== null,
  );
  if (!quote.length) return { twoLines: false, height: one };
  const chars = [...o.name];
  const nameMin = estimateTextWidth(chars.length <= NAME_MIN_CHARS ? o.name : `${chars.slice(0, NAME_MIN_CHARS).join("")}…`, font.h2 * s);
  // 오른쪽 버튼 묶음 (버튼 사이 간격 + 왼쪽 글자 묶음과의 간격)
  const buttons = o.buttons > 0 ? o.buttons * CHART_ICON_BTN + (o.buttons - 1) * space.sm + space.sm : 0;
  const need = nameMin + quote.reduce((sum, w) => sum + space.sm + w, 0) + buttons;
  return need <= o.width ? { twoLines: false, height: one } : { twoLines: true, height: two };
}

// ── 이동평균 값 줄 ──

/** 읽기 줄·이동평균 값 (통화는 원·달러 표기, PT = 지수·환율은 소수 둘째 자리) */
export function formatChartValue(v: number, unit: ChartUnit): string {
  if (unit === "PT") return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return formatPrice(v, unit);
}

export interface MaLegendItem {
  /** 이동평균 기간 (색 네모의 색을 고른다) */
  period: number;
  /** '120일 77,120원' — 안의 띄어쓰기는 줄바꿈 없는 공백이라 항목 안에서 줄이 바뀌지 않는다 */
  text: string;
}

/**
 * 차트 아래 이동평균 값 줄의 항목 (십자선이 잡은 봉, 없으면 마지막 봉). 진단 24번:
 * 예전에는 한 줄 글자로 이어 써서 글자 130% 에서 '120일'과 '77,120원'이 다른 줄로 떨어지거나 색 네모만 윗줄에 남았다.
 * 이제 항목마다 따로 그리고(PriceChart 의 MaLine), 항목 안 공백은 줄바꿈 없는 공백으로 둔다 → 줄은 항목 단위로만 바뀐다
 */
export function maLegendItems(mas: { period: number; values: Series }[], index: number, unit: ChartUnit, candle: CandlePeriod): MaLegendItem[] {
  const word = candle === "W" ? "주" : candle === "M" ? "월" : candle === "D" ? "일" : "봉";
  return mas.map((m) => {
    const v = m.values[index];
    const value = v === null || v === undefined ? "-" : formatChartValue(v, unit);
    return { period: m.period, text: `${m.period}${word} ${value}`.replace(/ /g, " ") };
  });
}

// ── 칩 띠 가장자리 ──

export interface FadeEdges {
  left: boolean;
  right: boolean;
}

export const NO_FADE: FadeEdges = Object.freeze({ left: false, right: false });

/** 1dp 안쪽 차이는 끝에 닿은 것으로 본다 (소수점 폭·스크롤 위치 오차) */
const EDGE_EPS = 1;

/**
 * 옆으로 넘기는 칩 띠(기간·이동평균 칩)에서 더 넘길 내용이 있는 쪽 (진단 25번). 그쪽 가장자리를 바탕색으로 흐리게 칠해
 * 반쯤 잘린 칩이 깨진 글자가 아니라 넘길 수 있다는 표시로 보이게 한다. 내용이 다 보이면(넘길 수 없으면) 양쪽 모두 false
 */
export function fadeEdges(m: { view: number; content: number; x: number }): FadeEdges {
  if (!(m.view > 0) || !(m.content > m.view + EDGE_EPS)) return NO_FADE;
  const x = Number.isFinite(m.x) ? m.x : 0;
  return { left: x > EDGE_EPS, right: x + m.view < m.content - EDGE_EPS };
}

export function sameEdges(a: FadeEdges, b: FadeEdges): boolean {
  return a.left === b.left && a.right === b.right;
}
