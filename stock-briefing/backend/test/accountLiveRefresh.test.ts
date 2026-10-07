import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLiveRefresh } from "../src/services/accountLiveRefresh.js";
import type { AutoSyncStatus } from "../src/services/tossSyncService.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T10:00:00+09:00")); });
afterEach(() => vi.useRealTimers());
function setup() {
  const state: AutoSyncStatus = { enabled: true, running: false, intervalMin: 10, idleIntervalMin: 60,
    lastRunAt: null, lastTrigger: null, lastError: null, lastChanges: null, nextRunAt: null };
  const enabled = vi.fn(async () => true);
  const run = vi.fn(async () => { state.lastRunAt = new Date().toISOString(); return null; });
  const refresh = new AccountLiveRefresh({ enabled, autoSync: { status: () => state, run } });
  return { state, enabled, run, refresh };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("앱 연결 중 계좌 원본 갱신", () => {
  it("첫 접속은 즉시, 이후 완료 후 30초에 조회하고 이탈하면 멈춘다", async () => {
    const { refresh, run } = setup();
    refresh.setActive(true); await flush();
    expect(run).toHaveBeenCalledExactlyOnceWith("view");
    refresh.setActive(true);
    await vi.advanceTimersByTimeAsync(29_999); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    refresh.setActive(false);
    await vi.advanceTimersByTimeAsync(120_000); expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("최근 정기·수동 조회를 재사용하고 잦은 재접속으로 최소 간격을 우회하지 않는다", async () => {
    const { refresh, run, state } = setup();
    state.lastRunAt = new Date(Date.now() - 10_000).toISOString();
    refresh.setActive(true); await flush(); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    refresh.setActive(false); refresh.setActive(true); await flush(); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9999); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(1);
    refresh.setActive(false);
  });

  it("플래그·자동 동기화가 꺼져 있거나 이미 실행 중이면 외부 조회를 늘리지 않는다", async () => {
    const { refresh, run, state, enabled } = setup();
    enabled.mockResolvedValue(false); refresh.setActive(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(run).not.toHaveBeenCalled();
    enabled.mockResolvedValue(true); state.enabled = false;
    await vi.advanceTimersByTimeAsync(30_000); expect(run).not.toHaveBeenCalled();
    state.enabled = true; state.running = true;
    await vi.advanceTimersByTimeAsync(30_000); expect(run).not.toHaveBeenCalled();
    state.running = false;
    await vi.advanceTimersByTimeAsync(30_000); expect(run).toHaveBeenCalledTimes(1);
    refresh.setActive(false);
  });

  it("느린 실행과 이탈·재접속이 겹쳐도 한 번만 돌고 완료 뒤부터 간격을 센다", async () => {
    const { refresh, run, state } = setup();
    let finish!: () => void;
    run.mockImplementationOnce(async () => { await new Promise<void>(r => { finish = r; }); state.lastRunAt = new Date().toISOString(); return null; });
    refresh.setActive(true); await flush();
    refresh.setActive(false); refresh.setActive(true);
    await vi.advanceTimersByTimeAsync(90_000); expect(run).toHaveBeenCalledTimes(1);
    finish(); await flush();
    await vi.advanceTimersByTimeAsync(29_999); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    refresh.setActive(false);
  });

  it("조회 중 앱을 닫으면 완료 후 추가 예약을 만들지 않는다", async () => {
    const { refresh, run } = setup(); let finish!: () => void;
    run.mockImplementationOnce(async () => { await new Promise<void>(r => { finish = r; }); return null; });
    refresh.setActive(true); await flush(); refresh.setActive(false); finish(); await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("원본 실패는 1분·2분으로 늦추며 재접속에도 유지하고 성공 뒤 30초로 복귀한다", async () => {
    const { refresh, run, state } = setup(); state.lastError = "원본 연결 실패";
    refresh.setActive(true); await flush(); expect(run).toHaveBeenCalledTimes(1);
    refresh.setActive(false); refresh.setActive(true); await flush();
    await vi.advanceTimersByTimeAsync(59_999); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_999); expect(run).toHaveBeenCalledTimes(2);
    state.lastError = null;
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000); expect(run).toHaveBeenCalledTimes(4);
    refresh.setActive(false);
  });

  it("플래그 조회 중 이탈하면 조회를 시작하지 않고 거부도 처리한다", async () => {
    const { refresh, run, enabled } = setup(); let finish!: (v: boolean) => void;
    enabled.mockImplementationOnce(() => new Promise<boolean>(r => { finish = r; }));
    refresh.setActive(true); refresh.setActive(false); finish(true); await flush();
    expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    enabled.mockRejectedValueOnce(new Error("저장소 실패"));
    refresh.setActive(true); await flush();
    await vi.advanceTimersByTimeAsync(59_999); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(1);
    refresh.setActive(false);
  });
});
