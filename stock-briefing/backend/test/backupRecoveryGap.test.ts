import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import { decodeBackup, encryptJsonBackup, restoreBackup, type BackupPayload } from "../src/services/backupService.js";

const CREATED_AT = "2026-10-03T07:11:00+09:00";

function reportRow(index: number, id = index + 1) {
  const date = new Date(Date.UTC(2025, 0, 1 + Math.floor(index / 2))).toISOString().slice(0, 10);
  return {
    id,
    code: index % 2 === 0 ? "005930" : "AAPL",
    session: index % 2 === 0 ? "morning" : "afternoon",
    briefing_date: date,
    status: index % 5 === 0 ? "failed" : "ok",
    summary: `복구 검사 ${index}: 기준 시각과 누락 자료`,
    detail: `# 보고서 ${index}\n\n한국어·영문·숫자 1,234.56\n자료가 없는 항목은 누락으로 표시합니다.`,
    data_snapshot: JSON.stringify({ asOf: CREATED_AT, quote: { price: 100.125 + index, currency: index % 2 === 0 ? "KRW" : "USD" }, sources: ["fixture"], unavailable: null }),
    missing_data: JSON.stringify(index % 3 === 0 ? ["검사 자료 누락"] : []),
    model: "fixture-model",
    error: index % 5 === 0 ? `검사 오류 ${index}` : null,
    created_at: CREATED_AT,
  };
}

describe("JSON 백업 복구의 묶음 경계와 장기 이력 (격리 SQLite)", () => {
  it("201번째 행 저장 실패는 앞 200행도 되돌리고 기존 다른 표를 보존하며 재시도할 수 있다", async () => {
    const db = await createMigratedDb(":memory:");
    const sentinel = { key: "restore-sentinel", value: "기존 값을 보존" };
    const stock = { code: "005930", name: "기존 종목", market: "KOSPI", quantity: 2, avg_price: 3, memo: "기존 메모", created_at: CREATED_AT, updated_at: CREATED_AT };
    const rows = Array.from({ length: 225 }, (_, i) => reportRow(i));
    const payload: BackupPayload = { version: 1, createdAt: CREATED_AT, tables: {
      registered_stocks: [{ ...stock, quantity: 999, memo: "덮어쓰면 안 되는 백업 값" }],
      meta: [{ ...sentinel, value: "덮어쓰면 안 되는 백업 값" }],
      briefings: rows,
    } };
    try {
      await db.insertInto("meta").values(sentinel).execute();
      await db.insertInto("registered_stocks").values(stock).execute();
      // 두 번째 묶음까지 진행했고 앞 묶음 200행이 실제 존재할 때만 실패한다.
      await sql`create trigger fail_second_restore_batch before insert on briefings
        when NEW.id = 201 and (select count(*) from briefings) = 200
        begin select raise(abort, '복구 두 번째 묶음 저장 실패'); end`.execute(db);
      await expect(restoreBackup(db, "sqlite", payload)).rejects.toThrow("복구 두 번째 묶음 저장 실패");
      expect(await db.selectFrom("briefings").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("meta").selectAll().execute()).toEqual([sentinel]);
      expect(await db.selectFrom("registered_stocks").selectAll().execute()).toEqual([stock]);
      await sql`drop trigger fail_second_restore_batch`.execute(db);
      expect(await restoreBackup(db, "sqlite", payload)).toMatchObject({ registered_stocks: "skipped", meta: "skipped", briefings: 225 });
      expect(await db.selectFrom("briefings").selectAll().orderBy("id").execute()).toEqual(rows);
      expect(await db.selectFrom("meta").selectAll().execute()).toEqual([sentinel]);
      expect(await db.selectFrom("registered_stocks").selectAll().execute()).toEqual([stock]);
      expect((await restoreBackup(db, "sqlite", payload)).briefings).toBe("skipped");
    } finally {
      await db.destroy();
    }
  });

  it("600행 암호화 JSON 왕복 복구에서 전체 필드·원래 ID·이력을 보존하고 다음 자동 ID가 겹치지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    const dir = await mkdtemp(join(tmpdir(), "backup-recovery-gap-"));
    const path = join(dir, "synthetic-history.sbk");
    const rows = Array.from({ length: 600 }, (_, i) => reportRow(i, 1000 + i * 3));
    const payload: BackupPayload = { version: 1, createdAt: CREATED_AT, tables: { briefings: rows } };
    try {
      await encryptJsonBackup(payload, path, "fixture-backup-key-not-a-secret");
      const decoded = await decodeBackup(await readFile(path), "fixture-backup-key-not-a-secret");
      expect(decoded.kind).toBe("json");
      if (decoded.kind !== "json") throw new Error("JSON 복구 검사 자료가 아닙니다");
      expect(decoded.payload).toEqual(payload);
      expect((await restoreBackup(db, "sqlite", decoded.payload)).briefings).toBe(600);
      expect(await db.selectFrom("briefings").selectAll().orderBy("id").execute()).toEqual(rows);
      const { id: _id, ...next } = reportRow(600);
      const inserted = await db.insertInto("briefings").values(next).returningAll().executeTakeFirstOrThrow();
      expect(inserted).toEqual({ ...next, id: rows.at(-1)!.id + 1 });
      expect(await db.selectFrom("briefings").selectAll().orderBy("id").limit(600).execute()).toEqual(rows);
    } finally {
      await db.destroy();
      await unlink(path).catch(() => undefined);
      await rmdir(dir);
    }
  });
});
