import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb } from "../src/db/index.js";
import { TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
import { FeatureService } from "../src/services/featureService.js";
import { reconcileAfterSync } from "../src/services/reconcileAfterSync.js";
import type { ImportResult } from "../src/services/tossSyncService.js";
import { fakeProviders } from "./helpers.js";
import { client, NOW } from "./tossFake.js";

describe("기능 켜고 끄기 (3-15)", () => {
  it("플래그 목록을 주고, 관리 API 로 바꾸면 바로 반영되며, tossReconcile 을 끄면 상태에서도 대조가 빠진다", async () => {
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ tossOpenApi: new TossOpenApiProvider(client(), { now: NOW }) }),
      logger: false,
      enableScheduler: false,
      now: NOW,
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/features" })).json()).toEqual({ features: { tossReconcile: true, briefingSources: true, briefingDigest: true, briefingTabMovers: true, briefingManualRun: true, widgetPnlToggle: true, widgetIndexLine: true }, updatedAt: null });
      const history = async () => ((await app.inject({ method: "GET", url: "/api/admin/toss/reconcile" })).json() as { history: unknown[] }).history.length;
      expect((await app.inject({ method: "POST", url: "/api/admin/toss/import-holdings" })).statusCode).toBe(200);
      await vi.waitFor(async () => expect(await history()).toBe(1)); // 대조는 동기화를 기다리지 않고 뒤에서 돈다
      expect((await app.inject({ method: "GET", url: "/api/admin/toss/status" })).json().reconcile).not.toBeNull();

      const put = await app.inject({ method: "PUT", url: "/api/admin/features", payload: { tossReconcile: false } });
      expect(put.json()).toMatchObject({ features: { tossReconcile: false, briefingSources: true } });
      expect((await app.inject({ method: "GET", url: "/api/features" })).json().features.tossReconcile).toBe(false);
      // 꺼져 있으면 예전 앱 빌드에도 옛 경고를 주지 않는다
      expect((await app.inject({ method: "GET", url: "/api/admin/toss/status" })).json().reconcile).toBeNull();
      expect((await app.inject({ method: "GET", url: "/health" })).json().tossOpenApi?.reconcile ?? null).toBeNull();

      // null 이면 기본값으로, 모르는 키·잘못된 값은 400
      expect((await app.inject({ method: "PUT", url: "/api/admin/features", payload: { tossReconcile: null } })).json().features.tossReconcile).toBe(true);
      expect((await app.inject({ method: "PUT", url: "/api/admin/features", payload: { nope: true } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/admin/features", payload: { tossReconcile: "yes" } })).statusCode).toBe(400);
      const detail = (await app.inject({ method: "GET", url: "/api/admin/features" })).json().features;
      expect(detail.find((f: { key: string }) => f.key === "tossReconcile")).toMatchObject({ enabled: true, default: true, overridden: false });
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  it("동기화 뒤 대조: 끄면 시세 조회·기록 0건, 켜면 1건 (타이밍과 무관하게 직접 확인)", async () => {
    const db = await createMigratedDb(":memory:");
    const features = new FeatureService(db, NOW);
    const calls = { list: 0, record: 0 };
    const handler = reconcileAfterSync({
      features,
      reconcile: { record: async () => void calls.record++ } as never,
      stocks: { listWithFreshQuotes: async () => (calls.list++, []) },
    });
    const r = { excluded: [], holdings: [{ code: "005930", currency: "KRW", quantity: 1, marketValueAfterCost: 1 }] } as unknown as ImportResult;
    await features.set({ tossReconcile: false });
    await handler(r);
    expect(calls).toEqual({ list: 0, record: 0 });
    await features.set({ tossReconcile: true });
    await handler(r);
    expect(calls).toEqual({ list: 1, record: 1 });
    await db.destroy();
  });

  it("바꾼 값은 DB 에 남아 재시작 뒤에도 유지, 지운 플래그의 옛 값은 무시, 동시 변경도 둘 다 남는다", async () => {
    const db = await createMigratedDb(":memory:");
    const a = new FeatureService(db, NOW);
    await Promise.all([a.set({ tossReconcile: false }), a.set({ briefingSources: false })]);
    expect((await new FeatureService(db, NOW).all()).features).toMatchObject({ tossReconcile: false, briefingSources: false });
    await db.updateTable("meta").set({ value: JSON.stringify({ overrides: { briefingSources: false, removedFlag: true }, updatedAt: "x" }) }).where("key", "=", "features").execute();
    const b = new FeatureService(db, NOW);
    expect((await b.all()).features).toEqual({ tossReconcile: true, briefingSources: false, briefingDigest: true, briefingTabMovers: true, briefingManualRun: true, widgetPnlToggle: true, widgetIndexLine: true });
    await db.destroy();
  });

  it("다른 인스턴스가 바꾼 값도 30초 안에 따라가고, DB 를 못 읽으면 꺼짐으로 본다", async () => {
    const db = await createMigratedDb(":memory:");
    let t = NOW().getTime();
    const one = new FeatureService(db, () => new Date(t));
    const two = new FeatureService(db, () => new Date(t));
    expect(await two.enabled("tossReconcile")).toBe(true);
    await one.set({ tossReconcile: false });
    t += 31_000;
    expect(await two.enabled("tossReconcile")).toBe(false);
    const broken = new FeatureService({ selectFrom: () => { throw new Error("db down"); } } as never, NOW);
    expect(await broken.enabled("tossReconcile")).toBe(false);
    await db.destroy();
  });
});
