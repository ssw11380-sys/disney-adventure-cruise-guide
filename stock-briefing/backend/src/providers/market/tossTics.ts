import type { FetchFn } from "./types.js";

/**
 * 토스증권 웹의 테마 분류(TICS) — 로그인·쿠키 없이 받는 공개 JSON (wts-info-api).
 * 미국 테마(양자컴퓨터·비트코인·원자력 …)의 이름과 구성 종목을 얻는 데만 쓴다.
 * 등락률은 한국 낮에 토스 주간거래 가격이 섞이므로, 오늘 등락률은 네이버 정규장 시세로 따로 계산한다.
 *  - 순위: POST /v2/dashboard/wts/overview/tics/ranking {nation, duration: 1d|1w|1m|3m|1y, sortBy: FLUCTUATION_RATE|TRADING_AMOUNT}
 *    (내림차순 상위 약 100개만 준다)
 *  - 개요: GET /v2/dashboard/wts/overview/tics/{id}/overview (설명·상위 분류 트리)
 *  - 기간 등락률: GET /v2/dashboard/wts/overview/tics/{id}/simple?nation=US&duration= (테마 하나, 시가총액 가중)
 *  - 구성 종목: POST /v2/dashboard/wts/overview/tics/{id}/stocks {nation, sortBy: MARKET_CAP, sortOrder: DESC, page} (한 쪽 10개)
 *  - 종목 정보: GET /v1/stock-infos?codes= (상품 코드 → 티커·거래소, 한 번에 200개)
 */

type Json = Record<string, unknown>;

const BASE = "https://wts-info-api.tossinvest.com/api";
const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  accept: "application/json",
  referer: "https://tossinvest.com/",
  origin: "https://tossinvest.com",
};

export type TicsNation = "US" | "KR";
export type TicsDuration = "1d" | "1w" | "1m" | "3m" | "1y";

export interface TicsRankRow {
  id: string;
  name: string;
  /** 기간 등락률(%) */
  rate: number;
  stockCount: number | null;
  /** 대표 종목 (상품 코드·이름) */
  leader: { productCode: string; name: string } | null;
}

export interface TicsNode {
  id: string;
  name: string;
  depth: number;
  root: string;
}

export interface TicsStock {
  productCode: string;
  name: string;
  marketCapUsd: number | null;
}

export interface TicsStockInfo {
  productCode: string;
  symbol: string;
  /** NSQ | NYS | AMX … */
  market: string;
  name: string;
  spac: boolean;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export class TossTics {
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly retryDelayMs = 800,
  ) {}

  private async call(path: string, body?: unknown): Promise<unknown> {
    const once = () =>
      this.fetchFn(`${BASE}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? HEADERS : { ...HEADERS, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000), // 멈춘 연결이 테마북 만들기를 붙잡지 않게
      });
    // 연결이 끊기거나 5xx·429 면 한 번 더 (하루 한 번 수백 번 부르는 동안 가끔 끊긴다)
    let res: Response;
    try {
      res = await once();
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
    } catch {
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      res = await once();
    }
    if (!res.ok) throw new Error(`토스 테마 HTTP ${res.status} (${path.split("?")[0]})`);
    const j = (await res.json()) as Json;
    if (j["result"] === undefined || j["result"] === null) throw new Error(`토스 테마 응답에 result 가 없습니다 (${path.split("?")[0]})`);
    return j["result"];
  }

  /** 테마 순위 (내림차순 상위 약 100개) */
  async ranking(nation: TicsNation, duration: TicsDuration, sortBy: "FLUCTUATION_RATE" | "TRADING_AMOUNT" = "FLUCTUATION_RATE"): Promise<TicsRankRow[]> {
    const r = (await this.call("/v2/dashboard/wts/overview/tics/ranking", { nation, duration, sortBy })) as Json;
    const rows = (r["tics"] as Json[] | undefined) ?? [];
    return rows
      .map((t) => {
        const lead = t["leadingStock"] as Json | null | undefined;
        const rate = num(t["fluctuationRate"]);
        return {
          id: String(t["ticsId"] ?? ""),
          name: String(t["name"] ?? ""),
          rate: rate === null ? NaN : Math.round(rate * 10000) / 100,
          stockCount: num(t["stockCount"]),
          leader: lead && typeof lead["productCode"] === "string" ? { productCode: lead["productCode"], name: String(lead["name"] ?? "") } : null,
        };
      })
      .filter((t) => t.id && t.name && Number.isFinite(t.rate));
  }

  /** 테마 한 개의 기간 등락률(%) — nation 을 주면 그 나라 종목만 (토스 순위 값과 같다) */
  async periodRate(id: string, nation: TicsNation, duration: TicsDuration): Promise<number | null> {
    const r = (await this.call(`/v2/dashboard/wts/overview/tics/${encodeURIComponent(id)}/simple?nation=${nation}&duration=${duration}`)) as Json;
    return num(r["changeRate"]);
  }

  /** 테마 개요: 설명과, 이 테마가 속한 상위 분류 트리(루트별 전체 하위 테마) */
  async overview(id: string): Promise<{ id: string; name: string; summary: string | null; nodes: TicsNode[] }> {
    const r = (await this.call(`/v2/dashboard/wts/overview/tics/${encodeURIComponent(id)}/overview`)) as Json;
    const nodes: TicsNode[] = [];
    const walk = (n: Json, root: string) => {
      nodes.push({ id: String(n["ticsId"] ?? ""), name: String(n["name"] ?? ""), depth: num(n["depth"]) ?? 0, root });
      for (const c of (n["subItems"] as Json[] | undefined) ?? []) walk(c, root);
    };
    for (const root of (r["relatedTics"] as Json[] | undefined) ?? []) walk(root, String(root["name"] ?? ""));
    const summary = [r["summary"], r["description"]].find((x): x is string => typeof x === "string" && x.trim() !== "");
    return { id: String(r["ticsId"] ?? id), name: String(r["name"] ?? ""), summary: summary?.trim() ?? null, nodes: nodes.filter((n) => n.id && n.name) };
  }

  /** 구성 종목 한 쪽 (시가총액 큰 순, 10개씩, page 1부터) */
  async stocksPage(id: string, nation: TicsNation, page: number): Promise<{ total: number; stocks: TicsStock[] }> {
    const r = (await this.call(`/v2/dashboard/wts/overview/tics/${encodeURIComponent(id)}/stocks`, { nation, sortBy: "MARKET_CAP", sortOrder: "DESC", page })) as Json;
    const stocks = ((r["stocks"] as Json[] | undefined) ?? [])
      .map((s) => ({ productCode: String(s["code"] ?? ""), name: String(s["name"] ?? ""), marketCapUsd: num(s["marketCapUsd"]) }))
      .filter((s) => s.productCode);
    return { total: num(r["totalCount"]) ?? stocks.length, stocks };
  }

  /** 상품 코드 → 티커·거래소 (200개씩) */
  async stockInfos(codes: string[]): Promise<Map<string, TicsStockInfo>> {
    const out = new Map<string, TicsStockInfo>();
    for (let i = 0; i < codes.length; i += 200) {
      const batch = codes.slice(i, i + 200);
      const r = (await this.call(`/v1/stock-infos?codes=${batch.map(encodeURIComponent).join(",")}`)) as Json[];
      for (const x of Array.isArray(r) ? r : []) {
        const code = String(x["code"] ?? "");
        const symbol = String(x["symbol"] ?? "").trim().toUpperCase();
        if (!code || !symbol || String(x["status"] ?? "N") !== "N") continue;
        const market = (x["market"] as Json | undefined)?.["code"];
        out.set(code, { productCode: code, symbol, market: typeof market === "string" ? market : "", name: String(x["name"] ?? symbol), spac: x["spac"] === true });
      }
    }
    return out;
  }
}

/**
 * 토스 티커 → 네이버 로이터 코드 후보 (앞의 것 우선).
 * NASDAQ 은 ".O", NYSE·AMEX 는 접미사 없음 또는 ".K"/".N"/".A". 클래스주 BRK.B → BRKb.
 */
export function reutersCandidates(symbol: string, market: string): string[] {
  const m = /^([A-Z0-9]+)[./-]([A-Z])$/.exec(symbol);
  const base = m ? `${m[1]}${m[2]!.toLowerCase()}` : symbol;
  if (!/^[A-Za-z0-9]+$/.test(base)) return [];
  switch (market) {
    case "NSQ":
      return [`${base}.O`, base];
    case "NYS":
      return [base, `${base}.K`, `${base}.N`];
    case "AMX":
      return [`${base}.K`, `${base}.A`, base];
    default:
      return [`${base}.O`, base, `${base}.K`];
  }
}
