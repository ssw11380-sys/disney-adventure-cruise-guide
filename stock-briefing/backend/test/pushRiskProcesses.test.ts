import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createDb, createMigratedDb, type Db } from "../src/db/index.js";
import { ReceiptStore, RECEIPT_LEASE_MS } from "../src/notifications/receiptStore.js";

type Message = { type: string; id?: string; result?: any; error?: string; count?: number };
class Worker {
  readonly messages: Message[] = [];
  readonly child: ChildProcess;
  private readonly listeners = new Set<() => void>();
  private stderr = "";
  private dead = false;
  readonly exited: Promise<void>;
  constructor(database: string, holdSend = false, holdCheck = false) {
    this.child = fork(fileURLToPath(new URL("./fixtures/pushRiskWorker.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, RISK_PUSH_DATABASE: database, RISK_HOLD_SEND: holdSend ? "1" : "0", RISK_HOLD_CHECK: holdCheck ? "1" : "0" },
    });
    this.child.stderr?.on("data", (chunk) => { this.stderr += String(chunk); });
    this.child.on("message", (message: Message) => { this.messages.push(message); this.listeners.forEach((listener) => listener()); });
    this.exited = new Promise((resolve) => this.child.once("exit", () => { this.dead = true; this.listeners.forEach((listener) => listener()); resolve(); }));
  }
  wait(type: string, id?: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        const found = this.messages.find((m) => m.type === type && (id === undefined || m.id === id));
        if (!found && !this.dead) return;
        clearTimeout(timer); this.listeners.delete(finish);
        if (found) resolve(found); else reject(new Error(`격리 프로세스 조기 종료: ${this.stderr}`));
      };
      const timer = setTimeout(() => { this.listeners.delete(finish); reject(new Error(`격리 프로세스 응답 제한 시간: ${type} ${this.stderr}`)); }, 12_000);
      this.listeners.add(finish); finish();
    });
  }
  command(command: string, extra: object = {}) {
    const id = randomUUID(); this.child.send({ command, id, ...extra });
    return this.wait("result", id);
  }
  release(kind: "send" | "check") { if (!this.dead) this.child.send({ command: `release-${kind}` }); }
  async kill() { if (!this.dead) this.child.kill("SIGKILL"); await this.exited; }
}
const pgUrl = process.env["TEST_PG_URL"];
const AT = Date.parse("2026-12-28T09:00:00+09:00");
const TOKEN = "ExponentPushToken[risk_isolated_process]";
async function setup(kind: "sqlite" | "postgres") {
  const workers: Worker[] = [];
  let db: Db; let database: string; let cleanup: () => Promise<void>;
  if (kind === "postgres") {
    if (!pgUrl) throw new Error("격리 PG 주소 필요");
    const url = new URL(pgUrl);
    if (!["127.0.0.1", "localhost", "[::1]", "postgres"].includes(url.hostname) || url.searchParams.has("host")) throw new Error("격리 로컬·CI DB만 허용합니다");
    const admin = createDb(pgUrl).db;
    const name = `push_risk_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    url.pathname = `/${name}`; database = url.toString(); db = await createMigratedDb(database);
    cleanup = async () => { await sql`drop database ${sql.id(name)} with (force)`.execute(admin); await admin.destroy(); };
  } else {
    const directory = await mkdtemp(join(tmpdir(), "stock-push-risk-"));
    database = join(directory, "data.sqlite"); db = await createMigratedDb(database);
    cleanup = async () => rm(directory, { recursive: true, force: true });
  }
  const now = new Date(AT).toISOString();
  await db.insertInto("devices").values({ token: TOKEN, platform: "android", device_name: null, enabled: 1, disabled_reason: null, created_at: now, last_seen_at: now }).execute();
  const worker = async (holdSend = false, holdCheck = false) => { const w = new Worker(database, holdSend, holdCheck); workers.push(w); await w.wait("ready"); return w; };
  return { db, worker, async close() { await Promise.all(workers.map((w) => w.kill())); await db.destroy(); await cleanup(); } };
}

describe.each(["sqlite", ...(pgUrl ? ["postgres"] : [])] as const)("실제 별도 프로세스 푸시 경계 (%s), 외부 발송은 가짜", (kind) => {
  it("공유 DB 두 프로세스의 같은 발송은 외부 호출 한 번이다", async () => {
    const env = await setup(kind);
    try {
      const a = await env.worker(true); const b = await env.worker(true);
      const first = a.command("send"); void first.catch(() => undefined); await a.wait("send");
      const second = b.command("send"); void second.catch(() => undefined);
      // 정상 기대값은1이며 변경 전에는 b의 외부 호출도 관측된다.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect([...a.messages, ...b.messages].filter((m) => m.type === "send")).toHaveLength(1);
      a.release("send"); b.release("send");
      expect((await first).result).toMatchObject({ sent: 1 });
      expect((await second).result).toMatchObject({ sent: 0, suppressed: 1 });
    } finally { await env.close(); }
  }, 30_000);

  it("같은 영수증의 두 프로세스 확인은 외부 한 번·기기 처리 한 번이다", async () => {
    const env = await setup(kind);
    try {
      await new ReceiptStore(env.db).save([{ receiptId: "shared-process", token: TOKEN, receivedAt: AT }]);
      const a = await env.worker(false, true); const b = await env.worker(false, true);
      const first = a.command("check"); void first.catch(() => undefined); await a.wait("check");
      const second = b.command("check"); void second.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect([...a.messages, ...b.messages].filter((m) => m.type === "check")).toHaveLength(1);
      a.release("check"); b.release("check");
      expect((await first).result).toEqual({ checked: 1, disabled: 1 });
      expect((await second).result).toEqual({ checked: 0, disabled: 0 });
      expect((await b.command("check")).result).toEqual({ checked: 0, disabled: 0 });
    } finally { await env.close(); }
  }, 30_000);

  it("외부 발송 도중 SIGKILL한 뒤 미확인 발송을 보존하고 같은 이벤트를 반복하지 않는다", async () => {
    const env = await setup(kind);
    try {
      const a = await env.worker(true);
      const sending = a.command("send"); void sending.catch(() => undefined); await a.wait("send"); await a.kill();
      const b = await env.worker(); await b.command("advance", { advance: 6 * 60_000 });
      expect((await b.command("send")).result).toEqual({ sent: 0, failed: 0, disabled: [], suppressed: 1 });
      expect((await b.command("status")).result).toMatchObject({ uncertain: 1, accepted: 0, sending: 0 });
      expect(b.messages.filter((m) => m.type === "send")).toHaveLength(0);
    } finally { await env.close(); }
  }, 30_000);

  it("ACK checkpoint 후 영수증 쓰기 실패·SIGKILL은 새 프로세스가 발송 없이 복원한다", async () => {
    const env = await setup(kind);
    try {
      if (kind === "sqlite") await sql`create trigger risk_receipt_stop before insert on meta when NEW.key like 'push-receipt:%' begin select raise(abort, '격리 저장 실패'); end`.execute(env.db);
      else {
        await sql`create function risk_receipt_stop() returns trigger as $$ begin if NEW.key like 'push-receipt:%' then raise exception 'isolated receipt write failure'; end if; return NEW; end; $$ language plpgsql`.execute(env.db);
        await sql`create trigger risk_receipt_stop before insert on meta for each row execute function risk_receipt_stop()`.execute(env.db);
      }
      const a = await env.worker(); expect((await a.command("send")).result).toMatchObject({ sent: 1 }); await a.kill();
      expect(await new ReceiptStore(env.db).load(AT)).toEqual([]);
      if (kind === "sqlite") await sql`drop trigger risk_receipt_stop`.execute(env.db);
      else await sql`drop trigger risk_receipt_stop on meta`.execute(env.db);
      const b = await env.worker();
      expect((await b.command("check")).result).toEqual({ checked: 1, disabled: 1 });
      expect(b.messages.filter((m) => m.type === "send")).toHaveLength(0);
      await b.kill(); const c = await env.worker();
      expect((await c.command("check")).result).toEqual({ checked: 0, disabled: 0 });
    } finally { await env.close(); }
  }, 30_000);

  it("영수증 처리권 소유자를 SIGKILL하면 만료 후 새 프로세스가 이어 처리한다", async () => {
    const env = await setup(kind);
    try {
      await new ReceiptStore(env.db).save([{ receiptId: "dead-owner", token: TOKEN, receivedAt: AT }]);
      const a = await env.worker(false, true); const b = await env.worker();
      const checking = a.command("check"); void checking.catch(() => undefined); await a.wait("check"); await a.kill();
      expect((await b.command("check")).result).toEqual({ checked: 0, disabled: 0 });
      await b.command("advance", { advance: RECEIPT_LEASE_MS + 1 });
      expect((await b.command("check")).result).toEqual({ checked: 1, disabled: 1 });
      expect((await env.db.selectFrom("devices").select("enabled").where("token", "=", TOKEN).executeTakeFirstOrThrow()).enabled).toBe(0);
    } finally { await env.close(); }
  }, 30_000);
});
