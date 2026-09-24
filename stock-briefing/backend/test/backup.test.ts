import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, createMigratedDb, migrate } from "../src/db/index.js";
import { BackupService, decryptBackup, encryptBackup, restoreBackup } from "../src/services/backupService.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

const KEY = "test-key-not-a-secret";

async function seeded() {
  const db = await createMigratedDb(":memory:");
  await db
    .insertInto("registered_stocks")
    .values(["005930", "035420", "VRT"].map((code, i) => ({ code, name: code, market: "KOSPI", quantity: i + 1, avg_price: 1000, memo: null, created_at: "2026-09-01T00:00:00+09:00", updated_at: "2026-09-01T00:00:00+09:00" })))
    .execute();
  await db.insertInto("meta").values({ key: "krw_cost_book", value: JSON.stringify({ version: 2, items: { VRT: { krw: 1 } } }) }).execute();
  await db.insertInto("quote_cache").values({ code: "005930", payload: "{}", fetched_at: "x" }).execute();
  return db;
}

describe("DB 백업 (3-7)", () => {
  it("암호화한 파일은 같은 키로만 풀린다", () => {
    const file = encryptBackup({ version: 1, createdAt: "t", tables: { meta: [{ key: "a", value: "b" }] } }, KEY);
    expect(file.includes(Buffer.from('"value"'))).toBe(false); // 평문이 보이지 않는다
    expect(decryptBackup(file, KEY).tables["meta"]).toEqual([{ key: "a", value: "b" }]);
    expect(() => decryptBackup(file, "wrong")).toThrow();
  });

  it("백업 → 빈 DB 에 복구하면 종목·원화 장부가 같고, 캐시는 넣지 않는다", async () => {
    const db = await seeded();
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    const svc = new BackupService({ db, dir, key: KEY, now: () => new Date("2026-09-24T04:30:00+09:00") });
    const st = await svc.run();
    expect(st).toMatchObject({ enabled: true, lastFile: "backup-20260924-043000.sbk", lastError: null, files: 1 });
    expect(st.lastCounts).toMatchObject({ registered_stocks: 3 });
    const payload = decryptBackup((await svc.read(st.lastFile!))!, KEY);
    expect(payload.tables["quote_cache"]).toBeUndefined();

    const fresh = createDb(":memory:");
    await migrate(fresh.db, fresh.dialect);
    const r = await restoreBackup(fresh.db, fresh.dialect, payload);
    expect(r["registered_stocks"]).toBe(3);
    expect((await fresh.db.selectFrom("registered_stocks").select("code").execute()).map((x) => x.code).sort()).toEqual(["005930", "035420", "VRT"]);
    expect((await fresh.db.selectFrom("meta").select("value").where("key", "=", "krw_cost_book").executeTakeFirst())?.value).toContain("VRT");
    // 이미 행이 있으면 덮어쓰지 않는다
    expect((await restoreBackup(fresh.db, fresh.dialect, payload))["registered_stocks"]).toBe("skipped");
  });

  it("7개만 남기고, 경로를 벗어난 이름은 읽지 않는다", async () => {
    const db = await seeded();
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    let t = Date.parse("2026-09-24T04:30:00+09:00");
    const svc = new BackupService({ db, dir, key: KEY, now: () => new Date(t) });
    for (let i = 0; i < 9; i++) {
      await svc.run();
      t += 86_400_000;
    }
    const files = await readdir(dir);
    expect(files).toHaveLength(7);
    expect(files.sort()[0]).toBe("backup-20260926-043000.sbk");
    await writeFile(join(dir, "..", "secret.txt"), "x");
    expect(await svc.read("../secret.txt")).toBeNull();
  });

  it("키가 없으면 백업하지 않고 이유를 남긴다", async () => {
    const db = await seeded();
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    const st = await new BackupService({ db, dir, key: "" }).run();
    expect(st).toMatchObject({ enabled: false, files: 0 });
    expect(st.lastError).toContain("BACKUP_KEY");
  });

  it("새벽(04~06시)에 20시간 넘었으면, 또는 26시간 넘었으면 백업한다", async () => {
    const db = await seeded();
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    let t = Date.parse("2026-09-24T04:10:00+09:00");
    const svc = new BackupService({ db, dir, key: KEY, now: () => new Date(t) });
    expect(await svc.maybeRun()).toBe(true); // 처음
    t = Date.parse("2026-09-24T12:00:00+09:00");
    expect(await svc.maybeRun()).toBe(false);
    t = Date.parse("2026-09-25T04:40:00+09:00");
    expect(await svc.maybeRun()).toBe(true); // 다음 날 새벽
    t = Date.parse("2026-09-26T07:00:00+09:00"); // 새벽을 놓쳤어도 26시간 넘음
    expect(await svc.maybeRun()).toBe(true);
  });

  it("관리 API: 지금 백업·목록·내려받기, /health 에 마지막 백업", async () => {
    const db = await seeded();
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:", BACKUP_KEY: KEY, BACKUP_DIR: dir }), db, providers: fakeProviders({ generator: new FakeGenerator() }), logger: false, enableScheduler: false });
    const run = (await app.inject({ method: "POST", url: "/api/admin/backups/run" })).json();
    expect(run.lastFile).toMatch(/^backup-.*\.sbk$/);
    const list = (await app.inject({ method: "GET", url: "/api/admin/backups" })).json();
    expect(list.files).toHaveLength(1);
    const dl = await app.inject({ method: "GET", url: `/api/admin/backups/${run.lastFile}` });
    expect(decryptBackup(dl.rawPayload, KEY).tables["registered_stocks"]).toHaveLength(3);
    expect((await app.inject({ method: "GET", url: "/api/admin/backups/..%2Fx" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/health" })).json().backup).toMatchObject({ enabled: true, files: 1 });
    await app.close();
  });
});
