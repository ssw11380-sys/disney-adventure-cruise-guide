import { sentence, speakRate } from "@/lib/a11y";
import { formatIndexValue, formatPct } from "@/lib/format";
import type { BoardColumnInput } from "./layout";
import { HOME_URI } from "./model";
import { WIDGET_BOARD_CODES, type WidgetIndex } from "./payload";

/**
 * 지수·환율 위젯 (APK 1.4.0) 화면 규칙 — 순수 함수 (RN·위젯 모듈 의존 없음 → 단위 테스트).
 *  - 항목·순서·구역은 여기 한 곳: 국내(코스피·코스닥) · 미국(나스닥·S&P500·다우·필라반도체) · 환율(원/달러·원/100엔·원/위안)
 *  - 값·등락 표기는 앱 지수 띠(MarketStrip)와 같은 함수: 값 formatIndexValue, 등락 "▲63.01 +0.90%" (좁으면 "+0.90%")
 *  - 출처 조회가 실패한 항목(stale)은 마지막 값을 흐리게 + "지연" — 장중 점을 찍지 않는다 (앱 indexLive 와 같은 규칙)
 *  - 누르면 그 지수·환율 차트 화면(market/[code])으로
 */

export type BoardSectionKey = "kr" | "us" | "fx";

export interface BoardSection {
  key: BoardSectionKey;
  /** 구역 이름 (금색 작은 글자) */
  label: string;
  codes: readonly string[];
}

/** 구역과 항목 순서. 4×2 는 구역마다 앞의 2개(코스피·코스닥 / 나스닥·S&P500 / 원/달러·원/100엔), 더 낮으면 앞의 1개 */
export const BOARD_SECTIONS: readonly BoardSection[] = [
  { key: "kr", label: "국내", codes: ["KOSPI", "KOSDAQ"] },
  { key: "us", label: "미국", codes: ["NASDAQ", "SPX", "DJI", "SOX"] },
  { key: "fx", label: "환율", codes: ["USDKRW", "JPYKRW", "CNYKRW"] },
];

/** 위젯에 보이는 이름 (서버 이름과 같다. 서버가 이름을 바꿔도 위젯 폭 어림이 흔들리지 않게 여기 고정) */
export const BOARD_LABEL: Record<string, string> = {
  KOSPI: "코스피",
  KOSDAQ: "코스닥",
  NASDAQ: "나스닥",
  SPX: "S&P500",
  DJI: "다우",
  SOX: "필라반도체",
  USDKRW: "원/달러",
  JPYKRW: "원/100엔",
  CNYKRW: "원/위안",
};

export const BOARD_TITLE = "지수·환율";

/** 구역 순서를 펼친 것 = 서버 board 순서 (payload.ts WIDGET_BOARD_CODES — 둘이 같은지는 테스트가 지킨다) */
export const BOARD_CODES: readonly string[] = BOARD_SECTIONS.flatMap((s) => s.codes);
export { WIDGET_BOARD_CODES };

export interface BoardTile {
  code: string;
  /** "코스피" */
  label: string;
  /** "7,080.92" — 값이 없으면 "-" */
  value: string;
  /** 등락 줄 후보를 긴 것부터: ["▲63.01 +0.90%", "+0.90%"] (값이 없으면 빈 배열) */
  changes: string[];
  change: number;
  changeRate: number;
  /** 서버가 이 항목을 줬는지 (한 번도 못 받은 출처는 "-") */
  has: boolean;
  /** 출처 조회가 실패해 마지막 값 (흐리게 + "지연") */
  stale: boolean;
  /** 장중 초록 점: 출처에서 장중을 확인한 지수만 (환율·지연 항목은 아님) */
  live: boolean;
  /** 화면 읽기: "코스피 3,412.35, 0.90% 상승" */
  speech: string;
  /** 누르면 가는 곳: 지수·환율 차트 화면 */
  uri: string;
}

const isFx = (code: string) => /KRW$/.test(code);

/** 지수·환율 차트 화면 딥링크 (앱 라우트 market/[code]) */
export function marketUri(code: string): string {
  return `${HOME_URI}market/${code}`;
}

/** 등락 줄: 앱 지수 띠와 같은 "▲63.01 +0.90%", 좁으면 등락률만 "+0.90%" */
export function boardChanges(change: number, changeRate: number): string[] {
  const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "";
  const pct = formatPct(changeRate);
  return [`${arrow}${formatIndexValue(Math.abs(change))} ${pct}`, pct];
}

function tileOf(code: string, i: WidgetIndex | undefined): BoardTile {
  const label = BOARD_LABEL[code] ?? i?.name ?? code;
  const uri = marketUri(code);
  if (!i || !Number.isFinite(i.value)) {
    return { code, label, value: "-", changes: [], change: 0, changeRate: 0, has: false, stale: false, live: false, speech: `${label} 시세 없음`, uri };
  }
  const stale = i.stale === true;
  const live = i.open && !isFx(code) && !stale;
  const value = formatIndexValue(i.value);
  return {
    code,
    label,
    value,
    changes: boardChanges(i.change, i.changeRate),
    change: i.change,
    changeRate: i.changeRate,
    has: true,
    stale,
    live,
    speech: sentence([`${label} ${value}`, speakRate(i.changeRate), live ? "장중" : null, stale ? "시세 지연" : null]),
    uri,
  };
}

/** 받은 판(서버 board 또는 앱 지수 띠) → 9칸, 구역 순서대로. 받지 못한 항목은 "-" 칸 (자리를 지켜 줄이 어긋나지 않게) */
export function boardTiles(list: readonly WidgetIndex[] | null | undefined): BoardTile[] {
  const byCode = new Map((list ?? []).map((i) => [i.code, i]));
  return BOARD_CODES.map((code) => tileOf(code, byCode.get(code)));
}

/** 판에 보여 줄 값이 하나라도 있는지 */
export function boardHasData(list: readonly WidgetIndex[] | null | undefined): boolean {
  return boardTiles(list).some((t) => t.has);
}

/** 칸 → 배치 입력 (layout.ts planMarket): 구역마다 세로 칸, 이름 옆 표시는 장중 점 · "지연" · 없음 */
export function boardColumns(tiles: readonly BoardTile[]): BoardColumnInput[] {
  const byCode = new Map(tiles.map((t) => [t.code, t]));
  return BOARD_SECTIONS.map((sec) => ({
    key: sec.key,
    label: sec.label,
    tiles: sec.codes.flatMap((code) => {
      const t = byCode.get(code);
      return t ? [{ code, label: t.label, value: t.value, changes: t.changes, marker: t.live ? ("live" as const) : t.stale ? ("stale" as const) : null }] : [];
    }),
  }));
}
