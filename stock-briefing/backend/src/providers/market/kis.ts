import type { Candle, CandlePeriod, CandleSeries, Quote } from "../../domain/types.js";
import { ProviderError } from "../../lib/errors.js";
import { isKrCode } from "../../lib/codes.js";
import { seoulDateCompact, seoulDateCompactDaysAgo, seoulIso } from "../../lib/time.js";
import type { InvestorFlowDay, InvestorFlowProvider } from "./investorFlow.js";
import type { FetchFn, QuoteProvider } from "./types.js";

/**
 * 한국투자증권 KIS Open API 시세 클라이언트.
 * - 접근토큰(POST /oauth2/tokenP)은 24시간 유효, 발급 제한이 있어 메모리에 캐시한다.
 * - 현재가:   GET /uapi/domestic-stock/v1/quotations/inquire-price           (tr_id FHKST01010100)
 * - 기간별봉: GET /uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice (tr_id FHKST03010100, 최대 100건/호출)
 * 실계좌 서버는 초당 20건 제한. 스케줄러에서 여러 종목을 돌릴 때는 순차 호출한다.
 */

export interface KisOptions {
  appKey: string;
  appSecret: string;
  env: "real" | "mock";
  fetchFn?: FetchFn;
  now?: () => Date;
}

const BASE_URL = {
  real: "https://openapi.koreainvestment.com:9443",
  mock: "https://openapivts.koreainvestment.com:29443",
} as const;

type KisRow = Record<string, string>;

function n(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function dashDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export class KisProvider implements QuoteProvider, InvestorFlowProvider {
  readonly name = "kis";
  private token: { value: string; expiresAt: number } | null = null;
  private tokenPromise: Promise<string> | null = null;
  private readonly fetchFn: FetchFn;
  private readonly now: () => Date;
  private readonly baseUrl: string;

  constructor(private readonly opts: KisOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.baseUrl = BASE_URL[opts.env];
  }

  /** KIS 국내주식 API 는 한국 종목만 */
  supports(code: string): boolean {
    return isKrCode(code);
  }

  private async getToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.token && this.token.expiresAt - 60_000 > nowMs) return this.token.value;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/oauth2/tokenP`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "client_credentials",
            appkey: this.opts.appKey,
            appsecret: this.opts.appSecret,
          }),
        });
      } catch (e) {
        throw new ProviderError(this.name, "토큰 발급 네트워크 오류", e);
      }
      if (!res.ok) throw new ProviderError(this.name, `토큰 발급 실패 HTTP ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!json.access_token) throw new ProviderError(this.name, "토큰 응답에 access_token 없음");
      const ttlMs = (json.expires_in ?? 86_400) * 1000;
      this.token = { value: json.access_token, expiresAt: this.now().getTime() + ttlMs };
      return this.token.value;
    })().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  private async get<T>(path: string, trId: string, query: Record<string, string>): Promise<T> {
    const token = await this.getToken();
    const url = `${this.baseUrl}${path}?${new URLSearchParams(query).toString()}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
          appkey: this.opts.appKey,
          appsecret: this.opts.appSecret,
          tr_id: trId,
          custtype: "P",
        },
      });
    } catch (e) {
      throw new ProviderError(this.name, `네트워크 오류: ${path}`, e);
    }
    if (res.status === 401 || res.status === 403) this.token = null; // 다음 호출에서 재발급
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${path} ${await res.text()}`);
    const json = (await res.json()) as { rt_cd?: string; msg_cd?: string; msg1?: string } & T;
    if (json.rt_cd !== undefined && json.rt_cd !== "0") {
      throw new ProviderError(this.name, `${json.msg_cd ?? ""} ${json.msg1 ?? "응답 오류"}`.trim());
    }
    return json;
  }

  async getQuote(code: string): Promise<Quote> {
    const json = await this.get<{ output?: KisRow }>(
      "/uapi/domestic-stock/v1/quotations/inquire-price",
      "FHKST01010100",
      { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code },
    );
    const o = json.output;
    const price = n(o?.["stck_prpr"]);
    if (!o || price === null) throw new ProviderError(this.name, `${code} 현재가 응답 비어 있음`);
    const sign = o["prdy_vrss_sign"]; // 1,2 상승 / 3 보합 / 4,5 하락
    const rawChange = n(o["prdy_vrss"]) ?? 0;
    const change = sign === "4" || sign === "5" ? -Math.abs(rawChange) : Math.abs(rawChange);
    const rawRate = n(o["prdy_ctrt"]) ?? 0;
    const marketCapEok = n(o["hts_avls"]); // 억원 단위
    return {
      code,
      currency: "KRW",
      price,
      change,
      changeRate: sign === "4" || sign === "5" ? -Math.abs(rawRate) : Math.abs(rawRate),
      open: n(o["stck_oprc"]),
      high: n(o["stck_hgpr"]),
      low: n(o["stck_lwpr"]),
      prevClose: n(o["stck_sdpr"]),
      volume: n(o["acml_vol"]),
      marketCap: marketCapEok !== null ? marketCapEok * 100_000_000 : null,
      per: n(o["per"]),
      pbr: n(o["pbr"]),
      eps: n(o["eps"]),
      bps: n(o["bps"]),
      high52w: n(o["w52_hgpr"]),
      low52w: n(o["w52_lwpr"]),
      asOf: seoulIso(this.now()),
      source: this.name,
    };
  }

  async getCandles(code: string, period: CandlePeriod, count: number): Promise<CandleSeries> {
    // 한 호출에 최대 100건. 필요한 만큼 기간을 뒤로 옮기며 반복 조회한다.
    const perCall = 100;
    const daysPerBar = period === "D" ? 1.5 : period === "W" ? 7.5 : 31;
    const all: Candle[] = [];
    let endDate = seoulDateCompact(this.now());
    const seen = new Set<string>();
    for (let round = 0; round < Math.ceil(count / perCall) + 1 && all.length < count; round++) {
      const spanDays = Math.ceil(perCall * daysPerBar);
      const endMs = new Date(
        `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}T00:00:00+09:00`,
      ).getTime();
      const startDate = seoulDateCompactDaysAgo(spanDays, new Date(endMs));
      const json = await this.get<{ output2?: KisRow[] }>(
        "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
        "FHKST03010100",
        {
          FID_COND_MRKT_DIV_CODE: "J",
          FID_INPUT_ISCD: code,
          FID_INPUT_DATE_1: startDate,
          FID_INPUT_DATE_2: endDate,
          FID_PERIOD_DIV_CODE: period,
          FID_ORG_ADJ_PRC: "0", // 수정주가
        },
      );
      const rows = (json.output2 ?? []).filter((r) => r["stck_bsop_date"]);
      if (rows.length === 0) break;
      for (const r of rows) {
        const d = r["stck_bsop_date"]!;
        if (seen.has(d)) continue;
        seen.add(d);
        const o = n(r["stck_oprc"]), h = n(r["stck_hgpr"]), l = n(r["stck_lwpr"]), c = n(r["stck_clpr"]);
        if (o === null || h === null || l === null || c === null) continue;
        all.push({ date: dashDate(d), open: o, high: h, low: l, close: c, volume: n(r["acml_vol"]) ?? 0 });
      }
      // 다음 라운드는 이번에 받은 가장 오래된 날짜 하루 전까지
      const oldest = rows.map((r) => r["stck_bsop_date"]!).sort()[0]!;
      endDate = seoulDateCompactDaysAgo(1, new Date(`${dashDate(oldest)}T00:00:00+09:00`));
    }
    all.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { code, period, candles: all.slice(-count), source: this.name };
  }

  /** 투자자별 매매동향 (tr_id FHKST01010900). 최근 30영업일 정도를 최신순으로 돌려준다. */
  async getInvestorFlow(code: string, days: number): Promise<InvestorFlowDay[]> {
    const json = await this.get<{ output?: KisRow[] }>(
      "/uapi/domestic-stock/v1/quotations/inquire-investor",
      "FHKST01010900",
      { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code },
    );
    return (json.output ?? [])
      .filter((r) => r["stck_bsop_date"])
      .slice(0, days)
      .map((r) => ({
        date: dashDate(r["stck_bsop_date"]!),
        close: n(r["stck_clpr"]),
        individual: n(r["prsn_ntby_qty"]),
        foreign: n(r["frgn_ntby_qty"]),
        institution: n(r["orgn_ntby_qty"]),
      }));
  }
}
