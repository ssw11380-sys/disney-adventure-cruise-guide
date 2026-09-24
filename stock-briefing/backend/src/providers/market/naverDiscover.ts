import { isTimeoutError, ProviderError } from "../../lib/errors.js";
import type { FetchFn } from "./types.js";

/**
 * 발견 탭 데이터 (네이버 증권 모바일 공개 JSON, 로그인 불필요).
 *  - 한국 순위: front-api/domestic/stock/list/sorted?sortType=priceTop|quantTop|up|down&marketType=all (50개씩, index 0부터)
 *  - 미국 순위: api.stock.naver.com/stock/nation/USA/priceTop|top|up|down?page=&pageSize=100 (정규장 기준, 보통주만)
 *  - 테마·업종: front-api/stock/sectors/all?sectorType=theme|upjong&businessDayCategory=daily|weekly|monthly&nationType=domestic|USA
 *    (50개씩 cursor. 등락률은 거래정지를 뺀 구성 종목 단순 평균 = 네이버 값 그대로)
 *  - 구성 종목: 한국 front-api/domestic/sector/item/list, 미국 front-api/worldstock/sector/item/list
 *  - 미국 여러 종목 시세: polling.finance.naver.com/api/realtime/worldstock/stock/{로이터 코드,…} (정규장 값)
 * 미국은 네이버가 테마 대신 TRBC 산업 분류(137개)만 준다 → "업종"으로 쓰고, 미국 테마는 토스 테마 분류(tossTics)로 만든다.
 */

export type DiscoverMarket = "KR" | "US";
export type RankCategory = "tradingValue" | "volume" | "gainers" | "losers";
export type ThemePeriod = "day" | "week" | "month";
export type ThemeKind = "theme" | "sector";

export interface DiscoverStock {
  code: string;
  name: string;
  market: string;
  currency: "KRW" | "USD";
  price: number;
  change: number;
  changeRate: number;
  volume: number | null;
  tradingValue: number | null;
  marketCap?: number | null;
  /** 상장 첫날 (가격제한폭이 없어 등락률이 크게 나온다) */
  newlyListed?: boolean;
  /** 거래정지 (한국: 출처의 tradableStatus = halt). 테마 평균·상승/보합/하락 수에서 뺀다 */
  suspended?: boolean;
}

export interface ThemeSummary {
  id: string;
  name: string;
  changeRate: number;
  up: number;
  flat: number;
  down: number;
  leaders: { code: string; name: string; changeRate: number | null }[];
  /** 상장 첫날 종목(가격제한폭 없음)을 빼고 다시 계산한 값이면 true */
  adjusted?: boolean;
  /** changeRate 가 시가총액 가중 평균일 때 함께 주는 단순 평균 (참고) */
  simpleAvg?: number;
  /** 요약을 보이는 종목 값과 같은 시점으로 확인하지 못했으면 true (상승·보합·하락 수는 0 = 세지 않음, 이유는 note) */
  unverified?: boolean;
}

/** 미국 종목 정규장 시세 + 체결 시각 + 네이버 장 상태(OPEN/CLOSE/PREOPEN) */
export type UsQuote = DiscoverStock & { tradedAt: string | null; status?: string };

/**
 * 네이버 거래소 장 상태 한 세션 (front-api/marketStatus). 휴장일·특수일(수능 10:00 개장 등)이 반영된 실제 세션이다.
 *  - kind: preopen(개장 전) · pre(프리마켓) · regular(정규장) · after(애프터마켓·시간외) · closed(마감·휴장)
 *  - openAt·closeAt: 이 상태가 시작·끝나는 시각 (closed 면 openAt = 마지막 거래가 끝난 시각)
 */
export interface ExchangeSession {
  kind: "preopen" | "pre" | "regular" | "after" | "closed";
  label: string;
  openAt: string | null;
  closeAt: string | null;
  /** 이 세션 값의 거래일 (YYYY-MM-DD) */
  tradeBaseAt: string | null;
}
export type ExchangeStatus = { latest: ExchangeSession; next: ExchangeSession | null; isTradingDay: boolean | null };

export function exchangeSession(j: Json | undefined): ExchangeSession | null {
  const ss = j?.["session"] as Json | undefined;
  if (!ss) return null;
  const status = String(ss["marketStatusDetailType"] ?? "");
  const type = String(ss["marketSessionType"] ?? "");
  const kind: ExchangeSession["kind"] =
    status === "open" ? (type === "regularMarket" ? "regular" : type === "afterMarket" ? "after" : type === "preMarket" ? "pre" : "closed") : status === "preopen" ? "preopen" : "closed";
  const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
  return { kind, label: String(ss["displayLabel"] ?? ""), openAt: iso(ss["openAt"]), closeAt: iso(ss["closeAt"]), tradeBaseAt: typeof j?.["tradeBaseAt"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j["tradeBaseAt"] as string) ? (j["tradeBaseAt"] as string) : null };
}

/** 줄의 90% 이상이 등락률 0·거래량 0(또는 없음)인지 — 출처가 장 시작 전으로 초기화한 목록 */
export function isMostlyZero(rows: { changeRate: number; volume?: number | null }[], ratio = 0.9): boolean {
  if (!rows.length) return false;
  return rows.filter((r) => r.changeRate === 0 && !r.volume).length / rows.length >= ratio;
}

/** 장 시작 전 초기화된 미국 시세 묶음인지 (절반 넘게 PREOPEN 이면 등락률·거래량이 0 이라 쓸 수 없다) */
export function isPreopenQuotes(q: Map<string, UsQuote>): boolean {
  if (!q.size) return false;
  let pre = 0;
  for (const v of q.values()) if (v.status === "PREOPEN") pre++;
  return pre / q.size >= 0.5;
}

export interface SectorDetail {
  theme: ThemeSummary;
  description: string | null;
  items: DiscoverStock[];
}

type Json = Record<string, unknown>;

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const BASE = "https://m.stock.naver.com/front-api";
const US_BASE = "https://api.stock.naver.com";
const POLL_BASE = "https://polling.finance.naver.com";
const FETCH_TIMEOUT_MS = 10_000;
/** 폴링 한 번에 묻는 코드 수 (주소 길이 한도: 800개면 400) */
const POLL_BATCH = 500;
const SORT: Record<RankCategory, string> = { tradingValue: "priceTop", volume: "quantTop", gainers: "up", losers: "down" };
/** 미국 순위 경로 (네이버 JS 기준 거래대금 = priceTop, 거래량 = top) */
const US_SORT: Record<RankCategory, string> = { tradingValue: "priceTop", volume: "top", gainers: "up", losers: "down" };
const PERIOD: Record<ThemePeriod, string> = { day: "daily", week: "weekly", month: "monthly" };

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 앱에서 쓰는 티커: symbolCode(AAPL, "BRK B") 우선, 없으면 로이터 코드에서 만든다
 * (AAPL.O → AAPL, 클래스주 BRKb → BRK.B, 우선주 AHT_pd 처럼 앱 티커로 못 쓰는 것은 null).
 */
export function usTicker(it: Json): string | null {
  const sym = typeof it["symbolCode"] === "string" && it["symbolCode"].trim() ? it["symbolCode"] : null;
  if (sym) return appTicker(sym);
  const reuters = typeof it["reutersCode"] === "string" ? it["reutersCode"] : typeof it["code"] === "string" ? it["code"] : null;
  if (!reuters) return null;
  const base = reuters.replace(/\.[A-Z]$/, "");
  const cls = /^([A-Z0-9]+)([a-z])$/.exec(base);
  return appTicker(cls ? `${cls[1]}.${cls[2]!.toUpperCase()}` : base);
}

/** 스팩(기업인수목적회사)·ETF·ETN 은 순위에서 뺀다 (동전주·상품이 목록을 덮지 않게) */
export function isPlainStock(it: Json): boolean {
  const end = String(it["stockEndType"] ?? "stock");
  const name = String(it["name"] ?? it["stockName"] ?? "");
  return end === "stock" && !/스팩|SPAC/i.test(name);
}

/** 상장 첫날 종목 표시 (네이버 newlyListed) */
export function isNewlyListed(it: Json): boolean {
  return it["newlyListed"] === true;
}

export function krStock(it: Json): DiscoverStock | null {
  const code = String(it["itemCode"] ?? it["id"] ?? "").toUpperCase();
  const price = num(it["currentPrice"]);
  if (!code || price === null) return null;
  // 가격·등락률이 KRX 값이라 거래량·거래대금도 KRX 값으로 맞춘다 (순위 원본 정렬도 KRX 기준).
  // NXT 통합 값(krxNxtIntegratedPriceInfo)을 섞으면 기준이 어긋나고 쪽을 이어 받을 때 순서가 틀어진다.
  return {
    code,
    name: String(it["name"] ?? code),
    market: String(it["marketType"] ?? "KRX"),
    currency: "KRW",
    price,
    change: num(it["fluctuations"]) ?? 0,
    changeRate: num(it["fluctuationsRatio"]) ?? 0,
    volume: num(it["accumulatedTradingVolume"]),
    tradingValue: num(it["accumulatedTradingValue"]),
    marketCap: num(it["marketValue"]),
    ...(isNewlyListed(it) ? { newlyListed: true } : {}),
    // 거래량 0 이어도 거래 가능한 종목(코넥스 무거래 등)이 있어, 출처의 거래 가능 상태로만 거래정지를 판정한다
    ...(String(it["tradableStatus"] ?? "") === "halt" ? { suspended: true } : {}),
  };
}

/**
 * 미국 순위 한 줄 (api.stock.naver.com/stock/nation/USA/*). 정규장 기준 값이다:
 * closePrice 는 장중엔 현재가, 장 밖에서는 직전 정규장 종가이고 프리·애프터 값은 overMarketPriceInfo 에 따로 온다.
 * 권리주(RT)·워런트(WS)·우선주(PR*)·유닛(U)·SPAC 권리, 거래정지 종목은 뺀다. 클래스주 "BRK B" 는 "BRK.B" 로 바꾼다.
 */
export function usRankStock(it: Json): DiscoverStock | null {
  if (String(it["stockEndType"] ?? "stock") !== "stock") return null;
  const stop = it["tradeStopType"] as Json | undefined;
  if (stop && String(stop["name"] ?? "TRADING") !== "TRADING") return null;
  const eng = String(it["stockNameEng"] ?? "");
  const sym = appTicker(String(it["symbolCode"] ?? ""));
  if (!sym) return null; // "AHT PRD", "RIV RT", "ASGI RTWI"
  if (isUsNonCommon(eng, sym, typeof it["stockName"] === "string" ? it["stockName"] : "")) return null;
  const price = num(it["closePriceRaw"] ?? it["closePrice"]);
  if (price === null) return null;
  const ex = it["stockExchangeType"] as Json | undefined;
  const name = typeof it["stockName"] === "string" && it["stockName"].trim() ? it["stockName"].trim() : eng || sym;
  return {
    code: sym,
    name,
    market: String(ex?.["name"] ?? "US"),
    currency: "USD",
    price,
    change: num(it["compareToPreviousClosePriceRaw"]) ?? 0,
    changeRate: num(it["fluctuationsRatioRaw"]) ?? 0,
    volume: num(it["accumulatedTradingVolumeRaw"]),
    tradingValue: num(it["accumulatedTradingValueRaw"]),
    marketCap: num(it["marketValueRaw"]),
  };
}

/** 네이버 심볼 → 앱 티커. 클래스주 "BRK B" → "BRK.B", 그 밖에 공백이 남는 우선주·권리주 등은 null */
export function appTicker(raw: string): string | null {
  let sym = raw.trim().toUpperCase();
  const cls = /^([A-Z][A-Z0-9]*) ([A-Z])$/.exec(sym);
  if (cls) sym = `${cls[1]}.${cls[2]}`;
  return /^[A-Z][A-Z0-9-]{0,9}(?:\.[A-Z])?$/.test(sym) ? sym : null;
}

/**
 * 보통주가 아닌 미국 종목: 권리(Rights)·워런트·조건부가치권(CVR), 스팩(Acquisition Corp)과 스팩 유닛.
 * 네이버는 MLP·로열티 트러스트 지분도 "… Units" 로 부른다("Energy Transfer Units", "Sabine Royalty Units").
 * 이들은 보통주처럼 거래되므로 남기고, 티커가 U 로 끝나는 유닛(스팩 유닛 "CAPNU")만 뺀다.
 */
export function isUsNonCommon(eng: string, sym: string, kor = ""): boolean {
  if (/\b(rights?|warrants?|contingent value)\b/i.test(eng)) return true;
  // 우선주(나스닥식 5글자 티커 GOOGM·STRK 등도)와 거래소 상장 채권(베이비본드).
  //  - 영문명에 분명한 증권 표지가 있으면 뺀다 ("Preferred Stock", "Senior Notes due" …). "Preferred Bank" 같은 회사명은 남긴다
  //  - 한글명의 '우선주'·'채권'은 영문명에도 증권 표지(Pref·Series·% 쿠폰 …)가 있을 때만 — 네이버 한글명이 틀린 보통주 ADR(KSPI '카스피.kz 우선주')을 빼지 않게
  if (/\b(pfd|preferred (stock|shares?|series)|preference shares?|depositary shares?|dep shs|senior notes?|subordinated (notes?|debentures?)|debentures?|notes due)\b/i.test(eng)) return true;
  if (/우선주|채권/.test(kor) && /(\bpref\b|\bprf\b|\bpfd\b|\bseries\b|\bnotes?\b|\bbonds?\b|\bdebentures?\b|\bdepositary\b|\d+(\.\d+)?\s?%)/i.test(eng)) return true;
  if (/\bacquisition (corp|co|company|inc|holdings?)\b/i.test(eng)) return true;
  if (/\bunits?\s*$/i.test(eng) && sym.length >= 4 && sym.endsWith("U")) return true;
  return false;
}

export function usStock(it: Json): DiscoverStock | null {
  const code = usTicker(it); // 공백이 남는 우선주 등("BIP PRA")은 앱에서 열 수 없어 뺀다
  const price = num(it["currentPrice"]);
  if (!code || price === null) return null;
  return {
    code,
    name: String(it["name"] ?? code),
    market: String(it["stockExchangeType"] ?? "US"),
    currency: "USD",
    price,
    change: num(it["fluctuations"]) ?? 0,
    changeRate: num(it["fluctuationsRatio"]) ?? 0,
    volume: num(it["accumulatedTradingVolume"]),
    tradingValue: num(it["accumulatedTradingValue"]),
    marketCap: num(it["marketValue"]),
  };
}

function sectorSummary(s: Json, market: DiscoverMarket): ThemeSummary {
  const tops = (s["topItems"] as Json[] | undefined) ?? [];
  return {
    id: String(s["code"] ?? ""),
    name: String(s["name"] ?? ""),
    changeRate: num(s["changeRate"]) ?? 0,
    up: num(s["risingCount"]) ?? 0,
    flat: num(s["unchangedCount"] ?? s["unChangedCount"]) ?? 0,
    down: num(s["fallingCount"]) ?? 0,
    leaders: tops
      .map((t) => ({ code: market === "US" ? (usTicker(t) ?? "") : String(t["code"] ?? ""), name: String(t["name"] ?? ""), changeRate: null }))
      .filter((l) => l.code && l.name)
      .slice(0, 3),
  };
}

export class NaverDiscover {
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  /** 출처 JSON — 연결·시간 초과·HTTP·해석 실패는 모두 출처 오류(ProviderError)로 (라우트가 502 로 돌려준다) */
  private async json(url: string): Promise<Json> {
    try {
      return await this.fetchJson(url);
    } catch (e) {
      throw e instanceof ProviderError ? e : new ProviderError("naver", e instanceof Error ? e.message : String(e), e);
    }
  }

  private async fetchJson(url: string): Promise<Json> {
    // 10초 안에 답이 없으면 끊는다 (멈춘 출처가 요청을 붙잡지 않게 — 캐시가 직전 값을 준다)
    const once = () => this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // 연결이 끊기면 한 번 더 (HTTP 오류는 그대로). 시간 초과는 다시 부르지 않는다 (한 요청이 20초를 붙잡지 않게)
    let res: Response;
    try {
      res = await once();
    } catch (e) {
      if (isTimeoutError(e)) throw e;
      await new Promise((r) => setTimeout(r, 300));
      res = await once();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url.replace(BASE, "")})`);
    const body = (await res.json()) as Json;
    if (body["isSuccess"] === false) throw new Error(`네이버 응답 실패: ${String(body["message"] ?? "")}`);
    return (body["result"] as Json | undefined) ?? body;
  }

  /** 한국 순위 원본 한 쪽 (50개, index 0부터) */
  async krRankPage(category: RankCategory, index: number): Promise<{ items: DiscoverStock[]; raw: number; hasNext: boolean; preopen: boolean }> {
    const r = await this.json(`${BASE}/domestic/stock/list/sorted?sortType=${SORT[category]}&marketType=all&domesticStockExchangeType=KRX&index=${index}`);
    const rows = (r["items"] as Json[] | undefined) ?? [];
    const items = rows.filter(isPlainStock).map(krStock).filter((x): x is DiscoverStock => x !== null);
    // 장 시작 전 초기화: 거의 모든 줄(90% 이상)의 등락률·거래량이 0 이면 오늘 값이 아직 없는 것
    // (장전 시간외 매매로 몇 줄만 거래량이 잡혀도 초기화로 알아보게)
    const preopen = isMostlyZero(items);
    return { items, raw: rows.length, hasNext: r["hasNext"] === true, preopen };
  }

  /**
   * 미국 순위 원본 한 쪽 (100개, index 0부터). NYSE·NASDAQ·AMEX 합산, 보통주만(ETF 없음).
   * 가장 최근 거래일이 아닌 줄(오래 멈춘 종목)은 뺀다.
   */
  async usRankPage(category: RankCategory, index: number): Promise<{ items: DiscoverStock[]; raw: number; hasNext: boolean; tradedAt: string | null; preopen: boolean }> {
    const r = await this.json(`${US_BASE}/stock/nation/USA/${US_SORT[category]}?page=${index + 1}&pageSize=100`);
    const rows = (r["stocks"] as Json[] | undefined) ?? [];
    const day = (it: Json) => String(it["localTradedAt"] ?? "").slice(0, 10);
    const latest = rows.reduce((m, it) => (day(it) > m ? day(it) : m), "");
    const items = rows
      .filter((it) => !latest || day(it) === latest)
      .map(usRankStock)
      .filter((x): x is DiscoverStock => x !== null);
    const total = num(r["totalCount"]) ?? 0;
    // 값의 시각: 가장 늦은 체결 시각 (장 마감 뒤엔 정규장 종료 16:00 ET)
    const tradedAt = rows.map((it) => String(it["localTradedAt"] ?? "")).filter((x) => !Number.isNaN(Date.parse(x))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    // 네이버는 뉴욕 03:40~04:00(한국 16:40~17:00, 겨울 17:40~18:00) 잠시 목록을 비우고 marketStatus=PREOPEN 으로 둔다
    // (04:00 프리마켓 시작과 함께 직전 정규장 값으로 돌아온다 — 2026-09-23 실측)
    const preopen = String(r["marketStatus"] ?? "") === "PREOPEN" || (rows.length === 0 && total === 0);
    return { items, raw: rows.length, hasNext: rows.length > 0 && (index + 1) * 100 < total, tradedAt, preopen };
  }

  /**
   * 미국 종목 여러 개의 정규장 시세 (polling.finance.naver.com, 로이터 코드 500개씩).
   * 모르는 코드는 응답에서 빠진다. 결과는 로이터 코드 → 종목 (시가총액 포함).
   */
  async usQuotes(reuters: string[]): Promise<Map<string, UsQuote>> {
    const out = new Map<string, UsQuote>();
    const codes = [...new Set(reuters)].filter((c) => /^[A-Za-z0-9._]+$/.test(c));
    const batches: string[][] = [];
    for (let i = 0; i < codes.length; i += POLL_BATCH) batches.push(codes.slice(i, i + POLL_BATCH));
    // 묶음은 4개씩 동시에 (2,500종목 = 5번, 하나씩이면 5초 남짓)
    const results: Json[] = [];
    for (let i = 0; i < batches.length; i += 4)
      results.push(...(await Promise.all(batches.slice(i, i + 4).map((b) => this.json(`${POLL_BASE}/api/realtime/worldstock/stock/${b.join(",")}`)))));
    for (const r of results) {
      for (const it of (r["datas"] as Json[] | undefined) ?? []) {
        const s = usRankStock({ ...it, marketValueRaw: it["marketValueFullRaw"] ?? it["marketValueRaw"] });
        const rc = String(it["reutersCode"] ?? "");
        if (s && rc) out.set(rc, { ...s, tradedAt: typeof it["localTradedAt"] === "string" ? it["localTradedAt"] : null, status: String(it["marketStatus"] ?? "") });
      }
    }
    return out;
  }

  /**
   * 거래소 장 상태 — 한국은 KRX 코스피 주식, 미국은 나스닥 (front-api/marketStatus, 로그인 불필요).
   * 발견 탭 값의 출처(네이버)와 같은 곳이라 세션 경계·휴장일·특수일 개장 시각이 값과 맞는다.
   */
  async marketStatus(): Promise<Partial<Record<DiscoverMarket, ExchangeStatus>>> {
    const r = await this.json(`${BASE}/marketStatus?exchanges=krx,nasdaq`);
    const out: Partial<Record<DiscoverMarket, ExchangeStatus>> = {};
    for (const ex of (r["exchanges"] as Json[] | undefined) ?? []) {
      const statuses = (ex["statuses"] as Json[] | undefined) ?? [];
      const row = ex["exchange"] === "krx" ? statuses.find((x) => x["marketType"] === "KOSPI" && x["stockType"] === "stock") : ex["exchange"] === "nasdaq" ? statuses[0] : undefined;
      const latest = exchangeSession(row?.["latest"] as Json | undefined);
      if (!row || !latest) continue;
      const today = row["today"] as Json | undefined;
      out[ex["exchange"] === "krx" ? "KR" : "US"] = { latest, next: exchangeSession(row["next"] as Json | undefined), isTradingDay: typeof today?.["isTradingDay"] === "boolean" ? (today["isTradingDay"] as boolean) : null };
    }
    return out;
  }

  /** 오늘 상장한(첫날) 한국 종목 코드. 테마 평균을 크게 왜곡하므로 따로 빼서 계산한다 */
  async newlyListedToday(): Promise<Set<string>> {
    const r = await this.json(`${BASE}/domestic/stock/list/sorted?sortType=newStock&marketType=all&domesticStockExchangeType=KRX&index=0`);
    const rows = (r["items"] as Json[] | undefined) ?? [];
    return new Set(rows.filter(isNewlyListed).map((it) => String(it["itemCode"] ?? it["id"] ?? "").toUpperCase()).filter(Boolean));
  }

  /** 테마·업종 목록 전체 (cursor 로 끝까지, 같은 코드는 한 번만) */
  async sectors(market: DiscoverMarket, kind: ThemeKind, period: ThemePeriod): Promise<ThemeSummary[]> {
    const nation = market === "KR" ? "domestic" : "USA";
    // 미국은 theme·upjong 이 같은 산업 분류라 upjong 으로 묻는다
    const type = market === "US" ? "upjong" : kind === "theme" ? "theme" : "upjong";
    const out = new Map<string, ThemeSummary>();
    let cursor: string | null = null;
    for (let page = 0; page < 12; page++) {
      const url = `${BASE}/stock/sectors/all?sectorType=${type}&businessDayCategory=${PERIOD[period]}&sectorSortType=CHANGE_RATE&nationType=${nation}&pageSize=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const r = await this.json(url);
      for (const s of (r["sectors"] as Json[] | undefined) ?? []) {
        const t = sectorSummary(s, market);
        if (t.id && !out.has(t.id)) out.set(t.id, t);
      }
      cursor = r["hasNext"] === true && typeof r["cursor"] === "string" ? r["cursor"] : null;
      if (!cursor) break;
    }
    return [...out.values()];
  }

  /** 테마·업종 구성 종목 (등락률순, 최대 maxItems) + 설명 */
  async sectorDetail(market: DiscoverMarket, kind: ThemeKind, id: string, maxItems = 300): Promise<SectorDetail | null> {
    const items: DiscoverStock[] = [];
    const seen = new Set<string>();
    let info: Json | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < Math.ceil(maxItems / 50); page++) {
      const url =
        market === "KR"
          ? `${BASE}/domestic/sector/item/list?sectorType=${kind === "theme" ? "theme" : "upjong"}&sectorCode=${encodeURIComponent(id)}&sectorSortType=CHANGE_RATE&size=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
          : // 미국은 cursor 가 없고 pageSize(최대 50)·page(1부터)로 넘긴다 (size 를 주면 10개만 온다)
            `${BASE}/worldstock/sector/item/list?nationType=USA&sectorCode=${encodeURIComponent(id)}&sectorSortType=CHANGE_RATE&pageSize=50&page=${page + 1}`;
      let r: Json;
      try {
        r = await this.json(url);
      } catch (e) {
        if (page === 0 && /HTTP 404/.test(String(e))) return null;
        throw e;
      }
      if (!info) info = market === "KR" ? ((r["sectorInfo"] as Json | undefined) ?? {}) : r;
      const rows = (r["items"] as Json[] | undefined) ?? [];
      for (const it of rows) {
        const s = market === "KR" ? krStock(it) : usStock(it);
        if (s && !seen.has(s.code)) {
          seen.add(s.code);
          items.push(s);
        }
      }
      if (items.length >= maxItems) break;
      if (market === "US") {
        // 쪽이 덜 찼거나 상승+보합+하락 수만큼 받았으면 끝
        const total = (num(r["risingCount"]) ?? 0) + (num(r["unChangedCount"] ?? r["unchangedCount"]) ?? 0) + (num(r["fallingCount"]) ?? 0);
        if (rows.length < 50 || (total > 0 && (page + 1) * 50 >= total)) break;
        continue;
      }
      cursor = r["hasNext"] === true && typeof r["cursor"] === "string" ? r["cursor"] : null;
      if (!cursor) break;
    }
    if (!info) return null;
    // 요약: 출처 등락률(없으면 구성 종목 단순 평균)과 상승·보합·하락 수(없으면 구성 종목으로 센다).
    // 거래정지(출처 표시) 종목은 빼고 센다 — 목록(네이버)의 개수와 같은 기준 (거래 없는 코넥스 종목은 보합)
    const live = items.filter((i) => !i.suspended);
    const avg = live.length ? live.reduce((s, i) => s + i.changeRate, 0) / live.length : 0;
    const count = (f: (x: DiscoverStock) => boolean) => live.filter(f).length;
    const theme: ThemeSummary = {
      id,
      name: String(info["sectorName"] ?? info["name"] ?? id),
      changeRate: num(info["changeRate"]) ?? Math.round(avg * 100) / 100,
      up: num(info["risingCount"]) ?? count((x) => x.changeRate > 0),
      flat: num(info["unChangedCount"] ?? info["unchangedCount"]) ?? count((x) => x.changeRate === 0),
      down: num(info["fallingCount"]) ?? count((x) => x.changeRate < 0),
      leaders: [...items]
        .sort((a, b) => b.changeRate - a.changeRate)
        .slice(0, 3)
        .map((x) => ({ code: x.code, name: x.name, changeRate: x.changeRate })),
    };
    const desc = info["sectorDescription"];
    return { theme, description: typeof desc === "string" && desc.trim() ? desc.trim() : null, items };
  }
}
