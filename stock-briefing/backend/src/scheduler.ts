import cron, { type ScheduledTask } from "node-cron";
import type { BriefingService, BriefingSession } from "./services/briefingService.js";

export interface SchedulerOptions {
  /** null 이면 해당 세션 비활성 */
  morningCron: string | null;
  afternoonCron: string | null;
  timezone?: string;
  log?: { info(obj: Record<string, unknown>, msg: string): void; error(obj: Record<string, unknown>, msg: string): void };
}

export interface SchedulerStatus {
  timezone: string;
  jobs: Array<{ session: BriefingSession; cron: string; nextRun: string | null }>;
  running: boolean;
}

/**
 * node-cron 기반 스케줄러. 한국 시간 기준으로 오전/오후 브리핑을 돌린다.
 * 설정 화면에서 시간을 바꾸면 reschedule() 로 즉시 반영된다.
 * 휴장일(공휴일)에는 시세가 전일과 같게 나오지만 브리핑은 그대로 생성된다 (v1 범위 밖).
 */
export class BriefingScheduler {
  private tasks: Array<{ session: BriefingSession; expr: string; task: ScheduledTask }> = [];
  private readonly timezone: string;
  private readonly log: SchedulerOptions["log"];
  private crons: { morningCron: string | null; afternoonCron: string | null };

  constructor(
    private readonly service: BriefingService,
    opts: SchedulerOptions,
  ) {
    this.timezone = opts.timezone ?? "Asia/Seoul";
    this.log = opts.log;
    this.crons = { morningCron: opts.morningCron, afternoonCron: opts.afternoonCron };
  }

  static validate(expr: string): boolean {
    return cron.validate(expr);
  }

  start(): void {
    this.stop();
    const jobs: Array<[BriefingSession, string | null]> = [
      ["morning", this.crons.morningCron],
      ["afternoon", this.crons.afternoonCron],
    ];
    for (const [session, expr] of jobs) {
      if (!expr) continue;
      if (!cron.validate(expr)) throw new Error(`잘못된 cron 표현식 (${session}): ${expr}`);
      const task = cron.schedule(
        expr,
        async () => {
          this.log?.info({ session }, "정기 브리핑 시작");
          try {
            const r = await this.service.runSession(session);
            const failed = r.results.filter((x) => x.status === "failed").length;
            this.log?.info({ session, total: r.results.length, failed }, "정기 브리핑 완료");
          } catch (e) {
            this.log?.error({ session, err: (e as Error).message }, "정기 브리핑 실패");
          }
        },
        { timezone: this.timezone, name: `briefing-${session}-${Date.now()}` },
      );
      this.tasks.push({ session, expr, task });
    }
  }

  reschedule(crons: { morningCron: string | null; afternoonCron: string | null }): void {
    for (const c of [crons.morningCron, crons.afternoonCron]) {
      if (c && !cron.validate(c)) throw new Error(`잘못된 cron 표현식: ${c}`);
    }
    this.crons = crons;
    this.start();
    this.log?.info(this.crons, "브리핑 스케줄 변경");
  }

  stop(): void {
    for (const t of this.tasks) void t.task.destroy();
    this.tasks = [];
  }

  status(): SchedulerStatus {
    return {
      timezone: this.timezone,
      running: this.service.isRunning,
      jobs: this.tasks.map((t) => {
        let nextRun: string | null = null;
        try {
          const n = t.task.getNextRun();
          nextRun = n ? n.toISOString() : null;
        } catch {
          nextRun = null;
        }
        return { session: t.session, cron: t.expr, nextRun };
      }),
    };
  }
}
