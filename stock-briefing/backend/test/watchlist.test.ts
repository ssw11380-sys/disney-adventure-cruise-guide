import { afterEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { WatchlistService, movementDate, movementLevel } from "../src/services/watchlistService.js";
import { FeatureService } from "../src/services/featureService.js";
import { NotificationSettingsStore, defaultsFromCron } from "../src/notifications/settings.js";
import { NotificationService } from "../src/services/notificationService.js";
import { DeviceService } from "../src/services/deviceService.js";
import { ReceiptStore } from "../src/notifications/receiptStore.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fakeProviders, makeQuote, NoopPushSender } from "./helpers.js";
import type { StockService } from "../src/services/stockService.js";
import type { PushMessage } from "../src/notifications/push.js";

let db: Db;
let notifications: NotificationService | undefined;
afterEach(async () => { await notifications?.stop(); notifications = undefined; await db?.destroy(); });

async function setup() {
  db = await createMigratedDb(":memory:");
  let time = new Date("2026-10-05T10:00:00+09:00");
  const now = () => time;
  const features = new FeatureService(db, now);
  const settings = new NotificationSettingsStore(db, defaultsFromCron("30 8 * * 1-5", "0 16 * * 1-5"));
  const push = new NoopPushSender(), messages: PushMessage[] = [];
  const original = push.send.bind(push);
  push.send = vi.fn(async (tokens, message) => { messages.push(message); return original(tokens, message); });
  const devices = new DeviceService(db, push, now);
  await devices.register({ token: "ExponentPushToken[watch_test]", platform: "android", deviceName: null });
  notifications = new NotificationService({ devices, push, settings, receipts: new ReceiptStore(db), now });
  const q = { ...makeQuote("005930", "test", 100), prevClose: 100, asOf: now().toISOString(), session: { open: true, eligible: true } } as ReturnType<typeof makeQuote>;
  const stocks = { get: vi.fn(async () => null), preview: vi.fn(async (code: string) => ({ code, name: "테스트", market: /^\d/.test(code) ? "KOSPI" : "US" })),
    getQuote: vi.fn(async () => q), quotesFor: vi.fn(async (codes: string[]) => new Map(codes.map(code => [code, q]))), list: vi.fn(async () => [{ code: "005930", name: "보유", quantity: 1 }]) } as unknown as StockService;
  const deps = { db, features, stocks, notifications, settings, now, warn: vi.fn() };
  return { service: new WatchlistService(deps), another: () => new WatchlistService(deps), features, settings, stocks, q, messages, setTime: (s: string) => { time = new Date(s); q.asOf = time.toISOString(); } };
}

describe("관심 가격과 5% 구간", () => {
  it("정확한 경계·음수 방향·부동소수 가격을 계산한다", () => {
    expect(movementLevel(104.99, 100)).toBe(0); expect(movementLevel(105, 100)).toBe(5);
    expect(movementLevel(115, 100)).toBe(15); expect(movementLevel(95, 100)).toBe(-5);
    expect(movementLevel(85, 100)).toBe(-15); expect(movementLevel(1.155, 1.1)).toBe(5);
    expect(movementLevel(NaN, 100)).toBe(0); expect(movementLevel(105, 0)).toBe(0);
  });
  it("관심 CRUD는 보유 수량·평단·보고서에 쓰지 않는다", async () => {
    const h = await setup();
    await h.service.save("005930", { startPrice: 100, desiredPrice: 80, alerts: true });
    expect(await h.service.list(false)).toMatchObject([{ code: "005930", startPrice: 100, desiredPrice: 80 }]);
    const first = await db.selectFrom("watch_items").selectAll().executeTakeFirstOrThrow();
    await h.service.save("005930", { startPrice: 100, desiredPrice: 85, alerts: false });
    expect((await db.selectFrom("watch_items").selectAll().executeTakeFirstOrThrow()).revision).toBe(first.revision);
    await h.service.save("005930", { startPrice: 110, desiredPrice: 85, alerts: true });
    expect((await db.selectFrom("watch_items").selectAll().executeTakeFirstOrThrow()).revision).not.toBe(first.revision);
    await h.service.remove("005930"); expect(await h.service.list()).toEqual([]);
    expect(await db.selectFrom("registered_stocks").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("briefings").selectAll().execute()).toEqual([]);
  });
  it("잔고 전일 종가 기준 양방향 새 구간만 보내며 반복·재시작·인스턴스 중복을 막는다", async () => {
    const h = await setup(); h.q.price = 105;
    await Promise.all([h.service.check(), h.service.check(), h.another().check()]);
    expect(h.messages).toHaveLength(1); expect(h.messages[0]?.data).toMatchObject({ scope: "holding", level: 5, basis: 100 });
    h.q.price = 115; await h.service.check(); expect(h.messages).toHaveLength(2); expect(h.messages[1]?.data?.level).toBe(15);
    h.q.price = 110; await h.service.check(); h.q.price = 115; await h.another().check(); expect(h.messages).toHaveLength(2);
    h.q.price = 95; await h.service.check(); expect(h.messages[2]?.data?.level).toBe(-5);
    h.setTime("2026-10-06T10:00:00+09:00"); h.q.price = 105; await h.service.check(); expect(h.messages).toHaveLength(4);
  });
  it("관심 구간은 날짜가 바뀌어도 기억하고 시작 가격 변경에만 새로 시작한다", async () => {
    const h = await setup(); await h.service.setSettings(false);
    await h.service.save("005930", { startPrice: 100, desiredPrice: 80, alerts: true });
    h.q.price = 115; await h.service.check(); expect(h.messages).toHaveLength(1);
    h.setTime("2026-10-06T10:00:00+09:00"); await h.another().check(); expect(h.messages).toHaveLength(1);
    await h.service.save("005930", { startPrice: 110, desiredPrice: 80, alerts: true });
    h.q.price = 121; await h.service.check(); expect(h.messages).toHaveLength(2); expect(h.messages[1]?.data?.level).toBe(10);
  });
  it("지연·장 종료·거래일 경계가 지난 시세와 전일 종가 없는 잔고는 보내지 않는다", async () => {
    const h = await setup(); h.q.price = 110;
    h.q.stale = true; await h.service.check(); delete h.q.stale;
    h.q.asOf = "2026-10-05T09:50:00+09:00"; await h.service.check(); h.q.asOf = "2026-10-05T10:00:00+09:00";
    h.q.session!.open = false; await h.service.check(); h.q.session!.open = true;
    h.q.prevClose = null; await h.service.check(); expect(h.messages).toHaveLength(0);
    expect(movementDate(h.q, new Date("2026-10-05T09:00:00+09:00"))).toBeNull();
  });
  it("끄면 조회·발송을 멈추고 관심 삭제 후 감시하지 않는다", async () => {
    const h = await setup(); h.q.price = 110;
    await h.features.set({ watchlistSteps: false }); await h.service.check(); expect(h.stocks.quotesFor).not.toHaveBeenCalled();
    await h.features.set({ watchlistSteps: true }); await h.service.setSettings(false); await h.service.check(); expect(h.messages).toHaveLength(0);
    await h.service.save("005930", { startPrice: 100, desiredPrice: 80, alerts: false }); await h.service.check(); expect(h.messages).toHaveLength(0);
    await h.service.remove("005930"); await h.service.check(); expect(h.messages).toHaveLength(0);
  });
  it("미국 자정은 거래일을 바꾸지 않고 다음 거래일에 잔고 구간을 다시 알린다", async () => {
    const h = await setup(); h.q.code = "AAPL"; h.q.currency = "USD";
    vi.mocked(h.stocks.list).mockResolvedValue([{ code: "AAPL", name: "애플", quantity: 1 }] as never);
    h.q.price = 105; h.setTime("2026-10-05T23:30:00+09:00"); await h.service.check();
    h.setTime("2026-10-06T00:30:00+09:00"); await h.service.check(); expect(h.messages).toHaveLength(1);
    h.setTime("2026-10-06T23:30:00+09:00"); await h.service.check(); expect(h.messages).toHaveLength(2);
  });
  it("푸시 기기가 없어도 사건을 보존하며 다시 확인해도 복제하지 않는다", async () => {
    const h = await setup(); await db.deleteFrom("devices").execute(); h.q.price = 110;
    await h.service.check(); await h.another().check();
    expect(h.messages).toHaveLength(0);
    expect((await h.service.events()).events).toHaveLength(1);
    expect((await h.service.events()).events[0]?.data).toMatchObject({ level: 10, scope: "holding" });
    await h.service.setSettings(false); expect((await h.service.events()).events).toHaveLength(0);
  });
  it("API는 인증·통화 입력·플래그를 검증하고 잘못된 가격을 저장하지 않는다", async () => {
    db = await createMigratedDb(":memory:");
    const app = await buildApp({ db, config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN: "unit-test-only" }), providers: fakeProviders(), enableScheduler: false, logger: false });
    try {
      const headers = { authorization: "Bearer unit-test-only" };
      await app.stockService.refreshMaster();
      expect((await app.inject({ url: "/api/watchlist" })).statusCode).toBe(401);
      expect((await app.inject({ method: "PUT", url: "/api/watchlist/005930", headers, payload: { startPrice: 10.5, desiredPrice: 9, alerts: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/watchlist/AAPL", headers, payload: { startPrice: 100.001, desiredPrice: 90, alerts: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/watchlist/005930", headers, payload: { startPrice: 100, desiredPrice: 90, alerts: true } })).statusCode).toBe(200);
      expect((await app.inject({ url: "/api/stocks", headers })).json()).toEqual([]);
      await new FeatureService(db).set({ watchlistSteps: false });
      // 앱의 플래그 인스턴스를 통해 바꿔 즉시 반영한다.
      await app.inject({ method: "PUT", url: "/api/admin/features", headers, payload: { watchlistSteps: false } });
      expect((await app.inject({ url: "/api/watchlist", headers })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
