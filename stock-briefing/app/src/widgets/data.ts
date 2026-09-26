import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AccountBriefing, LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { defaultApiUrl, STORAGE_KEYS, widgetRowCurrencyOf } from "@/lib/settings";
import { fillFromLast, type PnlMode } from "./model";
import {
  canReuse,
  cleanBrief,
  fromPayload,
  gateExtended,
  NO_FEATURES,
  payloadMarket,
  REUSE_OPEN_MS,
  withExtended,
  type WidgetBrief,
  type WidgetBriefing,
  type WidgetFeatures,
  type WidgetIndex,
  type WidgetMarket,
  type WidgetPayload,
} from "./payload";
import { DEFAULT_PREFS, type NotifyPrefs } from "@/lib/briefingDigest";
import { logWidgetRefresh } from "@/lib/widgetRefreshLog";

/**
 * 위젯은 앱과 별도의 JS 컨텍스트에서 돌아가므로(react-native-android-widget 태스크 핸들러) react-query 나
 * SettingsProvider 를 쓸 수 없다. AsyncStorage 에서 서버 주소·토큰·표시 설정을 직접 읽어 서버를 호출한다.
 */

export interface WidgetData {
  stocks: RegisteredWithQuote[];
  briefings: LatestBriefing[];
  showKrw: boolean;
  afterCost: boolean;
  /** 다듬은 잔고 위젯 종목 줄 손익을 원화로 (설정 "위젯 종목 금액", 기본 원화). 없으면 원화 */
  rowKrw?: boolean;
  /** 브리핑 위젯 안내: 브리핑 시간·최신 브리핑 실패 수 (BH-68, 새 서버). 예전 서버면 null·없음 */
  brief?: WidgetBrief | null;
  fetchedAt: number;
  /** 이번 조회 실패 사유 (실패해도 stocks 에는 마지막으로 받은 값이 들어 있을 수 있다) */
  error: string | null;
  /** 이번에 받지 못해 마지막 값을 쓴 종목 코드 */
  filled: string[];
  /** 장 상태 칩 (예전 서버면 null) */
  market: WidgetMarket | null;
  /** 모든 종목의 최신 브리핑 id (새 서버). 없으면 briefings 가 전체 목록(예전 서버) */
  latestIds?: number[];
  /** 최근 계좌 한 장 브리핑 id (3-31 서버, 플래그 accountBriefing 이 켜져 있을 때). 백그라운드 알림이 새 계좌 브리핑을 알아보게 */
  accountIds?: number[];
  /** 지수 줄 (코스피·나스닥·원/달러). 예전 서버·플래그 꺼짐이면 null */
  indices: WidgetIndex[] | null;
  /** indices 를 받은 시각 (앱이 받은 지수와 어느 쪽이 새것인지 견줄 때) */
  indicesAt?: number;
  /**
   * 지수·환율 위젯 판 9개 (서버 board 또는 앱 지수 띠). 마지막으로 받은 값을 계속 둔다 — 이번 조회가 실패했거나
   * 판을 묻지 않은 조회(다른 위젯의 ↻)여도 지우지 않는다. 한 번도 못 받았으면 null
   */
  board: WidgetIndex[] | null;
  /** board 를 받은 시각 (기준 시각 표시, 앱이 받은 지수와 견줄 때, 3시간이 넘으면 모두 "지연") */
  boardAt?: number;
  /** 위젯 기능 플래그 (예전 서버면 모두 꺼짐) */
  features: WidgetFeatures;
  /** features 를 서버에서 받은 시각 (앱이 받은 /api/features 와 어느 쪽이 새것인지 견줄 때). 모르면 없음 */
  featuresAt?: number;
  /**
   * 이번 조회에서 서버에 물었는지 (loadWidgetData 만 채운다 — 받아 둔 응답을 다시 쓰면 false). 자동 갱신 기록이 '서버를 부른 갱신'만
   * 평균 간격에 세도록 (lib/widgetRefreshLog, 통합 검증 지적). 저장하지 않는다
   */
  asked?: boolean;
}

const LAST_KEY = "widget.lastStocks";

/**
 * 마지막으로 받은 잔고 (위젯이 조회에 실패해도 숫자를 지우지 않게). 앱이 받은 데이터도 여기에 적는다.
 * 서버 주소와 함께 적고, 주소가 바뀌면 쓰지 않는다 (다른 서버·계좌의 잔고가 보이지 않게).
 */
export async function saveLastStocks(stocks: RegisteredWithQuote[], at: number, apiUrl: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_KEY, JSON.stringify({ at, apiUrl, stocks }));
  } catch {
    /* 저장 실패는 무시 */
  }
}

export async function readLastStocks(apiUrl: string): Promise<{ at: number; stocks: RegisteredWithQuote[] } | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_KEY);
    const v = raw ? (JSON.parse(raw) as { at?: unknown; apiUrl?: unknown; stocks?: unknown }) : null;
    if (!v || typeof v.at !== "number" || !Array.isArray(v.stocks) || v.apiUrl !== apiUrl) return null;
    return { at: v.at, stocks: v.stocks as RegisteredWithQuote[] };
  } catch {
    return null;
  }
}

/**
 * 앱이 받은 잔고로 위젯을 그릴 때: 시세가 빠진 종목은 마지막 값으로 채우고, 그 결과를 다음 실패 대비로 적어 둔다.
 * at 은 앱이 그 잔고를 받은 시각 (react-query dataUpdatedAt). 마지막 잔고가 그보다 늦게 받은 것이면(앱이 다른 탭에 있는 동안 백그라운드 작업이 받음)
 * 덮지 않는다 — 조회가 실패했을 때 더 옛 숫자로 되돌아가지 않게 (통합 검증 지적)
 */
export async function withLastGood(stocks: RegisteredWithQuote[], at: number): Promise<{ stocks: RegisteredWithQuote[]; filled: string[] }> {
  const { apiUrl } = await readSettings();
  const last = await readLastStocks(apiUrl);
  const f = fillFromLast(stocks, last?.stocks ?? null, at);
  if (!(last && last.at > at)) await saveLastStocks(f.stocks, at, apiUrl);
  return f;
}

/** 받은 시세 중 가장 늦은 시세 시각 (ms). codes 에 있는 종목만 본다. 시세가 하나도 없으면 0 */
function latestQuoteAt(stocks: readonly RegisteredWithQuote[], codes: ReadonlySet<string>): number {
  let best = 0;
  for (const s of stocks) {
    if (!codes.has(s.code)) continue;
    const t = s.quote ? Date.parse(s.quote.asOf) : NaN;
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

/**
 * a 의 잔고가 b 보다 새 데이터인지 (위젯 리뷰 5 통합 검증 지적). fetchedAt 은 그 잔고를 받은 시각이다 — 서버 응답은 조회 시각,
 * 앱 즉시 갱신은 앱이 잔고를 받은 시각(react-query dataUpdatedAt, refresh.tsx). 위젯에 넘긴 시각으로 견주면 앱이 떠날 때 넘긴 09:48 잔고가
 * 10:00 서버 응답을 이겼다. 시세 시각(가장 늦은 asOf)도 뒤지지 않아야 한다 — 받은 시각을 모르는 기록(업데이트 전에 넘긴 시각으로 적은 것)도 막는다.
 * 시세 시각은 두 기록에 모두 있는 종목끼리만 견준다 (2차 검증 지적): 목록 전체로 견주면 앱에서 지운 종목의 시세가 가장 늦을 때
 * (미국 장 시간·주말에 하나뿐인 미국 종목을 지움) 목록이 달라진 더 새 앱 기록이 더 옛 서버 응답에 져서, 지운 종목이 위젯에 다시 보였다
 * (받아 둔 응답을 다시 쓰는 동안 — 장중 15분·휴장 최대 2시간). 겹치는 종목이 없으면(목록을 통째로 바꿈) 받은 시각만 본다.
 * 잔고가 빈 기록은 새것으로 보지 않는다
 */
function fresherStocks(a: Pick<WidgetData, "stocks" | "fetchedAt">, b: Pick<WidgetData, "stocks" | "fetchedAt">): boolean {
  if (a.stocks.length === 0 || a.fetchedAt <= b.fetchedAt) return false;
  const inA = new Set(a.stocks.map((s) => s.code));
  const both = new Set(b.stocks.filter((s) => inA.has(s.code)).map((s) => s.code));
  return latestQuoteAt(a.stocks, both) >= latestQuoteAt(b.stocks, both);
}

/**
 * 마지막으로 그린 잔고가 out 보다 새 데이터면 그 잔고·채운 종목·칩·기준 시각을 쓴다. 칩은 그 기록에 없으면(앱이 장 상태를 받기 전에 그림)
 * out 의 칩을 둔다 — 멀쩡한 칩과 '지연' 판단이 최대 15분 사라지지 않게 (통합 검증 지적). 바꿨으면 true
 */
function takeFresherStocks(out: WidgetData, prev: StoredView | null): boolean {
  if (!prev || !fresherStocks(prev, out)) return false;
  out.stocks = prev.stocks;
  out.filled = prev.filled;
  out.market = prev.market ?? out.market;
  out.fetchedAt = prev.fetchedAt;
  return true;
}

async function readSettings(): Promise<{ apiUrl: string; apiToken: string; showKrw: boolean; afterCost: boolean; rowKrw: boolean }> {
  const pairs = await AsyncStorage.multiGet([STORAGE_KEYS.apiUrl, STORAGE_KEYS.apiToken, STORAGE_KEYS.showKrw, STORAGE_KEYS.afterCost, STORAGE_KEYS.widgetRowCurrency]).catch(() => []);
  const m = new Map(pairs);
  return {
    apiUrl: m.get(STORAGE_KEYS.apiUrl) || defaultApiUrl(),
    // 토큰은 앱(lib/settings storedToken)과 같은 규칙: 저장한 적 없으면 번들 기본 토큰, 사용자가 비웠으면(공백) 빈 값 → 헤더를 보내지 않는다 (BH-66)
    apiToken: (m.get(STORAGE_KEYS.apiToken) ?? process.env.EXPO_PUBLIC_API_TOKEN ?? "").trim(),
    showKrw: m.get(STORAGE_KEYS.showKrw) === "1",
    afterCost: m.get(STORAGE_KEYS.afterCost) !== "0",
    rowKrw: widgetRowCurrencyOf(m.get(STORAGE_KEYS.widgetRowCurrency)) === "krw",
  };
}

const PAYLOAD_KEY = "widget.payload";
const VIEW_KEY = "widget.view";
const PNL_KEY = "widget.pnlMode";

/** 마지막으로 그린 데이터 (표시 설정 제외). 손익 전환·↻ 직후에 서버를 부르지 않고 바로 다시 그릴 때 쓴다 */
type StoredView = Omit<WidgetData, "showKrw" | "afterCost" | "rowKrw">;

/** 브리핑 위젯은 앞의 3개 요약 첫 줄만 쓰므로 그만큼만 적는다 (예전 서버의 전체 목록·상세를 저장하지 않게) */
function slimBriefings(list: LatestBriefing[]): LatestBriefing[] {
  return list
    .filter((b) => b.latest && b.latest.status === "ok")
    .slice(0, 3)
    .map((b) => ({ ...b, latest: b.latest ? { ...b.latest, detail: "" } : null }));
}

export async function saveWidgetView(data: WidgetData, apiUrl: string): Promise<void> {
  const { showKrw: _k, afterCost: _a, rowKrw: _r, asked: _q, ...rest } = data;
  const view: StoredView = { ...rest, briefings: slimBriefings(data.briefings) };
  try {
    await AsyncStorage.setItem(VIEW_KEY, JSON.stringify({ apiUrl, view }));
  } catch {
    /* 저장 실패는 무시 */
  }
}

async function readWidgetView(apiUrl: string): Promise<StoredView | null> {
  try {
    const raw = await AsyncStorage.getItem(VIEW_KEY);
    const v = raw ? (JSON.parse(raw) as { apiUrl?: unknown; view?: Partial<StoredView> }) : null;
    const d = v?.view;
    if (!v || v.apiUrl !== apiUrl || !d || typeof d.fetchedAt !== "number" || !Array.isArray(d.stocks)) return null;
    return {
      stocks: d.stocks,
      briefings: Array.isArray(d.briefings) ? d.briefings : [],
      fetchedAt: d.fetchedAt,
      error: typeof d.error === "string" ? d.error : null,
      filled: Array.isArray(d.filled) ? d.filled : [],
      market: d.market ?? null,
      ...(d.latestIds ? { latestIds: d.latestIds } : {}),
      indices: Array.isArray(d.indices) ? d.indices : null,
      ...(typeof d.indicesAt === "number" ? { indicesAt: d.indicesAt } : {}),
      // 1.3.0 앱이 적은 기록에는 없다 → 판 없음
      board: Array.isArray(d.board) ? d.board : null,
      ...(typeof d.boardAt === "number" ? { boardAt: d.boardAt } : {}),
      features: { ...NO_FEATURES, ...(d.features ?? {}) },
      ...(typeof d.featuresAt === "number" ? { featuresAt: d.featuresAt } : {}),
      brief: cleanBrief(d.brief),
    };
  } catch {
    return null;
  }
}

/** 손익 칸이 보여 주는 것: 누적(기본) 또는 당일 */
export async function readPnlMode(): Promise<PnlMode> {
  try {
    return (await AsyncStorage.getItem(PNL_KEY)) === "day" ? "day" : "cumulative";
  } catch {
    return "cumulative";
  }
}

export async function setPnlMode(mode: PnlMode): Promise<void> {
  await AsyncStorage.setItem(PNL_KEY, mode).catch(() => undefined);
}

/** 누적 ↔ 당일을 바꾸고 바뀐 값을 돌려준다 */
export async function togglePnlMode(): Promise<PnlMode> {
  const next: PnlMode = (await readPnlMode()) === "day" ? "cumulative" : "day";
  await setPnlMode(next);
  return next;
}

/**
 * 서버를 부르지 않고 마지막으로 그린 데이터 (손익 전환, ↻ 를 누른 직후 "갱신 중" 표시).
 * 아직 적어 둔 것이 없으면(업데이트 직후) 마지막 잔고·마지막 /api/widget 응답으로 만든다
 */
export async function loadCachedWidgetData(): Promise<WidgetData> {
  const { apiUrl, showKrw, afterCost, rowKrw } = await readSettings();
  const view = await readWidgetView(apiUrl);
  if (view) return { ...view, showKrw, afterCost, rowKrw };
  const [last, cached] = await Promise.all([readLastStocks(apiUrl), readCachedPayload(apiUrl)]);
  const p = cached ? fromPayload(cached.body) : null;
  return {
    stocks: last?.stocks ?? p?.stocks ?? [],
    briefings: p?.briefings ?? [],
    showKrw,
    afterCost,
    rowKrw,
    brief: p?.brief ?? null,
    fetchedAt: last?.at ?? cached?.at ?? Date.now(),
    error: null,
    filled: [],
    market: p?.market ?? null,
    ...(cached?.body.latestIds ? { latestIds: cached.body.latestIds } : {}),
    indices: p?.indices ?? null,
    ...(p?.indices && cached ? { indicesAt: cached.at } : {}),
    board: p?.board ?? null,
    ...(p?.board && cached ? { boardAt: cached.at } : {}),
    features: p?.features ?? NO_FEATURES,
    ...(cached ? { featuresAt: cached.at } : {}),
  };
}

/** 받은 시각이 가장 늦은 것 (같으면 앞의 것) */
function newest<T extends { at: number }>(known: (T | null | undefined)[]): T | null {
  let best: T | null = null;
  for (const k of known) if (k && (!best || k.at > best.at)) best = k;
  return best;
}

/**
 * 앱이 받은 잔고로 위젯을 그릴 때의 데이터 (refreshWidgets). 지수와 기능 플래그는 앱이 받은 것과 위젯이 받아 둔 것
 * (마지막 /api/widget 응답·마지막으로 그린 데이터) 중 받은 시각이 늦은 쪽을 쓴다.
 * 앱 캐시는 기기에 최대 7일 남고, 플래그는 브리핑·설정 화면을 열 때만 다시 받으므로 옛 값일 수 있다 —
 * 늘 앱 값을 쓰면 관리자가 끈 기능(예: widgetPnlToggle)이 앱을 열 때마다 되살아난다.
 * 잔고·칩·기준 시각도 같은 규칙 (통합 검증 지적): 마지막으로 그린 잔고(백그라운드 작업이 받은 응답)가 앱이 넘긴 잔고보다 새 데이터면
 * (앱이 다른 탭에 있는 동안 잔고를 다시 받지 않았는데 백그라운드 작업은 받음) 그쪽을 둔다 — 앱이 떠날 때 넘긴 옛 잔고로 되돌아가지 않게.
 * 그린 데이터는 적어 둔다 (손익 전환 때 같은 값으로 다시 그리게)
 */
export async function pushWidgetData(o: {
  stocks: RegisteredWithQuote[];
  filled: string[];
  showKrw: boolean;
  afterCost: boolean;
  /** 잔고를 받은 시각 (앱: react-query dataUpdatedAt, 백그라운드 작업: 위젯 조회 시각) — 넘기는 시각이 아니다 */
  fetchedAt: number;
  market: WidgetMarket | null;
  /** 다듬은 잔고 위젯용 칩 (시장별 문구와 그 경계). 아래에서 고른 플래그가 widgetPolish 일 때만 market 대신 쓴다 — 주지 않으면 market */
  marketPolished?: WidgetMarket | null;
  briefings?: LatestBriefing[];
  /** 앱이 받은 기능 플래그와 받은 시각 (react-query dataUpdatedAt) */
  features?: { at: number; flags: WidgetFeatures } | null;
  indices?: { at: number; list: WidgetIndex[] } | null;
  /** 지수·환율 위젯 판 (앱 지수 띠 9개와 받은 시각) */
  board?: { at: number; list: WidgetIndex[] } | null;
  /** 종목 줄 손익을 원화로 (앱 설정 값). 주지 않으면(백그라운드 작업) 저장된 설정 */
  rowKrw?: boolean;
}): Promise<WidgetData> {
  const now = Date.now();
  const { apiUrl, rowKrw } = await readSettings();
  const [prev, cached] = await Promise.all([readWidgetView(apiUrl), readCachedPayload(apiUrl)]);
  const p = cached ? fromPayload(cached.body) : null;
  const idx = newest([
    o.indices,
    prev?.indices ? { at: prev.indicesAt ?? prev.fetchedAt, list: prev.indices } : null,
    p?.indices && cached ? { at: cached.at, list: p.indices } : null,
  ]);
  // 판도 같은 규칙: 앱 지수 띠·마지막으로 그린 판·받아 둔 응답 중 받은 시각이 늦은 쪽
  const board = newest([o.board?.list.length ? o.board : null, boardOf(prev), p?.board && cached ? { at: cached.at, list: p.board } : null]);
  // 플래그: 받은 시각을 모르는 값(시각 없는 옛 기록)은 견주지 않는다
  const flags = newest([
    o.features,
    prev && prev.featuresAt !== undefined ? { at: prev.featuresAt, flags: prev.features } : null,
    p && cached ? { at: cached.at, flags: p.features } : null,
  ]);
  const features = flags?.flags ?? NO_FEATURES;
  // 다듬은 모습을 그릴 때만 시장별 문구가 있는 칩 (예전 모습은 그 경계에서 칩을 감추면 안 된다).
  // 연장 세션 표시(ext, widgetExtended)는 서버와 같은 규칙으로 잔고 시세의 세션에서 붙인다 — 서버 칩과 같은 갱신 주기·'지연' (위젯 리뷰 1)
  const chip = features.polish && o.marketPolished !== undefined ? o.marketPolished : o.market;
  const data: WidgetData = {
    stocks: o.stocks,
    briefings: o.briefings ?? prev?.briefings ?? p?.briefings ?? [],
    showKrw: o.showKrw,
    afterCost: o.afterCost,
    rowKrw: o.rowKrw ?? rowKrw,
    // 브리핑 안내(BH-68)는 위젯이 마지막으로 받은 응답의 것 — 앱은 따로 받지 않는다. 백그라운드 작업은 방금 받은 응답을 적어 두고 부르므로 그 값이다.
    // 마지막으로 그린 데이터(앱이 넘긴 것은 그보다 앞선 응답의 값을 옮겨 적은 것)보다 받아 둔 응답을 먼저 본다
    brief: p ? p.brief : (prev?.brief ?? null),
    fetchedAt: o.fetchedAt,
    error: null,
    filled: o.filled,
    // 세션 경계(until)는 지금 시각으로 본다 (잔고를 받은 시각이 아니라)
    market: withExtended(chip, features, o.stocks, now),
    ...(prev?.latestIds ? { latestIds: prev.latestIds } : {}),
    indices: idx?.list ?? null,
    ...(idx ? { indicesAt: idx.at } : {}),
    board: board?.list ?? null,
    ...(board ? { boardAt: board.at } : {}),
    features,
    ...(flags ? { featuresAt: flags.at } : {}),
  };
  // 마지막으로 그린 잔고가 더 새 데이터면 그 잔고·칩·기준 시각 (그 칩의 연장 세션 표시는 고른 플래그로 다시 거른다)
  if (takeFresherStocks(data, prev)) data.market = gateExtended(data.market, features);
  await saveWidgetView(data, apiUrl);
  // 자동 갱신 기록 (위젯 리뷰 2): 앱이 바로 그린 것만 app 으로 — 앱(WidgetBridge)은 늘 rowKrw 를 넘기고, 백그라운드 작업은 넘기지 않는다
  // (refresh.tsx 의 약속. 백그라운드 작업은 lib/backgroundBriefings 가 background 로 따로 적는다). 시각은 넘긴 때
  if (o.rowKrw !== undefined) await logWidgetRefresh("app", "ok", { at: now });
  return data;
}

/** 마지막으로 그린 판과 받은 시각 (없으면 null) */
function boardOf(v: Pick<WidgetData, "board" | "boardAt" | "fetchedAt"> | null): { at: number; list: WidgetIndex[] } | null {
  return v?.board?.length ? { at: v.boardAt ?? v.fetchedAt, list: v.board } : null;
}

/**
 * 마지막으로 받은 /api/widget 응답 (ETag 로 304 를 받으면 이걸 쓴다, 백그라운드 갱신이 휴장 중 호출을 건너뛸지 판단).
 * 지금 앱의 요청 주소(WIDGET_PATH)로 받은 것만 — 주소가 바뀌기 전(OTA 전 ?indices=1)에 받은 응답은 서버가 다른 칩(달력만 본 칩)을 준 것이라,
 * 다시 쓰면 앱이 바로 그린 세션 칩("미국 주간거래")과 위젯이 스스로 갱신할 때의 옛 칩("한국 휴장")이 최대 2시간 번갈아 보인다
 */
export async function readCachedPayload(apiUrl?: string): Promise<{ at: number; etag: string | null; body: WidgetPayload; briefingsAt?: number } | null> {
  try {
    const url = apiUrl ?? (await readSettings()).apiUrl;
    const raw = await AsyncStorage.getItem(PAYLOAD_KEY);
    const v = raw ? (JSON.parse(raw) as { at?: unknown; apiUrl?: unknown; path?: unknown; etag?: unknown; body?: unknown; briefingsAt?: unknown }) : null;
    if (!v || typeof v.at !== "number" || v.apiUrl !== url || v.path !== WIDGET_PATH || !v.body) return null;
    return { at: v.at, etag: typeof v.etag === "string" ? v.etag : null, body: v.body as WidgetPayload, ...(typeof v.briefingsAt === "number" ? { briefingsAt: v.briefingsAt } : {}) };
  } catch {
    return null;
  }
}

/**
 * 앱이 브리핑 위젯에 넘긴 3종목(refresh.tsx pickWidgetBriefings)을 위젯이 받아 둔 /api/widget 응답에도 적는다 (위젯 검토 7번 검증 지적 —
 * 새 브리핑 → 옛 브리핑 되돌아감 막기. 통합 때 refresh.tsx 에서 이 저장 키의 주인인 이 파일로 옮겼다).
 * 위젯이 스스로 갱신할 때(주기·추가·크기 변경 — 폴드8 은 접고 펼 때마다)와 조회에 실패했을 때는 이 응답을 다시 쓰고(loadWidgetData),
 * 브리핑도 그 응답의 것으로 그려 앱이 넘긴 새 브리핑이 옛것으로 되돌아갔다 (휴장이면 최대 2시간).
 * 응답의 브리핑만 바꾸고 받은 시각·ETag·잔고·지수·칩·알림용 id 는 그대로 둔다: 서버가 바뀐 것 없다고(304) 답하면 이 브리핑 그대로, 새 응답(200)이면 서버 목록.
 * 앱 목록을 받은 시각(briefingsAt)도 함께 적는다 — 그보다 먼저 받은 앱 목록(메모리에 남은 옛 목록)이 다시 덮지 않게 (refresh.tsx appBriefingsToDraw).
 * 응답이 앱 목록보다 늦게 받은 것이거나, 고르는 동안 위젯·백그라운드 작업이 새 응답을 적었으면(받은 시각이 다름) 건드리지 않는다. 실패해도 그린 것은 그대로다
 */
export async function carryBriefingsIntoPayload(picked: readonly LatestBriefing[], appAt: number): Promise<void> {
  try {
    const { apiUrl } = await readSettings();
    const cached = await readCachedPayload(apiUrl);
    if (!cached || cached.at > appAt) return;
    const raw = await AsyncStorage.getItem(PAYLOAD_KEY);
    const v = raw ? (JSON.parse(raw) as { at?: unknown; body?: WidgetPayload }) : null;
    if (!v?.body || v.at !== cached.at) return;
    const briefings = picked.flatMap((b): WidgetBriefing[] =>
      b.latest ? [{ id: b.latest.id, code: b.code, name: b.name, session: b.latest.session, date: b.latest.date, summary: b.latest.summary, createdAt: b.latest.createdAt }] : [],
    );
    await AsyncStorage.setItem(PAYLOAD_KEY, JSON.stringify({ ...v, briefingsAt: appAt, body: { ...v.body, briefings } }));
  } catch {
    /* 적지 못하면 다음 서버 응답까지 위젯이 스스로 갱신할 때 옛 브리핑이 보일 수 있다 (예전과 같음) */
  }
}

class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const LEGACY_KEY = "widget.legacyServer";
/**
 * 예전 서버(/api/widget 없음)로 본 뒤 다시 묻기까지 (위젯 리뷰 6): 예전 6시간 → 10분. 지금 쓰는 서버는 모두 /api/widget 이 있어
 * 이 모드에 들어가는 것은 거의 늘 잘못 본 것(배포 중 404 등)이고, 그동안 지수·환율 위젯이 '표시할 수 없습니다'로 바뀌고 잔고 위젯 칩이 빠졌다
 */
const LEGACY_RECHECK_MS = 10 * 60_000;

/**
 * 받은 본문이 JSON 이 아님 (와이파이 로그인 페이지·프록시 오류 페이지 같은 HTML). 서버에 닿지 못한 것이므로 '갱신 실패 · 연결 안 됨'
 * (model.failureText 가 '연결'로 알아본다) — 예전에는 예전 서버로 보고 6시간 동안 예전 API 로 바꿨다
 */
const NOT_JSON = "연결 안 됨: 서버 대신 다른 페이지가 응답함";

/** 본문을 JSON 으로 (HTML·깨진 본문이면 연결 오류) */
async function jsonBody<T>(res: Response): Promise<T> {
  const text = await res.text().catch(() => "");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(NOT_JSON);
  }
}

/** HTML 페이지 응답인지 (로그인 페이지·프록시 오류 페이지). 본문을 읽으므로 이 응답의 본문은 더 쓰지 않을 때만 */
async function isHtml(res: Response): Promise<boolean> {
  if (/text\/html/i.test(res.headers.get("content-type") ?? "")) return true;
  return /^\s*</.test(await res.text().catch(() => ""));
}

/**
 * ok 가 아닌 응답이 서버 대신 와이파이 로그인 페이지·프록시가 준 것인지 (통합 검증 지적): 511(네트워크 로그인 필요)이나 4xx 인데 HTML 이면
 * 서버에 닿지 못한 것 → '갱신 실패 · 연결 안 됨'. 우리 서버(Fastify)의 4xx 는 늘 JSON 이다.
 * 5xx HTML(511 빼고)은 서버 앞단(호스팅)의 오류 페이지라 서버 쪽 문제로 두어 '서버 오류' — 폰 인터넷을 탓하지 않게
 */
async function isPortalPage(res: Response): Promise<boolean> {
  const s = res.status;
  return (s === 511 || (s >= 400 && s < 500)) && (await isHtml(res));
}

/** 예전 서버라 /api/widget 이 없던 기록 (10분 동안은 묻지 않고 예전 API 로 — 호출이 늘지 않게) */
async function legacyUntil(apiUrl: string): Promise<number> {
  try {
    const v = JSON.parse((await AsyncStorage.getItem(LEGACY_KEY)) ?? "null") as { apiUrl?: string; until?: number } | null;
    return v?.apiUrl === apiUrl && typeof v.until === "number" ? v.until : 0;
  } catch {
    return 0;
  }
}

/**
 * 위젯 응답 주소. indices=1 은 "지수 줄을 그릴 수 있는 앱"이라는 표시다 — 서버는 이 표시가 있을 때만 지수를 넣는다
 * (지수를 그리지 않는 예전 앱은 지수 때문에 304 대신 200 을 받지 않게). 예전 서버는 모르는 쿼리를 무시한다.
 * sessions=1 은 "앱이 위젯을 바로 그릴 때도 세션 이름 칩을 그린다"는 표시다 (components/WidgetBridge → lib/liveDot widgetChip) —
 * 서버는 이 표시가 있을 때만 칩에 보유 종목 세션 이름(미국 주간거래 등)을 쓴다. 예전 앱(표시 없음)은 달력만 본 칩을 그리므로 서버도 그렇게 준다
 * (둘이 다르면 앱을 열고 닫을 때와 위젯이 갱신할 때 칩이 번갈아 바뀐다).
 * ui=2 는 "다듬은 잔고 위젯(widgetPolish)과 브리핑 안내(BH-68)를 그릴 수 있는 앱"이라는 표시다 — 서버는 이때만 brief(브리핑 시간·실패 수)와,
 * 플래그가 켜져 있으면 칩의 시장별 문구·지수 줄 다섯 개를 넣는다 (예전 앱의 응답은 그대로). 주소가 바뀌어 OTA 뒤 첫 갱신은 받아 둔 응답을 다시 쓰지 않고 한 번 묻는다
 */
const WIDGET_PATH = "/api/widget?indices=1&sessions=1&ui=2";
/**
 * 지수·환율 위젯이 있을 때만 &board=1 (서버는 widgetMarket 이 켜져 있고 이 표시가 있을 때만 판 9개를 넣는다).
 * 위젯이 없는 사용자의 응답·ETag 는 그대로다. ETag 는 본문으로 만들므로 board 가 있는 응답과 없는 응답의 ETag 가 섞여도 304 가 잘못 나지 않는다
 */
const BOARD_QUERY = "&board=1";

/**
 * /api/widget 한 번: 304 면 저장해 둔 본문, 받으면 저장. 예전 서버(JSON·빈 본문 404, 모양이 다른 JSON 응답)면 null.
 * HTML(와이파이 로그인 페이지·프록시)이나 JSON 이 아닌 본문은 연결 오류로 던진다 — 예전 서버로 보지 않는다 (위젯 리뷰 6)
 */
async function fetchPayload(apiUrl: string, token: string, now: number, board = false): Promise<WidgetPayload | null> {
  const until = await legacyUntil(apiUrl);
  // 예전 앱이 적은 6시간짜리 기록(지금 규칙보다 긴 것)은 쓰지 않는다 — OTA 직후 바로 다시 묻게
  if (now < until && until - now <= LEGACY_RECHECK_MS) return null;
  const legacy = async () => {
    await AsyncStorage.setItem(LEGACY_KEY, JSON.stringify({ apiUrl, until: now + LEGACY_RECHECK_MS })).catch(() => undefined);
    return null;
  };
  const cached = await readCachedPayload(apiUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(`${apiUrl}${WIDGET_PATH}${board ? BOARD_QUERY : ""}`, {
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cached?.etag ? { "if-none-match": cached.etag } : {}) },
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      // 로그인 페이지·프록시의 HTML 404 는 서버에 닿지 못한 것 (예전 서버의 404 는 JSON 오류 본문 — Fastify)
      if (await isHtml(res)) throw new Error(NOT_JSON);
      return legacy();
    }
    let body: WidgetPayload | null;
    if (res.status === 304 && cached) body = cached.body;
    else if (res.ok) body = await jsonBody<WidgetPayload | null>(res); // 프록시의 HTML 대체 페이지 등은 연결 오류
    else if (await isPortalPage(res)) throw new Error(NOT_JSON); // 와이파이 로그인 511·프록시 403/407 HTML
    else throw new HttpError(res.status);
    // 모양이 다르면(예전·다른 서버) 예전 API 로
    if (!body || body.v !== 1 || !Array.isArray(body.stocks)) return legacy();
    await AsyncStorage.setItem(PAYLOAD_KEY, JSON.stringify({ at: now, apiUrl, path: WIDGET_PATH, etag: res.headers.get("etag"), body })).catch(() => undefined);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** 모든 종목의 최신 브리핑 (백그라운드 알림이 새 브리핑을 찾았을 때만) */
export async function loadLatestBriefings(): Promise<LatestBriefing[]> {
  const { apiUrl, apiToken } = await readSettings();
  return getJson<LatestBriefing[]>(`${apiUrl}/api/briefings/latest`, apiToken);
}

/**
 * 알림 규칙 (3-19): 세션당 1건 묶음·조용한 시간·끈 종목 + 브리핑 실행 중인지. 백그라운드 알림이 새 브리핑을 찾았을 때만 받는다.
 * 예전 서버(digest 없음)면 예전처럼 종목마다. 받지 못하면 null → 이번에는 알리지 않고 다음 확인에서 (잘못된 규칙으로 "본 것" 처리하지 않게)
 */
export async function loadNotifyPrefs(): Promise<(NotifyPrefs & { running: boolean }) | null> {
  const { apiUrl, apiToken } = await readSettings();
  try {
    const s = await getJson<Partial<NotifyPrefs> & { running?: boolean; schedule?: { running?: boolean } | null }>(`${apiUrl}/api/notifications/settings`, apiToken);
    const running = s.running ?? s.schedule?.running ?? false;
    if (s.digest === undefined) return { ...DEFAULT_PREFS, digest: false, running };
    return {
      digest: s.digest,
      // 3-31 서버부터. 없으면(예전 서버) 꺼짐 → 계좌 브리핑 목록을 묻지 않는다
      accountBriefing: s.accountBriefing === true,
      quietEnabled: s.quietEnabled ?? DEFAULT_PREFS.quietEnabled,
      quietStart: s.quietStart ?? DEFAULT_PREFS.quietStart,
      quietEnd: s.quietEnd ?? DEFAULT_PREFS.quietEnd,
      mutedCodes: s.mutedCodes ?? [],
      running,
    };
  } catch {
    return null;
  }
}

/**
 * 최근 계좌 한 장 브리핑 (3-31). 알림 규칙에서 accountBriefing 이 켜져 있을 때만 부른다.
 * 받지 못하면(끊김·5xx·시간 초과·예전 서버 404) null — '빈 목록'과 구분한다. 받지 못한 목록의 계좌 브리핑을 '본 것'으로 적지 않게
 */
export async function loadAccountBriefings(): Promise<AccountBriefing[] | null> {
  const { apiUrl, apiToken } = await readSettings();
  try {
    const list = await getJson<AccountBriefing[]>(`${apiUrl}/api/account-briefings?limit=4`, apiToken);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

async function getJson<T>(url: string, token: string, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: ctrl.signal });
    if (!res.ok) throw new Error((await isPortalPage(res)) ? NOT_JSON : `HTTP ${res.status}`);
    return await jsonBody<T>(res);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 판을 묻는 조회(지수·환율 위젯)가 받아 둔 응답을 다시 써도 되는지: 그 응답에 판이 있거나, 서버가 플래그를 꺼 두었거나 모르거나
 * (widgetMarket 이 true 가 아님 — 끈 서버·예전 서버는 물어도 판을 주지 않는다), 마지막으로 그린 판이 장중 재사용 시간(15분) 안에 받은 것이면.
 * 판을 주는 서버에서 판 없이 받아 둔 응답(다른 위젯이 받음)만 있으면 서버에 묻는다
 */
function boardReusable(body: WidgetPayload, prevBoardAt: number | undefined, now: number): boolean {
  if (body.board?.length || body.features?.widgetMarket !== true) return true;
  return prevBoardAt !== undefined && now - prevBoardAt < REUSE_OPEN_MS;
}

/**
 * 서버에서 위젯에 필요한 데이터를 받는다. 위젯 4종이 GET /api/widget 한 번을 같이 쓴다 (예전 서버면 예전 두 API).
 *  - 조회가 통째로 실패하면 마지막으로 받은 잔고를 그대로 돌려주고 error 에 사유를 남긴다("잔고 0"을 보이지 않게)
 *  - 일부 종목만 시세가 없으면 그 종목은 마지막 값으로 채운다
 *  - board: 지수·환율 위젯 판도 묻는다 (&board=1). 판은 받지 못해도(실패·묻지 않음) 마지막으로 받은 것을 둔다
 */
export async function loadWidgetData(opts: { stocks?: boolean; briefings?: boolean; reuse?: boolean; board?: boolean } = { stocks: true, briefings: true }): Promise<WidgetData> {
  const { apiUrl, apiToken, showKrw, afterCost, rowKrw } = await readSettings();
  const out: WidgetData = { stocks: [], briefings: [], showKrw, afterCost, rowKrw, brief: null, fetchedAt: Date.now(), error: null, filled: [], market: null, indices: null, board: null, features: NO_FEATURES };
  const last = await readLastStocks(apiUrl);
  // 판은 이번에 못 받아도 마지막 것을 둔다 (조회 전에 읽어 둔다 — 아래에서 이번 결과를 적으므로)
  const prevView = await readWidgetView(apiUrl);
  let full = false;
  /** 방금 서버에서 받은 응답인지 (304 도 서버가 지금 값이라고 답한 것) */
  let fresh = false;
  try {
    // 위젯이 스스로 갱신할 때는 백그라운드 작업이 받아 둔 응답을 다시 쓴다 (위젯마다 서버를 부르지 않게)
    const reused = opts.reuse ? await readCachedPayload(apiUrl) : null;
    // 칩은 플래그로 거른 것 (연장 세션 ext 는 widgetExtended 가 켜져 있을 때만 장중처럼 15분)
    const reuse =
      reused && canReuse({ at: reused.at, market: payloadMarket(reused.body) }, out.fetchedAt) && (!opts.board || boardReusable(reused.body, prevView?.boardAt, out.fetchedAt)) ? reused : null;
    if (reuse) out.fetchedAt = reuse.at;
    // 자동 갱신 기록: 받아 둔 응답을 다시 쓰면 서버를 부르지 않은 것 (예전 서버 모드 10분도 예전 API 로 서버에 묻는다)
    out.asked = !reuse;
    const payload = reuse ? reuse.body : await fetchPayload(apiUrl, apiToken, out.fetchedAt, opts.board === true);
    let stocks: RegisteredWithQuote[];
    if (payload) {
      const p = fromPayload(payload);
      stocks = p.stocks;
      out.briefings = p.briefings;
      out.market = p.market;
      out.indices = p.indices;
      if (p.indices) out.indicesAt = out.fetchedAt;
      out.board = p.board;
      if (p.board) out.boardAt = out.fetchedAt;
      out.features = p.features;
      out.featuresAt = out.fetchedAt;
      out.brief = p.brief;
      if (payload.latestIds) out.latestIds = payload.latestIds;
      if (Array.isArray(payload.accountIds)) out.accountIds = payload.accountIds.filter((id) => Number.isInteger(id) && id > 0);
      full = true;
      fresh = !reuse;
    } else {
      [stocks, out.briefings] = await Promise.all([
        opts.stocks ? getJson<RegisteredWithQuote[]>(`${apiUrl}/api/stocks?quotes=1`, apiToken) : Promise.resolve([]),
        opts.briefings ? getJson<LatestBriefing[]>(`${apiUrl}/api/briefings/latest`, apiToken) : Promise.resolve([]),
      ]);
      // 예전 서버는 등록 순서라 최신 순으로 (위젯은 앞의 3개를 보여 준다)
      out.briefings = [...out.briefings].sort((a, b) => ((a.latest?.createdAt ?? "") < (b.latest?.createdAt ?? "") ? 1 : -1));
      // 예전 API 로 받는 동안에도 마지막 플래그는 그대로 (위젯 리뷰 6 — 배포 중 404 한 번에 지수·환율 위젯이 '표시할 수 없습니다'로,
      // 잔고 위젯이 손익 전환·지수 줄 없는 예전 모습으로 번갈아 바뀌지 않게). 정말 예전 서버면 앱이 적은 플래그도 꺼짐이다
      if (prevView) {
        out.features = prevView.features;
        if (prevView.featuresAt !== undefined) out.featuresAt = prevView.featuresAt;
      }
    }
    const f = fillFromLast(stocks, last?.stocks ?? null, out.fetchedAt);
    out.stocks = f.stocks;
    out.filled = f.filled;
    // 채운 결과를 적는다: 채운 종목은 옛 시세 시각을 그대로 갖고 있어 7일이 지나면 더는 쓰이지 않는다.
    // 마지막 잔고가 이 응답보다 늦게 받은 것이면(앱 즉시 갱신 뒤 받아 둔 옛 응답을 다시 씀) 덮지 않는다 — 다음 조회가 실패했을 때 옛 숫자로 되돌아가지 않게 (위젯 리뷰 5)
    if ((stocks.length || payload) && !(last && last.at > out.fetchedAt)) await saveLastStocks(f.stocks, out.fetchedAt, apiUrl);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    const cached = await readCachedPayload(apiUrl);
    // 칩: 받아 둔 응답의 것(플래그로 거름), 없으면(업데이트 직후 등) 마지막으로 그린 것 — 실패했다고 칩이 사라지지 않게
    out.market = cached ? payloadMarket(cached.body) : (prevView?.market ?? null);
    if (cached) {
      const p = fromPayload(cached.body);
      out.briefings = p.briefings;
      // 지수·플래그는 마지막으로 받은 값 그대로 (실패했다고 줄이 사라지거나 손익 전환이 꺼지지 않게)
      out.indices = p.indices;
      if (p.indices) out.indicesAt = cached.at;
      out.board = p.board;
      if (p.board) out.boardAt = cached.at;
      out.features = p.features;
      out.featuresAt = cached.at;
      out.brief = p.brief;
      full = true;
    } else if (prevView) {
      // 받아 둔 응답이 없으면(업데이트 직후 첫 조회 등) 마지막으로 그린 데이터(앱 즉시 갱신이 적은 것)의 지수·플래그를 그대로 —
      // 첫 조회가 실패했다고 앱이 적어 둔 플래그가 꺼짐으로 바뀌어 판·손익 전환·지수 줄이 사라지지 않게 (판은 아래 keepBoard).
      // 브리핑도 그대로 (통합 검증 지적): 백그라운드 작업이 연달아 실패해 위젯 4종을 다시 그릴 때 브리핑 위젯이 브리핑 줄을 잃지 않게
      out.briefings = prevView.briefings;
      out.indices = prevView.indices;
      if (prevView.indicesAt !== undefined) out.indicesAt = prevView.indicesAt;
      out.features = prevView.features;
      if (prevView.featuresAt !== undefined) out.featuresAt = prevView.featuresAt;
      out.brief = prevView.brief ?? null;
    }
    if (last) {
      out.stocks = last.stocks;
      out.fetchedAt = last.at;
    }
  }
  // 방금 서버에서 받은 것이 아니면(재사용·조회 실패) 앱이 더 늦게 받아 그린 잔고·칩·기준 시각·지수·플래그를 옛 응답으로 덮지 않는다
  if (full && !fresh) await keepNewer(out, apiUrl);
  keepBoard(out, prevView);
  await saveWidgetView(full ? out : await mergeLegacy(out, apiUrl, opts), apiUrl);
  return out;
}

/**
 * 판은 받은 시각이 늦은 쪽: 이번 응답의 판 · 마지막으로 그린 판(앱 지수 띠가 적은 것 포함).
 * 이번 응답에 판이 없으면(묻지 않은 조회·조회 실패·서버 지수 조회 실패) 마지막 판을 그대로 둔다 — 숫자가 사라지지 않고,
 * 3시간이 지나면 그릴 때 모두 "지연"으로 (render.tsx agedIndices)
 */
function keepBoard(out: WidgetData, prev: Pick<WidgetData, "board" | "boardAt" | "fetchedAt"> | null): void {
  const best = newest([out.board?.length ? { at: out.boardAt ?? out.fetchedAt, list: out.board } : null, boardOf(prev)]);
  out.board = best?.list ?? null;
  if (best) out.boardAt = best.at;
  else delete out.boardAt;
}

/**
 * 받아 둔 /api/widget 응답을 다시 쓸 때(위젯 스스로 갱신 — 장중 15분·휴장 2시간까지 재사용, 조회 실패):
 * 마지막으로 그린 데이터(앱 즉시 갱신이 적은 것)의 지수·플래그가 그 응답보다 늦게 받은 것이면 그쪽을 쓴다 (pushWidgetData 와 같은 규칙).
 * 그러지 않으면 앱 갱신과 위젯 갱신이 번갈아 가며 손익 전환 칸·지수 줄이 켜졌다 꺼졌다 한다.
 * 잔고·칩·기준 시각(fetchedAt)도 같은 규칙 (위젯 리뷰 5): 10:08 앱이 그린 뒤 10:10 크기 변경(폴드 펼침)·주기 갱신이 백그라운드가
 * 10:00 에 받아 둔 응답을 다시 쓰면서 숫자·칩·'10:00 기준'으로 되돌아가 "방금 앱에서 본 금액과 다르다"가 되지 않게.
 * 견주는 것은 데이터가 새것인지다 (통합 검증 지적 — takeFresherStocks): 앱 즉시 갱신 기록의 fetchedAt 은 앱이 잔고를 받은 시각이고(넘긴 시각이 아님),
 * 시세 시각도 뒤지지 않아야 한다(두 기록에 모두 있는 종목끼리 — 앱에서 지운 종목이 되살아나지 않게). 앱이 10:08 에 넘긴 09:48 잔고는 10:00 응답을 이기지 못한다.
 * 그 기록에 칩이 없으면 응답의 칩을 둔다.
 * 조회 실패로 그린 기록의 fetchedAt 은 마지막으로 받은 잔고의 시각이라 그대로 견줄 수 있다 (잔고가 비어 있는 기록은 쓰지 않는다)
 */
async function keepNewer(out: WidgetData, apiUrl: string): Promise<void> {
  const prev = await readWidgetView(apiUrl);
  if (!prev) return;
  takeFresherStocks(out, prev);
  if (out.featuresAt === undefined) return;
  const at = out.featuresAt;
  // 응답에 지수가 없어도(플래그 꺼짐·조회 실패) 그 응답의 시각으로 견준다 — 더 옛 지수가 되살아나지 않게
  const idx = newest([{ at: out.indicesAt ?? at, list: out.indices }, prev.indices ? { at: prev.indicesAt ?? prev.fetchedAt, list: prev.indices } : null]);
  if (idx && idx.list !== out.indices) {
    out.indices = idx.list;
    out.indicesAt = idx.at;
  }
  const flags = newest([{ at, flags: out.features }, prev.featuresAt !== undefined ? { at: prev.featuresAt, flags: prev.features } : null]);
  if (flags && flags.flags !== out.features) {
    out.features = flags.flags;
    out.featuresAt = flags.at;
  }
  // 고른 칩과 고른 플래그가 서로 다른 기록에서 왔을 수 있다 → 연장 세션 표시는 고른 플래그로 다시 거른다
  out.market = gateExtended(out.market, out.features);
}

/** 예전 서버에서 한쪽만 받았으면(잔고만·브리핑만) 받지 않은 쪽은 마지막으로 그린 값을 남긴다 */
async function mergeLegacy(out: WidgetData, apiUrl: string, opts: { stocks?: boolean; briefings?: boolean }): Promise<WidgetData> {
  const prev = await readWidgetView(apiUrl);
  if (!prev) return out;
  return {
    ...out,
    ...(opts.stocks || out.stocks.length ? {} : { stocks: prev.stocks, filled: prev.filled }),
    ...(opts.briefings ? {} : { briefings: prev.briefings }),
  };
}
