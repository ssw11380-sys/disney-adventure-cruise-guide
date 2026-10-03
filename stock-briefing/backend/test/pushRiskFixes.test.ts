import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import { RECEIPT_LEASE_MS, ReceiptStore } from "../src/notifications/receiptStore.js";
import { DISPATCH_UNCERTAIN_AFTER_MS } from "../src/notifications/pushDispatchStore.js";
import { defaultsFromCron, NotificationSettingsStore } from "../src/notifications/settings.js";
import type { PushSender } from "../src/notifications/push.js";
import { DeviceService } from "../src/services/deviceService.js";
import { NotificationService } from "../src/services/notificationService.js";

const AT = Date.parse("2026-12-28T09:00:00+09:00");
const TOKEN = "ExponentPushToken[risk_test_device]";
const MESSAGE = { title: "검증 알림", body: "동일 저장 결과", data: { type: "briefing", briefingId: 7 } };
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function setup() {
  const db = await createMigratedDb(":memory:");
  let clock = AT;
  const sent: string[][] = [];
  const checked: string[][] = [];
  const push: PushSender = {
    name: "격리 가짜 발송기", isValidToken: () => true,
    async send(tokens) { sent.push(tokens); return { results: tokens.map((token, i) => ({ token, ok: true, error: null, receiptId: `risk-${sent.length}-${i}` })) }; },
    async checkReceipts(ids) { checked.push(ids); return ids.map((receiptId) => ({ receiptId, ok: false, error: "DeviceNotRegistered" })); },
  };
  const devices = new DeviceService(db, push, () => new Date(clock));
  await devices.register({ token: TOKEN, platform: "android" });
  const settings = new NotificationSettingsStore(db, defaultsFromCron("30 8 * * 1-5", "0 16 * * 1-5"));
  const services: NotificationService[] = [];
  const receipts = new ReceiptStore(db);
  const make = (digest = true) => { const service = new NotificationService({ devices, settings, receipts: new ReceiptStore(db), push, features: { enabled: async () => digest }, now: () => new Date(clock), receiptDelayMs: 60_000 }); services.push(service); return service; };
  return { db, receipts, devices, push, sent, checked, make, setClock: (value: number) => { clock = value; }, close: async () => { services.forEach((service) => service.stop()); await db.destroy(); } };
}

describe("발송 전 기록과 영수증 분산 소유권", () => {
  it("같은 논리 발송을 두 서비스가 요청해도 외부 발송은 한 번이며 새 명시적 시험은 유지한다", async () => {
    const env = await setup();
    const entered = barrier(); const release = barrier();
    try {
      const original = env.push.send.bind(env.push);
      vi.spyOn(env.push, "send").mockImplementation(async (tokens, message) => { const result = await original(tokens, message); entered.resolve(); await release.promise; return result; });
      const a = env.make(); const b = env.make();
      const first = a.sendToAll(MESSAGE, "same-event");
      await entered.promise;
      const second = b.sendToAll(MESSAGE, "same-event");
      // 네트워크 응답을 풀기 전에 두 번째 서비스가 발송을 시작하는지 관측한다.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(env.sent).toHaveLength(1);
      release.resolve();
      expect(await first).toEqual({ sent: 1, failed: 0, disabled: [] });
      expect(await second).toEqual({ sent: 0, failed: 0, disabled: [], suppressed: 1 });
      await a.sendTest(); await a.sendTest();
      expect(env.sent).toHaveLength(3);
    } finally { release.resolve(); await env.close(); }
  });

  it("외부 발송 전 기록 실패는 외부 호출을 하지 않고 실패로 전달한다", async () => {
    const env = await setup();
    try {
      await sql`create trigger risk_before_send before insert on meta when NEW.key like 'push-dispatch:%' begin select raise(abort, '격리 기록 실패'); end`.execute(env.db);
      await expect(env.make().sendToAll(MESSAGE, "unsaved")).rejects.toThrow();
      expect(env.sent).toHaveLength(0);
    } finally { await env.close(); }
  });

  it("200개를 넘는 발송 준비의 뒤 배치 실패는 앞 배치 잠금도 롤백한다", async () => {
    const env = await setup();
    try {
      await sql`create trigger risk_batch before insert on meta when NEW.key like 'push-dispatch:%' and (select count(*) from meta where key like 'push-dispatch:%') >= 200 begin select raise(abort, '격리 둘째 배치 실패'); end`.execute(env.db);
      await expect(env.receipts.dispatches.begin("many", Array.from({ length: 201 }, (_, i) => `test-token-${i}`), AT)).rejects.toThrow();
      expect(await env.db.selectFrom("meta").select("key").where("key", "like", "push-dispatch:%").execute()).toEqual([]);
    } finally { await env.close(); }
  });

  it("외부 응답을 잃으면 미확인 상태를 남기며 같은 이벤트를 성공이나 자동 재발송으로 바꾸지 않는다", async () => {
    const env = await setup();
    try {
      vi.spyOn(env.push, "send").mockRejectedValue(new Error("응답 유실"));
      const a = env.make();
      await expect(a.sendToAll(MESSAGE, "unknown")).rejects.toThrow("응답 유실");
      const b = env.make(); await b.resumeReceipts();
      expect(await b.sendToAll(MESSAGE, "unknown")).toEqual({ sent: 0, failed: 0, disabled: [], suppressed: 1 });
      expect(await b.deliveryStatus()).toEqual({ sending: 0, uncertain: 1, accepted: 0, failed: 0, lastUncertainAt: new Date(AT).toISOString() });
      expect(env.push.send).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await b.deliveryStatus())).not.toContain(TOKEN);
    } finally { await env.close(); }
  });

  it("ACK 뒤 영수증 저장 실패·서비스 재시작은 checkpoint로 복구하고 재확인 완료 뒤 되살리지 않는다", async () => {
    const env = await setup();
    try {
      await sql`create trigger risk_receipt_write before insert on meta when NEW.key like 'push-receipt:%' begin select raise(abort, '격리 영수증 기록 실패'); end`.execute(env.db);
      const a = env.make();
      expect(await a.sendToAll(MESSAGE, "checkpoint")).toMatchObject({ sent: 1 });
      expect(await env.receipts.load(AT)).toEqual([]);
      a.stop();
      await sql`drop trigger risk_receipt_write`.execute(env.db);
      const b = env.make(); await b.resumeReceipts();
      expect(await b.checkReceipts()).toEqual({ checked: 1, disabled: 1 });
      b.stop();
      const c = env.make(); await c.resumeReceipts();
      expect(await c.checkReceipts()).toEqual({ checked: 0, disabled: 0 });
      expect(env.sent).toHaveLength(1); expect(env.checked).toHaveLength(1);
      expect(await c.deliveryStatus()).toMatchObject({ accepted: 1, uncertain: 0 });
      const dispatch = await env.db.selectFrom("meta").select("value").where("key", "like", "push-dispatch:%").executeTakeFirstOrThrow();
      expect(dispatch.value).not.toContain(TOKEN);
    } finally { await env.close(); }
  });

  it("ACK checkpoint만 실패해도 영수증 저장에 성공하면 미확인으로 잘못 남기지 않는다", async () => {
    const env = await setup();
    try {
      await sql`create trigger risk_ack_write before update on meta when NEW.key like 'push-dispatch:%' and NEW.value like '%acknowledged%' begin select raise(abort, '격리 ACK 기록 실패'); end`.execute(env.db);
      const a = env.make(); await a.sendToAll(MESSAGE, "ack-failure");
      expect(await a.deliveryStatus()).toMatchObject({ accepted: 1, uncertain: 0 });
      expect(await a.checkReceipts()).toEqual({ checked: 1, disabled: 1 });
      expect(env.sent).toHaveLength(1);
    } finally { await env.close(); }
  });

  it("같은 영수증을 복원한 두 서비스의 동시 확인은 외부 한 번·기기 처리 한 번이다", async () => {
    const env = await setup(); const entered = barrier(); const release = barrier();
    try {
      await env.receipts.save([{ receiptId: "shared", token: TOKEN, receivedAt: AT }]);
      const a = env.make(); const b = env.make();
      await a.resumeReceipts(); await b.resumeReceipts();
      const original = env.push.checkReceipts.bind(env.push);
      vi.spyOn(env.push, "checkReceipts").mockImplementation(async (ids) => { const result = await original(ids); entered.resolve(); await release.promise; return result; });
      const first = a.checkReceipts(); await entered.promise;
      const second = b.checkReceipts();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(env.checked).toHaveLength(1);
      release.resolve();
      expect(await first).toEqual({ checked: 1, disabled: 1 });
      expect(await second).toEqual({ checked: 0, disabled: 0 });
      expect(await b.checkReceipts()).toEqual({ checked: 0, disabled: 0 });
    } finally { release.resolve(); await env.close(); }
  });

  it("처리권 만료·새 소유자 획득 뒤 옛 응답은 기기를 변경하거나 새 기록을 지울 수 없다", async () => {
    const env = await setup();
    try {
      const receipt = { receiptId: "lease", token: TOKEN, receivedAt: AT };
      await env.receipts.save([receipt]);
      const a = (await env.receipts.claim([receipt], AT)).claims[0]!;
      const b = (await new ReceiptStore(env.db).claim([receipt], AT + RECEIPT_LEASE_MS + 1)).claims[0]!;
      expect(b).toBeDefined();
      // 옛 서버의 시계가 뒤처져도 CAS의 소유권 비교가 변경을 거절한다.
      expect(await env.receipts.finish(a, AT + 1, "DeviceNotRegistered")).toEqual({ owned: false, removed: false });
      await env.receipts.release([a]);
      expect((await env.devices.get(TOKEN))?.enabled).toBe(true);
      expect(await env.receipts.finish(b, AT + RECEIPT_LEASE_MS + 2, "DeviceNotRegistered")).toEqual({ owned: true, removed: true });
      expect((await env.devices.get(TOKEN))?.enabled).toBe(false);
    } finally { await env.close(); }
  });

  it("새 소유자가 없어도 만료한 응답은 기기 상태 변경을 중단한다", async () => {
    const env = await setup();
    try {
      const receipt = { receiptId: "expired", token: TOKEN, receivedAt: AT };
      await env.receipts.save([receipt]);
      const claim = (await env.receipts.claim([receipt], AT)).claims[0]!;
      expect(await env.receipts.finish(claim, AT + RECEIPT_LEASE_MS, "DeviceNotRegistered")).toEqual({ owned: false, removed: false });
      expect((await env.devices.get(TOKEN))?.enabled).toBe(true);
    } finally { await env.close(); }
  });

  it("다른 서버의 오래된 ACK 복원 목록은 처리 완료한 영수증을 되살리지 않는다", async () => {
    const env = await setup();
    try {
      const dispatches = env.receipts.dispatches;
      const claims = await dispatches.begin("stale-recovery", [TOKEN], AT);
      await dispatches.checkpoint(claims, [{ token: TOKEN, ok: true, error: null, receiptId: "completed-elsewhere" }], AT);
      const stale = await dispatches.recover(AT);
      await env.receipts.save(stale);
      const claim = (await env.receipts.claim(stale, AT)).claims[0]!;
      expect(await env.receipts.finish(claim, AT + 1)).toMatchObject({ owned: true });
      await new ReceiptStore(env.db).save(stale);
      expect(await env.receipts.load(AT + 2)).toEqual([]);
    } finally { await env.close(); }
  });

  it("트랜잭션 대기 중 처리권이 만료되면 완료 표시와 기기 변경을 함께 롤백한다", async () => {
    const env = await setup();
    try {
      const receipt = { receiptId: "expires-during-db", token: TOKEN, receivedAt: AT };
      await env.receipts.save([receipt]);
      const claim = (await env.receipts.claim([receipt], AT)).claims[0]!;
      let reads = 0;
      await expect(env.receipts.finish(claim, () => ++reads < 3 ? AT : AT + RECEIPT_LEASE_MS, "DeviceNotRegistered")).rejects.toThrow("처리권 만료");
      expect((await env.devices.get(TOKEN))?.enabled).toBe(true);
      expect(await env.receipts.load(AT)).toHaveLength(1);
    } finally { await env.close(); }
  });

  it("제공자가 일부 토큰의 응답을 빠뜨리면 성공 건수에 넣지 않고 미확인으로 남긴다", async () => {
    const env = await setup();
    try {
      vi.spyOn(env.push, "send").mockResolvedValue({ results: [] });
      const service = env.make();
      expect(await service.sendToAll(MESSAGE, "missing-response")).toEqual({ sent: 0, failed: 0, disabled: [], uncertain: 1 });
      expect(await service.deliveryStatus()).toMatchObject({ accepted: 0, uncertain: 1 });
    } finally { await env.close(); }
  });

  it("다른 서버가 오래 걸린 발송을 미확인으로 읽어도 늦은 ACK 저장을 방해하지 않는다", async () => {
    const env = await setup();
    try {
      const claims = await env.receipts.dispatches.begin("slow", [TOKEN], AT);
      expect(await env.receipts.dispatches.status(AT + DISPATCH_UNCERTAIN_AFTER_MS)).toMatchObject({ uncertain: 1, accepted: 0 });
      await env.receipts.dispatches.recover(AT + DISPATCH_UNCERTAIN_AFTER_MS);
      await env.receipts.dispatches.checkpoint(claims, [{ token: TOKEN, ok: true, receiptId: "late", error: null }], AT + DISPATCH_UNCERTAIN_AFTER_MS + 1);
      expect(await env.receipts.dispatches.status(AT + DISPATCH_UNCERTAIN_AFTER_MS + 2)).toMatchObject({ accepted: 1, uncertain: 0 });
    } finally { await env.close(); }
  });

  it("시각·행ID가 같아도 새 force 실행의 알림은 유지하고 동일 실행의 재통지만 억제한다", async () => {
    const env = await setup();
    try {
      const service = env.make();
      const done = { eventId: "force-one", date: "2026-12-28", session: "morning" as const, trigger: "manual" as const, partial: false, force: true,
        created: [{ changeRate: 1, briefing: { id: 7, code: "005930", name: "검증 종목", session: "morning" as const, date: "2026-12-28", status: "ok" as const, summary: "검증 본문", detail: "검증 본문", missing: [], model: "fake", error: null, createdAt: new Date(AT).toISOString() } }] };
      await service.onSession(done); await service.onSession(done);
      await service.onSession({ ...done, eventId: "force-two" });
      expect(env.sent).toHaveLength(2);
    } finally { await env.close(); }
  });

  it("종목별 알림도 실행ID로 재생성을 구분하고 같은 실행의 다른 종목은 막지 않는다", async () => {
    const env = await setup();
    try {
      const service = env.make(false);
      const briefing = { id: 7, code: "005930", name: "검증 종목", session: "morning" as const, date: "2026-12-28", status: "ok" as const, summary: "검증 본문", detail: "검증 본문", missing: [], model: "fake", error: null, createdAt: new Date(AT).toISOString() };
      await service.onBriefing(briefing, "run-one"); await service.onBriefing(briefing, "run-one");
      await service.onBriefing({ ...briefing, id: 8, code: "000660" }, "run-one");
      await service.onBriefing(briefing, "run-two");
      expect(env.sent).toHaveLength(3);
    } finally { await env.close(); }
  });
});
