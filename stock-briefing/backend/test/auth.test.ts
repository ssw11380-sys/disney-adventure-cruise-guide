import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
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
