import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { FEATURES } from "../src/services/featureService.js";
import { fakeProviders, FakeGenerator } from "./helpers.js";

/**
 * 위젯 2차: 폴드 위젯 크기 맞추기 (플래그 widgetFoldFit — 넓은 모습은 위젯 폭 560dp 이상만). 앱만 쓰는 기능이라 서버는 /api/widget 의 features 칸으로 전하기만 한다.
 * widgetFoldFit 을 끄면 features 에 false — 앱은 예전 폭 기준 그대로 (app/test/widgetFold.test.tsx).
 * 한때 있던 widgetFoldBoth(두 화면에 들어가는 카드)는 뺐다 — 응답에도 없다
 */
describe("GET /api/widget: widgetFoldFit 은 features 칸으로만 전한다", () => {
  let db: Db | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const start = async () => {
    db = await createMigratedDb(":memory:");
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: new FakeGenerator() }), logger: false, enableScheduler: false });
  };
  const get = async (url: string) => (await app!.inject({ method: "GET", url })).json();
  afterEach(async () => {
    await app?.close();
    await db?.destroy();
    app = undefined;
    db = undefined;
  });

  it("기본값은 켜짐, 끄면 false — 응답의 다른 칸은 그대로", async () => {
    expect(FEATURES.widgetFoldFit.default).toBe(true);
    expect(FEATURES.widgetFoldFit.description).toMatch(/560dp/);
    await start();
    const urls = ["/api/widget", "/api/widget?indices=1&sessions=1&ui=2", "/api/widget?indices=1&sessions=1&ui=2&board=1"];
    const on = await Promise.all(urls.map(get));
    await app!.inject({ method: "PUT", url: "/api/admin/features", payload: { widgetFoldFit: false } });
    const off = await Promise.all(urls.map(get));
    urls.forEach((url, i) => {
      expect(on[i].features.widgetFoldFit, url).toBe(true);
      expect(off[i].features.widgetFoldFit, url).toBe(false);
      const strip = (b: { features: Record<string, boolean> }) => ({ ...b, features: { ...b.features, widgetFoldFit: null } });
      expect(strip(off[i]), url).toEqual(strip(on[i]));
    });
  });

  it("widgetFoldBoth 는 없다 (플래그 목록·위젯 응답 모두)", async () => {
    expect(Object.keys(FEATURES)).not.toContain("widgetFoldBoth");
    await start();
    const body = await get("/api/widget?indices=1&sessions=1&ui=2&board=1");
    expect(Object.keys(body.features)).not.toContain("widgetFoldBoth");
    expect(Object.keys((await get("/api/features")).features)).not.toContain("widgetFoldBoth");
  });
});
