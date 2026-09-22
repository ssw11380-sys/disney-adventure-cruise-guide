import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { PushMessage, PushSender, PushSendResult } from "../src/notifications/push.js";
import { defaultsFromCron, timeToCron } from "../src/notifications/settings.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

class FakePushSender implements PushSender {
  readonly name = "fake-push";
  sent: Array<{ tokens: string[]; message: PushMessage }> = [];
  failTokens = new Map<string, string>(); // token → error
  receiptErrors = new Map<string, string>(); // receiptId → error
  isValidToken(token: string): boolean {
    return /^ExponentPushToken\[[A-Za-z0-9_-]+\]$/.test(token);
  }
  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    this.sent.push({ tokens, message });
    return {
      results: tokens.map((token) => {
        const err = this.failTokens.get(token);
        return err ? { token, ok: false, error: err, receiptId: null } : { token, ok: true, error: null, receiptId: `r-${token}` };
      }),
    };
  }
  async checkReceipts(receiptIds: string[]) {
    return receiptIds.map((receiptId) => {
      const err = this.receiptErrors.get(receiptId);
      return { receiptId, ok: !err, error: err ?? null };
    });
  }
}

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

describe("notification settings helpers", () => {
  it("cron 에서 기본 시간을 뽑고 다시 cron 으로 만든다", () => {
    const d = defaultsFromCron("30 8 * * 1-5", "0 16 * * 1-5");
    expect(d).toMatchObject({ morningTime: "08:30", afternoonTime: "16:00", weekdaysOnly: true, pushEnabled: true });
    expect(timeToCron("08:30", true)).toBe("30 8 * * 1-5");
    expect(timeToCron("16:05", false)).toBe("5 16 * * *");
    expect(defaultsFromCron("garbage", "0 16 * * *")).toMatchObject({ morningTime: "08:30", weekdaysOnly: false });
  });
});

describe("devices, settings and push", () => {
  let app: FastifyInstance;
  let db: Db;
  let push: FakePushSender;
  let gen: FakeGenerator;

  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    push = new FakePushSender();
    gen = new FakeGenerator();
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ push, generator: gen }),
      logger: false,
      enableScheduler: true,
      receiptDelayMs: 0,
      now: () => new Date("2026-09-22T00:00:00+09:00"),
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660", quantity: 10, avgPrice: 150_000 } });
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it("기기 등록/목록/삭제, 잘못된 토큰은 400", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/devices", payload: { token: "not-a-token-at-all", platform: "android" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("INVALID_TOKEN");

    const ok = await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN_A, platform: "android", deviceName: "Pixel" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ token: TOKEN_A, platform: "android", deviceName: "Pixel", enabled: true });

    // 같은 토큰 재등록은 갱신
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN_A, platform: "android" } });
    expect((await app.inject({ method: "GET", url: "/api/devices" })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/health" })).json().devices).toBe(1);

    const del = await app.inject({ method: "DELETE", url: `/api/devices/${encodeURIComponent(TOKEN_A)}` });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/devices/${encodeURIComponent(TOKEN_A)}` })).statusCode).toBe(404);
  });

  it("브리핑이 생성되면 등록된 기기 전체에 요약이 푸시된다 (실패 건은 제외)", async () => {
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN_A, platform: "android" } });
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN_B, platform: "android" } });
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } });
    expect(push.sent).toHaveLength(1);
    const [m] = push.sent;
    expect(m!.tokens.sort()).toEqual([TOKEN_A, TOKEN_B]);
    expect(m!.message.title).toBe("SK하이닉스 오전 브리핑");
    expect(m!.message.body).toBe("주가 100,000원 (+1.01%)\n뉴스 요약 한 줄\n내일 체크포인트");
    expect(m!.message.data).toMatchObject({ type: "briefing", code: "000660", session: "morning", date: "2026-09-22" });
    expect(typeof m!.message.data!["briefingId"]).toBe("number");

    gen.opts.failKind = "api";
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon" } });
    expect(push.sent).toHaveLength(1);
  });

  it("pushEnabled=false 면 보내지 않는다", async () => {
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN_A, platform: "android" } });
    await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { pushEnabled: false } });
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } });
    expect(push.sent).toHaveLength(0);
  });

  it("DeviceNotRegistered 티켓/영수증은 기기를 비활성화한다", async () => {
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN_A, platform: "android" } });
    await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN_B, platform: "android" } });
    push.failTokens.set(TOKEN_A, "DeviceNotRegistered");
    push.receiptErrors.set(`r-${TOKEN_B}`, "DeviceNotRegistered");

    const res = await app.inject({ method: "POST", url: "/api/notifications/test" });
    expect(res.json()).toMatchObject({ sent: 1, failed: 1, disabled: [TOKEN_A] });

    const receipts = await app.inject({ method: "POST", url: "/api/notifications/receipts" });
    expect(receipts.json()).toEqual({ checked: 1, disabled: 1 });

    const devices = (await app.inject({ method: "GET", url: "/api/devices" })).json();
    expect(devices.every((d: { enabled: boolean; disabledReason: string }) => !d.enabled && d.disabledReason === "DeviceNotRegistered")).toBe(true);

    // 비활성 기기에는 더 보내지 않는다
    const none = await app.inject({ method: "POST", url: "/api/notifications/test" });
    expect(none.statusCode).toBe(409);
  });

  it("알림 시간 설정을 바꾸면 스케줄이 즉시 바뀌고 재시작 후에도 유지된다", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/notifications/settings" })).json();
    expect(before).toMatchObject({ morningTime: "08:30", afternoonTime: "16:00", weekdaysOnly: true });
    expect(before.schedule.jobs.map((j: { cron: string }) => j.cron)).toEqual(["30 8 * * 1-5", "0 16 * * 1-5"]);

    const bad = await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { morningTime: "25:00" } });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { morningTime: "07:45", afternoonEnabled: false, weekdaysOnly: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule.jobs).toEqual([expect.objectContaining({ session: "morning", cron: "45 7 * * *" })]);

    // 새 앱 인스턴스가 같은 DB 로 뜨면 저장된 설정으로 스케줄한다
    const app2 = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ push }), logger: false });
    const h = (await app2.inject({ method: "GET", url: "/health" })).json();
    expect(h.schedule.jobs).toEqual([expect.objectContaining({ session: "morning", cron: "45 7 * * *" })]);
    await app2.close();
  });
});
