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

  it("브리핑 2차 6 새 프롬프트 두 개: 사용자 부분 변수, 시스템 부분에 예전 말(애널리스트·평가 꼬리표·지지/저항·체크포인트·보유자 해석)이 없다", async () => {
    const store = new PromptStore();
    const detail = await store.load("briefing_detail_safe");
    const summary = await store.load("briefing_summary_safe");
    expect(detail.userTemplate).toContain("{{data_json}}");
    expect(summary.userTemplate).toContain("{{detail}}");
    // 사용자 부분은 예전 상세 프롬프트와 같다 (데이터·보유 정보를 같은 틀로 넘긴다)
    expect(detail.userTemplate).toBe((await store.load("briefing_detail")).userTemplate);
    // 새 프롬프트는 금지 규칙 안에서 '지지선·저항선'·'과매수' 같은 이름을 직접 적어야 하므로 금지어 검사(findBanned)가 아니라 이 목록으로 본다
    const OLD_WORDS = ["애널리스트", "(긍정/부정/중립)", "지지/저항", "체크포인트", "그 의미", "영향 방향", "주가 영향", "보유자 관점", "다음 세션"];
    for (const t of [detail, summary]) {
      expect(t.system.length, t.name).toBeGreaterThan(50);
      for (const w of OLD_WORDS) expect(t.system, `${t.name}: ${w}`).not.toContain(w);
    }
    expect(detail.system).toContain("편집자");
  });

  it("없는 파일은 경로를 담은 오류를 낸다", async () => {
    await expect(new PromptStore("/nonexistent").load("briefing_detail")).rejects.toThrow("briefing_detail.md");
  });
});
