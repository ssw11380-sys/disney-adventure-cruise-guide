import { describe, expect, it } from "vitest";
import { parsePromptFile, PromptStore, renderTemplate, type PromptName } from "../src/llm/prompts.js";

describe("prompt templates", () => {
  it("=== USER === 구분선으로 시스템/사용자 부분을 나눈다", () => {
    const t = parsePromptFile("briefing_detail", "시스템 규칙\n\n=== USER ===\n\n종목: {{stock_name}}\n");
    expect(t.system).toBe("시스템 규칙");
    expect(t.userTemplate).toBe("종목: {{stock_name}}");
  });

  it("구분선이 없으면 전체가 사용자 메시지", () => {
    const t = parsePromptFile("briefing_summary", "그냥 본문");
    expect(t.system).toBe("");
    expect(t.userTemplate).toBe("그냥 본문");
  });

  it("변수를 치환하고 null 은 '확인 안 됨', 미정의 변수는 그대로 둔다", () => {
    expect(renderTemplate("{{a}}/{{ b }}/{{c}}/{{d}}", { a: "x", b: 1, c: null })).toBe("x/1/확인 안 됨/{{d}}");
  });

  it("prompts/ 폴더의 5개 파일이 모두 시스템+사용자 구조로 로드된다", async () => {
    const store = new PromptStore();
    const names: PromptName[] = ["briefing_detail", "briefing_summary", "company_overview", "value_analysis", "technical_analysis"];
    for (const name of names) {
      const t = await store.load(name);
      expect(t.system.length, name).toBeGreaterThan(50);
      expect(t.userTemplate, name).toContain("{{stock_name}}");
    }
    const detail = await store.load("briefing_detail");
    expect(detail.userTemplate).toContain("{{data_json}}");
    const summary = await store.load("briefing_summary");
    expect(summary.userTemplate).toContain("{{detail}}");
  });

  it("없는 파일은 경로를 담은 오류를 낸다", async () => {
    await expect(new PromptStore("/nonexistent").load("briefing_detail")).rejects.toThrow("briefing_detail.md");
  });
});
