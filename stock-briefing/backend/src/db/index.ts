import SQLite from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import type { Database } from "./schema.js";
import { migrate, type Dialect } from "./migrate.js";

export type Db = Kysely<Database>;

export function detectDialect(databaseUrl: string): Dialect {
  return databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://") ? "postgres" : "sqlite";
}

/**
 * DATABASE_URL 에 따라 SQLite(개발) 또는 Postgres(운영) 연결을 만든다.
 *  - 파일 경로 또는 ":memory:"  → SQLite
 *  - postgres://user:pass@host:5432/db → Postgres (Railway/Fly/Supabase 등)
 * 스키마와 쿼리는 Kysely 로 공용. 방언 차이는 migrate.ts 의 id 컬럼 정도.
 */
export function createDb(databaseUrl: string): { db: Db; dialect: Dialect } {
  if (detectDialect(databaseUrl) === "postgres") {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 5,
      // Railway/Supabase 등은 SSL 을 요구하는 경우가 많다. sslmode=disable 이 명시되지 않으면 켠다.
      ...(databaseUrl.includes("sslmode=disable") || /localhost|127\.0\.0\.1/.test(databaseUrl) ? {} : { ssl: { rejectUnauthorized: false } }),
    });
    return { db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), dialect: "postgres" };
  }
  if (databaseUrl !== ":memory:") mkdirSync(dirname(databaseUrl), { recursive: true });
  const sqlite = new SQLite(databaseUrl);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { db: new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) }), dialect: "sqlite" };
}

export async function createMigratedDb(databaseUrl: string): Promise<Db> {
  const { db, dialect } = createDb(databaseUrl);
  await migrate(db, dialect);
  return db;
}

export { migrate };
