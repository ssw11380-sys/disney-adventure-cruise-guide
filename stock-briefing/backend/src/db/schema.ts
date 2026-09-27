import type { ColumnType, Generated } from "kysely";

/** Kysely 테이블 타입. SQLite/Postgres 공용으로 쓸 수 있는 컬럼 타입만 사용한다. */

export interface ListedStockTable {
  code: string;
  name: string;
  market: string;
  isin_code: string | null;
  group_code: string | null;
  updated_at: string;
}

export interface RegisteredStockTable {
  code: string;
  name: string;
  market: string;
  quantity: number | null;
  avg_price: number | null;
  memo: string | null;
  created_at: ColumnType<string, string, never>;
  updated_at: string;
}

export interface QuoteCacheTable {
  code: string;
  payload: string; // JSON(Quote)
  fetched_at: string;
}

export interface MetaTable {
  key: string;
  value: string;
}

export interface BriefingTable {
  id: Generated<number>;
  code: string;
  session: string; // 'morning' | 'afternoon'
  briefing_date: string; // YYYY-MM-DD (KST)
  status: string; // 'ok' | 'failed'
  summary: string; // 3줄 요약 (실패 시 실패 사유)
  detail: string; // 상세 브리핑 마크다운
  data_snapshot: string; // JSON
  missing_data: string; // JSON string[]
  model: string;
  error: string | null;
  created_at: string;
}

/** 종목 상세 탭(회사 소개/가치/기술) 분석 결과 캐시 */
export interface AnalysisTable {
  id: Generated<number>;
  code: string;
  kind: string; // 'company' | 'value' | 'technical'
  content: string; // 마크다운
  data_snapshot: string; // JSON
  missing_data: string; // JSON string[]
  model: string;
  created_at: string;
}

/** DART 고유번호 매핑 (종목코드 → corp_code) */
export interface DartCorpCodeTable {
  stock_code: string;
  corp_code: string;
  corp_name: string;
  updated_at: string;
}

/** 푸시 알림 기기 (Expo 푸시 토큰이 식별자) */
export interface DeviceTable {
  token: string;
  platform: string;
  device_name: string | null;
  enabled: number; // 1 | 0 (SQLite/Postgres 공용)
  disabled_reason: string | null;
  created_at: string;
  last_seen_at: string;
}

/** 앱이 보낸 JS 오류 (토큰·금액은 지운 뒤 저장) */
export interface AppErrorTable {
  id: Generated<number>;
  at: string; // 서버 수신 시각 (한국 시간 ISO)
  occurred_at: string | null; // 앱에서 난 시각
  kind: string; // fatal | js | render | promise | test
  message: string;
  stack: string | null;
  screen: string | null;
  fingerprint: string;
  app_version: string | null;
  update_id: string | null;
  platform: string | null;
}

/** 계좌 한 장 브리핑 (3-31): 세션(날짜·오전/오후)마다 1건. 숫자는 data(JSON)에 코드로 계산해 두고, detail 은 그 숫자를 설명한 마크다운 */
export interface AccountBriefingTable {
  id: Generated<number>;
  briefing_date: string; // YYYY-MM-DD (KST)
  session: string; // 'morning' | 'afternoon'
  status: string; // 'ok' | 'failed'
  summary: string; // 알림·카드용 요약 (코드로 만든 문장)
  detail: string; // 설명 마크다운 (모델 또는 기본 문장)
  data: string; // JSON(AccountData)
  model: string; // 설명을 쓴 모델 이름, 기본 문장이면 'template'
  created_at: string;
}

/** 시장 전체 요약 (플래그 marketSummary): 세션(날짜·오전/오후)마다 1건. 숫자·뉴스 제목은 data(JSON), summary 는 만든 때의 요약 줄 (모델 문장 없음) */
export interface MarketSummaryTable {
  id: Generated<number>;
  summary_date: string; // YYYY-MM-DD (KST, 브리핑 세션 날짜)
  session: string; // 'morning' | 'afternoon'
  market: string; // 'US' (아침) | 'KR' (오후)
  status: string; // 'ok' | 'failed'
  summary: string; // 만든 때의 요약 줄 (코드로 만든 문장)
  data: string; // JSON(MarketSummaryData)
  created_at: string;
}

/**
 * 매매 기록 (3-36, 플래그 tradeRecords): 시장(한국·미국)의 거래일마다 1줄 — 장 마감 뒤 토스 보유 조회로 찍은 스냅샷(ok) 또는
 * 그날을 놓쳐 값이 없다는 빈칸 표시(gap, 값은 지어내지 않음). 종목별 값은 data(JSON)
 */
export interface AccountSnapshotTable {
  id: Generated<number>;
  snapshot_date: string; // YYYY-MM-DD, 그 시장 현지 거래일 (한국 = 서울, 미국 = 뉴욕)
  market: string; // 'KR' | 'US'
  status: string; // 'ok' | 'gap'
  method: string | null; // 'close'(마감 직후) | 'intraday-fallback'(늦게 찍음) | null(gap)
  as_of: string; // 찍은 시각(gap 은 빈칸으로 적은 시각), 한국 시간 ISO
  scheduled_at: string; // 그 거래일의 예약 시각 (한국 16:05 · 미국 마감 5분 뒤), 한국 시간 ISO
  source: string | null; // 'toss-openapi' | null(gap)
  reason: string | null; // gap 까닭 등
  holdings_count: number;
  total_value_krw: number | null; // 평가금액 원화 합계 (미국은 기록한 환율로, 환율이 없으면 null)
  data: string; // JSON(SnapshotData), gap 은 '{}'
  created_at: string;
  updated_at: string;
}

/**
 * 체결 기록 (3-36): 토스 주문 내역의 체결된 주문 1건 = 1줄 (계좌·주문번호로 중복 없음). 부분 체결은 누적 수량·금액과 마지막 체결 시각으로 고친다.
 * 수수료·세금은 토스 주문 내역 칸을 확인한 뒤 채운다(지금은 null, 원본은 raw). 체결 시점 환율은 저장하지 않는다 — 미국 체결의 원화 금액(3-37 원화 실현손익·
 * 해외 양도세)은 원화 장부처럼 토스 과거 환율(usdKrwAt, 체결 시각 기준)로 채워야 한다
 */
export interface TradeExecutionTable {
  id: Generated<number>;
  account: number; // 토스 계좌 순번(accountSeq) — 계좌번호가 아님
  order_id: string;
  code: string;
  market: string; // 'KR' | 'US'
  side: string; // 'BUY' | 'SELL'
  quantity: number; // 누적 체결 수량
  amount: number; // 누적 체결 금액 (종목 통화)
  price: number | null; // 평균 체결가 = amount / quantity
  currency: string; // 'KRW' | 'USD'
  fee: number | null;
  tax: number | null;
  executed_at: string; // 마지막 체결 시각 (없으면 주문 시각, 그것도 없으면 처음 받은 시각 — time_basis 로 구분, 처음 받은 시각은 다시 받아도 바꾸지 않음), 토스가 준 표기 그대로
  executed_date: string; // 그 시장 거래일 YYYY-MM-DD
  time_basis: string; // 'filled' | 'ordered' | 'seen'
  order_status: string; // 'CLOSED' | 'OPEN'
  source: string; // 'toss-orders'
  raw: string; // JSON (계좌번호 칸은 뺌)
  /**
   * JSON — 받을 때마다 늘어난 누적 체결 수량·금액과 그 몫의 시각 [{ q, a, at, basis, seenAt }] (합 = quantity). 며칠에 걸친 부분 체결의 날짜별 몫을
   * 잃지 않으려고 둔다 (at = 그때 토스가 준 마지막 체결 시각, 없으면 받은 시각 seenAt). 없으면(null) 한 번에 executed_at 에 체결된 것으로 본다
   */
  fills: string | null;
  created_at: string;
  updated_at: string;
}

export interface Database {
  listed_stocks: ListedStockTable;
  registered_stocks: RegisteredStockTable;
  quote_cache: QuoteCacheTable;
  meta: MetaTable;
  briefings: BriefingTable;
  analyses: AnalysisTable;
  dart_corp_codes: DartCorpCodeTable;
  devices: DeviceTable;
  app_errors: AppErrorTable;
  account_briefings: AccountBriefingTable;
  market_summaries: MarketSummaryTable;
  account_snapshots: AccountSnapshotTable;
  trade_executions: TradeExecutionTable;
}
