/** 제품의 푸시·영수증 서비스만 별도 OS 프로세스에서 실행한다. 외부 네트워크는 금지한다. */
import { createDb } from "../../src/db/index.js";
import { DeviceService } from "../../src/services/deviceService.js";
import { NotificationSettingsStore, defaultsFromCron } from "../../src/notifications/settings.js";
import type { PushSender } from "../../src/notifications/push.js";

const database = process.env["RISK_PUSH_DATABASE"];
if (!database || !process.send) throw new Error("격리 검증 전용 프로세스입니다");
const { NotificationService } = await import(process.env["RISK_NOTIFICATION_MODULE"] ?? "../../src/services/notificationService.js");
const { ReceiptStore } = await import(process.env["RISK_RECEIPT_MODULE"] ?? "../../src/notifications/receiptStore.js");
globalThis.fetch = async () => { throw new Error("검증 중 외부 HTTP 금지"); };
const event = (type: string, data: object = {}) => process.send?.({ type, ...data });
let clock = Date.parse("2026-12-28T09:00:00+09:00");
let releaseSend!: () => void; let releaseCheck!: () => void;
const sendBarrier = new Promise<void>((resolve) => { releaseSend = resolve; });
const checkBarrier = new Promise<void>((resolve) => { releaseCheck = resolve; });
if (process.env["RISK_HOLD_SEND"] !== "1") releaseSend();
if (process.env["RISK_HOLD_CHECK"] !== "1") releaseCheck();
const push: PushSender = {
  name: "별도 프로세스 가짜 푸시", isValidToken: () => true,
  async send(tokens) {
    event("send", { count: tokens.length });
    await sendBarrier;
    return { results: tokens.map((token, i) => ({ token, ok: true, error: null, receiptId: `risk-process-${process.pid}-${i}` })) };
  },
  async checkReceipts(ids) {
    event("check", { count: ids.length });
    await checkBarrier;
    return ids.map((receiptId) => ({ receiptId, ok: false, error: "DeviceNotRegistered" }));
  },
};
const db = createDb(database).db;
const devices = new DeviceService(db, push, () => new Date(clock));
const service = new NotificationService({
  push, devices, receipts: new ReceiptStore(db),
  settings: new NotificationSettingsStore(db, defaultsFromCron("30 8 * * 1-5", "0 16 * * 1-5")),
  receiptDelayMs: 60_000, now: () => new Date(clock),
});
await service.resumeReceipts();
process.on("message", (message: { command: string; id: string; advance?: number; eventId?: string }) => {
  if (message.command === "release-send") { releaseSend(); return; }
  if (message.command === "release-check") { releaseCheck(); return; }
  void (async () => {
    let result: unknown;
    switch (message.command) {
      case "send": result = await service.sendToAll({ title: "격리 발송", body: "시험 자료", data: { type: "briefing", briefingId: 1 } }, message.eventId ?? "shared-event"); break;
      case "check": result = await service.checkReceipts(); break;
      case "status": result = await service.deliveryStatus(); break;
      case "advance": clock += message.advance ?? 0; break;
      default: throw new Error("알 수 없는 검증 명령");
    }
    event("result", { id: message.id, result });
  })().catch((error: unknown) => event("result", { id: message.id, error: error instanceof Error ? error.message : String(error) }));
});
event("ready");
