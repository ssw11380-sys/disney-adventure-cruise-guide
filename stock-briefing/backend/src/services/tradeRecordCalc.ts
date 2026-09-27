import { isKrCode } from "../lib/codes.js";
import type { TossHolding } from "../providers/market/tossOpenApi.js";
import { isKrTradingDate, isUsTradingDate, krRegularHours, tradingDate, usRegularCloseMinutes } from "./marketContext.js";

/**
 * 매매 기록 기반 (3-36) 순수 계산 — 시각은 모두 인자로 받는다 (테스트는 고정 시계).
 *  - 스냅샷 날짜 = 그 시장의 거래일(marketContext.tradingDate 와 같은 규칙: 한국은 08:00 전이면 전 거래일, 미국은 뉴욕 20:00 뒤면 다음 거래일,
 *    주말·휴장일(KR_HOLIDAYS·US_HOLIDAYS)은 직전 거래일)
 *  - 예약 시각 = 한국 정규장 마감 35분 뒤(보통 16:05, 수능일 17:05), 미국 정규장 마감 5분 뒤(16:05 ET, 조기 폐장 13:05 ET — 서머타임은 뉴욕 시각으로 계산)
 *  - 방법: 예약 시각부터 30분 안이면 'close', 그 뒤 같은 거래일 안이면(서버가 늦게 켜졌거나 토스 오류 뒤 다시) 'intraday-fallback'.
 *    둘 다 그때 토스 보유 조회의 수량·평단·현재가 그대로다 — 한국은 NXT 애프터마켓, 미국은 애프터마켓 체결이 섞일 수 있어 '정규장 종가'와 조금 다를 수 있다
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
  /** 찍은 때 토스 보유 조회의 현재가 (한국 KRX+NXT 통합, 미국 최근 체결(시간외 포함)) */
  price: number | null;
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
  /**
   * 미국만: 원화 합계에 쓴 환율과 실제 출처('toss' 토스 표시 환율 · 'naver' 네이버 환율 · 'unknown' 출처를 모름), 그 환율을 받은 시각(asOf —
   * 받기에 실패해 전에 받아 둔 값을 썼으면 그때 시각이라 찍은 시각보다 이르다). 환율이 없으면 usdKrw·source·asOf 모두 null
   */
  fx: { usdKrw: number | null; source: string | null; asOf: string | null } | null;
  holdings: SnapshotHolding[];
  totals: SnapshotTotals;
  /** 찍은 때 토스 계좌 요약 (계좌 순번별 — 계좌번호 없음). 3-37 에서 토스 수익률과 맞춰 보는 데 쓴다 */
  accounts: Array<{ account: number } & AccountOverview>;
  /** 오래 이어져 받아들인 의심 (snapshotDoubts) — 있으면 이 스냅샷은 계좌 몫이 빠졌을 수 있다. 없으면 칸이 없다 */
  doubts?: string[];
}

export const PRICE_BASIS: Record<RecordMarket, string> = {
  KR: "토스 보유 조회의 현재가 (KRX+NXT 통합 — 16:05 뒤 NXT 애프터마켓 체결이 섞일 수 있음)",
  US: "토스 보유 조회의 현재가 (최근 체결 — 정규장 마감 뒤 애프터마켓 체결이 섞일 수 있음)",
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
      holdings.push({
        account: a.account,
        code: h.code,
        name: h.name,
        currency: h.currency,
        quantity: h.quantity,
        avgPrice: h.avgPrice,
        price: h.lastPrice,
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
 * - unsure: 그 계좌 보유 목록이 통째로 비었고 요약의 달러 매입금액이 없어 빈 계좌인지 확인할 수 없음
 * - sum: 그 계좌 종목 매입금액 합계가 요약 매입금액과 맞지 않음 (목록 일부만 온 일시 오류)
 * - missing-account: 직전 스냅샷에 있던 계좌가 계좌 목록에서 빠짐
 */
export type DoubtKind = "empty" | "unsure" | "sum" | "missing-account";

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
  empty: 24 * 3_600_000,
  "missing-account": 24 * 3_600_000,
};

/** 종목 매입금액 합계와 요약 매입금액의 허용 차이: 요약의 1% 와 (원화 10원 · 달러 0.1달러) 가운데 큰 값 — 반올림·표시 차이는 넘기고 종목이 빠진 것만 잡는다 */
export const SUM_TOLERANCE = { rel: 0.01, KRW: 10, USD: 0.1 } as const;

const money = (n: number, cur: "KRW" | "USD") => (cur === "KRW" ? `${Math.round(n).toLocaleString("en-US")}원` : `$${round4(n)}`);

/**
 * 그 시장 스냅샷을 찍기 전에 계좌마다 토스 응답을 확인한다. 빈 배열이면 믿을 수 있다.
 * 매입금액 요약은 계좌마다 통화별(원화 = 한국 종목, 달러 = 미국 종목 — 원화 장부 보정과 같은 뜻)이라 그 시장 통화 칸과 맞춰 본다.
 * @param prevAccounts 직전 ok 스냅샷의 계좌 순번 (없으면 빈 배열)
 */
export function snapshotDoubts(market: RecordMarket, accounts: AccountHoldings[], prevAccounts: readonly number[] = []): SnapshotDoubt[] {
  const out: SnapshotDoubt[] = [];
  const name = MARKET_NAME[market];
  const cur = market === "KR" ? "KRW" : "USD";
  const listed = new Set(accounts.map((a) => a.account));
  for (const acct of [...new Set(prevAccounts)].sort((x, y) => x - y)) {
    if (!listed.has(acct)) out.push({ kind: "missing-account", account: acct, text: `계좌 ${acct}: 직전 스냅샷에 있던 계좌가 토스 계좌 목록에서 빠짐` });
  }
  for (const a of accounts) {
    const held = a.items.filter((h) => h.quantity > 0);
    const mine = held.filter((h) => marketOf(h.code) === market);
    const summary = market === "KR" ? a.overview.purchaseKrw : a.overview.purchaseUsd;
    if (mine.length === 0) {
      if (summary !== null && summary !== 0) {
        out.push({ kind: "empty", account: a.account, text: `계좌 ${a.account}: ${name} 보유 목록이 비었는데 계좌 요약 매입금액은 ${money(summary, cur)}` });
      } else if (held.length === 0 && a.overview.purchaseUsd === null) {
        // 목록이 통째로 비었고 달러 요약도 없다: 요약이 빠진 일시 오류와 전부 판 빈 계좌를 가릴 수 없다 (원화 요약은 없으면 0 으로 읽힌다).
        // 목록에 다른 시장 종목이 있는 계좌의 달러 요약 빈칸은 '달러 종목 없음'으로 본다 (토스 동기화와 같은 기준)
        out.push({ kind: "unsure", account: a.account, text: `계좌 ${a.account}: 보유 목록이 비었고 요약의 달러 매입금액이 없어 빈 계좌인지 확인할 수 없음` });
      }
      continue;
    }
    if (summary === null) continue;
    const sameCur = held.filter((h) => h.currency === cur);
    if (sameCur.some((h) => h.purchaseAmount === null || h.purchaseAmount === undefined)) continue; // 종목 매입금액을 모르면 맞춰 볼 수 없다
    const sum = sameCur.reduce((s, h) => s + (h.purchaseAmount ?? 0), 0);
    if (Math.abs(sum - summary) > Math.max(SUM_TOLERANCE[cur], Math.abs(summary) * SUM_TOLERANCE.rel)) {
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
}

export interface TradeLite {
  account: number;
  code: string;
  side: "BUY" | "SELL";
  quantity: number;
  executedAt: string;
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

/**
 * 같은 시장의 이어진 두 ok 스냅샷 사이 (계좌, 종목) 수량 변화에서, 그 사이(앞 스냅샷 시각 초과 ~ 뒤 스냅샷 시각 이하) 체결로 설명되지 않는 몫만 '추정' 한 줄로.
 * 부분 체결은 마지막 체결 시각에 한 번에 들어가므로 경계에서 틀릴 수 있다 — 그래서 추정이다
 */
export function unexplainedChanges(snapshots: SnapshotLite[], trades: TradeLite[]): EstimatedChange[] {
  const out: EstimatedChange[] = [];
  const byMarket = new Map<RecordMarket, SnapshotLite[]>();
  for (const s of snapshots) byMarket.set(s.market, [...(byMarket.get(s.market) ?? []), s]);
  for (const [market, list] of byMarket) {
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) {
      const s1 = sorted[i - 1]!, s2 = sorted[i]!;
      const t1 = Date.parse(s1.asOf), t2 = Date.parse(s2.asOf);
      const key = (a: number, c: string) => `${a}|${c}`;
      const q1 = new Map(s1.holdings.map((h) => [key(h.account, h.code), h]));
      const q2 = new Map(s2.holdings.map((h) => [key(h.account, h.code), h]));
      const keys = [...new Set([...q1.keys(), ...q2.keys()])];
      for (const k of keys) {
        const [accountStr, code] = k.split("|") as [string, string];
        const account = Number(accountStr);
        const a = q1.get(k), b = q2.get(k);
        const fromQty = a?.quantity ?? 0, toQty = b?.quantity ?? 0;
        const traded = trades
          .filter((t) => t.account === account && t.code === code)
          .filter((t) => {
            const at = Date.parse(t.executedAt);
            return at > t1 && at <= t2;
          })
          .reduce((sum, t) => sum + (t.side === "BUY" ? t.quantity : -t.quantity), 0);
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
  return out.sort((x, y) => (x.toDate < y.toDate ? -1 : x.toDate > y.toDate ? 1 : x.market < y.market ? -1 : x.market > y.market ? 1 : x.code < y.code ? -1 : x.code > y.code ? 1 : x.account - y.account));
}
