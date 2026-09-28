import type { Db } from "../src/db/index.js";
import type { CandlePeriod, CandleSeries, ListedStock } from "../src/domain/types.js";
import type { GenerateRequest, GenerateResult } from "../src/llm/generator.js";
import type { Providers } from "../src/providers/index.js";
import { benchOf, candlesOf } from "./fixtures/indicatorScores/load.js";
import { FakeGenerator, FakeMasterProvider, FakeQuoteProvider, fakeIndices, SAMPLE_MASTER } from "./helpers.js";

/**
 * 등록 표 이름 카나리아 (계정 A단계 검증 8차). 주인 등록 표의 이름·시장이 종목 마스터·검색 값과 다를 때(토스 동기화 이름 등)
 * 공유 캐시(AI 분석 글·지표 점수 계산)에 실려 주인 아닌 계정에게 나가는지 본다. 그러려면 가짜 출처가 이름을 **본문에 실어야** 한다:
 *  - EchoGenerator: 분석 글에 프롬프트(종목: 이름 (코드) · 데이터 JSON · 이름으로 찾은 뉴스)를 그대로 쓴다
 *  - RecordedQuotes · recordedIndices: 레버리지 상품(SOXL·RGTX)과 기초자산(SOXX·RGTI)의 기록한 일봉 + 비교 지수(나스닥) 일봉 —
 *    기초자산이 일봉으로 확인되어야 '기초자산 참고' 줄(이름 포함)이 생긴다
 *  - 주인 등록 표: 삼성전자·기초자산 SOXX 의 이름(과 SOXX 시장)을 마스터와 다르게, 마스터·검색에 없는 종목(900001)·기초자산(RGTI)은 등록 표에만
 */
export const NAME_CANARY = {
  /** 주인 등록 종목 005930 의 등록 표 이름 */
  stock: "카나리아전자",
  /** 레버리지 SOXL 의 기초자산 SOXX 를 주인이 등록해 둔 이름 (시장도 US 로 — 마스터는 NASDAQ) */
  underlying: "카나리아반도체",
  /** 등록 표에만 있는 종목 (마스터·검색에 없음) */
  only: "카나리아비상장",
  /** 등록 표에만 있는 기초자산 (RGTX 의 RGTI) */
  onlyUnderlying: "카나리아양자",
} as const;
export const NAME_MARKS: readonly string[] = Object.values(NAME_CANARY);
/** 등록 표에만 있는 종목 코드 (FakeSearchProvider 는 000660 만 돌려주므로 미리 보기로 찾지 못함) */
export const REGISTERED_ONLY = "900001";
/** 마스터·검색에도 없고 등록도 안 된 종목 코드 (404 비교용) */
export const UNKNOWN = "900002";

/** 미국 종목 마스터 (공개 이름). RGTI 는 일부러 없다 — 주인 등록 표에만 있는 기초자산 */
export const US_MASTER: ListedStock[] = [
  { code: "SOXX", name: "아이셰어즈 반도체 ETF", market: "NASDAQ", isinCode: "US4642875235", groupCode: "EF" },
  { code: "SOXL", name: "디렉시온 반도체 3배 ETF", market: "AMEX", isinCode: "US25459W4583", groupCode: "EF" },
  { code: "RGTX", name: "디파이언스 리게티 2배 ETF", market: "NASDAQ", isinCode: "US26923N6760", groupCode: "EF" },
];

/** 분석 글에 프롬프트를 그대로 쓰는 가짜 모델 (브리핑 요약은 FakeGenerator 그대로) */
export class EchoGenerator extends FakeGenerator {
  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    const r = await super.generate(req);
    return (req.label ?? "").startsWith("briefing_summary") ? r : { ...r, text: `## 한 줄 요약\n${req.user}` };
  }
}

const RECORDED = new Set(["SOXL", "SOXX", "RGTX", "RGTI"]);

/** 레버리지 상품·기초자산은 기록한 일봉, 나머지는 FakeQuoteProvider 의 가짜 봉 */
export class RecordedQuotes extends FakeQuoteProvider {
  override async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    if (period !== "D" || !RECORDED.has(code)) return super.getCandles(code, period, count);
    this.calls++;
    return { code, period, candles: candlesOf(code).slice(-count), source: this.name };
  }
}

/** 지수 띠는 fakeIndices 그대로, 비교 지수 일봉(나스닥·S&P500)은 기록한 나스닥 종합 */
export function recordedIndices() {
  const m = fakeIndices();
  m.candles = async (code: string, period: CandlePeriod, count: number) =>
    period === "D" && (code === "NASDAQ" || code === "SPX") ? { code, period, candles: benchOf("SOXX").slice(-count), source: "naver" } : null;
  return m;
}

/** 이름 카나리아용 가짜 출처 (fakeProviders 에 덮어쓴다) */
export function nameCanaryProviders(): Partial<Providers> & { quotes: RecordedQuotes } {
  return { quotes: new RecordedQuotes("kis"), master: new FakeMasterProvider([...SAMPLE_MASTER, ...US_MASTER]), indices: recordedIndices(), generator: new EchoGenerator() };
}

/**
 * 주인 등록 표를 토스 동기화처럼 바꾼다 (등록 경로를 거친 005930·SOXX 가 있어야 한다): 이름·시장을 마스터와 다르게,
 * 마스터·검색에 없는 종목과 기초자산을 등록 표에만 넣는다 (ts = 그 두 행의 등록 시각)
 */
export async function plantRegisteredNames(db: Db, ts: string): Promise<void> {
  await db.updateTable("registered_stocks").set({ name: NAME_CANARY.stock }).where("code", "=", "005930").execute();
  await db.updateTable("registered_stocks").set({ name: NAME_CANARY.underlying, market: "US" }).where("code", "=", "SOXX").execute();
  await db
    .insertInto("registered_stocks")
    .values([
      { code: REGISTERED_ONLY, name: NAME_CANARY.only, market: "KOSPI", quantity: 1, avg_price: 1000, memo: null, created_at: ts, updated_at: ts },
      { code: "RGTI", name: NAME_CANARY.onlyUnderlying, market: "NASDAQ", quantity: 1, avg_price: 10, memo: null, created_at: ts, updated_at: ts },
    ])
    .execute();
}

/** 주인 앱처럼 공유 캐시를 먼저 채운다 (분석 글·지표 점수) — 가입자가 그 캐시를 받는지 보려고 */
export const OWNER_WARM_URLS: readonly string[] = [
  ...["005930", "SOXX", REGISTERED_ONLY].flatMap((c) => ["company", "value", "technical"].map((k) => `/api/stocks/${c}/analysis/${k}`)),
  ...["005930", "SOXX", "SOXL", "RGTX", REGISTERED_ONLY].map((c) => `/api/scores/${c}`),
];

/** 가입자로 모든 GET 을 부를 때 경로의 :code · :kind 를 채우는 벌 (분석 하루 한도 안에서) */
export const MEMBER_VARIANTS: ReadonlyArray<{ code: string; kind: string }> = [
  { code: "005930", kind: "company" },
  { code: "SOXX", kind: "technical" },
  { code: "SOXL", kind: "value" },
  { code: "RGTX", kind: "company" },
  { code: REGISTERED_ONLY, kind: "company" },
];
