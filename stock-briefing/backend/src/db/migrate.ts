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
  {
    version: 11, // main 의 가장 큰 번호(10) + 1. 새 표만 추가하고 기존 표는 건드리지 않는다 (예전 서버로 되돌려도 모르고 지나갈 뿐)
    up: async (db, dialect) => {
      // 가치 지표 점수 (3-44 2단계, 플래그 valueScore): 종목별 SEC 재무(줄인 companyfacts)와 주 1회 비교 기준(업종 분포)
      await db.schema
        .createTable("value_fundamentals")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("code", "text", (c) => c.notNull())
        .addColumn("cik", "text", (c) => c.notNull())
        .addColumn("sic", "integer")
        .addColumn("last_filed", "text")
        .addColumn("fetched_at", "text", (c) => c.notNull())
        .addColumn("data", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      await sql`create unique index if not exists uq_value_fundamentals_code on value_fundamentals (code)`.execute(db);
      await db.schema
        .createTable("value_references")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("market", "text", (c) => c.notNull())
        .addColumn("ref_date", "text", (c) => c.notNull())
        .addColumn("method", "text", (c) => c.notNull())
        .addColumn("data", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .execute();
      // 시장·기준일마다 한 줄 (같은 날 다시 만들면 덮어쓴다)
      await sql`create unique index if not exists uq_value_references_market_date on value_references (market, ref_date)`.execute(db);
    },
  },
  {
    version: 12,
    up: async (db) => {
      // 종목을 지정하지 않은 최신 목록도 전체 보고서를 정렬하지 않고 조회한다. 기존 내용과 이력은 보존한다.
      await sql`create index if not exists idx_briefings_date_created on briefings (briefing_date desc, created_at desc)`.execute(db);
    },
  },
  {
    version: 13,
    up: async (db) => {
      // 기존 보고서·계좌 자료는 그대로 두고 작업 소유권·완료 단계·원 재무값을 별도 보존한다.
      await db.schema.createTable("generation_jobs").ifNotExists()
        .addColumn("job_key", "text", (c) => c.primaryKey())
        .addColumn("run_id", "text", (c) => c.notNull())
        .addColumn("owner", "text", (c) => c.notNull())
        .addColumn("signature", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("started_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .addColumn("lease_until", "text", (c) => c.notNull())
        .addColumn("checkpoint", "text", (c) => c.notNull())
        .addColumn("result", "text")
        .addColumn("error", "text").execute();
      await sql`create index if not exists idx_generation_jobs_status_lease on generation_jobs (status, lease_until)`.execute(db);
      await sql`create index if not exists idx_generation_jobs_status_updated on generation_jobs (status, updated_at)`.execute(db);
      await db.schema.createTable("generation_requests").ifNotExists()
        .addColumn("request_key", "text", (c) => c.primaryKey())
        .addColumn("job_key", "text", (c) => c.notNull())
        .addColumn("run_id", "text", (c) => c.notNull())
        .addColumn("status", "text", (c) => c.notNull())
        .addColumn("result", "text")
        .addColumn("updated_at", "text", (c) => c.notNull()).execute();
      await sql`create index if not exists idx_generation_requests_run on generation_requests (job_key, run_id)`.execute(db);
      await sql`create index if not exists idx_generation_requests_updated on generation_requests (updated_at)`.execute(db);
      await db.schema.createTable("fundamentals_cache").ifNotExists()
        .addColumn("code", "text", (c) => c.primaryKey())
        .addColumn("payload", "text", (c) => c.notNull())
        .addColumn("fetched_at", "text", (c) => c.notNull()).execute();
    },
  },
  {
    version: 14,
    up: async (db) => {
      // 관심 가격은 보유 수량·평단과 독립해 보존한다.
      await db.schema.createTable("watch_items").ifNotExists()
        .addColumn("code", "text", c => c.primaryKey())
        .addColumn("name", "text", c => c.notNull())
        .addColumn("market", "text", c => c.notNull())
        .addColumn("start_price", "double precision", c => c.notNull())
        .addColumn("desired_price", "double precision", c => c.notNull())
        .addColumn("alerts", "integer", c => c.notNull())
        .addColumn("revision", "text", c => c.notNull())
        .addColumn("created_at", "text", c => c.notNull())
        .addColumn("updated_at", "text", c => c.notNull()).execute();
      await db.schema.createTable("movement_marks").ifNotExists()
        .addColumn("mark_key", "text", c => c.primaryKey())
        .addColumn("up", "integer", c => c.notNull().defaultTo(0))
        .addColumn("down", "integer", c => c.notNull().defaultTo(0))
        .addColumn("created_at", "text", c => c.notNull()).execute();
      await db.schema.createTable("movement_events").ifNotExists()
        .addColumn("event_key", "text", c => c.primaryKey()).addColumn("code", "text", c => c.notNull())
        .addColumn("scope", "text", c => c.notNull()).addColumn("payload", "text", c => c.notNull())
        .addColumn("created_at", "text", c => c.notNull()).execute();
      await sql`create index if not exists idx_movement_events_created on movement_events (created_at)`.execute(db);
    },
  },
  {
    version: 15, // main 의 가장 큰 번호(14) + 1 (병합 때 다시 맞춤). 새 표만 추가 — 예전 서버로 되돌려도 모르고 지나갈 뿐
    up: async (db, dialect) => {
      // SEC 공시 확인 (3-38, 플래그 filingAlerts): CIK 마다 기준 잡기·마지막 성공 — 공용(공개 자료, 누구의 것도 아님)
      await db.schema
        .createTable("sec_filing_watch")
        .ifNotExists()
        .addColumn("cik", "text", (c) => c.primaryKey())
        .addColumn("first_ok_at", "text") // null = 아직 기준을 잡지 않음
        .addColumn("last_try_at", "text")
        .addColumn("last_ok_at", "text")
        .addColumn("last_error", "text")
        .execute();
      // 받은 공시 (알림 서식만, 90일 보관) — 공용
      await db.schema
        .createTable("sec_filings")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("cik", "text", (c) => c.notNull())
        .addColumn("accession", "text", (c) => c.notNull())
        .addColumn("form", "text", (c) => c.notNull())
        .addColumn("items", "text", (c) => c.notNull()) // "2.02,9.01" · ""
        .addColumn("accepted_at", "text") // ISO UTC · null
        .addColumn("filing_date", "text", (c) => c.notNull())
        .addColumn("report_date", "text")
        .addColumn("primary_doc", "text", (c) => c.notNull())
        .addColumn("description", "text", (c) => c.notNull())
        .addColumn("baseline", "integer", (c) => c.notNull()) // 1 = 알리지 않음(기준 잡기·24시간 넘음)
        .addColumn("first_seen_at", "text", (c) => c.notNull())
        .execute();
      await sql`create unique index if not exists uq_sec_filings_cik_acc on sec_filings (cik, accession)`.execute(db);
      await sql`create index if not exists ix_sec_filings_seen on sec_filings (first_seen_at)`.execute(db);
    },
  },
  {
    // main 의 가장 큰 번호(15) + 1 (처음 12 로 만들었다가 main 에 12~15 가 먼저 들어가 병합 때 다시 매김) — 'if not exists' 라 번호가 바뀌어도 안전.
    // 새 표만 추가하고 기존 표는 건드리지 않는다 (예전 서버로 되돌려도 모르고 지나갈 뿐)
    version: 16,
    up: async (db, dialect) => {
      // 매매일지 (3-37, 플래그 tradeJournal): 거래 메모(주문 하나 = 메모 하나 — 체결 표와 따로 둬 토스 동기화가 덮어쓰지 않게)와
      // 환율 기록(세법 기준환율·토스 과거 환율 — 지난 값은 바뀌지 않아 받은 대로 둔다). 환율은 8바이트 실수 (Postgres real 은 4바이트 — BH-48)
      const dbl = dialect === "postgres" ? "double precision" : "real";
      await db.schema
        .createTable("trade_notes")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("account", "integer", (c) => c.notNull())
        .addColumn("order_id", "text", (c) => c.notNull())
        .addColumn("note", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      await sql`create unique index if not exists uq_trade_notes_account_order on trade_notes (account, order_id)`.execute(db);
      await db.schema
        .createTable("fx_rates")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("at", "text", (c) => c.notNull())
        .addColumn("rate", dbl, (c) => c.notNull())
        .addColumn("source", "text", (c) => c.notNull())
        .addColumn("fetched_at", "text", (c) => c.notNull())
        .execute();
      await sql`create unique index if not exists uq_fx_rates_kind_at on fx_rates (kind, at)`.execute(db);
    },
  },
  {
    // main 의 가장 큰 번호(16) + 1 (처음 12 로 만들었다가 main 에 12~16 이 먼저 들어가 병합 때 다시 매김) — 'if not exists'·칸 있음 검사라 번호가 바뀌어도 안전.
    // 새 표 하나 + registered_stocks 에 비어 있을 수 있는 칸 둘 (예전 서버로 되돌려도 모르고 지나갈 뿐)
    version: 17,
    up: async (db, dialect) => {
      // 관심 종목 그룹·순서 (3-34, 플래그 watchGroups)
      await db.schema
        .createTable("watch_groups")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("position", "integer", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      // SQLite 는 ALTER TABLE 한 번에 칸 하나 → 칸마다 따로. 중간에 멈췄다 다시 돌 때 이미 있는 칸은 건너뛴다
      for (const col of ["watch_group_id", "watch_position"] as const)
        if (!(await hasColumn(db, dialect, "registered_stocks", col))) await db.schema.alterTable("registered_stocks").addColumn(col, "integer").execute();
    },
  },
  {
    // main 의 가장 큰 번호(17) + 1 (처음 12·13 으로 만들었다가 main 에 12~17 이 먼저 들어가 병합 때 다시 매김) — 'if not exists'·칸 있음 검사라 번호가 바뀌어도 안전.
    // 번호가 겹치면 이미 그 번호까지 올라간 DB 는 이 표를 건너뛰므로 늘 main 의 가장 큰 번호 + 1
    version: 18, // 계정 A단계
    up: async (db, dialect) => {
      // 로그인·회원가입 (플래그 accounts). 새 표만 추가하고 기존 표는 건드리지 않는다. 예전 서버로 되돌려도 이 표를 모르고 지나갈 뿐이다.
      // 시각은 이 저장소 방식대로 seoulIso(+09:00) 글자로 적는다
      await db.schema
        .createTable("users")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("login_id", "text", (c) => c.notNull()) // 보이는 아이디 (NFC, 앞뒤 공백 없음)
        .addColumn("login_id_key", "text", (c) => c.notNull()) // 비교용: NFC + 소문자
        .addColumn("email", "text") // 소문자. 주인은 비어 있을 수 있다
        .addColumn("password_hash", "text", (c) => c.notNull()) // scrypt$N$r$p$소금$키
        .addColumn("is_owner", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("initial_password", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .execute();
      await sql`create unique index if not exists uq_users_login_id_key on users (login_id_key)`.execute(db);
      // 이메일이 없는(NULL) 행은 여러 개여도 된다 (SQLite·Postgres 공통)
      await sql`create unique index if not exists uq_users_email on users (email)`.execute(db);
      // 주인은 한 명 (여러 서버가 동시에 켜져 시드해도)
      await sql`create unique index if not exists uq_users_owner on users (is_owner) where is_owner = 1`.execute(db);
      await db.schema
        .createTable("sessions")
        .ifNotExists()
        .addColumn("id", "integer", idColumn(dialect))
        .addColumn("user_id", "integer", (c) => c.notNull().references("users.id").onDelete("cascade"))
        .addColumn("token_hash", "text", (c) => c.notNull()) // sha256(토큰) hex — 토큰 자체는 적지 않는다
        .addColumn("remember", "integer", (c) => c.notNull()) // 1 = 자동 로그인 (1년, 쓸 때마다 연장)
        .addColumn("device_label", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("last_seen_at", "text", (c) => c.notNull())
        .addColumn("expires_at", "text", (c) => c.notNull())
        .addColumn("revoked_at", "text")
        .execute();
      await sql`create unique index if not exists uq_sessions_token_hash on sessions (token_hash)`.execute(db);
      await sql`create index if not exists idx_sessions_user on sessions (user_id)`.execute(db);
    },
  },
  {
    version: 19, // 계정 A단계 보안 보강 (처음 13): 푸시 기기 등록을 로그인 세션에 묶는다
    up: async (db, dialect) => {
      // 세션을 끊으면(로그아웃·모든 기기에서 로그아웃·비밀번호 변경) 그 세션으로 등록한 기기도 지운다 — 잃어버린 폰으로 주인 계좌 알림이 가지 않게.
      // 비어 있을 수 있는 칸 하나만 더한다 (FK 없음 — 세션을 지워도 기기 행은 남고, 알림은 살아 있는 세션의 기기에만 간다).
      // 예전 서버로 되돌려도 이 칸을 모르고 지나갈 뿐이다.
      // 여러 번 돌려도 안전하게 (검증 5차): 칸을 더한 뒤 색인·schema_version 적기 전에 멈췄다면 다음 기동 때 '칸이 이미 있음'으로 서버가 뜨지 못했다
      if (!(await hasColumn(db, dialect, "devices", "session_id"))) await db.schema.alterTable("devices").addColumn("session_id", "integer").execute();
      await sql`create index if not exists idx_devices_session on devices (session_id)`.execute(db);
    },
  },
];

/** 표에 칸이 있는지 (SQLite: pragma_table_info · Postgres: information_schema — 지금 스키마) */
export async function hasColumn(db: Kysely<Database>, dialect: Dialect, table: string, column: string): Promise<boolean> {
  if (dialect === "postgres") {
    const r = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_schema = current_schema() and table_name = ${table} and column_name = ${column}`.execute(db);
    return Number(r.rows[0]?.n ?? 0) > 0;
  }
  const r = await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(db);
  return r.rows.some((x) => x.name === column);
}

/** 마이그레이션 번호 (테스트: 1 부터 빈 곳·겹침 없이 하나씩 — 두 브랜치가 같은 번호를 쓰면 이미 그 번호까지 올라간 DB 는 뒤의 것을 건너뛴다) */
export const MIGRATION_VERSIONS: readonly number[] = migrations.map((m) => m.version);

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
