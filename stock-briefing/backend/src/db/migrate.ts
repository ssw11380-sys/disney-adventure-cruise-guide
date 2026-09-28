import { sql, type ColumnDefinitionBuilder, type Kysely } from "kysely";
import type { Database } from "./schema.js";

export type Dialect = "sqlite" | "postgres";

/**
 * 스키마 마이그레이션. 아직 규모가 작아 순차 버전 배열로 관리한다.
 * SQLite/Postgres 공용. 방언 차이는 자동 증가 id 컬럼뿐이다.
 */
const idColumn = (dialect: Dialect) => (c: ColumnDefinitionBuilder) =>
  dialect === "postgres" ? c.primaryKey().generatedAlwaysAsIdentity() : c.primaryKey().autoIncrement();

const migrations: Array<{ version: number; up: (db: Kysely<Database>, dialect: Dialect) => Promise<void> }> = [
  {
    version: 1,
    up: async (db, dialect) => {
      await db.schema
        .createTable("listed_stocks")
        .ifNotExists()
        .addColumn("code", "text", (c) => c.primaryKey())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("market", "text", (c) => c.notNull())
        .addColumn("isin_code", "text")
        .addColumn("group_code", "text")
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("idx_listed_stocks_name")
        .ifNotExists()
        .on("listed_stocks")
        .column("name")
        .execute();

      await db.schema
        .createTable("registered_stocks")
        .ifNotExists()
        .addColumn("code", "text", (c) => c.primaryKey())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("market", "text", (c) => c.notNull())
        .addColumn("quantity", "real")
        .addColumn("avg_price", "real")
        .addColumn("memo", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("quote_cache")
        .ifNotExists()
        .addColumn("code", "text", (c) => c.primaryKey())
        .addColumn("payload", "text", (c) => c.notNull())
        .addColumn("fetched_at", "text", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("meta")
        .ifNotExists()
        .addColumn("key", "text", (c) => c.primaryKey())
        .addColumn("value", "text", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("briefings")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("code", "text", (c) => c.notNull())
        .addColumn("session", "text", (c) => c.notNull())
        .addColumn("briefing_date", "text", (c) => c.notNull())
        .addColumn("summary", "text", (c) => c.notNull())
        .addColumn("detail", "text", (c) => c.notNull())
        .addColumn("data_snapshot", "text", (c) => c.notNull())
        .addColumn("missing_data", "text", (c) => c.notNull())
        .addColumn("model", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("idx_briefings_code_date")
        .ifNotExists()
        .on("briefings")
        .columns(["code", "briefing_date", "session"])
        .execute();
    },
  },
  {
    version: 2,
    up: async (db, dialect) => {
      // 1단계에서 미리 만든 briefings 테이블에 상태/오류 컬럼 추가 (아직 데이터 없음)
      await db.schema.alterTable("briefings").addColumn("status", "text", (c) => c.notNull().defaultTo("ok")).execute();
      await db.schema.alterTable("briefings").addColumn("error", "text").execute();
      await sql`create unique index if not exists uq_briefings_code_date_session on briefings (code, briefing_date, session)`.execute(db);

      await db.schema
        .createTable("analyses")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("code", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("content", "text", (c) => c.notNull())
        .addColumn("data_snapshot", "text", (c) => c.notNull())
        .addColumn("missing_data", "text", (c) => c.notNull())
        .addColumn("model", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("idx_analyses_code_kind")
        .ifNotExists()
        .on("analyses")
        .columns(["code", "kind", "created_at"])
        .execute();

      await db.schema
        .createTable("dart_corp_codes")
        .ifNotExists()
        .addColumn("stock_code", "text", (c) => c.primaryKey())
        .addColumn("corp_code", "text", (c) => c.notNull())
        .addColumn("corp_name", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
    },
  },
  {
    version: 3,
    up: async (db) => {
      await db.schema
        .createTable("devices")
        .ifNotExists()
        .addColumn("token", "text", (c) => c.primaryKey())
        .addColumn("platform", "text", (c) => c.notNull())
        .addColumn("device_name", "text")
        .addColumn("enabled", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("disabled_reason", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("last_seen_at", "text", (c) => c.notNull())
        .execute();
    },
  },
  {
    version: 4,
    up: async (db, dialect) => {
      // 앱 오류 수집 (3-3). 새 표만 추가하고 기존 표는 건드리지 않는다
      await db.schema
        .createTable("app_errors")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("at", "text", (c) => c.notNull())
        .addColumn("occurred_at", "text")
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("message", "text", (c) => c.notNull())
        .addColumn("stack", "text")
        .addColumn("screen", "text")
        .addColumn("fingerprint", "text", (c) => c.notNull())
        .addColumn("app_version", "text")
        .addColumn("update_id", "text")
        .addColumn("platform", "text")
        .execute();
      await db.schema.createIndex("idx_app_errors_at").ifNotExists().on("app_errors").column("at").execute();
    },
  },
  {
    version: 5,
    up: async (db, dialect) => {
      // 계좌 한 장 브리핑 (3-31). 새 표만 추가하고 기존 표는 건드리지 않는다. 날짜·세션마다 1건 (다시 만들면 덮어쓴다)
      await db.schema
        .createTable("account_briefings")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("briefing_date", "text", (c) => c.notNull())
        .addColumn("session", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("summary", "text", (c) => c.notNull())
        .addColumn("detail", "text", (c) => c.notNull())
        .addColumn("data", "text", (c) => c.notNull())
        .addColumn("model", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();
      await sql`create unique index if not exists uq_account_briefings_date_session on account_briefings (briefing_date, session)`.execute(db);
    },
  },
  {
    version: 6,
    up: async (db, dialect) => {
      // BH-48. Postgres 의 real 은 4바이트라 토스 소수 수량·평단 끝자리가 달라진다(16.123456 → 16.123455) → 8바이트로.
      // 값은 지금까지 읽히던 표기(::text) 그대로 옮긴다. SQLite 의 REAL 은 이미 8바이트라 바꾸지 않는다 (버전만 기록).
      // 5(계좌 한 장 브리핑)가 이미 배포돼 있어 6 이다. 번호는 겹치면 안 된다 (겹치면 새 DB 는 기록 충돌, 5 까지 올라간 DB 는 건너뜀)
      if (dialect !== "postgres") return;
      await sql`alter table registered_stocks
        alter column quantity type double precision using quantity::text::double precision,
        alter column avg_price type double precision using avg_price::text::double precision`.execute(db);
    },
  },
  {
    version: 7,
    up: async (db, dialect) => {
      // 시장 전체 요약 (플래그 marketSummary). 새 표만 추가하고 기존 표는 건드리지 않는다. 날짜·세션마다 1건 (다시 만들면 덮어쓴다).
      // 예전 서버로 되돌려도 이 표를 모르고 지나갈 뿐이다
      await db.schema
        .createTable("market_summaries")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("summary_date", "text", (c) => c.notNull())
        .addColumn("session", "text", (c) => c.notNull())
        .addColumn("market", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("summary", "text", (c) => c.notNull())
        .addColumn("data", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();
      await sql`create unique index if not exists uq_market_summaries_date_session on market_summaries (summary_date, session)`.execute(db);
    },
  },
  {
    version: 8,
    up: async (db, dialect) => {
      // 매매 기록 기반 (3-36, 플래그 tradeRecords). 새 표 두 개만 추가하고 기존 표는 건드리지 않는다 (예전 서버로 되돌려도 모르고 지나갈 뿐).
      // 수량·금액은 8바이트 실수 — Postgres 의 real 은 4바이트라 소수 수량 끝자리가 달라진다(BH-48, 버전 6)
      const dbl = dialect === "postgres" ? "double precision" : "real";
      await db.schema
        .createTable("account_snapshots")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("snapshot_date", "text", (c) => c.notNull())
        .addColumn("market", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("method", "text")
        .addColumn("as_of", "text", (c) => c.notNull())
        .addColumn("scheduled_at", "text", (c) => c.notNull())
        .addColumn("source", "text")
        .addColumn("reason", "text")
        .addColumn("holdings_count", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("total_value_krw", dbl)
        .addColumn("data", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      // 시장·거래일마다 한 줄 (서버가 겹쳐 떠도 두 번 쓰지 않게)
      await sql`create unique index if not exists uq_account_snapshots_date_market on account_snapshots (snapshot_date, market)`.execute(db);
      await db.schema
        .createTable("trade_executions")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("account", "integer", (c) => c.notNull())
        .addColumn("order_id", "text", (c) => c.notNull())
        .addColumn("code", "text", (c) => c.notNull())
        .addColumn("market", "text", (c) => c.notNull())
        .addColumn("side", "text", (c) => c.notNull())
        .addColumn("quantity", dbl, (c) => c.notNull())
        .addColumn("amount", dbl, (c) => c.notNull())
        .addColumn("price", dbl)
        .addColumn("currency", "text", (c) => c.notNull())
        .addColumn("fee", dbl)
        .addColumn("tax", dbl)
        .addColumn("executed_at", "text", (c) => c.notNull())
        .addColumn("executed_date", "text", (c) => c.notNull())
        .addColumn("time_basis", "text", (c) => c.notNull())
        .addColumn("order_status", "text", (c) => c.notNull())
        .addColumn("source", "text", (c) => c.notNull())
        .addColumn("raw", "text", (c) => c.notNull())
        // 받을 때마다 늘어난 체결 몫 (JSON, 없으면 null — 며칠에 걸친 부분 체결의 날짜별 몫)
        .addColumn("fills", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      // 토스 주문번호로 중복 없음 (계좌마다)
      await sql`create unique index if not exists uq_trade_executions_account_order on trade_executions (account, order_id)`.execute(db);
      await sql`create index if not exists idx_trade_executions_date on trade_executions (executed_date)`.execute(db);
    },
  },
  {
    version: 9,
    up: async (db, dialect) => {
      // 지표 점수 기록 (3-44, 플래그 indicatorScores). 새 표만 추가하고 기존 표는 건드리지 않는다 (예전 서버로 되돌려도 모르고 지나갈 뿐).
      // 점수는 8바이트 실수 — Postgres 의 real 은 4바이트 (BH-48)
      const dbl = dialect === "postgres" ? "double precision" : "real";
      await db.schema
        .createTable("indicator_scores")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("score_date", "text", (c) => c.notNull())
        .addColumn("code", "text", (c) => c.notNull())
        .addColumn("market", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("version", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("score", dbl)
        .addColumn("score_today", dbl)
        .addColumn("band", "text")
        .addColumn("data", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      // 종목·기준일·종류마다 한 줄 (같은 날 다시 계산하면 덮어쓴다)
      await sql`create unique index if not exists uq_indicator_scores_code_date_kind on indicator_scores (code, score_date, kind)`.execute(db);
    },
  },
  {
    version: 10, // main 의 가장 큰 번호(9) + 1 (작업지시 3-29 0.4). 번호가 겹치면 이미 그 번호까지 올라간 DB 는 이 표를 건너뛴다
    up: async (db, dialect) => {
      // 가격 알림 조건 (3-29, 플래그 priceAlerts). 새 표만 추가하고 기존 표는 건드리지 않는다. 예전 서버로 되돌려도 이 표를 모르고 지나갈 뿐이다.
      // 값은 Postgres 에서 double precision (real 은 4바이트라 끝자리가 달라진다 — 버전 6 BH-48)
      const num = dialect === "postgres" ? "double precision" : "real";
      await db.schema
        .createTable("price_alerts")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("code", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("value", num, (c) => c.notNull())
        .addColumn("currency", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("fired_on", "text")
        .addColumn("fired_at", "text")
        .addColumn("fired_value", num)
        .execute();
      // 같은 (종목·조건 종류·값)은 하나만 (동시에 두 번 저장해도 하나만 들어간다)
      await sql`create unique index if not exists uq_price_alerts_rule on price_alerts (code, kind, value)`.execute(db);
    },
  },
];

export async function migrate(db: Kysely<Database>, dialect: Dialect = "sqlite"): Promise<void> {
  await sql`create table if not exists schema_version (version integer primary key)`.execute(db);
  const rows = await sql<{ version: number }>`select version from schema_version`.execute(db);
  const applied = new Set(rows.rows.map((r) => Number(r.version)));
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    await m.up(db, dialect);
    await sql`insert into schema_version (version) values (${m.version})`.execute(db);
  }
}
