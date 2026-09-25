import cron, { type ScheduledTask } from "node-cron";
import type { BriefingService, BriefingSession } from "./services/briefingService.js";

export interface SchedulerOptions {
  /** null 이면 해당 세션 비활성 */
  morningCron: string | null;
  afternoonCron: string | null;
  timezone?: string;
  /** 정기 브리핑 직전에 실행 (예: 토스 보유 종목 동기화). 실패해도 브리핑은 진행 */
  beforeRun?: (session: BriefingSession) => Promise<void>;
  log?: { info(obj: Record<string, unknown>, msg: string): void; error(obj: Record<string, unknown>, msg: string): void };
  /** 예약 시각을 잴 시계 (테스트에서 주입). 기본은 지금 */
  now?: () => Date;
}

/** 이벤트 루프가 잠깐 막히거나 서버가 잠들어 예약 시각을 늦게 알아채도 이만큼 안이면 건너뛰지 않고 돈다 (node-cron 기본 1초) */
const LATE_TOLERANCE_MS = 30 * 60_000;

export interface SchedulerStatus {
  timezone: string;
  jobs: Array<{ session: BriefingSession; cron: string; nextRun: string | null }>;
  running: boolean;
}

/**
 * node-cron 기반 스케줄러. 한국 시간 기준으로 오전/오후 브리핑을 돌린다.
 * 설정 화면에서 시간을 바꾸면 reschedule() 로 즉시 반영된다.
 * 휴장일(공휴일)에는 BriefingService 가 세션이 다루는 그 시장의 거래일(briefingMarketDate — 월요일 오전의 미국은 금요일)을 달력으로 보고 해당 종목을 건너뛴다.
 */
export class BriefingScheduler {
  private tasks: Array<{ session: BriefingSession; expr: string; task: ScheduledTask }> = [];
  private readonly timezone: string;
  private readonly log: SchedulerOptions["log"];
  private crons: { morningCron: string | null; afternoonCron: string | null };
  private readonly beforeRun: SchedulerOptions["beforeRun"];
  private readonly now: () => Date;

  constructor(
    private readonly service: BriefingService,
    opts: SchedulerOptions,
  ) {
    this.timezone = opts.timezone ?? "Asia/Seoul";
    this.log = opts.log;
    this.beforeRun = opts.beforeRun;
    this.now = opts.now ?? (() => new Date());
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
      const task = cron.schedule(expr, () => this.runScheduled(session), {
        timezone: this.timezone,
        name: `briefing-${session}-${Date.now()}`,
        missedExecutionTolerance: LATE_TOLERANCE_MS,
      });
      this.tasks.push({ session, expr, task });
    }
  }

  /**
   * 예약 시각에 도는 한 회차.
   *  - 수동 실행이 도는 중이면 건너뛰지 않고 끝날 때까지 기다렸다가 이어서 돈다
   *  - 예약 시각보다 먼저(수동으로) 만든 같은 회차 브리핑은 다시 만든다 — 장중·장전 내용이 그날 회차로 남지 않고 회차 알림에도 들어가게.
   *    예약 시각 뒤에 만든 것(겹친 수동 실행이 막 만든 것)은 그대로 쓴다
   */
  private async runScheduled(session: BriefingSession): Promise<void> {
    const firedAt = this.now();
    this.log?.info({ session }, "정기 브리핑 시작");
    try {
      if (this.service.isRunning) this.log?.info({ session }, "다른 브리핑이 실행 중이라 끝나면 이어서 실행");
      await this.beforeRun?.(session).catch((e: unknown) => this.log?.error({ session, err: (e as Error).message }, "브리핑 사전 작업 실패"));
      const r = await this.service.runSession(session, { trigger: "schedule", wait: true, staleBefore: firedAt });
      const failed = r.results.filter((x) => x.status === "failed").length;
      const skipped = r.results.filter((x) => x.status === "skipped").length;
      this.log?.info({ session, total: r.results.length, failed, skipped }, "정기 브리핑 완료");
    } catch (e) {
      this.log?.error({ session, err: (e as Error).message }, "정기 브리핑 실패");
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
