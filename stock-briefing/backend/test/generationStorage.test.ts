import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createMigratedDb, migrate } from "../src/db/index.js";
import { BACKUP_TABLES, restoreBackup } from "../src/services/backupService.js";
import { GenerationJobs } from "../src/services/generationJobs.js";

describe("생성 복구·재무 캐시 스키마와 보존", () => {
  it("기존 스키마12에서 추가 표를 만들 때 기존 보고서와 등록 보유 자료를 바꾸지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    try {
      const holding = { code: "005930", name: "삼성전자", market: "KOSPI", quantity: 10.123, avg_price: 90000.45, memo: "기존 사용자 메모", created_at: "2026-10-03", updated_at: "2026-10-03" };
      await db.insertInto("registered_stocks").values(holding).execute();
      const analysis = { code: "005930", kind: "company", content: "기존 본문 전체", model: "원본 모델", data_snapshot: '{"value":123}', missing_data: '["분기자료"]', created_at: "2026-10-03" };
      await db.insertInto("analyses").values(analysis).execute();
      for (const table of ["generation_requests", "generation_jobs", "fundamentals_cache"] as const) await db.schema.dropTable(table).execute();
      await sql`delete from schema_version where version = 13`.execute(db);
      await migrate(db);
      // 관심 그룹 칸 둘(3-34, 마이그레이션 17)은 비어 있는 채로 더해질 뿐 — 기존 값은 그대로
      expect(await db.selectFrom("registered_stocks").selectAll().execute()).toEqual([{ ...holding, watch_group_id: null, watch_position: null }]);
      expect(await db.selectFrom("analyses").selectAll().execute()).toEqual([{ id: 1, ...analysis }]);
      expect(await db.selectFrom("generation_jobs").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("fundamentals_cache").selectAll().execute()).toEqual([]);
    } finally { await db.destroy(); }
  });

  it("백업 대상에 완료 결과·요청 연결·원 재무 자료를 포함하고 JSON 복원 후 AI 없이 동일 결과를 회수한다", async () => {
    const source = await createMigratedDb(":memory:"); const restored = await createMigratedDb(":memory:");
    try {
      const result = { text: "저장된 모델 원문", model: "고급 모델", input: { value: 321, asOf: "2026-10-03" } };
      await new GenerationJobs(source).run("analysis:backup", { requestKey: "backup-request" }, async () => result);
      const fundamental = { code: "005930", payload: '{"pbr":0,"per":12,"receivedAt":"2026-10-03"}', fetched_at: "2026-10-03" };
      await source.insertInto("fundamentals_cache").values(fundamental).execute();
      const tables: Record<string, Record<string, unknown>[]> = {};
      for (const table of ["generation_jobs", "generation_requests", "fundamentals_cache"] as const) {
        expect(BACKUP_TABLES).toContain(table);
        tables[table] = await source.selectFrom(table).selectAll().execute();
      }
      expect(await restoreBackup(restored, "sqlite", { version: 1, schemaVersion: 13, createdAt: new Date().toISOString(), tables })).toMatchObject({ generation_jobs: 1, generation_requests: 1, fundamentals_cache: 1 });
      expect(await new GenerationJobs(restored).run("analysis:backup", { requestKey: "backup-request" }, async () => { throw new Error("재호출 금지"); })).toEqual(result);
      expect(await restored.selectFrom("fundamentals_cache").selectAll().execute()).toEqual([fundamental]);
    } finally { await source.destroy(); await restored.destroy(); }
  });
});
