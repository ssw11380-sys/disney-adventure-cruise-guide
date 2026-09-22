/** 투자자별 매매동향 (수급). KIS 에서만 제공된다. */
export interface InvestorFlowDay {
  date: string; // YYYY-MM-DD
  close: number | null;
  individual: number | null; // 개인 순매수 수량
  foreign: number | null; // 외국인 순매수 수량
  institution: number | null; // 기관 순매수 수량
}

export interface InvestorFlowProvider {
  readonly name: string;
  getInvestorFlow(code: string, days: number): Promise<InvestorFlowDay[]>;
}
