import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { describeLlmBackend, resolveLlmBackend } from "../src/llm/backend.js";
import { ClaudeGenerator, GenerationError } from "../src/llm/generator.js";

describe("LLM backend 선택", () => {
  it("키가 없으면 null", () => {
    expect(resolveLlmBackend(loadConfig({ DATABASE_URL: ":memory:" }))).toBeNull();
  });
  it("ANTHROPIC_API_KEY 가 있으면 anthropic", () => {
    const b = resolveLlmBackend(loadConfig({ DATABASE_URL: ":memory:", ANTHROPIC_API_KEY: "sk-ant-x" }));
    expect(b).toEqual({ kind: "anthropic", apiKey: "sk-ant-x", model: "claude-opus-5" });
  });
  it("Bedrock 키만 있으면 bedrock (도쿄 기본, opus 4.8 기본)", () => {
    const b = resolveLlmBackend(loadConfig({ DATABASE_URL: ":memory:", AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key-x" }));
    expect(b).toEqual({ kind: "bedrock", region: "ap-northeast-1", model: "anthropic.claude-opus-4-8", bearerToken: "bedrock-api-key-x" });
    expect(describeLlmBackend(b)).toBe("bedrock(ap-northeast-1): anthropic.claude-opus-4-8");
  });
  it("IAM 액세스 키 쌍도 bedrock 으로 인식하고, LLM_PROVIDER 로 강제할 수 있다", () => {
    const cfg = loadConfig({ DATABASE_URL: ":memory:", ANTHROPIC_API_KEY: "sk", AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1", BEDROCK_MODEL: "anthropic.claude-sonnet-5", LLM_PROVIDER: "bedrock" });
    expect(resolveLlmBackend(cfg)).toEqual({ kind: "bedrock", region: "us-east-1", model: "anthropic.claude-sonnet-5", accessKeyId: "AKIA", secretAccessKey: "s" });
    expect(resolveLlmBackend(loadConfig({ DATABASE_URL: ":memory:", LLM_PROVIDER: "bedrock" }))).toBeNull();
  });
  it("자격 증명이 비어 있으면 생성기가 설정 오류를 낸다", () => {
    expect(() => new ClaudeGenerator({ backend: { kind: "bedrock", region: "ap-northeast-1", model: "x" } })).toThrow(GenerationError);
    expect(() => new ClaudeGenerator({ backend: { kind: "anthropic", apiKey: "", model: "x" } })).toThrow(GenerationError);
  });
  it("Bedrock 생성기는 자격 증명이 있으면 만들어진다 (네트워크 호출 없음)", () => {
    const g = new ClaudeGenerator({ backend: { kind: "bedrock", region: "ap-northeast-1", model: "anthropic.claude-opus-4-8", bearerToken: "k" } });
    expect(g.model).toBe("anthropic.claude-opus-4-8");
  });
});
