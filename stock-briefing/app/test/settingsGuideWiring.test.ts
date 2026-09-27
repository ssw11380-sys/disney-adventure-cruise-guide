import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 3-24 리뷰 수정: '설정 열기'와 칸 이름 문구가 주요 탭·종목 상세·비중에만 붙고 브리핑 상세·계좌 브리핑 상세·시장 요약 상세·테마 상세·
 * 잔고 수정에는 빠져 있었다. 서버 조회가 실패하는 오류 화면(ErrorView … refetch)과 끊김 띠(StaleBanner)가 모두
 * useSettingsGuide 의 속성(플래그가 꺼져 있으면 null — 지금 그대로)을 받는지 소스에서 본다 (새 화면이 빠뜨리지 않게).
 * 종목 상세 안의 작은 카드(AI 분석·뉴스·공시)는 화면 전체 오류가 먼저 보이므로 넣지 않는다 — 401 글은 api/client 가 칸 이름 문구로 바꾼다
 */
const FILES = [
  "src/app/(tabs)/index.tsx",
  "src/app/(tabs)/briefings.tsx",
  "src/app/(tabs)/discover.tsx",
  "src/components/discover/ThemeBoard.tsx",
  "src/app/stocks/[code]/index.tsx",
  "src/app/stocks/[code]/edit.tsx",
  "src/app/portfolio/allocation.tsx",
  "src/app/discover/theme/[id].tsx",
  "src/components/BriefingBody.tsx",
  "src/components/AccountBriefingBody.tsx",
  "src/components/MarketSummaryBody.tsx",
];
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
/** 여는 태그 하나씩 (속성 안의 화살표 함수 '=>' 의 '>' 에서 끊기지 않게 '/>' 까지) */
const tags = (src: string, name: string) => [...src.matchAll(new RegExp(`<${name}\\b[\\s\\S]*?/>`, "g"))].map((m) => m[0]);

describe("서버 조회 오류 화면·끊김 띠는 모두 '설정 열기' 속성을 받는다", () => {
  it.each(FILES)("%s", (f) => {
    const src = read(f);
    expect(src).toContain("useSettingsGuide()");
    const errors = tags(src, "ErrorView").filter((t) => /refetch/.test(t));
    expect(errors.length).toBeGreaterThan(0);
    for (const t of errors) expect(t).toMatch(/\{\.\.\.(guide|guideProps)\}/);
    for (const t of tags(src, "StaleBanner")) expect(t).toMatch(/\{\.\.\.(guide|guideProps)\}/);
  });

  it.each(["src/app/stocks/add.tsx", "src/app/market/[code].tsx"])("작은 칸 오류 글(종목 검색 결과 · 지수 차트)도 받는다: %s", (f) => {
    const src = read(f);
    expect(src).toContain("useSettingsGuide()");
    const lines = tags(src, "ConnectionLine");
    expect(lines.length).toBeGreaterThan(0);
    for (const t of lines) expect(t).toMatch(/\{\.\.\.(guide|guideProps)\}/);
  });

  it("'설정 열기'를 onPress 에 바로 넘기지 않는다 (누름 이벤트가 라우터 인자로 들어가지 않게 — useSettingsGuide 를 쓴다)", () => {
    for (const f of FILES) expect(read(f)).not.toMatch(/onOpenSettings:\s*openServerSettings\b/);
  });
});
