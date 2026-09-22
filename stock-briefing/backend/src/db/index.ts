import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "./schema.js";
import { migrate } from "./migrate.js";

export type Db = Kysely<Database>;

/**
 * DATABASE_URL 에 따라 SQLite(개발) 또는 Postgres(운영) 연결을 만든다.
 * Postgres 는 `pg` 패키지 설치 후 PostgresDialect 로 교체하면 된다 (스키마/쿼리는 공용).
 */
export function createDb(databaseUrl: string): Db {
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    throw new Error(
      "Postgres 연결은 아직 활성화되지 않았습니다. `npm i pg` 후 src/db/index.ts 의 PostgresDialect 분기를 열어 주세요.",
    );
  }
  if (databaseUrl !== ":memory:") mkdirSync(dirname(databaseUrl), { recursive: true });
  const sqlite = new SQLite(databaseUrl);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

export async function createMigratedDb(databaseUrl: string): Promise<Db> {
  const db = createDb(databaseUrl);
  await migrate(db);
  return db;
}

export { migrate };
