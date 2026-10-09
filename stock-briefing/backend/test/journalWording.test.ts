import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REASONS } from "../src/services/journalCalc.js";
import { TAX_EXCLUDE_REASON } from "../src/services/taxRules.js";

/**
 * 매매일지 문구 검사 (3-37): 사실만 적는다 — 세금·매매 행동을 권하는 말이 없어야 한다.
 * 기존 wording.test(앱)는 금지 목록을 모든 파일에서 보고, 여기서는 매매일지 전용 금지어(설계 §4.7)를 매매일지 서버 파일과 서버가 만드는 문장에서 본다
 */
export const JOURNAL_BANNED = ["절세", "세금을 줄이", "줄이려면", "팔면", "매도하면", "사면", "매수하면", "손실을 확정", "기회", "유리", "추천", "해야 해요", "하세요"];

const FILES = [
  "src/services/journalCalc.ts",
  "src/services/journalService.ts",
  "src/services/journalReturns.ts",
  "src/services/taxRules.ts",
  "src/routes/journal.ts",
  "src/providers/market/fxStd.ts",
];

describe("매매일지 문구 (권유·세금 조언 표현 0건)", () => {
  it("서버가 만드는 까닭 문장에 금지어가 없다", () => {
    const texts = [...Object.values(REASONS), ...Object.values(TAX_EXCLUDE_REASON)];
    for (const s of texts) for (const w of JOURNAL_BANNED) expect(s, `${s} ⊃ ${w}`).not.toContain(w);
  });

  it("매매일지 서버 파일(주석 포함)에 금지어가 없다", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(fileURLToPath(new URL(`../${f}`, import.meta.url)), "utf8");
      for (const w of JOURNAL_BANNED) if (text.includes(w)) hits.push(`${f}: ${w}`);
    }
    expect(hits).toEqual([]);
  });
});
