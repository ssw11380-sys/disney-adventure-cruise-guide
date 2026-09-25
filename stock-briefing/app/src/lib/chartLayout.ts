import type { CandlePeriod, ChartUnit } from "@/api/types";
import { formatPrice } from "@/lib/format";
import type { Series } from "@/lib/indicators";
import { clampScale, LINE } from "@/lib/textScale";
import { font, fontCap, layout, space, touch } from "@/tokens";

/**
 * 차트 화면 배치 계산 (3-42 접는 폰 · 폴드 진단 8·22·24·25·6·7번). React Native 를 불러오지 않는 순수 모듈 (테스트용).
 *  - candleChartSize: 종목·지수 상세 차트 그림의 폭·높이 (휴대폰 화면은 3-42 이전 식 그대로 — phoneChartWidth)
 *  - headerNeedsTwoLines · chartHeaderLayout: 전체 화면 차트 머리 (한 줄로 그려 재 보고 넘칠 때만 가격·등락을 둘째 줄로, 머리 높이)
 *  - maLegendItems: 차트 아래 이동평균 값 줄의 항목 (한 항목이 두 줄로 나뉘지 않게 — 넓은 창만)
 *  - fadeEdges: 옆으로 넘기는 칩 띠에서 흐리게 칠할 가장자리 (넓은 창만)
 * 기준 숫자는 tokens.ts 의 layout·space·font (폰 실측 전 추정값은 토큰만 바꾼다)
 */

// ── 상세 차트 크기 ──

/** 상세 차트를 담은 패널의 좌우 안쪽 여백 (종목 상세·지수 상세 panel 의 paddingHorizontal). 폭을 재기 전 첫 그림의 어림에만 쓴다 */
export const CHART_PANEL_PAD = space.lg;

export interface ChartSizeInput {
  /**
   * 차트 묶음이 실제로 받은 폭 (onLayout). 넓은 창(wide)에서만 쓴다 — 휴대폰 화면은 예전처럼 창 폭으로 정한다.
   * 아직 재지 못했으면 null → 창 폭 − 패널 좌우 여백으로 어림.
   * 잰 값이 창 폭 − 패널 여백보다 넓으면(창이 좁아졌는데 새 폭을 아직 재지 못함) 창 쪽으로 줄인다
   */
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
 * 휴대폰 화면(좁은 창 · foldLayout 꺼짐)의 상세 차트 폭: 3-42 이전 식 그대로 min(창 폭 − 패널 여백 × 4, 720).
 * 패널 여백을 두 번 빼서 오른쪽에 28dp 빈 띠가 남지만(진단 22번), 사용자 결정 '접은 화면은 지금 그대로'(2026-09-26)에 따라
 * 휴대폰 화면에서는 고치지 않는다 — 고치면 차트가 커져 첫 화면 핵심 숫자가 줄었다(폴드8 접힘 419×260 → 447×277, 5개 → 3개).
 * 소수점 창 폭도 예전처럼 그대로 쓴다 (내리지 않는다). 창 폭을 모르면(0·NaN) 0
 */
export function phoneChartWidth(windowWidth: number): number {
  const w = Math.min(windowWidth - CHART_PANEL_PAD * 4, layout.chartMaxW);
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * 상세 차트 그림 크기.
 *  - 좁은 창(휴대폰·접힌 화면)이거나 foldLayout 이 꺼져 있으면(wide=false) 3-42 이전과 똑같다: 폭 = phoneChartWidth(창 폭),
 *    높이 = 폭 × chartAspect(0.62). 잰 폭(box)은 쓰지 않는다 → 접은 화면 첫 화면이 main 과 같다 (사용자 결정 '접은 화면은 지금 그대로')
 *  - 넓은 창(wide = 플래그 켜짐 + 폭 등급 중간 이상)만 새 규칙:
 *    · 폭은 창 폭이 아니라 차트 묶음이 실제로 받은 폭(패널 안쪽) — 28dp 빈 띠가 없다 (진단 22번)
 *    · 잰 폭은 창 폭 − 패널 여백을 넘지 않게 줄인다. 창이 바뀌었는데 onLayout 이 한 박자 늦을 때(펼친 가로 → 세로 등)
 *      지난 창에서 잰 폭으로 그려 화면 밖으로 넘치지 않게. 창보다 좁은 자리(2단 오른쪽 칸·탭 막대 옆)는 잰 폭 그대로
 *    · 폭 상한 없이 다 쓰고, 높이 = min(폭 × 0.62, 창 높이 × chartMaxHRatio(0.5)) →
 *      낮고 넓은 창(펼친 폴드8 가로 933×704)에서도 날짜 줄까지 첫 화면에 들어온다 (진단 6·7번).
 *      단 창이 아주 낮아도 chartMinH(200) 아래로는 줄이지 않고(그 폭의 폭 × 0.62 보다 높이지도 않는다),
 *      창 폭 600(좁음 ↔ 중간 경계)부터 chartCapRamp(96) 만큼에 걸쳐 상한을 서서히 건다 → 경계에서 높이가 355 → 200 처럼 뛰지 않는다.
 *      (경계 599 → 600 에서는 폭 식이 휴대폰 식 → 잰 폭으로 바뀌어 폭이 28dp, 높이가 그 폭만큼(약 18dp) 한 번 달라진다)
 */
export function candleChartSize(o: ChartSizeInput): { width: number; height: number } {
  if (o.width !== undefined) return { width: o.width, height: o.height ?? Math.round(o.width * layout.chartAspect) };
  if (!o.wide) {
    const width = phoneChartWidth(o.window.width);
    return { width, height: o.height ?? Math.round(width * layout.chartAspect) };
  }
  const guess = o.window.width - CHART_PANEL_PAD * 2;
  const guessOk = Number.isFinite(guess) && guess > 0;
  const boxOk = o.box !== null && Number.isFinite(o.box) && o.box > 0;
  // 잰 폭 우선, 단 창 폭 − 패널 여백보다 넓으면 창 쪽으로 (창이 좁아졌는데 아직 다시 재지 못함)
  const measured = boxOk ? (guessOk ? Math.min(o.box!, guess) : o.box!) : guess;
  // 소수점 폭은 내림 (그림이 패널 밖으로 1px 넘치지 않게)
  const width = Math.max(0, Math.floor(Number.isFinite(measured) ? measured : 0));
  const natural = Math.round(width * layout.chartAspect);
  if (o.height !== undefined) return { width, height: o.height };
  if (!(o.window.height > 0)) return { width, height: natural };
  // 넓은 창 높이 상한: 창 높이 × 0.5, 하한 chartMinH. 어느 쪽도 그 폭의 폭 × 0.62(natural) 보다 높이지 않는다
  const capped = Math.min(natural, Math.max(layout.chartMinH, Math.round(o.window.height * layout.chartMaxHRatio)));
  // 폭 600 에서 0 → 600 + chartCapRamp 에서 1: 상한을 거는 정도 (좁은 창 높이와 이어지게)
  const ramp = Math.min(1, Math.max(0, (o.window.width - layout.mediumMin) / layout.chartCapRamp));
  return { width, height: Math.round(natural - (natural - capped) * (Number.isFinite(ramp) ? ramp : 1)) };
}

// ── 전체 화면 차트 머리 ──

/** 전체 화면 차트 머리의 둥근 아이콘 버튼(가로로 보기·닫기) 크기. 누르는 영역은 hitSlop 으로 44 */
export const CHART_ICON_BTN = 34;
/** 머리 한 줄에서 이름이 줄어들어도 남기는 글자 수. 이만큼도 남지 않으면 가격·등락을 둘째 줄로 내린다 */
export const NAME_MIN_CHARS = 4;
/** 글자 폭 어림 여유 (실제 글꼴보다 조금 넓게 잡는다 — 넓은 창 상세 머리 lib/detailLayout 도 쓴다) */
const WIDTH_SLACK = 1.05;
/** 잰 폭의 소수점 오차 (이만큼 안쪽이면 꽉 찬 것으로 본다) */
const FIT_EPS = 0.5;

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

/**
 * 머리 오른쪽 버튼 묶음이 차지하는 폭 + 왼쪽 글자 묶음과의 간격 (chart.tsx: 버튼 사이 space.sm, 머리 줄 gap space.sm).
 * 머리 폭에서 이것을 뺀 것이 이름·가격·등락 한 줄이 쓸 수 있는 폭이다
 */
export function headerButtonsRoom(buttons: number): number {
  return buttons > 0 ? buttons * CHART_ICON_BTN + (buttons - 1) * space.sm + space.sm : 0;
}

/** 이름이 한 줄 머리에서 지켜야 하는 폭 (어림): 앞 NAME_MIN_CHARS 자 + '…' (그보다 짧은 이름은 전부), 글자 배율은 fontCap.chrome 까지 */
export function nameMinWidth(name: string, fontScale: number): number {
  const chars = [...name];
  const keep = chars.length <= NAME_MIN_CHARS ? name : `${chars.slice(0, NAME_MIN_CHARS).join("")}…`;
  return estimateTextWidth(keep, font.h2 * clampScale(fontScale, fontCap.chrome));
}

export interface ChartHeaderMeasure {
  /** 머리가 쓰는 폭 (차트 판의 좌우 여백을 뺀 값) */
  width: number;
  /** 오른쪽 둥근 버튼 수 (가로로 보기 + 닫기 = 2, 가로 창에서 가로로 보기를 숨기면 1) */
  buttons: number;
  /** 시스템 글자 배율 (1 = 100%) */
  fontScale: number;
  name: string;
  /** 한 줄 머리에서 잰 글자 묶음(이름·가격·등락) 폭 (onLayout) */
  title: number;
  /** 한 줄 머리에서 잰 이름 폭 — 자리가 모자라 줄어든 뒤의 폭 (onLayout) */
  nameWidth: number;
}

/**
 * 한 줄로 그려 본 머리를 재서, 가격·등락을 둘째 줄로 내려야 하는지 정한다 (진단 8번, 버그 수정 — 깨질 때만 고친다).
 *  - 글자 묶음이 쓸 수 있는 폭보다 좁으면(다 들어감) 늘 한 줄 → 3-42 이전(main)과 똑같은 머리 (사용자 결정 '접은 화면은 그대로').
 *    어림이 아니라 실제 글꼴로 잰 폭이라, 다 들어가는 짧은 이름(360 창 삼성전자 등)이 어림 때문에 두 줄로 가지 않는다
 *  - 꽉 찼으면(예전 머리라면 넘쳐서 가격이 '912,000 / 원'처럼 쪼개지던 경우) 이름만 '…'로 줄어든다.
 *    그래도 이름에 NAME_MIN_CHARS 자 폭(어림)도 남지 않으면 두 줄
 */
export function headerNeedsTwoLines(m: ChartHeaderMeasure): boolean {
  const room = m.width - headerButtonsRoom(m.buttons);
  if (![room, m.title, m.nameWidth].every(Number.isFinite)) return false;
  if (m.title < room - FIT_EPS) return false;
  return m.nameWidth < nameMinWidth(m.name, m.fontScale) - FIT_EPS;
}

export interface ChartHeaderInput {
  /** 시스템 글자 배율 (1 = 100%). 머리는 fontCap.chrome(150%) 까지만 커진다 */
  fontScale: number;
  /** 가격·등락이 있는가 (시세가 없으면 이름만 — 늘 한 줄) */
  quote: boolean;
  /**
   * 두 줄로 정했는가: headerNeedsTwoLines 로 잰 결과를 같은 창 폭·글자 배율·버튼 수·종목 이름 동안 기억한 값 (chart.tsx).
   * 한 번 두 줄이 되면 시세가 바뀌어 한 줄에 다시 들어가도 두 줄로 둔다 (시세가 움직일 때마다 머리가 44 ↔ 62 로 뛰지 않게)
   */
  twoLines: boolean;
}

export interface ChartHeaderLayout {
  /** 가격·등락을 이름 아래 둘째 줄로 내린다 (좁은 창 + 큰 글씨 + 긴 이름) */
  twoLines: boolean;
  /** 머리 최소 높이: 44 와 글자 배율(fontCap.chrome 까지)에 맞춘 줄 높이 중 큰 값 → 아래 도구 줄과 겹치지 않는다 */
  height: number;
}

/**
 * 전체 화면 차트 머리 배치 (진단 8번). 높이는 고정 44 대신 최소 44 에 글자 배율을 반영한다 (두 줄이면 두 줄 높이).
 * 한 줄이면 100~150% 글자에서 44 그대로 — 3-42 이전 머리와 같은 높이라 차트 크기도 같다.
 *
 * 두 줄로 갈지는 그려 본 한 줄 머리를 재서 정한다 (headerNeedsTwoLines). 재기 전(첫 그림)은 한 줄.
 * 한 번 두 줄이 되면(twoLines) 같은 창·글자·종목에서는 두 줄 그대로 둔다. 등락이 +990원 ↔ +1,000원, 보합 0원 ↔ ±100원처럼
 * 오가면 필요한 폭이 한 틱에 13~35dp 씩 바뀌어, 기준선에 걸린 창에서 머리가 44 ↔ 62 로 뛰고 차트도 오르내렸다.
 * 두 줄은 늘 안전하다(잘리지 않는다). 한 줄 → 두 줄은 넘쳐서 이름이 모자랄 때 바로 바꾼다
 */
export function chartHeaderLayout(o: ChartHeaderInput): ChartHeaderLayout {
  const s = clampScale(o.fontScale, fontCap.chrome);
  // 첫 줄: 이름(h2)과 둥근 버튼 중 높은 쪽. 둘째 줄: 가격(body) 한 줄 + 도구 줄과의 틈
  const line1 = Math.max(CHART_ICON_BTN, Math.ceil(font.h2 * LINE * s));
  if (!o.quote || !o.twoLines) return { twoLines: false, height: Math.max(touch.min, line1) };
  return { twoLines: true, height: Math.max(touch.min, line1 + space.xxs + Math.ceil(font.body * LINE * s) + space.xs) };
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
