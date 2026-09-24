import type { AnnualFinancials, CompanyProfile, Disclosure, DividendInfo, FinancialsProvider } from "./types.js";
import { isKrCode, normalizeCode } from "../../lib/codes.js";
import { NotListedError, ProviderError } from "../../lib/errors.js";
import type { FetchFn } from "../market/types.js";

/**
 * 미국 종목용 SEC EDGAR (무료, 키 불필요, User-Agent 에 연락처 필수, 초당 10회 제한).
 *  - 티커 → CIK: https://www.sec.gov/files/company_tickers.json (하루 1회 캐시)
 *  - 재무: https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json (10-K FY 값만)
 *  - 공시: https://data.sec.gov/submissions/CIK##########.json (최근 filing 목록)
 * DART 의 FinancialsProvider 인터페이스를 그대로 구현해 collector/analysis 가 한국·미국을 같은 코드로 다룬다.
 * 배당 이력은 XBRL 로 일관되게 뽑기 어려워 빈 배열(네이버 보강의 배당수익률로 대신).
 */

const UA = "stock-briefing/1.0 (personal use; contact: admin@stock-briefing.app)";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

const REVENUE_TAGS = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
  "SalesRevenueGoodsNet",
  "RevenuesNetOfInterestExpense",
  "TotalRevenuesAndOtherIncome",
  "OperatingRevenue",
];
const OPERATING_TAGS = ["OperatingIncomeLoss", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest"];
const NET_TAGS = ["NetIncomeLoss", "ProfitLoss"];
const ASSET_TAGS = ["Assets"];
const LIAB_TAGS = ["Liabilities", "LiabilitiesCurrent"];
const EQUITY_TAGS = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"];
const FILING_FORMS = new Set(["10-K", "10-Q", "8-K", "DEF 14A", "S-1", "S-3", "4", "SC 13G", "SC 13D", "10-K/A", "10-Q/A", "8-K/A"]);
const FORM_LABEL: Record<string, string> = {
  "10-K": "연간 보고서 (10-K)",
  "10-Q": "분기 보고서 (10-Q)",
  "8-K": "수시 공시 (8-K)",
  "DEF 14A": "주주총회 위임장 (DEF 14A)",
  "S-1": "증권 신고서 (S-1)",
  "S-3": "증권 신고서 (S-3)",
  "4": "내부자 거래 (Form 4)",
  "SC 13G": "5% 이상 보유 보고 (13G)",
  "SC 13D": "5% 이상 보유 보고 (13D)",
};

type Json = Record<string, unknown>;

interface FactRow {
  fy?: number;
  fp?: string;
  form?: string;
  end?: string;
  val?: number;
  start?: string;
}

export class EdgarProvider implements FinancialsProvider {
  readonly name = "edgar";
  private tickers: { at: number; map: Map<string, { cik: string; title: string }> } | null = null;
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async getJson<T>(url: string, ttlMs: number): Promise<T> {
    const hit = this.cache.get(url);
    const t = this.now().getTime();
    if (hit && t - hit.at < ttlMs) return hit.value as T;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json" } });
    } catch (e) {
      throw new ProviderError(this.name, `네트워크 오류: ${url}`, e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${url}${res.status === 403 ? " (SEC 요청 제한, 잠시 후 재시도)" : ""}`);
    const json = (await res.json()) as T;
    this.cache.set(url, { at: t, value: json });
    return json;
  }

  async resolveCik(code: string): Promise<{ cik: string; title: string }> {
    code = normalizeCode(code);
    if (isKrCode(code)) throw new ProviderError(this.name, `미국 종목만 지원합니다: ${code}`);
    const t = this.now().getTime();
    if (!this.tickers || t - this.tickers.at > 24 * 3_600_000) {
      const raw = await this.getJson<Record<string, { cik_str: number; ticker: string; title: string }>>(TICKERS_URL, 24 * 3_600_000);
      const map = new Map<string, { cik: string; title: string }>();
      for (const v of Object.values(raw)) map.set(String(v.ticker).toUpperCase(), { cik: String(v.cik_str).padStart(10, "0"), title: v.title });
      this.tickers = { at: t, map };
    }
    const hit = this.tickers.map.get(code) ?? this.tickers.map.get(code.replace(".", "-")) ?? this.tickers.map.get(code.replace("-", "."));
    if (!hit) throw new NotListedError(this.name, `SEC 에 등록된 티커가 아닙니다: ${code} (ETF·ADR 은 재무제표가 없을 수 있음)`);
    return hit;
  }

  async getCompany(stockCode: string): Promise<CompanyProfile> {
    const { cik, title } = await this.resolveCik(stockCode);
    const s = await this.getJson<Json>(`https://data.sec.gov/submissions/CIK${cik}.json`, 6 * 3_600_000);
    const addr = (s["addresses"] as Json | undefined)?.["business"] as Json | undefined;
    const fye = String(s["fiscalYearEnd"] ?? ""); // MMDD
    return {
      corpCode: cik,
      name: String(s["name"] ?? title),
      ceo: null,
      industryCode: typeof s["sicDescription"] === "string" ? s["sicDescription"] : null,
      established: null,
      homepage: typeof s["website"] === "string" && s["website"] ? s["website"] : null,
      address: addr ? [addr["street1"], addr["city"], addr["stateOrCountry"]].filter(Boolean).join(", ") : null,
      fiscalMonth: fye.length === 4 ? String(Number(fye.slice(0, 2))) : null,
    };
  }

  async getDisclosures(stockCode: string, days: number, limit: number): Promise<Disclosure[]> {
    const { cik } = await this.resolveCik(stockCode);
    const s = await this.getJson<Json>(`https://data.sec.gov/submissions/CIK${cik}.json`, 3_600_000);
    const recent = (s["filings"] as Json | undefined)?.["recent"] as Record<string, string[]> | undefined;
    if (!recent) return [];
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString().slice(0, 10);
    const out: Disclosure[] = [];
    const n = recent["form"]?.length ?? 0;
    for (let i = 0; i < n && out.length < limit; i++) {
      const form = recent["form"]![i]!;
      const filed = recent["filingDate"]?.[i] ?? "";
      if (!FILING_FORMS.has(form) || filed < since) continue;
      const acc = (recent["accessionNumber"]?.[i] ?? "").replace(/-/g, "");
      const doc = recent["primaryDocument"]?.[i] ?? "";
      const desc = recent["primaryDocDescription"]?.[i] ?? "";
      const descIsForm = desc.toUpperCase().replace(/^FORM\s+/, "") === form.toUpperCase();
      out.push({
        receiptNo: recent["accessionNumber"]?.[i] ?? `${cik}-${i}`,
        title: `${FORM_LABEL[form] ?? form}${desc && !descIsForm ? ` · ${desc}` : ""}`,
        filedAt: filed,
        filer: String(s["name"] ?? stockCode),
        url: acc && doc ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${doc}` : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
      });
    }
    return out;
  }

  async getAnnualFinancials(stockCode: string, years: number): Promise<AnnualFinancials[]> {
    const { cik } = await this.resolveCik(stockCode);
    const f = await this.getJson<Json>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, 6 * 3_600_000);
    const gaap = ((f["facts"] as Json | undefined)?.["us-gaap"] as Record<string, { units?: Record<string, FactRow[]> }> | undefined) ?? {};
    const pick = (tags: string[], duration: boolean): Map<number, number> => {
      // 태그마다 연도별 값을 모으고, 연도별로 앞선 태그의 값을 우선하되 빠진 연도는 뒤 태그로 채운다
      const merged = new Map<number, number>();
      for (const tag of tags) {
        const byYear = new Map<number, { end: string; val: number }>();
        const rows = gaap[tag]?.units?.["USD"] ?? [];
        for (const r of rows) {
          if (r.form !== "10-K" || r.fp !== "FY" || !r.fy || typeof r.val !== "number" || !r.end) continue;
          // 손익 항목은 1년 기간(start~end 약 365일)만, 재무상태 항목은 시점값
          if (duration) {
            if (!r.start) continue;
            const span = (Date.parse(r.end) - Date.parse(r.start)) / 86_400_000;
            if (span < 300 || span > 400) continue;
          }
          const year = Number(r.end.slice(0, 4));
          const prev = byYear.get(year);
          if (!prev || r.end > prev.end) byYear.set(year, { end: r.end, val: r.val });
        }
        for (const [y, v] of byYear) if (!merged.has(y)) merged.set(y, v.val);
      }
      return merged;
    };
    const revenue = pick(REVENUE_TAGS, true);
    const operating = pick(OPERATING_TAGS, true);
    const net = pick(NET_TAGS, true);
    const assets = pick(ASSET_TAGS, false);
    const liabilities = pick(LIAB_TAGS, false);
    const equity = pick(EQUITY_TAGS, false);
    const yearsAll = [...new Set([...revenue.keys(), ...net.keys(), ...assets.keys()])].sort((a, b) => a - b).slice(-years);
    return yearsAll.map((year) => ({
      year,
      basis: "CFS" as const,
      revenue: revenue.get(year) ?? null,
      operatingIncome: operating.get(year) ?? null,
      netIncome: net.get(year) ?? null,
      totalAssets: assets.get(year) ?? null,
      totalLiabilities: liabilities.get(year) ?? (assets.has(year) && equity.has(year) ? assets.get(year)! - equity.get(year)! : null),
      totalEquity: equity.get(year) ?? null,
    }));
  }

  async getDividends(_stockCode: string, _years: number): Promise<DividendInfo[]> {
    return [];
  }
}
