import { isKrCode } from "../lib/codes.js";
import type { TossHolding } from "../providers/market/tossOpenApi.js";
import { isKrTradingDate, isUsTradingDate, krRegularHours, tradingDate, usRegularCloseMinutes } from "./marketContext.js";

/**
 * 매매 기록 기반 (3-36) 순수 계산 — 시각은 모두 인자로 받는다 (테스트는 고정 시계).
 *  - 스냅샷 날짜 = 그 시장의 거래일(marketContext.tradingDate 와 같은 규칙: 한국은 08:00 전이면 전 거래일, 미국은 뉴욕 20:00 뒤면 다음 거래일,
 *    주말·휴장일(KR_HOLIDAYS·US_HOLIDAYS)은 직전 거래일)
 *  - 예약 시각 = 한국 정규장 마감 35분 뒤(보통 16:05, 수능일 17:05), 미국 정규장 마감 5분 뒤(16:05 ET, 조기 폐장 13:05 ET — 서머타임은 뉴욕 시각으로 계산)
 *  - 방법: 예약 시각부터 30분 안이면 'close', 그 뒤 같은 거래일 안이면(서버가 늦게 켜졌거나 토스 오류 뒤 다시) 'intraday-fallback'.
 *    둘 다 그때 토스 보유 조회의 수량·평단·현재가 그대로다 — 한국은 NXT 애프터마켓, 미국은 애프터마켓 체결이 섞일 수 있어 '정규장 종가'와 조금 다를 수 있다.
 *    그래서 그 거래일 일봉의 정규장 종가를 regularClose 로 따로 함께 적는다(받지 못하면 null)
 *  - 거래일이 지나도록 못 찍은 날은 값을 지어내지 않고 빈칸(gap)으로 남긴다
 *  - 한국 16:05 뒤에도 NXT 애프터마켓(~20:00)에서 체결될 수 있어, 거래일 D 에 체결(executed_date = D)됐어도 보유 변화는 D+1 스냅샷에 들어갈 수 있다.
 *    그래서 체결과 스냅샷을 짝지을 때는 executed_date 가 아니라 스냅샷 asOf 와 체결 시각(executed_at)을 비교한다 (unexplainedChanges 가 그렇게 한다)
 */

export type RecordMarket = "KR" | "US";
export type SnapshotMethod = "close" | "intraday-fallback";

/** 한국: 15:30 정규장 마감(시간외 종가 매매 15:40~16:00)이 끝난 뒤 */
export const KR_AFTER_CLOSE_MIN = 35;
/** 미국: 16:00 ET 정규장 마감 5분 뒤 (조기 폐장 13:00 이면 13:05) */
export const US_AFTER_CLOSE_MIN = 5;
/** 예약 시각부터 이만큼 안에 찍으면 'close' */
export const CLOSE_TOLERANCE_MS = 30 * 60_000;

const TZ: Record<RecordMarket, string> = { KR: "Asia/Seoul", US: "America/New_York" };
export const MARKET_NAME: Record<RecordMarket, string> = { KR: "한국", US: "미국" };

/** 그 시각의 시간대 오프셋(현지 − UTC, ms) */
function offsetMs(d: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** 현지 날짜 YYYY-MM-DD 의 자정부터 minutes 분 → 실제 시각 (서머타임 반영) */
export function zonedInstant(date: string, minutes: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = naive - offsetMs(new Date(naive), tz);
  // 오프셋이 바뀌는 날 경계: 한 번 더 맞춘다
  const second = offsetMs(new Date(t), tz);
  t = naive - second;
  return new Date(t);
}

export function isTradingDay(market: RecordMarket, date: string): boolean {
  return market === "KR" ? isKrTradingDate(date) : isUsTradingDate(date);
}

/** 그 거래일 스냅샷의 예약 시각 */
export function snapshotDueAt(market: RecordMarket, date: string): Date {
  const minutes = market === "KR" ? krRegularHours(date).close + KR_AFTER_CLOSE_MIN : usRegularCloseMinutes(date) + US_AFTER_CLOSE_MIN;
  return zonedInstant(date, minutes, TZ[market]);
}

/** 지금이 속한 그 시장의 거래일 */
export function sessionDate(market: RecordMarket, now: Date): string {
  return tradingDate(now.toISOString(), market === "KR");
}

export interface SnapshotPlan {
  market: RecordMarket;
  date: string;
  dueAt: Date;
  /** 예약 시각이 지났는지 */
  due: boolean;
  method: SnapshotMethod | null;
}

export function snapshotPlan(market: RecordMarket, now: Date): SnapshotPlan {
  const date = sessionDate(market, now);
  const dueAt = snapshotDueAt(market, date);
  const late = now.getTime() - dueAt.getTime();
  const due = late >= 0;
  return { market, date, dueAt, due, method: !due ? null : late <= CLOSE_TOLERANCE_MS ? "close" : "intraday-fallback" };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** after 와 before 사이(양 끝 제외)의 거래일, 오래된 순. 최대 400일 */
export function tradingDaysBetween(market: RecordMarket, after: string, before: string): string[] {
  const out: string[] = [];
  for (let d = addDays(after, 1), i = 0; d < before && i < 400; d = addDays(d, 1), i++) if (isTradingDay(market, d)) out.push(d);
  return out;
}

/** 점검 대상: 예약 시각 + 30분이 지난 거래일 가운데 최근 n개 (새것부터) */
export function recentExpectedDates(market: RecordMarket, now: Date, n: number): string[] {
  const out: string[] = [];
  let d = sessionDate(market, now);
  if (now.getTime() < snapshotDueAt(market, d).getTime() + CLOSE_TOLERANCE_MS) d = addDays(d, -1);
  for (let i = 0; out.length < n && i < 800; i++, d = addDays(d, -1)) if (isTradingDay(market, d)) out.push(d);
  return out;
}

/** 빠진 날: 기록 시작일(since) 이후에 ok 스냅샷이 없는 날 (시작 전 날은 빠진 날이 아님) */
export function missingDates(expected: string[], ok: ReadonlySet<string>, since: string | null): string[] {
  if (!since) return [];
  return expected.filter((d) => d >= since && !ok.has(d));
}

/** 'M/D' */
export const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// ── 스냅샷 내용 ──────────────────────────────────────────────────────

export interface AccountOverview {
  purchaseKrw: number;
  purchaseUsd: number | null;
  afterCostKrw: number;
  afterCostUsd: number;
  rateAfterCost: number | null;
}

export interface AccountHoldings {
  account: number;
  items: TossHolding[];
  overview: AccountOverview;
}

export interface SnapshotHolding {
  account: number;
  code: string;
  name: string;
  currency: "KRW" | "USD";
  quantity: number;
  avgPrice: number | null;
  /** 찍은 때 토스 보유 조회의 현재가 (한국 KRX+NXT 통합, 미국 최근 체결(시간외 포함)) — 평가금액·원화 합계는 이 값 기준 */
  price: number | null;
  /**
   * 그 거래일 정규장 종가 (그날 일봉 종가 — 한국 네이버 KRX 일봉, 미국 토스 웹 일봉(애프터마켓 제외)·Yahoo). 받지 못했으면 null (지어내지 않음).
   * 3-37 기간 수익률·'어제와 비교'를 증권사 종가 기준으로 맞출 때 쓴다. price 와 따로 둔다
   */
  regularClose: number | null;
  /** regularClose 를 준 출처 (naver · toss · yahoo 등, 없으면 null) */
  regularCloseSource: string | null;
  purchaseAmount: number | null;
  marketValue: number | null;
  marketValueAfterCost: number | null;
  /** 평가금액 원화 (미국은 기록한 환율로, 환율이 없으면 null) */
  valueKrw: number | null;
  valueAfterCostKrw: number | null;
  /** 원화 매입금액: 한국은 토스 매입금액, 미국은 원화 장부(수량이 맞을 때만) — 없으면 null */
  costKrw: number | null;
  costKrwSource: "toss" | "book-exact" | "book-estimated" | null;
}

export interface SnapshotTotals {
  holdings: number;
  valueKrw: number | null;
  valueAfterCostKrw: number | null;
  /** 하나라도 원화 매입금액을 모르면 null */
  costKrw: number | null;
  /** 미국만: 달러 평가금액·매입금액 합계 */
  valueUsd: number | null;
  costUsd: number | null;
}

export interface SnapshotData {
  version: 1;
  /** 가격이 무엇인지 (사람이 읽는 설명) */
  priceBasis: string;
  /** regularClose(정규장 종가)가 무엇인지 (사람이 읽는 설명) */
  regularCloseBasis: string;
  /**
   * 미국만: 원화 합계에 쓴 환율과 실제 출처('toss' 토스 표시 환율 · 'naver' 네이버 환율 · 'unknown' 출처를 모름), 그 환율을 받은 시각(asOf —
   * 받기에 실패해 전에 받아 둔 값을 썼으면 그때 시각이라 찍은 시각보다 이르다). 환율이 없으면 usdKrw·source·asOf 모두 null
   */
  fx: { usdKrw: number | null; source: string | null; asOf: string | null } | null;
  holdings: SnapshotHolding[];
  totals: SnapshotTotals;
  /** 찍은 때 토스 계좌 요약 (계좌 순번별 — 계좌번호 없음). 3-37 에서 토스 수익률과 맞춰 보는 데 쓴다 */
  accounts: Array<{ account: number } & AccountOverview>;
  /**
   * 오래 이어져(또는 관리 API force 로) 받아들인 의심 (snapshotDoubts) — 있으면 이 스냅샷은 적힌 계좌(account)의 몫이 빠졌을 수 있다.
   * 없으면 칸이 없다. 추정 계산(unexplainedChanges)은 그 계좌를 이 스냅샷으로 비교하지 않고, '어제와 비교'는 previousSnapshot 의 skipDoubted 로 건너뛴다
   */
  doubts?: SnapshotDoubt[];
}

export const PRICE_BASIS: Record<RecordMarket, string> = {
  KR: "토스 보유 조회의 현재가 (KRX+NXT 통합 — 16:05 뒤 NXT 애프터마켓 체결이 섞일 수 있음)",
  US: "토스 보유 조회의 현재가 (최근 체결 — 정규장 마감 뒤 애프터마켓 체결이 섞일 수 있음)",
};

export const REGULAR_CLOSE_BASIS: Record<RecordMarket, string> = {
  KR: "그 거래일 일봉 종가 (KRX 정규장 — 네이버 일봉). 받지 못한 종목은 null",
  US: "그 거래일 일봉 종가 (정규장 — 토스 웹 일봉(애프터마켓 제외), 없으면 Yahoo). 받지 못한 종목은 null",
};

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const sumOrNull = (xs: Array<number | null>, round: (n: number) => number): number | null => (xs.some((x) => x === null) ? null : round(xs.reduce<number>((s, x) => s + (x ?? 0), 0)));

export function marketOf(code: string): RecordMarket {
  return isKrCode(code) ? "KR" : "US";
}

export function buildSnapshotData(
  market: RecordMarket,
  accounts: AccountHoldings[],
  ctx: {
    fx: number | null;
    fxSource: string | null;
    /** 그 환율을 받은 시각 (모르면 null) */
    fxAsOf?: string | null;
    scheduledAt: string;
    /** (계좌, 종목, 수량) → 원화 장부의 원화 매입금액. 수량이 맞지 않거나 없으면 null */
    krwCost: (account: number, code: string, quantity: number) => { krw: number; source: "book-exact" | "book-estimated" } | null;
    /** 종목 → 그 거래일 정규장 종가와 출처 (없으면 null) */
    regularClose?: (code: string) => { close: number; source: string } | null;
  },
): SnapshotData {
  const holdings: SnapshotHolding[] = [];
  for (const a of accounts) {
    for (const h of a.items) {
      if (marketOf(h.code) !== market || !(h.quantity > 0)) continue;
      const mv = h.marketValue ?? (h.lastPrice !== null ? h.lastPrice * h.quantity : null);
      const after = h.marketValueAfterCost ?? null;
      const usd = h.currency === "USD";
      const toKrw = (v: number | null) => (v === null ? null : usd ? (ctx.fx !== null ? Math.round(v * ctx.fx) : null) : Math.round(v));
      const book = usd ? ctx.krwCost(a.account, h.code, h.quantity) : null;
      const rc = ctx.regularClose?.(h.code) ?? null;
      holdings.push({
        account: a.account,
        code: h.code,
        name: h.name,
        currency: h.currency,
        quantity: h.quantity,
        avgPrice: h.avgPrice,
        price: h.lastPrice,
        regularClose: rc && Number.isFinite(rc.close) && rc.close > 0 ? rc.close : null,
        regularCloseSource: rc && Number.isFinite(rc.close) && rc.close > 0 ? rc.source : null,
        purchaseAmount: h.purchaseAmount ?? null,
        marketValue: mv,
        marketValueAfterCost: after,
        valueKrw: toKrw(mv),
        valueAfterCostKrw: toKrw(after),
        costKrw: usd ? (book ? Math.round(book.krw) : null) : h.purchaseAmount !== null && h.purchaseAmount !== undefined ? Math.round(h.purchaseAmount) : null,
        costKrwSource: usd ? (book ? book.source : null) : h.purchaseAmount !== null && h.purchaseAmount !== undefined ? "toss" : null,
      });
    }
  }
  holdings.sort((x, y) => x.account - y.account || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
  const us = market === "US";
  return {
    version: 1,
    priceBasis: PRICE_BASIS[market],
    regularCloseBasis: REGULAR_CLOSE_BASIS[market],
    fx: us ? { usdKrw: ctx.fx, source: ctx.fx !== null ? ctx.fxSource : null, asOf: ctx.fx !== null ? ctx.fxAsOf ?? null : null } : null,
    holdings,
    totals: {
      holdings: holdings.length,
      valueKrw: sumOrNull(holdings.map((h) => h.valueKrw), Math.round),
      valueAfterCostKrw: sumOrNull(holdings.map((h) => h.valueAfterCostKrw), Math.round),
      costKrw: sumOrNull(holdings.map((h) => h.costKrw), Math.round),
      valueUsd: us ? sumOrNull(holdings.map((h) => h.marketValue), round4) : null,
      costUsd: us ? sumOrNull(holdings.map((h) => h.purchaseAmount), round4) : null,
    },
    accounts: accounts.map((a) => ({ account: a.account, ...a.overview })),
  };
}

// ── 토스 응답을 믿을 수 있는지 (계좌마다) ────────────────────────────────
//
// 스냅샷은 한 번 쓰면 다시 찍지 않으므로, 계좌 하나의 몫이 빠진 응답을 'ok' 로 남기면 틀린 합계가 영구히 남는다
// (3-37 기간 수익률·'어제와 비교'·다음 스냅샷과의 '추정' 줄까지 틀어짐). 그래서 계좌마다 보고, 의심스러우면 찍지 않고 다시 묻는다.
// 같은 의심이 오래 이어지면(정말 그 상태일 수 있음 — 계좌 해지, 전부 판 빈 계좌) 토스 동기화(tossSyncService)와 같은 기준으로
// 받아들이되, 그 스냅샷에 의심 내용을 적어(reason·data.doubts) 나중에 가려낼 수 있게 한다.

/**
 * - empty: 그 계좌의 그 시장 보유 목록이 비었는데 계좌 요약의 그 통화 매입금액이 0 이 아님 (목록만 비어 온 일시 오류)
 * - unsure: 그 계좌 보유 목록이 통째로 비었고 요약의 달러 매입금액이 없어 빈 계좌인지 확인할 수 없음 — 직전 스냅샷의 그 계좌 종목이
 *   그 사이 저장한 매도 체결로 모두 설명되면(전부 팖) 의심하지 않는다
 * - sum: 그 계좌 종목 매입금액 합계가 요약 매입금액과 반올림 차이(종목 수 × 1원·1센트)보다 크게 다름 (목록 일부만 온 일시 오류)
 * - vanished: 직전 스냅샷에 있던 종목이 목록에서 사라졌는데 그 사이 저장한 체결(매도)로 설명되지 않음 (목록 일부만 온 일시 오류)
 * - missing-account: 전에 그 시장 종목이 있던 계좌가 계좌 목록에서 빠짐
 */
export type DoubtKind = "empty" | "unsure" | "sum" | "vanished" | "missing-account";

export interface SnapshotDoubt {
  kind: DoubtKind;
  /** 토스 계좌 순번(accountSeq) — 계좌번호가 아님 */
  account: number;
  text: string;
}

/**
 * 같은 의심이 처음 본 뒤 이만큼 넘게, 두 번 이상 이어지면 받아들인다 (tossSyncService 의 UNSURE_MS 30분 · DOUBT_MS 24시간과 같은 값).
 * 24시간 쪽은 그 거래일 안에 풀리지 않으면 그날은 빈칸이 되고, 다음 거래일 스냅샷에서 받아들인다
 */
export const DOUBT_ACCEPT_MS: Record<DoubtKind, number> = {
  unsure: 30 * 60_000,
  sum: 30 * 60_000,
  vanished: 30 * 60_000,
  empty: 24 * 3_600_000,
  "missing-account": 24 * 3_600_000,
};

/**
 * 종목 매입금액 합계와 요약 매입금액의 허용 차이 = 종목 수 × 반올림 단위(원화 1원 · 달러 0.01달러) + 요약의 아주 작은 비율(부동소수 오차).
 * 반올림 차이만 넘기고, 작은 종목 하나라도 빠지면 잡는다 (예전 1% 는 요약의 1% 보다 작은 종목이 빠진 응답을 'ok' 로 남겼다)
 */
export const SUM_TOLERANCE = { KRW: 1, USD: 0.01, rel: 1e-9 } as const;

export function sumTolerance(cur: "KRW" | "USD", holdings: number, summary: number): number {
  return Math.max(1, holdings) * SUM_TOLERANCE[cur] + Math.abs(summary) * SUM_TOLERANCE.rel;
}

const money = (n: number, cur: "KRW" | "USD") => (cur === "KRW" ? `${Math.round(n).toLocaleString("en-US")}원` : `$${round4(n)}`);

/** 같은 의심이 이만큼 넘게 보이지 않았으면 이어 세지 않는다 (추석·긴 연휴는 넘게) */
export const DOUBT_CARRY_MAX_MS = 7 * 86_400_000;

/**
 * 받아들이는 데 하루 넘게 걸리는 의심(empty·missing-account)은 그 거래일 안에 찰 수 없어 다음 거래일로 이어 센다 — 내용(text)이 똑같을 때만.
 * 30분짜리(unsure·sum·vanished)는 5분 간격 다시 묻기로 이어 본 것만 센다 (밤사이 한 번 본 것으로 다음 날 곧바로 받아들이지 않게)
 */
export function doubtCarriesOver(kind: DoubtKind): boolean {
  return DOUBT_ACCEPT_MS[kind] >= 86_400_000;
}

/** 직전 ok 스냅샷(같은 시장)과 그 뒤 저장한 체결 */
export interface PrevSnapshotInfo {
  /**
   * 그 시장 종목을 갖고 있던 계좌 — 직전 스냅샷에 그 계좌 종목이 있었거나, 직전 스냅샷에 없는 계좌(첫 스냅샷·새 계좌)면
   * 토스 동기화가 마지막으로 믿은 보유에 그 시장 종목이 있던 계좌. 'unsure'·'missing-account' 는 이 계좌만 본다
   * (늘 비어 있는 계좌가 목록에서 잠깐 빠지거나 달러 요약 없이 와도 의심하지 않게 — 토스 동기화의 kept.length > 0 과 같은 기준)
   */
  held?: readonly number[];
  /** 직전 스냅샷의 그 시장 보유 (계좌, 종목, 수량) — 목록에서 사라진 종목을 찾으려고 */
  holdings?: ReadonlyArray<{ account: number; code: string; quantity: number }>;
  /** 직전 스냅샷 뒤 저장한 체결의 순수량 (매수 +, 매도 −), '계좌:종목' → 수량 (없으면 0) */
  traded?: Readonly<Record<string, number>>;
}

const qtyText = (n: number) => `${round4(n)}주`;

/**
 * 그 시장 스냅샷을 찍기 전에 계좌마다 토스 응답을 확인한다. 빈 배열이면 믿을 수 있다.
 * 매입금액 요약은 계좌마다 통화별(원화 = 한국 종목, 달러 = 미국 종목 — 원화 장부 보정과 같은 뜻)이라 그 시장 통화 칸과 맞춰 본다.
 * @param prev 직전 ok 스냅샷에서 본 계좌·보유와 그 뒤 저장한 체결 (첫 스냅샷이면 빈 값)
 */
export function snapshotDoubts(market: RecordMarket, accounts: AccountHoldings[], prev: PrevSnapshotInfo = {}): SnapshotDoubt[] {
  const out: SnapshotDoubt[] = [];
  const name = MARKET_NAME[market];
  const cur = market === "KR" ? "KRW" : "USD";
  const listed = new Set(accounts.map((a) => a.account));
  const heldBefore = new Set(prev.held ?? []);
  for (const acct of [...heldBefore].sort((x, y) => x - y)) {
    if (!listed.has(acct)) out.push({ kind: "missing-account", account: acct, text: `계좌 ${acct}: 전에 ${name} 종목이 있던 계좌가 토스 계좌 목록에서 빠짐` });
  }
  for (const a of accounts) {
    const held = a.items.filter((h) => h.quantity > 0);
    const mine = held.filter((h) => marketOf(h.code) === market);
    const summary = market === "KR" ? a.overview.purchaseKrw : a.overview.purchaseUsd;
    // 직전 스냅샷에 있던 그 계좌 종목 가운데 지금 목록에 없는 것 — 그 사이 저장한 체결의 순매도가 그 수량을 덮으면 판 것으로 본다
    const before = (prev.holdings ?? []).filter((h) => h.account === a.account && marketOf(h.code) === market && h.quantity > 0);
    const now = new Set(mine.map((h) => h.code));
    const gone = before
      .filter((h) => !now.has(h.code) && h.quantity + (prev.traded?.[`${a.account}:${h.code}`] ?? 0) > 1e-6)
      .sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
    if (mine.length === 0) {
      if (summary !== null && summary !== 0) {
        out.push({ kind: "empty", account: a.account, text: `계좌 ${a.account}: ${name} 보유 목록이 비었는데 계좌 요약 매입금액은 ${money(summary, cur)}` });
        continue;
      }
      if (held.length === 0 && a.overview.purchaseUsd === null && heldBefore.has(a.account)) {
        // 목록이 통째로 비었고 달러 요약도 없다: 요약이 빠진 일시 오류와 전부 판 빈 계좌를 가릴 수 없다 (원화 요약은 없으면 0 으로 읽힌다).
        // 그래서 전에 그 시장 종목이 있던 계좌만 의심한다 — 늘 비어 있는 계좌(달러 요약 없이 옴)는 날마다 의심하지 않는다 (토스 동기화와 같은 기준).
        // 직전 스냅샷의 그 계좌 종목이 그 사이 저장한 매도로 모두 설명되면 정말 전부 판 것이라 곧바로 받아들인다
        // (직전 스냅샷 없이 토스 동기화 기록으로만 아는 계좌는 수량을 몰라 맞춰 볼 수 없다)
        if (before.length === 0 || gone.length > 0) {
          out.push({ kind: "unsure", account: a.account, text: `계좌 ${a.account}: 보유 목록이 비었고 요약의 달러 매입금액이 없어 빈 계좌인지 확인할 수 없음 (전에는 ${name} 종목이 있었음)` });
        }
        continue;
      }
      // 목록에 다른 시장 종목이 있는 계좌의 달러 요약 빈칸은 '달러 종목 없음'으로 본다 — 사라진 종목만 아래에서 본다
    }
    if (gone.length) {
      out.push({
        kind: "vanished",
        account: a.account,
        text: `계좌 ${a.account}: 직전 스냅샷의 ${gone.map((h) => `${h.code} ${qtyText(h.quantity)}`).join("·")}이(가) 목록에서 빠졌는데 그 사이 저장한 매도 체결로 설명되지 않음`,
      });
    }
    if (mine.length === 0 || summary === null) continue;
    const sameCur = held.filter((h) => h.currency === cur);
    if (sameCur.some((h) => h.purchaseAmount === null || h.purchaseAmount === undefined)) continue; // 종목 매입금액을 모르면 맞춰 볼 수 없다
    const sum = sameCur.reduce((s, h) => s + (h.purchaseAmount ?? 0), 0);
    if (Math.abs(sum - summary) > sumTolerance(cur, sameCur.length, summary)) {
      out.push({ kind: "sum", account: a.account, text: `계좌 ${a.account}: ${name} 종목 매입금액 합계 ${money(sum, cur)} ≠ 계좌 요약 ${money(summary, cur)}` });
    }
  }
  return out;
}

// ── 주문 내역으로 설명되지 않는 수량 변화 (추정) ─────────────────────────────

export interface SnapshotLite {
  date: string;
  market: RecordMarket;
  asOf: string;
  holdings: Array<{ account: number; code: string; quantity: number; avgPrice: number | null }>;
  /** 의심을 안고 저장된 스냅샷에서 몫이 빠졌을 수 있는 계좌 (data.doubts 의 account) — 이 계좌는 이 스냅샷으로 비교하지 않는다 */
  doubtAccounts?: readonly number[];
}

export interface TradeLite {
  account: number;
  code: string;
  side: "BUY" | "SELL";
  quantity: number;
  executedAt: string;
  /**
   * 받을 때마다 늘어난 체결 수량과 그 몫의 시각 (trade_executions.fills — 합 = quantity). 있으면 executedAt 대신 이것으로 나눠 센다
   * (며칠에 걸친 부분 체결이 마지막 체결 시각에 한꺼번에 들어가 경계 앞뒤로 가짜 +·− 가 생기지 않게)
   */
  fills?: ReadonlyArray<{ quantity: number; at: string }>;
}

export interface EstimatedChange {
  market: RecordMarket;
  account: number;
  code: string;
  fromDate: string;
  toDate: string;
  fromQty: number;
  toQty: number;
  /** 두 스냅샷 사이 저장한 체결의 순수량 (매수 +, 매도 −) */
  tradedQty: number;
  /** 체결로 설명되지 않는 수량 (이관·분할·병합·주문 내역 누락 등) */
  unexplainedQty: number;
  fromAvg: number | null;
  toAvg: number | null;
  kind: "increase" | "decrease";
  /** 늘 true — 스냅샷 차이로 짐작한 값 */
  estimated: true;
}

/** 그 체결 가운데 (t1, t2] 에 든 수량 — 받을 때마다 늘어난 몫(fills)이 있으면 그것으로, 없으면 한 번에 executedAt 에 */
function filledBetween(t: TradeLite, t1: number, t2: number): number {
  const within = (iso: string) => {
    const at = Date.parse(iso);
    return at > t1 && at <= t2;
  };
  if (t.fills && t.fills.length) return t.fills.reduce((s, f) => s + (within(f.at) ? f.quantity : 0), 0);
  return within(t.executedAt) ? t.quantity : 0;
}

/** (t1, t2] 에 든 체결의 순수량 (매수 +, 매도 −), '계좌:종목' 마다 — 스냅샷을 찍기 전 사라진 종목이 매도로 설명되는지 볼 때 (snapshotDoubts 의 traded) */
export function netTradedBetween(trades: TradeLite[], t1: number, t2: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of trades) {
    const q = filledBetween(t, t1, t2);
    if (q === 0) continue;
    const key = `${t.account}:${t.code}`;
    out[key] = round4((out[key] ?? 0) + (t.side === "BUY" ? q : -q));
  }
  return out;
}

/**
 * 같은 시장의 이어진 두 ok 스냅샷 사이 (계좌, 종목) 수량 변화에서, 그 사이(앞 스냅샷 시각 초과 ~ 뒤 스냅샷 시각 이하) 체결로 설명되지 않는 몫만 '추정' 한 줄로.
 * 계좌마다 비교한다: 그 계좌를 의심한 채 저장된 스냅샷(doubtAccounts)은 그 계좌의 끝점으로 쓰지 않고 앞뒤 믿을 수 있는 스냅샷끼리 비교한다
 * (계좌 몫이 빠졌을 수 있는 스냅샷 때문에 가짜 −x·+x 두 줄이 생기지 않게).
 * 부분 체결은 받을 때마다 늘어난 몫(fills)으로 나눠 세지만, 한 번 받는 사이의 여러 체결은 그 사이 마지막 체결 시각에 들어가므로 경계에서 틀릴 수 있다 — 그래서 추정이다
 */
export function unexplainedChanges(snapshots: SnapshotLite[], trades: TradeLite[]): EstimatedChange[] {
  const out: EstimatedChange[] = [];
  const byMarket = new Map<RecordMarket, SnapshotLite[]>();
  for (const s of snapshots) byMarket.set(s.market, [...(byMarket.get(s.market) ?? []), s]);
  for (const [market, list] of byMarket) {
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const accounts = [...new Set(sorted.flatMap((s) => [...s.holdings.map((h) => h.account), ...(s.doubtAccounts ?? [])]))];
    for (const account of accounts) {
      const usable = sorted.filter((s) => !(s.doubtAccounts ?? []).includes(account));
      for (let i = 1; i < usable.length; i++) {
        const s1 = usable[i - 1]!, s2 = usable[i]!;
        const t1 = Date.parse(s1.asOf), t2 = Date.parse(s2.asOf);
        const q1 = new Map(s1.holdings.filter((h) => h.account === account).map((h) => [h.code, h]));
        const q2 = new Map(s2.holdings.filter((h) => h.account === account).map((h) => [h.code, h]));
        for (const code of new Set([...q1.keys(), ...q2.keys()])) {
          const a = q1.get(code), b = q2.get(code);
          const fromQty = a?.quantity ?? 0, toQty = b?.quantity ?? 0;
          const traded = trades
            .filter((t) => t.account === account && t.code === code)
            .reduce((sum, t) => sum + (t.side === "BUY" ? 1 : -1) * filledBetween(t, t1, t2), 0);
          const unexplained = round4(toQty - fromQty - traded);
          if (Math.abs(unexplained) < 1e-6) continue;
          out.push({
            market,
            account,
            code,
            fromDate: s1.date,
            toDate: s2.date,
            fromQty,
            toQty,
            tradedQty: round4(traded),
            unexplainedQty: unexplained,
            fromAvg: a?.avgPrice ?? null,
            toAvg: b?.avgPrice ?? null,
            kind: unexplained > 0 ? "increase" : "decrease",
            estimated: true,
          });
        }
      }
    }
  }
  return out.sort((x, y) => (x.toDate < y.toDate ? -1 : x.toDate > y.toDate ? 1 : x.market < y.market ? -1 : x.market > y.market ? 1 : x.code < y.code ? -1 : x.code > y.code ? 1 : x.account - y.account));
}
