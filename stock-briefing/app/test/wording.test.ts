import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 투자 권유로 읽히는 문구가 앱·서버·프롬프트에 들어가지 않았는지, 고지 문구가 그대로 있는지 확인한다.
 * 금지 문구를 꼭 써야 하는 곳(금지 지시 자체)은 프롬프트뿐이라 프롬프트는 "금지 지시가 있는지"로 따로 본다.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url)); // stock-briefing/
const DISCLAIMER = "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.";
const BANNED = ["매수 추천", "매도 추천", "매수추천", "매도추천", "적극 매수", "강력 매수", "매수하세요", "매도하세요", "사세요", "파세요", "추천 종목", "수익 보장", "원금 보장", "목표주가", "목표 주가", "무조건 오", "반드시 오릅"];

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("투자 권유 금지 문구", () => {
  const targets = [...files(join(ROOT, "app/src"), [".ts", ".tsx"]), ...files(join(ROOT, "backend/src"), [".ts"])];

  it("검사 대상 파일이 있다", () => expect(targets.length).toBeGreaterThan(50));

  it("앱·서버 코드에 금지 문구가 없다", () => {
    const hits: string[] = [];
    for (const f of targets) {
      const text = readFileSync(f, "utf8");
      for (const w of BANNED) if (text.includes(w)) hits.push(`${f.slice(ROOT.length)}: ${w}`);
    }
    expect(hits).toEqual([]);
  });

  it("분석·브리핑 프롬프트마다 매수/매도 지시 금지 규칙이 있다", () => {
    const prompts = files(join(ROOT, "backend/prompts"), [".md"]).filter((f) => !f.endsWith("README.md"));
    expect(prompts.length).toBeGreaterThanOrEqual(5);
    for (const f of prompts) expect(readFileSync(f, "utf8"), f).toMatch(/매수\/매도[^\n]*(금지|하지 않|없이)/);
  });
});

describe("고지 문구", () => {
  it("앱 공통 고지 문구가 그대로다", () => expect(read("app/src/lib/disclaimer.ts")).toContain(`DISCLAIMER = "${DISCLAIMER}"`));
  it("위젯 고지 한 줄은 권유가 아님을 밝힌다", () => expect(read("app/src/lib/disclaimer.ts")).toMatch(/DISCLAIMER_SHORT = ".*투자 권유가 아닙니다"/));
  it("서버 고지 문구가 앱과 같다", () => expect(read("backend/src/app.ts")).toContain(`DISCLAIMER = "${DISCLAIMER}"`));
  it("설정 화면에 고지가 있다", () => expect(read("app/src/app/(tabs)/settings.tsx")).toContain(DISCLAIMER));
  it("브리핑 목록·상세·종목 상세 화면이 고지를 붙인다", () => {
    expect(read("app/src/app/(tabs)/briefings.tsx")).toMatch(/<Screen[^>]*\bdisclaimer\b/);
    // 상세 본문은 components 로 떼어냈다 (3-42 웨이브 D): 경로 화면은 본문을 그대로 쓰고, 본문은 폰(stack)·넓은 창 두 칸(split)·2단 오른쪽 칸(pane) 모두 고지를 붙인다
    expect(read("app/src/app/briefings/[id].tsx")).toMatch(/<BriefingBody\b/);
    expect(read("app/src/app/briefings/account/[id].tsx")).toMatch(/<AccountBriefingBody\b/); // 계좌 한 장 브리핑 (3-31)
    expect(read("app/src/components/BriefingBody.tsx").match(/<Screen[^>]*\bdisclaimer\b/g)?.length).toBe(5); // 본문 3곳(폰·두 칸·2단) + 2단 오른쪽 칸 불러오는 중·오류 (3-42 통합: 2단은 고지가 오른쪽 칸에만 있어 늘 붙인다)
    expect(read("app/src/components/AccountBriefingBody.tsx").match(/<Screen[^>]*\bdisclaimer\b/g)?.length).toBe(7); // 본문 2곳 + 2단 오른쪽 칸 불러오는 중·오류·꺼짐 5곳
    expect(read("app/src/app/stocks/[code]/index.tsx")).toMatch(/<Screen[\s\S]{0,200}?\bdisclaimer\b/);
  });
});
