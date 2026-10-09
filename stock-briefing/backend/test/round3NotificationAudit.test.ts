import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { PushMessage, PushSender, PushSendResult } from "../src/notifications/push.js";
import { defaultsFromCron, NotificationSettingsStore } from "../src/notifications/settings.js";
import { DeviceService } from "../src/services/deviceService.js";
import { NotificationService } from "../src/services/notificationService.js";

const TOKEN = "ExponentPushToken[round3_local_only]";
const START = Date.parse("2026-12-28T09:30:00+09:00");
type Receipt = { receiptId: string; ok: boolean; error: string | null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class HeldPush implements PushSender {
  readonly name = "3차 가짜 발송기";
  sent: PushMessage[] = [];
  checked: string[][] = [];
  check: ((ids: string[]) => Promise<Receipt[]>) | undefined;
  beforeSend: (() => Promise<void>) | undefined;
  isValidToken(): boolean { return true; }
  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    const count = this.sent.length;
    await this.beforeSend?.();
    return { results: tokens.map((token, index) => ({ token, ok: true, error: null, receiptId: `receipt-${count}-${index}` })) };
  }
  async checkReceipts(ids: string[]): Promise<Receipt[]> {
    this.checked.push(ids);
    return this.check ? this.check(ids) : ids.map((receiptId) => ({ receiptId, ok: true, error: null }));
  }
}

let db: Db;
let push: HeldPush;
let devices: DeviceService;
let service: NotificationService;
let clock: number;
beforeEach(async () => {
  vi.useFakeTimers();
  clock = START;
  db = await createMigratedDb(":memory:");
  push = new HeldPush();
  devices = new DeviceService(db, push, () => new Date(clock));
  const settings = new NotificationSettingsStore(db, defaultsFromCron("30 8 * * 1-5", "0 16 * * 1-5"));
  service = new NotificationService({ devices, push, settings, receiptDelayMs: 60_000, now: () => new Date(clock) });
  await devices.register({ token: TOKEN, platform: "android" });
});
afterEach(async () => { service.stop(); await db.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("3차 알림 영수증 종료·동시성 경계", () => {
  it("확인 도중 종료한 뒤 미완료 응답이 와도 예약이 부활하지 않는다", async () => {
    await service.sendTest();
    const held = deferred<Receipt[]>();
    push.check = () => held.promise;
    const checking = service.checkReceipts();
    expect(push.checked).toEqual([["receipt-1-0"]]);
    service.stop();
    expect(vi.getTimerCount()).toBe(0);
    held.resolve([]);
    await checking;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(push.checked).toHaveLength(1);
    expect(push.sent).toHaveLength(1);
    service.stop();
    expect(await service.checkReceipts()).toEqual({ checked: 0, disabled: 0 });
    expect(push.checked).toHaveLength(1);
  });

  it("종료 뒤 도착한 무효 기기 응답은 닫히는 저장소에 새 비활성화를 시작하지 않는다", async () => {
    await service.sendTest();
    const held = deferred<Receipt[]>();
    push.check = () => held.promise;
    const disable = vi.spyOn(devices, "disable");
    const checking = service.checkReceipts();
    service.stop();
    held.resolve([{ receiptId: "receipt-1-0", ok: false, error: "DeviceNotRegistered" }]);
    await checking;
    expect(disable).not.toHaveBeenCalled();
    expect((await devices.get(TOKEN))?.enabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("발송 대기 중 종료해도 이미 시작한 발송의 응답이 새 영수증 예약을 만들지 않는다", async () => {
    const entered = deferred<void>();
    const held = deferred<void>();
    push.beforeSend = () => { entered.resolve(); return held.promise; };
    const sending = service.sendTest();
    await entered.promise;
    service.stop();
    held.resolve();
    expect(await sending).toMatchObject({ sent: 1, failed: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(push.sent).toHaveLength(1);
    expect(push.checked).toHaveLength(0);
  });

  it.each(["DeviceNotRegistered", "InvalidToken"])("종료 뒤 늦은 발송 오류 %s가 와도 DB 비활성화를 시작하지 않는다", async (error) => {
    const entered = deferred<void>();
    const held = deferred<void>();
    const send = vi.spyOn(push, "send").mockImplementation(async (tokens) => {
      entered.resolve();
      await held.promise;
      return { results: tokens.map((token) => ({ token, ok: false, error, receiptId: null })) };
    });
    const disable = vi.spyOn(devices, "disable");
    const sending = service.sendTest();
    await entered.promise;
    service.stop();
    held.resolve();
    expect(await sending).toEqual({ sent: 0, failed: 1, disabled: [] });
    expect(disable).not.toHaveBeenCalled();
    expect((await devices.get(TOKEN))?.enabled).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("동시 확인과 새 발송이 겹쳐도 각 영수증은 하나의 작업만 소유하고 실패분만 다시 확인한다", async () => {
    await service.sendTest();
    const first = deferred<Receipt[]>();
    const second = deferred<Receipt[]>();
    push.check = (ids) => ids[0] === "receipt-1-0" ? first.promise : second.promise;
    const checkingFirst = service.checkReceipts();
    expect(await service.checkReceipts()).toEqual({ checked: 0, disabled: 0 });
    await service.sendTest();
    const checkingSecond = service.checkReceipts();
    expect(push.checked).toEqual([["receipt-1-0"], ["receipt-2-0"]]);
    second.resolve([{ receiptId: "receipt-2-0", ok: true, error: null }]);
    await checkingSecond;
    first.reject(new Error("검증용 첫 조회 실패"));
    await checkingFirst;
    push.check = undefined;
    expect(await service.checkReceipts()).toEqual({ checked: 1, disabled: 0 });
    expect(push.checked).toEqual([["receipt-1-0"], ["receipt-2-0"], ["receipt-1-0"]]);
    expect(await service.checkReceipts()).toEqual({ checked: 0, disabled: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(push.checked).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(push.sent).toHaveLength(2);
  });

  it("조회 도중 24시간을 넘긴 미완료 영수증만 버리고 새 발송 영수증은 예정대로 확인한다", async () => {
    await service.sendTest();
    clock = START + 24 * 3_600_000 - 1;
    const held = deferred<Receipt[]>();
    push.check = () => held.promise;
    const checking = service.checkReceipts();
    clock++;
    await service.sendTest();
    held.resolve([]);
    await checking;
    push.check = undefined;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(push.checked).toEqual([["receipt-1-0"], ["receipt-2-0"]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(push.sent).toHaveLength(2);
  });
});
