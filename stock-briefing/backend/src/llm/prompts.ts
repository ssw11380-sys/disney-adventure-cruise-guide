import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * prompts/*.md 로더.
 * 파일은 "=== USER ===" 구분선으로 시스템 프롬프트(위)와 사용자 템플릿(아래)을 나눈다.
 * 매 호출마다 파일을 읽으므로 서버 재시작 없이 수정이 반영된다.
 */

export type PromptName =
  | "briefing_detail"
  | "briefing_summary"
  | "company_overview"
  | "value_analysis"
  | "technical_analysis";

export interface PromptTemplate {
  name: PromptName;
  system: string;
  userTemplate: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROMPTS_DIR = join(here, "..", "..", "prompts");
const SEPARATOR = /^=== USER ===\s*$/m;

export function parsePromptFile(name: PromptName, raw: string): PromptTemplate {
  const m = SEPARATOR.exec(raw);
  if (!m) return { name, system: "", userTemplate: raw.trim() };
  return {
    name,
    system: raw.slice(0, m.index).trim(),
    userTemplate: raw.slice(m.index + m[0].length).trim(),
  };
}

export class PromptStore {
  constructor(private readonly dir: string = DEFAULT_PROMPTS_DIR) {}

  async load(name: PromptName): Promise<PromptTemplate> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, `${name}.md`), "utf8");
    } catch (e) {
      throw new Error(`프롬프트 파일을 읽을 수 없습니다: ${join(this.dir, `${name}.md`)} (${(e as Error).message})`);
    }
    return parsePromptFile(name, raw);
  }
}

/** {{key}} 를 vars[key] 로 치환. 정의되지 않은 변수는 그대로 남겨 눈에 띄게 한다. */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) => {
    const v = vars[key];
    if (v === undefined) return whole;
    if (v === null) return "확인 안 됨";
    return String(v);
  });
}
