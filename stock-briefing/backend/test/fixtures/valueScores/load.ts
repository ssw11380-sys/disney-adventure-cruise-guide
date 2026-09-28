import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { ValueReferenceData } from "../../../src/analysis/valueScore.js";
import type { Candle } from "../../../src/domain/types.js";
import type { ValueSources } from "../../../src/services/valueScoreService.js";
import type { FrameRow, ReferenceSources, ScreenerRow } from "../../../src/services/valueReference.js";

/**
 * 가치 지표 점수 픽스처 (test/fixtures/valueScores, 2026-09-28 기록 — 모두 로그인 없는 공개 자료).
 *  - sec/<티커>.json.gz: SEC companyfacts 원본에서 가치 지표 태그·정기 보고서·2019-06 이후 기간만 남긴 것 (SEC 모양 그대로)
 *    MSFT(6월 결산, 최근 = 10-K) · NVDA(1월 결산, 설비투자·이자 태그 바뀜) · AAPL(9월 결산, 9개월 누적) · META · JPM(은행) · RGTI(적자)
 *  - reference.json.gz: 2026-09-26 에 실제로 만든 비교 기준(SEC frames + Nasdaq 스크리너, 모집단 3,055곳)에서 시험 종목 업종·금융사 전부와
 *    나머지 1/4 만 남긴 것 (지표 채택 비율·시장 기준값은 원래 값)
 *  - prices.json: 야후 공개 차트 — JPM·S&P500 일봉, 6종목 월봉 (2026-09-25 종가까지)
 *  - screener-sample.json · frame-sample.json: 파서 시험용 원본 조각
 */

const here = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const gz = (name: string) => JSON.parse(gunzipSync(readFileSync(here(name))).toString("utf8")) as unknown;

export const SEC_TICKERS = ["MSFT", "NVDA", "AAPL", "META", "JPM", "RGTI"] as const;
export type SecTicker = (typeof SEC_TICKERS)[number];
export const CIK: Record<SecTicker, string> = { MSFT: "0000789019", NVDA: "0001045810", AAPL: "0000320193", META: "0001326801", JPM: "0000019617", RGTI: "0001838359" };
/** SEC SIC (submissions, 2026-09-28) */
export const SIC: Record<SecTicker, number> = { MSFT: 7372, NVDA: 3674, AAPL: 3571, META: 7370, JPM: 6021, RGTI: 7371 };

export const secFacts = (t: SecTicker) => gz(`sec/${t}.json.gz`) as Record<string, unknown>;
export const referenceData = () => gz("reference.json.gz") as ValueReferenceData;
export const screenerSample = () => JSON.parse(readFileSync(here("screener-sample.json"), "utf8")) as unknown;
export const frameSample = () => JSON.parse(readFileSync(here("frame-sample.json"), "utf8")) as unknown;

interface Prices {
  daily: Record<string, { dates: string[]; o: number[]; c: number[]; v: number[] }>;
  monthly: Record<string, { dates: string[]; c: number[] }>;
}
let prices: Prices | null = null;
const P = (): Prices => (prices ??= JSON.parse(readFileSync(here("prices.json"), "utf8")) as Prices);

/** 일봉 (JPM · SPX) — 고가·저가는 기록하지 않아 종가로 채운다 */
export function dailyOf(sym: "JPM" | "SPX"): Candle[] {
  const d = P().daily[sym]!;
  return d.dates.map((date, i) => ({ date, open: d.o[i]!, high: d.c[i]!, low: d.c[i]!, close: d.c[i]!, volume: d.v[i] ?? 0 }));
}
/** 월봉 종가 (날짜는 그달 첫 거래일, 마지막 줄은 9월 — 진행 중인 달) */
export function monthlyOf(sym: string): Candle[] | null {
  const m = P().monthly[sym];
  if (!m) return null;
  return m.dates.map((date, i) => ({ date, open: m.c[i]!, high: m.c[i]!, low: m.c[i]!, close: m.c[i]!, volume: 0 }));
}

/**
 * 가짜 가치 지표 출처: companyfacts 는 픽스처(없는 티커는 null = SEC 목록에 없음), SIC 는 위 표.
 * facts 를 넘기면 그 티커 → 픽스처 티커로 바꿔 준다 (예시 종목). 부른 횟수를 센다
 */
export function fakeValueSources(opts: { alias?: Record<string, SecTicker>; failFacts?: Set<string>; hold?: Map<string, Promise<void>>; reference?: ReferenceSources; sicOf?: (cik: string) => number | null } = {}) {
  const calls = { facts: [] as string[], sic: 0, screener: 0, tickers: 0, frames: 0 };
  const src: ValueSources = {
    companyFacts: async (code) => {
      calls.facts.push(code);
      const wait = opts.hold?.get(code);
      if (wait) await wait;
      if (opts.failFacts?.has(code)) throw new Error("가짜 SEC 받기 실패");
      const t = (opts.alias?.[code] ?? code) as SecTicker;
      if (!(SEC_TICKERS as readonly string[]).includes(t)) return null;
      return { cik: CIK[t], raw: secFacts(t) };
    },
    sic: async (cik) => {
      calls.sic++;
      if (opts.sicOf) return opts.sicOf(cik);
      const t = (Object.keys(CIK) as SecTicker[]).find((k) => CIK[k] === cik);
      return t ? SIC[t] : null;
    },
    reference: opts.reference ?? {
      screener: async () => {
        calls.screener++;
        return [] as ScreenerRow[];
      },
      tickers: async () => {
        calls.tickers++;
        return new Map();
      },
      frame: async () => {
        calls.frames++;
        return [] as FrameRow[];
      },
    },
  };
  return { src, calls };
}
