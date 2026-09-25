import { describe, expect, it } from "vitest";
import {
  chunkRows,
  detailHeaderLayout,
  detailMode,
  fillChartHeight,
  markdownPreview,
  parseDetailTab,
  phoneTab,
  shortStamp,
  sideWidth,
  splitColumns,
  statColumns,
  wideChartHeight,
  wideTab,
  type DetailHeaderInput,
} from "@/lib/detailLayout";
import { classifyWindow, foldLayoutOf } from "@/lib/windowClass";
import { foldDetail, layout, space } from "@/tokens";

/**
 * 종목 상세 넓은 창 배치 계산 (3-42 웨이브 C). 추정 창 크기(앱이 쓰는 창 = 창 − 상태 표시줄 24 − 작업 표시줄 48)로 본다
 */
const APP = {
  "폴드8 접힘": [475, 679],
  "울트라 접힘": [411, 888],
  "폴드8 펼침 가로": [933, 632],
  "폴드8 펼침 세로": [704, 861],
  "울트라 펼침 세로": [859, 882],
  "울트라 펼침 가로": [954, 787],
} as const;

const modeOf = (w: number, h: number, on = true, fontScale = 1) => detailMode(foldLayoutOf(on, classifyWindow({ width: w, height: h, fontScale })), { width: w, height: h });

describe("배치 고르기 (detailMode)", () => {
  it("플래그가 켜져 있으면 크기마다 설계대로", () => {
    const got = Object.fromEntries(Object.entries(APP).map(([k, [w, h]]) => [k, modeOf(w, h)]));
    expect(got).toEqual({
      "폴드8 접힘": "phone",
      "울트라 접힘": "phone",
      "폴드8 펼침 가로": "split",
      "폴드8 펼침 세로": "wide",
      "울트라 펼침 세로": "rows",
      "울트라 펼침 가로": "split",
    });
  });

  it("플래그가 꺼져 있으면 어떤 크기든 휴대폰 화면", () => {
    for (const [w, h] of Object.values(APP)) expect(modeOf(w, h, false)).toBe("phone");
  });

  it("큰 글씨(130%)로 2단 기준을 넘지 못한 울트라 펼침 세로(859)는 한 단, 폴드8 가로(933)는 좌우 그대로", () => {
    expect(modeOf(859, 882, true, 1.3)).toBe("wide");
    expect(modeOf(933, 632, true, 1.3)).toBe("split");
  });
});

describe("오른쪽 칸 폭 · 시세표 칸 수", () => {
  it("오른쪽 칸: 100% 는 340, 큰 글씨는 늘어난 배율의 절반만큼 (140% 이상 408)", () => {
    expect(sideWidth(1)).toBe(layout.detailSideW);
    expect(sideWidth(1.3)).toBe(391);
    expect(sideWidth(2)).toBe(408);
  });

  it("오른쪽 칸 340(안쪽 312): 100% 2칸, 130% 부터 1칸", () => {
    expect(statColumns(sideWidth(1) - space.lg * 2, 1, 2)).toBe(2);
    expect(statColumns(sideWidth(1.3) - space.lg * 2, 1.3, 2)).toBe(1);
  });

  it("폴드8 펼침 세로(안쪽 676): 100% 4칸, 130% 3칸, 칸은 최대 4", () => {
    expect(statColumns(676, 1)).toBe(4);
    expect(statColumns(676, 1.3)).toBe(3);
    expect(statColumns(2000, 1)).toBe(4);
    expect(statColumns(0, 1)).toBe(1);
  });

  it("세로로 나누기: 14개 3칸 → 5·5·4, 가로로 나누기: 14개 2칸 → 7줄", () => {
    const items = Array.from({ length: 14 }, (_, i) => i);
    expect(splitColumns(items, 3).map((c) => c.length)).toEqual([5, 5, 4]);
    expect(splitColumns(items, 3).flat()).toEqual(items);
    expect(chunkRows(items, 2)).toHaveLength(7);
    expect(chunkRows(items, 2)[0]).toEqual([0, 1]);
  });
});

describe("차트 높이", () => {
  it("한 단(폴드8 펼침 세로): 창 높이 × 0.32 (폭 × 0.62 보다 낮으면)", () => {
    expect(wideChartHeight(676, 861)).toBe(Math.round(861 * foldDetail.wideChartHRatio));
    expect(wideChartHeight(300, 2000)).toBe(186);
    expect(wideChartHeight(676, 100)).toBe(layout.chartMinH);
  });

  it("좌우 배치: 칸 높이 − 차트 둘레, 최소 chartMinH", () => {
    expect(fillChartHeight(560, 170)).toBe(390);
    expect(fillChartHeight(200, 170)).toBe(layout.chartMinH);
    expect(fillChartHeight(0, 170)).toBe(layout.chartMinH);
  });
});

describe("탭 값 (주소 검색어 tab)", () => {
  it("아는 값만, 여러 번 넣었으면 첫 값", () => {
    expect(parseDetailTab("news")).toBe("news");
    expect(parseDetailTab(["value", "news"])).toBe("value");
    expect(parseDetailTab("x")).toBeNull();
    expect(parseDetailTab(undefined)).toBeNull();
  });

  it("휴대폰 화면은 고른 적 없거나 브리핑이면 지금처럼 기업개요, 넓은 창은 브리핑", () => {
    expect(phoneTab(null)).toBe("company");
    expect(phoneTab("briefing")).toBe("company");
    expect(phoneTab("technical")).toBe("technical");
    expect(wideTab(null)).toBe("briefing");
    expect(wideTab("news")).toBe("news");
  });
});

describe("AI 분석 미리보기 · 짧은 기준 시각", () => {
  it("제목·구분선·표 줄은 빼고 기호를 걷어 한 문단으로", () => {
    const md = "## 사업 개요\n- **메모리** 반도체 기업\n> [공시](https://x) 참고\n---\n| a | b |\n1. 둘째 `항목`";
    expect(markdownPreview(md)).toBe("메모리 반도체 기업 공시 참고 둘째 항목");
  });

  it("한국 시간 'M/D HH:MM'", () => {
    expect(shortStamp("2026-09-23T11:00:00Z")).toBe("9/23 20:00");
    expect(shortStamp(null)).toBe("-");
  });
});

describe("합친 머리 배치 (detailHeaderLayout)", () => {
  const base: DetailHeaderInput = {
    width: 933,
    fontScale: 1,
    name: "삼성전자",
    sub: "005930 · KOSPI · 반도체",
    price: "84,300",
    unit: "원",
    change: "▲1,200",
    rate: "+1.44%",
    state: ["한국 휴장", "KRX+NXT 통합 · 9월 23일 (수) 20:00"],
    pager: "1/17",
    action: null,
  };

  it("폴드8 펼침 가로(933)는 한 줄에 모두", () => expect(detailHeaderLayout(base).tier).toBe("one"));

  it("폴드8 펼침 세로(704): 긴 기준 시각이면 시장 상태만 둘째 줄, 짧게 줄이면 한 줄", () => {
    expect(detailHeaderLayout({ ...base, width: 704 }).tier).toBe("stateBelow");
    expect(detailHeaderLayout({ ...base, width: 704, state: ["한국 휴장", "9/23 20:00"] }).tier).toBe("one");
  });

  it("좁은 폭 + 큰 글씨면 가격·등락까지 둘째 줄 (숫자를 줄이지 않는다)", () => {
    expect(detailHeaderLayout({ ...base, width: 600, fontScale: 1.5 }).tier).toBe("quoteBelow");
  });

  it("이전·다음이 없고 버튼도 없는 머리(지수 상세)는 그만큼 넓게 쓴다", () => {
    const tight = { ...base, width: 600, state: ["장 마감", "9/23 15:30 기준"] };
    expect(detailHeaderLayout(tight).tier).not.toBe("one");
    expect(detailHeaderLayout({ ...tight, pager: null, action: false }).tier).toBe("one");
  });
});
