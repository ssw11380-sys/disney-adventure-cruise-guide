import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().default("./data/dev.db"),

  KIS_APP_KEY: z.string().default(""),
  KIS_APP_SECRET: z.string().default(""),
  KIS_ENV: z.enum(["real", "mock"]).default("real"),

  DART_API_KEY: z.string().default(""),
  NAVER_CLIENT_ID: z.string().default(""),
  NAVER_CLIENT_SECRET: z.string().default(""),

  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),

  BRIEFING_MORNING_CRON: z.string().default("30 8 * * 1-5"),
  BRIEFING_AFTERNOON_CRON: z.string().default("0 16 * * 1-5"),

  /** Expo 푸시 보안 토큰 (선택). 계정에서 "Enhanced push security" 를 켠 경우에만 필요 */
  EXPO_ACCESS_TOKEN: z.string().default(""),
});

export type AppConfig = z.infer<typeof schema> & {
  kisEnabled: boolean;
  timezone: "Asia/Seoul";
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`환경 변수 설정 오류:\n${issues}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    kisEnabled: cfg.KIS_APP_KEY.length > 0 && cfg.KIS_APP_SECRET.length > 0,
    timezone: "Asia/Seoul",
  };
}
