import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";
import type { RegisteredWithQuote } from "./stockService.js";

/**
 * 토스 계좌 자동 대조: 동기화 때마다 "앱 총평가(비용 차감)"와 토스 계좌 요약(amountAfterCost)을 비교해 남긴다.
 *  - 원화 종목은 원화끼리, 달러 종목은 달러끼리 비교하고 합계 차이만 환율로 원화 환산 (환율 차이가 섞이지 않게)
 *  - 토스와 앱의 가격 시각이 조금 달라 장중엔 작은 차이가 정상이다 → 0.1% 초과가 3번 연속일 때만 경고
 *  - 시세를 못 받은 토스 종목이 있으면 비교를 믿을 수 없어 연속 횟수에 넣지 않는다
 */

export const RECONCILE_KEY = "toss_reconcile";
const KEEP = 300; // 10분마다면 이틀치
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
  /** 시세·평가를 못 받은 토스 종목 수 (0 이 아니면 비교 제외) */
  missing: number;
}

export interface ReconcileStatus {
  last: ReconcileEntry | null;
  /** 0.1% 넘는 차이가 연속된 횟수 */
  streakOver: number;
  /** 최근 7일: 비교한 횟수와 0.1% 이하 비율 */
  week: { n: number; withinPct: number | null };
  alert: boolean;
}

/** 순수 계산: 토스 종목(tossSynced)만 합친다 */
export function compareWithToss(list: RegisteredWithQuote[], toss: { afterCostKrw: number; afterCostUsd: number }, at: string): ReconcileEntry {
  let appKrw = 0, appUsd = 0, missing = 0;
  let fx: number | null = null;
  for (const s of list) {
    if (!s.tossSynced || !s.quantity) continue;
    const ev = s.evaluation;
    if (!s.quote || !ev) {
      missing++;
      continue;
    }
    const v = ev.afterCost?.marketValue ?? ev.marketValue;
    if (s.quote.currency === "USD") {
      appUsd += v;
      fx ??= s.quote.fxRate ?? null;
    } else appKrw += v;
  }
  const rate = fx ?? 0;
  const diffKrw = appKrw - toss.afterCostKrw + (appUsd - toss.afterCostUsd) * rate;
  const base = toss.afterCostKrw + toss.afterCostUsd * rate;
  return {
    at,
    tossKrw: Math.round(toss.afterCostKrw),
    tossUsd: Math.round(toss.afterCostUsd * 100) / 100,
    appKrw: Math.round(appKrw),
    appUsd: Math.round(appUsd * 100) / 100,
    fx,
    diffKrw: Math.round(diffKrw),
    diffPct: base > 0 ? Math.round((diffKrw / base) * 1e5) / 1e3 : 0,
    missing,
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

  async record(list: RegisteredWithQuote[], toss: { afterCostKrw: number; afterCostUsd: number }): Promise<ReconcileEntry> {
    const entry = compareWithToss(list, toss, seoulIso(this.now));
    const history = await this.history();
    history.push(entry);
    const trimmed = history.slice(-KEEP);
    const value = JSON.stringify(trimmed);
    await this.opts.db.insertInto("meta").values({ key: RECONCILE_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    const streak = streakOver(trimmed);
    if (streak === STREAK_ALERT) {
      const text = `토스 대조: 앱 총평가가 토스 계좌와 ${entry.diffKrw.toLocaleString("ko-KR")}원(${entry.diffPct.toFixed(2)}%) 다릅니다 (${STREAK_ALERT}회 연속 ${RECONCILE_WARN_PCT}% 초과)`;
      this.opts.log?.warn({ entry }, text);
      await this.opts.notify?.(text).catch(() => undefined);
    }
    return entry;
  }

  async history(): Promise<ReconcileEntry[]> {
    const row = await this.opts.db.selectFrom("meta").select("value").where("key", "=", RECONCILE_KEY).executeTakeFirst();
    if (!row) return [];
    try {
      const v = JSON.parse(row.value) as unknown;
      return Array.isArray(v) ? (v as ReconcileEntry[]) : [];
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
    return { last: h.at(-1) ?? null, streakOver: streak, week: { n: week.length, withinPct: week.length ? Math.round((within / week.length) * 1000) / 10 : null }, alert: streak >= STREAK_ALERT };
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
