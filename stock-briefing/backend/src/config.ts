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

  /** anthropic | bedrock | auto(기본: 키가 있는 쪽) */
  LLM_PROVIDER: z.enum(["auto", "anthropic", "bedrock"]).default("auto"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5"),

  /** Amazon Bedrock (Claude in Amazon Bedrock, Messages API 엔드포인트). Bedrock API 키 또는 IAM 액세스 키 중 하나 */
  AWS_BEARER_TOKEN_BEDROCK: z.string().default(""),
  AWS_ACCESS_KEY_ID: z.string().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().default(""),
  AWS_REGION: z.string().default("ap-northeast-1"),
  BEDROCK_MODEL: z.string().default("anthropic.claude-opus-4-8"),

  BRIEFING_MORNING_CRON: z.string().default("30 8 * * 1-5"),
  BRIEFING_AFTERNOON_CRON: z.string().default("0 16 * * 1-5"),

  /** Expo 푸시 보안 토큰 (선택). 계정에서 "Enhanced push security" 를 켠 경우에만 필요 */
  EXPO_ACCESS_TOKEN: z.string().default(""),

  /** 설정하면 /api/* 요청에 `Authorization: Bearer <토큰>` 이 필요하다 (인터넷에 노출할 때 필수) */
  API_TOKEN: z.string().default(""),
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
