import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { sql } from "kysely";
import type { Db } from "../db/index.js";
import type { Dialect } from "../db/migrate.js";
import { seoulIso } from "../lib/time.js";

/**
 * DB 백업 (자체, 외부 서비스 없음).
 *  - 하루 한 번 새벽(한국 04~06시)에 표 전체를 JSON 으로 모아 gzip → AES-256-GCM 으로 암호화해 볼륨의 backups/ 에 쓴다. 7개 보관
 *  - 다시 받을 수 있는 캐시(종목 마스터·현재가 캐시·DART 코드)는 넣지 않는다
 *  - 키(BACKUP_KEY)가 없으면 백업하지 않는다 (개인 계좌 데이터라 평문 저장 금지). 키는 Railway 변수에만 둔다
 *  - 복구: src/scripts/restoreBackup.ts (빈 DB 에 마이그레이션 후 표마다 넣는다)
 */

/** 백업에 넣는 표 (순서대로 복구) */
export const BACKUP_TABLES = ["registered_stocks", "meta", "briefings", "analyses", "devices", "app_errors"] as const;
const MAGIC = Buffer.from("SBBK1\n");
const KEEP = 7;
const FILE_RE = /^backup-\d{8}-\d{6}\.sbk$/;

export interface BackupPayload {
  version: 1;
  createdAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface BackupStatus {
  enabled: boolean;
  lastAt: string | null;
  lastFile: string | null;
  lastBytes: number | null;
  lastCounts: Record<string, number> | null;
  lastError: string | null;
  files: number;
}

/** 아무 문자열 키 → 32바이트 (Railway 변수에 긴 임의 문자열을 넣는다) */
function keyBytes(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export function encryptBackup(payload: BackupPayload, key: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(payload), "utf8"))), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBackup(file: Buffer, key: string): BackupPayload {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("백업 파일 형식이 아닙니다");
  const iv = file.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = file.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), iv);
  decipher.setAuthTag(tag);
  const zipped = Buffer.concat([decipher.update(file.subarray(MAGIC.length + 28)), decipher.final()]); // 키가 틀리면 여기서 실패
  return JSON.parse(gunzipSync(zipped).toString("utf8")) as BackupPayload;
}

/** 빈(마이그레이션만 한) DB 에 백업을 넣는다. 이미 행이 있는 표는 건너뛴다(덮어쓰지 않음) */
export async function restoreBackup(db: Db, dialect: Dialect, payload: BackupPayload): Promise<Record<string, number | "skipped">> {
  const out: Record<string, number | "skipped"> = {};
  const anyDb = db as unknown as Db & { insertInto: (t: string) => { values: (v: unknown) => { execute: () => Promise<unknown> } } };
  for (const table of BACKUP_TABLES) {
    const rows = payload.tables[table] ?? [];
    const existing = await sql<{ n: number }>`select count(*) as n from ${sql.table(table)}`.execute(db);
    if (Number(existing.rows[0]?.n ?? 0) > 0) {
      out[table] = "skipped";
      continue;
    }
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      if (dialect === "postgres" && cols.includes("id")) {
        // id 가 GENERATED ALWAYS AS IDENTITY 라 원래 id 를 넣으려면 OVERRIDING SYSTEM VALUE 가 필요하다
        const values = chunk.map((r) => sql`(${sql.join(cols.map((c) => r[c] ?? null))})`);
        await sql`insert into ${sql.table(table)} (${sql.join(cols.map((c) => sql.ref(c)))}) overriding system value values ${sql.join(values)}`.execute(db);
      } else {
        await anyDb.insertInto(table).values(chunk).execute();
      }
    }
    // Postgres: id 를 그대로 넣었으니 일련번호를 맞춰 둔다 (다음 insert 가 겹치지 않게)
    if (dialect === "postgres" && rows.length && "id" in rows[0]!) {
      await sql`select setval(pg_get_serial_sequence(${table}, 'id'), (select max(id) from ${sql.table(table)}))`.execute(db);
    }
    out[table] = rows.length;
  }
  return out;
}

export class BackupService {
  private running: Promise<BackupStatus> | null = null;
  private lastError: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly opts: { db: Db; dir: string; key: string; now?: () => Date; log?: { info(o: object, m: string): void; warn(o: object, m: string): void } },
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.opts.key.length > 0;
  }

  /** 30분마다 확인: 마지막 백업이 20시간 넘었고 한국 04~06시면, 또는 26시간 넘었으면 백업 */
  start(): void {
    if (!this.enabled || this.timer) return;
    const check = () => void this.maybeRun().catch(() => undefined);
    this.timer = setInterval(check, 30 * 60_000);
    this.timer.unref?.();
    setTimeout(check, 2 * 60_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async maybeRun(): Promise<boolean> {
    const last = (await this.lastMeta())?.at ?? null;
    const t = this.now().getTime();
    const age = last ? t - Date.parse(last) : Infinity;
    const hour = new Date(t + 9 * 3_600_000).getUTCHours();
    if ((age > 20 * 3_600_000 && hour >= 4 && hour < 6) || age > 26 * 3_600_000) {
      await this.run();
      return true;
    }
    return false;
  }

  /** 지금 백업 (동시에 부르면 하나만) */
  run(): Promise<BackupStatus> {
    if (!this.running)
      this.running = this.doRun().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async doRun(): Promise<BackupStatus> {
    if (!this.enabled) {
      this.lastError = "BACKUP_KEY 가 없어 백업하지 않습니다 (암호화 없이 저장하지 않음)";
      return this.status();
    }
    try {
      const tables: Record<string, Record<string, unknown>[]> = {};
      for (const t of BACKUP_TABLES) tables[t] = (await sql<Record<string, unknown>>`select * from ${sql.table(t)}`.execute(this.opts.db)).rows;
      const createdAt = seoulIso(this.now());
      const file = encryptBackup({ version: 1, createdAt, tables }, this.opts.key);
      await mkdir(this.opts.dir, { recursive: true });
      const name = `backup-${createdAt.slice(0, 10).replace(/-/g, "")}-${createdAt.slice(11, 19).replace(/:/g, "")}.sbk`;
      const tmp = join(this.opts.dir, `${name}.tmp`);
      await writeFile(tmp, file, { mode: 0o600 });
      await rename(tmp, join(this.opts.dir, name)); // 다 쓴 뒤에만 보이게
      const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
      await this.saveMeta({ at: createdAt, file: name, bytes: file.length, counts });
      await this.prune();
      this.lastError = null;
      this.opts.log?.info({ file: name, bytes: file.length, counts }, "DB 백업 완료");
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.opts.log?.warn({ err: this.lastError }, "DB 백업 실패");
    }
    return this.status();
  }

  private async prune(): Promise<void> {
    const files = await this.files();
    for (const f of files.slice(KEEP)) await unlink(join(this.opts.dir, f)).catch(() => undefined);
  }

  /** 백업 파일 이름 (새것부터) */
  async files(): Promise<string[]> {
    try {
      return (await readdir(this.opts.dir)).filter((f) => FILE_RE.test(f)).sort().reverse();
    } catch {
      return [];
    }
  }

  async list(): Promise<Array<{ name: string; bytes: number }>> {
    const out: Array<{ name: string; bytes: number }> = [];
    for (const f of await this.files()) out.push({ name: f, bytes: (await stat(join(this.opts.dir, f))).size });
    return out;
  }

  /** 암호화된 파일 그대로 (내려받기용). 이름은 형식을 지켜야 한다 (경로 조작 방지) */
  async read(name: string): Promise<Buffer | null> {
    if (!FILE_RE.test(name)) return null;
    try {
      return await readFile(join(this.opts.dir, name));
    } catch {
      return null;
    }
  }

  async status(): Promise<BackupStatus> {
    const m = await this.lastMeta();
    return { enabled: this.enabled, lastAt: m?.at ?? null, lastFile: m?.file ?? null, lastBytes: m?.bytes ?? null, lastCounts: m?.counts ?? null, lastError: this.lastError, files: (await this.files()).length };
  }

  private async lastMeta(): Promise<{ at: string; file: string; bytes: number; counts: Record<string, number> } | null> {
    const row = await this.opts.db.selectFrom("meta").select("value").where("key", "=", "last_backup").executeTakeFirst();
    if (!row) return null;
    try {
      return JSON.parse(row.value) as { at: string; file: string; bytes: number; counts: Record<string, number> };
    } catch {
      return null;
    }
  }

  private async saveMeta(v: { at: string; file: string; bytes: number; counts: Record<string, number> }): Promise<void> {
    const value = JSON.stringify(v);
    await this.opts.db.insertInto("meta").values({ key: "last_backup", value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
  }
}
