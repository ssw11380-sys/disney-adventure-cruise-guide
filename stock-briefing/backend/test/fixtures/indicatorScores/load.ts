import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Candle } from "../../../src/domain/types.js";

/**
 * 추세 지표 점수 픽스처 읽기 (test/fixtures/indicatorScores).
 *  - candles.json: 야후 공개 일봉 기록(2026-09-28)에서 계산에 필요한 끝부분만 — 미국(나스닥 비교) 10종목, 한국(코스피 비교) 3종목, 레버리지 상품 2개(SOXL·RGTX)
 *  - expected.json: 설계 단계의 기준 구현(trend-score.mjs)이 같은 입력으로 낸 값 (식 이식 검증용)
 * 압축 모양: 시장마다 날짜 목록 하나, 종목은 start 부터 차례로 시가(o)·종가(c)·거래량(v) (null = 그날 봉 없음)
 */

interface Block {
  dates: string[];
  bench: { code: string; yahoo: string; start: number; c: (number | null)[] };
  stocks: Record<string, { market: "US" | "KR"; exchange: string; name: string; start: number; o: (number | null)[]; c: (number | null)[]; v: (number | null)[] }>;
}
interface Fixture {
  US: Block;
  KR: Block;
  products: Block;
}

const read = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")) as unknown;

let cached: Fixture | null = null;
const fixture = (): Fixture => (cached ??= read("candles.json") as Fixture);

/** 기준 구현의 기대값 */
export const expected = read("expected.json") as {
  cal: string;
  trend: Record<string, ExpectedTrend>;
  full: Record<string, { score: number; band: string }>;
  leveraged: Record<string, { L: number; sigUnderlyingAnnPct: number; sigEtfAnnPct: number; volDecayPctPerYear: number; etf63Pct: number; und63Pct: number; naiveLx63Pct: number; etfMdd1yPct: number }>;
  shortHistory: { status: string; reason: string };
};

export interface ExpectedTrend {
  status: string;
  asOf: string;
  bars: number;
  score: number;
  scoreToday: number;
  daysAveraged: number;
  coverage: number;
  families: Record<string, number | null>;
  subs: Record<string, number>;
  subsToday: Record<string, number>;
  raw: Record<string, unknown>;
  notes: string[];
}

function blockOf(sym: string): Block {
  const f = fixture();
  for (const b of [f.US, f.KR, f.products]) if (b.stocks[sym]) return b;
  throw new Error(`픽스처에 없는 종목: ${sym}`);
}

/** 종목 일봉 (오래된 → 최신). high·low 는 기록에서 뺐으므로 종가로 채운다 (추세 점수는 쓰지 않음) */
export function candlesOf(sym: string): Candle[] {
  const b = blockOf(sym);
  const st = b.stocks[sym]!;
  const out: Candle[] = [];
  st.c.forEach((close, i) => {
    if (close === null) return;
    out.push({ date: b.dates[st.start + i]!, open: st.o[i]!, high: close, low: close, close, volume: st.v[i] ?? 0 });
  });
  return out;
}

/** 그 종목 시장의 비교 지수 일봉 (미국 = 나스닥 종합, 한국 = 코스피) */
export function benchOf(sym: string): Candle[] {
  const b = blockOf(sym);
  const block = b === fixture().products ? fixture().US : b;
  const out: Candle[] = [];
  block.bench.c.forEach((close, i) => {
    if (close !== null) out.push({ date: block.dates[block.bench.start + i]!, open: close, high: close, low: close, close, volume: 0 });
  });
  return out;
}

export const US_SYMBOLS = ["NVDA", "MSFT", "AAPL", "AVGO", "META", "TSLA", "PLTR", "SOXX", "RGTI", "QQQ"] as const;
export const KR_SYMBOLS = ["005930.KS", "000660.KS", "035420.KS"] as const;

/** 토스 웹 v2/stock-infos 원본 응답 (2026-09-28 기록) */
export const tossInfo = (sym: "SOXL" | "RGTX" | "MSFT") => (read(`toss-info-${sym}.json`) as { result: Record<string, unknown> }).result;
