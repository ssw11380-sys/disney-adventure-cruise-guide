import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";
import type { RegisteredWithQuote } from "./stockService.js";

/**
 * 토스 계좌 자동 대조: 동기화 때마다 같은 응답의 토스 종목별 수량·평가금(amountAfterCost)과 앱을 비교해 남긴다.
 *  - 수량: 토스와 앱 보유 수량이 다른 종목 수 (3번 연속이면 경고 — 동기화가 수량을 못 맞추는 경우)
 *  - 평가금: 수량이 같은 종목만. 수량·비용률은 토스에서 받아 오므로 사실상 앱 시세가 토스 가격과 맞는지 보는 검사
 *  - 같은 종목끼리만: 이번 동기화로 받은 토스 종목 중 "동기화 제외"가 아닌 것 (계좌 요약 합계를 쓰면 제외 종목·앱이 모르는 종목이 늘 차이로 남는다)
 *  - 원화 종목은 원화끼리, 달러 종목은 달러끼리 합치고 합계 차이만 환율로 원화 환산 (환율 차이가 섞이지 않게)
 *  - 가격 시각이 조금 달라 장중엔 작은 차이가 정상이다 → 0.1% 초과가 3번 연속일 때 한 번만 경고
 *  - 비교를 믿을 수 없으면(시세 없음·지연, 비용 차감 평가 없음, 토스 평가금 없음, 환율 없음) 연속 횟수에 넣지 않는다
 */

export const RECONCILE_KEY = "toss_reconcile";
const KEEP = 1_000; // 10분마다 하루 약 100건 → 7일치 이상
export const RECONCILE_WARN_PCT = 0.1;
const STREAK_ALERT = 3;

export interface ReconcileEntry {
  at: string;
  tossKrw: number;
  tossUsd: number;
  appKrw: number;
  appUsd: number;
  fx: number | null;
  /** 앱 − 토스 (원화 환산) */
  diffKrw: number;
  diffPct: number;
  /** 비교한 종목 수 */
  n?: number;
  /** 비교할 수 없던 종목 수 (0 이 아니면 평가금 비교 제외) */
  missing: number;
  /** 토스와 보유 수량이 다른 종목 (예전 기록에는 없음) */
  qtyMismatch?: string[];
}

export interface ReconcileStatus {
  last: ReconcileEntry | null;
  /** 0.1% 넘는 차이가 연속된 횟수 */
  streakOver: number;
  /** 수량이 다른 종목이 있는 기록이 연속된 횟수 */
  qtyStreak: number;
  /** 최근 7일: 비교한 횟수와 0.1% 이하 비율 */
  week: { n: number; withinPct: number | null };
  alert: boolean;
}

/** 이번 동기화의 토스 종목 (여러 계좌면 합친 값) */
export interface TossItem {
  code: string;
  currency: "KRW" | "USD";
  quantity: number;
  marketValueAfterCost?: number | null;
}

/** 순수 계산: 토스 종목(동기화 제외 뺌)과 앱의 같은 종목만 합친다 */
export function compareWithToss(list: RegisteredWithQuote[], toss: TossItem[], at: string): ReconcileEntry {
  const byCode = new Map(list.map((s) => [s.code, s]));
  let appKrw = 0, appUsd = 0, tossKrw = 0, tossUsd = 0, missing = 0, n = 0;
  let fx: number | null = null;
  const qtyMismatch: string[] = [];
  for (const t of toss) {
    const s = byCode.get(t.code);
    const ev = s?.evaluation ?? null;
    // 수량이 다르면 평가금 비교는 의미가 없다 → 수량 차이로 따로 센다
    if ((s?.quantity ?? 0) !== t.quantity) {
      qtyMismatch.push(t.code);
      continue;
    }
    if (t.marketValueAfterCost == null || !s!.quote || s!.quote.stale || !ev?.afterCost) {
      missing++;
      continue;
    }
    n++;
    const v = ev.afterCost.marketValue;
    if (t.currency === "USD") {
      appUsd += v;
      tossUsd += t.marketValueAfterCost;
      fx ??= s?.quote?.fxRate ?? null;
    } else {
      appKrw += v;
      tossKrw += t.marketValueAfterCost;
    }
  }
  if (tossUsd > 0 && fx === null) {
    for (const s of list) fx ??= s.quote?.currency === "USD" ? (s.quote.fxRate ?? null) : null;
  }
  const noFx = (tossUsd > 0 || appUsd > 0) && fx === null;
  const rate = fx ?? 0;
  const diffKrw = appKrw - tossKrw + (appUsd - tossUsd) * rate;
  const base = tossKrw + tossUsd * rate;
  return {
    at,
    tossKrw: Math.round(tossKrw),
    tossUsd: Math.round(tossUsd * 100) / 100,
    appKrw: Math.round(appKrw),
    appUsd: Math.round(appUsd * 100) / 100,
    fx,
    diffKrw: Math.round(diffKrw),
    diffPct: base > 0 ? Math.round((diffKrw / base) * 1e5) / 1e3 : 0,
    n,
    // 수량이 다른 종목이 있거나 환율·비교할 금액이 없으면 평가금 비교는 믿을 수 없다
    missing: missing + qtyMismatch.length + (noFx ? 1 : 0) + (base > 0 ? 0 : 1),
    qtyMismatch,
  };
}

export class ReconcileService {
  constructor(
    private readonly opts: {
      db: Db;
      now?: () => Date;
      log?: { warn(o: object, m: string): void };
      /** 경고를 보낼 곳 (3-8 알림 통로가 생기면 연결). 없으면 로그만 */
      notify?: ((text: string) => Promise<void>) | null;
    },
  ) {}

  private get now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  /** 기록을 한 줄로 (읽고-고쳐-쓰기 사이에 다른 기록이 끼어 사라지지 않게) */
  private queue: Promise<unknown> = Promise.resolve();
  private cache: ReconcileEntry[] | null = null;

  record(list: RegisteredWithQuote[], toss: TossItem[]): Promise<ReconcileEntry> {
    const run = this.queue.then(() => this.recordNow(list, toss));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async recordNow(list: RegisteredWithQuote[], toss: TossItem[]): Promise<ReconcileEntry> {
    const entry = compareWithToss(list, toss, seoulIso(this.now));
    const trimmed = [...(await this.history()), entry].slice(-KEEP);
    const value = JSON.stringify(trimmed);
    await this.opts.db.insertInto("meta").values({ key: RECONCILE_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    this.cache = trimmed;
    // 이번 비교로 연속 3번이 된 때만 (비교 제외 건이 뒤에 붙어도 다시 알리지 않게)
    if (entry.missing === 0 && streakOver(trimmed) === STREAK_ALERT) {
      const text = `토스 대조: 앱 평가금이 토스 계좌와 ${entry.diffKrw.toLocaleString("ko-KR")}원(${entry.diffPct.toFixed(2)}%) 다릅니다 (${STREAK_ALERT}회 연속 ${RECONCILE_WARN_PCT}% 초과, 시세 출처·시각 차이)`;
      this.opts.log?.warn({ entry }, text);
      await this.opts.notify?.(text).catch(() => undefined);
    }
    if (entry.qtyMismatch?.length && qtyStreak(trimmed) === STREAK_ALERT) {
      const text = `토스 대조: 보유 수량이 토스와 다른 종목이 ${STREAK_ALERT}회 연속 있습니다 (${entry.qtyMismatch.join(", ")})`;
      this.opts.log?.warn({ entry }, text);
      await this.opts.notify?.(text).catch(() => undefined);
    }
    return entry;
  }

  async history(): Promise<ReconcileEntry[]> {
    if (this.cache) return this.cache;
    const row = await this.opts.db.selectFrom("meta").select("value").where("key", "=", RECONCILE_KEY).executeTakeFirst();
    if (!row) return [];
    try {
      const v = JSON.parse(row.value) as unknown;
      this.cache = Array.isArray(v) ? (v as ReconcileEntry[]) : [];
      return this.cache;
    } catch {
      return [];
    }
  }

  async status(): Promise<ReconcileStatus> {
    const h = await this.history();
    const since = this.now.getTime() - 7 * 86_400_000;
    const week = h.filter((e) => e.missing === 0 && Date.parse(e.at) >= since);
    const within = week.filter((e) => Math.abs(e.diffPct) <= RECONCILE_WARN_PCT).length;
    const streak = streakOver(h);
    const qty = qtyStreak(h);
    return { last: h.at(-1) ?? null, streakOver: streak, qtyStreak: qty, week: { n: week.length, withinPct: week.length ? Math.round((within / week.length) * 1000) / 10 : null }, alert: streak >= STREAK_ALERT || qty >= STREAK_ALERT };
  }
}

/** 끝에서부터 0.1% 초과가 몇 번 연속인지 (비교 제외 건은 건너뜀) */
function streakOver(h: ReconcileEntry[]): number {
  let n = 0;
  for (let i = h.length - 1; i >= 0; i--) {
    const e = h[i]!;
    if (e.missing > 0) continue;
    if (Math.abs(e.diffPct) > RECONCILE_WARN_PCT) n++;
    else break;
  }
  return n;
}

/** 끝에서부터 수량이 다른 종목이 있는 기록이 몇 번 연속인지 (연달아 이어진 동기화 사이에 잠깐 어긋나는 건 3번 연속이 되기 어렵다) */
function qtyStreak(h: ReconcileEntry[]): number {
  let n = 0;
  for (let i = h.length - 1; i >= 0 && h[i]!.qtyMismatch?.length; i--) n++;
  return n;
}
