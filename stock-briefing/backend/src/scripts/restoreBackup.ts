import { access, readFile, writeFile } from "node:fs/promises";
import { sql } from "kysely";
import { createDb, migrate } from "../db/index.js";
import { BACKUP_TABLES, decodeBackup, restoreBackup } from "../services/backupService.js";

/**
 * 백업 파일을 새 DB 로 되살린다.
 *   BACKUP_KEY=<Railway 변수 값> RESTORE_DATABASE_URL=./data/restored.db npm run backup:restore -- backup-20260924-070000.sbk
 *  - SQLite 백업(운영): 그 시점의 DB 파일을 RESTORE_DATABASE_URL 경로에 그대로 쓴다 (이미 있으면 멈춤)
 *  - JSON 백업(Postgres): 새(빈) DB 에 표마다 넣는다 (Postgres 로 옮길 때는 RESTORE_DATABASE_URL=postgres://...)
 * 운영 DB 를 바로 가리키지 말 것 (docs/DB-백업-복구.md)
 */
const file = process.argv[2];
const key = process.env["BACKUP_KEY"] ?? "";
const target = process.env["RESTORE_DATABASE_URL"] ?? "";
if (!file || !key || !target) {
  console.error("사용법: BACKUP_KEY=... RESTORE_DATABASE_URL=<새 DB> npm run backup:restore -- <백업 파일>");
  process.exit(2);
}
const started = Date.now();
const decoded = await decodeBackup(await readFile(file), key);
let restored: Record<string, number | "skipped">;
if (decoded.kind === "sqlite") {
  if (target.startsWith("postgres")) throw new Error("SQLite 백업은 SQLite 파일 경로로만 되살립니다");
  if (await access(target).then(() => true, () => false)) throw new Error(`${target} 가 이미 있습니다 — 새 경로를 주세요`);
  await writeFile(target, decoded.file, { mode: 0o600 });
}
const { db, dialect } = createDb(target);
await migrate(db, dialect);
if (decoded.kind === "json") restored = await restoreBackup(db, dialect, decoded.payload);
else {
  restored = {};
  for (const t of BACKUP_TABLES) restored[t] = Number((await sql<{ n: number }>`select count(*) as n from ${sql.table(t)}`.execute(db)).rows[0]?.n ?? 0);
}
await db.destroy();
console.log(JSON.stringify({ kind: decoded.kind, restored, seconds: Math.round((Date.now() - started) / 100) / 10 }));
