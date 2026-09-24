import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { buildDigest, byMove, inQuietHours } from "../src/notifications/digest.js";
import type { PushMessage, PushSender, PushSendResult } from "../src/notifications/push.js";
import { FakeGenerator, fakeProviders } from "./helpers.js";

class FakePush implements PushSender {
  readonly name = "fake-push";
  sent: PushMessage[] = [];
  isValidToken(token: string): boolean {
    return token.startsWith("ExponentPushToken[");
  }
  async send(tokens: string[], message: PushMessage): Promise<PushSendResult> {
    this.sent.push(message);
    return { results: tokens.map((token) => ({ token, ok: true, error: null, receiptId: null })) };
  }
  async checkReceipts() {
    return [];
  }
}

const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const item = (code: string, name: string, changeRate: number | null, id = 1) => ({ briefingId: id, code, name, summary: `${name} 요약 첫 줄\n둘째 줄`, changeRate });

describe("브리핑 알림 묶음 (3-19)", () => {
  it("조용한 시간: 자정을 넘는 구간, 끄면 없음, 시작=끝이면 없음 (한국 시간)", () => {
    const q = { quietEnabled: true, quietStart: "22:00", quietEnd: "07:00" };
    expect(inQuietHours(q, new Date("2026-09-22T21:59:00+09:00"))).toBe(false);
    expect(inQuietHours(q, new Date("2026-09-22T22:00:00+09:00"))).toBe(true);
    expect(inQuietHours(q, new Date("2026-09-23T03:00:00+09:00"))).toBe(true);
    expect(inQuietHours(q, new Date("2026-09-23T07:00:00+09:00"))).toBe(false);
    expect(inQuietHours({ ...q, quietEnabled: false }, new Date("2026-09-23T03:00:00+09:00"))).toBe(false);
    expect(inQuietHours({ ...q, quietStart: "12:00", quietEnd: "13:00" }, new Date("2026-09-22T12:30:00+09:00"))).toBe(true);
    expect(inQuietHours({ ...q, quietStart: "12:00", quietEnd: "12:00" }, new Date("2026-09-22T12:00:00+09:00"))).toBe(false);
  });

  it("여러 종목은 1건: 종목 수와 변동 상위 2개, 1종목이면 예전 문구", () => {
    const m = buildDigest("afternoon", "2026-09-22", [item("A", "가", 1.2, 1), item("B", "나", -4.5, 2), item("C", "다", null, 3), item("D", "라", 3.01, 4)])!;
    expect(m.title).toBe("오후 브리핑 4종목");
    expect(m.body).toBe("변동 상위 나 -4.50% · 라 +3.01%\n나: 나 요약 첫 줄");
    expect(m.data).toMatchObject({ type: "briefingDigest", session: "afternoon", count: 4, briefingId: 2 });
    const one = buildDigest("morning", "2026-09-22", [item("A", "가", 1.2, 7)])!;
    expect(one).toMatchObject({ title: "가 오전 브리핑", body: "가 요약 첫 줄\n둘째 줄", data: { type: "briefing", briefingId: 7 } });
    expect(buildDigest("morning", "2026-09-22", [])).toBeNull();
    expect(byMove([item("A", "가", null), item("B", "나", -0.1)]).map((i) => i.code)).toEqual(["B", "A"]);
  });

  describe("서버에서", () => {
    let app: FastifyInstance;
    let db: Db;
    afterEach(async () => {
      await app.close();
      await db.destroy();
    });
    const setup = async (at: string) => {
      db = await createMigratedDb(":memory:");
      const push = new FakePush();
      app = await buildApp({
        config: loadConfig({ DATABASE_URL: ":memory:" }),
        db,
        providers: fakeProviders({ push, generator: new FakeGenerator() }),
        logger: false,
        receiptDelayMs: 0,
        now: () => new Date(at),
      });
      await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
      for (const code of ["000660", "005930", "247540"]) await app.inject({ method: "POST", url: "/api/stocks", payload: { code } });
      await app.inject({ method: "POST", url: "/api/devices", payload: { token: TOKEN, platform: "android" } });
      return push;
    };

    it("세션 한 번에 알림 1건(지금은 종목마다 1건이던 것), 끈 종목은 빼고 센다", async () => {
      const push = await setup("2026-09-22T16:00:00+09:00");
      await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon" } });
      expect(push.sent).toHaveLength(1);
      expect(push.sent[0]!.title).toBe("오후 브리핑 3종목");
      expect(push.sent[0]!.body).toMatch(/^변동 상위 .+ \+1\.01% · .+ \+1\.01%/);

      const put = await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { mutedCodes: ["005930", " 247540"] } });
      expect(put.json()).toMatchObject({ mutedCodes: ["005930", "247540"], digest: true, quietEnabled: true, quietStart: "22:00", quietEnd: "07:00" });
      await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", force: true } });
      expect(push.sent).toHaveLength(2);
      expect(push.sent[1]!.title).toBe("SK하이닉스 오후 브리핑"); // 남은 1종목은 예전 문구

      await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { mutedCodes: ["000660", "005930", "247540"] } });
      await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", force: true } });
      expect(push.sent).toHaveLength(2); // 모두 끈 종목 → 0건
    });

    it("조용한 시간에는 0건, 조용한 시간을 끄면 보낸다", async () => {
      const push = await setup("2026-09-22T23:30:00+09:00");
      await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon" } });
      expect(push.sent).toHaveLength(0);
      const list = (await app.inject({ method: "GET", url: "/api/briefings/latest" })).json() as Array<{ latest: unknown }>;
      expect(list.every((l) => l.latest)).toBe(true); // 브리핑은 그대로 만든다
      await app.inject({ method: "PUT", url: "/api/notifications/settings", payload: { quietEnabled: false } });
      await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", force: true } });
      expect(push.sent).toHaveLength(1);
    });

    it("briefingDigest 플래그를 끄면 예전처럼 종목마다 1건", async () => {
      const push = await setup("2026-09-22T16:00:00+09:00");
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingDigest: false } });
      expect((await app.inject({ method: "GET", url: "/api/notifications/settings" })).json()).toMatchObject({ digest: false });
      await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon" } });
      expect(push.sent.map((m) => m.title).sort()).toEqual(["SK하이닉스 오후 브리핑", "삼성전자 오후 브리핑", "에코프로비엠 오후 브리핑"]);
    });
  });
});
