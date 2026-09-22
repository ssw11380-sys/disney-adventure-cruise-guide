export interface Disclosure {
  receiptNo: string; // rcept_no
  title: string; // report_nm
  filedAt: string; // YYYY-MM-DD
  filer: string; // flr_nm
  url: string; // DART 뷰어 링크
}

export interface CompanyProfile {
  corpCode: string;
  name: string;
  ceo: string | null;
  industryCode: string | null;
  established: string | null; // YYYY-MM-DD
  homepage: string | null;
  address: string | null;
  fiscalMonth: string | null; // 결산월
}

/** 연도별 주요 계정 (원 단위). 연결(CFS) 우선, 없으면 개별(OFS). */
export interface AnnualFinancials {
  year: number;
  basis: "CFS" | "OFS";
  revenue: number | null; // 매출액
  operatingIncome: number | null; // 영업이익
  netIncome: number | null; // 당기순이익
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
}

export interface DividendInfo {
  year: number;
  cashDividendPerShare: number | null; // 주당 현금배당금 (보통주)
  dividendYieldPct: number | null; // 현금배당수익률 (%)
  payoutRatioPct: number | null; // 현금배당성향 (%)
}

export interface FinancialsProvider {
  readonly name: string;
  getCompany(stockCode: string): Promise<CompanyProfile>;
  getDisclosures(stockCode: string, days: number, limit: number): Promise<Disclosure[]>;
  getAnnualFinancials(stockCode: string, years: number): Promise<AnnualFinancials[]>;
  getDividends(stockCode: string, years: number): Promise<DividendInfo[]>;
}
