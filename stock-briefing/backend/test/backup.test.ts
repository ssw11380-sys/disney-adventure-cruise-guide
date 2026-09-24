import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, createMigratedDb, migrate } from "../src/db/index.js";
import { BackupService, decodeBackup, encryptJsonBackup, restoreBackup } from "../src/services/backupService.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

const KEY = "test-key-not-a-secret";

async function seeded(path = ":memory:") {
  const db = await createMigratedDb(path);
  await db
    .insertInto("registered_stocks")
    .values(["005930", "035420", "VRT"].map((code, i) => ({ code, name: code, market: "KOSPI", quantity: i + 1, avg_price: 1000, memo: null, created_at: "2026-09-01T00:00:00+09:00", updated_at: "2026-09-01T00:00:00+09:00" })))
    .execute();
  await db.insertInto("meta").values({ key: "krw_cost_book", value: JSON.stringify({ version: 2, items: { VRT: { krw: 1 } } }) }).execute();
  return db;
}

const svcFor = (db: Awaited<ReturnType<typeof seeded>>, dir: string, now: () => Date, key = KEY) => new BackupService({ db, dialect: "sqlite", dir, key, now });

describe("DB 백업 (3-7)", () => {
  it("SQLite: 한 시점의 DB 파일을 암호화해 두고, 풀면 그대로 열린다 (종목·원화 장부 같음)", async () => {
    const db = await seeded();
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    const st = await svcFor(db, dir, () => new Date("2026-09-24T07:10:00+09:00")).run();
    expect(st).toMatchObject({ enabled: true, lastFile: "backup-20260924-071000.sbk", lastError: null, files: 1 });
    expect(st.lastCounts).toMatchObject({ registered_stocks: 3 });
    const raw = await readFile(join(dir, st.lastFile!));
    expect(raw.includes(Buffer.from("SQLite format"))).toBe(false); // 평문이 보이지 않는다
    expect(raw.includes(Buffer.from("krw_cost_book"))).toBe(false);
    const decoded = await decodeBackup(raw, KEY);
    expect(decoded.kind).toBe("sqlite");
    const restoredPath = join(dir, "restored.db");
    await writeFile(restoredPath, decoded.kind === "sqlite" ? decoded.file : Buffer.alloc(0));
    const back = await createMigratedDb(restoredPath);
    expect((await back.selectFrom("registered_stocks").select("code").execute()).map((x) => x.code).sort()).toEqual(["005930", "035420", "VRT"]);
    expect((await back.selectFrom("meta").select("value").where("key", "=", "krw_cost_book").executeTakeFirst())?.value).toContain("VRT");
    await back.destroy();
    await expect(decodeBackup(raw, "wrong")).rejects.toThrow();
    const tampered = Buffer.from(raw);
    tampered[7] = tampered[7]! ^ 1; // 헤더(salt) 한 비트
    await expect(decodeBackup(tampered, KEY)).rejects.toThrow();
  });

  it("JSON 백업(Postgres 형식)을 빈 DB 에 넣고, 이미 행이 있는 표는 건너뛴다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    const file = join(dir, "j.sbk");
    await encryptJsonBackup({ version: 1, createdAt: "t", tables: { registered_stocks: [{ code: "A", name: "A", market: "KOSPI", quantity: 1, avg_price: 1, memo: null, created_at: "x", updated_at: "x" }] } }, file, KEY);
    const decoded = await decodeBackup(await readFile(file), KEY);
    if (decoded.kind !== "json") throw new Error("json 이어야 함");
    const fresh = createDb(":memory:");
    await migrate(fresh.db, fresh.dialect);
    expect((await restoreBackup(fresh.db, fresh.dialect, decoded.payload))["registered_stocks"]).toBe(1);
    expect((await restoreBackup(fresh.db, fresh.dialect, decoded.payload))["registered_stocks"]).toBe("skipped");
  });

  it("날짜별 1개씩 7일치만 남기고(같은 날 수동 백업은 하나로), 남은 임시 파일을 치우고, 경로를 벗어난 이름은 읽지 않는다", async () => {
    const db = await seeded();
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    let t = Date.parse("2026-09-20T07:10:00+09:00");
    const svc = svcFor(db, dir, () => new Date(t));
    await writeFile(join(dir, "backup-20260101-000000.sbk.tmp"), "half");
    for (let d = 0; d < 9; d++) {
      for (let k = 0; k < 3; k++) {
        await svc.run(); // 같은 날 여러 번
        t += 60_000;
      }
      t += 86_400_000 - 3 * 60_000;
    }
    const files = (await readdir(dir)).sort();
    expect(files).toHaveLength(7);
    expect(new Set(files.map((f) => f.slice(7, 15))).size).toBe(7);
    expect(files[0]!.startsWith("backup-20260922-")).toBe(true);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    await writeFile(join(dir, "..", "secret.txt"), "x");
    expect(await svc.read("../secret.txt")).toBeNull();
  });

  it("키가 없으면 처음부터 이유를 보이고 백업하지 않는다", async () => {
    const db = await seeded();
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    const svc = svcFor(db, dir, () => new Date(), "");
    expect((await svc.status()).lastError).toContain("BACKUP_KEY");
    expect(await svc.run()).toMatchObject({ enabled: false, files: 0 });
  });

  it("아침 7시대에 20시간 넘었으면, 또는 26시간 넘었으면 백업. 실패하면 3시간 쉰다", async () => {
    const db = await seeded();
    const dir = await mkdtemp(join(tmpdir(), "bk-"));
    let t = Date.parse("2026-09-24T07:10:00+09:00");
    const svc = svcFor(db, dir, () => new Date(t));
    expect(await svc.maybeRun()).toBe(true); // 처음
    t = Date.parse("2026-09-24T12:00:00+09:00");
    expect(await svc.maybeRun()).toBe(false);
    t = Date.parse("2026-09-25T07:40:00+09:00");
    expect(await svc.maybeRun()).toBe(true); // 다음 날 아침
    t = Date.parse("2026-09-26T10:00:00+09:00"); // 아침을 놓쳤어도 26시간 넘음
    expect(await svc.maybeRun()).toBe(true);
    // 쓸 수 없는 폴더 → 실패 → 3시간 동안은 다시 시도하지 않음
    await writeFile(join(dir, "blocker"), "x");
    const bad = svcFor(db, join(dir, "blocker", "sub"), () => new Date(t));
    t = Date.parse("2026-09-28T07:10:00+09:00");
    expect(await bad.maybeRun()).toBe(true);
    expect((await bad.status()).lastError).toBeTruthy();
    t += 60 * 60_000;
    expect(await bad.maybeRun()).toBe(false);
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
    expect((await decodeBackup(dl.rawPayload, KEY)).kind).toBe("sqlite");
    expect((await app.inject({ method: "GET", url: "/api/admin/backups/..%2Fx" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/health" })).json().backup).toMatchObject({ enabled: true, files: 1 });
    await app.close();
  });
});
