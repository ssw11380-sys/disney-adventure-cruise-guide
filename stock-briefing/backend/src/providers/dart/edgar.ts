import type { AnnualFinancials, CompanyProfile, Disclosure, DividendInfo, FinancialsProvider } from "./types.js";
import { isKrCode, normalizeCode } from "../../lib/codes.js";
import { NotListedError, ProviderError } from "../../lib/errors.js";
import type { FetchFn } from "../market/types.js";

/**
 * 미국 종목용 SEC EDGAR (무료, 키 불필요, User-Agent 에 연락처 필수, 초당 10회 제한).
 *  - 티커 → CIK: https://www.sec.gov/files/company_tickers.json (하루 1회 캐시)
 *  - 재무: https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json (연간 보고서 10-K·20-F·40-F 의 FY 값만, us-gaap·ifrs-full)
 *  - 공시: https://data.sec.gov/submissions/CIK##########.json (최근 filing 목록)
 * DART 의 FinancialsProvider 인터페이스를 그대로 구현해 collector/analysis 가 한국·미국을 같은 코드로 다룬다.
 * 배당 이력은 XBRL 로 일관되게 뽑기 어려워 빈 배열(네이버 보강의 배당수익률로 대신).
 */

const UA = "stock-briefing/1.0 (personal use; contact: admin@stock-briefing.app)";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
/** 연결부터 본문 끝까지 한 요청의 제한 시간 (companyfacts 는 수 MB 라 넉넉히) */
const REQUEST_TIMEOUT_MS = 15_000;
/** 종목별로 뽑아 둔 결과(재무 표·공시 목록)를 몇 개까지 들고 있을지. 원본 JSON(대형주 companyfacts 는 수 MB)은 들고 있지 않는다 */
const CACHE_MAX = 120;
const FACTS_TTL_MS = 6 * 3_600_000;
const COMPANY_TTL_MS = 6 * 3_600_000;
const DISCLOSURE_TTL_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 연간 값으로 인정하는 보고서: 미국 기업 10-K, 외국 기업 20-F, 캐나다 기업 40-F */
const ANNUAL_FORMS = new Set(["10-K", "20-F", "40-F"]);
/** 52/53주 회계연도: 1월 첫 주에 끝난 해는 앞 해로 본다 (12/31 에 가까운 토·일요일에 끝나는 회사) */
const YEAR_END_GRACE_DAYS = 7;
/** 태그를 고를 때 보는 최근 연도 수 */
const CHOICE_WINDOW = 5;

type Taxonomy = "us-gaap" | "ifrs-full";
interface Concept {
  tax: Taxonomy;
  name: string;
}
const gaap = (name: string): Concept => ({ tax: "us-gaap", name });
const ifrs = (name: string): Concept => ({ tax: "ifrs-full", name });

/*
 * 항목별 태그 우선순위. 한 회사에는 항목마다 태그 하나만 고른다 (연도마다 섞지 않음).
 * 매출: ① 회사의 가장 최근 회계연도 값이 있는 태그 ② 최근 5개 연도 중 2개 연도 이상 있는 태그 (한 해만 섞여 든 값 제외)
 *   ③ 아래 목록 순서. 합계 태그가 앞이라, 부분 매출인 RevenueFromContract… 가 더 많은 해를 덮어도 합계 태그를 고른다 (SE).
 * 나머지 항목: ① 가장 최근 회계연도 값이 있는 태그 ② 최근 5개 연도를 가장 많이 덮는 태그 ③ 목록 순서.
 *   후보끼리 범위 차이가 작아(순이익: 지배주주 몫 ↔ 비지배지분 포함) 한 태그로 여러 해를 잇는 편이 낫다.
 * 다른 태그는 고른 태그와 겹치는 연도 값이 모두 같을 때만(태그 이름만 바꾼 경우) 빈 연도를 채운다.
 */
const REVENUE = [
  gaap("Revenues"), // 매출 합계
  gaap("RevenuesNetOfInterestExpense"), // 은행·핀테크의 총순수익 (수수료 매출만인 RevenueFromContract… 보다 앞)
  gaap("RevenueFromContractWithCustomerExcludingAssessedTax"),
  gaap("RevenueFromContractWithCustomerIncludingAssessedTax"),
  gaap("SalesRevenueNet"), // 2018년 이전 이름
  gaap("SalesRevenueGoodsNet"),
  gaap("TotalRevenuesAndOtherIncome"),
  gaap("OperatingRevenue"),
  ifrs("Revenue"),
  ifrs("RevenueFromContractsWithCustomers"),
  ifrs("RevenueFromSaleOfGoods"), // 제약사(NVS) 등 제품 매출만 보고하는 IFRS 회사
];
/** 은행·금융사의 RevenueFromContract…(IFRS: RevenueFromContractsWithCustomers) 는 이자수익이 빠진 수수료 매출이라 매출로 쓰지 않는다
 *  (HBAN: 순이익보다 작음, BCS: 순이자이익보다 작음, BCH: 일부 부문 매출) */
const FEE_ONLY = new Set([
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "RevenueFromContractsWithCustomers",
]);
/** 은행 순영업수익 = 순이자이익 + 비이자이익 (JPM·BAC·WFC·SOFI 등이 Revenues·RevenuesNetOfInterestExpense 로 보고하는 값과 같은 기준) */
const BANK_NII = gaap("InterestIncomeExpenseNet");
const BANK_NONII = gaap("NoninterestIncome");
/** 순이자이익 (IFRS: InterestRevenueExpense). 은행 매출 합계는 비이자이익이 음수인 해가 아니면 이보다 작을 수 없다 */
const NET_INTEREST = [BANK_NII, ifrs("InterestRevenueExpense")];
/** 은행 판별에 쓰는 이자 쪽 항목: 순이자이익, 이자수익 (일반 회사도 예금 이자를 이 태그로 적는 일이 있어 크기를 같이 본다) */
const BANK_INTEREST = [
  ...NET_INTEREST,
  gaap("InterestAndDividendIncomeOperating"),
  ifrs("RevenueFromInterest"),
  ifrs("InterestRevenueCalculatedUsingEffectiveInterestMethod"),
];
/** 은행 판별에 쓰는 이자 외 수익: 비이자이익 (IFRS: 수수료·위탁 수익) */
const BANK_OTHER_INCOME = [BANK_NONII, ifrs("FeeAndCommissionIncome"), ifrs("FeeAndCommissionIncomeExpense")];
/** 은행 매출 항목이 해마다 순영업수익의 이 비율에도 못 미치면 부분 합계로 본다 (HDB 의 충당금 뺀 순수익은 84~94% 라 합계로 둔다) */
const PARTIAL_RATIO = 0.8;
/** 영업이익. 세전이익은 영업이익이 아니므로 대신 쓰지 않는다 (없으면 비워 두고 사유를 남김) */
const OPERATING = [gaap("OperatingIncomeLoss"), ifrs("ProfitLossFromOperatingActivities")];
const NET = [gaap("NetIncomeLoss"), ifrs("ProfitLossAttributableToOwnersOfParent"), gaap("ProfitLoss"), ifrs("ProfitLoss")];
const ASSETS = [gaap("Assets"), ifrs("Assets")];
/** 부채총계. 유동부채는 부채총계가 아니므로 대신 쓰지 않는다 (없으면 자산총계 − 자본총계) */
const LIABILITIES = [gaap("Liabilities"), ifrs("Liabilities")];
const EQUITY_PARENT = [gaap("StockholdersEquity"), ifrs("EquityAttributableToOwnersOfParent")];
const EQUITY_WITH_NCI = [gaap("StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"), ifrs("Equity")];
const NCI = [gaap("MinorityInterest"), ifrs("NoncontrollingInterests")];
/** 자본총계 칸: 지배주주 몫 우선 (ROE 의 순이익과 맞춤) */
const EQUITY = [...EQUITY_PARENT, ...EQUITY_WITH_NCI];

/** 공시 목록에 넣는 서식: 한글 이름, 괄호 안 표시, 칸 채우는 순위(0 정기 보고서 → 1 수시·지분 → 2 내부자 거래), 정정(/A)도 넣는지 */
const FORMS: Record<string, { name: string; short: string; rank: 0 | 1 | 2; amend?: true }> = {
  "10-K": { name: "연간 보고서", short: "10-K", rank: 0, amend: true },
  "10-Q": { name: "분기 보고서", short: "10-Q", rank: 0, amend: true },
  "20-F": { name: "연간 보고서", short: "20-F", rank: 0, amend: true }, // 외국 기업
  "40-F": { name: "연간 보고서", short: "40-F", rank: 0, amend: true }, // 캐나다 기업
  "8-K": { name: "수시 공시", short: "8-K", rank: 1, amend: true },
  "6-K": { name: "수시 공시", short: "6-K", rank: 1, amend: true }, // 외국 기업
  "DEF 14A": { name: "주주총회 위임장", short: "DEF 14A", rank: 1 },
  "S-1": { name: "증권 신고서", short: "S-1", rank: 1 },
  "S-3": { name: "증권 신고서", short: "S-3", rank: 1 },
  // 5% 이상 보유: 2024년 12월부터 'SCHEDULE 13G/13D', 그 전 제출은 'SC 13G/13D'
  "SCHEDULE 13G": { name: "5% 이상 보유 보고", short: "13G", rank: 1, amend: true },
  "SCHEDULE 13D": { name: "5% 이상 보유 보고", short: "13D", rank: 1, amend: true },
  "SC 13G": { name: "5% 이상 보유 보고", short: "13G", rank: 1, amend: true },
  "SC 13D": { name: "5% 이상 보유 보고", short: "13D", rank: 1, amend: true },
  "4": { name: "내부자 거래", short: "Form 4", rank: 2 },
};
/** Form 4 는 대형주에서 90일에 수십 건이라, 다른 서식을 다 넣고 남은 칸에만, 전체의 1/3 까지 */
const INSIDER_SHARE = 1 / 3;

function formInfo(form: string): { label: string; rank: 0 | 1 | 2 } | null {
  const amended = form.endsWith("/A");
  const f = FORMS[amended ? form.slice(0, -2) : form];
  if (!f || (amended && !f.amend)) return null;
  return { label: `${f.name}${amended ? " 정정" : ""} (${f.short}${amended ? "/A" : ""})`, rank: f.rank };
}

type Json = Record<string, unknown>;

interface FactRow {
  fy?: number | null;
  fp?: string;
  form?: string;
  end?: string;
  val?: number;
  start?: string;
  accn?: string;
  filed?: string;
}

/** EDGAR 연도별 재무: 공통 항목 + 금액 통화, 비우거나 계산한 값의 사유 (AI 분석 입력에 그대로 들어간다) */
export interface EdgarAnnualFinancials extends AnnualFinancials {
  currency: string;
  notes?: string[];
}

/** submissions 에서 쓰는 것만 (목록에 넣는 서식의 filing 만) */
interface Submissions {
  name: string | null;
  sic: string | null;
  website: string | null;
  address: string | null;
  fiscalYearEnd: string;
  filings: Array<{ form: string; filed: string; accession: string; doc: string; desc: string }>;
}

/** 크기 상한이 있는 TTL 캐시. 넣을 때 maxAgeMs 지난 항목을 지우고, 넘치면 가장 오래 안 쓴 것부터 버린다 */
class BoundedCache {
  private readonly map = new Map<string, { at: number; value: unknown }>();
  constructor(
    private readonly max: number,
    private readonly maxAgeMs: number,
  ) {}

  get<T>(key: string, now: number, ttlMs: number): T | undefined {
    const hit = this.map.get(key);
    if (!hit || now - hit.at >= ttlMs) return undefined;
    this.map.delete(key); // 최근 사용으로 옮김
    this.map.set(key, hit);
    return hit.value as T;
  }

  set(key: string, value: unknown, now: number): void {
    this.map.delete(key);
    for (const [k, v] of this.map) if (now - v.at >= this.maxAgeMs) this.map.delete(k);
    this.map.set(key, { at: now, value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  get size(): number {
    return this.map.size;
  }
}

export class EdgarProvider implements FinancialsProvider {
  readonly name = "edgar";
  private tickers: { at: number; map: Map<string, { cik: string; title: string }> } | null = null;
  private readonly cache: BoundedCache;

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly opts: { timeoutMs?: number; cacheMax?: number } = {},
  ) {
    this.cache = new BoundedCache(opts.cacheMax ?? CACHE_MAX, Math.max(FACTS_TTL_MS, COMPANY_TTL_MS, DISCLOSURE_TTL_MS));
  }

  /** 테스트·진단용: 들고 있는 종목별 결과 수 */
  get cachedEntries(): number {
    return this.cache.size;
  }

  /** SEC JSON 한 번. 연결부터 본문 끝까지 제한 시간 안에 못 받으면 끊고 실패로 (멈춘 연결이 브리핑·분석을 붙잡지 않게) */
  private async getJson<T>(url: string): Promise<T> {
    const ms = this.opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const signal = AbortSignal.timeout(ms);
    let onAbort = () => {};
    // 주입한 fetch 가 signal 을 따르지 않아도 제한 시간에 끝나게 같이 경쟁시킨다
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => reject(new ProviderError(this.name, `시간 초과 ${ms}ms: ${url}`));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      let res: Response;
      try {
        res = await Promise.race([this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json" }, signal }), expired]);
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw new ProviderError(this.name, `네트워크 오류: ${url}`, e);
      }
      if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${url}${res.status === 403 ? " (SEC 요청 제한, 잠시 후 재시도)" : ""}`);
      try {
        return (await Promise.race([res.json() as Promise<T>, expired])) as T;
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw new ProviderError(this.name, `응답 읽기 실패: ${url}`, e);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async resolveCik(code: string): Promise<{ cik: string; title: string }> {
    code = normalizeCode(code);
    if (isKrCode(code)) throw new ProviderError(this.name, `미국 종목만 지원합니다: ${code}`);
    const t = this.now().getTime();
    if (!this.tickers || t - this.tickers.at > 24 * 3_600_000) {
      const raw = await this.getJson<Record<string, { cik_str: number; ticker: string; title: string }>>(TICKERS_URL);
      const map = new Map<string, { cik: string; title: string }>();
      for (const v of Object.values(raw)) map.set(String(v.ticker).toUpperCase(), { cik: String(v.cik_str).padStart(10, "0"), title: v.title });
      this.tickers = { at: t, map };
    }
    const hit = this.tickers.map.get(code) ?? this.tickers.map.get(code.replace(".", "-")) ?? this.tickers.map.get(code.replace("-", "."));
    if (!hit) throw new NotListedError(this.name, `SEC 에 등록된 티커가 아닙니다: ${code} (ETF·ADR 은 재무제표가 없을 수 있음)`);
    return hit;
  }

  private async submissions(cik: string, ttlMs: number): Promise<Submissions> {
    const t = this.now().getTime();
    const key = `submissions:${cik}`;
    const hit = this.cache.get<Submissions>(key, t, ttlMs);
    if (hit) return hit;
    const s = compactSubmissions(await this.getJson<Json>(`https://data.sec.gov/submissions/CIK${cik}.json`));
    this.cache.set(key, s, t);
    return s;
  }

  async getCompany(stockCode: string): Promise<CompanyProfile> {
    const { cik, title } = await this.resolveCik(stockCode);
    const s = await this.submissions(cik, COMPANY_TTL_MS);
    const fye = s.fiscalYearEnd; // MMDD
    return {
      corpCode: cik,
      name: s.name ?? title,
      ceo: null,
      industryCode: s.sic,
      established: null,
      homepage: s.website,
      address: s.address,
      fiscalMonth: fye.length === 4 ? String(Number(fye.slice(0, 2))) : null,
    };
  }

  async getDisclosures(stockCode: string, days: number, limit: number): Promise<Disclosure[]> {
    const { cik } = await this.resolveCik(stockCode);
    const s = await this.submissions(cik, DISCLOSURE_TTL_MS);
    const since = new Date(this.now().getTime() - days * DAY_MS).toISOString().slice(0, 10);
    const inRange = s.filings.filter((f) => f.filed >= since);
    // 정기 보고서 → 수시·지분 공시 → 내부자 거래 순으로 칸을 채우고, 보여 줄 때는 원래(최신) 순서
    const picked = new Set<(typeof inRange)[number]>();
    const insiderCap = Math.ceil(limit * INSIDER_SHARE);
    for (const rank of [0, 1, 2] as const) {
      let taken = 0;
      for (const f of inRange) {
        if (picked.size >= limit || (rank === 2 && taken >= insiderCap)) break;
        if (formInfo(f.form)?.rank !== rank) continue;
        picked.add(f);
        taken++;
      }
    }
    return inRange
      .filter((f) => picked.has(f))
      .map((f, i) => {
        const acc = f.accession.replace(/-/g, "");
        const descIsForm = f.desc.toUpperCase().replace(/^FORM\s+/, "") === f.form.toUpperCase();
        return {
          receiptNo: f.accession || `${cik}-${i}`,
          title: `${formInfo(f.form)?.label ?? f.form}${f.desc && !descIsForm ? ` · ${f.desc}` : ""}`,
          filedAt: f.filed,
          filer: s.name ?? stockCode,
          url: acc && f.doc ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${f.doc}` : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
        };
      });
  }

  async getAnnualFinancials(stockCode: string, years: number): Promise<EdgarAnnualFinancials[]> {
    const { cik } = await this.resolveCik(stockCode);
    const t = this.now().getTime();
    const key = `facts:${cik}`;
    let rows = this.cache.get<EdgarAnnualFinancials[]>(key, t, FACTS_TTL_MS);
    if (!rows) {
      rows = extractFinancials(await this.getJson<Json>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`));
      this.cache.set(key, rows, t);
    }
    // 빈 표를 성공으로 주면 분석이 "확인했는데 없음"으로 읽는다 → 실패(데이터 미확인)로 알린다
    if (!rows.length) throw new ProviderError(this.name, `연간 보고서(10-K·20-F·40-F) 재무 수치가 없습니다: ${stockCode}`);
    return rows.slice(-years);
  }

  async getDividends(_stockCode: string, _years: number): Promise<DividendInfo[]> {
    return [];
  }
}

function compactSubmissions(s: Json): Submissions {
  const addr = (s["addresses"] as Json | undefined)?.["business"] as Json | undefined;
  const recent = (s["filings"] as Json | undefined)?.["recent"] as Record<string, string[] | undefined> | undefined;
  const filings: Submissions["filings"] = [];
  const n = recent?.["form"]?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const form = recent!["form"]![i]!;
    if (!formInfo(form)) continue; // 목록에 넣지 않는 서식은 들고 있지 않는다
    filings.push({
      form,
      filed: recent!["filingDate"]?.[i] ?? "",
      accession: recent!["accessionNumber"]?.[i] ?? "",
      doc: recent!["primaryDocument"]?.[i] ?? "",
      desc: recent!["primaryDocDescription"]?.[i] ?? "",
    });
  }
  return {
    name: typeof s["name"] === "string" ? s["name"] : null,
    sic: typeof s["sicDescription"] === "string" ? s["sicDescription"] : null,
    website: typeof s["website"] === "string" && s["website"] ? s["website"] : null,
    address: addr ? [addr["street1"], addr["city"], addr["stateOrCountry"]].filter(Boolean).join(", ") : null,
    fiscalYearEnd: String(s["fiscalYearEnd"] ?? ""),
    filings,
  };
}

/** 기간 끝 날짜의 연도. 1월 첫 주에 끝난 52/53주 회계연도는 앞 해 */
function shiftedYear(end: string): number {
  return new Date(Date.parse(end) - YEAR_END_GRACE_DAYS * DAY_MS).getUTCFullYear();
}

/** 같은 값인지 (재작성 반올림 차이 0.5% 까지) */
function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b));
}

/** 끝자리 0 개수 */
function trailingZeros(v: number): number {
  let n = 0;
  for (let x = Math.abs(Math.round(v)); x !== 0 && x % 10 === 0 && n < 15; x /= 10) n++;
  return n;
}

/** coarse 가 fine 을 더 큰 단위로 반올림만 한 값인지 (예: 2,291,413M → 2,291,000M) */
function isRoundingOf(coarse: number, fine: number): boolean {
  const z = trailingZeros(coarse);
  if (z <= trailingZeros(fine) || !sameValue(coarse, fine)) return false;
  const unit = 10 ** z;
  return Math.sign(fine) * Math.round(Math.abs(fine) / unit) * unit === coarse;
}

type Point = { end: string; filed: string; val: number };
type Series = Map<number, Point>;

/** 같은 연도에 둘 중 어느 값을 둘지: 기간 끝이 늦은 값 → 같은 기간이면 나중에 제출한 값(정정·재작성 반영).
 *  다만 한쪽이 다른 쪽을 반올림만 한 값이면(Citi 2021 자산: 나중 보고서는 2,291,000M) 자세한 값을 둔다 */
function better(next: Point, prev: Point): boolean {
  if (next.end !== prev.end) return next.end > prev.end;
  if (isRoundingOf(next.val, prev.val)) return false;
  if (isRoundingOf(prev.val, next.val)) return true;
  return next.filed > prev.filed;
}

/** companyfacts → 연도별 재무 (전체 연도, 오래된 순). 연간 값이 하나도 없으면 빈 배열 */
export function extractFinancials(f: Json): EdgarAnnualFinancials[] {
  const facts = (f["facts"] as Json | undefined) ?? {};
  const unitsOf = (c: Concept): Record<string, FactRow[]> =>
    ((facts[c.tax] as Record<string, { units?: Record<string, FactRow[]> }> | undefined)?.[c.name]?.units) ?? {};
  // 손익 항목은 1년 기간(start~end 약 365일)만, 재무상태 항목은 시점값
  const annual = (rows: FactRow[], duration: boolean): Array<FactRow & { end: string; val: number }> =>
    rows.filter((r): r is FactRow & { end: string; val: number } => {
      if (!r.form || !ANNUAL_FORMS.has(r.form) || r.fp !== "FY" || typeof r.val !== "number" || !r.end) return false;
      if (!duration) return true;
      if (!r.start) return false;
      const span = (Date.parse(r.end) - Date.parse(r.start)) / DAY_MS;
      return span >= 300 && span <= 400;
    });
  const KEY: Array<[Concept[], boolean]> = [
    [REVENUE, true],
    [NET, true],
    [ASSETS, false],
  ];

  // 1) 통화 하나: 가장 최근 결산일 값이 있는 통화 (보고 통화를 바꾼 회사는 지금 통화: DEO 는 FY2024 부터 GBP → USD)
  //    그런 통화가 여럿이면 최근 5년 안의 연간 값이 가장 많은 통화 (외국 기업은 현지 통화 + 최근 해만 달러 환산인 경우가 많다: BABA)
  const ends = new Map<string, Set<string>>();
  for (const [cs, d] of KEY)
    for (const c of cs)
      for (const [unit, rows] of Object.entries(unitsOf(c))) {
        if (!/^[A-Z]{3}$/.test(unit)) continue;
        const set = ends.get(unit) ?? new Set<string>();
        for (const r of annual(rows, d)) set.add(r.end);
        ends.set(unit, set);
      }
  const lastEnd = Math.max(...[...ends.values()].flatMap((s) => [...s].map((e) => Date.parse(e))));
  const recentEnds = (s: Set<string>) => [...s].filter((e) => Date.parse(e) > lastEnd - CHOICE_WINDOW * 366 * DAY_MS).length;
  const hasLast = (s: Set<string>) => Number([...s].some((e) => Date.parse(e) === lastEnd));
  const currency = [...ends]
    .filter(([, s]) => s.size > 0)
    .sort(
      (a, b) =>
        hasLast(b[1]) - hasLast(a[1]) ||
        recentEnds(b[1]) - recentEnds(a[1]) ||
        b[1].size - a[1].size ||
        Number(b[0] === "USD") - Number(a[0] === "USD") ||
        a[0].localeCompare(b[0]),
    )[0]?.[0];
  if (!currency) return [];
  // 보고 통화를 바꾼 회사: 바꾸기 전 연도는 다른 통화라 넣지 않는다 → 가장 오래된 해에 사유를 남긴다
  const firstEnd = Math.min(...[...ends.get(currency)!].map((e) => Date.parse(e)));
  const before = [...ends].filter(([u, s]) => u !== currency && [...s].some((e) => Date.parse(e) < firstEnd)).map(([u]) => u);
  const rowsOf = (c: Concept, d: boolean) => annual(unitsOf(c)[currency] ?? [], d);

  // 2) 회계연도 이름: 기본은 기간 끝 연도(52/53주 회계연도 보정). 보고서(accn)의 fy 가 이와 1 다르면(TGT·HD: 2026-01-31 에 끝난 해가 2025 회계연도)
  //    그 이름을 따르되, 가장 최근 보고서와 최근 5개 보고서 과반이 같은 차이를 보일 때만. fy 는 보고서마다 틀린 값이 섞여 있어서다:
  //    TJX·MUFG 는 2021년 전 보고서만 1 작고, CRWD 는 세 해만, CRM 은 최근 한 해만 1 작다 → 모두 기간 끝 연도
  const byAccn = new Map<string, { end: string; fy: number; filed: string }>();
  for (const [cs, d] of KEY)
    for (const c of cs)
      for (const r of rowsOf(c, d)) {
        if (!r.accn || typeof r.fy !== "number") continue;
        const prev = byAccn.get(r.accn);
        if (!prev || r.end > prev.end) byAccn.set(r.accn, { end: r.end, fy: r.fy, filed: r.filed ?? "" });
      }
  // 같은 기간을 다룬 보고서가 여럿이면(정정 등) 나중에 낸 것
  const byEnd = new Map<string, { fy: number; filed: string }>();
  for (const v of byAccn.values()) {
    const prev = byEnd.get(v.end);
    if (!prev || v.filed > prev.filed) byEnd.set(v.end, v);
  }
  const diffs = [...byEnd]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, CHOICE_WINDOW)
    .map(([end, v]) => v.fy - shiftedYear(end));
  const lastDiff = diffs[0] ?? 0;
  const offset = Math.abs(lastDiff) === 1 && diffs.filter((x) => x === lastDiff).length * 2 > diffs.length ? lastDiff : 0;

  // 3) 태그별 연도 값 (같은 연도에 값이 여럿이면 better() 참고)
  //    같은 태그라도 보고서마다 뜻이 바뀐 경우가 있다(SE 의 RevenueFromContract… 는 2023년부터 부분 매출). 그래서 4) 에서 합계 태그를 앞에 둔다
  const memo = new Map<string, Series>();
  const series = (c: Concept, d: boolean): Series => {
    const k = `${c.tax}:${c.name}`;
    const hit = memo.get(k);
    if (hit) return hit;
    const by: Series = new Map();
    for (const r of rowsOf(c, d)) {
      const year = shiftedYear(r.end) + offset;
      const next = { end: r.end, filed: r.filed ?? "", val: r.val };
      const prev = by.get(year);
      if (!prev || better(next, prev)) by.set(year, next);
    }
    memo.set(k, by);
    return by;
  };
  const keyYears = new Set<number>();
  for (const [cs, d] of KEY) for (const c of cs) for (const y of series(c, d).keys()) keyYears.add(y);
  if (!keyYears.size) return [];
  const latest = Math.max(...keyYears);
  const inWindow = (s: Map<number, unknown>) => [...s.keys()].filter((y) => y > latest - CHOICE_WINDOW && y <= latest).length;

  // 4) 항목마다 후보 하나 (위 우선순위 설명 참고). totalFirst: 매출처럼 목록 순서(합계 우선)를 연도 수보다 앞에. from: 연도별로 값을 준 후보 번호
  const choose = (list: Series[], totalFirst = false): { values: Map<number, number>; from: Map<number, number> } => {
    const cands = list.map((s, idx) => ({ idx, s, n: inWindow(s) })).filter((x) => x.s.size > 0);
    const values = new Map<number, number>();
    const from = new Map<number, number>();
    const enough = Math.min(2, Math.max(0, ...cands.map((x) => x.n)));
    const first = [...cands].sort(
      (a, b) =>
        Number(b.s.has(latest)) - Number(a.s.has(latest)) ||
        (totalFirst ? Number(b.n >= enough) - Number(a.n >= enough) || a.idx - b.idx : b.n - a.n || a.idx - b.idx),
    )[0];
    if (!first) return { values, from };
    for (const [y, v] of first.s) values.set(y, v.val), from.set(y, first.idx);
    for (const x of cands) {
      if (x === first) continue;
      const overlap = [...x.s.keys()].filter((y) => values.has(y));
      if (!overlap.length || !overlap.every((y) => sameValue(values.get(y)!, x.s.get(y)!.val))) continue;
      for (const [y, v] of x.s) if (!values.has(y)) values.set(y, v.val), from.set(y, x.idx);
    }
    return { values, from };
  };
  const pick = (cs: Concept[], d: boolean) => choose(cs.map((c) => series(c, d)));

  // 은행·금융사: 수수료 매출(RevenueFromContract…)은 빼고, 합계 태그가 없으면 순이자이익 + 비이자이익으로 계산 (HBAN·FITB·MTB 2024~)
  //   은행으로 보는 해: 이자수익(순이자이익)이 같은 해 수수료 매출보다 크고, 비이자이익을 보고하거나 수수료 매출이 순이익보다도 작은 해
  //   (수수료 매출이 없는 해는 비이자이익이 있어야). 최근 5년 중 이런 해가 수수료 매출이 매출인 해보다 많을 때만 은행.
  //   예금 이자를 이자수익 태그로 적는 일반 회사(ORLY·DGX·CELH)나 이자수익이 매출보다 큰 적자 바이오 회사는 은행으로 보지 않는다
  //   IFRS 회사도 같은 기준 (이자수익·순이자이익 ifrs-full 태그, 비이자이익 대신 수수료·위탁 수익: BCS·BCH)
  const feeSeries = REVENUE.filter((c) => FEE_ONLY.has(c.name)).map((c) => series(c, true));
  const interestSeries = BANK_INTEREST.map((c) => series(c, true));
  const nonInterest = series(BANK_NONII, true);
  const otherIncome = BANK_OTHER_INCOME.map((c) => series(c, true));
  const netSeries = NET.map((c) => series(c, true));
  const largest = (list: Series[], y: number): number | undefined => {
    const vals = list.flatMap((s) => (s.has(y) ? [s.get(y)!.val] : []));
    return vals.length ? Math.max(...vals) : undefined;
  };
  let bankYears = 0;
  let feeYears = 0;
  for (let y = latest - CHOICE_WINDOW + 1; y <= latest; y++) {
    const fee = largest(feeSeries, y);
    const interest = largest(interestSeries, y);
    const profit = largest(netSeries, y);
    const other = otherIncome.some((s) => s.has(y));
    const bankLike = interest !== undefined && (fee === undefined ? other : interest > fee && (other || (profit !== undefined && fee < profit)));
    if (bankLike) bankYears++;
    else if (fee !== undefined) feeYears++;
  }
  const bank = bankYears > feeYears;
  const bankRevenue: Series = new Map();
  if (bank) {
    const nii = series(BANK_NII, true);
    for (const [y, p] of nonInterest) {
      const q = nii.get(y);
      if (q && q.end === p.end) bankRevenue.set(y, { end: p.end, filed: p.filed > q.filed ? p.filed : q.filed, val: q.val + p.val });
    }
  }
  // 매출이 0 이하인 값은 같은 해 다른 매출 항목이 양수면 버린다 (FLS: 'Revenues' 를 해마다 0 으로 보고, 실제 매출은 RevenueFromContract…)
  const revenueConcepts = bank ? REVENUE.filter((c) => !FEE_ONLY.has(c.name)) : REVENUE;
  const rawRevenue = [...revenueConcepts.map((c) => series(c, true)), bankRevenue];
  const revenueList = rawRevenue.map((s) => {
    const kept: Series = new Map();
    for (const [y, p] of s) if (p.val > 0 || !rawRevenue.some((o) => (o.get(y)?.val ?? 0) > 0)) kept.set(y, p);
    return kept;
  });
  const bankComputed = revenueList.length - 1;
  const bankReported = revenueConcepts.findIndex((c) => c.name === "RevenuesNetOfInterestExpense");
  let revenue = choose(revenueList, true);
  // 은행: 고른 매출이 합계인지 순영업수익(RevenuesNetOfInterestExpense, 없으면 순이자이익 + 비이자이익)과 순이자이익으로 검산한다
  //   ZION 의 'Revenues' 는 수수료 + 기타 비이자이익(순이자이익의 1/4)이라 매출로 쓰면 순이익이 매출보다 커진다
  const partialYears = new Set<number>(); // 부분 합계라 버린 해 (다른 값으로 못 채우면 사유를 남긴다)
  if (bank) {
    const niiList = NET_INTEREST.map((c) => series(c, true));
    const isNet = (idx: number) => idx === bankReported || idx === bankComputed;
    const netRevenue = (y: number): { idx: number; val: number } | undefined => {
      for (const idx of [bankReported, bankComputed]) {
        const p = revenueList[idx]!.get(y);
        if (p) return { idx, val: p.val };
      }
      return undefined;
    };
    // 부분 합계: 순영업수익이 있으면 그 80% 미만, 없으면 순이자이익보다도 작은 값. 검산할 값이 없으면 undefined
    //   0 이하인 값은 여기서 보지 않는다 (음수 매출은 아래에서 따로 비우고 사유를 남긴다: LYG 2022)
    const partial = (y: number, v: number): boolean | undefined => {
      if (v <= 0) return undefined;
      const net = netRevenue(y);
      if (net) return v < net.val * PARTIAL_RATIO;
      const nii = largest(niiList, y);
      return nii !== undefined && nii > 0 ? v < nii : undefined;
    };
    // 회사 단위: 고른 항목이 최근 5년 중 검산한 해의 과반에서 부분 합계면 이 회사에는 그 항목을 쓰지 않고 다시 고른다 (연도마다 섞지 않게)
    for (;;) {
      const votes = new Map<number, number>(); // 후보 번호 → 부분 합계인 해 수 − 합계인 해 수
      for (const [y, v] of revenue.values) {
        const idx = revenue.from.get(y)!;
        if (isNet(idx) || y <= latest - CHOICE_WINDOW) continue;
        const p = partial(y, v);
        if (p !== undefined) votes.set(idx, (votes.get(idx) ?? 0) + (p ? 1 : -1));
      }
      const drop = [...votes].filter(([, n]) => n > 0).map(([idx]) => idx);
      if (!drop.length) break;
      for (const [y, idx] of revenue.from) if (drop.includes(idx)) partialYears.add(y);
      for (const idx of drop) revenueList[idx] = new Map();
      revenue = choose(revenueList, true);
    }
    // 해마다: 그래도 순이자이익보다 작은 값은 합계가 아니다 → 순영업수익으로 바꾸고, 없으면 비운다
    //   순영업수익과 같은 값이면 비이자이익이 음수인 해라 합계가 맞다 (TFC 2024: 증권 매각 손실)
    for (const [y, v] of [...revenue.values]) {
      const nii = largest(niiList, y);
      const net = netRevenue(y);
      if (isNet(revenue.from.get(y)!) || v <= 0 || nii === undefined || nii <= 0 || v >= nii || (net && sameValue(v, net.val))) continue;
      partialYears.add(y);
      if (net) revenue.values.set(y, net.val), revenue.from.set(y, net.idx);
      else revenue.values.delete(y), revenue.from.delete(y);
    }
  }
  const operating = pick(OPERATING, true);
  const net = pick(NET, true);
  const assets = pick(ASSETS, false);
  const liabilities = pick(LIABILITIES, false);
  const equity = pick(EQUITY, false);
  const equityParent = pick(EQUITY_PARENT, false);
  const equityWithNci = pick(EQUITY_WITH_NCI, false);
  const nci = pick(NCI, false);

  const years = [...new Set([...revenue.values.keys(), ...net.values.keys(), ...assets.values.keys()])].sort((a, b) => a - b);
  return years.map((year) => {
    const notes: string[] = [];
    const reported = revenue.values.get(year) ?? null;
    const reportedOp = operating.values.get(year) ?? null;
    const netIncome = net.values.get(year) ?? null;
    // 회사가 태그 뜻을 다르게 쓴 원자료: 음수 매출(LYG 2022), 매출과 똑같은 영업이익(ING) → 비우고 사유를 남긴다 (영업이익률 계산에 쓰이지 않게)
    const negative = reported !== null && reported < 0;
    const operatingVal = reportedOp !== null && reported !== null && reported !== 0 && reportedOp === reported ? null : reportedOp;
    // 합계일 수 없는 매출: 영업이익이 매출보다 크거나, 영업이익 없이 순이익이 매출보다 크면 부분 매출(부문·수수료)로 보고 그해만 비운다
    //   영업이익이 매출 안에 있으면 순이익이 더 커도 매출은 그대로 둔다 (EBAY 2021: 사업 매각 이익)
    const overBy = ((): "영업이익" | "순이익" | null => {
      if (reported === null || reported <= 0) return null;
      if (operatingVal !== null) return operatingVal > reported ? "영업이익" : null;
      return netIncome !== null && netIncome > reported ? "순이익" : null;
    })();
    const revenueVal = negative || overBy ? null : reported;
    if (currency !== "USD") notes.push(`금액 통화: ${currency} (주가 통화와 다를 수 있음, 달러로 환산하지 않은 값)`);
    if (year === years[0] && before.length) notes.push(`금액 통화: 이 해보다 앞선 연도는 다른 통화(${before.join("·")})로 보고해 넣지 않음`);
    // 비우거나 계산한 값은 사유를 남긴다 (AI 분석이 "0" 이나 "감소"로 읽지 않게)
    if (negative) notes.push("매출: 회사가 보고한 값이 음수라 매출로 쓰지 않고 비워 둠 (해마다 기준이 다른 항목일 수 있음)");
    else if (overBy) notes.push(`매출: ${overBy}이 매출보다 커서 매출 항목이 합계가 아닐 수 있어 비움 (영업이익률도 계산하지 않음)`);
    else if (revenueVal === null)
      notes.push(
        partialYears.has(year)
          ? "매출: 은행·금융사인데 매출 항목이 순이자이익·순영업수익에 못 미치는 부분 합계라 매출로 쓰지 않고 비워 둠"
          : bank && !bankRevenue.has(year) && feeSeries.some((s) => s.has(year))
            ? "매출: 은행·금융사라 이자수익이 빠진 수수료 매출은 매출로 쓰지 않았고, 순이자이익 + 비이자이익도 확인되지 않아 비워 둠"
            : "매출: 매출 합계 항목에서 이 해 값을 찾지 못해 비워 둠 (기준이 다른 값으로 채우지 않음)",
      );
    else if (revenue.from.get(year) === bankComputed) notes.push("매출: 은행·금융사라 순이자이익 + 비이자이익(순영업수익)으로 계산");
    if (reportedOp !== null && operatingVal === null) notes.push("영업이익: 회사가 매출과 같은 값으로 보고해 영업이익으로 보지 않고 비워 둠");
    else if (operatingVal === null) notes.push("영업이익: 영업이익 항목에서 이 해 값을 찾지 못해 비워 둠 (세전이익으로 대신하지 않음)");
    const totalAssets = assets.values.get(year) ?? null;
    let totalLiabilities = liabilities.values.get(year) ?? null;
    if (totalLiabilities === null) {
      // 부채총계 = 자산총계 − 자본총계(비지배지분 포함)
      const parent = equityParent.values.get(year);
      const eq = equityWithNci.values.get(year) ?? (parent !== undefined ? parent + (nci.values.get(year) ?? 0) : undefined);
      if (totalAssets !== null && eq !== undefined) {
        totalLiabilities = totalAssets - eq;
        notes.push("부채총계: 회사가 따로 보고하지 않아 자산총계 − 자본총계로 계산");
      } else notes.push("부채총계: 항목을 찾지 못했고 자산총계 − 자본총계로도 계산할 수 없어 비워 둠");
    }
    return {
      year,
      basis: "CFS" as const,
      revenue: revenueVal,
      operatingIncome: operatingVal,
      netIncome,
      totalAssets,
      totalLiabilities,
      totalEquity: equity.values.get(year) ?? null,
      currency,
      ...(notes.length ? { notes } : {}),
    };
  });
}
