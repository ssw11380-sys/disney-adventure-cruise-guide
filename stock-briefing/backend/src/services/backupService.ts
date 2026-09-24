import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import { sql } from "kysely";
import type { Db } from "../db/index.js";
import type { Dialect } from "../db/migrate.js";
import { seoulIso } from "../lib/time.js";

/**
 * DB 백업 (자체, 외부 서비스 없음).
 *  - 하루 한 번(한국 07~08시: 미국 장 마감 뒤·국내 NXT 개장 전) 백업해 볼륨의 backups/ 에 날짜별 1개씩 7일치를 둔다
 *  - SQLite(운영): VACUUM INTO 로 한 시점의 DB 파일을 떠서(일관된 스냅샷) gzip → AES-256-GCM 으로 흘려 쓴다 (메모리에 통째로 올리지 않음)
 *  - Postgres: 보관할 표를 한 트랜잭션(repeatable read)에서 JSON 으로 읽는다 (캐시 표 제외)
 *  - 키(BACKUP_KEY)가 없으면 백업하지 않는다 (개인 계좌 데이터라 평문 저장 금지). 키 → scrypt(파일마다 salt) → 256비트
 *  - 복구: src/scripts/restoreBackup.ts, 절차는 docs/DB-백업-복구.md
 */

/** Postgres JSON 백업에 넣는 표 (다시 받을 수 있는 캐시 — 종목 마스터·현재가·DART 코드 — 는 뺌) */
export const BACKUP_TABLES = ["registered_stocks", "meta", "briefings", "analyses", "devices", "app_errors"] as const;
const MAGIC = Buffer.from("SBBK2\n");
/** 헤더: MAGIC(6) + 종류(1) + salt(16) + iv(12), 끝에 인증 태그(16) */
const HEADER = MAGIC.length + 1 + 16 + 12;
const TAG = 16;
const KIND_SQLITE = 1;
const KIND_JSON = 2;
const KEEP_DAYS = 7;
const FILE_RE = /^backup-(\d{8})-\d{6}\.sbk$/;
/** 실패하면 이만큼 쉬었다 다시 (디스크가 찼을 때 30분마다 통째로 다시 뜨지 않게) */
const RETRY_AFTER_FAIL_MS = 3 * 3_600_000;

export interface BackupPayload {
  version: 1;
  createdAt: string;
  schemaVersion?: number;
  tables: Record<string, Record<string, unknown>[]>;
}

export type DecodedBackup = { kind: "sqlite"; file: Buffer } | { kind: "json"; payload: BackupPayload };

export interface BackupStatus {
  enabled: boolean;
  lastAt: string | null;
  lastFile: string | null;
  lastBytes: number | null;
  lastCounts: Record<string, number> | null;
  lastError: string | null;
  files: number;
}

function deriveKey(key: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(key, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
}

/** src 를 gzip → 암호화해 dest 에 쓴다. 쓴 바이트 수 */
async function encryptTo(src: Readable, dest: string, key: string, kind: number): Promise<number> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(key, salt), iv, { authTagLength: TAG });
  const header = Buffer.concat([MAGIC, Buffer.from([kind]), salt, iv]);
  cipher.setAAD(header); // 헤더를 바꿔치기해도 풀리지 않게
  await writeFile(dest, header, { mode: 0o600 });
  await pipeline(src, createGzip(), cipher, createWriteStream(dest, { flags: "a" }));
  await appendFile(dest, cipher.getAuthTag());
  return (await stat(dest)).size;
}

/** 백업 파일 → 원래 내용. 키가 틀리거나 파일이 바뀌었으면 던진다 */
export async function decodeBackup(file: Buffer, key: string): Promise<DecodedBackup> {
  if (file.length < HEADER + TAG || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("백업 파일 형식이 아닙니다");
  const header = file.subarray(0, HEADER);
  const kind = header[MAGIC.length]!;
  const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 17);
  const iv = header.subarray(MAGIC.length + 17, HEADER);
  const decipher = createDecipheriv("aes-256-gcm", await deriveKey(key, salt), iv, { authTagLength: TAG });
  decipher.setAAD(header);
  decipher.setAuthTag(file.subarray(file.length - TAG));
  const zipped = Buffer.concat([decipher.update(file.subarray(HEADER, file.length - TAG)), decipher.final()]);
  const raw = gunzipSync(zipped);
  if (kind === KIND_SQLITE) return { kind: "sqlite", file: raw };
  if (kind === KIND_JSON) return { kind: "json", payload: JSON.parse(raw.toString("utf8")) as BackupPayload };
  throw new Error(`알 수 없는 백업 종류: ${kind}`);
}

/** 테스트·도구용: JSON 백업을 파일로 (Postgres 경로와 같은 형식) */
export async function encryptJsonBackup(payload: BackupPayload, dest: string, key: string): Promise<number> {
  return encryptTo(Readable.from([Buffer.from(JSON.stringify(payload), "utf8")]), dest, key, KIND_JSON);
}

/**
 * JSON 백업을 빈(마이그레이션만 한) DB 에 넣는다. 표마다 트랜잭션 — 중간에 실패하면 그 표는 비어 있어 다시 돌리면 다시 넣는다.
 * 이미 행이 있는 표는 건너뛴다(덮어쓰지 않음)
 */
export async function restoreBackup(db: Db, dialect: Dialect, payload: BackupPayload): Promise<Record<string, number | "skipped">> {
  const out: Record<string, number | "skipped"> = {};
  for (const table of BACKUP_TABLES) {
    const rows = payload.tables[table] ?? [];
    const existing = await sql<{ n: number }>`select count(*) as n from ${sql.table(table)}`.execute(db);
    if (Number(existing.rows[0]?.n ?? 0) > 0) {
      out[table] = "skipped";
      continue;
    }
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    await db.transaction().execute(async (trx) => {
      for (let i = 0; i < rows.length; i += 200) {
        const values = rows.slice(i, i + 200).map((r) => sql`(${sql.join(cols.map((c) => r[c] ?? null))})`);
        // Postgres 의 id 는 GENERATED ALWAYS AS IDENTITY 라 원래 id 를 넣으려면 OVERRIDING SYSTEM VALUE 가 필요하다
        const override = dialect === "postgres" && cols.includes("id") ? sql`overriding system value` : sql``;
        await sql`insert into ${sql.table(table)} (${sql.join(cols.map((c) => sql.ref(c)))}) ${override} values ${sql.join(values)}`.execute(trx);
      }
      // Postgres: 일련번호를 맞춰 둔다 (다음 insert 가 겹치지 않게)
      if (dialect === "postgres" && rows.length && cols.includes("id")) {
        await sql`select setval(pg_get_serial_sequence(${table}, 'id'), (select max(id) from ${sql.table(table)}))`.execute(trx);
      }
    });
    out[table] = rows.length;
  }
  return out;
}

async function countRows(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of BACKUP_TABLES) out[t] = Number((await sql<{ n: number }>`select count(*) as n from ${sql.table(t)}`.execute(db)).rows[0]?.n ?? 0);
  return out;
}

export class BackupService {
  private running: Promise<BackupStatus> | null = null;
  private lastError: string | null;
  private lastFailAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly opts: { db: Db; dialect: Dialect; dir: string; key: string; now?: () => Date; log?: { info(o: object, m: string): void; warn(o: object, m: string): void } },
  ) {
    this.now = opts.now ?? (() => new Date());
    this.lastError = this.enabled ? null : "BACKUP_KEY 가 없어 백업하지 않습니다 (암호화 없이 저장하지 않음)";
  }

  get enabled(): boolean {
    return this.opts.key.length > 0;
  }

  /** 30분마다 확인 (maybeRun) */
  start(): void {
    if (!this.enabled || this.timer) return;
    const check = () => void this.maybeRun().catch(() => undefined);
    this.timer = setInterval(check, 30 * 60_000);
    this.timer.unref?.();
    this.first = setTimeout(check, 2 * 60_000);
    this.first.unref?.();
  }

  /** 멈춤. 진행 중인 백업은 끝날 때까지 기다린다 (중간에 끊겨 반쪽 파일이 남지 않게) */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
    await this.running?.catch(() => undefined);
  }

  /** 마지막 백업이 20시간 넘었고 한국 07~08시면, 또는 26시간 넘었으면 백업. 실패 뒤 3시간은 쉼 */
  async maybeRun(): Promise<boolean> {
    const t = this.now().getTime();
    if (t - this.lastFailAt < RETRY_AFTER_FAIL_MS) return false;
    const last = (await this.lastMeta())?.at ?? null;
    const age = last ? t - Date.parse(last) : Infinity;
    const hour = new Date(t + 9 * 3_600_000).getUTCHours();
    if ((age > 20 * 3_600_000 && hour === 7) || age > 26 * 3_600_000) {
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
    if (!this.enabled) return this.status();
    const createdAt = seoulIso(this.now());
    const name = `backup-${createdAt.slice(0, 10).replace(/-/g, "")}-${createdAt.slice(11, 19).replace(/:/g, "")}.sbk`;
    const tmp = join(this.opts.dir, `${name}.tmp`);
    const snap = join(this.opts.dir, `${name}.db.tmp`);
    try {
      await mkdir(this.opts.dir, { recursive: true });
      await this.sweepTmp();
      let bytes: number;
      let counts: Record<string, number>;
      if (this.opts.dialect === "sqlite") {
        // 한 시점의 DB 파일 (쓰기 중이어도 일관됨). 캐시 표까지 들어가지만 복구가 단순해진다
        await sql`vacuum into ${snap}`.execute(this.opts.db);
        counts = await countRows(this.opts.db);
        bytes = await encryptTo(createReadStream(snap), tmp, this.opts.key, KIND_SQLITE);
      } else {
        const tables: Record<string, Record<string, unknown>[]> = {};
        await this.opts.db.transaction().execute(async (trx) => {
          await sql`set transaction isolation level repeatable read`.execute(trx);
          for (const t of BACKUP_TABLES) tables[t] = (await sql<Record<string, unknown>>`select * from ${sql.table(t)}`.execute(trx)).rows;
        });
        const schemaVersion = Number((await sql<{ v: number }>`select max(version) as v from schema_version`.execute(this.opts.db)).rows[0]?.v ?? 0);
        counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
        bytes = await encryptTo(Readable.from([Buffer.from(JSON.stringify({ version: 1, createdAt, schemaVersion, tables } satisfies BackupPayload), "utf8")]), tmp, this.opts.key, KIND_JSON);
      }
      await rename(tmp, join(this.opts.dir, name)); // 다 쓴 뒤에만 보이게
      await this.saveMeta({ at: createdAt, file: name, bytes, counts });
      await this.prune();
      this.lastError = null;
      this.lastFailAt = 0;
      this.opts.log?.info({ file: name, bytes, counts }, "DB 백업 완료");
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.lastFailAt = this.now().getTime();
      await unlink(tmp).catch(() => undefined);
      this.opts.log?.warn({ err: this.lastError }, "DB 백업 실패");
    } finally {
      await unlink(snap).catch(() => undefined);
    }
    return this.status();
  }

  /** 지난 실행이 끊겨 남은 임시 파일 정리 */
  private async sweepTmp(): Promise<void> {
    for (const f of await readdir(this.opts.dir).catch(() => [] as string[])) if (f.endsWith(".tmp")) await unlink(join(this.opts.dir, f)).catch(() => undefined);
  }

  /** 날짜별로 가장 새 파일 하나씩, 최근 7일치만 남긴다 (수동 백업을 여러 번 해도 지난 날짜가 밀려나지 않게) */
  private async prune(): Promise<void> {
    const keep = new Set<string>();
    const days = new Set<string>();
    for (const f of await this.files()) {
      const day = FILE_RE.exec(f)![1]!;
      if (days.has(day)) continue; // 같은 날짜의 더 오래된 파일
      if (days.size >= KEEP_DAYS) continue;
      days.add(day);
      keep.add(f);
    }
    for (const f of await this.files()) if (!keep.has(f)) await unlink(join(this.opts.dir, f)).catch(() => undefined);
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
