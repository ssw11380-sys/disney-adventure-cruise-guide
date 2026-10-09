import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import type { GenerationJobTable } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import type { TextGenerator } from "../llm/generator.js";

const contexts = new AsyncLocalStorage<GenerationContext>();
const wrappedGenerators = new WeakSet<TextGenerator>();
const RETAIN_MS = 30 * 60_000;
type Checkpoint = { steps: Record<string, unknown>; pending: string[] };
export interface GenerationJobOptions {
  signature?: string;
  requestKey?: string;
  /** 사용자가 명시적으로 다시 만들기를 요청한 경우에만 중단된 외부 호출을 다시 허용한다. */
  retryUncertain?: boolean;
  /** 다른 입력의 실행은 기존 수동 요청처럼 충돌을 알린다. 예약 요청만 완료를 기다린다. */
  waitForDifferent?: boolean;
  /** 상위 회차의 같은 실행 ID에 속한 하위 작업만 저장 완료 결과를 재사용한다. */
  reuseCompleted?: boolean;
}
export interface GenerationJobTiming { leaseMs?: number; pollMs?: number; recordNow?: () => Date }
const interrupted = () => new AppError(409, "GENERATION_INTERRUPTED", "이전 생성이 중단되어 완료 여부를 확인하지 못했습니다. 다시 만들기를 눌러 새로 요청해 주세요.");
const lost = () => new AppError(409, "GENERATION_OWNERSHIP_LOST", "다른 서버가 이 작업을 복구하고 있습니다. 결과를 다시 확인해 주세요.");

/** DB의 한 행이 작업 소유권이다. 정상 소유자에는 고정 대기 없이 실행하고 중복 요청만 기존 실행을 기다린다. */
export class GenerationJobs {
  readonly leaseMs: number;
  readonly pollMs: number;
  private lastCleanup = 0;
  readonly recordNow: () => Date;
  constructor(readonly db: Db, timing: GenerationJobTiming = {}) {
    this.leaseMs = timing.leaseMs ?? 60_000;
    this.pollMs = timing.pollMs ?? 100;
    this.recordNow = timing.recordNow ?? (() => new Date());
  }

  async run<T>(key: string, options: GenerationJobOptions, work: (context: GenerationContext) => Promise<T>): Promise<T> {
    const signature = options.signature ?? key;
    let joinedRun: string | null = null;
    while (true) {
      const now = new Date().toISOString();
      if (options.requestKey) {
        await this.expireRequest(options.requestKey);
        const request = await this.db.selectFrom("generation_requests").selectAll().where("request_key", "=", options.requestKey).executeTakeFirst();
        if (request?.status === "completed" && request.result !== null) return JSON.parse(request.result) as T;
        if (request?.status === "failed") throw interrupted();
        if (request) joinedRun = request.run_id;
      }
      const owner = randomUUID();
      const fresh: GenerationJobTable = {
        job_key: key, run_id: randomUUID(), owner, signature, status: "running", started_at: now, updated_at: now,
        lease_until: this.deadline(), checkpoint: JSON.stringify({ steps: {}, pending: [] }), result: null, error: null,
      };
      // 삽입 충돌은 같은 DB에서 원자적으로 결정한다. 조회만으로 생성 권한을 결정하지 않는다.
      let claimed = await this.db.insertInto("generation_jobs").values(fresh).onConflict((oc) => oc.column("job_key").doNothing()).returningAll().executeTakeFirst();
      if (!claimed) {
        const row = await this.db.selectFrom("generation_jobs").selectAll().where("job_key", "=", key).executeTakeFirst();
        if (!row) continue;
        if (row.status === "completed" && row.signature === signature && row.result !== null && (row.run_id === joinedRun || options.reuseCompleted)) {
          if (options.requestKey) await this.remember(options.requestKey, row, "completed", row.result);
          return JSON.parse(row.result) as T;
        }
        if (row.status === "completed" && options.requestKey) {
          const settled = await this.db.selectFrom("generation_requests").selectAll().where("request_key", "=", options.requestKey).executeTakeFirst();
          if (settled?.status === "completed" && settled.result !== null) return JSON.parse(settled.result) as T;
          if (settled?.status === "failed") throw interrupted();
        }
        if (row.status === "running" && row.lease_until > now) {
          if (row.signature !== signature && !options.waitForDifferent) throw new AppError(409, "GENERATION_BUSY", "다른 보고서를 만드는 중입니다. 완료 후 다시 시도해 주세요.");
          if (row.signature === signature) {
            joinedRun = row.run_id;
            if (options.requestKey) await this.remember(options.requestKey, row, "pending", null);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, this.pollMs));
          continue;
        }
        if (joinedRun === row.run_id && row.status === "failed") throw interrupted();
        // 만료된 작업만 이어받는다. 이전 소유자의 늦은 쓰기는 owner 비교에서 거절된다.
        const recover = row.signature === signature && row.status !== "completed";
        const replacement = recover ? { ...fresh, run_id: row.run_id, started_at: row.started_at, checkpoint: row.checkpoint } : fresh;
        claimed = await this.db.updateTable("generation_jobs").set(replacement)
          .where("job_key", "=", key).where("owner", "=", row.owner).where("status", "=", row.status)
          .where("lease_until", "=", row.lease_until).returningAll().executeTakeFirst();
        if (!claimed) continue;
      }
      const context = new GenerationContext(this, claimed, options.retryUncertain === true);
      const heartbeat = setInterval(() => { void context.renew().catch(() => context.invalidate()); }, Math.max(10, Math.floor(this.leaseMs / 3)));
      heartbeat.unref();
      try {
        if (options.requestKey) await this.remember(options.requestKey, claimed, "pending", null);
        await this.cleanup();
        const result = await contexts.run(context, () => work(context));
        if (!context.completed) await context.commit(async () => result);
        return result;
      } catch (error) {
        await context.fail().catch(() => undefined);
        throw error;
      } finally {
        clearInterval(heartbeat);
        await context.drain();
      }
    }
  }

  deadline(): string { return new Date(Date.now() + this.leaseMs).toISOString(); }

  private async remember(requestKey: string, row: GenerationJobTable, status: string, result: string | null) {
    await this.db.insertInto("generation_requests").values({ request_key: requestKey, job_key: row.job_key, run_id: row.run_id, status, result, updated_at: this.recordNow().toISOString() })
      .onConflict((oc) => oc.column("request_key").doNothing()).execute();
    // 완료 직후 합류한 요청도 같은 결과를 받는다. 다른 실행에 이미 연결된 ID는 덮어쓰지 않는다.
    if (status === "completed") await this.db.updateTable("generation_requests").set({ status, result, updated_at: this.recordNow().toISOString() })
      .where("request_key", "=", requestKey).where("run_id", "=", row.run_id).execute();
  }

  async request<T>(requestKey: string): Promise<{ status: "pending" | "completed" | "failed" | "unknown"; result: T | null }> {
    const row = await this.db.selectFrom("generation_requests").selectAll().where("request_key", "=", requestKey).executeTakeFirst();
    if (!row || (row.status !== "pending" && Date.parse(row.updated_at) <= this.recordNow().getTime() - RETAIN_MS)) return { status: "unknown", result: null };
    if (row.status === "completed") return { status: "completed", result: row.result ? JSON.parse(row.result) as T : null };
    if (row.status === "failed") return { status: "failed", result: null };
    const job = await this.db.selectFrom("generation_jobs").select(["status", "lease_until", "run_id", "result"]).where("job_key", "=", row.job_key).executeTakeFirst();
    if (job?.run_id === row.run_id && job.status === "completed" && job.result !== null) return { status: "completed", result: JSON.parse(job.result) as T };
    return { status: job?.run_id === row.run_id && job.status === "running" && job.lease_until > new Date().toISOString() ? "pending" : "failed", result: null };
  }

  async completeRequest<T>(requestKey: string, jobKey: string, value: T): Promise<void> {
    await this.expireRequest(requestKey);
    await this.db.insertInto("generation_requests").values({ request_key: requestKey, job_key: jobKey, run_id: randomUUID(), status: "completed", result: JSON.stringify(value), updated_at: this.recordNow().toISOString() })
      .onConflict((oc) => oc.column("request_key").doNothing()).execute();
  }

  private async expireRequest(requestKey: string) {
    await this.db.deleteFrom("generation_requests").where("request_key", "=", requestKey).where("status", "!=", "pending")
      .where("updated_at", "<=", new Date(this.recordNow().getTime() - RETAIN_MS).toISOString()).execute();
  }

  async running(key: string): Promise<boolean> {
    const row = await this.db.selectFrom("generation_jobs").select("job_key").where("job_key", "=", key)
      .where("status", "=", "running").where("lease_until", ">", new Date().toISOString()).executeTakeFirst();
    return !!row;
  }

  async anyRunning(prefixes: string[]): Promise<boolean> {
    const row = await this.db.selectFrom("generation_jobs").select("job_key").where("status", "=", "running")
      .where("lease_until", ">", new Date().toISOString()).where((eb) => eb.or(prefixes.map((prefix) => eb("job_key", "like", `${prefix}%`)))).executeTakeFirst();
    return !!row;
  }

  private async cleanup() {
    if (Date.now() - this.lastCleanup < 60_000) return;
    this.lastCleanup = Date.now();
    const cutoff = new Date(this.recordNow().getTime() - RETAIN_MS).toISOString();
    // 진행 중 요청은 지우지 않는다. 완료 요청은 기존 재조회 보장 시간만 보존한다.
    await this.db.deleteFrom("generation_requests").where("updated_at", "<", cutoff).where("status", "!=", "pending").execute();
    // 만료된 요청의 실패를 확정한다. 실행 중이거나 미확정 모델 응답이 있는 작업의 체크포인트는 보존한다.
    await this.db.updateTable("generation_requests").set({ status: "failed", updated_at: this.recordNow().toISOString() })
      .where("status", "=", "pending").where("updated_at", "<", cutoff)
      .where("job_key", "not in", this.db.selectFrom("generation_jobs").select("job_key").where("status", "=", "running").where("lease_until", ">", new Date().toISOString())).execute();
    await this.db.deleteFrom("generation_jobs").where("status", "=", "completed").where("updated_at", "<", new Date(Date.now() - 7 * 86_400_000).toISOString()).execute();
  }
}

export class GenerationContext {
  private checkpoint: Checkpoint;
  private invalid = false;
  completed = false;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly jobs: GenerationJobs, private readonly row: GenerationJobTable, private readonly retryUncertain: boolean) {
    this.checkpoint = JSON.parse(row.checkpoint) as Checkpoint;
  }
  get runId(): string { return this.row.run_id; }
  invalidate() { this.invalid = true; }
  private guard(db: Db) {
    if (this.invalid) throw lost();
    return db.updateTable("generation_jobs").where("job_key", "=", this.row.job_key).where("run_id", "=", this.row.run_id)
      .where("owner", "=", this.row.owner).where("status", "=", "running").where("lease_until", ">", new Date().toISOString());
  }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const p = this.writes.then(work);
    this.writes = p.catch(() => undefined);
    return p;
  }
  async renew(): Promise<void> {
    if (this.completed) return;
    await this.queue(async () => {
      if (this.completed) return;
      const r = await this.guard(this.jobs.db).set({ lease_until: this.jobs.deadline() }).executeTakeFirst();
      if (r.numUpdatedRows !== 1n) { this.invalid = true; throw lost(); }
    });
  }
  async drain() { await this.writes; }
  private async save() {
    try { await this.queue(async () => {
      const r = await this.guard(this.jobs.db).set({ checkpoint: JSON.stringify(this.checkpoint), lease_until: this.jobs.deadline(), updated_at: new Date().toISOString() }).executeTakeFirst();
      if (r.numUpdatedRows !== 1n) { this.invalid = true; throw lost(); }
    }); } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, "GENERATION_CHECKPOINT_FAILED", "생성 중간 결과를 저장하지 못했습니다. 이전 보고서는 보존됩니다. 잠시 후 다시 확인해 주세요.");
    }
  }
  /** 리스너 등 외부 효과는 이미 소유권을 잃은 실행에서 시작하지 않는다. */
  async effect<T>(name: string, work: () => Promise<T>): Promise<T> {
    await this.renew();
    return this.step(name, work);
  }
  async step<T>(name: string, work: () => Promise<T>, paid = false): Promise<T> {
    if (this.invalid) throw lost();
    if (Object.hasOwn(this.checkpoint.steps, name)) return this.checkpoint.steps[name] as T;
    const group = name.slice(0, name.lastIndexOf(":") + 1);
    if (paid && this.checkpoint.pending.some((pending) => pending === name || pending.startsWith(group)) && !this.retryUncertain) throw interrupted();
    if (paid) {
      if (!this.checkpoint.pending.includes(name)) this.checkpoint.pending.push(name);
      await this.save();
    }
    const result = await work();
    this.checkpoint.steps[name] = result;
    this.checkpoint.pending = this.checkpoint.pending.filter((value) => value !== name);
    await this.save();
    return result;
  }
  /** 결과 본문과 작업 완료를 같은 트랜잭션으로 확정하고 이전 소유자의 저장을 거절한다. */
  async commit<T>(save: (db: Db) => Promise<T>): Promise<T> {
    return this.queue(async () => {
      const result = await this.jobs.db.transaction().execute(async (tx) => {
        const locked = await this.guard(tx).set({ lease_until: this.jobs.deadline() }).executeTakeFirst();
        if (locked.numUpdatedRows !== 1n) { this.invalid = true; throw lost(); }
        const value = await save(tx);
        const encoded = JSON.stringify(value);
        const now = new Date().toISOString();
        await tx.updateTable("generation_jobs").set({ status: "completed", result: encoded, error: null, updated_at: now, checkpoint: JSON.stringify({ steps: {}, pending: [] }) })
          .where("job_key", "=", this.row.job_key).where("owner", "=", this.row.owner).execute();
        await tx.updateTable("generation_requests").set({ status: "completed", result: encoded, updated_at: this.jobs.recordNow().toISOString() })
          .where("job_key", "=", this.row.job_key).where("run_id", "=", this.row.run_id).execute();
        return value;
      });
      this.completed = true;
      return result;
    });
  }
  async fail() {
    if (this.completed || this.invalid) return;
    await this.queue(async () => {
      await this.jobs.db.transaction().execute(async (tx) => {
        const changed = await this.guard(tx).set({ status: "failed", error: "생성 작업이 중단됐습니다", updated_at: new Date().toISOString() }).executeTakeFirst();
        if (changed.numUpdatedRows !== 1n) return;
        await tx.updateTable("generation_requests").set({ status: "failed", updated_at: this.jobs.recordNow().toISOString() })
          .where("job_key", "=", this.row.job_key).where("run_id", "=", this.row.run_id).execute();
      });
    });
  }
}

/** 전체 입력과 설정의 해시로 저장된 모델 결과를 재사용한다. 모델 등급·본문·단계는 바꾸지 않는다. */
export function checkpointGenerator(generator: TextGenerator): TextGenerator {
  if (wrappedGenerators.has(generator)) return generator;
  const wrapped: TextGenerator = {
    get model() { return generator.model; },
    generate(request) {
      const context = contexts.getStore();
      if (!context) return generator.generate(request);
      const key = `model:${request.label ?? "unlabelled"}:${createHash("sha256").update(JSON.stringify({ model: generator.model, request })).digest("hex")}`;
      return context.step(key, () => generator.generate(request), true);
    },
  };
  wrappedGenerators.add(wrapped);
  return wrapped;
}
