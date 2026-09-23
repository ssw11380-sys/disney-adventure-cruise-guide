import type { FetchFn } from "./types.js";

/**
 * 발견 탭 데이터 (네이버 증권 모바일 공개 JSON, 로그인 불필요).
 *  - 한국 순위: front-api/domestic/stock/list/sorted?sortType=priceTop|quantTop|up|down&marketType=all (50개씩, index 0부터)
 *  - 미국 순위: api.stock.naver.com/stock/nation/USA/priceTop|top|up|down?page=&pageSize=100 (정규장 기준, 보통주만)
 *  - 테마·업종: front-api/stock/sectors/all?sectorType=theme|upjong&businessDayCategory=daily|weekly|monthly&nationType=domestic|USA
 *    (50개씩 cursor. 등락률은 거래정지를 뺀 구성 종목 단순 평균 = 네이버 값 그대로)
 *  - 구성 종목: 한국 front-api/domestic/sector/item/list, 미국 front-api/worldstock/sector/item/list
 * 미국은 네이버가 테마 대신 TRBC 산업 분류(137개)만 준다 → 앱에서는 "업종"으로 쓴다.
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

/** 앱에서 쓰는 티커: symbolCode(AAPL) 우선, 없으면 로이터 코드의 거래소 접미사를 뗀다 (AAPL.O → AAPL) */
export function usTicker(it: Json): string | null {
  const sym = typeof it["symbolCode"] === "string" && it["symbolCode"] ? it["symbolCode"] : null;
  const reuters = typeof it["reutersCode"] === "string" ? it["reutersCode"] : typeof it["code"] === "string" ? it["code"] : null;
  const raw = sym ?? (reuters ? reuters.replace(/\.[A-Z]$/, "") : null);
  return raw ? raw.toUpperCase() : null;
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
  // NXT 통합 거래량·대금이 있으면 그 값 (KRX 만 보면 장 마감 뒤 NXT 거래가 빠진다)
  const integ = (it["krxNxtIntegratedPriceInfo"] as Json | undefined) ?? {};
  return {
    code,
    name: String(it["name"] ?? code),
    market: String(it["marketType"] ?? "KRX"),
    currency: "KRW",
    price,
    change: num(it["fluctuations"]) ?? 0,
    changeRate: num(it["fluctuationsRatio"]) ?? 0,
    volume: num(integ["accumulatedTradingVolume"]) ?? num(it["accumulatedTradingVolume"]),
    tradingValue: num(integ["accumulatedTradingValue"]) ?? num(it["accumulatedTradingValue"]),
    marketCap: num(it["marketValue"]),
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
  if (/\b(rights?|warrants?|units?|contingent value)\b/i.test(eng) || /\bacquisition (corp|co|company|inc|holdings?)\b/i.test(eng)) return null;
  let sym = String(it["symbolCode"] ?? "").trim().toUpperCase();
  const cls = /^([A-Z][A-Z0-9]*) ([A-Z])$/.exec(sym);
  if (cls) sym = `${cls[1]}.${cls[2]}`;
  else if (/\s/.test(sym)) return null; // "AHT PRD", "RIV RT", "ASGI RTWI"
  if (!/^[A-Z][A-Z0-9-]{0,9}(?:\.[A-Z])?$/.test(sym)) return null;
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

export function usStock(it: Json): DiscoverStock | null {
  const code = usTicker(it);
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

  private async json(url: string): Promise<Json> {
    const res = await this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url.replace(BASE, "")})`);
    const body = (await res.json()) as Json;
    if (body["isSuccess"] === false) throw new Error(`네이버 응답 실패: ${String(body["message"] ?? "")}`);
    return (body["result"] as Json | undefined) ?? body;
  }

  /** 한국 순위 원본 한 쪽 (50개, index 0부터) */
  async krRankPage(category: RankCategory, index: number): Promise<{ items: DiscoverStock[]; raw: number; hasNext: boolean }> {
    const r = await this.json(`${BASE}/domestic/stock/list/sorted?sortType=${SORT[category]}&marketType=all&domesticStockExchangeType=KRX&index=${index}`);
    const rows = (r["items"] as Json[] | undefined) ?? [];
    return { items: rows.filter(isPlainStock).map(krStock).filter((x): x is DiscoverStock => x !== null), raw: rows.length, hasNext: r["hasNext"] === true };
  }

  /**
   * 미국 순위 원본 한 쪽 (100개, index 0부터). NYSE·NASDAQ·AMEX 합산, 보통주만(ETF 없음).
   * 가장 최근 거래일이 아닌 줄(오래 멈춘 종목)은 뺀다.
   */
  async usRankPage(category: RankCategory, index: number): Promise<{ items: DiscoverStock[]; raw: number; hasNext: boolean }> {
    const r = await this.json(`${US_BASE}/stock/nation/USA/${US_SORT[category]}?page=${index + 1}&pageSize=100`);
    const rows = (r["stocks"] as Json[] | undefined) ?? [];
    const day = (it: Json) => String(it["localTradedAt"] ?? "").slice(0, 10);
    const latest = rows.reduce((m, it) => (day(it) > m ? day(it) : m), "");
    const items = rows
      .filter((it) => !latest || day(it) === latest)
      .map(usRankStock)
      .filter((x): x is DiscoverStock => x !== null);
    const total = num(r["totalCount"]) ?? 0;
    return { items, raw: rows.length, hasNext: rows.length > 0 && (index + 1) * 100 < total };
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
          : `${BASE}/worldstock/sector/item/list?nationType=USA&sectorCode=${encodeURIComponent(id)}&sectorSortType=CHANGE_RATE&size=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      let r: Json;
      try {
        r = await this.json(url);
      } catch (e) {
        if (page === 0 && /HTTP 404/.test(String(e))) return null;
        throw e;
      }
      if (!info) info = market === "KR" ? ((r["sectorInfo"] as Json | undefined) ?? {}) : r;
      for (const it of (r["items"] as Json[] | undefined) ?? []) {
        const s = market === "KR" ? krStock(it) : usStock(it);
        if (s && !seen.has(s.code)) {
          seen.add(s.code);
          items.push(s);
        }
      }
      cursor = r["hasNext"] === true && typeof r["cursor"] === "string" ? r["cursor"] : null;
      if (!cursor || items.length >= maxItems) break;
    }
    if (!info) return null;
    // 요약: 출처 등락률(없으면 구성 종목 단순 평균)과 상승·보합·하락 수(없으면 구성 종목으로 센다)
    const avg = items.length ? items.reduce((s, i) => s + i.changeRate, 0) / items.length : 0;
    const count = (f: (x: DiscoverStock) => boolean) => items.filter(f).length;
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
