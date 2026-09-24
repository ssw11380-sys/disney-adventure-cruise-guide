import type { LatestBriefing, Quote, RegisteredWithQuote } from "@/api/types";

/**
 * GET /api/widget 응답 (서버 widgetPayload.ts 와 같은 모양, 짧은 키) → 위젯 코드가 쓰는 모양으로 되돌린다 (순수 함수).
 * 손익·수익률은 서버 evaluate 와 같은 식으로 여기서 계산한다 (평가금 − 매입금, 매입금 대비 %).
 */
export interface WidgetMarket {
  label: string;
  open: boolean;
  nextChangeAt: string | null;
}

export interface WidgetStock {
  c: string;
  n: string;
  qty: number | null;
  avg: number | null;
  q: [number, number, number, "KRW" | "USD", string, number | null, 0 | 1] | null;
  e: [number, number, number | null, number | null, "exact" | "estimated" | null] | null;
}

export interface WidgetBriefing {
  id: number;
  code: string;
  name: string;
  session: string;
  date: string;
  summary: string;
  createdAt: string;
}

export interface WidgetPayload {
  v: 1;
  market: WidgetMarket | null;
  stocks: WidgetStock[];
  briefings: WidgetBriefing[];
  /** 모든 종목의 최신 브리핑 id */
  latestIds?: number[];
}

const rate = (profit: number, cost: number) => (cost > 0 ? Math.round((profit / cost) * 10000) / 100 : 0);

export function fromPayload(p: WidgetPayload): { stocks: RegisteredWithQuote[]; briefings: LatestBriefing[]; market: WidgetMarket | null } {
  const stocks = p.stocks.map((s): RegisteredWithQuote => {
    const quote: Quote | null = s.q
      ? ({
          code: s.c, price: s.q[0], change: s.q[1], changeRate: s.q[2], currency: s.q[3], asOf: s.q[4], fxRate: s.q[5],
          open: null, high: null, low: null, prevClose: null, volume: null, marketCap: null, per: null, pbr: null, eps: null, bps: null, high52w: null, low52w: null, source: "widget",
          ...(s.q[6] ? { stale: true } : {}),
        } as Quote)
      : null;
    const e = s.e;
    const evaluation = e
      ? {
          marketValue: e[0], costBasis: e[1], profit: e[0] - e[1], profitRate: rate(e[0] - e[1], e[1]), costRate: null,
          afterCost: e[2] === null ? null : { marketValue: e[2], profit: e[2] - e[1], profitRate: rate(e[2] - e[1], e[1]) },
          costBasisKrw: e[3], krwCostSource: e[4],
        }
      : null;
    return { code: s.c, name: s.n, market: "", quantity: s.qty, avgPrice: s.avg, memo: null, createdAt: "", updatedAt: "", quote, quoteError: null, evaluation } as unknown as RegisteredWithQuote;
  });
  // 서버가 보유 비중 순으로 골라 준 3종목, 순서 그대로
  const briefings = p.briefings.map((b): LatestBriefing => ({
    code: b.code,
    name: b.name,
    latest: { id: b.id, code: b.code, name: b.name, session: b.session as "morning" | "afternoon", date: b.date, status: "ok", summary: b.summary, detail: "", missing: [], model: "", error: null, createdAt: b.createdAt },
  }));
  return { stocks, briefings, market: p.market };
}

/** 30분 넘게 지난 값이면 "지연": 장중인데 시세가 오래됐거나, 조회가 실패해 마지막 값을 보여 줄 때 */
export const STALE_MS = 30 * 60_000;
export function isDelayed(opts: { marketOpen: boolean; asOf: number; fetchedAt: number; error: string | null; now: number }): boolean {
  if (opts.error && opts.now - opts.fetchedAt > STALE_MS) return true;
  return opts.marketOpen && opts.now - opts.asOf > STALE_MS;
}

/**
 * 백그라운드 갱신에서 서버 호출을 건너뛸지: 두 시장이 모두 닫혀 있고, 다음 개장 전이고, 마지막으로 받은 지 2시간 안이면 건너뛴다.
 * 브리핑이 나오는 시간(08:20~09:30, 15:50~17:00 KST)은 휴장이어도 건너뛰지 않는다 (알림이 늦지 않게)
 */
export const CLOSED_REFRESH_MS = 2 * 3_600_000;
export function shouldSkipFetch(last: { at: number; market: WidgetMarket | null } | null, now: number): boolean {
  if (!last?.market || last.market.open) return false;
  if (now - last.at >= CLOSED_REFRESH_MS) return false;
  const next = last.market.nextChangeAt ? Date.parse(last.market.nextChangeAt) : NaN;
  if (!Number.isFinite(next) || now >= next) return false;
  const kst = new Date(now + 9 * 3_600_000);
  const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if ((m >= 8 * 60 + 20 && m < 9 * 60 + 30) || (m >= 15 * 60 + 50 && m < 17 * 60)) return false;
  return true;
}
