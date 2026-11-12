import { ProviderError } from "../../lib/errors.js";

/**
 * 토스증권 Open API 요청 한도 지키기 (그룹별 속도 조절).
 *
 * 토스는 '클라이언트 × API 그룹' 단위로 초당 요청 수를 제한한다 (문서 Rate Limits — 시세 15, 봉 20, 종목 정보 5, 환율·장 달력 3 …).
 * 예전에는 부르는 쪽마다 동시 개수만 제한해(종목 4개씩) 응답이 빠르면 한도를 넘었다 — 운영에서 하루 사이 환율 2,400번·현재가 370번·봉 300번이
 * 429 로 거절됐고, 그때마다 1~3초 기다렸다 다시 보내거나(시세 스냅샷이 그만큼 늦음) 1초 시세 확인이 5초 쉬었다.
 *
 * 여기서는 보내기 전에 줄을 세운다: 그룹마다 최근 WINDOW_MS 안에 보낸 요청이 허용 수(한도보다 조금 적게)를 채웠으면 자리가 날 때까지 기다린다.
 * 온 차례대로 보내고(FIFO), 너무 오래 기다리게 되면(maxWaitMs) 보내지 않고 실패로 돌려준다 — 부르는 쪽은 응답 시간 초과와 같게 다음 출처·옛 값으로 넘어간다.
 * 그래도 429 를 받으면(pause) 그 그룹은 Retry-After 만큼 쉰다.
 */

export interface RateGroup {
  /** 문서의 Rate Limits Group 이름 */
  group: string;
  /** 문서에 적힌 초당 한도 (피크 시간 한도가 따로 있으면 낮은 쪽) */
  limit: number;
}

const TREND_RE = /^\/api\/v1\/stocks\/[^/]+\/(investor-trading|program-trades|short-selling|credit-trades|securities-lending)$/;

/** 경로 → 요청 한도 그룹. 문서에 없는 경로는 null (속도 조절 없이 그대로 보낸다) */
export function rateGroupOf(path: string): RateGroup | null {
  if (path === "/api/v1/stocks/all") return { group: "STOCK_ALL", limit: 1 };
  if (TREND_RE.test(path)) return { group: "STOCK_TRADING_TREND", limit: 10 };
  if (path === "/api/v1/stocks" || /^\/api\/v1\/stocks\/[^/]+\/warnings$/.test(path)) return { group: "STOCK", limit: 5 };
  if (path === "/api/v1/prices" || path === "/api/v1/trades" || path === "/api/v1/orderbook" || path === "/api/v1/price-limits") return { group: "MARKET_DATA", limit: 15 };
  if (path === "/api/v1/candles") return { group: "MARKET_DATA_CHART", limit: 20 };
  if (path === "/api/v1/exchange-rate" || path.startsWith("/api/v1/market-calendar/")) return { group: "MARKET_INFO", limit: 3 };
  if (path === "/api/v1/rankings" || path.startsWith("/api/v1/rankings/")) return { group: "RANKING", limit: 5 };
  if (path === "/api/v1/sectors/rankings") return { group: "SECTOR_RANKING", limit: 5 };
  if (path === "/api/v1/sectors" || path.startsWith("/api/v1/sectors/")) return { group: "SECTOR", limit: 5 };
  if (path === "/api/v1/market-indicators/prices") return { group: "MARKET_INDICATOR_PRICE", limit: 10 };
  if (/^\/api\/v1\/market-indicators\/[^/]+\/candles$/.test(path)) return { group: "MARKET_INDICATOR_CHART", limit: 5 };
  if (path.startsWith("/api/v1/market-indicators/")) return { group: "MARKET_INDICATOR", limit: 10 };
  if (path === "/api/v1/accounts") return { group: "ACCOUNT", limit: 1 };
  if (path === "/api/v1/holdings") return { group: "ASSET", limit: 5 };
  if (path === "/api/v1/transactions") return { group: "TRANSACTION", limit: 5 };
  if (path === "/api/v1/orders" || path.startsWith("/api/v1/orders/")) return { group: "ORDER_HISTORY", limit: 5 };
  // 주문 정보는 09:00~09:10 KST 에 초당 3회로 줄어든다 → 늘 낮은 쪽으로
  if (path === "/api/v1/buying-power" || path === "/api/v1/sellable-quantity" || path === "/api/v1/commissions") return { group: "ORDER_INFO", limit: 3 };
  if (path === "/api/v1/conditional-orders" || path.startsWith("/api/v1/conditional-orders/")) return { group: "CONDITIONAL_ORDER_HISTORY", limit: 10 };
  return null;
}

/** 한도를 세는 구간. 1초보다 조금 길게 — 우리가 보낸 간격과 토스가 받은 간격이 조금 달라도(네트워크) 넘지 않게 */
export const PACE_WINDOW_MS = 1_100;
/** 줄에서 이보다 오래 기다리게 되면 보내지 않고 실패로 (요청 하나의 응답 제한 시간과 같게) */
export const PACE_MAX_WAIT_MS = 10_000;

/**
 * 한 구간에 실제로 보내는 수: 한도에서 15%(적어도 1)를 남긴다 — 20 → 17, 15 → 13, 10 → 8, 5 → 4, 3 → 2.
 * 한도가 1 이면 1 (구간이 1.1초라 그것으로 여유)
 */
export function pacedPerWindow(limit: number): number {
  if (!(limit > 1)) return 1;
  return Math.max(1, Math.floor(limit) - Math.max(1, Math.round(limit * 0.15)));
}

export interface PacerOptions {
  /** 지금 시각(ms). 기본 Date.now — 테스트는 가짜 시계 */
  clock?: () => number;
  /** 기다리기. 기본 setTimeout — 테스트는 가짜 시계를 돌린다 */
  sleep?: (ms: number) => Promise<void>;
  windowMs?: number;
  maxWaitMs?: number;
}

/** 운영 확인용 (/health): 그룹별로 줄을 서서 기다린 요청 수 · 가장 오래 기다린 시간 · 너무 오래 걸려 보내지 않은 수 */
export interface PaceStat {
  waited: number;
  maxWaitMs: number;
  dropped: number;
}

interface GroupState {
  /** 최근에 보낸 시각 (오래된 것부터) */
  sent: number[];
  /** 429 를 받아 쉬는 끝 시각 */
  pausedUntil: number;
  /** 줄의 끝 (앞 요청이 자리를 받은 뒤에 다음 요청이 자리를 본다) */
  tail: Promise<void>;
}

export class RequestPacer {
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly groups = new Map<string, GroupState>();
  readonly stats: Record<string, PaceStat> = {};

  constructor(opts: PacerOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.windowMs = opts.windowMs ?? PACE_WINDOW_MS;
    this.maxWaitMs = opts.maxWaitMs ?? PACE_MAX_WAIT_MS;
  }

  private state(group: string): GroupState {
    let s = this.groups.get(group);
    if (!s) {
      s = { sent: [], pausedUntil: 0, tail: Promise.resolve() };
      this.groups.set(group, s);
    }
    return s;
  }

  /**
   * 보낼 차례를 기다린다. limit = 그 그룹의 지금 초당 한도 (문서 값과 토스가 응답 머리글로 알려 준 값 중 낮은 쪽).
   * 너무 오래 기다리게 되면 ProviderError (보내지 않음)
   */
  take(group: string, limit: number): Promise<void> {
    const s = this.state(group);
    const queuedAt = this.clock();
    const turn = s.tail.then(() => this.slot(group, s, limit, queuedAt));
    // 앞 요청이 줄에서 떨어져도(오래 기다려 포기) 뒤 요청은 이어서 본다
    s.tail = turn.catch(() => undefined);
    return turn;
  }

  private async slot(group: string, s: GroupState, limit: number, queuedAt: number): Promise<void> {
    const allowed = pacedPerWindow(limit);
    for (;;) {
      const t = this.clock();
      while (s.sent.length && t - s.sent[0]! >= this.windowMs) s.sent.shift();
      const wait = Math.max(0, t < s.pausedUntil ? s.pausedUntil - t : s.sent.length >= allowed ? s.sent[0]! + this.windowMs - t : 0);
      const waited = t - queuedAt;
      // 이미 오래 기다렸거나 더 기다리면 넘는다: 보내지 않는다 (부르는 쪽은 벌써 다른 길로 갔다 — 늦게 보내 봐야 줄만 길어진다)
      if (waited + wait > this.maxWaitMs) {
        (this.stats[group] ??= { waited: 0, maxWaitMs: 0, dropped: 0 }).dropped++;
        throw new ProviderError("toss-openapi", `요청 한도 대기 시간 초과 (${group}, ${Math.round(this.maxWaitMs / 1000)}초) — 보내지 않음`);
      }
      if (wait === 0) {
        s.sent.push(t);
        if (waited > 0) {
          const st = (this.stats[group] ??= { waited: 0, maxWaitMs: 0, dropped: 0 });
          st.waited++;
          st.maxWaitMs = Math.max(st.maxWaitMs, Math.round(waited));
        }
        return;
      }
      await this.sleep(wait);
    }
  }

  /** 429 를 받았다: 그 그룹은 ms 동안 새 요청을 보내지 않는다 (줄에 선 요청들이 이어서 두드리지 않게) */
  pause(group: string, ms: number): void {
    if (!(ms > 0)) return;
    const s = this.state(group);
    s.pausedUntil = Math.max(s.pausedUntil, this.clock() + ms);
  }
}
