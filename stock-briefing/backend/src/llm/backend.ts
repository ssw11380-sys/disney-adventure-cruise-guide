import type { AppConfig } from "../config.js";

/** 어떤 경로로 Claude 를 호출할지. 설정에서 결정한다. */
export type LlmBackend =
  | { kind: "anthropic"; apiKey: string; model: string }
  | {
      kind: "bedrock";
      region: string;
      model: string;
      /** Bedrock API 키 (Bearer). 있으면 IAM 키보다 우선 */
      bearerToken?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    };

/**
 * LLM_PROVIDER=auto 면 키가 있는 쪽을 고른다: ANTHROPIC_API_KEY → Bedrock 자격 증명 순.
 * 아무것도 없으면 null (브리핑은 "미생성"으로 기록되고 서버는 정상 기동).
 */
export function resolveLlmBackend(cfg: Pick<
  AppConfig,
  "LLM_PROVIDER" | "ANTHROPIC_API_KEY" | "ANTHROPIC_MODEL" | "AWS_BEARER_TOKEN_BEDROCK" | "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY" | "AWS_REGION" | "BEDROCK_MODEL"
>): LlmBackend | null {
  const hasAnthropic = cfg.ANTHROPIC_API_KEY.length > 0;
  const hasBedrock = cfg.AWS_BEARER_TOKEN_BEDROCK.length > 0 || (cfg.AWS_ACCESS_KEY_ID.length > 0 && cfg.AWS_SECRET_ACCESS_KEY.length > 0);

  const provider = cfg.LLM_PROVIDER === "auto" ? (hasAnthropic ? "anthropic" : hasBedrock ? "bedrock" : null) : cfg.LLM_PROVIDER;
  if (provider === "anthropic") {
    return hasAnthropic ? { kind: "anthropic", apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.ANTHROPIC_MODEL } : null;
  }
  if (provider === "bedrock") {
    if (!hasBedrock) return null;
    return {
      kind: "bedrock",
      region: cfg.AWS_REGION,
      model: cfg.BEDROCK_MODEL,
      ...(cfg.AWS_BEARER_TOKEN_BEDROCK ? { bearerToken: cfg.AWS_BEARER_TOKEN_BEDROCK } : {}),
      ...(cfg.AWS_ACCESS_KEY_ID ? { accessKeyId: cfg.AWS_ACCESS_KEY_ID, secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY } : {}),
    };
  }
  return null;
}

export function describeLlmBackend(b: LlmBackend | null): string {
  if (!b) return "없음 (ANTHROPIC_API_KEY 또는 Bedrock 자격 증명 없음)";
  if (b.kind === "anthropic") return `anthropic: ${b.model}`;
  return `bedrock(${b.region}): ${b.model}`;
}
