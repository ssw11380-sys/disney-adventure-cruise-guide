import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import { ReceiptStore, RECEIPT_MAX_AGE_MS } from "../src/notifications/receiptStore.js";
import { NotificationSettingsStore, defaultsFromCron } from "../src/notifications/settings.js";
import { DeviceService } from "../src/services/deviceService.js";
import { NotificationService } from "../src/services/notificationService.js";
import { NoopPushSender } from "./helpers.js";

const AT = new Date("2026-12-28T09:00:00+09:00").getTime();
const TOKEN = "ExponentPushToken[remaining_receipt]";
class Push extends NoopPushSender {
  sends = 0;
  checked: string[][] = [];
  override async send(tokens: string[]) {
    this.sends++;
    return { results: tokens.map((token) => ({ token, ok: true, error: null, receiptId: `receipt-${this.sends}` })) };
  }
  override async checkReceipts(ids: string[]) { this.checked.push(ids); return ids.map((receiptId) => ({ receiptId, ok: false, error: "DeviceNotRegistered" })); }
}
async function setup() {
  const db = await createMigratedDb(":memory:");
  const push = new Push();
  const receipts = new ReceiptStore(db);
  let now = AT;
  const devices = new DeviceService(db, push, () => new Date(now));
  await devices.register({ token: TOKEN, platform: "android" });
  const service = new NotificationService({
    push, devices, receipts, now: () => new Date(now), receiptDelayMs: 60_000,
    settings: new NotificationSettingsStore(db, defaultsFromCron("30 8 * * 1-5", "0 16 * * 1-5")),
  });
  return { db, push, receipts, devices, service, setNow: (value: number) => { now = value; }, async close() { service.stop(); await db.destroy(); } };
}
afterEach(() => vi.useRealTimers());
describe("영수증 영구 저장의 실패·기한·다른 자료 보존", () => {
  it("개별 키를 배치 저장하고 재저장해도 최초 시각·다른 meta를 보존하며 만료·손상 항목만 정리한다", async () => {
    const env = await setup();
    try {
      await env.db.insertInto("meta").values({ key: "notification_settings_custom", value: "원래 자료" }).execute();
      const rows = Array.from({ length: 205 }, (_, i) => ({ receiptId: `batch-${i}`, token: TOKEN, receivedAt: AT }));
      await env.receipts.save(rows);
      await new ReceiptStore(env.db).save([{ ...rows[0]!, receivedAt: AT + 1000 }, { receiptId: "other-server", token: TOKEN, receivedAt: AT + 2000 }]);
      expect(await env.receipts.load(AT + 5000)).toHaveLength(206);
      expect((await env.receipts.load(AT + 5000)).find((r) => r.receiptId === "batch-0")?.receivedAt).toBe(AT);
      await env.db.insertInto("meta").values({ key: "push-receipt:broken", value: "{broken" }).execute();
      expect(await env.receipts.load(AT + RECEIPT_MAX_AGE_MS)).toEqual([{ receiptId: "other-server", token: TOKEN, receivedAt: AT + 2000 }]);
      expect(await env.db.selectFrom("meta").selectAll().where("key", "=", "notification_settings_custom").execute()).toEqual([{ key: "notification_settings_custom", value: "원래 자료" }]);
      expect(await env.receipts.load(AT + RECEIPT_MAX_AGE_MS + 2000)).toEqual([]);
    } finally { await env.close(); }
  });

  it("발송 뒤 저장이 실패해도 발송을 반복하지 않고 다음 영수증 확인에서 기록·처리를 마친다", async () => {
    const env = await setup();
    try {
      await sql`create trigger remaining_receipt_save before insert on meta when NEW.key like 'push-receipt:%' begin select raise(abort, '격리 쓰기 실패'); end`.execute(env.db);
      expect(await env.service.sendTest()).toEqual({ sent: 1, failed: 0, disabled: [] });
      expect(await env.receipts.load(AT)).toEqual([]);
      await sql`drop trigger remaining_receipt_save`.execute(env.db);
      expect(await env.service.checkReceipts()).toEqual({ checked: 1, disabled: 1 });
      expect(env.push.sends).toBe(1);
      expect(await env.receipts.load(AT)).toEqual([]);
    } finally { await env.close(); }
  });

  it("완료 기록 삭제가 실패하면 기존 확인 주기로 정리하고 무관한 meta를 지우지 않는다", async () => {
    vi.useFakeTimers();
    const env = await setup();
    try {
      await env.db.insertInto("meta").values({ key: "other", value: "보존" }).execute();
      await env.service.sendTest();
      await sql`create trigger remaining_receipt_delete before delete on meta when OLD.key like 'push-receipt:%' begin select raise(abort, '격리 삭제 실패'); end`.execute(env.db);
      expect(await env.service.checkReceipts()).toEqual({ checked: 1, disabled: 1 });
      expect(await env.receipts.load(AT)).toHaveLength(1);
      await sql`drop trigger remaining_receipt_delete`.execute(env.db);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await env.receipts.load(AT)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(env.push.sends).toBe(1);
      expect(await env.db.selectFrom("meta").selectAll().where("key", "=", "other").execute()).toEqual([{ key: "other", value: "보존" }]);
    } finally { await env.close(); }
  });

  it("시작 복구 읽기 실패는 다음 기존 주기로 복구하고 stop 뒤 예약을 되살리지 않는다", async () => {
    vi.useFakeTimers();
    const env = await setup();
    try {
      await env.receipts.save([{ receiptId: "recovered", token: TOKEN, receivedAt: AT }]);
      vi.spyOn(env.receipts, "load").mockRejectedValueOnce(new Error("격리 읽기 실패"));
      await env.service.resumeReceipts();
      expect(env.push.checked).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(env.push.checked).toEqual([["recovered"]]);
      expect(env.push.sends).toBe(0);
      env.service.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await env.close(); }
  });
});
