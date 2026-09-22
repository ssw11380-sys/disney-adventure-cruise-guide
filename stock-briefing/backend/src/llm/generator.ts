import Anthropic from "@anthropic-ai/sdk";

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
  apiKey: string;
  model: string;
  /** 3xx/5xx, 429 재시도 횟수. SDK 기본값 2 */
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Anthropic SDK 래퍼.
 * - 시스템 프롬프트는 cache_control 로 캐싱 (프롬프트 파일 내용이 그대로 prefix 가 되므로 안정적).
 * - 서버측 refusal fallback 을 기본으로 켠다 (안전 분류기가 거절하면 대체 모델이 같은 요청을 이어서 처리).
 * - stop_reason 을 검사해서 refusal / max_tokens 를 오류로 올린다.
 */
export class ClaudeGenerator implements TextGenerator {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: ClaudeGeneratorOptions) {
    if (!opts.apiKey) throw new GenerationError("ANTHROPIC_API_KEY 가 설정되지 않았습니다", "config");
    this.model = opts.model;
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries ?? 2,
      timeout: opts.timeoutMs ?? 5 * 60_000,
    });
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: req.effort ?? "medium" },
        ...(req.system
          ? { system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }] }
          : {}),
        messages: [{ role: "user", content: req.user }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new GenerationError("Anthropic API 키가 올바르지 않습니다", "config", e);
      if (e instanceof Anthropic.RateLimitError) throw new GenerationError("Anthropic API 사용량 제한에 걸렸습니다", "api", e);
      if (e instanceof Anthropic.APIError) throw new GenerationError(`Anthropic API 오류 ${e.status ?? ""}: ${e.message}`, "api", e);
      throw new GenerationError(`Anthropic 호출 실패: ${(e as Error).message}`, "api", e);
    }

    if (response.stop_reason === "refusal") {
      const cat = response.stop_details?.category ?? "unknown";
      throw new GenerationError(`모델이 응답을 거절했습니다 (category=${cat})`, "refusal");
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
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

/** API 키가 없을 때 쓰는 생성기: 호출 즉시 설정 오류를 낸다 (서버는 뜨되 브리핑은 "미생성"으로 기록). */
export class DisabledGenerator implements TextGenerator {
  readonly model = "disabled";
  async generate(): Promise<GenerateResult> {
    throw new GenerationError("ANTHROPIC_API_KEY 가 설정되지 않아 브리핑을 생성할 수 없습니다", "config");
  }
}
