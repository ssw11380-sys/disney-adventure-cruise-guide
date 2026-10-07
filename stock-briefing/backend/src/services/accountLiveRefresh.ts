import type { HoldingsAutoSync } from "./tossSyncService.js";

/** 앱을 보는 동안만 계좌 원본을 갱신한다. 시세·보고서 요청은 이 작업을 기다리지 않는다. */
export class AccountLiveRefresh {
  private active = false;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly deps: {
    autoSync: Pick<HoldingsAutoSync, "status" | "run">;
    enabled: () => Promise<boolean>;
    now?: () => number;
  }) {}

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (active) void this.tick();
  }

  private get now(): number { return (this.deps.now ?? Date.now)(); }

  private async tick(): Promise<void> {
    if (!this.active || this.busy) return;
    this.busy = true;
    let delay = 30_000;
    try {
      if (!await this.deps.enabled() || !this.active) return;
      const s = this.deps.autoSync.status();
      if (!s.enabled || s.running) return;
      const last = s.lastRunAt ? Date.parse(s.lastRunAt) : NaN;
      // 직전 정기·수동·체결 조회도 재사용한다. 재접속해도 실패 대기와 최소 간격을 우회하지 않는다.
      const due = Math.max(Number.isFinite(last) ? Math.min(last, this.now) + 30_000 : 0, this.retryAt);
      if (this.now < due) { delay = due - this.now; return; }
      await this.deps.autoSync.run("view");
      if (this.deps.autoSync.status().lastError) this.failed();
      else { this.failures = 0; this.retryAt = 0; }
    } catch {
      this.failed();
    } finally {
      this.busy = false;
      if (this.active) {
        delay = Math.max(delay, this.retryAt - this.now);
        this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, delay);
      }
    }
  }

  private failed(): void {
    this.failures = Math.min(this.failures + 1, 4);
    this.retryAt = this.now + Math.min(30_000 * 2 ** this.failures, 300_000);
  }
}
