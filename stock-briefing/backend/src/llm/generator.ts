import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import type { LlmBackend } from "./backend.js";

/**
 * 텍스트 생성기 인터페이스. 브리핑/분석 서비스는 이 인터페이스만 알고,
 * 테스트에서는 가짜 구현을 주입한다.
 */
export interface GenerateRequest {
  system: string;
  user: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  /** 로깅용 라벨 (예: briefing_detail:000660) */
  label?: string;
}

export interface GenerateResult {
  text: string;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  stopReason: string;
}

export interface TextGenerator {
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export class GenerationError extends Error {
  constructor(
    message: string,
    public readonly kind: "refusal" | "truncated" | "api" | "config",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

export interface ClaudeGeneratorOptions {
  backend: LlmBackend;
  /** 3xx/5xx, 429 재시도 횟수. SDK 기본값 2 */
  maxRetries?: number;
  timeoutMs?: number;
}

/** 두 SDK 응답의 공통 모양 (구조적 타입) */
interface MessageLike {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
}

/**
 * Claude 호출 래퍼. 두 경로를 지원한다.
 *  - anthropic: 첫 번째 파티 API. 서버측 refusal fallback 을 켠다 (beta).
 *  - bedrock:   Claude in Amazon Bedrock (Messages API 엔드포인트). fallback 파라미터는 지원되지 않아 뺀다.
 * 공통: 시스템 프롬프트는 1시간 캐싱, stop_reason 검사 (refusal / max_tokens 는 오류).
 */
export class ClaudeGenerator implements TextGenerator {
  readonly model: string;
  private readonly anthropic: Anthropic | null = null;
  private readonly bedrock: AnthropicBedrockMantle | null = null;

  constructor(opts: ClaudeGeneratorOptions) {
    const b = opts.backend;
    this.model = b.model;
    const common = { maxRetries: opts.maxRetries ?? 2, timeout: opts.timeoutMs ?? 5 * 60_000 };
    if (b.kind === "anthropic") {
      if (!b.apiKey) throw new GenerationError("ANTHROPIC_API_KEY 가 설정되지 않았습니다", "config");
      this.anthropic = new Anthropic({ apiKey: b.apiKey, ...common });
    } else {
      if (!b.bearerToken && !(b.accessKeyId && b.secretAccessKey)) {
        throw new GenerationError("Bedrock 자격 증명(AWS_BEARER_TOKEN_BEDROCK 또는 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)이 없습니다", "config");
      }
      this.bedrock = new AnthropicBedrockMantle({
        awsRegion: b.region,
        ...(b.bearerToken ? { apiKey: b.bearerToken } : { awsAccessKey: b.accessKeyId, awsSecretAccessKey: b.secretAccessKey }),
        ...common,
      });
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const system = req.system
      ? [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }]
      : undefined;
    const base = {
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      output_config: { effort: req.effort ?? "medium" },
      ...(system ? { system } : {}),
      messages: [{ role: "user" as const, content: req.user }],
    };

    let response: MessageLike;
    try {
      if (this.anthropic) {
        response = await this.anthropic.beta.messages.create({
          ...base,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
      } else {
        response = await this.bedrock!.messages.create(base);
      }
    } catch (e) {
      throw toGenerationError(e);
    }

    if (response.stop_reason === "refusal") {
      const cat = response.stop_details?.category ?? "unknown";
      throw new GenerationError(`모델이 응답을 거절했습니다 (category=${cat})`, "refusal");
    }
    const text = response.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    if (response.stop_reason === "max_tokens") {
      throw new GenerationError(`응답이 max_tokens 에서 잘렸습니다 (${text.length}자)`, "truncated");
    }
    if (!text) throw new GenerationError("모델이 빈 응답을 반환했습니다", "api");
    const u = response.usage;
    return {
      text,
      model: response.model,
      usage: {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      stopReason: response.stop_reason ?? "end_turn",
    };
  }
}

function toGenerationError(e: unknown): GenerationError {
  if (e instanceof Anthropic.AuthenticationError) return new GenerationError("API 키/자격 증명이 올바르지 않습니다 (401)", "config", e);
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new GenerationError("권한이 없습니다 (403). Bedrock 이면 모델 접근 권한(Model access)과 IAM 정책(bedrock-mantle:CreateInference)을 확인하세요", "config", e);
  }
  if (e instanceof Anthropic.NotFoundError) return new GenerationError(`모델을 찾을 수 없습니다 (404): 모델 ID 와 리전을 확인하세요. ${(e as Error).message}`, "config", e);
  if (e instanceof Anthropic.RateLimitError) return new GenerationError("API 사용량 제한에 걸렸습니다 (429). 잠시 후 자동 재시도됩니다", "api", e);
  if (e instanceof Anthropic.APIError) {
    const msg = `${e.message}`.toLowerCase();
    if (e.status === 402 || msg.includes("credit balance") || msg.includes("billing") || msg.includes("insufficient")) {
      return new GenerationError("Anthropic 크레딧이 부족합니다. console.anthropic.com → Billing 에서 충전하세요", "config", e);
    }
    if (e.status !== undefined && e.status >= 500) return new GenerationError(`Anthropic 서버 장애 (${e.status}). 다음 실행에서 자동 재시도됩니다`, "api", e);
    return new GenerationError(`API 오류 ${e.status ?? ""}: ${e.message}`, "api", e);
  }
  return new GenerationError(`모델 호출 실패: ${(e as Error).message}`, "api", e);
}

/** 자격 증명이 없을 때 쓰는 생성기: 호출 즉시 설정 오류를 낸다 (서버는 뜨되 브리핑은 "미생성"으로 기록). */
export class DisabledGenerator implements TextGenerator {
  readonly model = "disabled";
  async generate(): Promise<GenerateResult> {
    throw new GenerationError("ANTHROPIC_API_KEY 또는 Bedrock 자격 증명이 없어 브리핑을 생성할 수 없습니다", "config");
  }
}
