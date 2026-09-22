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

/** 2단계에서 채워질 브리핑 테이블. 1단계에서 스키마만 미리 잡아둔다. */
export interface BriefingTable {
  id: Generated<number>;
  code: string;
  session: string; // 'morning' | 'afternoon'
  briefing_date: string; // YYYY-MM-DD (KST)
  summary: string;
  detail: string;
  data_snapshot: string; // JSON
  missing_data: string; // JSON string[]
  model: string;
  created_at: string;
}

export interface Database {
  listed_stocks: ListedStockTable;
  registered_stocks: RegisteredStockTable;
  quote_cache: QuoteCacheTable;
  meta: MetaTable;
  briefings: BriefingTable;
}
