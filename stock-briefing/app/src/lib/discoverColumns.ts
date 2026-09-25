import { clampScale } from "@/lib/textScale";
import { fontCap, foldScreens, space } from "@/tokens";

/**
 * 발견 순위 표의 열 고르기 (3-42 웨이브 E, 넓은 창 + 기능 플래그 foldLayout).
 * React Native 를 불러오지 않는 순수 모듈 (테스트용). 잔고 표의 열 고르기와 같은 생각이지만 파일은 따로 둔다.
 *
 * 표 한 줄: 순위 | 종목 | 현재가 | 등락률 | 거래대금 | 거래량 | 시가총액 | 보유
 *  - 열 순서는 늘 이대로 (폰에서 보던 현재가·등락률 다음에 넓어진 만큼 오른쪽에 붙는다)
 *  - 폭이 모자라면 덜 중요한 열부터 뺀다: 보유 표시 → 시가총액 → 분류 값이 아닌 쪽(거래대금 분류면 거래량, 거래량 분류면 거래대금)
 *  - 현재가·등락률과 지금 고른 분류의 값(거래량 분류면 거래량, 나머지는 거래대금)은 늘 둔다
 *  - 보유 표시 열을 뺐으면 이름 옆에 작은 표시로 보인다 (inlineMark)
 *  - 이름 칸이 최대 폭(discoverNameMax)보다 넓게 남으면 넘는 폭을 숫자 열에 고루 나눈다 (이름과 현재가 사이가 벌어지지 않게)
 * 열 폭과 이름 칸 최소 폭은 글자 배율(최대 fontCap.row 140%)만큼 넓혀서 계산한다 → 큰 글씨에서는 열이 줄어든다.
 */

export type DiscoverColKey = "price" | "rate" | "tradingValue" | "volume" | "marketCap" | "mark";
/** 분류마다 늘 보이는 값: 거래량 순위는 거래량, 나머지(거래대금·급상승·급하락)는 거래대금 */
export type DiscoverMetric = "tradingValue" | "volume";

/** 표 순서 */
export const DISCOVER_COL_ORDER: readonly DiscoverColKey[] = ["price", "rate", "tradingValue", "volume", "marketCap", "mark"];

/** 줄 좌우 여백과 칸 사이 간격 (표 머리와 줄이 같은 값을 쓴다) */
export const DISCOVER_PAD = space.lg;
export const DISCOVER_GAP = space.sm;

export interface DiscoverCol {
  key: DiscoverColKey;
  width: number;
}

export interface DiscoverTableCols {
  /** 순위 칸 폭 */
  rank: number;
  /** 이름 칸이 받는 폭 (나머지 전부) */
  name: number;
  /** 이름 칸 오른쪽 열 (표 순서) */
  cols: DiscoverCol[];
  /** 보유 표시 열이 없어 이름 옆에 표시를 붙인다 */
  inlineMark: boolean;
}

/** 빼는 순서 (앞에서부터 먼저 뺀다) */
function dropOrder(metric: DiscoverMetric): DiscoverColKey[] {
  return ["mark", "marketCap", metric === "volume" ? "tradingValue" : "volume"];
}

/**
 * 표가 실제로 받은 폭(width, 좌우 여백 포함) → 보일 열.
 * 폭을 모르면(0·NaN) 가장 적은 열(현재가·등락률·분류 값)로 본다
 */
export function pickDiscoverCols(width: number, fontScale: number, metric: DiscoverMetric): DiscoverTableCols {
  const k = clampScale(fontScale, fontCap.row);
  // 순위 숫자는 120% 까지만 커진다 (StockLine 과 같음)
  const rank = Math.round(foldScreens.discoverCol.rank * Math.min(k, 1.2));
  const nameMin = Math.round(foldScreens.discoverNameMin * k);
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const colW = (key: DiscoverColKey) => Math.round(foldScreens.discoverCol[key] * k);
  let keys = [...DISCOVER_COL_ORDER];
  const nameOf = (ks: DiscoverColKey[]) => w - 2 * DISCOVER_PAD - rank - DISCOVER_GAP - ks.reduce((s, key) => s + DISCOVER_GAP + colW(key), 0);
  for (const drop of dropOrder(metric)) {
    if (nameOf(keys) >= nameMin) break;
    keys = keys.filter((key) => key !== drop);
  }
  // 이름 칸이 최대 폭보다 넓게 남으면 넘는 만큼을 숫자 열에 고루 나눈다 (나머지 몇 dp 는 이름 칸에)
  const name = Math.max(0, nameOf(keys));
  const nameMax = Math.round(foldScreens.discoverNameMax * k);
  const extra = name > nameMax ? Math.floor((name - nameMax) / keys.length) : 0;
  return {
    rank,
    name: name - extra * keys.length,
    cols: keys.map((key) => ({ key, width: colW(key) + extra })),
    inlineMark: !keys.includes("mark"),
  };
}

/** 넓은 창 테마 히트맵 칸 수: 폭 ÷ 타일 기준 폭(큰 글씨는 배율의 절반만큼 넓힘), 적어도 지금의 3칸 */
export function heatColumns(width: number, fontScale: number): number {
  if (!(Number.isFinite(width) && width > 0)) return 3;
  const tile = foldScreens.heatTileW * (1 + (clampScale(fontScale, fontCap.row) - 1) / 2);
  return Math.max(3, Math.floor(width / tile));
}
