import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createDb, createMigratedDb, type Db } from "../src/db/index.js";

type Message = { event: string; id?: string; result?: any; error?: string; label?: string; count?: number };
class Worker {
  readonly messages: Message[] = [];
  readonly child: ChildProcess;
  private readonly listeners = new Set<() => void>();
  private stderr = "";
  readonly exited: Promise<void>;
  private dead = false;
  readonly applicationName = `remaining_worker_${randomUUID().replaceAll("-", "")}`;
  constructor(database: string) {
    if (database.startsWith("postgres")) { const url = new URL(database); url.searchParams.set("application_name", this.applicationName); database = url.toString(); }
    this.child = fork(fileURLToPath(new URL("./fixtures/remainingProcessWorker.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, REMAINING_TEST_DATABASE: database },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child.stderr?.on("data", (chunk) => { this.stderr += String(chunk); });
    this.child.on("message", (message: Message) => { this.messages.push(message); this.listeners.forEach((listener) => listener()); });
    this.exited = new Promise((resolve) => this.child.once("exit", () => { this.dead = true; this.listeners.forEach((listener) => listener()); resolve(); }));
  }
  wait(event: string, id?: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        const found = this.messages.find((m) => m.event === event && (id === undefined || m.id === id));
        if (!found && !this.dead) return;
        clearTimeout(timer); this.listeners.delete(finish);
        if (found) resolve(found); else reject(new Error(`검증 자식 프로세스 조기 종료: ${this.stderr}`));
      };
      const timer = setTimeout(() => { this.listeners.delete(finish); reject(new Error(`검증 메시지 제한 시간: ${event} ${this.stderr}`)); }, 12_000);
      this.listeners.add(finish); finish();
    });
  }
  command(command: string, requestId?: string) {
    const id = randomUUID();
    this.child.send({ command, id, requestId });
    return { id, done: this.wait("result", id) };
  }
  release() { this.child.send({ command: "release" }); }
  async kill() { if (!this.dead) this.child.kill("SIGKILL"); await this.exited; }
  get alive() { return !this.dead; }
}
const pgUrl = process.env["TEST_PG_URL"];
async function isolated(kind: "sqlite" | "postgres") {
  const workers: Worker[] = [];
  let db: Db;
  let database: string;
  let cleanup: () => Promise<void>;
  if (kind === "postgres") {
    if (!pgUrl) throw new Error("격리 PostgreSQL 검사 주소 필요");
    const url = new URL(pgUrl);
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("로컬 격리 DB만 허용합니다");
    const admin = createDb(pgUrl).db;
    const name = `remaining_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    url.pathname = `/${name}`;
    database = url.toString();
    db = await createMigratedDb(database);
    cleanup = async () => { await sql`drop database ${sql.id(name)} with (force)`.execute(admin); await admin.destroy(); };
  } else {
    const directory = await mkdtemp(join(tmpdir(), "stock-remaining-"));
    database = join(directory, "data.sqlite");
    db = await createMigratedDb(database);
    cleanup = async () => rm(directory, { recursive: true, force: true });
  }
  const now = "2026-12-28T09:00:00+09:00";
  await db.insertInto("registered_stocks").values({ code: "005930", name: "삼성전자", market: "KOSPI", quantity: 10, avg_price: 95_000, memo: "", created_at: now, updated_at: now }).execute();
  const worker = async () => { const value = new Worker(database); workers.push(value); await value.wait("ready"); return value; };
  return { db, database, worker, async close() { await Promise.all(workers.map((w) => w.kill())); await db.destroy(); await cleanup(); } };
}

describe.each(["sqlite", ...(pgUrl ? ["postgres"] : [])] as const)("실제 별도 프로세스 중단과 복원 (%s), 모델·푸시는 가짜", (kind) => {
  it.each(["analysis", "briefing"])("프로세스 간 같은 %s 요청이 한 번의 생성과 같은 결과에 합류한다", async (command) => {
    const env = await isolated(kind);
    try {
      const a = await env.worker(); const b = await env.worker();
      const first = a.command(command, "shared-request");
      await a.wait("model");
      if (command === "briefing") {
        const other = (await b.command("progress").done).result;
        expect(other.settings.running).toBe(true);
        expect(other.progress).toMatchObject({ session: "morning", date: "2026-12-28", total: 1, done: 0 });
      }
      const second = b.command(command, "shared-request");
      if (command === "analysis") expect((await b.command("state", "shared-request").done).result.request.status).toBe("pending");
      a.release(); b.release();
      const results = await Promise.all([first.done, second.done]);
      expect(results.map((r) => r.error)).toEqual([undefined, undefined]);
      const modelCalls = [...a.messages, ...b.messages].filter((m) => m.event === "model").length;
      const rows = await env.db.selectFrom(command === "analysis" ? "analyses" : "briefings").selectAll().execute();
      expect(modelCalls).toBe(command === "analysis" ? 1 : 2);
      expect(rows).toHaveLength(1);
      if (command === "analysis") expect(results[0]!.result.id).toBe(results[1]!.result.id);
      else expect(results[0]!.result.results).toEqual(results[1]!.result.results);
      console.info(JSON.stringify({ evidence: "M01 수정 후 중복 없음", database: kind, command, processes: 2, modelCalls, storedRows: rows.length }));
    } finally { await env.close(); }
  }, 30_000);
  it("SIGKILL 뒤 이전 저장 결과를 보존하고 만료된 작업을 실패로 구분한 뒤 명시적 재요청을 완료한다", async () => {
    const env = await isolated(kind);
    try {
      const before = await env.worker(); before.release();
      const saved = await before.command("analysis", "saved").done;
      expect(saved.error).toBeUndefined();
      await before.kill();
      const interrupted = await env.worker();
      const pending = interrupted.command("analysis", "interrupted");
      void pending.done.catch(() => undefined);
      await interrupted.wait("model"); await interrupted.kill();
      // 죽은 프로세스의 소유권 만료를 즉시 재현한다. 제품에서는 실제 임대 시간이 지나야 인계한다.
      await env.db.updateTable("generation_jobs").set({ lease_until: new Date(Date.now() - 1).toISOString() }).where("status", "=", "running").execute();
      expect(await env.db.selectFrom("analyses").selectAll().execute()).toHaveLength(1);
      const restarted = await env.worker();
      const state = (await restarted.command("state", "interrupted").done).result;
      expect(state).toMatchObject({ running: false, request: { status: "failed", result: null }, latest: { id: saved.result.id } });
      restarted.release();
      expect((await restarted.command("analysis", "interrupted").done).error).toBeTruthy();
      const result = await restarted.command("analysis", "explicit-retry").done;
      expect(result.error).toBeUndefined();
      expect(result.result.id).not.toBe(saved.result.id);
      expect(await env.db.selectFrom("analyses").selectAll().execute()).toHaveLength(2);
      expect(restarted.messages.filter((m) => m.event === "model")).toHaveLength(1);
    } finally { await env.close(); }
  }, 30_000);

  it("상세 생성 완료·요약 진행 중 SIGKILL 뒤에는 같은 상세 원문을 복원하고 명시적 재요청의 요약만 생성한다", async () => {
    const env = await isolated(kind);
    try {
      const first = await env.worker();
      const run = first.command("briefing-summary-hold"); void run.done.catch(() => undefined);
      await first.wait("summary"); await first.kill();
      const saved = await env.db.selectFrom("generation_jobs").selectAll().where("job_key", "like", "briefing:005930:%").executeTakeFirstOrThrow();
      const steps = JSON.parse(saved.checkpoint).steps;
      const modelResults = Object.entries(steps).filter(([key]) => key.startsWith("model:"));
      expect(modelResults).toHaveLength(1);
      expect(await env.db.selectFrom("briefings").selectAll().execute()).toHaveLength(0);
      await env.db.updateTable("generation_jobs").set({ lease_until: new Date(Date.now() - 1).toISOString() }).where("status", "=", "running").execute();
      const next = await env.worker(); next.release();
      expect((await next.command("briefing-force").done).error).toBeUndefined();
      const calls = next.messages.filter((m) => m.event === "model");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.label).toContain("briefing_summary");
      const row = await env.db.selectFrom("briefings").selectAll().executeTakeFirstOrThrow();
      expect(row.detail).toBe((modelResults[0]![1] as { text: string }).text);
      console.info(JSON.stringify({ evidence: "중단 후 상세 원문 복원", database: kind, paidModel: false, newDetailCalls: 0, newSummaryCalls: 1 }));
    } finally { await env.close(); }
  }, 30_000);

  it("발송 영수증을 저장한 뒤 SIGKILL해도 재시작 시 복원하고 추가 발송 없이 무효 기기를 처리한다", async () => {
    const env = await isolated(kind);
    const token = "ExponentPushToken[remaining_process_device]";
    try {
      const now = "2026-12-28T09:00:00+09:00";
      await env.db.insertInto("devices").values({ token, platform: "android", device_name: null, enabled: 1, disabled_reason: null, created_at: now, last_seen_at: now }).execute();
      const before = await env.worker();
      expect((await before.command("send").done).result).toEqual({ sent: 1, failed: 0, disabled: [] });
      await before.kill();
      const restarted = await env.worker();
      expect((await restarted.command("receipts").done).result).toEqual({ checked: 1, disabled: 1 });
      expect((await env.db.selectFrom("devices").selectAll().where("token", "=", token).executeTakeFirstOrThrow()).enabled).toBe(0);
      expect(restarted.messages.filter((m) => m.event === "push")).toHaveLength(0);
      expect((await restarted.command("receipts").done).result).toEqual({ checked: 0, disabled: 0 });
    } finally { await env.close(); }
  }, 30_000);
});

it.skipIf(!pgUrl)("격리 PostgreSQL이 유휴 연결을 끊어도 프로세스는 살아 있고 진행 중인 분석을 재연결해 저장한다", async () => {
  const env = await isolated("postgres");
  try {
    const worker = await env.worker();
    const pending = worker.command("analysis", "disconnect");
    void pending.done.catch(() => undefined);
    await worker.wait("model");
    const terminated = await sql<{ stopped: boolean }>`select pg_terminate_backend(pid) as stopped from pg_stat_activity where application_name = ${worker.applicationName} and datname = current_database()`.execute(env.db);
    expect(terminated.rows.length).toBeGreaterThan(0);
    expect(terminated.rows.every((r) => r.stopped)).toBe(true);
    // DB 소켓의 close/error가 실제 자식 프로세스에 전달될 시간만 제공한다. 제품 대기가 아니다.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(worker.alive).toBe(true);
    worker.release();
    const result = await pending.done;
    expect(result.error).toBeUndefined();
    expect(await env.db.selectFrom("analyses").selectAll().execute()).toHaveLength(1);
    expect(worker.messages.filter((m) => m.event === "model")).toHaveLength(1);
  } finally { await env.close(); }
}, 30_000);

it.skipIf(!pgUrl)("격리 PostgreSQL 저장 연결을 강제 종료하면 성공으로 표시하지 않고 기존 자료 보존·다음 요청 복구를 확인한다", async () => {
  const env = await isolated("postgres");
  try {
    const worker = await env.worker(); worker.release();
    const saved = await worker.command("analysis", "before-disconnect").done;
    expect(saved.error).toBeUndefined();
    await sql`create function remaining_delay() returns trigger as $$ begin perform pg_sleep(10); return NEW; end; $$ language plpgsql`.execute(env.db);
    await sql`create trigger remaining_delay before insert on analyses for each row execute function remaining_delay()`.execute(env.db);
    const pending = worker.command("analysis", "save-disconnect");
    let target: number | undefined;
    for (let i = 0; i < 100; i++) {
      const rows = await sql<{ pid: number }>`select pid from pg_stat_activity where application_name = ${worker.applicationName} and datname = current_database() and state = 'active' and query like 'insert into "analyses"%'`.execute(env.db);
      target = rows.rows[0]?.pid;
      if (target !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(target, "검증용 저장 지연 지점 도달").toBeTypeOf("number");
    await sql`select pg_terminate_backend(${target!})`.execute(env.db);
    expect((await pending.done).error).toBeTruthy();
    expect(worker.alive).toBe(true);
    const rows = await env.db.selectFrom("analyses").selectAll().execute();
    expect(rows).toHaveLength(1); expect(rows[0]?.id).toBe(saved.result.id);
    expect((await worker.command("state", "save-disconnect").done).result.request.status).toBe("failed");
    await sql`drop trigger remaining_delay on analyses`.execute(env.db);
    const recovered = await worker.command("analysis", "after-disconnect").done;
    expect(recovered.error).toBeUndefined();
    expect(await env.db.selectFrom("analyses").selectAll().execute()).toHaveLength(2);
  } finally { await env.close(); }
}, 30_000);
