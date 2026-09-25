import type { Quote, QuoteSession } from "../domain/types.js";
import type { MarketStatus } from "../providers/market/calendar.js";
import type { MarketIndex } from "../providers/market/indices.js";
import type { Briefing } from "./briefingService.js";
import type { RegisteredWithQuote } from "./stockService.js";

/**
 * 홈 화면 위젯 한 번에 필요한 것만 (3-16). 위젯 3종이 이 응답 하나를 같이 쓴다.
 *  - 시세는 위젯이 쓰는 칸만(가격·등락·통화·시각·환율·지연 표시), 평가는 그대로
 *  - 장 상태 칩: 앱 잔고 탭 띠와 같은 규칙(/api/market/status 기준). 새 앱이 물을 때(?sessions=1)만, 달력으로는 닫혀 있어도 보유 미국 종목의
 *    프리·애프터·주간거래가 열려 있으면 문구만 그 세션 이름(앱 잔고 상태 줄과 같은 말). 예전 앱(쿼리 없음)에는 예전처럼 달력만 본 칩 —
 *    예전 앱이 위젯을 바로 그릴 때(WidgetBridge)의 칩이 달력만 보기 때문이다 (다르면 앱을 열고 닫을 때마다 칩이 번갈아 바뀐다)
 *  - 브리핑: 보유 비중(원화 환산 평가금) 상위 3종목의 최신 요약 첫 줄 (위젯이 한 줄만 보여 준다)
 *  - features: 위젯이 쓰는 기능 플래그만 (위젯은 /api/features 를 따로 받지 않는다). 예전 앱은 모르는 칸이라 무시한다
 *  - indices: 잔고 위젯 지수 줄 (코스피·나스닥·원/달러). widgetIndexLine 이 켜져 있고 새 앱이 물을 때(?indices=1)만 — 아니면 지수를 부르지도
 *    넣지도 않아 ETag 가 지수 값에 따라 바뀌지 않는다. 다만 features 칸은 늘 들어가므로 본문·ETag 가 예전(main) 서버와 바이트까지 같지는 않다
 *  - board: 지수·환율 위젯 판 9개 (APK 1.4.0). widgetMarket 이 켜져 있고 지수·환율 위젯이 있는 앱이 물을 때(?board=1)만 — 같은 규칙으로
 *    위젯이 없는 사용자의 응답·ETag 는 판과 무관하다
 *  - 새 앱(&ui=2 — 다듬은 잔고 위젯·브리핑 안내를 그릴 수 있는 앱)에만: brief(브리핑 시간·최신 브리핑 실패 수, BH-68).
 *    widgetPolish 가 켜져 있으면 칩의 시장별 문구(market.markets)와 지수 줄 다섯 개(코스피·코스닥·나스닥·S&P500·원/달러)도. 예전 앱의 응답은 그대로다
 *  - 세션 칩을 묻는 앱(&sessions=1)이고 widgetExtended 가 켜져 있으면 칩에 시장별 연장 세션 열림(market.ext, extendedOpen) — 칩의 다른 칸은 그대로
 */

/** 칩에 넣는 시장 하나 (다듬은 잔고 위젯): 달력으로 열려 있으면 "한국 장중"·"미국 장중", 아니면 그 시장 보유 종목의 지금 세션 이름 */
export interface ChipMarket {
  market: "KR" | "US";
  label: string;
}

export interface WidgetMarket {
  /** 칩 문구: 실시간 / 한국 장중 / 미국 장중 / 미국 주간거래·프리마켓·애프터마켓 / 휴장 / 한국 휴장 / 장 마감 */
  label: string;
  open: boolean;
  /** 시장별 거래 중 (지연 판단은 열린 시장의 시세만 본다) */
  kr: boolean;
  us: boolean;
  /** 다음에 장 상태가 바뀌는 시각 (위젯 백그라운드 갱신이 휴장 중 호출을 건너뛸 때 이때까지만) */
  nextChangeAt: string | null;
  /** 시장별 문구 (보유 종목 세션을 넘겼을 때만 — 새 앱이 두 시장을 한 칩에 그린다). 경계가 지난 세션은 넣지 않는다 */
  markets?: ChipMarket[];
  /**
   * 시장별 연장 세션 열림 (widgetExtended, extendedOpen): 달력으로는 닫혀 있지만 보유 종목이 거래되는 세션(미국 프리·애프터·주간거래 등)이 열려 있음.
   * 새 앱은 이때도 장중처럼 15분마다 갱신하고, 그 시장 시세가 30분 넘게 묵으면 '지연'을 띄운다.
   * 세션 이름 칩을 묻는 앱(&sessions=1)에만, 플래그가 켜져 있을 때만 넣는다. 예전 앱은 모르는 칸이라 무시한다
   */
  ext?: { kr: boolean; us: boolean };
}

/** 브리핑 위젯 안내 (BH-68): 알림 설정의 브리핑 시각(끈 세션은 null)과, 최신 브리핑이 실패한 종목 수 */
export interface WidgetBrief {
  morning: string | null;
  afternoon: string | null;
  weekdaysOnly: boolean;
  failed: number;
}

/**
 * 짧은 키 (응답을 gzip 2KB 안으로). 앱 widgets/payload.ts 가 RegisteredWithQuote 모양으로 되돌린다.
 *  - 손익·수익률은 보내지 않고 앱에서 평가금 − 매입금으로 계산 (서버 evaluate 와 같은 식)
 */
export interface WidgetStock {
  c: string; // 코드
  n: string; // 이름
  qty: number | null;
  avg: number | null;
  /** 시세: [가격, 전일 대비, 등락률 %, 통화, 시세 시각 ISO, 환율|null, 지연 1|0] */
  q: [number, number, number, "KRW" | "USD", string, number | null, 0 | 1] | null;
  /** 평가: [평가금, 매입금, 비용 차감 평가금|null, 원화 매입금|null, 원화 매입금 출처|null] */
  e: [number, number, number | null, number | null, "exact" | "estimated" | null] | null;
}

/**
 * 잔고 위젯 지수 줄 한 항목: 앱 지수 띠(/api/market/indices?stale=1)와 같은 값·같은 stale 규칙.
 * 서버가 출처에서 받은 시각(fetchedAt)은 넣지 않는다 — 30초마다 바뀌어 값이 같아도 ETag 가 달라지므로
 */
export interface WidgetIndex {
  code: string;
  name: string;
  value: number;
  change: number;
  changeRate: number;
  open: boolean;
  /** 출처 조회가 실패해 마지막 정상값 (새 앱은 흐리게 + "지연") */
  stale?: true;
  /** 출처의 시세 시각 */
  asOf?: string;
}

/** 위젯 지수 줄 항목과 순서 (앱 widgets/payload.ts 의 WIDGET_INDEX_CODES 와 같다) */
export const WIDGET_INDEX_CODES = ["KOSPI", "NASDAQ", "USDKRW"] as const;

/** 다듬은 잔고 위젯(widgetPolish)의 지수 줄: 국내 둘 · 미국 둘 · 원/달러. 앱이 계좌 비중으로 순서를 고른다 (앱 widgets/payload.ts 의 WIDGET_LINE_CODES 와 같다) */
export const WIDGET_LINE_CODES = ["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "USDKRW"] as const;

/** 지수·환율 위젯 판 항목과 순서: 국내 → 미국 → 환율 (앱 widgets/payload.ts 의 WIDGET_BOARD_CODES 와 같다) */
export const WIDGET_BOARD_CODES = ["KOSPI", "KOSDAQ", "NASDAQ", "SPX", "DJI", "SOX", "USDKRW", "JPYKRW", "CNYKRW"] as const;

/** 위젯이 쓰는 기능 플래그 */
export interface WidgetFeatures {
  widgetPnlToggle: boolean;
  widgetIndexLine: boolean;
  /** 지수·환율 위젯 (새 서버는 늘 준다. 없으면 새 앱은 꺼짐으로 본다) */
  widgetMarket?: boolean;
  /** 다듬은 잔고 위젯 (없으면 새 앱은 꺼짐 — 예전 모습) */
  widgetPolish?: boolean;
  /** 연장 세션(프리·애프터·주간거래)도 장중처럼 갱신·'지연' 판단 (없으면 새 앱은 꺼짐 — 예전처럼 휴장 규칙) */
  widgetExtended?: boolean;
}

export interface WidgetPayload {
  v: 1;
  market: WidgetMarket | null;
  stocks: WidgetStock[];
  briefings: Array<{ id: number; code: string; name: string; session: string; date: string; summary: string; createdAt: string }>;
  /** 모든 종목의 최신 브리핑 id (앱 백그라운드 알림이 새 브리핑이 있을 때만 전체 목록을 받게) */
  latestIds: number[];
  /** 위젯 기능 플래그 (새 서버). 없으면 새 앱은 모두 꺼짐으로 본다 */
  features?: WidgetFeatures;
  /** 지수 줄 (widgetIndexLine 이 켜져 있고 지수를 받았을 때만) */
  indices?: WidgetIndex[];
  /** 지수·환율 위젯 판 9개 (widgetMarket 이 켜져 있고 ?board=1 이고 지수를 받았을 때만) */
  board?: WidgetIndex[];
  /**
   * 최근 성공한 계좌 한 장 브리핑 id (3-31, 플래그 accountBriefing 이 켜져 있고 있을 때만). 앱 백그라운드 알림이 새 계좌 브리핑을 알아보게 —
   * 종목 브리핑이 모두 실패한 세션도 서버 푸시처럼 1건. 예전 앱은 모르는 칸이라 무시한다
   */
  accountIds?: number[];
  /** 브리핑 시간·최신 브리핑 실패 수 (새 앱 &ui=2 만, BH-68) */
  brief?: WidgetBrief;
}

/** 지수 띠 목록(stale 을 아는 앱용)에서 위젯 줄(또는 판)에 넣을 것만, 정해진 순서로. 값은 그대로 (앱 지수 띠와 같은 숫자가 되게) */
export function widgetIndices(list: readonly MarketIndex[], codes: readonly string[] = WIDGET_INDEX_CODES): WidgetIndex[] {
  const byCode = new Map(list.map((i) => [i.code, i]));
  return codes.flatMap((code) => {
    const i = byCode.get(code);
    if (!i) return [];
    const row: WidgetIndex = { code: i.code, name: i.name, value: i.value, change: i.change, changeRate: i.changeRate, open: i.open };
    if (i.stale) row.stale = true;
    if (i.asOf) row.asOf = i.asOf;
    return [row];
  });
}

/** 시장 하나의 지금 세션 (잔고 상태 줄 앞머리 한 칸 · 위젯 칩이 고르는 세션) */
export interface SessionView {
  market: "KR" | "US";
  label: string;
  open: boolean;
  /** 세션 경계(until)가 아직 안 지남 */
  current: boolean;
  until: string | null;
}

/**
 * 보유 종목 세션 → 시장별 지금 세션. 열린 시장 먼저, 같으면 한국 → 미국. 시장마다 경계가 아직 안 지난 세션을 쓴다 (모두 지났으면 그대로 — current false).
 * 앱 lib/liveDot 의 sessionViews 와 같은 함수다 (앱 잔고 상태 줄 marketSessions 와 위젯 칩 marketChip 이 이걸로 세션을 고른다).
 * 앱과 서버가 같은 답을 내는지는 공용 픽스처(stock-briefing/shared/fixtures/marketChip.json)로 묶어 둔다 — 한쪽을 고치면 다른 쪽도 같이
 */
export function sessionViews(sessions: readonly (QuoteSession | null | undefined)[], now: number): SessionView[] {
  const pick = new Map<"KR" | "US", SessionView>();
  for (const s of sessions) {
    if (!s) continue;
    const until = s.until ? Date.parse(s.until) : NaN;
    const current = !(Number.isFinite(until) && now >= until);
    const had = pick.get(s.market);
    if (!had || (!had.current && current)) pick.set(s.market, { market: s.market, label: s.label, open: s.open, current, until: s.until });
  }
  const order = (m: "KR" | "US") => (m === "KR" ? 0 : 1);
  return [...pick.values()].sort((a, b) => Number(b.open) - Number(a.open) || order(a.market) - order(b.market));
}

/**
 * 위젯 장 상태 칩. 앱이 위젯을 바로 그릴 때(앱 components/WidgetBridge → lib/liveDot marketChip)도 같은 함수라
 * 위젯이 받은 값과 앱이 넘긴 값이 번갈아 그려져도 칩이 바뀌지 않는다 (공용 픽스처 shared/fixtures/marketChip.json).
 *  - 토스 달력(한국 08:00~20:00, 미국은 정규장만)으로 열린 시장이 있으면 예전 문구: 실시간 / 한국 장중 / 미국 장중 (금색)
 *  - 두 시장이 달력으로 닫혀 있어도 보유 종목(sessions — 잔고 시세의 session)에 열린 세션(미국 프리·애프터·주간거래)이 있으면 문구만 그 세션 이름 —
 *    앱 잔고 상태 줄("미국 주간거래 · 한국 휴장")의 맨 앞 세션과 같은 말 (sessionViews 로 같은 세션을 고른다. 예전에는 이때 "한국 휴장"·"장 마감").
 *    open(금색)·kr·us 는 그대로 두어 위젯의 갱신 주기·지연 판단은 바뀌지 않는다
 *  - 아니면 휴장 / 한국 휴장 / 장 마감
 *  - markets: 시장별 문구 (다듬은 잔고 위젯이 "미국 주간거래 · 한국 휴장"처럼 두 시장을 한 칩에, o.markets 일 때만). 달력으로 열린 시장은 "한국 장중"·"미국 장중",
 *    닫힌 시장은 그 시장 세션 이름. 경계가 지난 세션(오프라인으로 옛 값만 있음)은 지금 세션처럼 보이지 않게 뺀다
 *  - nextChangeAt: 달력 경계(개장·마감)와, 칩 글자가 바뀔 수 있을 때만 보유 종목 세션 경계 — 열린 세션이 끝나는 때와 아직 열리지 않은 세션이 시작하는 때.
 *    세션 경계를 넣는 때: 두 시장이 달력으로 닫혀 있음(예전 칩 한 개도 세션 이름·휴장이 바뀐다 — 삼일절 09:29 "휴장"이 10:00 미국 주간거래에 바뀌게),
 *    또는 시장별 문구를 그림(o.markets — 달력으로 닫힌 시장의 세션). 달력으로 열린 시장이 있는데 시장별 문구를 그리지 않으면(예전 앱·플래그 꺼짐)
 *    "한국 장중"은 달력 마감까지 바뀌지 않으므로 넣지 않는다 — 넣으면 예전 위젯이 09:00(미국 애프터마켓 끝)에 칩과 '지연'을 감춘다 (검증 지적)
 *  - o.markets: 시장별 문구를 넣는다 (다듬은 잔고 위젯 — 서버는 &ui=2 이고 widgetPolish 가 켜져 있을 때, 앱은 WidgetBridge 가 다듬은 모습용으로)
 * sessions 를 비우면(예전 앱이 물을 때 — /api/widget 에 &sessions=1 없음) 달력만 본 예전 칩이다 (예전 앱의 WidgetBridge 와 같은 값, markets 없음)
 */
export function marketChip(s: MarketStatus, sessions: readonly (QuoteSession | null | undefined)[] = [], now: number = Date.parse(s.now), o: { markets?: boolean } = {}): WidgetMarket {
  const kr = s.KR, us = s.US;
  const t = Number.isFinite(now) ? now : Date.now();
  const calOpen = (m: "KR" | "US") => (m === "KR" ? kr : us).isOpen;
  const views = sessionViews(sessions, t);
  const bounds = [kr, us].map((m) => (m.isOpen ? m.closesAt : m.opensAt)).filter((x): x is string => !!x).sort();
  let nextChangeAt = bounds[0] ?? null;
  // 세션 경계는 칩 글자가 바뀔 수 있을 때만 (위 설명)
  const watch = (!kr.isOpen && !us.isOpen) || o.markets === true;
  for (const v of views) {
    // 경계가 지난 세션(받아 둔 시세가 지난 세션 것)은 쓰지 않는다
    const until = watch && v.current && v.until && !calOpen(v.market) ? Date.parse(v.until) : NaN;
    if (Number.isFinite(until) && (nextChangeAt === null || until < Date.parse(nextChangeAt))) nextChangeAt = new Date(until).toISOString();
  }
  const markets = views.flatMap((v): ChipMarket[] => (calOpen(v.market) ? [{ market: v.market, label: v.market === "KR" ? "한국 장중" : "미국 장중" }] : v.current ? [{ market: v.market, label: v.label }] : []));
  const base = { kr: kr.isOpen, us: us.isOpen, nextChangeAt, ...(o.markets && views.length ? { markets } : {}) };
  if (kr.isOpen || us.isOpen) return { label: kr.isOpen && us.isOpen ? "실시간" : kr.isOpen ? "한국 장중" : "미국 장중", open: true, ...base };
  const ext = views.find((v) => v.open && v.current);
  if (ext) return { label: ext.label, open: false, ...base };
  if (!kr.isTradingDay && !us.isTradingDay) return { label: "휴장", open: false, ...base };
  if (!kr.isTradingDay) return { label: "한국 휴장", open: false, ...base };
  return { label: "장 마감", open: false, ...base };
}

/**
 * 시장별 연장 세션 열림 (widgetExtended): 달력(토스 — 한국 08:00~20:00, 미국은 정규장만)으로는 닫혀 있지만, 보유 종목 중
 * 지금 세션이 열려 있고(open) 그 세션의 거래 대상으로 확인됐고(eligible true) 경계(until) 전인 종목이 있으면 true.
 * 앱 잔고 상태 줄이 '지연'을 따지는 조건(lib/liveDot liveCounts)과 같다 — 거래 대상인지 모르는 종목(eligible null)이나
 * 주간거래 미지원 종목(eligible false)만 있으면 가격이 바뀌지 않으니 장중처럼 갱신하거나 '지연'이라 하지 않는다.
 * 달력으로 열린 시장은 예전 규칙(kr·us)이 이미 장중으로 보므로 false. 앱 widgets/payload.ts 의 extendedOpen 과 같은 함수
 * (공용 픽스처 shared/fixtures/widgetExtended.json — 한쪽을 고치면 다른 쪽도 같이)
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

/** 위젯 표시에 필요한 자릿수만 (등락률 소수 2자리, 금액·가격·환율 4자리) */
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** "2026-09-24T12:03:51.000+09:00" → "2026-09-24T12:03:51+09:00" */
const shortIso = (iso: string) => iso.replace(/\.000(?=[Z+-])/, "");

/**
 * 위젯에 싣는 환율 (BH-04). 위젯은 원화 환산가를 받지 않아 환율이 비면 그 달러 종목을 원화 합계에서 뺀다 →
 * 시세에 환율이 없으면(서버 보강이 시간 초과로 끝난 시세 등) 같은 응답의 다른 달러 시세 환율, 그것도 없으면 원화 환산가 ÷ 가격
 */
function fxFor(q: Quote, shared: number | null): number | null {
  if (q.currency !== "USD") return q.fxRate ?? null;
  return q.fxRate ?? shared ?? (q.priceKrw && q.price ? q.priceKrw / q.price : null);
}

function slim(s: RegisteredWithQuote, shared: number | null): WidgetStock {
  const q = s.quote;
  const e = s.evaluation;
  const fx = q ? fxFor(q, shared) : null;
  return {
    c: s.code,
    n: s.name,
    qty: s.quantity,
    avg: s.avgPrice,
    q: q ? [r4(q.price), r4(q.change), r2(q.changeRate), q.currency, shortIso(q.asOf), fx == null ? null : r4(fx), q.stale ? 1 : 0] : null,
    // 금액은 소수 4자리까지 (달러 금액을 원화로 바꿔도 1원 미만 차이 — 앱 잔고와 같은 숫자가 되게)
    e: e ? [r4(e.marketValue), r4(e.costBasis), e.afterCost ? r4(e.afterCost.marketValue) : null, e.costBasisKrw === null ? null : r4(e.costBasisKrw), e.krwCostSource] : null,
  };
}

const krwValue = (s: RegisteredWithQuote | undefined) => {
  if (!s) return 0; // 목록을 읽는 사이에 등록·삭제된 종목
  const v = s.evaluation?.marketValue ?? 0;
  return s.quote?.currency === "USD" ? v * (s.quote.fxRate ?? 1400) : v;
};

/** 알림 설정에서 브리핑 위젯 안내에 쓰는 것만 (notifications/settings.ts 의 NotificationSettings) */
export interface BriefSchedule {
  morningTime: string;
  afternoonTime: string;
  morningEnabled: boolean;
  afternoonEnabled: boolean;
  weekdaysOnly: boolean;
}

/**
 * 브리핑 위젯 안내 (BH-68): 설정한 브리핑 시각(끈 세션은 null)과 최신 브리핑이 실패한 종목 수.
 * 위젯은 성공한 브리핑만 보여 주므로, 이것이 없으면 모두 실패했을 때 "아직 브리핑이 없습니다. 평일 08:30·16:00 …"으로 실패를 숨겼다. 설정을 모르면 null
 */
export function widgetBrief(latest: ReadonlyArray<{ latest: Pick<Briefing, "status"> | null }>, s: BriefSchedule | null): WidgetBrief | null {
  if (!s) return null;
  return {
    morning: s.morningEnabled ? s.morningTime : null,
    afternoon: s.afternoonEnabled ? s.afternoonTime : null,
    weekdaysOnly: s.weekdaysOnly,
    failed: latest.filter((b) => b.latest?.status === "failed").length,
  };
}

export function buildWidgetPayload(
  stocks: RegisteredWithQuote[],
  latest: Array<{ code: string; name: string; latest: Briefing | null }>,
  status: MarketStatus | null,
  extra: {
    features?: WidgetFeatures | undefined;
    indices?: readonly MarketIndex[] | null | undefined;
    board?: readonly MarketIndex[] | null | undefined;
    accountIds?: readonly number[] | null | undefined;
    /** 새 앱(?sessions=1): 칩에 보유 종목 세션 이름을 쓴다. 아니면 달력만 본 칩 (예전 앱의 WidgetBridge 와 같게) */
    sessions?: boolean | undefined;
    /** 다듬은 잔고 위젯을 그리는 새 앱(&ui=2)이고 widgetPolish 가 켜져 있음: 칩의 시장별 문구와 지수 줄 다섯 개 */
    polish?: boolean | undefined;
    /** 새 앱(&ui=2)에만: 브리핑 시간·실패 수 */
    brief?: WidgetBrief | null | undefined;
    /** 세션 칩을 묻는 앱(&sessions=1)이고 widgetExtended 가 켜져 있음: 칩에 시장별 연장 세션 열림(ext) */
    extended?: boolean | undefined;
  } = {},
): WidgetPayload {
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const ok = latest.filter((b) => b.latest?.status === "ok");
  // 보유 비중 큰 순 → 비중이 같으면(관심 종목) 최신 순
  ok.sort((a, b) => {
    const d = krwValue(byCode.get(b.code)) - krwValue(byCode.get(a.code));
    if (Number.isFinite(d) && d !== 0) return d;
    return a.latest!.createdAt < b.latest!.createdAt ? 1 : -1;
  });
  // 달러 환율은 종목마다 같다 → 환율이 빠진 달러 시세는 다른 달러 시세(관심 종목 포함)의 환율로
  const sharedFx = stocks.find((s) => s.quote?.currency === "USD" && s.quote.fxRate)?.quote?.fxRate ?? null;
  // 시장별 문구(와 그 경계의 nextChangeAt)는 다듬은 잔고 위젯을 그리는 새 앱에만 (예전 앱·플래그 꺼짐의 칩은 예전 그대로)
  const market = status ? marketChip(status, extra.sessions ? stocks.map((x) => x.quote?.session) : [], undefined, { markets: extra.polish === true }) : null;
  // 연장 세션(프리·애프터·주간거래): 칩의 다른 칸은 그대로 두고 표시만 더한다 (칩 문구·금색·nextChangeAt 은 앱 WidgetBridge 와 같은 marketChip 그대로)
  if (market && status && extra.extended) {
    const t = Date.parse(status.now);
    market.ext = extendedOpen({ kr: status.KR.isOpen, us: status.US.isOpen }, stocks.map((x) => x.quote?.session), Number.isFinite(t) ? t : Date.now());
  }
  const payload: WidgetPayload = {
    v: 1,
    market,
    stocks: stocks.map((s) => slim(s, sharedFx)),
    latestIds: ok.map((b) => b.latest!.id).sort((a, b) => a - b),
    briefings: ok.slice(0, 3).map((b) => ({ id: b.latest!.id, code: b.code, name: b.name, session: b.latest!.session, date: b.latest!.date, summary: b.latest!.summary.split("\n").find((l) => l.trim()) ?? "", createdAt: b.latest!.createdAt })),
  };
  if (extra.features) payload.features = extra.features;
  const indices = extra.features?.widgetIndexLine && extra.indices ? widgetIndices(extra.indices, extra.polish ? WIDGET_LINE_CODES : WIDGET_INDEX_CODES) : [];
  if (indices.length) payload.indices = indices;
  const board = extra.features?.widgetMarket && extra.board ? widgetIndices(extra.board, WIDGET_BOARD_CODES) : [];
  if (board.length) payload.board = board;
  if (extra.accountIds?.length) payload.accountIds = [...extra.accountIds];
  if (extra.brief) payload.brief = extra.brief;
  return payload;
}
