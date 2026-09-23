import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, redactToken } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { fakeProviders } from "./helpers.js";

describe("API_TOKEN auth", () => {
  let app: FastifyInstance;
  let db: Db;

  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN: "secret-123" }), db, providers: fakeProviders(), logger: false, enableScheduler: false });
  });
  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it("/health 는 열려 있고 authRequired 를 알려준다", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().authRequired).toBe(true);
  });

  it("/api/* 는 Bearer 토큰이 없거나 틀리면 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/stocks" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/api/stocks", headers: { authorization: "Bearer secret-123" } });
    expect(ok.statusCode).toBe(200);
  });

  it("퍼센트 인코딩·이중 슬래시 등으로 경로를 바꿔도 인증을 피할 수 없다 (라우터가 고른 경로로 판단)", async () => {
    for (const url of ["/%61pi/stocks", "/%61%70%69/stocks", "/api/%73tocks", "/api//stocks", "/api/stocks/", "/api/stocks?x=1", "/%61pi/briefings/latest", "/%61pi/stream?token=nope"]) {
      const res = await app.inject({ method: "GET", url });
      expect([401, 404], url).toContain(res.statusCode);
      expect(res.body, url).not.toContain('"code"');
    }
    // 쓰기 요청도 마찬가지
    for (const [method, url] of [["POST", "/%61pi/stocks"], ["DELETE", "/%61pi/stocks/005930"], ["POST", "/%61pi/briefings/run"]] as const) {
      expect([401, 404], url).toContain((await app.inject({ method, url, payload: { code: "005930" } })).statusCode);
    }
    // 올바른 토큰이면 인코딩된 경로도 정상
    expect((await app.inject({ method: "GET", url: "/%61pi/stocks", headers: { authorization: "Bearer secret-123" } })).statusCode).toBe(200);
    // 토큰 길이가 달라도 오류 없이 401
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: { authorization: "Bearer secret-1234567890" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/stocks", headers: { authorization: "secret-123" } })).statusCode).toBe(401);
  });

  it("API_TOKEN 이 비어 있으면 인증 없이 통과한다", async () => {
    const open = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(), logger: false, enableScheduler: false });
    expect((await open.inject({ method: "GET", url: "/api/stocks" })).statusCode).toBe(200);
    expect((await open.inject({ method: "GET", url: "/health" })).json().authRequired).toBe(false);
    await open.close();
  });
});

describe("needsSsl", () => {
  it("외부 호스트는 켜고 localhost/사설망/sslmode=disable 은 끈다", async () => {
    const { needsSsl } = await import("../src/db/index.js");
    expect(needsSsl("postgres://u:p@ep-cool.neon.tech/db?sslmode=require", undefined)).toBe(true);
    expect(needsSsl("postgres://u:p@db.supabase.co:5432/postgres", undefined)).toBe(true);
    expect(needsSsl("postgres://u:p@postgres.railway.internal:5432/railway", undefined)).toBe(false);
    expect(needsSsl("postgres://u:p@db:5432/stock", undefined)).toBe(false);
    expect(needsSsl("postgres://u:p@127.0.0.1:5433/x", undefined)).toBe(false);
    expect(needsSsl("postgres://u:p@host.example.com/x?sslmode=disable", undefined)).toBe(false);
    expect(needsSsl("postgres://u:p@postgres.railway.internal/x", "true")).toBe(true);
  });
});

describe("/health · 없는 주소 · 발견 탭 오류 형식", () => {
  it("토큰이 없으면 /health 는 최소 정보만, 토큰이 있으면 상세", async () => {
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN: "secret-123" }), db, providers: fakeProviders(), logger: false, enableScheduler: false });
    const pub = (await app.inject({ method: "GET", url: "/health" })).json();
    // 상세(구독 종목·서버 IP·출처 구성)는 빼고, 옛 앱이 바로 읽는 sources·schedule 은 빈 값으로
    expect(pub).toEqual({ ok: true, time: expect.any(String), authRequired: true, limited: true, sources: {}, schedule: null, disclaimer: expect.any(String) });
    expect(JSON.stringify(pub)).not.toMatch(/tossOpenApi|outboundIp|subscribed|devices/);
    const wrong = (await app.inject({ method: "GET", url: "/health", headers: { authorization: "Bearer nope" } })).json();
    expect(wrong.limited).toBe(true);
    const full = (await app.inject({ method: "GET", url: "/health", headers: { authorization: "Bearer secret-123" } })).json();
    expect(full).toHaveProperty("sources");
    expect(full).toHaveProperty("tossOpenApi");
    const nf = await app.inject({ method: "GET", url: "/nope", headers: { authorization: "Bearer secret-123" } });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toMatchObject({ error: "NOT_FOUND" });
    await app.close();
    await db.destroy();
  });
});

describe("요청 로그의 토큰 가림", () => {
  it("쿼리의 token 값만 가린다 (인코딩한 이름 포함)", () => {
    expect(redactToken("/api/stream?token=abc123")).toBe("/api/stream?token=[redacted]");
    expect(redactToken("/api/stream?x=1&%74oken=abc&y=2")).toBe("/api/stream?x=1&%74oken=[redacted]&y=2");
    expect(redactToken("/api/stream?TOKEN=abc")).toBe("/api/stream?TOKEN=[redacted]");
    expect(redactToken("/api/stocks?tokens=1&mytoken=2")).toBe("/api/stocks?tokens=1&mytoken=2");
    expect(redactToken("/health")).toBe("/health");
    // 라우터는 '#' 뒤도 쿼리로 읽는다
    expect(redactToken("/api/stream#token=abc")).toBe("/api/stream#token=[redacted]");
    expect(redactToken("/api/stream#x=1&token=abc")).toBe("/api/stream#x=1&token=[redacted]");
    expect(redactToken("/api/stream;token=abc")).toBe("/api/stream;token=[redacted]");
    expect(redactToken("/api/stream?token=a=b&x=1")).toBe("/api/stream?token=[redacted]&x=1");
  });

  it("서버 요청 로그에 웹소켓 토큰이 남지 않는다", async () => {
    const lines: string[] = [];
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN: "secret-123" }),
      db,
      providers: fakeProviders(),
      logger: { level: "info", stream: { write: (s: string) => lines.push(s) } },
      enableScheduler: false,
    });
    try {
      await app.inject({ method: "GET", url: "/api/stream?token=secret-123" });
      await app.inject({ method: "GET", url: "/api/stocks?t%6Fken=secret-123" });
      const all = lines.join("");
      expect(all).toContain("[redacted]");
      expect(all).toContain("/api/stream");
      expect(all).not.toContain("secret-123");
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});
