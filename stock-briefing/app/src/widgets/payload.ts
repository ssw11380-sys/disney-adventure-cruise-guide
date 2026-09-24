import type { LatestBriefing, Quote, RegisteredWithQuote } from "@/api/types";
import { featureOn } from "@/lib/features";

/**
 * GET /api/widget 응답 (서버 widgetPayload.ts 와 같은 모양, 짧은 키) → 위젯 코드가 쓰는 모양으로 되돌린다 (순수 함수).
 * 손익·수익률은 서버 evaluate 와 같은 식으로 여기서 계산한다 (평가금 − 매입금, 매입금 대비 %).
 */
export interface WidgetMarket {
  label: string;
  open: boolean;
  nextChangeAt: string | null;
  /** 시장별 거래 중 (예전 응답에는 없음) */
  kr?: boolean;
  us?: boolean;
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

/** 잔고 위젯 지수 줄 한 항목 (서버 지수 띠와 같은 값·같은 stale 규칙). 예전 서버에는 없음 */
export interface WidgetIndex {
  code: string;
  name: string;
  value: number;
  change: number;
  changeRate: number;
  open: boolean;
  /** 출처 조회가 실패해 마지막 값 (흐리게 + "지연") */
  stale?: boolean;
  asOf?: string | null;
}

export interface WidgetPayload {
  v: 1;
  market: WidgetMarket | null;
  stocks: WidgetStock[];
  briefings: WidgetBriefing[];
  /** 모든 종목의 최신 브리핑 id */
  latestIds?: number[];
  /** 위젯이 쓰는 기능 플래그만 (위젯은 /api/features 를 따로 받지 않는다). 예전 서버에는 없음 → 모두 꺼짐 */
  features?: Record<string, boolean>;
  /** 코스피·나스닥·원/달러 (widgetIndexLine 이 켜진 서버만) */
  indices?: WidgetIndex[];
}

/** 위젯 기능 플래그 (서버 featureService 의 widgetPnlToggle·widgetIndexLine) */
export interface WidgetFeatures {
  /** 합계 옆 손익을 눌러 누적·당일 전환 */
  pnlToggle: boolean;
  /** 합계 아래 지수·환율 한 줄 */
  indexLine: boolean;
}

export const NO_FEATURES: WidgetFeatures = { pnlToggle: false, indexLine: false };

/** 받은 플래그 → 위젯 기능. 모르는 키·예전 서버(없음)면 꺼짐 (새 기능은 fallback false, docs/기능-플래그.md) */
export function widgetFeatures(features: Record<string, boolean> | null | undefined): WidgetFeatures {
  const flags = features ? { features, updatedAt: null } : null;
  return { pnlToggle: featureOn(flags, "widgetPnlToggle", false), indexLine: featureOn(flags, "widgetIndexLine", false) };
}

/** 위젯 지수 줄에 넣는 항목과 순서 (서버 widgetPayload.ts 의 WIDGET_INDEX_CODES 와 같다) */
export const WIDGET_INDEX_CODES = ["KOSPI", "NASDAQ", "USDKRW"] as const;

/** 앱이 받은 지수 띠 목록(/api/market/indices?stale=1)에서 위젯 줄에 넣을 것만, 서버와 같은 순서·같은 모양으로 */
export function pickWidgetIndices(list: readonly { code: string; name: string; value: number; change: number; changeRate: number; open: boolean; stale?: boolean; asOf?: string | null }[]): WidgetIndex[] {
  const byCode = new Map(list.map((i) => [i.code, i]));
  return WIDGET_INDEX_CODES.flatMap((code) => {
    const i = byCode.get(code);
    if (!i) return [];
    return [{ code: i.code, name: i.name, value: i.value, change: i.change, changeRate: i.changeRate, open: i.open, ...(i.stale ? { stale: true } : {}), ...(i.asOf ? { asOf: i.asOf } : {}) }];
  });
}

/** 모양이 맞는 지수 항목만 (예전·다른 서버의 이상한 값은 버린다) */
function cleanIndices(list: unknown): WidgetIndex[] | null {
  if (!Array.isArray(list)) return null;
  return list.filter((i): i is WidgetIndex => !!i && typeof i === "object" && typeof (i as WidgetIndex).code === "string" && Number.isFinite((i as WidgetIndex).value) && Number.isFinite((i as WidgetIndex).change) && Number.isFinite((i as WidgetIndex).changeRate));
}

const rate = (profit: number, cost: number) => (cost > 0 ? Math.round((profit / cost) * 10000) / 100 : 0);

export function fromPayload(p: WidgetPayload): {
  stocks: RegisteredWithQuote[];
  briefings: LatestBriefing[];
  market: WidgetMarket | null;
  indices: WidgetIndex[] | null;
  features: WidgetFeatures;
} {
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
  return { stocks, briefings, market: p.market, indices: cleanIndices(p.indices), features: widgetFeatures(p.features) };
}

/**
 * 그릴 때 쓸 장 상태: 받은 뒤 다음 개장·마감 시각이 지났으면 모르는 것으로(칩을 감추고 지연도 따지지 않음).
 * 위젯은 받을 때만 다시 그려지므로 09:00·15:30 을 지나 옛 칩이 남지 않게
 */
export function currentMarket(market: WidgetMarket | null | undefined, now: number): WidgetMarket | null {
  if (!market) return null;
  const next = market.nextChangeAt ? Date.parse(market.nextChangeAt) : NaN;
  return Number.isFinite(next) && now >= next ? null : market;
}

/** 지금 열린 시장 종목의 가장 늦은 시세 시각 (한국 장중이면 한국 종목만). 열린 시장 종목이 없으면 null */
export function openMarketAsOf(stocks: RegisteredWithQuote[], market: WidgetMarket | null): number | null {
  if (!market?.open) return null;
  const byMarket = market.kr !== undefined || market.us !== undefined;
  let best: number | null = null;
  for (const s of stocks) {
    if (!s.quote) continue;
    const isOpen = !byMarket || (s.quote.currency === "USD" ? market.us : market.kr);
    const t = Date.parse(s.quote.asOf);
    if (isOpen && Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

/** 30분 넘게 지난 값이면 "지연": 열린 시장 종목의 시세가 오래됐거나, 조회가 실패해 마지막 값을 보여 줄 때 */
export const STALE_MS = 30 * 60_000;
export function isDelayed(opts: { openAsOf: number | null; fetchedAt: number; error: string | null; now: number }): boolean {
  if (opts.error && opts.now - opts.fetchedAt > STALE_MS) return true;
  return opts.openAsOf !== null && opts.now - opts.openAsOf > STALE_MS;
}

/**
 * 위젯이 스스로 갱신할 때(주기·추가·크기 변경) 서버를 다시 부르지 않고 저장해 둔 응답을 쓸지.
 * 장중엔 15분 안에 받은 값(백그라운드 작업이 15분마다 받는다), 두 시장이 닫혀 있으면 shouldSkipFetch 규칙
 */
export const REUSE_OPEN_MS = 15 * 60_000;
export function canReuse(last: { at: number; market: WidgetMarket | null } | null, now: number): boolean {
  if (!last) return false;
  if (now - last.at < REUSE_OPEN_MS) return true;
  return shouldSkipFetch(last, now);
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
