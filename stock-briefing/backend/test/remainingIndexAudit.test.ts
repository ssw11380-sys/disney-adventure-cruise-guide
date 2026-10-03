import { sql } from "kysely";
import { expect, it } from "vitest";
import { createMigratedDb, migrate } from "../src/db/index.js";

it("기존 보고서 내용을 보존하며 최신 목록 인덱스를 추가하고 재실행해도 안전하다", async () => {
  const db = await createMigratedDb(":memory:");
  try {
    // 이전 버전의 실제 자료가 있는 DB를 격리된 메모리 DB에서 구성한다.
    await sql`drop index if exists idx_briefings_date_created`.execute(db);
    await sql`delete from schema_version where version = 12`.execute(db);
    await db.insertInto("registered_stocks").values({ code: "005930", name: "가상 종목", market: "KOSPI", quantity: 3, avg_price: 100, memo: "보존", created_at: "2025-01-01", updated_at: "2025-01-01" }).execute();
    for (let n = 0; n < 306; n++) {
      const date = new Date(Date.UTC(2025, 0, 1 + n)).toISOString().slice(0, 10);
      await db.insertInto("briefings").values({ code: "005930", session: "morning", briefing_date: date, status: "ok", summary: `요약 ${n}`, detail: `본문 ${n}`, data_snapshot: JSON.stringify({ n }), missing_data: "[]", model: "fake", error: null, created_at: `${date}T08:30:00+09:00` }).execute();
    }
    const before = await db.selectFrom("briefings").selectAll().orderBy("id").execute();
    await migrate(db);
    await migrate(db);
    expect(await db.selectFrom("briefings").selectAll().orderBy("id").execute()).toEqual(before);
    const indexes = await sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name = 'briefings'`.execute(db);
    expect(indexes.rows.map((row) => row.name)).toContain("idx_briefings_date_created");
    const plan = await sql<{ detail: string }>`explain query plan select * from briefings order by briefing_date desc, created_at desc limit 200`.execute(db);
    expect(plan.rows.some((row) => row.detail.includes("idx_briefings_date_created"))).toBe(true);
    expect(plan.rows.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
    const newest = await db.selectFrom("briefings").selectAll().orderBy("briefing_date", "desc").orderBy("created_at", "desc").limit(200).execute();
    expect(newest).toEqual([...before].reverse().slice(0, 200));
    expect((await sql<{ version: number }>`select version from schema_version where version = 12`.execute(db)).rows).toEqual([{ version: 12 }]);
  } finally {
    await db.destroy();
  }
});
