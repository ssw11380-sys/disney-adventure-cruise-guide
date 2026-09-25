import { unzipSync } from "fflate";
import type { Db } from "../../db/index.js";
import { isTimeoutError, ProviderError } from "../../lib/errors.js";
import { seoulDateCompact, seoulDateCompactDaysAgo, seoulIso } from "../../lib/time.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";
import type { FetchFn } from "../market/types.js";
import type {
  AnnualFinancials,
  CompanyProfile,
  Disclosure,
  DividendInfo,
  FinancialsProvider,
} from "./types.js";

/**
 * 금융감독원 DART Open API. https://opendart.fss.or.kr 에서 무료 키 발급 (일 20,000회).
 * - corpCode.xml : 종목코드 → 고유번호(corp_code) 매핑 (zip). DB(dart_corp_codes)에 캐시, 없는 종목을 만나면 하루에 한 번까지 다시 받는다.
 * - company.json : 회사 개요
 * - list.json    : 공시 목록
 * - fnlttSinglAcnt.json : 단일회사 주요계정 (당기/전기/전전기 3개년을 한 번에)
 * - alotMatter.json     : 배당에 관한 사항
 * 응답 status "000" 정상, "013" 조회 데이터 없음.
 */

const BASE = "https://opendart.fss.or.kr/api";
const ANNUAL_REPORT = "11011";
/** corpCode.xml(수 MB zip) 다운로드 제한 시간. 나머지 요청은 기본(10초) */
const CORP_CODE_TIMEOUT_MS = 60_000;
/** 표에 없는 종목을 만나면 표가 이보다 오래됐을 때만 다시 받는다 (첫 다운로드 뒤 새로 상장한 종목) */
const CORP_CODE_STALE_MS = 24 * 3_600_000;
/** 다시 받기가 실패한 뒤 다음 시도까지 (없는 코드로 부를 때마다 내려받지 않게) */
const CORP_CODE_RETRY_MS = 10 * 60_000;

type DartStatus = { status?: string; message?: string };

export interface DartOptions {
  apiKey: string;
  db: Db;
  fetchFn?: FetchFn;
  now?: () => Date;
}

export class DartProvider implements FinancialsProvider {
  readonly name = "dart";
  private readonly fetchFn: FetchFn;
  private readonly now: () => Date;
  /** 진행 중인 corpCode.xml 받기 (겹친 호출은 이것을 같이 기다린다) */
  private refreshing: Promise<number> | null = null;
  private lastRefreshTry = 0;

  constructor(private readonly opts: DartOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  private async getJson<T extends DartStatus>(path: string, params: Record<string, string>): Promise<T> {
    const q = new URLSearchParams({ crtfc_key: this.opts.apiKey, ...params });
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, `${BASE}/${path}?${q.toString()}`);
    } catch (e) {
      throw new ProviderError(this.name, `${isTimeoutError(e) ? "시간 초과" : "네트워크 오류"}: ${path}`, e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${path}`);
    const json = (await res.json()) as T;
    if (json.status && json.status !== "000" && json.status !== "013") {
      throw new ProviderError(this.name, `${path} 오류 ${json.status}: ${json.message ?? ""}`);
    }
    return json;
  }

  // ── corp_code 매핑 ────────────────────────────────────────────

  /** corpCode.xml 을 내려받아 상장사(stock_code 있는 것)만 DB에 저장. 여러 호출이 겹쳐도 한 번만 받는다 */
  async refreshCorpCodes(): Promise<number> {
    this.refreshing ??= this.downloadCorpCodes().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async downloadCorpCodes(): Promise<number> {
    this.lastRefreshTry = this.now().getTime();
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, `${BASE}/corpCode.xml?crtfc_key=${encodeURIComponent(this.opts.apiKey)}`, {}, CORP_CODE_TIMEOUT_MS);
    } catch (e) {
      throw new ProviderError(this.name, `corpCode.xml 다운로드 실패${isTimeoutError(e) ? " (시간 초과)" : ""}`, e);
    }
    if (!res.ok) throw new ProviderError(this.name, `corpCode.xml HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // 키가 틀리면 zip 대신 JSON/XML 오류 본문이 온다
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new ProviderError(this.name, `corpCode.xml 응답이 zip 이 아님: ${Buffer.from(buf.subarray(0, 120)).toString("utf8")}`);
    }
    const files = unzipSync(buf);
    const entry = Object.values(files)[0];
    if (!entry) throw new ProviderError(this.name, "corpCode.xml zip 이 비어 있음");
    const rows = parseCorpCodeXml(Buffer.from(entry).toString("utf8"));
    const ts = seoulIso(this.now());
    await this.opts.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("dart_corp_codes").execute();
      for (let i = 0; i < rows.length; i += 500) {
        await trx
          .insertInto("dart_corp_codes")
          .values(rows.slice(i, i + 500).map((r) => ({ ...r, updated_at: ts })))
          .execute();
      }
    });
    return rows.length;
  }

  private async corpCode(stockCode: string): Promise<string> {
    const find = () =>
      this.opts.db.selectFrom("dart_corp_codes").select("corp_code").where("stock_code", "=", stockCode).executeTakeFirst();
    let row = await find();
    if (!row) {
      await this.refreshIfStale();
      row = await find();
    }
    if (!row) throw new ProviderError(this.name, `DART 고유번호를 찾을 수 없음: ${stockCode}`);
    return row.corp_code;
  }

  /**
   * 표에 없는 종목을 만났을 때: 표가 비었으면 받고, 아니면 하루 넘게 묵었을 때만 다시 받는다 (BH-44).
   * 첫 다운로드 뒤 상장한 종목은 다시 받아야 찾을 수 있다. ETF 처럼 원래 없는 코드로 매번 내려받지는 않는다.
   */
  private async refreshIfStale(): Promise<void> {
    if (!this.refreshing) {
      const r = await this.opts.db
        .selectFrom("dart_corp_codes")
        .select((eb) => [eb.fn.countAll<number>().as("c"), eb.fn.max("updated_at").as("at")])
        .executeTakeFirst();
      // 표를 읽는 사이 겹친 호출이 받기를 시작했으면(lastRefreshTry 가 방금으로 바뀜) 건너뛰지 말고 그것을 같이 기다린다
      if (!this.refreshing && Number(r?.c ?? 0) > 0) {
        const t = this.now().getTime();
        const at = Date.parse(String(r?.at ?? ""));
        if (Number.isFinite(at) && t - at < CORP_CODE_STALE_MS) return;
        if (t - this.lastRefreshTry < CORP_CODE_RETRY_MS) return;
      }
    }
    await this.refreshCorpCodes(); // 진행 중인 받기가 있으면 그것을 기다린다
  }

  // ── 조회 ──────────────────────────────────────────────────────

  async getCompany(stockCode: string): Promise<CompanyProfile> {
    const corp = await this.corpCode(stockCode);
    const j = await this.getJson<DartStatus & Record<string, string>>("company.json", { corp_code: corp });
    return {
      corpCode: corp,
      name: j["corp_name"] ?? "",
      ceo: j["ceo_nm"] || null,
      industryCode: j["induty_code"] || null,
      established: j["est_dt"] ? dash(j["est_dt"]) : null,
      homepage: j["hm_url"] || null,
      address: j["adres"] || null,
      fiscalMonth: j["acc_mt"] || null,
    };
  }

  async getDisclosures(stockCode: string, days: number, limit: number): Promise<Disclosure[]> {
    const corp = await this.corpCode(stockCode);
    const j = await this.getJson<DartStatus & { list?: Array<Record<string, string>> }>("list.json", {
      corp_code: corp,
      bgn_de: seoulDateCompactDaysAgo(days, this.now()),
      end_de: seoulDateCompact(this.now()),
      page_count: String(Math.min(limit, 100)),
      sort: "date",
      sort_mth: "desc",
    });
    return (j.list ?? []).slice(0, limit).map((r) => ({
      receiptNo: r["rcept_no"] ?? "",
      title: r["report_nm"] ?? "",
      filedAt: r["rcept_dt"] ? dash(r["rcept_dt"]) : "",
      filer: r["flr_nm"] ?? "",
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcptNo=${r["rcept_no"] ?? ""}`,
    }));
  }

  /**
   * 최근 `years` 개년. 사업보고서 한 건에 당기/전기/전전기가 들어 있어 3년 단위로 호출한다.
   * 최신 사업보고서는 보통 전년도(결산 후 3월 제출)이므로 올해-1 부터 시작하고, 없으면 한 해 더 뒤로.
   */
  async getAnnualFinancials(stockCode: string, years: number): Promise<AnnualFinancials[]> {
    const corp = await this.corpCode(stockCode);
    const thisYear = Number(seoulDateCompact(this.now()).slice(0, 4));
    const byYear = new Map<number, AnnualFinancials>();
    let startYear = thisYear - 1;
    let emptyStreak = 0;
    while (byYear.size < years && emptyStreak < 2 && startYear > thisYear - years - 3) {
      const rows = await this.fetchSingleAccount(corp, startYear);
      if (rows.length === 0) {
        emptyStreak++;
        startYear--;
        continue;
      }
      emptyStreak = 0;
      for (const r of rows) if (!byYear.has(r.year)) byYear.set(r.year, r);
      startYear -= 3;
    }
    return [...byYear.values()].sort((a, b) => a.year - b.year).slice(-years);
  }

  private async fetchSingleAccount(corp: string, year: number): Promise<AnnualFinancials[]> {
    const j = await this.getJson<DartStatus & { list?: Array<Record<string, string>> }>("fnlttSinglAcnt.json", {
      corp_code: corp,
      bsns_year: String(year),
      reprt_code: ANNUAL_REPORT,
    });
    return parseSingleAccount(j.list ?? [], year);
  }

  async getDividends(stockCode: string, years: number): Promise<DividendInfo[]> {
    const corp = await this.corpCode(stockCode);
    const thisYear = Number(seoulDateCompact(this.now()).slice(0, 4));
    const out: DividendInfo[] = [];
    for (let y = thisYear - 1; y >= thisYear - years && out.length < years; y--) {
      const j = await this.getJson<DartStatus & { list?: Array<Record<string, string>> }>("alotMatter.json", {
        corp_code: corp,
        bsns_year: String(y),
        reprt_code: ANNUAL_REPORT,
      });
      const d = parseDividends(j.list ?? [], y);
      if (d) out.push(d);
      else if (out.length === 0 && y < thisYear - 2) break; // 배당 정보 자체가 없는 회사
    }
    return out.sort((a, b) => a.year - b.year);
  }
}

// ── 파서 (테스트 대상) ───────────────────────────────────────────

export function parseCorpCodeXml(xml: string): Array<{ stock_code: string; corp_code: string; corp_name: string }> {
  const out: Array<{ stock_code: string; corp_code: string; corp_name: string }> = [];
  const re = /<list>([\s\S]*?)<\/list>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1]!;
    const stock = tagText(body, "stock_code").trim();
    if (!/^\d{6}$/.test(stock)) continue;
    out.push({ stock_code: stock, corp_code: tagText(body, "corp_code").trim(), corp_name: tagText(body, "corp_name").trim() });
  }
  return out;
}

function tagText(body: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(body);
  return m?.[1] ?? "";
}

const ACCOUNT_KEYS: Record<string, keyof Omit<AnnualFinancials, "year" | "basis">> = {
  매출액: "revenue",
  수익: "revenue",
  영업수익: "revenue",
  영업이익: "operatingIncome",
  "영업이익(손실)": "operatingIncome",
  당기순이익: "netIncome",
  "당기순이익(손실)": "netIncome",
  자산총계: "totalAssets",
  부채총계: "totalLiabilities",
  자본총계: "totalEquity",
};

export function parseSingleAccount(list: Array<Record<string, string>>, reportYear: number): AnnualFinancials[] {
  const hasCfs = list.some((r) => r["fs_div"] === "CFS");
  const basis: "CFS" | "OFS" = hasCfs ? "CFS" : "OFS";
  const rows = list.filter((r) => r["fs_div"] === basis);
  if (rows.length === 0) return [];
  const mk = (year: number): AnnualFinancials => ({
    year,
    basis,
    revenue: null,
    operatingIncome: null,
    netIncome: null,
    totalAssets: null,
    totalLiabilities: null,
    totalEquity: null,
  });
  const cur = mk(reportYear), prev = mk(reportYear - 1), prev2 = mk(reportYear - 2);
  for (const r of rows) {
    const key = ACCOUNT_KEYS[(r["account_nm"] ?? "").replace(/\s+/g, "")];
    if (!key) continue;
    if (cur[key] === null) cur[key] = amount(r["thstrm_amount"]);
    if (prev[key] === null) prev[key] = amount(r["frmtrm_amount"]);
    if (prev2[key] === null) prev2[key] = amount(r["bfefrmtrm_amount"]);
  }
  return [prev2, prev, cur].filter((f) => f.revenue !== null || f.netIncome !== null || f.totalAssets !== null);
}

export function parseDividends(list: Array<Record<string, string>>, year: number): DividendInfo | null {
  if (list.length === 0) return null;
  const pick = (label: string, common = true): number | null => {
    const rows = list.filter((r) => (r["se"] ?? "").replace(/\s+/g, "").includes(label.replace(/\s+/g, "")));
    const row = common ? rows.find((r) => (r["stock_knd"] ?? "").includes("보통")) ?? rows[0] : rows[0];
    return row ? amount(row["thstrm"]) : null;
  };
  const info: DividendInfo = {
    year,
    cashDividendPerShare: pick("주당현금배당금"),
    dividendYieldPct: pick("현금배당수익률"),
    payoutRatioPct: pick("현금배당성향", false),
  };
  return info.cashDividendPerShare === null && info.dividendYieldPct === null ? null : info;
}

function amount(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function dash(yyyymmdd: string): string {
  return yyyymmdd.length === 8 ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : yyyymmdd;
}
