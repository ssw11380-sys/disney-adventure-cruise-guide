import cron, { type ScheduledTask } from "node-cron";
import type { BriefingService, BriefingSession } from "./services/briefingService.js";

export interface SchedulerOptions {
  morningCron: string;
  afternoonCron: string;
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
 * 휴장일(공휴일)에는 시세가 전일과 같게 나오지만 브리핑은 그대로 생성된다 (v1 범위 밖).
 */
export class BriefingScheduler {
  private tasks: Array<{ session: BriefingSession; expr: string; task: ScheduledTask }> = [];
  private readonly timezone: string;

  constructor(
    private readonly service: BriefingService,
    private readonly opts: SchedulerOptions,
  ) {
    this.timezone = opts.timezone ?? "Asia/Seoul";
  }

  static validate(expr: string): boolean {
    return cron.validate(expr);
  }

  start(): void {
    const jobs: Array<[BriefingSession, string]> = [
      ["morning", this.opts.morningCron],
      ["afternoon", this.opts.afternoonCron],
    ];
    for (const [session, expr] of jobs) {
      if (!cron.validate(expr)) throw new Error(`잘못된 cron 표현식 (${session}): ${expr}`);
      const task = cron.schedule(
        expr,
        async () => {
          this.opts.log?.info({ session }, "정기 브리핑 시작");
          try {
            const r = await this.service.runSession(session);
            const failed = r.results.filter((x) => x.status === "failed").length;
            this.opts.log?.info({ session, total: r.results.length, failed }, "정기 브리핑 완료");
          } catch (e) {
            this.opts.log?.error({ session, err: (e as Error).message }, "정기 브리핑 실패");
          }
        },
        { timezone: this.timezone, name: `briefing-${session}` },
      );
      this.tasks.push({ session, expr, task });
    }
  }

  stop(): void {
    for (const t of this.tasks) void t.task.stop();
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
