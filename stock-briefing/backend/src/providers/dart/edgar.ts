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
 * 고르는 순서: ① 회사의 가장 최근 회계연도 값이 있는 태그 ② 최근 5개 연도를 가장 많이 덮는 태그 ③ 아래 목록 순서.
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
];
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

  // 1) 통화 하나: 연간 값이 가장 많은 통화 (외국 기업은 현지 통화 + 최근 해만 달러 환산인 경우가 많다)
  const ends = new Map<string, Set<string>>();
  for (const [cs, d] of KEY)
    for (const c of cs)
      for (const [unit, rows] of Object.entries(unitsOf(c))) {
        if (!/^[A-Z]{3}$/.test(unit)) continue;
        const set = ends.get(unit) ?? new Set<string>();
        for (const r of annual(rows, d)) set.add(r.end);
        ends.set(unit, set);
      }
  const currency = [...ends].filter(([, s]) => s.size > 0).sort((a, b) => b[1].size - a[1].size || Number(b[0] === "USD") - Number(a[0] === "USD") || a[0].localeCompare(b[0]))[0]?.[0];
  if (!currency) return [];
  const rowsOf = (c: Concept, d: boolean) => annual(unitsOf(c)[currency] ?? [], d);

  // 2) 회계연도 이름: 보고서(accn)마다 가장 늦은 기간 끝이 그 보고서의 회계연도(fy). 그 차이를 다수결로 정해 회사가 쓰는 연도 이름에 맞춘다
  const byAccn = new Map<string, { end: string; fy: number }>();
  for (const [cs, d] of KEY)
    for (const c of cs)
      for (const r of rowsOf(c, d)) {
        if (!r.accn || typeof r.fy !== "number") continue;
        const prev = byAccn.get(r.accn);
        if (!prev || r.end > prev.end) byAccn.set(r.accn, { end: r.end, fy: r.fy });
      }
  const votes = new Map<number, number>();
  for (const { end, fy } of byAccn.values()) {
    const diff = fy - shiftedYear(end);
    if (Math.abs(diff) <= 1) votes.set(diff, (votes.get(diff) ?? 0) + 1);
  }
  const offset = [...votes].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0]?.[0] ?? 0;

  // 3) 태그별 연도 값: 같은 연도는 기간 끝이 늦은 값, 같은 기간이면 나중에 제출한(정정 반영) 값
  const memo = new Map<string, Map<number, { end: string; filed: string; val: number }>>();
  const series = (c: Concept, d: boolean) => {
    const k = `${c.tax}:${c.name}`;
    const hit = memo.get(k);
    if (hit) return hit;
    const by = new Map<number, { end: string; filed: string; val: number }>();
    for (const r of rowsOf(c, d)) {
      const year = shiftedYear(r.end) + offset;
      const filed = r.filed ?? "";
      const prev = by.get(year);
      if (!prev || r.end > prev.end || (r.end === prev.end && filed > prev.filed)) by.set(year, { end: r.end, filed, val: r.val });
    }
    memo.set(k, by);
    return by;
  };
  const keyYears = new Set<number>();
  for (const [cs, d] of KEY) for (const c of cs) for (const y of series(c, d).keys()) keyYears.add(y);
  if (!keyYears.size) return [];
  const latest = Math.max(...keyYears);
  const inWindow = (s: Map<number, unknown>) => [...s.keys()].filter((y) => y > latest - CHOICE_WINDOW && y <= latest).length;

  // 4) 항목마다 태그 하나 (위 우선순위 설명 참고). reported: 최근 5개 연도에 이 항목을 보고했는지
  const choose = (cs: Concept[], d: boolean): { values: Map<number, number>; reported: boolean } => {
    const cands = cs.map((c, idx) => ({ idx, s: series(c, d) })).filter((x) => x.s.size > 0);
    const values = new Map<number, number>();
    const first = [...cands].sort((a, b) => Number(b.s.has(latest)) - Number(a.s.has(latest)) || inWindow(b.s) - inWindow(a.s) || a.idx - b.idx)[0];
    if (!first) return { values, reported: false };
    for (const [y, v] of first.s) values.set(y, v.val);
    for (const x of cands) {
      if (x === first) continue;
      const overlap = [...x.s.keys()].filter((y) => values.has(y));
      if (!overlap.length || !overlap.every((y) => sameValue(values.get(y)!, x.s.get(y)!.val))) continue;
      for (const [y, v] of x.s) if (!values.has(y)) values.set(y, v.val);
    }
    return { values, reported: inWindow(values) > 0 };
  };
  const revenue = choose(REVENUE, true);
  const operating = choose(OPERATING, true);
  const net = choose(NET, true);
  const assets = choose(ASSETS, false);
  const liabilities = choose(LIABILITIES, false);
  const equity = choose(EQUITY, false);
  const equityParent = choose(EQUITY_PARENT, false);
  const equityWithNci = choose(EQUITY_WITH_NCI, false);
  const nci = choose(NCI, false);

  const years = [...new Set([...revenue.values.keys(), ...net.values.keys(), ...assets.values.keys()])].sort((a, b) => a - b);
  return years.map((year) => {
    const notes: string[] = [];
    const revenueVal = revenue.values.get(year) ?? null;
    const operatingVal = operating.values.get(year) ?? null;
    if (currency !== "USD") notes.push(`금액 통화: ${currency} (주가 통화와 다를 수 있음)`);
    if (revenueVal === null && !revenue.reported) notes.push("매출: 회사가 매출 합계 항목을 보고하지 않아 비워 둠");
    if (operatingVal === null && !operating.reported) notes.push("영업이익: 회사가 영업이익 항목을 보고하지 않아 비워 둠 (세전이익으로 대신하지 않음)");
    const totalAssets = assets.values.get(year) ?? null;
    let totalLiabilities = liabilities.values.get(year) ?? null;
    if (totalLiabilities === null) {
      // 부채총계 = 자산총계 − 자본총계(비지배지분 포함)
      const parent = equityParent.values.get(year);
      const eq = equityWithNci.values.get(year) ?? (parent !== undefined ? parent + (nci.values.get(year) ?? 0) : undefined);
      if (totalAssets !== null && eq !== undefined) {
        totalLiabilities = totalAssets - eq;
        notes.push("부채총계: 회사가 따로 보고하지 않아 자산총계 − 자본총계로 계산");
      } else if (!liabilities.reported) notes.push("부채총계: 회사가 따로 보고하지 않아 비워 둠");
    }
    return {
      year,
      basis: "CFS" as const,
      revenue: revenueVal,
      operatingIncome: operatingVal,
      netIncome: net.values.get(year) ?? null,
      totalAssets,
      totalLiabilities,
      totalEquity: equity.values.get(year) ?? null,
      currency,
      ...(notes.length ? { notes } : {}),
    };
  });
}
