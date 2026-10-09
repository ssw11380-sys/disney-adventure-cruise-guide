import type { Db } from "../db/index.js";
import { AppError } from "../lib/errors.js";
import { seoulDate, seoulDateOf, seoulIso } from "../lib/time.js";
import type { DailyRate } from "../providers/market/fxStd.js";
import type { FeatureKey } from "./featureService.js";
import { DOUBT_DAYS, replayPair, round6, roundMoney, tossCosts, type ArrivalSpan, type ChangeRow, type Cur, type LedgerAnchor, type LedgerFill, type PairResult, type Realized } from "./journalCalc.js";
import { periodReturns, presetRange, READY_DAYS, type Preset, type RetFlow, type RetSkip, type RetSnap, type ReturnsBody, type ReturnsMarket } from "./journalReturns.js";
import { tradingDate } from "./marketContext.js";
import { isKrBankDay, taxSummary, TAX_RULES, usSettleDate, type TaxFx, type TaxSellInput } from "./taxRules.js";
import { addDays, marketOf, type RecordMarket, type SnapshotHolding } from "./tradeRecordCalc.js";
import { parseData, STATE_KEY, tradeView, type TradeRow, type TradeView } from "./tradeRecordService.js";

/**
 * 매매일지 (3-37, 플래그 tradeJournal — tradeRecords 가 꺼져 있으면 꺼진 것으로 봄). 3-36 이 쌓은 원자료(일별 계좌 스냅샷 + 토스 주문 내역의 체결)로
 *  1) 기록: 날짜별 체결 목록, 매도마다 이동평균법 실현손익(journalCalc), 거래마다 메모(trade_notes — 서버에 저장, 백업 포함, AI 에는 넣지 않음).
 *     그해 그 종목에 기록으로 설명되지 않는 일이 있으면 그해 그 종목의 매도는 손익 없이 '확인이 필요한 매도'(summary.excludedSells)로 따로 (검토 반영 10차 종목·해 규칙 — journalCalc)
 *  2) 수익률: 스냅샷 시간가중 수익률(journalReturns — 10거래일 쌓인 뒤 숫자). 확인 필요인 종목·해의 구간과 주문 없이 들어온 종목의 앞 30일은 건너뜀
 *  3) 양도세 추정 (하위 플래그 journalTax — 기본 끔): 해외주식 결제일 기준환율 원화 양도차익 · 22% · 250만 원 공제(taxRules — 참고용 추정)
 * 계산은 저장하지 않고 요청 때 돌린다. 요청은 네트워크를 기다리지 않는다 — 환율(토스 과거 환율·세법 기준환율)은 fx_rates 에 있는 값만 쓰고,
 * 없는 값은 배경 작업(10분마다, 플래그가 켜져 있을 때만)이 받는다.
 * 토스와 1원까지 맞는지는 사용자 표본 5건으로 확인하기 전이라 '(추정)' 꼬리표를 둔다 (TOSS_VERIFIED)
 */

/** 표본 대조가 끝난 항목만 true 로 바꾸는 작은 PR 을 따로 낸다 (그 항목의 '(추정)'이 사라짐). headline: 큰 숫자가 비용 빼기 전(gross)·뒤(net) */
export const TOSS_VERIFIED = { krRealized: false, usRealizedUsd: false, usRealizedKrw: false, headline: "gross" as "gross" | "net" };

export class JournalOffError extends AppError {
  constructor() {
    super(409, "FEATURE_OFF", "매매일지(tradeJournal)가 꺼져 있습니다");
  }
}

export interface JournalFxSources {
  /** 토스 과거 매수 환율 (그 분). 실패하면 던진다 */
  tossAt?: ((iso: string) => Promise<number>) | null;
  /** 서울외국환중개 매매기준율 (기간). 실패하면 던진다 */
  std?: ((from: string, to: string) => Promise<DailyRate[]>) | null;
  /** 하나은행 고시 일별 종가 (네이버, 최근 1년) — 매매기준율 대신·교차 확인 */
  naver?: (() => Promise<DailyRate[]>) | null;
}

export interface JournalDeps {
  db: Db;
  features: { enabled(key: FeatureKey): Promise<boolean> };
  fx?: JournalFxSources | null;
  now?: () => Date;
  log?: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
  /** 배경 환율 받기 간격 (기본 10분) · 서버를 켠 뒤 첫 확인 (기본 2분) · 토스 요청 사이 (기본 350ms — MARKET_INFO 초당 3회) */
  tickMs?: number;
  startupDelayMs?: number;
  pauseMs?: number;
}

export interface JournalItem {
  key: string;
  /** fill = 체결 몫, change = 주문 내역으로 설명되지 않은 변화·큰 주가 변화 (그해 그 종목의 매도 손익·수익률 계산에서 뺌) */
  kind: "fill" | "change";
  account: number;
  accountLabel: string | null;
  orderId: string | null;
  code: string;
  name: string;
  market: RecordMarket;
  currency: Cur;
  side: "BUY" | "SELL" | null;
  quantity: number;
  orderQuantity: number;
  amount: number;
  price: number | null;
  at: string;
  timeBasis: "filled" | "ordered" | "seen";
  status: "CLOSED" | "OPEN";
  part: { index: number; count: number } | null;
  realized: Realized | null;
  afterBuy?: { avgCost: number; quantity: number } | null;
  note: string | null;
  /** kind 'change': 무엇이 달라졌는지 · 비율 짐작 이름표(숫자에 쓰지 않음) · 설명되지 않는 수량(뒤 기록 − 기록대로 돌린 수량) */
  change?: { kind: ChangeRow["kind"]; text: string; guess: string | null; qty: number };
}

/** 확인이 필요한 매도 (그해 그 종목에 기록으로 설명되지 않는 일이 있음 — 손익 숫자 없음) */
export interface ExcludedSell {
  key: string;
  code: string;
  name: string;
  date: string;
  quantity: number;
  currency: Cur;
  reason: string;
  change: string | null;
  guess: string | null;
}

export interface RealizedSum {
  KRW: number | null;
  USD: number | null;
  krwTotal: number | null;
  krwTotalEstimated: boolean;
}

export interface StockJournalHead {
  code: string;
  name: string;
  market: RecordMarket;
  holding: { quantity: number; avgCost: number | null; currency: Cur; asOf: string } | null;
  orders: number;
  buys: number;
  sells: number;
  realized: { amount: number | null; currency: Cur; sells: number; unknown: number };
  firstTrade: string | null;
  lastTrade: string | null;
  recordSince: string | null;
  memo: string | null;
}

/** 메모 한 건의 최대 글자 수 */
export const NOTE_MAX = 200;
/** 세법 기준환율: 받기를 이만큼 해 봐도 없으면 '받지 못함' (그 전까지는 '받는 중') */
const STD_MAX_TRIES = 3;
/** 결제일에 고시가 없을 때 직전 고시를 찾아볼 날 수 */
const PRIOR_DAYS = 10;
/**
 * 매매기준율 줄 사이에 고시가 빠져도 '고시가 없는 날'(목록에 없는 휴일 등)로 볼 은행 영업일 수. 이보다 길게 비면 응답이 모자란 것
 * (한 해 조각이 비었거나 줄이 끊김)으로 보고 받아 본 기간에서 빼 다시 받는다 — 그 날을 오래된 고시로 메우지 않는다
 */
export const STD_GAP_DAYS = 3;
/** 한 번에 받을 토스 과거 환율 수 */
const TOSS_BATCH = 200;
const FX_STATE_KEY = "journal_fx_state";

interface FxState {
  /** 매매기준율을 받아 본 기간 (그 안에 줄이 없는 날은 고시가 없는 날) */
  stdCovered: Array<[string, string]>;
  /** 날짜(또는 '분 시각') → 받기를 해 본 횟수·마지막 시각 */
  tries: Record<string, { n: number; last: string }>;
}

interface SnapLite {
  id: number;
  date: string;
  market: RecordMarket;
  status: "ok" | "gap";
  asOf: string;
  accounts: number[];
  doubtAccounts: number[];
  holdings: SnapshotHolding[];
  fx: number | null;
}

type TradeFull = TradeView & { costs: { fee: number | null; tax: number | null } | null; raw: Record<string, unknown> | null };

interface PairData {
  account: number;
  code: string;
  market: RecordMarket;
  currency: Cur;
  trades: TradeFull[];
  fills: LedgerFill[];
  res: PairResult;
}

const pairKey = (account: number, code: string) => `${account}:${code}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 분 단위 한국 시간 ISO (토스 과거 환율의 키) */
export const minuteKey = (iso: string) => seoulIso(new Date(Math.floor(Date.parse(iso) / 60_000) * 60_000));
const sumRounded = (xs: number[], cur: Cur) => roundMoney(xs.reduce((s, x) => s + x, 0), cur);

export class JournalService {
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  /** 파싱한 스냅샷 (id → 고친 시각·값) — 요청마다 JSON 을 다시 읽지 않게 */
  private readonly snapCache = new Map<number, { updatedAt: string; snap: SnapLite }>();

  constructor(private readonly deps: JournalDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async enabled(): Promise<boolean> {
    return (await this.deps.features.enabled("tradeJournal")) && (await this.deps.features.enabled("tradeRecords"));
  }

  /** 양도세 추정 (하위 플래그 journalTax — 기본 끔): 매매일지가 켜져 있고 journalTax 도 켜져 있을 때만. 끄면 /api/journal/tax 빈 값·매매기준율 받기 0건 */
  async taxEnabled(): Promise<boolean> {
    return (await this.enabled()) && (await this.deps.features.enabled("journalTax"));
  }

  // ── 읽기 ─────────────────────────────────────────────────────────────

  private async snapshots(): Promise<SnapLite[]> {
    const db = this.deps.db;
    const rows = await db.selectFrom("account_snapshots").select(["id", "snapshot_date", "market", "status", "as_of", "updated_at"]).orderBy("as_of").execute();
    const need = rows.filter((r) => r.status === "ok" && this.snapCache.get(Number(r.id))?.updatedAt !== r.updated_at).map((r) => Number(r.id));
    for (let i = 0; i < need.length; i += 200) {
      const part = await db.selectFrom("account_snapshots").select(["id", "data", "updated_at"]).where("id", "in", need.slice(i, i + 200)).execute();
      for (const p of part) {
        const d = parseData(p.data);
        const row = rows.find((r) => Number(r.id) === Number(p.id))!;
        this.snapCache.set(Number(p.id), {
          updatedAt: p.updated_at,
          snap: {
            id: Number(p.id),
            date: row.snapshot_date,
            market: row.market as RecordMarket,
            status: "ok",
            asOf: row.as_of,
            accounts: (d?.accounts ?? []).map((a) => Number(a.account)).filter((n) => Number.isFinite(n)),
            doubtAccounts: (d?.doubts ?? []).map((x) => Number(x.account)),
            holdings: (d?.holdings ?? []).map((h) => ({ ...h, account: Number(h.account), quantity: Number(h.quantity) })),
            fx: d?.fx?.usdKrw ?? null,
          },
        });
      }
    }
    return rows.map((r) =>
      r.status === "ok" && this.snapCache.get(Number(r.id))
        ? this.snapCache.get(Number(r.id))!.snap
        : { id: Number(r.id), date: r.snapshot_date, market: r.market as RecordMarket, status: "gap" as const, asOf: r.as_of, accounts: [], doubtAccounts: [], holdings: [], fx: null },
    );
  }

  /** 모든 종목의 체결 (종목을 골라도 모두 — 같은 계좌에 주문 없이 들어온 다른 종목을 가리려고 원장이 다른 종목의 체결도 본다) */
  private async trades(): Promise<TradeFull[]> {
    const rows = await this.deps.db.selectFrom("trade_executions").selectAll().orderBy("executed_at").orderBy("id").execute();
    return rows.map((r) => {
      let raw: Record<string, unknown> | null = null;
      try {
        const v = JSON.parse(r.raw) as unknown;
        raw = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
      } catch {
        raw = null;
      }
      const col = r.fee !== null || r.tax !== null ? { fee: r.fee === null ? null : Number(r.fee), tax: r.tax === null ? null : Number(r.tax) } : null;
      return { ...tradeView(r as unknown as TradeRow), costs: col ?? tossCosts(raw), raw };
    });
  }

  private async tossRates(): Promise<Map<string, number>> {
    const rows = await this.deps.db.selectFrom("fx_rates").select(["at", "rate"]).where("kind", "=", "toss-usdkrw").execute();
    return new Map(rows.map((r) => [r.at, Number(r.rate)]));
  }

  private async names(codes: string[], snaps: SnapLite[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!codes.length) return out;
    for (const r of await this.deps.db.selectFrom("registered_stocks").select(["code", "name"]).where("code", "in", codes).execute()) if (r.name) out.set(r.code, r.name);
    for (let i = snaps.length - 1; i >= 0; i--) for (const h of snaps[i]!.holdings) if (!out.has(h.code) && h.name && h.name !== h.code) out.set(h.code, h.name);
    const left = codes.filter((c) => !out.has(c));
    if (left.length) for (const r of await this.deps.db.selectFrom("listed_stocks").select(["code", "name"]).where("code", "in", left).execute()) if (r.name) out.set(r.code, r.name);
    for (const c of codes) if (!out.has(c)) out.set(c, c);
    return out;
  }

  private async notes(): Promise<Map<string, string>> {
    const rows = await this.deps.db.selectFrom("trade_notes").select(["account", "order_id", "note"]).execute();
    return new Map(rows.map((r) => [`${Number(r.account)}:${r.order_id}`, r.note]));
  }

  private async recordSince(): Promise<string | null> {
    const r = await this.deps.db.selectFrom("account_snapshots").select((eb) => eb.fn.min("snapshot_date").as("since")).executeTakeFirst();
    return (r?.since as string | null | undefined) ?? null;
  }

  /**
   * 짝마다 원장: 체결이 있는 짝 + 스냅샷에만 나온 짝(주문 내역에 없는 수량 변화 추정 줄을 보이려고). code 를 주면 그 종목만.
   * stdAt 을 주면 해외 양도세용 결제일 원화도. trades 는 늘 모든 종목 (같은 계좌에 주문 없이 들어온 다른 종목을 보려고 — arrivals)
   */
  private pairs(trades: TradeFull[], snaps: SnapLite[], toss: Map<string, number>, stdAt?: (f: LedgerFill) => number | null, code?: string): Map<string, PairData> {
    const arrived = arrivals(trades, snaps);
    const groups = new Map<string, { account: number; code: string; list: TradeFull[] }>();
    for (const t of trades) {
      if (code && t.code !== code) continue;
      const k = pairKey(t.account, t.code);
      const g = groups.get(k) ?? { account: t.account, code: t.code, list: [] };
      g.list.push(t);
      groups.set(k, g);
    }
    for (const s of snaps) for (const h of s.holdings) if ((!code || h.code === code) && !groups.has(pairKey(h.account, h.code))) groups.set(pairKey(h.account, h.code), { account: h.account, code: h.code, list: [] });
    const out = new Map<string, PairData>();
    for (const [key, { account, code, list }] of groups) {
      const market = marketOf(code);
      const currency: Cur = market === "KR" ? "KRW" : "USD";
      const fills: LedgerFill[] = [];
      for (const t of list) {
        t.fills.forEach((f, i) => {
          if (!(f.quantity > 0)) return;
          fills.push({
            key: `${t.account}:${t.orderId}:${i}`,
            account: t.account,
            orderId: t.orderId,
            code,
            side: t.side,
            quantity: f.quantity,
            amount: f.amount,
            at: f.at,
            basis: f.basis,
            orderQuantity: t.quantity,
            orderCosts: t.costs,
            seq: t.id * 1000 + i,
          });
        });
      }
      const anchors = this.anchorsFor(account, code, market, snaps);
      // ④ 같은 계좌·시장에 주문 없이 들어온 다른 종목
      const others = (arrived.get(`${account}:${market}`) ?? []).filter((x) => x.code !== code).map(({ from, to }) => ({ from, to }));
      const res = replayPair(fills, anchors, {
        currency,
        ...(currency === "USD" ? { fxAt: (at: string) => toss.get(minuteKey(at)) ?? null } : {}),
        ...(stdAt && currency === "USD" ? { stdAt } : {}),
        arrivals: others,
      });
      out.set(key, { account, code, market, currency, trades: list, fills, res });
    }
    return out;
  }

  /** 기준점: 그 계좌가 목록에 있고 그 계좌를 의심하지 않은 그 시장 ok 스냅샷 (그 종목이 없으면 0주) */
  private anchorsFor(account: number, code: string, market: RecordMarket, snaps: SnapLite[]): LedgerAnchor[] {
    const out: LedgerAnchor[] = [];
    for (const s of snaps) {
      if (!anchorSnap(s, account, market)) continue;
      const h = s.holdings.find((x) => x.account === account && x.code === code && x.quantity > 0);
      const cost = h ? (h.purchaseAmount ?? (h.avgPrice !== null ? h.avgPrice * h.quantity : null)) : 0;
      const ratio = h && h.marketValue && h.marketValueAfterCost !== null && h.marketValue > 0 ? Math.max(0, 1 - h.marketValueAfterCost / h.marketValue) : null;
      // 한 주 가격: 정규장 종가, 없으면 그때 현재가 (회사 행동 뒤 전부 판 경우 판 가격과 맞춰 본다)
      const px = h ? (h.regularClose ?? h.price) : null;
      out.push({
        asOf: s.asOf,
        date: s.date,
        quantity: h ? round6(h.quantity) : 0,
        cost,
        costKrw: market === "US" ? (h ? h.costKrw : 0) : null,
        costKrwEstimated: h?.costKrwSource === "book-estimated",
        costRatio: ratio,
        price: px !== null && px !== undefined && Number.isFinite(px) && px > 0 ? px : null,
      });
    }
    return out;
  }

  // ── 기록 ─────────────────────────────────────────────────────────────

  async journal(q: { from: string; to: string; code?: string }) {
    const [snaps, trades, toss, notes, since] = await Promise.all([this.snapshots(), this.trades(), this.tossRates(), this.notes(), this.recordSince()]);
    const pairs = this.pairs(trades, snaps, toss, undefined, q.code);
    const accounts = new Set((await this.deps.db.selectFrom("trade_executions").select("account").groupBy("account").execute()).map((r) => Number(r.account)));
    const codes = [...new Set([...pairs.values()].map((p) => p.code))];
    const names = await this.names(codes, snaps);
    const items = this.items(pairs, names, notes, accounts.size > 1).filter((x) => {
      const d = seoulDateOf(x.at);
      return d >= q.from && d <= q.to;
    });
    const fills = items.filter((x) => x.kind === "fill");
    const orderKey = (x: JournalItem) => `${x.account}:${x.orderId}`;
    const orderSet = (side?: "BUY" | "SELL") => new Set(fills.filter((x) => !side || x.side === side).map(orderKey)).size;
    const sells = fills.filter((x) => x.side === "SELL");
    // 날짜별 (새것부터), 날짜 안에서는 시각이 늦은 것부터
    const byDay = new Map<string, JournalItem[]>();
    for (const x of items) byDay.set(seoulDateOf(x.at), [...(byDay.get(seoulDateOf(x.at)) ?? []), x]);
    const days = [...byDay]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, list]) => ({
        date,
        realized: realizedSum(list.filter((x) => x.side === "SELL")),
        items: list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.key < b.key ? 1 : -1)),
      }));
    // 종목 고르기 목록: 종목을 골랐어도 기간 안 체결이 있는 모든 종목 (고른 종목에서 다른 종목으로 바로 바꿀 수 있게)
    const stockCount = new Map<string, Set<string>>();
    for (const t of trades) {
      if (!t.fills.some((f) => f.quantity > 0 && seoulDateOf(f.at) >= q.from && seoulDateOf(f.at) <= q.to)) continue;
      stockCount.set(t.code, (stockCount.get(t.code) ?? new Set()).add(`${t.account}:${t.orderId}`));
    }
    const stockNames = q.code ? await this.names([...stockCount.keys()], snaps) : names;
    const truncated = await this.truncatedCodes();
    const head = q.code ? await this.stockHead(q.code, pairs, names, snaps, since) : undefined;
    return {
      enabled: true as const,
      from: q.from,
      to: q.to,
      code: q.code ?? null,
      recordSince: since,
      verified: TOSS_VERIFIED,
      summary: {
        // 목록 건수 = 기간 안에 몫이 있는 주문 수 (며칠에 나뉜 주문도 1건) = 저장한 체결 건수 (완료 기준 3)
        orders: orderSet(),
        buys: orderSet("BUY"),
        sells: orderSet("SELL"),
        realized: { ...realizedSum(sells), estimatedIncluded: sells.some((x) => x.realized?.status === "order-uncertain") },
        costs: {
          toss: sells.filter((x) => x.realized?.costs.source === "toss").length,
          estimated: sells.filter((x) => x.realized?.costs.source === "estimated").length,
          none: sells.filter((x) => !x.realized?.costs.source).length,
        },
        unknownSells: sells.filter((x) => x.realized?.status === "unknown-cost").length,
        // 확인이 필요한 매도 (그해 그 종목에 기록으로 설명되지 않는 일이 있음): 합계에서 빼고 까닭·그해 있었던 일과 함께 따로 (새것부터)
        excludedSells: sells
          .filter((x) => x.realized?.status === "unexplained")
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.key < b.key ? 1 : -1))
          .map(
            (x): ExcludedSell => ({
              key: x.key,
              code: x.code,
              name: x.name,
              date: seoulDateOf(x.at),
              quantity: x.quantity,
              currency: x.currency,
              reason: x.realized!.reason ?? "",
              change: x.realized!.change ?? null,
              guess: x.realized!.guess ?? null,
            }),
          ),
        truncated: truncated.filter((c) => codes.includes(c)),
      },
      days,
      stocks: [...stockCount].map(([code, set]) => ({ code, name: stockNames.get(code) ?? code, count: set.size })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1)),
      ...(head ? { head } : {}),
    };
  }

  private items(pairs: Map<string, PairData>, names: Map<string, string>, notes: Map<string, string>, multi: boolean): JournalItem[] {
    const out: JournalItem[] = [];
    for (const p of pairs.values()) {
      const name = names.get(p.code) ?? p.code;
      for (const t of p.trades) {
        const live = t.fills.filter((f) => f.quantity > 0);
        t.fills.forEach((f, i) => {
          if (!(f.quantity > 0)) return;
          const key = `${t.account}:${t.orderId}:${i}`;
          const r = p.res.fills.get(key);
          const realized = t.side === "SELL" ? verifiedTag(r?.realized ?? null, p.currency) : null;
          out.push({
            key,
            kind: "fill",
            account: t.account,
            accountLabel: multi ? `계좌 ${t.account}` : null,
            orderId: t.orderId,
            code: p.code,
            name,
            market: p.market,
            currency: p.currency,
            side: t.side,
            quantity: f.quantity,
            orderQuantity: t.quantity,
            amount: f.amount,
            price: f.quantity > 0 ? Math.round((f.amount / f.quantity) * 1e4) / 1e4 : null,
            at: f.at,
            timeBasis: f.basis,
            status: t.status,
            part: live.length > 1 ? { index: live.indexOf(f) + 1, count: live.length } : null,
            realized,
            ...(t.side === "BUY" ? { afterBuy: r?.afterBuy ?? null } : {}),
            note: notes.get(`${t.account}:${t.orderId}`) ?? null,
          });
        });
      }
      for (const e of p.res.changes) {
        // 기록마다 한 줄 (구간 끝 기록 — 짝 안에서 겹치지 않음)
        const qty = round6(e.toQty - e.expectedQty);
        out.push({
          key: `chg:${p.account}:${p.code}:${e.at}`,
          kind: "change",
          account: p.account,
          accountLabel: multi ? `계좌 ${p.account}` : null,
          orderId: null,
          code: p.code,
          name,
          market: p.market,
          currency: p.currency,
          side: null,
          quantity: Math.abs(qty),
          orderQuantity: 0,
          amount: 0,
          price: null,
          at: e.at,
          timeBasis: "seen",
          status: "CLOSED",
          part: null,
          realized: null,
          note: null,
          change: { kind: e.kind, text: e.text, guess: e.guess, qty },
        });
      }
    }
    return out;
  }

  private async truncatedCodes(): Promise<string[]> {
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", STATE_KEY).executeTakeFirst();
    try {
      const v = row ? (JSON.parse(row.value) as { truncated?: Record<string, unknown> }) : null;
      return Object.keys(v?.truncated ?? {}).sort();
    } catch {
      return [];
    }
  }

  private async stockHead(code: string, pairs: Map<string, PairData>, names: Map<string, string>, snaps: SnapLite[], since: string | null): Promise<StockJournalHead> {
    const market = marketOf(code);
    const currency: Cur = market === "KR" ? "KRW" : "USD";
    const mine = [...pairs.values()].filter((p) => p.code === code);
    const last = [...snaps].reverse().find((s) => s.status === "ok" && s.market === market);
    const held = last ? last.holdings.filter((h) => h.code === code && h.quantity > 0) : [];
    const qty = round6(held.reduce((s, h) => s + h.quantity, 0));
    const cost = held.every((h) => h.purchaseAmount !== null || h.avgPrice !== null) ? held.reduce((s, h) => s + (h.purchaseAmount ?? (h.avgPrice ?? 0) * h.quantity), 0) : null;
    const trades = mine.flatMap((p) => p.trades);
    const sells = mine.flatMap((p) => p.fills.filter((f) => f.side === "SELL").map((f) => p.res.fills.get(f.key)?.realized ?? null));
    const known = sells.filter((r): r is Realized => !!r && r.status !== "unknown-cost" && r.status !== "unexplained" && r.gross !== null);
    const dates = trades.flatMap((t) => t.fills.map((f) => seoulDateOf(f.at))).sort();
    const memo = (await this.deps.db.selectFrom("registered_stocks").select("memo").where("code", "=", code).executeTakeFirst())?.memo ?? null;
    return {
      code,
      name: names.get(code) ?? (held[0]?.name || code),
      market,
      holding: qty > 0 && last ? { quantity: qty, avgCost: cost !== null && qty > 0 ? Math.round((cost / qty) * 1e4) / 1e4 : null, currency, asOf: last.asOf } : null,
      orders: new Set(trades.map((t) => `${t.account}:${t.orderId}`)).size,
      buys: new Set(trades.filter((t) => t.side === "BUY").map((t) => `${t.account}:${t.orderId}`)).size,
      sells: new Set(trades.filter((t) => t.side === "SELL").map((t) => `${t.account}:${t.orderId}`)).size,
      realized: { amount: known.length ? sumRounded(known.map((r) => r.gross!), currency) : null, currency, sells: known.length, unknown: sells.length - known.length },
      firstTrade: dates[0] ?? null,
      lastTrade: dates.at(-1) ?? null,
      recordSince: since,
      memo: memo && memo.trim() ? memo : null,
    };
  }

  /** 종목 상세 '매매 기록' 칸 · 이 종목 머리 카드 */
  async stock(code: string): Promise<StockJournalHead> {
    const [snaps, trades, toss, since] = await Promise.all([this.snapshots(), this.trades(), this.tossRates(), this.recordSince()]);
    const pairs = this.pairs(trades, snaps, toss, undefined, code);
    const names = await this.names([code], snaps);
    return this.stockHead(code, pairs, names, snaps, since);
  }

  // ── 메모 ─────────────────────────────────────────────────────────────

  /** 거래 메모 저장 (빈 글 → 지움). 200자 넘음·제어 문자만 → 400, 그 (계좌, 주문번호) 체결 없음 → 404 */
  async saveNote(account: number, orderId: string, text: string): Promise<{ account: number; orderId: string; note: string | null; updatedAt: string }> {
    const clean = cleanNote(text);
    if (clean === null) throw new AppError(400, "VALIDATION", "메모에 쓸 수 있는 글자가 없습니다");
    if ([...clean].length > NOTE_MAX) throw new AppError(400, "VALIDATION", `메모는 ${NOTE_MAX}자까지입니다`);
    const db = this.deps.db;
    const exists = await db.selectFrom("trade_executions").select("id").where("account", "=", account).where("order_id", "=", orderId).executeTakeFirst();
    if (!exists) throw new AppError(404, "NOT_FOUND", "그 주문의 체결 기록이 없습니다");
    const iso = seoulIso(this.now());
    if (clean === "") {
      await db.deleteFrom("trade_notes").where("account", "=", account).where("order_id", "=", orderId).execute();
      return { account, orderId, note: null, updatedAt: iso };
    }
    await db
      .insertInto("trade_notes")
      .values({ account, order_id: orderId, note: clean, created_at: iso, updated_at: iso })
      .onConflict((oc) => oc.columns(["account", "order_id"]).doUpdateSet({ note: clean, updated_at: iso }))
      .execute();
    return { account, orderId, note: clean, updatedAt: iso };
  }

  // ── 수익률 ───────────────────────────────────────────────────────────

  async returns(q: { preset: Preset; from?: string; to?: string; market: ReturnsMarket }): Promise<ReturnsBody & { enabled: true; recordSince: string | null }> {
    const today = seoulDate(this.now());
    const requested = q.preset === "custom" ? { from: q.from!, to: q.to! } : presetRange(q.preset, today);
    const [snaps, trades, toss, since] = await Promise.all([this.snapshots(), this.trades(), this.tossRates(), this.recordSince()]);
    const flows: RetFlow[] = [];
    for (const t of trades) for (const f of t.fills) if (f.quantity > 0) flows.push({ market: t.market, side: t.side, amount: f.amount, at: f.at });
    // 건너뛸 구간 (값을 매겨 흐름으로 넣지 않는다):
    //  ① 짝마다 확인 필요인 해(검토 반영 10차 종목·해 규칙)에 걸친, 그 종목이 든 기록 구간
    //  ② 주문 없이 들어온 종목의 앞 30일 (검토 반영 11차 — ④를 수익률에: 분사 신설회사가 며칠 늦게 들어와도 모회사가 내린 권리락 날이 이 안에 있다.
    //     모회사가 수량·매입금액 그대로 계속 있으면 모회사 쪽에는 확인 필요가 없어서. 기록 사이에 들어온 것만 — 첫 기록 전 증거는 그 앞에 수익률 구간이 없음)
    //  ③ 계좌 목록이 바뀐 기록 사이 (새 계좌가 기록에 들어오거나 빠지면 평가금액이 흐름 없이 뛴다)
    const skips: RetSkip[] = [];
    for (const p of this.pairs(trades, snaps, toss).values()) for (const x of p.res.skips) skips.push({ market: p.market, ...x });
    for (const [key, list] of arrivals(trades, snaps)) {
      const market = key.slice(key.indexOf(":") + 1) as RecordMarket;
      for (const x of list) if (x.from !== null) skips.push({ market, from: seoulIso(new Date(Date.parse(x.from) - DOUBT_DAYS * 86_400_000)), to: x.to });
    }
    for (const market of ["KR", "US"] as const) {
      const list = snaps.filter((x) => x.status === "ok" && x.market === market && x.doubtAccounts.length === 0);
      for (let i = 1; i < list.length; i++) {
        const a = [...new Set(list[i - 1]!.accounts)].sort().join(",");
        const b = [...new Set(list[i]!.accounts)].sort().join(",");
        if (a !== b) skips.push({ market, from: list[i - 1]!.asOf, to: list[i]!.asOf });
      }
    }
    const rs: RetSnap[] = snaps.map((s) => ({
      date: s.date,
      market: s.market,
      asOf: s.asOf,
      status: s.status,
      doubted: s.doubtAccounts.length > 0,
      fx: s.fx,
      holdings: s.holdings.map((h) => ({ code: h.code, quantity: h.quantity, price: h.price, regularClose: h.regularClose ?? null })),
    }));
    return { enabled: true, recordSince: since, ...periodReturns({ requested, market: q.market, recordSince: since, skips }, rs, flows) };
  }

  // ── 양도세 추정 ──────────────────────────────────────────────────────

  /** includeUncertain: 순서 모름 매도를 합계에 넣는다 (기본은 빼고 따로 보여 줌 — taxSummary) */
  async tax(year: number, opts: { includeUncertain?: boolean } = {}) {
    const now = this.now();
    const today = seoulDate(now);
    const [snaps, trades, toss, lookup] = await Promise.all([this.snapshots(), this.trades(), this.tossRates(), this.stdLookup(today)]);
    const settle = (f: LedgerFill) => usSettleDate(tradingDate(f.at, false)).kr;
    const pairs = this.pairs(trades, snaps, toss, (f) => {
      const r = lookup(settle(f));
      return typeof r === "object" ? r.rate : null;
    });
    const names = await this.names([...new Set(trades.map((t) => t.code))], snaps);
    const inputs: TaxSellInput[] = [];
    const years = new Set<number>([Number(today.slice(0, 4))]);
    const krSells: Array<{ year: number; order: string; tax: number | null }> = [];
    for (const p of pairs.values()) {
      for (const f of p.fills) {
        if (f.side !== "SELL") continue;
        const r = p.res.fills.get(f.key);
        if (p.market === "KR") {
          krSells.push({ year: Number(seoulDateOf(f.at).slice(0, 4)), order: `${f.account}:${f.orderId}`, tax: r?.realized?.costs.source === "toss" ? r.realized.costs.tax : null });
          continue;
        }
        const tradeDate = tradingDate(f.at, false);
        const settleDate = usSettleDate(tradeDate).kr;
        years.add(Number(settleDate.slice(0, 4)));
        const fx = lookup(settleDate);
        const fxSell: TaxFx | null = typeof fx === "object" ? fx : null;
        const std = r?.std;
        const costsUsd = r?.realized?.costs.source === "toss" ? r.realized.costs.total : null;
        const realized = r?.realized;
        // 확인이 필요한 매도: 숫자 없이 늘 합계에서 빼고 까닭·그해 있었던 일·이름표를 따로 (taxSummary)
        const unexplained = realized?.status === "unexplained";
        const ok = !unexplained && !!std && std.proceeds !== null && std.cost !== null && fxSell !== null;
        // 같은 날 사고판 순서를 몰라 추정한 매도는 기본으로 합계에서 뺀다 (taxSummary)
        const estimate = realized?.status === "order-uncertain" ? { status: "order-uncertain" as const, reason: realized.reason ?? "" } : null;
        // 결제일 환율 대기: 이 매도의 결제일(또는 이 짝 매수의 결제일)이 아직 받는 중
        const pending = !ok && !unexplained && (fx === "pending" || (std?.missing === "fx" && lookupPending(p.fills, settle, lookup)));
        inputs.push({
          key: f.key,
          code: p.code,
          name: names.get(p.code) ?? p.code,
          tradeDate,
          settleDate,
          settleSource: "estimated",
          quantity: f.quantity,
          proceedsUsd: f.amount,
          costsUsd,
          fxSell,
          gainParts: ok ? { proceeds: std!.proceeds!, cost: std!.cost!, costs: costsUsd !== null ? costsUsd * fxSell!.rate : null } : null,
          excluded: unexplained ? "unexplained" : ok ? null : std?.missing === "cost" || std?.missing === "changed" ? std.missing : !std ? "cost" : "fx",
          pending,
          estimate,
          ...(unexplained ? { unexplained: { reason: realized!.reason ?? "", change: realized!.change ?? null, guess: realized!.guess ?? null } } : {}),
        });
      }
    }
    const s = taxSummary(year, inputs, { includeUncertain: opts.includeUncertain === true });
    const kr = krSells.filter((x) => x.year === year);
    const krTaxes = kr.map((x) => x.tax).filter((x): x is number => x !== null);
    return {
      enabled: true as const,
      year,
      years: [...years].sort(),
      rules: TAX_RULES,
      ...s,
      kr: { securitiesTax: { amount: krTaxes.length ? Math.round(krTaxes.reduce((a, b) => a + b, 0)) : null, sells: new Set(kr.map((x) => x.order)).size, source: krTaxes.length ? ("toss" as const) : null } },
      asOf: seoulIso(now),
    };
  }

  /** 결제일 → 매매기준율 (고시가 없는 날은 직전 고시, 결제일 전이면 최근 고시로 잠정) · 'pending'(받는 중) · 'none'(받지 못함) */
  private async stdLookup(today: string): Promise<(date: string) => TaxFx | "pending" | "none"> {
    const rows = (await this.deps.db.selectFrom("fx_rates").select(["at", "rate", "source"]).where("kind", "=", "krw-std").orderBy("at").execute()).map((r) => ({ at: r.at, rate: Number(r.rate), source: r.source }));
    const byDate = new Map(rows.map((r) => [r.at, r]));
    const st = await this.fxState();
    const covered = (d: string) => st.stdCovered.some(([a, b]) => d >= a && d <= b);
    const dates = rows.map((r) => r.at);
    // 직전 고시: 가까운 것만 (priorStd — 오래된 고시로 빈칸을 메우지 않는다)
    const prior = (d: string, inclusive: boolean) => {
      const at = priorStd(dates, d, inclusive);
      return at === null ? null : byDate.get(at)!;
    };
    return (date) => {
      const hit = byDate.get(date);
      if (hit) return { rate: hit.rate, source: hit.source, date, provisional: false };
      if (date > today) {
        // 결제일 전: 오늘까지의 최근 고시로 잠정 (오늘 고시는 아직일 수 있어 오늘은 빈칸으로 세지 않는다)
        const p = byDate.get(today) ?? prior(today, false);
        return p ? { rate: p.rate, source: p.source, date: p.at, provisional: true } : "pending";
      }
      if (covered(date)) {
        const p = prior(date, true);
        if (p) return { rate: p.rate, source: p.source, date: p.at, provisional: false };
        // 받아 본 기간인데 가까운 고시가 없다(예전 모양의 넓은 기간 등) — 받지 못한 날로 센다
      }
      return (st.tries[date]?.n ?? 0) >= STD_MAX_TRIES ? "none" : "pending";
    };
  }

  private async fxState(): Promise<FxState> {
    const row = await this.deps.db.selectFrom("meta").select("value").where("key", "=", FX_STATE_KEY).executeTakeFirst();
    try {
      const v = row ? (JSON.parse(row.value) as Partial<FxState>) : null;
      return {
        stdCovered: Array.isArray(v?.stdCovered) ? v!.stdCovered.filter((x) => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string") : [],
        tries: v?.tries && typeof v.tries === "object" ? v.tries : {},
      };
    } catch {
      return { stdCovered: [], tries: {} };
    }
  }

  private async saveFxState(st: FxState): Promise<void> {
    // 받아 본 기간은 겹치면 합친다
    const merged: Array<[string, string]> = [];
    for (const [a, b] of [...st.stdCovered].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      const last = merged.at(-1);
      if (last && a <= addDays(last[1], 1)) last[1] = b > last[1] ? b : last[1];
      else merged.push([a, b]);
    }
    const value = JSON.stringify({ stdCovered: merged, tries: st.tries });
    await this.deps.db.insertInto("meta").values({ key: FX_STATE_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
  }

  // ── 배경 환율 받기 ───────────────────────────────────────────────────

  /** 10분마다(플래그가 켜져 있을 때만) 없는 환율을 받는다. 서버를 켠 뒤 2분에 첫 확인 */
  start(): void {
    if (this.timer || this.first || !this.deps.fx) return;
    const run = () => void this.tick().catch((e: unknown) => this.deps.log?.warn({ err: errText(e) }, "매매일지: 환율 받기 실패"));
    this.first = setTimeout(() => {
      this.first = null;
      run();
      this.timer = setInterval(run, this.deps.tickMs ?? 10 * 60_000);
      this.timer.unref?.();
    }, this.deps.startupDelayMs ?? 2 * 60_000);
    this.first.unref?.();
  }

  async stop(): Promise<void> {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** 한 번 (겹쳐 부르면 도는 것을 같이 기다린다). 플래그가 꺼져 있으면 아무것도 부르지 않는다 */
  tick(): Promise<void> {
    this.running ??= this.runTick().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runTick(): Promise<void> {
    if (!(await this.enabled()) || !this.deps.fx) return;
    const trades = (await this.trades()).filter((t) => t.market === "US");
    if (!trades.length) return;
    const fills = trades.flatMap((t) => t.fills.filter((f) => f.quantity > 0));
    await this.fetchToss(fills.map((f) => f.at));
    // 결제일 매매기준율은 양도세 추정에만 쓴다 (journalTax 가 꺼져 있으면 받지 않음)
    if (!(await this.taxEnabled())) return;
    const today = seoulDate(this.now());
    const dates = [...new Set(fills.map((f) => usSettleDate(tradingDate(f.at, false)).kr))].filter((d) => d <= today).sort();
    await this.fetchStd(dates);
  }

  /** 관리용: 그 기간 체결의 토스 과거 환율·결제일 매매기준율을 지금 받는다 */
  async prefetch(from: string, to: string): Promise<{ toss: number; std: number }> {
    if (!(await this.enabled())) throw new JournalOffError();
    const trades = (await this.trades()).filter((t) => t.market === "US");
    const fills = trades.flatMap((t) => t.fills.filter((f) => f.quantity > 0 && seoulDateOf(f.at) >= from && seoulDateOf(f.at) <= to));
    const toss = await this.fetchToss(fills.map((f) => f.at));
    if (!(await this.taxEnabled())) return { toss, std: 0 };
    const today = seoulDate(this.now());
    const std = await this.fetchStd([...new Set(fills.map((f) => usSettleDate(tradingDate(f.at, false)).kr))].filter((d) => d <= today).sort());
    return { toss, std };
  }

  private async fetchToss(ats: string[]): Promise<number> {
    const get = this.deps.fx?.tossAt;
    if (!get) return 0;
    const have = await this.tossRates();
    const st = await this.fxState();
    const nowMs = this.now().getTime();
    const want = [...new Set(ats.map(minuteKey))].filter((k) => !have.has(k) && !backoff(st.tries[`t:${k}`], nowMs)).sort().slice(0, TOSS_BATCH);
    let n = 0;
    for (const [i, k] of want.entries()) {
      if (i > 0) await sleep(this.deps.pauseMs ?? 350);
      try {
        const rate = await get(k);
        if (!(rate > 0)) throw new Error("환율 없음");
        await this.deps.db
          .insertInto("fx_rates")
          .values({ kind: "toss-usdkrw", at: k, rate, source: "toss", fetched_at: seoulIso(this.now()) })
          .onConflict((oc) => oc.columns(["kind", "at"]).doNothing())
          .execute();
        delete st.tries[`t:${k}`];
        n++;
      } catch (e) {
        const prev = st.tries[`t:${k}`];
        st.tries[`t:${k}`] = { n: (prev?.n ?? 0) + 1, last: seoulIso(this.now()) };
        this.deps.log?.warn({ at: k, err: errText(e) }, "매매일지: 토스 과거 환율 받기 실패 (다음에 다시)");
      }
    }
    if (want.length) await this.saveFxState(st);
    return n;
  }

  /**
   * 결제일 매매기준율: 서울외국환중개 공개 값을 그 기간 한 번에 받고, 네이버(하나은행 고시) 값과 1% 넘게 다르면 쓰지 않는다.
   * 매매기준율을 받지 못한 날은 네이버 값으로 대신한다('naver-hana'). 받아 본 기간은 '고시가 없는 날'을 가리려고 적는다.
   *  - 기간은 한 해씩 조각내 묻고(조각 하나가 실패해도 나머지는 쓴다), 받아 본 기간(stdCovered)은 **실제로 온 줄 사이**에만 적는다:
   *    줄과 줄 사이에 고시가 빠진 은행 영업일이 STD_GAP_DAYS(3) 이하면 한 구간(그 날은 목록에 없는 휴일 — 직전 고시), 더 길면 끊는다.
   *    그래서 빈 배열(모양 바뀜 · HTTP 200 오류 페이지)·한 해 조각이 빈 응답·중간에 끊긴 응답의 빈 곳은 받아 본 기간이 아니다
   *  - 받아 본 기간 밖 결제일은 네이버(하나은행 고시) 값으로 대신하고, 그것도 없으면 받기 횟수를 올려 다시(1시간·6시간·하루 뒤) 묻는다
   *    — 오래된 고시로 메우지 않는다 (STD_MAX_TRIES 번 뒤 '받지 못함')
   */
  private async fetchStd(dates: string[]): Promise<number> {
    const fx = this.deps.fx;
    if (!fx || !dates.length) return 0;
    const st = await this.fxState();
    const have = new Set((await this.deps.db.selectFrom("fx_rates").select("at").where("kind", "=", "krw-std").execute()).map((r) => r.at));
    const haveList = [...have].sort();
    // 받아 본 기간이어도 가까운 직전 고시가 없으면(예전 모양의 넓은 기간 등) 다시 받는다 — stdLookup 이 '받는 중'에서 멈추지 않게
    const covered = (d: string) => st.stdCovered.some(([a, b]) => d >= a && d <= b) && priorStd(haveList, d, true) !== null;
    const nowMs = this.now().getTime();
    const want = dates.filter((d) => !have.has(d) && !covered(d) && !backoff(st.tries[d], nowMs));
    if (!want.length) return 0;
    const from = want[0]!, to = want.at(-1)!;
    const naver = fx.naver ? await fx.naver().catch((e: unknown) => (this.deps.log?.warn({ err: errText(e) }, "매매일지: 네이버 환율 받기 실패"), [] as DailyRate[])) : [];
    const naverBy = new Map(naver.map((r) => [r.date, r.rate]));
    // 한 해씩 조각내 묻는다 — 조각이 실패하면 그 조각만 빈다 (빈 곳은 아래에서 받아 본 기간으로 적지 않음)
    const got = new Map<string, number>();
    let asked = false;
    if (fx.std) {
      for (const [a, b] of yearChunks(from, to)) {
        try {
          for (const r of await fx.std(a, b)) if (r.date >= a && r.date <= b && r.rate > 0) got.set(r.date, r.rate);
          asked = true;
        } catch (e) {
          this.deps.log?.warn({ from: a, to: b, err: errText(e) }, "매매일지: 매매기준율 받기 실패");
        }
      }
    }
    const iso = seoulIso(this.now());
    const today = seoulDate(this.now());
    // 오늘은 아직 고시 전일 수 있다: 오늘 줄이 없으면 오늘은 '아직'(받기 횟수를 올리지 않고 다음에 다시)
    const dueTo = to < today || got.has(today) ? to : addDays(today, -1);
    const rows = [...got].filter(([d]) => d >= from && d <= dueTo).sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([date, rate]) => ({ date, rate }));
    const bankDays = countDays(from, dueTo, isKrBankDay);
    const spans = coveredSpans(rows.map((r) => r.date));
    if (asked && bankDays > 0 && rows.length * 2 < bankDays) this.deps.log?.warn({ from, to, rows: rows.length, bankDays, spans }, "매매일지: 매매기준율 응답이 비었거나 모자라 받지 못한 것으로 봄 (온 줄 사이만 받아 본 기간)");
    const inSpans = (d: string) => spans.some(([a, b]) => d >= a && d <= b);
    let n = 0;
    const done = new Set<string>();
    const put = async (date: string, rate: number, source: string) => {
      const r = await this.deps.db.insertInto("fx_rates").values({ kind: "krw-std", at: date, rate, source, fetched_at: iso }).onConflict((oc) => oc.columns(["kind", "at"]).doNothing()).executeTakeFirst();
      if (Number(r.numInsertedOrUpdatedRows ?? 0) > 0) n++;
      done.add(date);
    };
    // 받은 줄은 (모자란 응답이어도) 하나은행 고시와 맞으면 쓴다 — 실제 고시 값이다
    for (const r of rows) {
      const nv = naverBy.get(r.date);
      if (nv !== undefined && Math.abs(r.rate - nv) / nv > 0.01) {
        this.deps.log?.warn({ date: r.date, smbs: r.rate, naver: nv }, "매매일지: 매매기준율이 하나은행 고시와 1% 넘게 달라 쓰지 않음");
        continue;
      }
      await put(r.date, r.rate, "smbs");
    }
    st.stdCovered.push(...spans);
    for (const d of want) {
      if (d > dueTo || done.has(d)) continue;
      const nv = naverBy.get(d);
      if (nv !== undefined) await put(d, nv, "naver-hana");
      // 온 줄 사이의 짧은 빈칸인데 줄도 네이버 값도 없음 → 고시가 없는 날(직전 고시). 그 밖은 받지 못함 → 다음에 다시
      else if (inSpans(d)) done.add(d);
      else st.tries[d] = { n: (st.tries[d]?.n ?? 0) + 1, last: iso };
    }
    for (const d of done) delete st.tries[d];
    await this.saveFxState(st);
    if (n) this.deps.log?.info({ n, from, to }, "매매일지: 결제일 기준환율 저장");
    return n;
  }

  /** 관리용 점검: 짝마다 원장 ↔ 스냅샷 대조 · 빠진 환율 */
  async check() {
    if (!(await this.enabled())) return { enabled: false as const };
    const [snaps, trades, toss] = await Promise.all([this.snapshots(), this.trades(), this.tossRates()]);
    const pairs = this.pairs(trades, snaps, toss);
    const today = seoulDate(this.now());
    const tax = await this.taxEnabled();
    const lookup = await this.stdLookup(today);
    const us = trades.filter((t) => t.market === "US").flatMap((t) => t.fills.filter((f) => f.quantity > 0));
    const missingToss = [...new Set(us.map((f) => minuteKey(f.at)))].filter((k) => !toss.has(k));
    // 양도세 추정이 꺼져 있으면 매매기준율을 받지 않으므로 빠진 날로 세지 않는다
    const settleDates = tax ? [...new Set(us.map((f) => usSettleDate(tradingDate(f.at, false)).kr))].sort() : [];
    return {
      enabled: true as const,
      tax,
      pairs: [...pairs.values()].map((p) => ({ account: p.account, code: p.code, ...p.res.check, holding: p.res.holding })),
      fx: {
        tossMissing: missingToss.length,
        stdPending: settleDates.filter((d) => lookup(d) === "pending"),
        stdNone: settleDates.filter((d) => lookup(d) === "none"),
      },
      readyDays: READY_DAYS,
    };
  }
}

/** 원장 기준점이 되는 스냅샷: 그 계좌가 목록에 있고 그 계좌를 의심하지 않은 그 시장 ok 스냅샷 */
const anchorSnap = (s: SnapLite, account: number, market: RecordMarket) => s.status === "ok" && s.market === market && s.accounts.includes(account) && !s.doubtAccounts.includes(account);

/**
 * 주문 없이 들어온 주식 (원장 opts.arrivals — ④ 분사 모양 · 수익률 건너뛰기). `${account}:${market}` → [{ 종목, from, to }] (들어왔을 수 있는 때):
 *  - 같은 계좌·시장의 이웃한 두 기준점 사이: 뒤 기록 수량이 앞 기록 수량 + 그 사이 기록된 순매수보다 많거나(0→N · 수량 늘어남),
 *    앞 기록 수량 + 순매수가 0 보다 작으면(주문 없이 들어와 그 구간에 팔려 기록에 보이지 않음 — 분사 신설회사를 들어온 날 모두 판 경우).
 *    from = 앞 기록 asOf, to = 뒤 기록 asOf (마지막 기준점 뒤는 뒤쪽만 — to null)
 *  - 첫 기준점 전 (검토 반영 11차 — 기준점이 한 번도 없는 계좌·시장은 모든 체결): 0주부터 돌려 산 기록보다 많이 판 매도(to = 그 매도 시각),
 *    첫 기준점 수량이 그 전 순매수보다 많음(to = 첫 기준점 asOf). 들어온 때의 하한은 모른다 (from null — 기록 전 언젠가)
 */
function arrivals(trades: Array<Pick<TradeView, "account" | "code" | "side" | "fills">>, snaps: SnapLite[]): Map<string, Array<ArrivalSpan & { code: string }>> {
  const out = new Map<string, Array<ArrivalSpan & { code: string }>>();
  const add = (key: string, code: string, from: string | null, to: string | null) => out.set(key, [...(out.get(key) ?? []), { code, from, to }]);
  // 계좌·시장마다 체결 몫 (시각 순) — 앞에서부터 한 번씩 훑는다
  const moves = new Map<string, Array<{ code: string; q: number; ms: number; at: string }>>();
  for (const t of trades) {
    const key = `${t.account}:${marketOf(t.code)}`;
    const list = moves.get(key) ?? [];
    for (const f of t.fills) if (f.quantity > 0) list.push({ code: t.code, q: t.side === "BUY" ? f.quantity : -f.quantity, ms: Date.parse(f.at), at: f.at });
    moves.set(key, list);
  }
  for (const list of moves.values()) list.sort((a, b) => a.ms - b.ms);
  const keys = new Set([...moves.keys(), ...snaps.flatMap((s) => s.accounts.map((a) => `${a}:${s.market}`))]);
  for (const key of keys) {
    const account = Number(key.slice(0, key.indexOf(":")));
    const market = key.slice(key.indexOf(":") + 1) as RecordMarket;
    const list = snaps.filter((s) => anchorSnap(s, account, market));
    const mv = moves.get(key) ?? [];
    const qty = (s: SnapLite) => {
      const m = new Map<string, number>();
      for (const h of s.holdings) if (h.account === account && h.quantity > 0) m.set(h.code, (m.get(h.code) ?? 0) + h.quantity);
      return m;
    };
    // 첫 기준점 전: 종목마다 0주부터 돌려, 가장 낮던 수량보다 더 내려간 매도마다 (그 전 언젠가 들어왔다) · 첫 기준점의 남는 수량
    const first = list[0] ?? null;
    const firstMs = first ? Date.parse(first.asOf) : Infinity;
    const run = new Map<string, number>();
    const low = new Map<string, number>();
    let p = 0;
    for (; p < mv.length && mv[p]!.ms <= firstMs; p++) {
      const m = mv[p]!;
      const q = round6((run.get(m.code) ?? 0) + m.q);
      run.set(m.code, q);
      if (q < (low.get(m.code) ?? 0) - 1e-6) {
        low.set(m.code, q);
        add(key, m.code, null, m.at);
      }
    }
    if (first) for (const [code, n] of qty(first)) if (n > Math.max(0, run.get(code) ?? 0) + 1e-6) add(key, code, null, first.asOf);
    // 이웃한 기준점 사이
    for (let i = 0; i < list.length; i++) {
      const prev = list[i]!;
      const cur = list[i + 1] ?? null;
      const from = Date.parse(prev.asOf);
      const to = cur ? Date.parse(cur.asOf) : Infinity;
      // 이 구간(앞 기록 시각 초과 ~ 뒤 기록 시각 이하)의 종목별 순매수 수량
      while (p < mv.length && mv[p]!.ms <= from) p++;
      const net = new Map<string, number>();
      for (let j = p; j < mv.length && mv[j]!.ms <= to; j++) net.set(mv[j]!.code, (net.get(mv[j]!.code) ?? 0) + mv[j]!.q);
      const before = qty(prev);
      const after = cur ? qty(cur) : null;
      for (const code of new Set([...before.keys(), ...net.keys(), ...(after ? after.keys() : [])])) {
        const expected = round6((before.get(code) ?? 0) + (net.get(code) ?? 0));
        if (expected < -1e-6 || (after !== null && (after.get(code) ?? 0) > expected + 1e-6)) add(key, code, prev.asOf, cur?.asOf ?? null);
      }
    }
  }
  return out;
}

/** 표본 대조 전이면 원화 실현손익은 늘 '(추정)' */
function verifiedTag(r: Realized | null, cur: Cur): Realized | null {
  if (!r) return r;
  if (cur === "USD" && r.krw && !TOSS_VERIFIED.usRealizedKrw) return { ...r, krw: { ...r.krw, estimated: true } };
  return r;
}

/** 매도 줄 → 통화별 합계 (매도마다 반올림한 값의 합 — 목록 합 = 머리 합계). 모름·확인이 필요한 매도(unexplained)는 넣지 않는다 */
function realizedSum(sells: JournalItem[]): RealizedSum {
  const known = sells.filter((x) => x.realized && x.realized.status !== "unknown-cost" && x.realized.status !== "unexplained" && x.realized.gross !== null);
  const kr = known.filter((x) => x.currency === "KRW").map((x) => x.realized!.gross!);
  const us = known.filter((x) => x.currency === "USD");
  const usKrw = us.map((x) => x.realized!.krw?.gross ?? null);
  const krwTotal = !known.length || usKrw.some((v) => v === null) ? null : Math.round(kr.reduce((s, v) => s + v, 0) + usKrw.reduce<number>((s, v) => s + (v ?? 0), 0));
  return {
    KRW: kr.length ? sumRounded(kr, "KRW") : null,
    USD: us.length ? sumRounded(us.map((x) => x.realized!.gross!), "USD") : null,
    krwTotal,
    krwTotalEstimated: us.length > 0 || known.some((x) => x.realized!.status !== "ok"),
  };
}

/** 제어 문자는 지우고(줄바꿈·탭은 빈칸으로) 앞뒤 빈칸을 뗀다. 글자가 있었는데 제어 문자뿐이면 null */
export function cleanNote(text: string): string | null {
  const spaced = text.replace(/[\r\n\t]+/g, " ");
  const clean = [...spaced].filter((ch) => !isHidden(ch.codePointAt(0) ?? 0)).join("").trim();
  if (clean === "" && text.trim() !== "" && spaced.trim() !== "") return null;
  return clean;
}

/** 지우는 글자: 제어 문자(C0·C1)와 보이지 않는 방향·너비 문자 */
const HIDDEN = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]);
function isHidden(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || HIDDEN.has(cp);
}

/**
 * 온 줄의 날짜들(오름차순) → 받아 본 기간들. 이웃한 두 줄 사이에 빠진 은행 영업일이 STD_GAP_DAYS 이하면 한 구간, 더 길면 끊는다.
 * 첫 줄 앞·마지막 줄 뒤는 넣지 않는다 (그 앞뒤는 응답이 덮었는지 모른다)
 */
export function coveredSpans(dates: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const d of dates) {
    const last = out.at(-1);
    if (last && countDays(addDays(last[1], 1), addDays(d, -1), isKrBankDay) <= STD_GAP_DAYS) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

/**
 * 날짜 d 에 고시가 없을 때 쓸 직전 고시일 (오름차순 dates 가운데): d 전 PRIOR_DAYS 안, 그리고 사이에 고시가 빠진 은행 영업일이
 * STD_GAP_DAYS 이하일 때만 (inclusive 면 d 자신도 빠진 날로 센다). 오래된 고시로 빈칸을 메우지 않는다
 */
function priorStd(dates: string[], d: string, inclusive: boolean): string | null {
  const floor = addDays(d, -PRIOR_DAYS);
  for (let i = dates.length - 1; i >= 0; i--) {
    const at = dates[i]!;
    if (at >= d) continue;
    if (at < floor) return null;
    return countDays(addDays(at, 1), inclusive ? d : addDays(d, -1), isKrBankDay) <= STD_GAP_DAYS ? at : null;
  }
  return null;
}

/** [from, to] 를 한 해(시작일 + 1년 − 1일, 2/29 시작이면 다음 해 2/28)씩 */
export function yearChunks(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let a = from; a <= to; ) {
    const [y, m, d] = a.split("-").map(Number) as [number, number, number];
    const e = new Date(Date.UTC(y + 1, m - 1, d));
    e.setUTCDate(e.getUTCDate() - 1);
    const end = e.toISOString().slice(0, 10);
    const b = end < to ? end : to;
    out.push([a, b]);
    a = addDays(b, 1);
  }
  return out;
}

/** [from, to] 가운데 조건에 맞는 날 수 (to < from 이면 0) */
function countDays(from: string, to: string, ok: (d: string) => boolean): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (ok(d)) n++;
  return n;
}

/** 받기 실패 뒤 기다림: 1시간 · 6시간 · 그 뒤 하루 */
function backoff(t: { n: number; last: string } | undefined, nowMs: number): boolean {
  if (!t) return false;
  const wait = t.n <= 1 ? 3_600_000 : t.n === 2 ? 6 * 3_600_000 : 24 * 3_600_000;
  return nowMs - Date.parse(t.last) < wait;
}

function lookupPending(fills: LedgerFill[], settle: (f: LedgerFill) => string, lookup: (d: string) => TaxFx | "pending" | "none"): boolean {
  return fills.some((f) => lookup(settle(f)) === "pending");
}

