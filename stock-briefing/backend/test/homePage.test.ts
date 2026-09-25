import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb } from "../src/db/index.js";
import { fakeProviders } from "./helpers.js";

const PUSH = "ExponentPushToken[AbCdEfGhIjKlMnOpQrStUv]";
const AUTH = { authorization: "Bearer secret-123" };

async function build(env: Record<string, string>, logger: false | object = false) {
  const db = await createMigratedDb(":memory:");
  const app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:", ANTHROPIC_API_KEY: "sk-test", BRIEFING_MORNING_CRON: "30 8 * * 1-5", BRIEFING_AFTERNOON_CRON: "0 16 * * 1-5", ...env }),
    db,
    providers: fakeProviders(),
    logger,
  });
  return {
    app,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

describe("서버 첫 화면(/) (BH-49, BH-52)", () => {
  it("토큰이 설정돼 있으면 토큰 없는 요청에 /health 에서 숨긴 모델·알림 기기 수·브리핑 시각을 보이지 않는다", async () => {
    const { app, close } = await build({ API_TOKEN: "secret-123" });
    try {
      expect((await app.inject({ method: "POST", url: "/api/devices", headers: AUTH, payload: { token: PUSH, platform: "android" } })).statusCode).toBe(201);
      const pub = await app.inject({ method: "GET", url: "/" });
      expect(pub.statusCode).toBe(200);
      expect(pub.body).toContain("정상 작동 중");
      expect(pub.body).toContain("API 는 토큰이 필요합니다");
      expect(pub.body).not.toMatch(/브리핑 모델|알림 기기|브리핑:|claude|anthropic/i);
      // 틀린 토큰도 마찬가지
      expect((await app.inject({ method: "GET", url: "/", headers: { authorization: "Bearer nope" } })).body).not.toContain("브리핑 모델");
      // 토큰을 보낸 요청에는 /health 처럼 상세를 준다
      const full = await app.inject({ method: "GET", url: "/", headers: AUTH });
      expect(full.body).toContain("브리핑 모델");
      expect(full.body).toContain("등록된 알림 기기: 1대");
      expect(full.body).toContain("다음 오전 브리핑");
    } finally {
      await close();
    }
  });

  it("토큰이 설정되지 않았으면 'API 는 토큰이 필요합니다' 대신 누구나 접근할 수 있다고 경고한다", async () => {
    const { app, close } = await build({});
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("토큰이 필요합니다");
      expect(res.body).toContain("누구나 API 에 접근할 수 있습니다");
      // 보호가 없으니 /health 와 같이 상세를 그대로 보여 준다
      expect(res.body).toContain("브리핑 모델");
      expect((await app.inject({ method: "GET", url: "/api/stocks" })).statusCode).toBe(200);
    } finally {
      await close();
    }
  });
});

describe("요청 로그의 푸시 토큰 가림 (BH-65)", () => {
  it("알림을 끌 때(DELETE /api/devices/:token) 주소에 실린 Expo 푸시 토큰이 서버 로그에 남지 않는다", async () => {
    const lines: string[] = [];
    const { app, close } = await build({ API_TOKEN: "secret-123" }, { level: "info", stream: { write: (s: string) => lines.push(s) } });
    try {
      expect((await app.inject({ method: "POST", url: "/api/devices", headers: AUTH, payload: { token: PUSH, platform: "android" } })).statusCode).toBe(201);
      // 앱은 encodeURIComponent 로 보낸다 (괄호만 %5B/%5D)
      expect((await app.inject({ method: "DELETE", url: `/api/devices/${encodeURIComponent(PUSH)}`, headers: AUTH })).statusCode).toBe(204);
      // 인코딩하지 않은 괄호·경로를 바꾼 주소·UUID 모양 토큰·쿼리의 token 도
      await app.inject({ method: "DELETE", url: `/api/devices/${PUSH}`, headers: AUTH });
      await app.inject({ method: "DELETE", url: `/%61pi/devices/${encodeURIComponent(PUSH)}?token=secret-123`, headers: AUTH });
      await app.inject({ method: "DELETE", url: "/api/devices/3f2a9c1e-7b4d-4e8a-9f01-23456789abcd", headers: AUTH });
      await app.inject({ method: "GET", url: `/nope/${encodeURIComponent(PUSH)}` });
      const all = lines.join("");
      expect(all).toContain("incoming request");
      expect(all).toContain("/api/devices/[redacted]");
      expect(all).not.toContain("AbCdEfGhIjKlMnOpQrStUv");
      expect(all).not.toContain("3f2a9c1e-7b4d-4e8a-9f01-23456789abcd");
      expect(all).not.toContain("secret-123");
    } finally {
      await close();
    }
  });
});
