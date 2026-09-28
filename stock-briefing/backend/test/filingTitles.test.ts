import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findBanned } from "../src/services/briefingWording.js";
import { AMENDED_NOTE, FORMS, filingDetail, filingTitle, ITEMS_8K, itemInfo, NO_ITEMS_NOTE } from "../src/services/filingTitles.js";

/**
 * 3-38 공시 제목 번역 (플래그 filingAlerts): SEC 서식·8-K 항목 번호 → 우리말 제목·한 줄 설명.
 * 내용 요약이 아니라 서식·번호를 옮긴 것 — 사실만 (매매·전망·권유하는 말 0건: BRIEFING_BANNED)
 */
describe("8-K 항목 표", () => {
  it("SEC Form 8-K 의 모든 항목 번호에 제목·설명이 있다 (6.01~6.10 은 자산유동화증권 한 줄)", () => {
    const all = ["1.01", "1.02", "1.03", "1.04", "1.05", "2.01", "2.02", "2.03", "2.04", "2.05", "2.06", "3.01", "3.02", "3.03", "4.01", "4.02", "5.01", "5.02", "5.03", "5.04", "5.05", "5.06", "5.07", "5.08", "7.01", "8.01", "9.01"];
    expect(Object.keys(ITEMS_8K).sort()).toEqual(all);
    for (const no of all) {
      expect(itemInfo(no).title.length, no).toBeGreaterThan(1);
      expect(itemInfo(no).about.length, no).toBeGreaterThan(4);
    }
    for (const no of ["6.01", "6.05", "6.10"]) expect(itemInfo(no).title).toBe("자산유동화증권 보고");
    expect(itemInfo("6.11").title).toBe("기타 항목");
    expect(itemInfo("2.02")).toMatchObject({ title: "실적 발표", about: "분기·연간 실적 같은 영업 결과를 알림" });
  });
});

describe("공시 제목", () => {
  it.each([
    ["8-K", ["2.02", "9.01"], "실적 발표(8-K 2.02)"],
    ["8-K", ["5.02"], "임원·이사 변경(8-K 5.02)"],
    // 차례가 가장 앞선 항목 + 9.01 을 뺀 나머지 수 (NVDA 8/17 '1.01,2.03,7.01')
    ["8-K", ["1.01", "2.03", "7.01"], "중요 계약 체결 외 2건(8-K 1.01)"],
    // RGTI 9/8 '1.01,3.02,7.01,8.01,9.01' · 8/19 '5.02,7.01,8.01,9.01'
    ["8-K", ["1.01", "3.02", "7.01", "8.01", "9.01"], "중요 계약 체결 외 3건(8-K 1.01)"],
    ["8-K", ["5.02", "7.01", "8.01", "9.01"], "임원·이사 변경 외 2건(8-K 5.02)"],
    // O 8/5 '2.02,7.01,9.01' — 실적 발표가 먼저
    ["8-K", ["2.02", "7.01", "9.01"], "실적 발표 외 1건(8-K 2.02)"],
    // 같은 차례(5.07·8.01 = 20)는 번호 순
    ["8-K", ["8.01", "5.07"], "주주총회 투표 결과 외 1건(8-K 5.07)"],
    ["8-K", ["9.01"], "재무제표·첨부 서류(8-K 9.01)"],
    ["8-K", ["1.09"], "기타 항목(8-K 1.09)"],
    ["8-K", ["6.03", "9.01"], "자산유동화증권 보고(8-K 6.03)"],
    ["8-K", [], "수시 보고(8-K)"],
    ["8-K/A", ["5.02"], "임원·이사 변경 정정(8-K/A 5.02)"],
    ["8-K/A", [], "수시 보고 정정(8-K/A)"],
    ["10-Q", [], "분기 보고서(10-Q)"],
    ["10-Q/A", [], "분기 보고서 정정(10-Q/A)"],
    ["10-K", [], "연간 보고서(10-K)"],
    ["10-K/A", [], "연간 보고서 정정(10-K/A)"],
    ["20-F", [], "연간 보고서(20-F, 외국 기업)"],
    ["40-F", [], "연간 보고서(40-F, 캐나다 기업)"],
    ["6-K", [], "외국 기업 수시 보고(6-K)"],
    ["6-K/A", [], "외국 기업 수시 보고 정정(6-K/A)"],
  ] as const)("%s %j → %s", (form, items, title) => {
    expect(filingTitle(form, items)).toBe(title);
  });
});

describe("펼친 내용", () => {
  it("8-K 는 들어 있는 항목마다 '번호 제목 — 설명' (번호 순서 그대로, 9.01 포함)", () => {
    expect(filingDetail("8-K", ["2.02", "9.01"])).toEqual({
      lines: ["2.02 실적 발표 — 분기·연간 실적 같은 영업 결과를 알림", "9.01 재무제표·첨부 서류 — 다른 항목에 딸린 첨부 서류"],
      note: null,
    });
    expect(filingDetail("8-K", [])).toEqual({ lines: [], note: NO_ITEMS_NOTE });
    expect(filingDetail("8-K/A", ["5.02"])).toEqual({ lines: ["5.02 임원·이사 변경 — 임원·이사의 선임·퇴임이나 보수 계약"], note: AMENDED_NOTE });
  });

  it("그 밖 서식은 한 줄 설명, 6-K 는 원문을 봐야 안다는 글, 정정은 '먼저 낸 보고서를 고친 것입니다.'", () => {
    expect(filingDetail("10-Q", [])).toEqual({ lines: [], note: "분기 재무제표와 사업 내용을 담은 정식 보고서" });
    expect(filingDetail("6-K", [])).toEqual({ lines: [], note: "외국 기업이 본국에서 알린 내용을 SEC에도 올린 것입니다. 무슨 내용인지는 원문을 봐야 알 수 있습니다." });
    expect(filingDetail("10-K/A", [])).toEqual({ lines: [], note: `한 해 재무제표와 사업 내용을 담은 정식 보고서 ${AMENDED_NOTE}` });
    expect(filingDetail("20-F", []).note).toBe("외국 기업이 SEC에 내는 연간 보고서");
    expect(filingDetail("40-F", []).note).toBe("캐나다 기업이 SEC에 내는 연간 보고서");
  });
});

describe("문구 검사 (사실만)", () => {
  it("모든 제목·설명·서식 글·공용 픽스처의 화면 문구에 매매·전망·권유하는 말이 없다 (BRIEFING_BANNED)", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/filingAlerts.json", import.meta.url), "utf8")) as { texts: Record<string, string>; items: Array<{ title: string; detail: string[]; note: string | null }> };
    const texts = [
      ...Object.values(ITEMS_8K).flatMap((i) => [i.title, i.about]),
      ...Object.values(FORMS).flatMap((f) => [f.title, f.about, f.extra ?? ""]),
      AMENDED_NOTE,
      NO_ITEMS_NOTE,
      ...Object.values(fixture.texts),
      ...fixture.items.flatMap((i) => [i.title, ...i.detail, i.note ?? ""]),
    ].filter((x) => x.length > 0);
    expect(texts.length).toBeGreaterThan(80);
    const hits = texts.flatMap((t) => {
      const w = findBanned(t, "");
      return w ? [`${t} → ${w}`] : [];
    });
    expect(hits).toEqual([]);
  });
});
