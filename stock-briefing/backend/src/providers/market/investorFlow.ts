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

/**
 * 종목 상세 '수급' 탭의 하루 한 줄 (3-33, 플래그 flowTab). 공개 출처(토스 웹·네이버)의 원자료를 같은 모양으로 맞춘 것.
 * 값이 없으면 null (지어내지 않는다). 순매수 = 산 주식 수 − 판 주식 수 (주 수, 금액 아님)
 */
export interface FlowTrendRow {
  date: string; // YYYY-MM-DD (한국 날짜)
  individual: number | null;
  foreign: number | null;
  institution: number | null;
  /** 기타법인 (토스 웹만 — 네이버는 늘 null) */
  otherCorp: number | null;
  /** 외국인 보유율 % (보유 ÷ 상장 주식 수) */
  foreignRatio: number | null;
  /** 외국인 보유 주식 수·한도 주식 수 (토스 웹만) */
  foreignHolding: number | null;
  foreignLimit: number | null;
  close: number | null;
  /** 장중 값인지 (토스 웹만, 모르면 null) */
  inMarketTime: boolean | null;
  /**
   * 개인·기관·외국인 값이 모두 나왔는지 (토스 웹 hasIndividual·hasInstitution·hasForeigner — 셋 다 참일 때만 참, 모르면 null).
   * 거짓인 분류의 값은 파서가 null 로 둔다 (아직 나오지 않은 값을 0 으로 읽지 않게)
   */
  hasAll: boolean | null;
  /** 출처가 그 줄을 마지막으로 고친 시각 (토스 웹만) */
  updatedAt: string | null;
}

/** 수급 탭 출처 하나 (최신순 줄). 받지 못하거나 모양이 바뀌면 던진다. 자료가 없는 종목은 빈 배열 */
export interface FlowTrendSource {
  readonly name: string;
  trend(code: string, size: number): Promise<FlowTrendRow[]>;
  /**
   * 상장 주식 수 (토스 웹만 — 외국인 한도율을 보유율 반올림 없이 셈하려고). 모르면 null, 던지지 않는다.
   * 없으면(네이버·테스트 가짜) 한도율은 보유율로 어림하고, 어림 오차가 크면 한도 줄을 뺀다
   */
  listedShares?(code: string): Promise<number | null>;
}
