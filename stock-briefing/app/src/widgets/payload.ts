import type { LatestBriefing, Quote, QuoteSession, RegisteredWithQuote } from "@/api/types";
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
  /** 시장별 문구 (다듬은 잔고 위젯이 두 시장을 한 칩에: "미국 주간거래 · 한국 휴장"). 예전 서버·플래그 꺼짐이면 없음 → label 한 개 */
  markets?: { market: "KR" | "US"; label: string }[];
  /**
   * 시장별 연장 세션 열림 (위젯 리뷰 1, 플래그 widgetExtended — extendedOpen): 달력으로는 닫혀 있지만 보유 종목이 거래되는 세션
   * (미국 프리·애프터·주간거래 등). 이때도 장중처럼 15분마다 갱신하고(shouldSkipFetch·canReuse) 그 시장 시세로 '지연'을 따진다(openMarketAsOf).
   * 예전 서버·플래그 꺼짐이면 없음 → 예전처럼 휴장 규칙
   */
  ext?: { kr: boolean; us: boolean };
}

/** 브리핑 위젯 안내 (BH-68): 설정한 브리핑 시각(끈 세션은 null)과 최신 브리핑이 실패한 종목 수. 예전 서버면 없음 */
export interface WidgetBrief {
  morning: string | null;
  afternoon: string | null;
  weekdaysOnly: boolean;
  failed: number;
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
  /** 지수·환율 위젯 판 9개 (widgetMarket 이 켜진 서버가 ?board=1 로 물은 앱에만). 예전 서버·플래그 꺼짐이면 없음 */
  board?: WidgetIndex[];
  /** 최근 계좌 한 장 브리핑 id (3-31, accountBriefing 이 켜진 서버만). 백그라운드 알림용 — 위젯은 쓰지 않는다 */
  accountIds?: number[];
  /** 브리핑 시간·최신 브리핑 실패 수 (BH-68, &ui=2 로 물은 새 앱에만) */
  brief?: WidgetBrief;
}

/** 위젯 기능 플래그 (서버 featureService 의 widgetPnlToggle·widgetIndexLine·widgetMarket·widgetPolish·widgetExtended·widgetFoldFit) */
export interface WidgetFeatures {
  /** 합계 옆 손익을 눌러 누적·당일 전환 */
  pnlToggle: boolean;
  /** 합계 아래 지수·환율 한 줄 */
  indexLine: boolean;
  /** 지수·환율 위젯 (APK 1.4.0). 꺼져 있거나 모르면 짧은 안내만 */
  market: boolean;
  /** 다듬은 잔고 위젯 (두 시장 칩·지수 줄 순서·'수익'/'오늘'·⇅·'보유 17 · 관심 1'·줄 간격). 꺼져 있거나 모르면 예전 모습 그대로 */
  polish: boolean;
  /**
   * 연장 세션(프리·애프터·주간거래)도 장중처럼 갱신·'지연' 판단 (widgetExtended). 켜져 있을 때만 true 칸이 있다 —
   * 꺼짐·모름은 칸이 없어 예전에 적어 둔 값·예전 모양과 같다 (fallback false)
   */
  extended?: boolean;
  /**
   * 폴드 위젯 크기 맞추기 (widgetFoldFit, 위젯 2차 — widgets/frame.ts): 바깥·안쪽 두 화면에서 본 크기를 기억해 두 화면에 맞게 그리고,
   * 앱이 떠 있을 때 접고 펴면 위젯을 다시 그린다. 켜져 있을 때만 true 칸이 있다 (fallback false — 꺼짐·모름은 지금 그림 그대로)
   */
  foldFit?: boolean;
}

export const NO_FEATURES: WidgetFeatures = { pnlToggle: false, indexLine: false, market: false, polish: false };

/** 받은 플래그 → 위젯 기능. 모르는 키·예전 서버(없음)면 꺼짐 (새 기능은 fallback false, docs/기능-플래그.md) */
export function widgetFeatures(features: Record<string, boolean> | null | undefined): WidgetFeatures {
  const flags = features ? { features, updatedAt: null } : null;
  return {
    pnlToggle: featureOn(flags, "widgetPnlToggle", false),
    indexLine: featureOn(flags, "widgetIndexLine", false),
    market: featureOn(flags, "widgetMarket", false),
    polish: featureOn(flags, "widgetPolish", false),
    ...(featureOn(flags, "widgetExtended", false) ? { extended: true } : {}),
    ...(featureOn(flags, "widgetFoldFit", false) ? { foldFit: true } : {}),
  };
}

/** 위젯 지수 줄에 넣는 항목과 순서 (서버 widgetPayload.ts 의 WIDGET_INDEX_CODES 와 같다) */
export const WIDGET_INDEX_CODES = ["KOSPI", "NASDAQ", "USDKRW"] as const;

/**
 * 다듬은 잔고 위젯(widgetPolish)의 지수 줄 후보: 국내 둘 · 미국 둘 · 원/달러 (서버 widgetPayload.ts 의 WIDGET_LINE_CODES 와 같다).
 * 순서는 그릴 때 계좌 비중으로 고른다 (model.ts polishedIndexItems). 예전 모습은 이 중 WIDGET_INDEX_CODES 세 개만 받은 순서대로 그린다
 */
export const WIDGET_LINE_CODES = ["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "USDKRW"] as const;

/** 지수·환율 위젯 판의 항목과 순서: 국내 → 미국 → 환율 (서버 widgetPayload.ts 의 WIDGET_BOARD_CODES, board.ts 의 구역과 같다) */
export const WIDGET_BOARD_CODES = ["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "DJI", "SOX", "USDKRW", "JPYKRW", "CNYKRW"] as const;

type IndexRow = { code: string; name: string; value: number; change: number; changeRate: number; open: boolean; stale?: boolean; asOf?: string | null };

/**
 * 앱이 받은 지수 띠 목록(/api/market/indices?stale=1)에서 위젯 줄에 넣을 것만, 서버와 같은 순서·같은 모양으로.
 * 다듬은 모습이 쓰는 다섯 개(WIDGET_LINE_CODES)를 모두 넘긴다 — 예전 모습은 그릴 때 세 개만 고른다(model.ts indexItems)
 */
export function pickWidgetIndices(list: readonly IndexRow[]): WidgetIndex[] {
  return pickCodes(list, WIDGET_LINE_CODES);
}

/** 앱이 받은 지수 띠 목록에서 지수·환율 위젯 판 9개 (서버가 주는 board 와 같은 순서·같은 모양) */
export function pickBoard(list: readonly IndexRow[]): WidgetIndex[] {
  return pickCodes(list, WIDGET_BOARD_CODES);
}

function pickCodes(list: readonly IndexRow[], codes: readonly string[]): WidgetIndex[] {
  const byCode = new Map(list.map((i) => [i.code, i]));
  return codes.flatMap((code) => {
    const i = byCode.get(code);
    if (!i) return [];
    return [{ code: i.code, name: i.name, value: i.value, change: i.change, changeRate: i.changeRate, open: i.open, ...(i.stale ? { stale: true } : {}), ...(i.asOf ? { asOf: i.asOf } : {}) }];
  });
}

/**
 * 지수를 받은 지 이만큼 지나면 모든 항목을 "지연"(흐리게)으로 그린다: 위젯 조회가 계속 실패해 마지막 값을 쓸 때.
 * 서버 지수 띠가 실패한 출처의 마지막 값을 이어 주는 최대 시간(indices.ts STALE_MAX_MS)과 같은 3시간
 */
export const INDEX_STALE_MS = 3 * 3_600_000;

/** 받은 시각(at)이 INDEX_STALE_MS 보다 오래됐으면 모든 항목을 stale 로. 시각을 모르면 그대로 */
export function agedIndices(list: WidgetIndex[] | null, at: number | undefined, now: number): WidgetIndex[] | null {
  if (!list || at === undefined || now - at <= INDEX_STALE_MS) return list;
  return list.map((i) => ({ ...i, stale: true }));
}

/** 모양이 맞는 지수 항목만 (예전·다른 서버의 이상한 값은 버린다) */
function cleanIndices(list: unknown): WidgetIndex[] | null {
  if (!Array.isArray(list)) return null;
  return list.filter((i): i is WidgetIndex => !!i && typeof i === "object" && typeof (i as WidgetIndex).code === "string" && Number.isFinite((i as WidgetIndex).value) && Number.isFinite((i as WidgetIndex).change) && Number.isFinite((i as WidgetIndex).changeRate));
}

const HHMM = /^\d{2}:\d{2}$/;
/** 모양이 맞는 브리핑 안내만 (예전·다른 서버의 이상한 값은 버린다 → 모름) */
export function cleanBrief(b: unknown): WidgetBrief | null {
  if (!b || typeof b !== "object") return null;
  const v = b as Partial<WidgetBrief>;
  const time = (t: unknown) => (typeof t === "string" && HHMM.test(t) ? t : null);
  if (typeof v.weekdaysOnly !== "boolean" || !Number.isInteger(v.failed) || (v.failed as number) < 0) return null;
  return { morning: time(v.morning), afternoon: time(v.afternoon), weekdaysOnly: v.weekdaysOnly, failed: v.failed as number };
}

const rate = (profit: number, cost: number) => (cost > 0 ? Math.round((profit / cost) * 10000) / 100 : 0);

export function fromPayload(p: WidgetPayload): {
  stocks: RegisteredWithQuote[];
  briefings: LatestBriefing[];
  market: WidgetMarket | null;
  indices: WidgetIndex[] | null;
  board: WidgetIndex[] | null;
  features: WidgetFeatures;
  brief: WidgetBrief | null;
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
  const features = widgetFeatures(p.features);
  return { stocks, briefings, market: gateExtended(p.market, features), indices: cleanIndices(p.indices), board: cleanIndices(p.board), features, brief: cleanBrief(p.brief) };
}

/**
 * 시장별 연장 세션 열림 (widgetExtended): 달력(토스 — 한국 08:00~20:00, 미국은 정규장만)으로는 닫혀 있지만, 보유 종목 중
 * 지금 세션이 열려 있고(open) 그 세션의 거래 대상으로 확인됐고(eligible true) 경계(until) 전인 종목이 있으면 true.
 * 잔고 상태 줄의 '지연' 판단(lib/liveDot liveCounts)과 같은 조건 — 대상인지 모르거나(eligible null) 주간거래 미지원(false)이면 가격이 바뀌지 않는다.
 * 서버 services/widgetPayload.ts 의 extendedOpen 과 같은 함수 (공용 픽스처 shared/fixtures/widgetExtended.json — 한쪽을 고치면 다른 쪽도 같이)
 */
export function extendedOpen(calendar: { kr: boolean; us: boolean }, sessions: readonly (QuoteSession | null | undefined)[], now: number): { kr: boolean; us: boolean } {
  const on = (market: "KR" | "US", calOpen: boolean) =>
    !calOpen &&
    sessions.some((s) => {
      if (!s || s.market !== market || !s.open || s.eligible !== true) return false;
      const until = s.until ? Date.parse(s.until) : NaN;
      return !(Number.isFinite(until) && now >= until);
    });
  return { kr: on("KR", calendar.kr), us: on("US", calendar.us) };
}

/** 칩의 연장 세션 표시를 쓸지: 위젯이 쓰는 플래그(widgetExtended)가 켜져 있을 때만. 꺼져 있거나 모르면 ext 를 뗀 칩 (예전 휴장 규칙) */
export function gateExtended(market: WidgetMarket | null, features: WidgetFeatures): WidgetMarket | null {
  if (!market?.ext || features.extended === true) return market;
  const { ext: _ext, ...rest } = market;
  return rest;
}

/** 받아 둔 /api/widget 응답의 칩 (플래그로 거른 것 — 백그라운드 작업·위젯 재사용이 갱신을 건너뛸지 볼 때) */
export function payloadMarket(body: Pick<WidgetPayload, "market" | "features">): WidgetMarket | null {
  return gateExtended(body.market ?? null, widgetFeatures(body.features));
}

/** 보유 종목의 연장 세션이 열려 있는 시장이 있는지 */
function extOpen(market: WidgetMarket | null | undefined): boolean {
  return market?.ext?.kr === true || market?.ext?.us === true;
}

/**
 * 연장 세션 표시(ext)와 그 '지연' 판단에 쓰는 종목: 보유 종목(수량 > 0)만 (통합 검증 지적). 관심 종목만 프리마켓이면 15분 갱신·'지연'을 하지 않는다.
 * 서버 services/widgetPayload.ts buildWidgetPayload 의 ext 계산과 같은 조건
 */
export function heldForExtended(s: { quantity?: number | null }): boolean {
  return (s.quantity ?? 0) > 0;
}

/**
 * 앱이 바로 그리는 칩(WidgetBridge — 서버 칩과 같은 marketChip)에 연장 세션 표시를 붙인다 (pushWidgetData).
 * 플래그가 켜져 있고 칩에 아직 없으면 보유 종목 시세의 세션으로 서버와 같은 규칙(extendedOpen — 관심 종목은 보지 않는다). 꺼져 있으면 뗀다.
 * 백그라운드 작업이 넘기는 칩(서버 응답)은 서버가 이미 붙였으므로 그대로
 */
export function withExtended(market: WidgetMarket | null, features: WidgetFeatures, stocks: readonly { quantity?: number | null; quote?: Quote | null }[], now: number): WidgetMarket | null {
  if (!market || features.extended !== true) return gateExtended(market, features);
  if (market.ext) return market;
  return { ...market, ext: extendedOpen({ kr: market.kr === true, us: market.us === true }, stocks.filter(heldForExtended).map((s) => s.quote?.session), now) };
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

/**
 * 지금 열린 시장 종목의 가장 늦은 시세 시각 (한국 장중이면 한국 종목만). 열린 시장 종목이 없으면 null.
 * 연장 세션(ext — 미국 프리·애프터·주간거래 등, widgetExtended)이 열린 시장도 열린 시장으로 본다 — 이때 숫자가 30분 넘게 묵으면 '지연'.
 * 연장 세션으로만 열린 시장은 보유 종목(수량 > 0) 시세만 본다 (통합 검증 지적 — ext 를 켠 것과 같은 종목. 관심 종목의 새 시세가 멈춘 보유 종목을 가리지 않게).
 * 달력으로 열린 시장은 예전처럼 모든 종목
 */
export function openMarketAsOf(stocks: RegisteredWithQuote[], market: WidgetMarket | null): number | null {
  if (!market || (!market.open && !extOpen(market))) return null;
  const byMarket = market.kr !== undefined || market.us !== undefined;
  let best: number | null = null;
  for (const s of stocks) {
    if (!s.quote) continue;
    const held = heldForExtended(s);
    const isOpen = !byMarket || (s.quote.currency === "USD" ? market.us === true || (market.ext?.us === true && held) : market.kr === true || (market.ext?.kr === true && held));
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
 * 장중(연장 세션 포함)엔 15분 안에 받은 값(백그라운드 작업이 15분마다 받는다), 두 시장이 닫혀 있으면 shouldSkipFetch 규칙
 */
export const REUSE_OPEN_MS = 15 * 60_000;
export function canReuse(last: { at: number; market: WidgetMarket | null } | null, now: number): boolean {
  if (!last) return false;
  if (now - last.at < REUSE_OPEN_MS) return true;
  return shouldSkipFetch(last, now);
}

/**
 * 백그라운드 갱신에서 서버 호출을 건너뛸지: 두 시장이 모두 닫혀 있고, 다음 개장 전이고, 마지막으로 받은 지 2시간 안이면 건너뛴다.
 * 브리핑이 나오는 시간(08:20~09:30, 15:50~17:00 KST)은 휴장이어도 건너뛰지 않는다 (알림이 늦지 않게).
 * 보유 종목의 연장 세션(ext — 미국 프리·애프터·주간거래 등)이 열려 있으면 장중처럼 건너뛰지 않는다 (위젯 리뷰 1 — 예전에는 이 시간에 최대 2시간 멈췄다).
 * 받아 둔 응답의 칩은 플래그로 거른 것(payloadMarket)을 넘긴다
 */
export const CLOSED_REFRESH_MS = 2 * 3_600_000;
export function shouldSkipFetch(last: { at: number; market: WidgetMarket | null } | null, now: number): boolean {
  if (!last?.market || last.market.open || extOpen(last.market)) return false;
  if (now - last.at >= CLOSED_REFRESH_MS) return false;
  const next = last.market.nextChangeAt ? Date.parse(last.market.nextChangeAt) : NaN;
  if (!Number.isFinite(next) || now >= next) return false;
  const kst = new Date(now + 9 * 3_600_000);
  const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if ((m >= 8 * 60 + 20 && m < 9 * 60 + 30) || (m >= 15 * 60 + 50 && m < 17 * 60)) return false;
  return true;
}
