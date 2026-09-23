import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { AppErrorService, fingerprint, scrub } from "../src/services/appErrorService.js";
import { fakeProviders } from "./helpers.js";

const AUTH = { authorization: "Bearer secret-123" };

describe("앱 오류 수집 API", () => {
  let app: FastifyInstance;
  let db: Db;
  let clock = new Date("2026-09-24T10:00:00+09:00");

  beforeEach(async () => {
    clock = new Date("2026-09-24T10:00:00+09:00");
    db = await createMigratedDb(":memory:");
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN: "secret-123" }), db, providers: fakeProviders(), logger: false, enableScheduler: false, now: () => clock });
  });
  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  const post = (payload: unknown, headers: Record<string, string> = AUTH) => app.inject({ method: "POST", url: "/api/app-errors", payload: payload as object, headers });

  it("토큰 없이는 보낼 수도 볼 수도 없다", async () => {
    expect((await post({ kind: "js", message: "x" }, {})).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/app-errors" })).statusCode).toBe(401);
  });

  it("한 건 저장 → 관리 API 에서 숫자로 조회", async () => {
    const r = await post({ kind: "fatal", message: "TypeError: undefined is not an object", stack: "at render (index.bundle:1:2345)", screen: "/stocks/005930", appVersion: "1.3.0", updateId: "abc", platform: "android" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ saved: 1, dropped: 0 });
    const s = (await app.inject({ method: "GET", url: "/api/admin/app-errors?days=7", headers: AUTH })).json();
    expect(s.total).toBe(1);
    expect(s.fatal).toBe(1);
    expect(s.byDay).toHaveLength(7);
    expect(s.byDay.at(-1)).toEqual({ date: "2026-09-24", count: 1 });
    expect(s.top[0]).toMatchObject({ kind: "fatal", count: 1, screen: "/stocks/005930", updateId: "abc" });
  });

  it("여러 건을 한 번에 (앱이 켜질 때 못 보낸 것)", async () => {
    const r = await post({ errors: [{ kind: "js", message: "a" }, { kind: "js", message: "a" }, { kind: "render", message: "b" }] });
    expect(r.json().saved).toBe(3);
    const s = (await app.inject({ method: "GET", url: "/api/admin/app-errors", headers: AUTH })).json();
    expect(s.total).toBe(3);
    expect(s.top[0].count).toBe(2); // 같은 오류는 묶인다
    expect(s.byKind).toEqual({ js: 2, render: 1 });
  });

  it("토큰·계좌 금액은 저장하지 않는다", async () => {
    await post({
      kind: "js",
      message: "fetch failed Bearer abc.def-123 at ?token=f00dcafe12abcd&x=1, 평가금액 75,857,144원, $52,669.59, 수량 1234",
      stack: "Error\n    at https://x/api/stream?token=zzz (bundle:10:20)\n    at key=sk-ant-api03-SECRET",
    });
    const row = await db.selectFrom("app_errors").selectAll().executeTakeFirstOrThrow();
    const all = `${row.message}\n${row.stack}`;
    for (const bad of ["abc.def-123", "f00dcafe", "75,857,144", "52,669", "zzz", "sk-ant", "SECRET", "1234"]) expect(all, bad).not.toContain(bad);
    expect(row.message).toContain("Bearer [지움]");
    expect(row.stack).toContain("bundle:10:20"); // 스택의 줄·열 번호는 남긴다
  });

  it("분당 30건을 넘으면 버린다 (다음 분에는 다시 받음)", async () => {
    const batch = { errors: Array.from({ length: 20 }, (_, i) => ({ kind: "js", message: `e${i}` })) };
    expect((await post(batch)).json()).toEqual({ saved: 20, dropped: 0 });
    expect((await post(batch)).json()).toEqual({ saved: 10, dropped: 10 });
    const full = await post({ kind: "js", message: "x" });
    expect(full.statusCode).toBe(429);
    clock = new Date(clock.getTime() + 61_000);
    expect((await post({ kind: "js", message: "x" })).statusCode).toBe(201);
  });

  it("시험 보고(test)는 합계에서 뺀다", async () => {
    await post({ kind: "test", message: "오류 수집 시험" });
    await post({ kind: "js", message: "real" });
    const s = (await app.inject({ method: "GET", url: "/api/admin/app-errors", headers: AUTH })).json();
    expect(s.total).toBe(1);
    expect(s.byKind.test).toBe(1);
  });

  it("형식이 틀리면 400", async () => {
    expect((await post({ kind: "nope", message: "x" })).statusCode).toBe(400);
    expect((await post({ errors: [] })).statusCode).toBe(400);
  });

  it("/health 상세에 최근 7일 오류 수", async () => {
    await post({ kind: "fatal", message: "boom" });
    const h = (await app.inject({ method: "GET", url: "/health", headers: AUTH })).json();
    expect(h.appErrors).toEqual({ days: 7, total: 1, fatal: 1 });
    const open = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(open.appErrors).toBeUndefined(); // 토큰 없으면 숫자도 안 보인다
  });
});

describe("오류 정리 규칙", () => {
  it("scrub: 메시지는 숫자까지, 스택은 토큰만", () => {
    expect(scrub("합계 1,234,567원", { numbers: true })).toBe("합계 #");
    expect(scrub("at bundle:12345:67", { numbers: false })).toBe("at bundle:12345:67");
    expect(scrub("ExponentPushToken[xyz] 0123456789abcdef0123456789abcdef", { numbers: false })).toBe("[지움] [지움]");
  });
  it("fingerprint: 숫자만 다른 같은 오류는 같은 키", () => {
    expect(fingerprint("js", "index 3 out of range", "at a (b:1:2)")).toBe(fingerprint("js", "index 7 out of range", "at a (b:9:9)"));
    expect(fingerprint("js", "x", null)).not.toBe(fingerprint("render", "x", null));
  });
  it("오래된 행은 5000개를 넘지 않게 지운다", async () => {
    const db = await createMigratedDb(":memory:");
    const svc = new AppErrorService(db, () => new Date("2026-09-24T10:00:00+09:00"));
    for (let k = 0; k < 50; k++) {
      await db.insertInto("app_errors").values(Array.from({ length: 100 }, (_, i) => ({ at: "2026-09-20T10:00:00+09:00", occurred_at: null, kind: "js", message: `m${k}-${i}`, stack: null, screen: null, fingerprint: "f", app_version: null, update_id: null, platform: null }))).execute();
    }
    await svc.record([{ kind: "js", message: "new" }]);
    const n = await db.selectFrom("app_errors").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(5000);
    await db.destroy();
  });
});
