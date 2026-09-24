import { readFile } from "node:fs/promises";
import { createDb, migrate } from "../db/index.js";
import { decryptBackup, restoreBackup } from "../services/backupService.js";

/**
 * 백업 파일을 빈 DB 에 되살린다.
 *   BACKUP_KEY=<Railway 변수 값> RESTORE_DATABASE_URL=./data/restored.db npm run backup:restore -- backup-20260924-043000.sbk
 * RESTORE_DATABASE_URL 은 새(빈) DB 여야 한다 — 이미 행이 있는 표는 건너뛴다. 운영 DB 를 바로 가리키지 말 것 (docs/DB-백업-복구.md)
 */
const file = process.argv[2];
const key = process.env["BACKUP_KEY"] ?? "";
const target = process.env["RESTORE_DATABASE_URL"] ?? "";
if (!file || !key || !target) {
  console.error("사용법: BACKUP_KEY=... RESTORE_DATABASE_URL=<새 DB> npm run backup:restore -- <백업 파일>");
  process.exit(2);
}
const started = Date.now();
const payload = decryptBackup(await readFile(file), key);
const { db, dialect } = createDb(target);
await migrate(db, dialect);
const result = await restoreBackup(db, dialect, payload);
await db.destroy();
console.log(JSON.stringify({ backupAt: payload.createdAt, restored: result, seconds: Math.round((Date.now() - started) / 100) / 10 }));
