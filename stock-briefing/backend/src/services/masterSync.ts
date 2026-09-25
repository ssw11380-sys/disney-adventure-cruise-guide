import cron, { type ScheduledTask } from "node-cron";
import type { Db } from "../db/index.js";
import type { StockService } from "./stockService.js";

/** 매일 갱신 때 받은 목록이 지금의 이 비율보다 적으면 바꾸지 않는다 (상장폐지는 하루 몇 건뿐이다) */
const MIN_KEEP_RATIO = 0.8;
/** 매일 한국 07:30 (장 시작 전) */
const DAILY_CRON = "30 7 * * *";
const SOURCE_KEY = "master_source";

/** refreshed = 새로 받음, kept = 받을 필요 없어 그대로, failed = 받기 실패·목록 이상으로 그대로 */
export type MasterSyncResult = "refreshed" | "kept" | "failed";

export interface MasterSyncDeps {
  db: Db;
  stocks: Pick<StockService, "refreshMaster" | "masterStatus">;
  /** 지금 설정의 마스터 출처 (토스 Open API 키가 있으면 toss-openapi, 없으면 kis-master) */
  source: string;
  log: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void };
}

/**
 * 종목 마스터 받기. 기동 때는 비었거나 출처가 바뀌었을 때만, 그 뒤로는 매일 한 번 (신규 상장·상장폐지·이름 변경 반영).
 * master_source 는 받기가 성공한 뒤에만 저장한다 → 출처를 바꾸던 받기가 실패하면 다음 기동·매일 갱신 때 다시 받는다
 */
export class MasterSync {
  private running: Promise<MasterSyncResult> | null = null;
  private task: ScheduledTask | null = null;

  constructor(private readonly deps: MasterSyncDeps) {}

  /** 기동 시: 비었거나 출처가 바뀌었으면 받는다 (실패해도 서버는 뜬다) */
  boot(): Promise<MasterSyncResult> {
    return this.once(false);
  }

  /** 매일: 늘 다시 받되, 같은 출처에서 받은 목록이 비었거나 크게 줄면 바꾸지 않는다 */
  daily(): Promise<MasterSyncResult> {
    return this.once(true);
  }

  start(timezone = "Asia/Seoul"): void {
    this.stop();
    this.task = cron.schedule(DAILY_CRON, () => void this.daily(), { timezone, name: "stock-master-daily" });
  }

  stop(): void {
    if (this.task) void this.task.destroy();
    this.task = null;
  }

  /** 받는 중에 또 부르면 같은 결과를 기다린다 (기동 받기와 매일 갱신이 겹쳐도 한 번만 받게) */
  private once(always: boolean): Promise<MasterSyncResult> {
    this.running ??= this.run(always).finally(() => (this.running = null));
    return this.running;
  }

  private async run(always: boolean): Promise<MasterSyncResult> {
    const { db, stocks, source, log } = this.deps;
    try {
      const status = await stocks.masterStatus();
      const saved = (await db.selectFrom("meta").select("value").where("key", "=", SOURCE_KEY).executeTakeFirst())?.value ?? null;
      const switching = status.count === 0 || saved !== source;
      if (!always && !switching) {
        log.info(status, "종목 마스터 로드됨");
        return "kept";
      }
      log.info({ source, switching }, `종목 마스터를 ${source} 로 내려받습니다...`);
      // 빈 목록으로는 바꾸지 않는다. 비었거나 출처를 바꿀 때는 줄어도 바꾼다 (토스 → KIS 는 미국 종목이 빠진다)
      const r = await stocks.refreshMaster({ minKeepRatio: switching ? 0 : MIN_KEEP_RATIO });
      if (saved !== source) {
        await db.insertInto("meta").values({ key: SOURCE_KEY, value: source }).onConflict((oc) => oc.column("key").doUpdateSet({ value: source })).execute();
      }
      log.info(r, "종목 마스터 갱신 완료");
      return "refreshed";
    } catch (e) {
      log.warn({ err: e }, "종목 마스터 갱신 실패 (검색은 외부 소스로 대체)");
      return "failed";
    }
  }
}
