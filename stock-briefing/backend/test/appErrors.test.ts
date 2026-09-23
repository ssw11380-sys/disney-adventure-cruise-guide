import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { AppErrorService, fingerprint, scrub, scrubStack } from "../src/services/appErrorService.js";
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
    expect(r.json()).toEqual({ saved: 1, dropped: 0, invalid: 0 });
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
    expect((await post(batch)).json()).toEqual({ saved: 20, dropped: 0, invalid: 0 });
    expect((await post(batch)).json()).toEqual({ saved: 10, dropped: 10, invalid: 0 });
    const full = await post({ kind: "js", message: "x" });
    expect(full.statusCode).toBe(429);
    expect(full.headers["retry-after"]).toBe("60");
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

  it("형식이 틀리면 400, 묶음 중 틀린 건만 빼고 저장 (묶음 전체를 막지 않음)", async () => {
    expect((await post({ kind: "nope", message: "x" })).statusCode).toBe(400);
    expect((await post({ errors: [] })).statusCode).toBe(400);
    expect((await post({ errors: Array.from({ length: 21 }, () => ({ kind: "js", message: "x" })) })).statusCode).toBe(400);
    const mixed = await post({ errors: [{ kind: "js", message: "ok" }, { kind: "새종류", message: "x" }, { nope: 1 }] });
    expect(mixed.statusCode).toBe(201);
    expect(mixed.json()).toEqual({ saved: 1, dropped: 0, invalid: 2 });
  });

  it("본문이 너무 크거나 JSON 이 깨지면 500 이 아니라 4xx", async () => {
    const big = await post({ errors: [{ kind: "js", message: "x", stack: "y".repeat(300_000) }] });
    expect(big.statusCode).toBe(413);
    const bad = await app.inject({ method: "POST", url: "/api/app-errors", payload: "{bad", headers: { ...AUTH, "content-type": "application/json" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("{bad");
  });

  it("스택 첫 줄(메시지 반복)의 금액도 지운다", async () => {
    await post({ kind: "js", message: "평가금액 75,857,144원 불일치", stack: "Error: 평가금액 75,857,144원 불일치\n    at check (index.bundle:1:23456)" });
    const row = await db.selectFrom("app_errors").selectAll().executeTakeFirstOrThrow();
    expect(row.stack).not.toContain("75,857,144");
    expect(row.stack).toContain("index.bundle:1:23456");
  });

  it("N일 창은 한국 날짜 기준 오늘 포함 N일 (byDay 합계 = total)", async () => {
    await db.insertInto("app_errors").values([
      { at: "2026-09-18T09:00:00+09:00", occurred_at: null, kind: "js", message: "8일 전", stack: null, screen: null, fingerprint: "a", app_version: null, update_id: null, platform: null },
      { at: "2026-09-18T00:00:00+09:00", occurred_at: null, kind: "js", message: "7일 창 첫날 0시", stack: null, screen: null, fingerprint: "b", app_version: null, update_id: null, platform: null },
    ]).execute();
    await db.updateTable("app_errors").set({ at: "2026-09-17T23:59:59+09:00" }).where("message", "=", "8일 전").execute();
    await post({ kind: "js", message: "오늘" });
    const s = (await app.inject({ method: "GET", url: "/api/admin/app-errors?days=7", headers: AUTH })).json();
    expect(s.total).toBe(2);
    expect(s.byDay.reduce((a: number, d: { count: number }) => a + d.count, 0)).toBe(2);
    expect(s.byDay[0].date).toBe("2026-09-18");
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
  it("scrubStack: 메시지 반복 줄은 숫자까지, 호출 위치 줄은 줄·열 번호 유지", () => {
    expect(scrubStack("Error: 합계 1,234,567원\n    at f (b:12345:6)")).toBe("Error: 합계 #\n    at f (b:12345:6)");
    expect(scrubStack("TypeError: x 9999\nf@http://h/b.js:1:2")).toBe("TypeError: x #\nf@http://h/b.js:1:2");
  });
  it("scrub: JSON 모양 토큰, 콤마 구분 유지", () => {
    expect(scrub('{"apiToken":"abc","avg":12345,"q":3}', { numbers: true })).toBe('{"apiToken":"[지움]","avg":#,"q":3}');
    expect(scrub("authorization: xyz, next", { numbers: false })).toBe('authorization: "[지움]", next');
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
