import type { Selectable } from "kysely";
import type { Db } from "../db/index.js";
import type { TradeExecutionTable } from "../db/schema.js";
import type { CandlePeriod, CandleSeries } from "../domain/types.js";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import { mapLimit } from "../lib/concurrency.js";
import { AppError, within } from "../lib/errors.js";
import { seoulDate, seoulIso } from "../lib/time.js";
import type { TossHolding, TossOrderHistory, TossOrderRecord } from "../providers/market/tossOpenApi.js";
import { KrwCostBook } from "./krwCostBook.js";
import { tradingDate } from "./marketContext.js";
import { ACCOUNTS_KEY } from "./tossSyncService.js";
import {
  addDays,
  buildSnapshotData,
  CLOSE_TOLERANCE_MS,
  DOUBT_ACCEPT_MS,
  DOUBT_CARRY_MAX_MS,
  doubtCarriesOver,
  isTradingDay,
  MARKET_NAME,
  marketOf,
  md,
  missingDates,
  netTradedBetween,
  recentExpectedDates,
  sessionDate,
  snapshotDueAt,
  snapshotDoubts,
  snapshotPlan,
  tradingDaysBetween,
  unexplainedChanges,
  type AccountHoldings,
  type AccountOverview,
  type DoubtKind,
  type EstimatedChange,
  type PrevSnapshotInfo,
  type RecordMarket,
  type SnapshotData,
  type SnapshotDoubt,
  type SnapshotHolding,
  type SnapshotMethod,
  type SnapshotPlan,
  type SnapshotTotals,
} from "./tradeRecordCalc.js";

/**
 * 매매 기록 기반 (3-36, 플래그 tradeRecords) — 실현손익·기간 수익률·양도세 추정(3-37)과 브리핑 '어제와 비교'에 쓸 원자료를 쌓는다.
 *
 * 1) 일별 계좌 스냅샷: 1분마다 확인해 시장(한국·미국)의 예약 시각(한국 16:05, 미국 정규장 마감 5분 뒤 — tradeRecordCalc)이 지났는데
 *    그 거래일 줄이 없으면 토스 보유 조회(/api/v1/holdings, 계좌마다)로 한 줄을 쓴다. 이미 있으면(다른 서버·재시작) 토스를 부르지 않는다.
 *    서버를 켜면 곧 한 번 돌아 같은 거래일 안에서 놓친 스냅샷을 따라잡는다('intraday-fallback'). 거래일이 지나도록 못 찍은 날은
 *    값을 지어내지 않고 빈칸(gap) 줄로 남긴다 — 지난 날의 보유·평단을 토스가 주지 않기 때문이다.
 *    스냅샷 한 줄: 보유를 읽고(as_of = 읽기 바로 전 시각) → 그 거래일 체결 받기가 아직이면 그 자리에서 받고(아래 2 — 'seen' 시각은 이 as_of) →
 *    계좌마다 응답을 확인해(snapshotDoubts — 한 계좌 목록만 비어 옴·목록 일부만 옴(합계가 반올림 차이보다 크게 다름·직전 스냅샷 종목이 매도 없이 사라짐)·
 *    전에 종목이 있던 계좌가 목록에서 빠짐) 쓴다. 의심스러우면 찍지 않고 5분 뒤 다시 묻고, 같은 의심(종류·계좌·내용이 모두 같음)이 오래 이어질 때만
 *    (DOUBT_ACCEPT_MS) 받아들여 그 스냅샷에 의심 내용을 적는다. 세는 기록은 상태(meta)에 두어 서버를 다시 켜도 이어 센다.
 *    받아들인 내용과 똑같은 의심은 다음 거래일에 곧바로 받아들이고, 내용이 다르면 처음부터 센다. 전부 판 계좌(목록이 비고 달러 요약도 없음)는
 *    직전 스냅샷의 그 계좌 종목이 저장한 매도로 모두 설명되면 곧바로 받아들인다. 종목마다 그 거래일 일봉의 정규장 종가(regularClose)도 함께 적는다.
 * 2) 체결: 그 시장의 토스 주문 내역(/api/v1/orders, 종료·진행 중)을 받아 (계좌, 주문번호)로 한 줄씩 저장한다(다시 받아도 늘지 않음).
 *    물은 종목과 다른 종목으로 온 주문은 저장하지 않는다. 부분 체결이 며칠에 걸치면 받을 때마다 늘어난 몫을 그 시각과 함께 fills 에 남긴다.
 *    체결 시각이 없는 몫·처음 본 주문의 시각('seen')은 그 확인의 스냅샷 as_of 로 적는다(이미 그 스냅샷에 든 체결이 다음 구간 '추정'으로 넘어가지 않게).
 *    원화 장부처럼 (계좌, 종목) 짝마다 묻는다 — 그 계좌가 그 종목을 가졌거나(최근 두 스냅샷·토스 동기화가 믿은 보유·지금 읽은 보유) 거래한(최근 30일
 *    체결·실시간 체결 알림) 짝만. 등록 종목·계좌를 모르는 알림 종목은 그 시장 종목을 가졌던 계좌에만 묻는다(늘 비어 있는 계좌는 묻지 않음).
 *    (서버는 종목을 지정해 묻는다 — 종목 없이 물을 수 있는지는 확인하지 않았다). 한 번도 묻지 않은 종목(기록 전에 전부 팔고
 *    등록도 안 한 종목)의 체결은 없다 — 그래서 종목별로 처음·마지막으로 받은 날(coverage)을 적어 3-37 이 '받은 종목'과 '안 물은 종목'을 가르게 한다.
 *    실패는 (계좌, 종목) 짝으로 센다: 실패한 짝(주문 한 건을 저장하다 난 오류 포함)만 5분마다 다시(최대 TRADE_RETRIES 번) 묻고, 풀리지 않으면 경고(warning)에 올린다.
 *    토스 주문 내역은 주문 1건 = 1줄(누적 체결 수량·금액·마지막 체결 시각)이고 부분 체결 낱개·수수료·세금·체결 환율은 주지 않는다.
 *    주문 내역으로 설명되지 않는 수량 변화는 스냅샷 차이로 '추정' 해 읽을 때만 보여 준다(저장하지 않음).
 * 3) 점검: 최근 5·30거래일 중 스냅샷이 없는 날(달력이 휴장이라 한 날은 빼고)과 풀리지 않은 체결 받기 실패(종목 실패·이어지는 전체 실패·
 *    쪽 수 한도로 오래된 주문을 다 받지 못한 종목)를 /health·관리 API·로그(30분마다 보고 새 경고일 때)로 알린다.
 * 상태(meta)를 읽고-고치고-쓰는 일(예약 확인·관리 체결 받기·관리 스냅샷)은 한 줄로 돌려 서로 덮어쓰지 않게 한다.
 * 플래그를 끄면 아무것도 쓰지 않고 토스도 부르지 않는다.
 */

export type { RecordMarket, SnapshotMethod } from "./tradeRecordCalc.js";

/** 정규장 종가 하나: 그 거래일 일봉 종가와 출처 */
export interface RegularClose {
  close: number;
  source: string;
}

/** 일봉을 주는 소스 (QuoteProvider 가 그대로 맞는다) */
export interface DailyCandleSource {
  readonly name: string;
  supports?(code: string): boolean;
  getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries>;
}

/** 종목 하나의 정규장 종가를 기다리는 최대 시간 */
const REGULAR_CLOSE_WAIT_MS = 10_000;

/**
 * 정규장 종가 찾기: 시장마다 소스를 차례로 물어 그 거래일(date) 일봉의 종가를 쓴다. 그 날짜 봉이 없거나 실패하면 다음 소스, 끝까지 없으면 뺀다(null).
 * 운영 소스: 한국은 네이버 일봉(KRX 정규장 — 토스 일봉은 NXT 애프터마켓까지 든 통합 종가라 쓰지 않음), 미국은 토스 웹 일봉(애프터마켓 체결은
 * 봉에 넣지 않음) → Yahoo. 종목은 동시에 4개까지, 종목마다 10초까지만 기다린다
 */
export function regularCloseLookup(sources: Record<RecordMarket, DailyCandleSource[]>): (market: RecordMarket, date: string, codes: string[]) => Promise<Map<string, RegularClose>> {
  return async (market, date, codes) => {
    const list = [...new Set(codes)];
    const found = await mapLimit(list, 4, async (code) => {
      for (const src of sources[market]) {
        if (src.supports && !src.supports(code)) continue;
        const series = await within(src.getCandles(code, "D", 5), REGULAR_CLOSE_WAIT_MS, null);
        const c = series?.candles.find((x) => x.date === date);
        if (c && Number.isFinite(c.close) && c.close > 0) return { close: c.close, source: series!.source || src.name };
      }
      return null;
    });
    const out = new Map<string, RegularClose>();
    list.forEach((code, i) => {
      const r = found[i];
      if (r) out.set(code, r);
    });
    return out;
  };
}

/** 환율 한 번: 값·실제 출처('toss' | 'naver' 등)·그 값을 받은 시각(모르면 null) */
export interface FxQuote {
  rate: number;
  source: string;
  asOf: string | null;
}

/** 이 서비스가 쓰는 토스 Open API 조회 (TossOpenApiProvider 가 그대로 맞는다 — 테스트는 가짜) */
export interface TradeRecordToss {
  accounts(): Promise<Array<{ accountSeq: number }>>;
  holdingsWithOverview(accountSeq: number): Promise<{ items: TossHolding[]; overview: AccountOverview }>;
  orderHistory(accountSeq: number, symbol: string): Promise<TossOrderHistory>;
}

export interface TradeRecordDeps {
  db: Db;
  /** 토스 키가 없으면 null — 스냅샷·체결을 찍지 않고 읽기만 */
  toss: TradeRecordToss | null;
  features: { enabled(key: "tradeRecords"): Promise<boolean> };
  /**
   * 미국 스냅샷 원화 합계에 쓸 환율과 실제 출처·받은 시각 (운영은 fundamentals.usdKrwQuote — 원화 장부와 같은 경로: 토스 표시 환율 → 네이버 → 전에 받아 둔 값).
   * 없거나 실패하면 원화 합계는 null
   */
  displayFx?: (() => Promise<FxQuote | null>) | null;
  /** 달력의 그 날짜 거래일 여부 (예상 못 한 휴장). 없으면 휴장일 목록만 */
  isTradingDate?: ((market: RecordMarket, date: string) => Promise<boolean>) | null;
  /**
   * 그 거래일 정규장 종가 (스냅샷 종목마다 regularClose — 운영은 regularCloseLookup: 한국 네이버 KRX 일봉, 미국 토스 웹·Yahoo 일봉).
   * 없거나 실패하면 regularClose 는 null (스냅샷은 그대로 저장)
   */
  regularCloses?: ((market: RecordMarket, date: string, codes: string[]) => Promise<Map<string, RegularClose>>) | null;
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
  /** 확인 간격 (기본 1분) */
  tickMs?: number;
  /** 서버를 켠 뒤 첫 확인까지 (기본 1분 — 다른 시작 작업이 먼저 돌게) */
  startupDelayMs?: number;
  /** 토스 오류 뒤 다시 해 볼 때까지 (기본 5분) */
  retryMs?: number;
  /** 주문 내역 요청 사이 쉬는 시간 (기본 250ms — 토스 그룹별 초당 한도) */
  pauseMs?: number;
}

export interface SnapshotView {
  id: number;
  date: string;
  market: RecordMarket;
  status: "ok" | "gap";
  method: SnapshotMethod | null;
  asOf: string;
  scheduledAt: string;
  source: string | null;
  reason: string | null;
  priceBasis: string | null;
  fx: SnapshotData["fx"];
  totals: SnapshotTotals | null;
  holdings: SnapshotHolding[];
  accounts: SnapshotData["accounts"];
  /** 받아들인 의심 (없으면 빈 배열) — 있으면 적힌 계좌(account)의 몫이 빠졌을 수 있다. 3-37·'어제와 비교'는 그 계좌를 이 스냅샷으로 비교하지 않는다 */
  doubts: SnapshotDoubt[];
}

/** 받을 때마다 늘어난 체결 몫 (합 = 주문의 누적 체결 수량) */
export interface TradeFill {
  quantity: number;
  amount: number;
  /**
   * 그 몫의 체결 시각: 그때 토스가 준 마지막 체결 시각(filled), 없으면 주문 시각(ordered, 처음 몫만)이나 'seen' —
   * 그 확인의 스냅샷 시각(as_of, 이 몫은 그 스냅샷 전에 체결됐다고 봄), 스냅샷이 없는 확인이면 받은 시각
   */
  at: string;
  /** at 의 그 시장 거래일 YYYY-MM-DD (기간으로 거를 때 — 3-37 의 날짜별 실현손익·현금 흐름) */
  date: string;
  basis: "filled" | "ordered" | "seen";
  /** 이 몫을 처음 본 시각 (이 몫은 이 시각 전에 체결됐다) */
  seenAt: string | null;
}

export interface TradeView {
  id: number;
  account: number;
  orderId: string;
  code: string;
  market: RecordMarket;
  side: "BUY" | "SELL";
  quantity: number;
  amount: number;
  price: number | null;
  currency: "KRW" | "USD";
  fee: number | null;
  tax: number | null;
  executedAt: string;
  executedDate: string;
  /** filled = 마지막 체결 시각, ordered = 체결 시각이 없어 주문 시각, seen = 둘 다 없어 처음 받은 시각 (다시 받아도 바꾸지 않음 — 체결 시각이 오면 filled 로) */
  timeBasis: "filled" | "ordered" | "seen";
  status: "CLOSED" | "OPEN";
  source: "toss-orders";
  /**
   * 며칠에 걸친 부분 체결의 날짜별 몫 (한 번에 체결된 주문은 한 칸). 3-37 의 날짜별 실현손익·현금 흐름은 이것으로 나눈다.
   * listTrades 는 기간과 겹치는 몫(fills[].date)이 하나라도 있는 주문을 돌려준다 — 기간 밖 몫도 함께 오므로 날짜로 걸러 쓴다
   */
  fills: TradeFill[];
}

export interface TradeSyncResult {
  market: RecordMarket;
  codes: number;
  /** 물은 (계좌, 종목) 짝 수 */
  pairs: number;
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** 물은 종목과 다른 종목으로 온 주문 (저장하지 않음 — 그 종목을 물을 때 저장된다) */
  skipped: number;
  errors: string[];
  /** 한 계좌라도 주문 내역을 받지 못했거나 주문 한 건을 저장하지 못한 종목 */
  failedCodes: string[];
  /** 받지 못한 (계좌, 종목) 짝 '계좌:종목' (다시 물을 대상 — 그 짝만) */
  failedPairs: string[];
  /** 쪽 수 한도에 걸려 오래된 종료 주문을 다 받지 못한 종목 (경고) */
  truncatedCodes: string[];
}

/** 종목별로 토스 주문 내역을 (물은 계좌 모두에서) 받은 첫날·마지막 날 (한국 날짜). 여기 없는 종목은 한 번도 묻지 않았다 */
export type TradeCoverage = Record<string, { first: string; last: string }>;

export interface MarketRecordStatus {
  /** 기록 시작일 (처음으로 예약 시각이 지난 거래일) */
  since: string | null;
  last: { date: string; method: SnapshotMethod | null; asOf: string } | null;
  stored: number;
  gaps: number;
  /** 최근 5·30거래일 중 스냅샷이 없는 날 (새것부터) */
  missing5: string[];
  missing30: string[];
  lastError: string | null;
}

export interface TradeRecordStatus {
  toss: boolean;
  since: string | null;
  /** 스냅샷을 저장한 날 수 (두 시장 합쳐 날짜 기준) */
  days: number;
  markets: Record<RecordMarket, MarketRecordStatus>;
  missing5: Array<{ market: RecordMarket; date: string }>;
  missing30: Array<{ market: RecordMarket; date: string }>;
  warning: string | null;
  trades: {
    count: number;
    /** 저장한 체결 가운데 가장 이른·늦은 거래일 — 물어본 종목(coverage)만의 값이라 '이 날부터 모든 체결이 있다'는 뜻이 아니다 */
    earliest: string | null;
    latest: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
    /** 받지 못해 다시 묻는 중이거나 다시 묻기를 다 쓴 종목 (시장별) */
    failing: Partial<Record<RecordMarket, string[]>>;
    /** 그 (계좌, 종목) 짝 '계좌:종목' (시장별 — 계좌는 토스 계좌 순번) */
    failingPairs: Partial<Record<RecordMarket, string[]>>;
    /** 쪽 수 한도(5,000건)에 걸려 오래된 주문을 다 받지 못한 종목 — 이 종목의 오래된 체결은 빠져 있을 수 있다 */
    truncated: string[];
    coverage: TradeCoverage;
    source: "toss-orders";
  };
}

/** 스냅샷 의심 하나를 세는 기록 ('시장|종류|계좌'마다) */
interface DoubtEntry {
  /** 세고 있는 의심 내용 — 내용이 바뀌면 처음부터 다시 센다 */
  text: string;
  /** 처음 본 시각·마지막으로 본 시각 (ms) */
  since: number;
  last: number;
  count: number;
  /** 이미 받아들여 저장한 의심 내용 — 똑같은 내용이면 곧바로 받아들인다 (그 의심이 사라지면 기록째 지운다) */
  accepted: string | null;
}

interface State {
  since: Partial<Record<RecordMarket, string>>;
  /** 체결을 받은 마지막 거래일 */
  tradesFor: Partial<Record<RecordMarket, string>>;
  /** 그 거래일 체결 받기에서 실패한 (계좌, 종목) 짝 '계좌:종목' — 그 짝만 5분마다 다시 (tries 번 해 봄). 풀리면 지운다 */
  tradeRetry: Partial<Record<RecordMarket, { date: string; pairs: string[]; tries: number }>>;
  /** 계좌 목록을 못 받는 등 전체 실패가 이어지는 중 (처음 실패한 시각·횟수). 받으면 지운다 */
  tradeFail: Partial<Record<RecordMarket, { since: string; count: number }>>;
  lastTradeSyncAt: string | null;
  /** 시장별 마지막 체결 받기 오류 (풀리면 지운다) */
  tradeErrors: Partial<Record<RecordMarket, string>>;
  coverage: TradeCoverage;
  /** 쪽 수 한도에 걸린 종목 → 마지막으로 걸린 날 (한도 안에서 끝까지 받으면 지운다) */
  truncated: Record<string, string>;
  /** 스냅샷 의심을 세는 기록 — 서버를 다시 켜도 이어 센다 */
  doubts: Record<string, DoubtEntry>;
}

export const STATE_KEY = "trade_records_state";
/**
 * 토스 실시간 체결 알림으로 본 '계좌:종목'(계좌를 모르면 '종목') → 마지막으로 본 시각 (하루 안에 사고판 종목도 주문 내역을 묻게).
 * 상태와 따로 둬 서로 덮어쓰지 않는다
 */
export const SEEN_KEY = "trade_records_seen";
const MARKETS: RecordMarket[] = ["KR", "US"];
/** 실시간 체결 알림으로 본 종목을 기억하는 날 수 */
const SEEN_DAYS = 30;
/** 건강 점검(빠진 날) 로그를 다시 볼 때까지, 같은 내용을 다시 알릴 때까지 */
const HEALTH_CHECK_MS = 30 * 60_000;
const HEALTH_REPEAT_MS = 12 * 3_600_000;
/** 체결 받기에서 실패한 종목을 같은 거래일 안에 다시 물어보는 횟수 (5분 간격, 처음 받기 포함) */
export const TRADE_RETRIES = 6;
/** 전체 실패(계좌 목록 못 받음 등)가 이만큼 이어지면 경고에 올린다 (5분 간격이라 약 10분) */
export const TRADE_FAIL_WARN = 3;
/** 기간으로 체결을 거를 때 executed_date 앞뒤로 넉넉히 보는 날 수 (며칠에 걸친 부분 체결의 몫 날짜가 마지막 체결일과 다를 수 있어서) */
const FILL_SPAN_DAYS = 62;
/** 체결 시각 기준의 믿을 만한 정도: 마지막 체결 시각 > 주문 시각 > 처음 받은 시각 */
const BASIS_RANK: Record<string, number> = { filled: 2, ordered: 1, seen: 0 };

export class FeatureOffError extends AppError {
  constructor() {
    super(409, "FEATURE_OFF", "매매 기록(tradeRecords)이 꺼져 있습니다");
  }
}

/** 토스 응답이 계좌 요약·직전 스냅샷과 맞지 않아 이번에는 찍지 않음 (5분 뒤 다시). 관리 API 에서는 409 */
export class SnapshotDoubtError extends AppError {
  constructor(market: RecordMarket, doubts: SnapshotDoubt[]) {
    super(409, "SNAPSHOT_DOUBT", `${MARKET_NAME[market]} 스냅샷 보류 — ${doubts.map((d) => d.text).join(" · ")} (일시 오류로 보고 다시 찍음)`);
  }
}

export class TossMissingError extends AppError {
  constructor() {
    super(503, "TOSS_DISABLED", "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았습니다");
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** (계좌, 종목) 짝 → '계좌:종목' */
const pairKey = (account: number, code: string) => `${account}:${code}`;

/** '계좌:종목' → [계좌, 종목] (모양이 틀리면 null) */
function parsePair(key: string): [number, string] | null {
  const m = /^(\d{1,9}):(.+)$/.exec(key);
  if (!m) return null;
  const code = normalizeCode(m[2]!);
  return CODE_RE.test(code) ? [Number(m[1]), code] : null;
}

/** 토스가 준 종목 기호 → 우리 종목 코드 (한국 'A005930' 모양은 A 를 뗀다). 모양이 틀리면 null */
export function orderSymbolCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let code = normalizeCode(raw);
  if (/^A\d[0-9A-Z]{5}$/.test(code)) code = code.slice(1);
  return CODE_RE.test(code) ? code : null;
}

export class TradeRecordService {
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private ticking: Promise<void> | null = null;
  /** 줄이 있다고 확인한 '시장|거래일' (매분 DB 를 묻지 않게) */
  private readonly done = new Set<string>();
  private readonly nextTry: Record<RecordMarket, number> = { KR: 0, US: 0 };
  private readonly nextTradeTry: Record<RecordMarket, number> = { KR: 0, US: 0 };
  private readonly lastError: Record<RecordMarket, { date: string; message: string } | null> = { KR: null, US: null };
  /** 빈칸 표시를 마친 기준 거래일 (거래일이 바뀔 때만 다시 본다) */
  private readonly gapsCheckedFor: Record<RecordMarket, string | null> = { KR: null, US: null };
  /** 건강 점검 로그: 다음 점검 시각, 마지막으로 알린 경고와 그 시각 */
  private nextHealthCheck = 0;
  private lastWarned: { text: string; at: number } | null = null;
  /** 실시간 체결 알림 기록을 차례로 쓰게 (한꺼번에 와도 서로 덮어쓰지 않게) */
  private seenGate: Promise<unknown> = Promise.resolve();
  /** 상태(meta trade_records_state)를 읽고-고치고-쓰는 일을 한 줄로 (예약 확인 · 관리 체결 받기 · 관리 스냅샷) */
  private gate: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TradeRecordDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get retryMs(): number {
    return this.deps.retryMs ?? 5 * 60_000;
  }

  /** 앞의 일이 끝난 뒤에 fn 을 돌린다 (앞의 일이 실패해도) */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn);
    this.gate = run.catch(() => undefined);
    return run;
  }

  get hasToss(): boolean {
    return this.deps.toss !== null;
  }

  enabled(): Promise<boolean> {
    return this.deps.features.enabled("tradeRecords");
  }

  /** 1분마다 확인. 서버를 켠 뒤 startupDelayMs 에 첫 확인(놓친 스냅샷 따라잡기) */
  start(): void {
    if (!this.deps.toss || this.timer || this.first) return;
    const run = () => void this.tick().catch((e: unknown) => this.deps.log?.warn({ err: errText(e) }, "매매 기록 확인 실패"));
    this.first = setTimeout(() => {
      this.first = null;
      run();
      this.timer = setInterval(run, this.deps.tickMs ?? 60_000);
      this.timer.unref?.();
    }, this.deps.startupDelayMs ?? 60_000);
    this.first.unref?.();
  }

  /** 멈춤. 도는 중인 확인은 끝날 때까지 기다린다 (반쯤 쓴 채로 DB 를 닫지 않게) */
  async stop(): Promise<void> {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
    await this.ticking?.catch(() => undefined);
    await this.gate;
  }

  /** 한 번 확인 (겹쳐 부르면 도는 것을 같이 기다린다). 관리 체결 받기·스냅샷이 도는 중이면 끝난 뒤에 */
  tick(): Promise<void> {
    this.ticking ??= this.exclusive(() => this.runTick()).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    if (!this.deps.toss) return;
    if (!(await this.enabled())) return;
    const now = this.now();
    const state = await this.loadState();
    for (const market of MARKETS) {
      try {
        await this.tickMarket(market, now, state);
      } catch (e) {
        this.deps.log?.warn({ market, err: errText(e) }, "매매 기록: 확인 중 오류");
      }
    }
    await this.logHealth(now).catch((e: unknown) => this.deps.log?.warn({ err: errText(e) }, "매매 기록: 건강 점검 실패"));
  }

  /** 30분마다 최근 5·30거래일 빠진 날을 보고, 경고가 새로 생기거나 바뀌면(같은 경고는 12시간마다) 로그로 알린다 */
  private async logHealth(now: Date): Promise<void> {
    const t = now.getTime();
    if (t < this.nextHealthCheck) return;
    this.nextHealthCheck = t + HEALTH_CHECK_MS;
    const { warning, missing5, missing30 } = await this.status();
    if (!warning) {
      this.lastWarned = null;
      return;
    }
    if (this.lastWarned?.text === warning && t - this.lastWarned.at < HEALTH_REPEAT_MS) return;
    this.lastWarned = { text: warning, at: t };
    this.deps.log?.warn({ missing5: missing5.length, missing30: missing30.length }, `매매 기록: ${warning}`);
  }

  /**
   * 토스 실시간 체결 알림(personal:order — { event, accountSeq, order{ symbol … } })을 받으면 종목을 기억해 둔다.
   * 체결 받기는 그 시장의 보유·등록 종목만 묻기 때문에, 하루 안에 사고팔아 보유에 남지 않은 종목도 빠지지 않게 하려는 것이다.
   * 주문 내용은 저장하지 않고(주문 내역에서 받음) 종목 코드와 본 시각만. 플래그가 꺼져 있으면 아무것도 하지 않는다
   */
  noteOrderEvent(data: unknown): Promise<void> {
    const run = this.seenGate.then(async () => {
      const d = (data ?? {}) as { order?: Record<string, unknown>; symbol?: unknown; accountSeq?: unknown };
      const code = orderSymbolCode(d.order?.["symbol"] ?? d.symbol); // 한국 종목 'A005930' 모양은 A 를 뗌
      if (!code) return;
      if (!(await this.enabled())) return;
      // 계좌 순번이 오면 그 (계좌, 종목) 짝만 묻고, 없으면 그 시장 종목을 가졌던 계좌에 묻는다
      const acct = Number(d.accountSeq ?? d.order?.["accountSeq"]);
      const key = Number.isInteger(acct) && acct >= 0 ? pairKey(acct, code) : code;
      const seen = await this.loadSeen();
      seen[key] = seoulIso(this.now());
      await this.saveSeen(seen);
    });
    this.seenGate = run.catch(() => undefined);
    return run;
  }

  private async loadSeen(): Promise<Record<string, string>> {
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", SEEN_KEY).executeTakeFirst();
    const out: Record<string, string> = {};
    if (!row) return out;
    try {
      const v = JSON.parse(row.value) as Record<string, unknown>;
      const cutoff = this.now().getTime() - SEEN_DAYS * 86_400_000;
      for (const [key, at] of Object.entries(v)) if (typeof at === "string" && (CODE_RE.test(key) || parsePair(key)) && Date.parse(at) >= cutoff) out[key] = at;
    } catch {
      // 깨진 값은 버린다 (다음 알림부터 다시 모음)
    }
    return out;
  }

  private async saveSeen(seen: Record<string, string>): Promise<void> {
    const value = JSON.stringify(seen);
    await this.deps.db.insertInto("meta").values({ key: SEEN_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
  }

  private async isOpen(market: RecordMarket, date: string): Promise<boolean> {
    if (!this.deps.isTradingDate) return true;
    return this.deps.isTradingDate(market, date).catch(() => true);
  }

  /** 달력이 거래일이라 한 날만 (달력이 없거나 실패하면 그대로) */
  private async openOnly(market: RecordMarket, dates: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const d of dates) if (await this.isOpen(market, d)) out.push(d);
    return out;
  }

  private async tickMarket(market: RecordMarket, now: Date, state: State): Promise<void> {
    const plan = snapshotPlan(market, now);
    const open = plan.due ? await this.isOpen(market, plan.date) : true;
    if (!state.since[market]) {
      // 기록 시작일 = 처음으로 예약 시각이 지난 거래일. 그 전 날들은 빠진 날이 아니다
      if (!plan.due || !open) return;
      state.since[market] = plan.date;
      await this.saveState(state);
    }
    await this.markGaps(market, plan.date, state.since[market]!);
    if (!plan.due || !open) return;
    const key = `${market}|${plan.date}`;
    /** 이번 확인에서 체결 받기를 했는지 (스냅샷을 찍으며 먼저 받았으면 아래에서 다시 받지 않는다) */
    const ran = { trades: false };
    let touched = false;
    if (!this.done.has(key)) {
      if (await this.rowExists(market, plan.date)) this.done.add(key);
      else if (now.getTime() >= this.nextTry[market]) {
        touched = true;
        try {
          await this.capture(market, plan, false, state, ran);
          this.done.add(key);
          this.lastError[market] = null;
        } catch (e) {
          this.nextTry[market] = now.getTime() + this.retryMs;
          this.lastError[market] = { date: plan.date, message: errText(e) };
          this.deps.log?.warn({ market, date: plan.date, err: errText(e) }, `매매 기록: ${MARKET_NAME[market]} ${md(plan.date)} 스냅샷 실패, 5분 뒤 다시`);
        }
      }
    }
    // 체결: 거래일마다 한 번 전체를 받고, 실패한 (계좌, 종목) 짝만 5분마다 다시(TRADE_RETRIES 번까지). 전날 끝내 못 받은 짝은 다음 전체 받기에 넣는다
    if (!ran.trades && (await this.tradeStep(market, plan, now, state))) touched = true;
    // 의심을 센 기록·체결 받기 결과를 남긴다 (서버를 다시 켜도 이어 세게)
    if (touched || ran.trades) await this.saveState(state).catch((e: unknown) => this.deps.log?.warn({ market, err: errText(e) }, "매매 기록: 상태 저장 실패"));
  }

  /**
   * 체결 받기 한 번 — 그 거래일 처음이면 전체(자동 짝 + heldPairs + 전날 못 받은 짝), 아니면 실패한 짝만(TRADE_RETRIES 번까지, 5분 간격).
   * 할 일이 없거나 5분이 안 됐으면 하지 않고 false. 결과는 state 에 적는다(저장은 부른 쪽). 전체 실패(계좌 목록을 못 받음 등)는 던지지 않고 적는다
   * @param seenIso 체결 시각이 없는 몫·처음 본 주문에 적을 시각 (스냅샷을 찍으며 받을 때 그 스냅샷 as_of)
   */
  private async tradeStep(market: RecordMarket, plan: SnapshotPlan, now: Date, state: State, opts: { seenIso?: string; heldPairs?: string[] } = {}): Promise<boolean> {
    const retry = state.tradeRetry[market];
    const full = state.tradesFor[market] !== plan.date;
    const again = !full && !!retry && retry.date === plan.date && retry.tries < TRADE_RETRIES;
    if (!(full || again) || now.getTime() < this.nextTradeTry[market]) return false;
    try {
      const leftover = retry?.pairs ?? [];
      const r = await this.syncTradesInto(market, state, full ? { extraPairs: [...leftover, ...(opts.heldPairs ?? [])] } : { pairs: leftover }, opts.seenIso);
      state.tradesFor[market] = plan.date;
      delete state.tradeFail[market];
      if (r.failedPairs.length) {
        state.tradeRetry[market] = { date: plan.date, pairs: r.failedPairs, tries: full ? 1 : retry!.tries + 1 };
        this.nextTradeTry[market] = now.getTime() + this.retryMs;
      } else delete state.tradeRetry[market];
    } catch (e) {
      // 계좌 목록을 못 받음 등 전체 실패: 그 거래일 받기를 끝내지 않고 5분 뒤 처음부터. 이어지면(TRADE_FAIL_WARN 번) 경고에 올린다
      this.nextTradeTry[market] = now.getTime() + this.retryMs;
      state.tradeErrors[market] = `${MARKET_NAME[market]}: ${errText(e)}`;
      const f = state.tradeFail[market];
      state.tradeFail[market] = { since: f?.since ?? seoulIso(now), count: (f?.count ?? 0) + 1 };
      this.deps.log?.warn({ market, err: errText(e), count: state.tradeFail[market]!.count }, "매매 기록: 체결 받기 실패, 5분 뒤 다시");
    }
    return true;
  }

  /** 기록 시작일부터 지금 거래일 전까지, 줄이 없는 거래일에 빈칸 표시 (값은 쓰지 않음) */
  private async markGaps(market: RecordMarket, current: string, since: string): Promise<void> {
    if (this.gapsCheckedFor[market] === current || since >= current) {
      this.gapsCheckedFor[market] = current;
      return;
    }
    const from = since > addDays(current, -400) ? since : addDays(current, -400);
    const rows = await this.deps.db.selectFrom("account_snapshots").select("snapshot_date").where("market", "=", market).where("snapshot_date", ">=", from).where("snapshot_date", "<", current).execute();
    const have = new Set(rows.map((r) => r.snapshot_date));
    const candidates = [...(isTradingDay(market, from) ? [from] : []), ...tradingDaysBetween(market, from, current)];
    const iso = seoulIso(this.now());
    for (const d of candidates) {
      if (have.has(d) || !(await this.isOpen(market, d))) continue;
      const err = this.lastError[market]?.date === d ? this.lastError[market]!.message : null;
      const reason = err ? `스냅샷 없음 — ${err}` : "스냅샷 없음 (서버가 꺼져 있었거나 기능이 꺼져 있었거나 그 거래일 안에 찍지 못함)";
      const r = await this.deps.db
        .insertInto("account_snapshots")
        .values({
          snapshot_date: d,
          market,
          status: "gap",
          method: null,
          as_of: iso,
          scheduled_at: seoulIso(snapshotDueAt(market, d)),
          source: null,
          reason,
          holdings_count: 0,
          total_value_krw: null,
          data: "{}",
          created_at: iso,
          updated_at: iso,
        })
        .onConflict((oc) => oc.columns(["snapshot_date", "market"]).doNothing())
        .executeTakeFirst();
      if (Number(r.numInsertedOrUpdatedRows ?? 0) > 0) this.deps.log?.warn({ market, date: d, reason }, `매매 기록: ${MARKET_NAME[market]} ${md(d)} 스냅샷 없음 — 빈칸으로 남김`);
    }
    this.gapsCheckedFor[market] = current;
  }

  private async rowExists(market: RecordMarket, date: string): Promise<boolean> {
    return !!(await this.deps.db.selectFrom("account_snapshots").select("id").where("market", "=", market).where("snapshot_date", "=", date).executeTakeFirst());
  }

  /**
   * 그 시장 직전 ok 스냅샷과 그 뒤 저장한 체결 (snapshotDoubts 가 전에 종목이 있던 계좌·목록에서 사라진 종목이 매도로 설명되는지 보려고).
   *  - held: 직전 스냅샷에 그 시장 종목이 있던 계좌. 직전 스냅샷에 없는 계좌(첫 스냅샷·새 계좌)는 토스 동기화가 마지막으로 믿은 계좌별 보유
   *    (meta toss_holdings_accounts)에 그 시장 종목이 있었는지로 본다
   *  - holdings: 직전 스냅샷의 보유 (계좌, 종목, 수량), traded: 그 스냅샷 as_of 뒤 ~ upTo 까지 저장한 체결의 순수량
   */
  private async previousInfo(market: RecordMarket, upTo: number): Promise<PrevSnapshotInfo> {
    const db = this.deps.db;
    const row = await db.selectFrom("account_snapshots").select(["data", "as_of", "snapshot_date"]).where("market", "=", market).where("status", "=", "ok").orderBy("snapshot_date", "desc").limit(1).executeTakeFirst();
    const data = row ? parseData(row.data) : null;
    const accounts = (data?.accounts ?? []).map((a) => Number(a.account)).filter((n) => Number.isFinite(n));
    const holdings = (data?.holdings ?? []).filter((h) => h.quantity > 0).map((h) => ({ account: Number(h.account), code: h.code, quantity: Number(h.quantity) }));
    // 그 스냅샷에 그 계좌 종목이 있었던 계좌만 (의심을 안고 '빈 계좌'로 받아들인 계좌는 다음 날 같은 빈 응답을 다시 의심하지 않게 넣지 않는다)
    const held = new Set<number>(holdings.map((h) => h.account));
    const known = new Set(accounts);
    const sync = await db.selectFrom("meta").select("value").where("key", "=", ACCOUNTS_KEY).executeTakeFirst();
    try {
      const v = sync ? (JSON.parse(sync.value) as { held?: Record<string, unknown> } | null) : null;
      for (const [acct, codes] of Object.entries(v?.held ?? {})) {
        const n = Number(acct);
        if (!Number.isFinite(n) || known.has(n) || !Array.isArray(codes)) continue;
        if (codes.some((c) => typeof c === "string" && marketOf(c) === market)) held.add(n);
      }
    } catch {
      // 깨진 값은 없는 것으로 본다
    }
    let traded: Record<string, number> = {};
    const since = row ? Date.parse(row.as_of) : NaN;
    if (row && Number.isFinite(since) && holdings.length) {
      const codes = [...new Set(holdings.map((h) => h.code))];
      const trades = await this.tradesTouching(addDays(row.snapshot_date, -1), seoulDate(new Date(upTo)), { codes });
      traded = netTradedBetween(
        trades.map((t) => ({ ...t, fills: t.fills.map((f) => ({ quantity: f.quantity, at: f.at })) })),
        since,
        upTo,
      );
    }
    return { held: [...held], holdings, traded };
  }

  /**
   * 이번 의심을 세고(state.doubts), 아직 받아들일 수 없는 것만 돌려준다.
   *  - 받아들인 내용과 똑같은 의심 → 곧바로 받아들임 (정말 그 상태가 이어지는 것 — 날마다 30분·24시간씩 늦지 않게)
   *  - 같은 종류·계좌·내용이 DOUBT_ACCEPT_MS 넘게·두 번 이상 이어짐 → 받아들임. 30분짜리는 5분 간격 다시 묻기로 이어 본 것만 세고(retryMs 두 배 안),
   *    24시간짜리는 그 거래일 안에 찰 수 없어 다음 거래일로 이어 센다(내용이 같을 때만, DOUBT_CARRY_MAX_MS 안)
   *  - 내용이 다르면 처음부터 (한 번 받아들인 뒤 다른 날 잠깐 목록 일부만 온 것을 곧바로 받아들이지 않게)
   * 이번에 없는 그 시장 의심은 기록째 지운다 (풀렸으면 받아들인 내용도 잊는다)
   */
  private pendingDoubts(market: RecordMarket, doubts: SnapshotDoubt[], now: Date, state: State): SnapshotDoubt[] {
    const t = now.getTime();
    const live = new Set<string>();
    const pending: SnapshotDoubt[] = [];
    for (const d of doubts) {
      const key = doubtKey(market, d.kind, d.account);
      live.add(key);
      const prev = state.doubts[key];
      const gap = prev ? t - prev.last : Infinity;
      if (prev && prev.accepted === d.text && gap <= DOUBT_CARRY_MAX_MS) {
        state.doubts[key] = { ...prev, last: t };
        continue;
      }
      const carry = !!prev && prev.text === d.text && gap >= 0 && (gap <= 2 * this.retryMs || (doubtCarriesOver(d.kind) && gap <= DOUBT_CARRY_MAX_MS));
      const keep = gap <= DOUBT_CARRY_MAX_MS ? prev?.accepted ?? null : null; // 받아들인 내용도 오래 안 보였으면 잊는다
      const next: DoubtEntry = carry ? { ...prev!, last: t, count: prev!.count + 1 } : { text: d.text, since: t, last: t, count: 1, accepted: keep };
      state.doubts[key] = next;
      if (!(next.count >= 2 && t - next.since >= DOUBT_ACCEPT_MS[d.kind])) pending.push(d);
    }
    for (const key of Object.keys(state.doubts)) if (key.startsWith(`${market}|`) && !live.has(key)) delete state.doubts[key];
    return pending;
  }

  /**
   * 토스 보유 조회로 스냅샷 한 줄.
   *  1) 보유를 읽는다 — as_of = 읽기 바로 전 시각
   *  2) 그 거래일 체결 받기가 아직이면(또는 실패한 짝을 다시 물을 때가 됐으면) 여기서 먼저 받는다 (tradeStep — 지금 읽은 보유의 짝까지).
   *     체결 시각이 없는 몫·처음 본 주문은 이 as_of 로 적어, 이미 이 스냅샷에 든 체결이 다음 구간 '추정'으로 넘어가지 않게 한다.
   *     사라진 종목·전부 판 계좌를 저장한 매도로 맞춰 보려면 오늘 매도까지 저장돼 있어야 해서 확인보다 먼저 받는다
   *  3) 계좌마다 응답을 확인해(snapshotDoubts) 의심스러우면 찍지 않고 던진다(SnapshotDoubtError — 5분 뒤 다시).
   * force(관리 API)면 있는 줄을 덮어쓰고, 의심이 있어도 그대로 쓴다 — 어느 쪽이든 받아들인 의심은 reason·data.doubts 에 적고,
   * 저장한 뒤 그 내용을 '받아들임'으로 적어 둔다(state.doubts — 똑같은 내용만 다음에 곧바로). 저장은 부른 쪽이 state 를 쓴다
   * @param ran 체결 받기를 했으면 trades = true (부른 쪽이 같은 확인에서 다시 받지 않게)
   */
  private async capture(market: RecordMarket, plan: SnapshotPlan, force: boolean, state: State, ran: { trades: boolean }): Promise<void> {
    const toss = this.deps.toss!;
    const at = this.now();
    const asOf = seoulIso(at);
    const accounts = await toss.accounts();
    if (accounts.length === 0) throw new Error("토스 계좌 목록이 비었습니다 (일시 오류일 수 있어 다시 찍음)");
    const per: AccountHoldings[] = [];
    for (const a of accounts) {
      const { items, overview } = await toss.holdingsWithOverview(a.accountSeq);
      per.push({ account: a.accountSeq, items, overview });
    }
    const readAt = this.now().getTime();
    const mineNow = per.flatMap((a) => a.items.filter((h) => h.quantity > 0 && marketOf(h.code) === market).map((h) => [a.account, h.code] as const));
    if (await this.tradeStep(market, plan, at, state, { seenIso: asOf, heldPairs: mineNow.map(([a, c]) => pairKey(a, c)) })) ran.trades = true;
    const doubts = snapshotDoubts(market, per, await this.previousInfo(market, readAt));
    const pending = this.pendingDoubts(market, doubts, at, state);
    if (pending.length && !force) throw new SnapshotDoubtError(market, pending);
    if (doubts.length) this.deps.log?.warn({ market, date: plan.date, doubts: doubts.map((d) => d.text), force }, `매매 기록: ${MARKET_NAME[market]} ${md(plan.date)} 의심을 안고 저장`);
    const fx = market === "US" && this.deps.displayFx ? await this.deps.displayFx().catch(() => null) : null;
    const book = market === "US" ? await KrwCostBook.read(this.deps.db) : null;
    const codes = [...new Set(mineNow.map(([, c]) => c))];
    const closes = this.deps.regularCloses && codes.length ? await this.deps.regularCloses(market, plan.date, codes).catch(() => new Map<string, RegularClose>()) : new Map<string, RegularClose>();
    const data = buildSnapshotData(market, per, {
      fx: fx && fx.rate > 0 ? fx.rate : null,
      fxSource: fx?.source ?? null,
      fxAsOf: fx?.asOf ?? null,
      scheduledAt: seoulIso(plan.dueAt),
      krwCost: (account, code, quantity) => {
        const e = book?.items[`${account}:${code}`];
        if (!book || !e || Math.abs(e.quantity - quantity) > 1e-9) return null;
        return { krw: e.krwExact + e.krwEst * book.factor, source: e.krwEst > 0.5 || e.approx ? "book-estimated" : "book-exact" };
      },
      regularClose: (code) => closes.get(code) ?? null,
    });
    if (doubts.length) data.doubts = doubts.map((d) => ({ kind: d.kind, account: d.account, text: d.text }));
    const iso = seoulIso(this.now());
    const values = {
      snapshot_date: plan.date,
      market,
      status: "ok",
      // 보유를 읽은 시각으로 가른다 (체결을 먼저 받느라 확인 시작보다 늦었을 수 있다)
      method: at.getTime() - plan.dueAt.getTime() <= CLOSE_TOLERANCE_MS ? "close" : "intraday-fallback",
      as_of: asOf,
      scheduled_at: seoulIso(plan.dueAt),
      source: "toss-openapi",
      reason: doubts.length ? `의심을 안고 저장(계좌 몫이 빠졌을 수 있음) — ${doubts.map((d) => d.text).join(" · ")}` : null,
      holdings_count: data.holdings.length,
      total_value_krw: data.totals.valueKrw,
      data: JSON.stringify(data),
      created_at: iso,
      updated_at: iso,
    };
    const q = this.deps.db.insertInto("account_snapshots").values(values);
    if (force) {
      const { created_at: _c, ...update } = values;
      await q.onConflict((oc) => oc.columns(["snapshot_date", "market"]).doUpdateSet(update)).execute();
    } else {
      await q.onConflict((oc) => oc.columns(["snapshot_date", "market"]).doNothing()).execute();
    }
    // 저장한 의심은 '받아들임'으로 — 똑같은 내용만 다음에 곧바로 받아들이고, 내용이 다르면 처음부터 센다
    for (const d of doubts) {
      const e = state.doubts[doubtKey(market, d.kind, d.account)];
      if (e) e.accepted = d.text;
    }
    this.deps.log?.info({ market, date: plan.date, method: values.method, holdings: data.holdings.length, regularCloses: closes.size }, "매매 기록: 스냅샷 저장");
  }

  /** 관리용: 지금 거래일 스냅샷을 찍는다 (예약 시각 전이면 409). 이미 있으면 force 일 때만 덮어쓴다 */
  async snapshotNow(market: RecordMarket, opts: { force?: boolean } = {}): Promise<SnapshotView> {
    if (!(await this.enabled())) throw new FeatureOffError();
    if (!this.deps.toss) throw new TossMissingError();
    return this.exclusive(async () => {
      const now = this.now();
      const plan = snapshotPlan(market, now);
      if (!plan.due) throw new AppError(409, "NOT_DUE", `${MARKET_NAME[market]} ${md(plan.date)} 장이 아직 끝나지 않았습니다 (예약 ${seoulIso(plan.dueAt)})`);
      const exists = await this.rowExists(market, plan.date);
      if (!exists || opts.force) {
        const state = await this.loadState();
        try {
          await this.capture(market, plan, !!opts.force, state, { trades: false });
        } finally {
          await this.saveState(state);
        }
      }
      this.done.add(`${market}|${plan.date}`);
      const [view] = await this.listSnapshots({ from: plan.date, to: plan.date, market });
      return view!;
    });
  }

  /**
   * 체결을 물을 (계좌, 종목) 짝 — 원화 장부처럼 그 계좌가 그 종목을 가졌거나 거래한 짝만:
   * 그 시장의 최근 두 스냅샷 보유 · 토스 동기화가 마지막으로 믿은 계좌별 보유(toss_holdings_accounts) · 최근 30일 체결 · 최근 30일 실시간 체결 알림(계좌가 온 것)
   * · extra(스냅샷을 찍으며 지금 읽은 보유, 전날 못 받은 짝).
   * 계좌를 모르는 종목(등록 종목·계좌 없이 온 알림)은 그 시장 종목을 가졌거나 거래한 계좌에만 묻는다 — 늘 비어 있는 계좌(주문 내역 조회가 늘 오류일 수 있음)는
   * 묻지 않아 날마다 모든 종목이 실패로 남지 않는다 (그런 계좌가 하나도 없으면 목록의 모든 계좌). 목록에 없는 계좌의 짝은 뺀다
   */
  private async pairsFor(market: RecordMarket, listed: ReadonlySet<number>, extra: ReadonlyArray<[number, string]> = []): Promise<Array<[number, string]>> {
    const db = this.deps.db;
    const holders = new Map<string, Set<number>>();
    const orphans = new Set<string>();
    const traders = new Set<number>();
    const add = (account: number, raw: string) => {
      const code = normalizeCode(raw);
      if (!Number.isInteger(account) || !CODE_RE.test(code) || marketOf(code) !== market) return;
      holders.set(code, (holders.get(code) ?? new Set<number>()).add(account));
      traders.add(account);
    };
    const orphan = (raw: string) => {
      const code = normalizeCode(raw);
      if (CODE_RE.test(code) && marketOf(code) === market) orphans.add(code);
    };
    for (const [a, c] of extra) add(a, c);
    const snaps = await db.selectFrom("account_snapshots").select("data").where("market", "=", market).where("status", "=", "ok").orderBy("snapshot_date", "desc").limit(2).execute();
    for (const s of snaps) for (const h of parseData(s.data)?.holdings ?? []) add(Number(h.account), h.code);
    const sync = await db.selectFrom("meta").select("value").where("key", "=", ACCOUNTS_KEY).executeTakeFirst();
    try {
      const v = sync ? (JSON.parse(sync.value) as { held?: Record<string, unknown> } | null) : null;
      for (const [acct, codes] of Object.entries(v?.held ?? {})) if (Array.isArray(codes)) for (const c of codes) if (typeof c === "string") add(Number(acct), c);
    } catch {
      // 깨진 값은 없는 것으로 본다
    }
    const recent = addDays(seoulDate(this.now()), -SEEN_DAYS);
    const traded = await db.selectFrom("trade_executions").select(["account", "code"]).where("market", "=", market).where("executed_date", ">=", recent).groupBy(["account", "code"]).execute();
    for (const r of traded) add(Number(r.account), r.code);
    await this.seenGate;
    for (const key of Object.keys(await this.loadSeen())) {
      const p = parsePair(key);
      if (p) add(p[0], p[1]);
      else orphan(key);
    }
    for (const r of await db.selectFrom("registered_stocks").select("code").execute()) orphan(r.code);
    const probe = [...traders].filter((a) => listed.has(a));
    const everyone = probe.length ? probe : [...listed];
    const out = new Map<string, [number, string]>();
    for (const [code, accts] of holders) for (const a of accts) if (listed.has(a)) out.set(pairKey(a, code), [a, code]);
    for (const code of orphans) if (!holders.has(code)) for (const a of everyone) out.set(pairKey(a, code), [a, code]);
    return [...out.values()];
  }

  /**
   * 'seen' 시각: 지금 거래일 스냅샷을 이미 찍었으면 그 as_of (그 스냅샷 전에 체결됐다고 봄 — 실패해 다시 묻는 짝·관리 체결 받기),
   * 아직이면 지금 (그 거래일 스냅샷은 그 뒤에 찍힌다)
   */
  private async seenIsoFor(market: RecordMarket, at: Date): Promise<string> {
    const row = await this.deps.db
      .selectFrom("account_snapshots")
      .select("as_of")
      .where("market", "=", market)
      .where("snapshot_date", "=", sessionDate(market, at))
      .where("status", "=", "ok")
      .executeTakeFirst();
    return row && Date.parse(row.as_of) < at.getTime() ? row.as_of : seoulIso(at);
  }

  /**
   * 그 시장 종목의 토스 주문 내역을 받아 체결된 주문을 (계좌, 주문번호)로 저장한다. 계좌 목록을 못 받으면 던지고,
   * (계좌, 종목) 짝 하나가 실패하면(주문 내역을 못 받음·주문 한 건을 저장하지 못함) 그 짝만 실패로 적고 까닭을 남긴다(failedPairs — 예약 확인이 그 짝만 다시 묻는다).
   * codes 를 주면(관리 API) 그 시장 종목 가운데 그것만 목록의 모든 계좌에 묻는다 — 기록 전에 전부 팔아 자동 목록에 없는 종목을 채울 때
   */
  async syncTrades(market: RecordMarket, codes?: string[]): Promise<TradeSyncResult> {
    // 예약 확인과 한 줄로 — 도는 중에 예약 확인이 끼어들어 서로의 상태(coverage·다시 묻기·오류)를 덮어쓰지 않게
    return this.exclusive(async () => {
      const state = await this.loadState();
      const r = await this.syncTradesInto(market, state, codes?.length ? { only: codes } : {});
      await this.saveState(state);
      return r;
    });
  }

  /**
   * syncTrades 본체: 결과 시각·오류·종목별 받은 날(coverage)을 state 에 적는다(저장은 부른 쪽 — 확인 한 번에 상태를 한 번에 쓰려고).
   * only: 이 종목만 목록의 모든 계좌에, pairs: 이 짝만, extraPairs: 자동 짝(pairsFor)에 더할 짝 (모두 그 시장 종목·목록의 계좌만 남긴다)
   * @param seenIso 체결 시각이 없는 몫·처음 본 주문에 적을 시각 (없으면 seenIsoFor)
   */
  private async syncTradesInto(market: RecordMarket, state: State, pick: { only?: string[]; pairs?: string[]; extraPairs?: string[] } = {}, seenIso?: string): Promise<TradeSyncResult> {
    const toss = this.deps.toss;
    if (!toss) throw new TossMissingError();
    const accounts = (await toss.accounts()).map((a) => a.accountSeq);
    if (accounts.length === 0) throw new Error("토스 계좌 목록이 비었습니다");
    const listed = new Set(accounts);
    const mine = (code: string) => CODE_RE.test(code) && marketOf(code) === market;
    const chosen = new Map<string, [number, string]>();
    const take = (p: [number, string] | null) => {
      if (p && listed.has(p[0]) && mine(p[1])) chosen.set(pairKey(p[0], p[1]), p);
    };
    if (pick.only) {
      const codes = [...new Set(pick.only.map(normalizeCode))].filter(mine);
      for (const a of accounts) for (const c of codes) take([a, c]);
    } else if (pick.pairs) {
      for (const k of pick.pairs) take(parsePair(k));
    } else {
      const extra = (pick.extraPairs ?? []).map(parsePair).filter((p): p is [number, string] => p !== null);
      for (const p of await this.pairsFor(market, listed, extra)) take(p);
    }
    // 계좌 순서대로, 계좌 안에서는 종목 순서대로
    const pairs = [...chosen.values()].sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
    const codes = [...new Set(pairs.map((p) => p[1]))].sort();
    const result: TradeSyncResult = { market, codes: codes.length, pairs: pairs.length, fetched: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, errors: [], failedCodes: [], failedPairs: [], truncatedCodes: [] };
    const start = this.now();
    const iso = seoulIso(start);
    const seen = seenIso ?? (await this.seenIsoFor(market, start));
    const today = seoulDate(start);
    const failed = new Set<string>();
    const failedPairs = new Set<string>();
    const truncated = new Set<string>();
    const pause = this.deps.pauseMs ?? 250;
    const fail = (account: number, code: string, msg: string) => {
      result.errors.push(`${account}:${code} ${msg}`);
      failed.add(code);
      failedPairs.add(pairKey(account, code));
    };
    let first = true;
    for (const [account, code] of pairs) {
      if (!first && pause > 0) await sleep(pause);
      first = false;
      let history: TossOrderHistory;
      try {
        history = await toss.orderHistory(account, code);
      } catch (e) {
        fail(account, code, errText(e));
        continue;
      }
      if (history.truncated) truncated.add(code);
      // 물은 종목과 다른 종목으로 온 주문은 저장하지 않는다 (토스가 종목 거르기를 무시·느슨하게 해도 다른 종목 코드로 적히지 않게).
      // 페이지 경계·진행 중 목록에서 같은 주문이 두 번 오면 체결 수량이 큰 쪽(같으면 종료된 쪽)
      const byId = new Map<string, TossOrderRecord>();
      const others = new Set<string>();
      for (const o of history.orders) {
        const sym = orderSymbolCode(o.symbol);
        if (sym !== null && sym !== code) {
          result.skipped++;
          others.add(sym);
          continue;
        }
        const p = byId.get(o.orderId);
        if (!p || o.quantity > p.quantity || (o.quantity === p.quantity && o.status === "CLOSED")) byId.set(o.orderId, o);
      }
      if (others.size) this.deps.log?.warn({ market, account, code, others: [...others].slice(0, 5) }, "매매 기록: 물은 종목과 다른 종목의 주문이 와서 저장하지 않음");
      if (byId.size === 0) continue;
      result.fetched += byId.size;
      let existing: Map<string, ExecRow>;
      try {
        existing = new Map((await this.existingRows(account, [...byId.keys()])).map((r) => [r.order_id, r]));
      } catch (e) {
        fail(account, code, errText(e));
        continue;
      }
      for (const o of byId.values()) {
        // 주문 한 건의 오류(해석할 수 없는 시각 등)는 그 짝 실패로 — 다른 주문·짝은 계속 받는다
        try {
          const r = await this.saveOrder(account, code, o, existing.get(o.orderId), iso, seen);
          result[r]++;
        } catch (e) {
          fail(account, code, `주문 ${o.orderId} 저장 실패: ${errText(e)}`);
        }
      }
    }
    // 물은 계좌 모두에서 받은 종목만 '받음'으로 적는다
    for (const code of codes) {
      if (failed.has(code)) continue;
      state.coverage[code] = { first: state.coverage[code]?.first ?? today, last: today };
      // 쪽 수 한도: 이번에 걸렸으면 적고, 끝까지 받았으면 지운다
      if (truncated.has(code)) state.truncated[code] = today;
      else delete state.truncated[code];
    }
    for (const code of truncated) if (failed.has(code)) state.truncated[code] = today;
    result.failedCodes = [...failed].sort();
    result.failedPairs = [...failedPairs].sort();
    result.truncatedCodes = [...truncated].sort();
    if (truncated.size) this.deps.log?.warn({ market, codes: result.truncatedCodes }, "매매 기록: 주문 내역이 쪽 수 한도를 넘어 오래된 주문을 다 받지 못함");
    // 다시 묻는 중인 짝 가운데 이번에 받은 것은 뺀다 (관리 API 로 따로 받았을 때도 경고가 풀리게)
    const retry = state.tradeRetry[market];
    if (retry) {
      const asked = new Set(pairs.map((p) => pairKey(p[0], p[1])));
      const left = retry.pairs.filter((k) => !asked.has(k) || failedPairs.has(k));
      if (left.length) state.tradeRetry[market] = { ...retry, pairs: left };
      else delete state.tradeRetry[market];
    }
    state.lastTradeSyncAt = iso;
    if (result.errors.length) state.tradeErrors[market] = `${MARKET_NAME[market]}: ${result.errors.slice(0, 5).join(" · ")}`;
    else delete state.tradeErrors[market];
    if (result.inserted || result.updated) this.deps.log?.info({ ...result, errors: result.errors.length }, "매매 기록: 체결 저장");
    if (result.errors.length) this.deps.log?.warn({ market, errors: result.errors.slice(0, 5) }, "매매 기록: 일부 (계좌, 종목) 주문 내역을 받지 못함");
    return result;
  }

  private existingRows(account: number, orderIds: string[]): Promise<ExecRow[]> {
    return this.deps.db.selectFrom("trade_executions").selectAll().where("account", "=", account).where("order_id", "in", orderIds).execute();
  }

  /**
   * 주문 한 건 저장: 없으면 넣고, 누적 수량·금액·시각·상태가 바뀌었으면 고친다. 누적 수량이 늘었으면 늘어난 몫을 그때 토스가 준 마지막 체결 시각
   * (없으면 seen — 그 확인의 스냅샷 as_of)과 함께 fills 에 덧붙인다 — 며칠에 걸친 부분 체결의 앞선 몫이 날짜·금액을 잃지 않게.
   * iso 는 실제로 받은 시각(fills 의 seenAt·created_at), seen 은 체결 시각이 없을 때 적는 시각
   */
  private async saveOrder(account: number, code: string, o: TossOrderRecord, e: ExecRow | undefined, iso: string, seen: string): Promise<"inserted" | "updated" | "unchanged"> {
    const db = this.deps.db;
    let row = tradeRow(account, code, o, iso, seen);
    if (!e) {
      const fills: StoredFill[] = [{ q: row.quantity, a: row.amount, at: row.executed_at, basis: row.time_basis, seenAt: iso }];
      await db.insertInto("trade_executions").values({ ...row, fills: JSON.stringify(fills) }).onConflict((oc) => oc.columns(["account", "order_id"]).doNothing()).execute();
      return "inserted";
    }
    // 체결 시각이 없는 주문('seen' = 받은 시각)이나 더 못한 기준으로 온 주문은 처음 적은 시각을 그대로 둔다
    // (그러지 않으면 받을 때마다 체결일이 그날로 밀려 기간 필터·추정 계산이 틀어진다)
    if (row.time_basis === "seen" || basisRank(row.time_basis) < basisRank(e.time_basis)) {
      row = { ...row, executed_at: e.executed_at, executed_date: e.executed_date, time_basis: asBasis(e.time_basis) };
    }
    const fills = storedFills(e);
    const dq = row.quantity - Number(e.quantity);
    if (Math.abs(dq) > 1e-9) {
      fills.push({ q: round6(dq), a: round6(row.amount - Number(e.amount)), at: o.filledAt ?? seen, basis: o.filledAt ? "filled" : "seen", seenAt: iso });
    } else if (row.executed_at !== e.executed_at) {
      // 같은 누적 수량에 더 나은 시각(체결 시각)이 왔다 — 마지막 체결 시각은 마지막 몫의 시각이다
      const last = fills[fills.length - 1];
      if (last && basisRank(last.basis) < basisRank(row.time_basis)) fills[fills.length - 1] = { ...last, at: row.executed_at, basis: row.time_basis };
    }
    const fillsText = JSON.stringify(fills);
    const changed =
      !same(Number(e.quantity), row.quantity) || !same(Number(e.amount), row.amount) || e.executed_at !== row.executed_at || e.order_status !== row.order_status || e.time_basis !== row.time_basis || (e.fills !== null && e.fills !== fillsText);
    if (!changed) return "unchanged";
    const { created_at: _c, ...update } = row;
    await db.updateTable("trade_executions").set({ ...update, fills: fillsText }).where("id", "=", e.id).execute();
    return "updated";
  }

  async listSnapshots(q: { from: string; to: string; market?: RecordMarket }): Promise<SnapshotView[]> {
    let query = this.deps.db.selectFrom("account_snapshots").selectAll().where("snapshot_date", ">=", q.from).where("snapshot_date", "<=", q.to);
    if (q.market) query = query.where("market", "=", q.market);
    const rows = await query.orderBy("snapshot_date").orderBy("market").execute();
    return rows.map(snapshotView);
  }

  /**
   * '어제와 비교'용: 그 날짜 전 가장 가까운 ok 스냅샷 (빈칸은 건너뜀). skipDoubted 면 의심을 안고 저장한 스냅샷(계좌 몫이 빠졌을 수 있음)도 건너뛴다.
   * 그 사이 체결을 붙일 때는 executed_date 가 아니라 이 스냅샷의 asOf 뒤에 체결된(executed_at) 것을 쓴다 — 한국은 16:05 뒤 NXT 체결이 있어서
   */
  async previousSnapshot(market: RecordMarket, before: string, opts: { skipDoubted?: boolean } = {}): Promise<SnapshotView | null> {
    const rows = await this.deps.db
      .selectFrom("account_snapshots")
      .selectAll()
      .where("market", "=", market)
      .where("status", "=", "ok")
      .where("snapshot_date", "<", before)
      .orderBy("snapshot_date", "desc")
      .limit(opts.skipDoubted ? 30 : 1)
      .execute();
    for (const r of rows) {
      const view = snapshotView(r);
      if (!opts.skipDoubted || view.doubts.length === 0) return view;
    }
    return null;
  }

  /**
   * 기간의 체결과, 그 기간 스냅샷 사이 주문 내역으로 설명되지 않는 수량 변화(추정).
   *  - items: 기간과 겹치는 몫(fills[].date 가 기간 안)이 하나라도 있는 주문 — 마지막 체결일(executedDate)만 보지 않는다
   *    (며칠에 걸친 부분 체결의 앞선 몫이 빠지지 않게). 기간 밖 몫도 fills 에 함께 오므로 날짜별로 셀 때는 fills 를 거른다
   *  - estimated: 계좌마다 의심을 안고 저장한 스냅샷을 건너뛰고(그 계좌 몫이 빠졌을 수 있어서), 부분 체결은 받을 때마다 늘어난 몫(fills)으로 센다
   */
  async listTrades(q: { from: string; to: string; code?: string }): Promise<{ items: TradeView[]; estimated: EstimatedChange[] }> {
    const db = this.deps.db;
    const items = await this.tradesTouching(q.from, q.to, q.code ? { codes: [q.code] } : {});
    // 추정: 기간 앞 스냅샷 하나를 더 보려고 10일 앞부터
    const snaps = (await db.selectFrom("account_snapshots").selectAll().where("status", "=", "ok").where("snapshot_date", ">=", addDays(q.from, -10)).where("snapshot_date", "<=", q.to).execute()).map(snapshotView);
    const trades = await this.tradesTouching(addDays(q.from, -11), q.to, q.code ? { codes: [q.code] } : {});
    const estimated = unexplainedChanges(
      snaps.map((s) => ({ date: s.date, market: s.market, asOf: s.asOf, holdings: s.holdings, doubtAccounts: s.doubts.map((d) => d.account) })),
      trades.map((t) => ({ ...t, fills: t.fills.map((f) => ({ quantity: f.quantity, at: f.at })) })),
    ).filter((c) => c.toDate >= q.from && c.toDate <= q.to && (!q.code || c.code === q.code));
    return { items, estimated };
  }

  /**
   * 기간 [from, to] 에 든 몫(fills[].date)이 있거나 마지막 체결일이 기간 안인 체결 (executed_at·id 순).
   * 몫의 날짜는 마지막 체결일(executed_date)보다 앞이거나(체결 시각 기준) 첫 몫 시각(주문 시각·처음 본 시각 기준)보다 뒤일 수 있어,
   * executed_date 로 앞뒤 FILL_SPAN_DAYS 일을 넉넉히 받아 몫 날짜로 거른다 (그보다 오래 걸친 주문의 먼 몫은 빠질 수 있다)
   */
  private async tradesTouching(from: string, to: string, opts: { codes?: string[] } = {}): Promise<TradeView[]> {
    if (opts.codes && opts.codes.length === 0) return [];
    let query = this.deps.db.selectFrom("trade_executions").selectAll().where("executed_date", ">=", addDays(from, -FILL_SPAN_DAYS)).where("executed_date", "<=", addDays(to, FILL_SPAN_DAYS));
    if (opts.codes) query = query.where("code", "in", opts.codes);
    const rows = (await query.orderBy("executed_at").orderBy("id").execute()).map(tradeView);
    return rows.filter((t) => (t.executedDate >= from && t.executedDate <= to) || t.fills.some((f) => f.date >= from && f.date <= to));
  }

  async status(): Promise<TradeRecordStatus> {
    const db = this.deps.db;
    const now = this.now();
    const state = await this.loadState();
    const rows = await db.selectFrom("account_snapshots").select(["snapshot_date", "market", "status", "method", "as_of"]).orderBy("snapshot_date").execute();
    const markets = {} as Record<RecordMarket, MarketRecordStatus>;
    const okDates = new Set<string>();
    for (const m of MARKETS) {
      const mine = rows.filter((r) => r.market === m);
      const ok = mine.filter((r) => r.status === "ok");
      for (const r of ok) okDates.add(r.snapshot_date);
      const okSet = new Set(ok.map((r) => r.snapshot_date));
      const since = state.since[m] ?? ok[0]?.snapshot_date ?? null;
      const last = ok.at(-1);
      // 휴장일 목록으로 고른 거래일 가운데 달력이 휴장이라 한 날(예상 못 한 휴장 — 스냅샷도 빈칸도 만들지 않은 날)은 빠진 날로 세지 않는다
      const missing30 = await this.openOnly(m, missingDates(recentExpectedDates(m, now, 30), okSet, since));
      const five = new Set(recentExpectedDates(m, now, 5));
      markets[m] = {
        since,
        last: last ? { date: last.snapshot_date, method: (last.method as SnapshotMethod | null) ?? null, asOf: last.as_of } : null,
        stored: ok.length,
        gaps: mine.length - ok.length,
        missing5: missing30.filter((d) => five.has(d)),
        missing30,
        lastError: this.lastError[m]?.message ?? null,
      };
    }
    const flat = (k: "missing5" | "missing30") => MARKETS.flatMap((m) => markets[m][k].map((date) => ({ market: m, date })));
    const missing5 = flat("missing5");
    const missing30 = flat("missing30");
    const sinces = MARKETS.map((m) => markets[m].since).filter((x): x is string => !!x).sort();
    const t = await db
      .selectFrom("trade_executions")
      .select((eb) => [eb.fn.countAll<number>().as("n"), eb.fn.min("executed_date").as("earliest"), eb.fn.max("executed_date").as("latest")])
      .executeTakeFirst();
    return {
      toss: this.hasToss,
      since: sinces[0] ?? null,
      days: okDates.size,
      markets,
      missing5,
      missing30,
      warning: [warningText(markets), tradeWarning(state)].filter((x): x is string => !!x).join(" / ") || null,
      trades: {
        count: Number(t?.n ?? 0),
        earliest: (t?.earliest as string | null | undefined) ?? null,
        latest: (t?.latest as string | null | undefined) ?? null,
        lastSyncAt: state.lastTradeSyncAt,
        lastError: MARKETS.map((m) => state.tradeErrors[m]).filter((x): x is string => !!x).join(" / ") || null,
        failing: Object.fromEntries(MARKETS.filter((m) => state.tradeRetry[m]?.pairs.length).map((m) => [m, retryCodes(state, m)])),
        failingPairs: Object.fromEntries(MARKETS.filter((m) => state.tradeRetry[m]?.pairs.length).map((m) => [m, [...state.tradeRetry[m]!.pairs].sort()])),
        truncated: Object.keys(state.truncated).sort(),
        coverage: state.coverage,
        source: "toss-orders",
      },
    };
  }

  private async loadState(): Promise<State> {
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", STATE_KEY).executeTakeFirst();
    const empty = (): State => ({ since: {}, tradesFor: {}, tradeRetry: {}, tradeFail: {}, lastTradeSyncAt: null, tradeErrors: {}, coverage: {}, truncated: {}, doubts: {} });
    if (!row) return empty();
    try {
      const v = JSON.parse(row.value) as Partial<State> | null;
      if (!v || typeof v !== "object") return empty();
      const obj = <T>(x: unknown): T => (x && typeof x === "object" && !Array.isArray(x) ? (x as T) : ({} as T));
      const doubts: Record<string, DoubtEntry> = {};
      for (const [k, d] of Object.entries(obj<Record<string, Partial<DoubtEntry> | null>>(v.doubts))) {
        if (!d || typeof d.text !== "string" || !Number.isFinite(d.since) || !Number.isFinite(d.last) || !Number.isFinite(d.count)) continue;
        doubts[k] = { text: d.text, since: d.since!, last: d.last!, count: d.count!, accepted: typeof d.accepted === "string" ? d.accepted : null };
      }
      // 다시 묻는 짝: '계좌:종목' 모양만 (모양이 다른 옛 값은 버린다 — 다음 전체 받기에서 다시 묻는다)
      const tradeRetry: State["tradeRetry"] = {};
      for (const m of MARKETS) {
        const r = obj<Record<string, { date?: unknown; pairs?: unknown; tries?: unknown } | null>>(v.tradeRetry)[m];
        if (!r || typeof r.date !== "string" || !Array.isArray(r.pairs) || !Number.isFinite(r.tries)) continue;
        const pairs = r.pairs.filter((k): k is string => typeof k === "string" && parsePair(k) !== null);
        if (pairs.length) tradeRetry[m] = { date: r.date, pairs, tries: Number(r.tries) };
      }
      return {
        since: obj(v.since),
        tradesFor: obj(v.tradesFor),
        tradeRetry,
        tradeFail: obj(v.tradeFail),
        lastTradeSyncAt: typeof v.lastTradeSyncAt === "string" ? v.lastTradeSyncAt : null,
        tradeErrors: obj(v.tradeErrors),
        coverage: obj(v.coverage),
        truncated: obj(v.truncated),
        doubts,
      };
    } catch {
      return empty();
    }
  }

  private async saveState(state: State): Promise<void> {
    const value = JSON.stringify(state);
    await this.deps.db.insertInto("meta").values({ key: STATE_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
  }
}

const doubtKey = (market: RecordMarket, kind: DoubtKind, account: number) => `${market}|${kind}|${account}`;

const codeList = (codes: string[]) => `${codes.length}종목(${codes.slice(0, 3).join("·")}${codes.length > 3 ? " 등" : ""})`;

/** 다시 묻는 짝의 종목 (중복 없이, 정렬) */
function retryCodes(state: State, market: RecordMarket): string[] {
  return [...new Set((state.tradeRetry[market]?.pairs ?? []).map((k) => parsePair(k)?.[1]).filter((c): c is string => !!c))].sort();
}

/**
 * 체결 받기 경고 — 받지 못한 종목의 체결이 빠져 있을 수 있다:
 * 다시 묻기로도 풀리지 않은(또는 다시 묻는 중인) (계좌, 종목) 짝의 종목 · TRADE_FAIL_WARN 번 넘게 이어지는 전체 실패 · 쪽 수 한도로 오래된 주문을 다 받지 못한 종목
 */
function tradeWarning(state: State): string | null {
  const out: string[] = [];
  const failing = MARKETS.filter((m) => state.tradeRetry[m]?.pairs.length).map((m) => `${MARKET_NAME[m]} ${codeList(retryCodes(state, m))}`);
  if (failing.length) out.push(`체결 받기 실패: ${failing.join(", ")}`);
  const down = MARKETS.filter((m) => (state.tradeFail[m]?.count ?? 0) >= TRADE_FAIL_WARN).map((m) => {
    const f = state.tradeFail[m]!;
    const since = Date.parse(f.since);
    const at = Number.isFinite(since) ? ` ${md(seoulDate(new Date(since)))} ${seoulIso(new Date(since)).slice(11, 16)}부터` : "";
    return `${MARKET_NAME[m]}${at} ${f.count}번`;
  });
  if (down.length) out.push(`체결 받기 전체 실패: ${down.join(", ")}`);
  const cut = Object.keys(state.truncated).sort();
  if (cut.length) out.push(`주문 내역이 너무 많아 오래된 체결을 다 받지 못함: ${codeList(cut)}`);
  return out.length ? out.join(" / ") : null;
}

function warningText(markets: Record<RecordMarket, MarketRecordStatus>): string | null {
  const list = (k: "missing5" | "missing30") =>
    MARKETS.filter((m) => markets[m][k].length > 0).map((m) => `${MARKET_NAME[m]} ${[...markets[m][k]].sort().map(md).join("·")}`);
  const five = list("missing5");
  if (five.length) return `최근 5거래일 중 스냅샷 없는 날: ${five.join(", ")}`;
  const n30 = MARKETS.reduce((s, m) => s + markets[m].missing30.length, 0);
  if (n30) return `최근 30거래일 중 스냅샷 없는 날 ${n30}일 (${MARKETS.filter((m) => markets[m].missing30.length).map((m) => `${MARKET_NAME[m]} ${markets[m].missing30.length}일`).join(" · ")})`;
  return null;
}

function parseData(value: string): SnapshotData | null {
  try {
    const v = JSON.parse(value) as Partial<SnapshotData> | null;
    if (!v || !Array.isArray(v.holdings)) return null;
    const doubts = (Array.isArray(v.doubts) ? v.doubts : []).filter(
      (d): d is SnapshotDoubt => !!d && typeof d === "object" && typeof d.text === "string" && typeof d.kind === "string" && Number.isFinite(d.account),
    );
    const out: SnapshotData = { ...(v as SnapshotData) };
    if (doubts.length) out.doubts = doubts;
    else delete out.doubts;
    return out;
  } catch {
    return null;
  }
}

type SnapshotRow = {
  id: number;
  snapshot_date: string;
  market: string;
  status: string;
  method: string | null;
  as_of: string;
  scheduled_at: string;
  source: string | null;
  reason: string | null;
  data: string;
};

function snapshotView(r: SnapshotRow): SnapshotView {
  const d = r.status === "ok" ? parseData(r.data) : null;
  return {
    id: Number(r.id),
    date: r.snapshot_date,
    market: r.market as RecordMarket,
    status: r.status === "ok" ? "ok" : "gap",
    method: (r.method as SnapshotMethod | null) ?? null,
    asOf: r.as_of,
    scheduledAt: r.scheduled_at,
    source: r.source,
    reason: r.reason,
    priceBasis: d?.priceBasis ?? null,
    fx: d?.fx ?? null,
    totals: d?.totals ?? null,
    holdings: d?.holdings ?? [],
    accounts: d?.accounts ?? [],
    doubts: d?.doubts ?? [],
  };
}

type TradeRow = {
  id: number;
  account: number;
  order_id: string;
  code: string;
  market: string;
  side: string;
  quantity: number;
  amount: number;
  price: number | null;
  currency: string;
  fee: number | null;
  tax: number | null;
  executed_at: string;
  executed_date: string;
  time_basis: string;
  order_status: string;
  fills: string | null;
};

type ExecRow = Selectable<TradeExecutionTable>;

/** fills 칸에 저장하는 한 몫 (TradeFill 의 저장 모양) */
interface StoredFill {
  q: number;
  a: number;
  at: string;
  basis: "filled" | "ordered" | "seen";
  seenAt: string | null;
}

const basisRank = (basis: string) => BASIS_RANK[basis] ?? 0;
const asBasis = (b: unknown): StoredFill["basis"] => (b === "filled" || b === "ordered" ? b : "seen");

/** 저장된 fills (없거나 깨졌으면 한 번에 executed_at 에 체결된 한 몫으로 본다) */
function storedFills(r: Pick<TradeRow, "quantity" | "amount" | "executed_at" | "time_basis" | "fills">): StoredFill[] {
  const whole = (): StoredFill[] => [{ q: Number(r.quantity), a: Number(r.amount), at: r.executed_at, basis: asBasis(r.time_basis), seenAt: null }];
  if (!r.fills) return whole();
  try {
    const v = JSON.parse(r.fills) as unknown;
    if (!Array.isArray(v) || v.length === 0) return whole();
    const out: StoredFill[] = [];
    for (const f of v as Array<Record<string, unknown>>) {
      if (!f || typeof f !== "object" || !Number.isFinite(f["q"]) || !Number.isFinite(f["a"]) || typeof f["at"] !== "string") return whole();
      out.push({ q: f["q"] as number, a: f["a"] as number, at: f["at"], basis: asBasis(f["basis"]), seenAt: typeof f["seenAt"] === "string" ? f["seenAt"] : null });
    }
    // 합이 누적 수량과 맞지 않으면(손으로 고친 줄 등) 믿지 않는다
    return Math.abs(out.reduce((s, f) => s + f.q, 0) - Number(r.quantity)) < 1e-6 ? out : whole();
  } catch {
    return whole();
  }
}

/** 몫 시각의 그 시장 거래일 (읽지 못하면 그 주문의 체결일) */
function fillDate(at: string, r: Pick<TradeRow, "market" | "executed_date">): string {
  if (!Number.isFinite(Date.parse(at))) return r.executed_date;
  return tradingDate(at, r.market === "KR");
}

function tradeView(r: TradeRow): TradeView {
  return {
    id: Number(r.id),
    account: Number(r.account),
    orderId: r.order_id,
    code: r.code,
    market: r.market as RecordMarket,
    side: r.side === "SELL" ? "SELL" : "BUY",
    quantity: Number(r.quantity),
    amount: Number(r.amount),
    price: r.price === null ? null : Number(r.price),
    currency: r.currency === "USD" ? "USD" : "KRW",
    fee: r.fee === null ? null : Number(r.fee),
    tax: r.tax === null ? null : Number(r.tax),
    executedAt: r.executed_at,
    executedDate: r.executed_date,
    timeBasis: r.time_basis === "filled" || r.time_basis === "ordered" ? r.time_basis : "seen",
    status: r.order_status === "OPEN" ? "OPEN" : "CLOSED",
    source: "toss-orders",
    fills: storedFills(r).map((f) => ({ quantity: f.q, amount: f.a, at: f.at, date: fillDate(f.at, r), basis: f.basis, seenAt: f.seenAt })),
  };
}

/** 토스 주문 한 줄 → 저장할 줄 (iso = 받은 시각, seen = 체결·주문 시각이 둘 다 없을 때 적는 시각 — 그 확인의 스냅샷 as_of) */
function tradeRow(account: number, code: string, o: TossOrderRecord, iso: string, seen: string) {
  const market = marketOf(code);
  const executedAt = o.filledAt ?? o.orderedAt ?? seen;
  const timeBasis: StoredFill["basis"] = o.filledAt ? "filled" : o.orderedAt ? "ordered" : "seen";
  return {
    account,
    order_id: o.orderId,
    code,
    market,
    side: o.side,
    quantity: o.quantity,
    amount: o.amount,
    price: o.quantity > 0 ? Math.round((o.amount / o.quantity) * 1e6) / 1e6 : null,
    currency: o.currency ?? (market === "KR" ? "KRW" : "USD"),
    fee: null,
    tax: null,
    executed_at: executedAt,
    executed_date: tradingDate(executedAt, market === "KR"),
    time_basis: timeBasis,
    order_status: o.status,
    source: "toss-orders",
    raw: JSON.stringify(o.raw),
    created_at: iso,
    updated_at: iso,
  };
}
