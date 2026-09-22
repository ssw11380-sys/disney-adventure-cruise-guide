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

export interface Database {
  listed_stocks: ListedStockTable;
  registered_stocks: RegisteredStockTable;
  quote_cache: QuoteCacheTable;
  meta: MetaTable;
  briefings: BriefingTable;
  analyses: AnalysisTable;
  dart_corp_codes: DartCorpCodeTable;
  devices: DeviceTable;
}
