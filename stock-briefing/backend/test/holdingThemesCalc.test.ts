import { describe, expect, it } from "vitest";
import { productKindOf } from "../src/analysis/leveraged.js";
import { parseCompanyTics } from "../src/providers/market/tossCompanyTics.js";
import {
  allServerTexts,
  basisLines,
  classifyHolding,
  groupKey,
  INDEX_PRODUCTS,
  krIndexEtf,
  koDateTime,
  MARKET_NOTE_KR_INDEX,
  MARKET_NOTE_US_BOOK_FAILED,
  mostHeld,
  ticsMissingNote,
  pushTvDay,
  themeWordingProblems,
  topBottom,
  TV_KEEP_DAYS,
  tvBaseline,
  tvRatio,
  underlyingOfKind,
  unmappedText,
  type ClassifyInput,
  type TvDay,
} from "../src/services/holdingThemesCalc.js";

/**
 * 3-35 내 종목 테마 — 순수 함수 (분류·많이 속한 테마·높은/낮은 3개·거래대금 평소·문구).
 * 토스 회사 테마 예시는 2026-09-29 01:40~02:45 KST 에 직접 받아 본 값(설계 3.1 표)을 줄인 것
 */

/** 미국 테마북(깊이 1 이상 · 미국 3종목 이상)에 있는 토스 테마 id */
const BOOK = new Set(["179", "823", "209", "956", "89", "389", "203", "475", "359", "295", "291"]);
/** 토스 '주요 사업' 테마 (majorList) */
const TICS: Record<string, Array<{ id: string; title: string }>> = {
  NVDA: [
    { id: "179", title: "반도체팹리스" },
    { id: "823", title: "인공지능" },
    { id: "209", title: "컴퓨터와 주변기기" },
  ],
  RGTI: [
    { id: "956", title: "양자컴퓨터" },
    { id: "89", title: "IT솔루션구축" },
  ],
  IONQ: [
    { id: "956", title: "양자컴퓨터" },
    { id: "389", title: "소프트웨어" },
  ],
  AAPL: [
    { id: "203", title: "스마트폰제조" },
    { id: "209", title: "컴퓨터와 주변기기" },
  ],
  MSFT: [
    { id: "475", title: "클라우드" },
    { id: "389", title: "소프트웨어" },
    { id: "359", title: "인터넷" },
    { id: "823", title: "인공지능" },
  ],
  META: [{ id: "359", title: "인터넷" }],
  AVGO: [
    { id: "179", title: "반도체팹리스" },
    { id: "389", title: "소프트웨어" },
  ],
  PLTR: [{ id: "389", title: "소프트웨어" }],
  TSLA: [
    { id: "295", title: "전기차" },
    { id: "291", title: "자동차브랜드" },
  ],
  AMZN: [
    { id: "359", title: "인터넷" },
    { id: "475", title: "클라우드" },
  ],
  SOFI: [{ id: "97", title: "금융" }], // 깊이 0 — 테마북에 없음
  QQQ: [{ id: "87", title: "IT" }],
  SOXL: [{ id: "169", title: "반도체" }],
  RGTX: [{ id: "87", title: "IT" }],
};
const US_IND: Record<string, string | null> = { SOFI: "55101030", NVDA: "57101010", RGTI: "57101010", QQQ: null, SOXL: null, RGTX: null };

const us = (code: string, over: Partial<ClassifyInput> = {}): ClassifyInput => {
  const kind = productKindOf(code, code, null, null);
  const u = underlyingOfKind(kind);
  const src = u?.code ?? code;
  return { code, name: code, market: "US", underlying: u, bookIds: BOOK, usTics: TICS[src] ?? [], usIndustry: US_IND[src] ?? null, ...over };
};
const kr = (code: string, name: string, over: Partial<ClassifyInput> = {}): ClassifyInput => ({ code, name, market: "KR", underlying: null, bookIds: BOOK, krThemes: [], krIndustry: null, ...over });

describe("종목 → 묶음 고르기 (설계 3.1)", () => {
  it("미국 보통주: 토스 주요 사업 테마 중 테마북에 있는 것만", () => {
    expect(classifyHolding(us("NVDA")).groups.map((g) => g.id)).toEqual(["179", "823", "209"]);
    expect(classifyHolding(us("MSFT")).groups.map((g) => g.name)).toEqual(["클라우드", "소프트웨어", "인터넷", "인공지능"]);
    // 주요 사업만 넘어온다: 그 외 사업(minorList)에만 있는 테마는 부르는 쪽이 넣지 않는다 (MSFT 양자컴퓨터·TSLA ESS)
    expect(classifyHolding(us("TSLA")).groups.map((g) => g.id)).not.toContain("383");
  });

  it("토스 분류가 깊이 0 만 있으면(SOFI 금융) 네이버 업종으로", () => {
    const r = classifyHolding(us("SOFI"));
    expect(r.groups).toEqual([{ market: "US", kind: "sector", id: "55101030" }]);
    expect(r.reason).toBeNull();
  });

  it("레버리지 단일 종목(RGTX)은 기초 종목(RGTI)의 테마로, 표시는 '리게티 컴퓨팅 2배'", () => {
    const r = classifyHolding(us("RGTX"));
    expect(r.groups.map((g) => g.name)).toEqual(["양자컴퓨터", "IT솔루션구축"]);
    expect(r.via).toEqual({ code: "RGTI", name: "리게티 컴퓨팅", L: 2, inverse: false, index: null });
  });

  it("반도체 지수 상품(SOXL·SOXS·SOXX)은 미국 업종 '반도체', 지수 전체 상품(QQQ·SPY·TQQQ)은 묶지 않는다", () => {
    expect(classifyHolding(us("SOXL"))).toMatchObject({ groups: [{ market: "US", kind: "sector", id: "57101010" }], via: { name: "반도체 지수", L: 3, inverse: false } });
    expect(classifyHolding(us("SOXS")).via).toMatchObject({ L: 3, inverse: true });
    expect(classifyHolding(us("SOXX")).via).toBeNull();
    for (const code of ["QQQ", "SPY", "TQQQ", "VOO"]) {
      const r = classifyHolding(us(code));
      expect(r.groups).toEqual([]);
      expect(r.reason).toBe("index");
    }
    expect(classifyHolding(us("QQQ")).index).toBe("나스닥100 지수");
    expect(Object.keys(INDEX_PRODUCTS)).toContain("SOXL");
  });

  it("테마북을 처음 만드는 중이면 토스 분류가 있는 종목은 '준비 중' (업종으로 먼저 묶지 않는다)", () => {
    expect(classifyHolding(us("NVDA", { bookIds: null })).reason).toBe("preparing");
    // 토스 분류가 없으면 업종으로
    expect(classifyHolding(us("SOFI", { bookIds: null, usTics: [] })).groups[0]!.kind).toBe("sector");
  });

  it("미국 테마북 시세를 받지 못함(만드는 중이 아닌 실패): 토스 분류가 있는 종목은 업종으로 옮기지 않고 '받지 못함' (시세 문구)", () => {
    const r = classifyHolding(us("NVDA", { bookIds: null, bookFailed: true }));
    expect(r).toMatchObject({ groups: [], reason: "failed", why: "book" });
    expect(unmappedText(r.reason!, { code: "NVDA", name: "NVDA", market: "US", why: r.why ?? null })).toBe("NVDA · 미국 테마 시세를 받지 못했습니다 (잠시 뒤 다시 시도)");
    // 토스 분류가 없는 종목(업종만)·지수 상품 표는 그대로 업종
    expect(classifyHolding(us("SOFI", { bookIds: null, bookFailed: true, usTics: [] })).groups[0]!.id).toBe("55101030");
    expect(classifyHolding(us("SOXL", { bookIds: null, bookFailed: true })).groups[0]!.id).toBe("57101010");
  });

  it("분류를 아직 받는 중(3초 안에 못 받음)은 목록 준비와 다른 문구", () => {
    const r = classifyHolding(us("ABCD", { usTics: undefined, usIndustry: undefined, pending: true }));
    expect(r).toMatchObject({ reason: "preparing", why: "classify" });
    expect(unmappedText("preparing", { code: "ABCD", name: "ABCD", market: "US", why: r.why ?? null })).toBe("ABCD · 테마 분류를 받는 중입니다 (잠시 뒤 다시 보여 드립니다)");
    const k = classifyHolding(kr("123456", "작은회사", { krThemes: [], krIndustry: undefined, pending: true }));
    expect(unmappedText("preparing", { code: "123456", name: "작은회사", market: "KR", why: k.why ?? null })).toBe("작은회사 · 테마 분류를 받는 중입니다 (잠시 뒤 다시 보여 드립니다)");
    // 한국 표를 처음 만드는 중은 목록 준비 문구 그대로
    expect(classifyHolding(kr("005930", "삼성전자", { krThemes: null })).why).toBeUndefined();
  });

  it("분류를 받는 중·받지 못함·없음", () => {
    expect(classifyHolding(us("ABCD", { usTics: undefined, usIndustry: undefined, pending: true })).reason).toBe("preparing");
    expect(classifyHolding(us("ABCD", { usTics: null, usIndustry: undefined, failed: true })).reason).toBe("failed");
    expect(classifyHolding(us("ABCD", { usTics: [], usIndustry: null })).reason).toBe("none");
    // 토스는 못 받았어도 업종이 있으면 업종으로
    expect(classifyHolding(us("SOFI", { usTics: null })).groups[0]!.id).toBe("55101030");
  });

  it("한국: 네이버 테마(거꾸로 찾는 표) → 없으면 업종, 표를 처음 만드는 중이면 준비 중, 지수 ETF 는 묶지 않음", () => {
    expect(classifyHolding(kr("005930", "삼성전자", { krThemes: ["543", "12"], krIndustry: "278" })).groups.map(groupKey)).toEqual(["KR:theme:543", "KR:theme:12"]);
    expect(classifyHolding(kr("123456", "작은회사", { krThemes: [], krIndustry: "299" })).groups.map(groupKey)).toEqual(["KR:sector:299"]);
    expect(classifyHolding(kr("005930", "삼성전자", { krThemes: null, krIndustry: "278" })).reason).toBe("preparing");
    expect(classifyHolding(kr("069500", "KODEX 200"))).toMatchObject({ reason: "index", index: "코스피200 지수" });
    expect(classifyHolding(kr("229200", "KODEX 코스닥150"))).toMatchObject({ reason: "index", index: "코스닥150 지수" });
    // 이름에 지수 낱말이 없는 지수 레버리지 (KODEX 레버리지 → 정적 표 069500 코스피200)
    const lev = underlyingOfKind(productKindOf("122630", "KODEX 레버리지", null, "EF"));
    expect(classifyHolding(kr("122630", "KODEX 레버리지", { underlying: lev }))).toMatchObject({ reason: "index", index: "코스피200 지수" });
    expect(krIndexEtf("삼성전자")).toBeNull();
  });

  it("예시 17종목(미국 14 + 한국 3)에서 연결 14종목 이상 (로드맵 80%)", () => {
    const US14 = ["SOXL", "RGTX", "NVDA", "AAPL", "MSFT", "META", "AVGO", "TSLA", "PLTR", "IONQ", "SOFI", "QQQ", "RGTI", "AMZN"];
    const rs = [
      ...US14.map((c) => classifyHolding(us(c))),
      classifyHolding(kr("005930", "삼성전자", { krThemes: ["543"], krIndustry: "278" })),
      classifyHolding(kr("000660", "SK하이닉스", { krThemes: ["543"], krIndustry: "278" })),
      classifyHolding(kr("123456", "작은회사", { krThemes: [], krIndustry: "299" })),
    ];
    const mapped = rs.filter((r) => r.groups.length).length;
    expect(rs).toHaveLength(17);
    expect(mapped).toBeGreaterThanOrEqual(14);
    expect(mapped).toBe(16); // QQQ 만 지수 전체 상품
  });

  it("토스 회사 테마 응답 읽기: majorList · minorList (id 숫자 → 글자)", () => {
    const r = parseCompanyTics({ baseDate: "2020-12-01T00:00:00", majorList: [{ id: 295, title: "전기차", ordering: 1 }, { id: 291, title: "자동차브랜드" }], minorList: [{ id: 383, title: "ESS" }] });
    expect(r.major).toEqual([
      { id: "295", title: "전기차" },
      { id: "291", title: "자동차브랜드" },
    ]);
    expect(r.minor).toEqual([{ id: "383", title: "ESS" }]);
    expect(parseCompanyTics(null)).toEqual({ major: [], minor: [] });
  });
});

describe("많이 속한 테마 (설계 2.2 ①)", () => {
  const values: Record<string, number> = { NVDA: 5_000_000, AVGO: 1_000_000, MSFT: 3_000_000, RGTI: 500_000, RGTX: 2_000_000, AMZN: 800_000 };
  const v = (c: string) => values[c] ?? null;

  it("2종목 이상만, 종목 수 → 평가금액 합 → 이름 순, 최대 3개", () => {
    const r = mostHeld(
      [
        { key: "a", name: "반도체팹리스", codes: ["NVDA", "AVGO"] }, // 2 · 6,000,000
        { key: "b", name: "인공지능", codes: ["NVDA", "MSFT", "AMZN"] }, // 3
        { key: "c", name: "양자컴퓨터", codes: ["RGTI", "RGTX"] }, // 2 · 2,500,000 (기초 + 레버리지 둘 다 셈)
        { key: "d", name: "인터넷", codes: ["MSFT", "AMZN"] }, // 2 · 3,800,000
        { key: "e", name: "클라우드", codes: ["MSFT"] },
      ],
      v,
    );
    expect(r.map((x) => [x.name, x.count])).toEqual([
      ["인공지능", 3],
      ["반도체팹리스", 2],
      ["인터넷", 2],
    ]);
  });

  it("2종목 이상 든 묶음이 없으면 평가금액이 가장 큰 종목의 첫 묶음 하나 (1종목 — '많이'를 지어내지 않음)", () => {
    const r = mostHeld(
      [
        { key: "x", name: "클라우드", codes: ["MSFT"] },
        { key: "y", name: "반도체팹리스", codes: ["NVDA"] },
      ],
      v,
    );
    expect(r).toEqual([{ key: "y", name: "반도체팹리스", count: 1, codes: ["NVDA"] }]);
    expect(mostHeld([], v)).toEqual([]);
  });
});

describe("등락률 높은 3개 · 낮은 3개", () => {
  const rows = (rates: Array<number | null>) => rates.map((rate, i) => ({ name: `테마${String(i).padStart(2, "0")}`, rate }));

  it("12개: 높은 3개와 낮은 3개(낮은 것부터), 겹치지 않음", () => {
    const r = topBottom(rows([1, 5, -2, 3, 0, -7, 2, 4, -1, 6, -3, 0.5]));
    expect(r.split).toBe(true);
    expect(r.top.map((x) => x.rate)).toEqual([6, 5, 4]);
    expect(r.bottom.map((x) => x.rate)).toEqual([-7, -3, -2]);
  });

  it("6개면 나누고, 5개·1개는 나누지 않고 높은 순 하나로", () => {
    expect(topBottom(rows([1, 2, 3, 4, 5, 6])).split).toBe(true);
    const five = topBottom(rows([1, 2, 3, 4, 5]));
    expect(five.split).toBe(false);
    expect(five.all.map((x) => x.rate)).toEqual([5, 4, 3, 2, 1]);
    expect(topBottom(rows([1])).split).toBe(false);
  });

  it("같은 값은 이름순, 값 없는 묶음은 맨 뒤이고 순위에 넣지 않음", () => {
    const r = topBottom([
      { name: "나", rate: 1 },
      { name: "가", rate: 1 },
      { name: "다", rate: null },
      { name: "라", rate: 2 },
      { name: "마", rate: -1 },
      { name: "바", rate: 0 },
      { name: "사", rate: 3 },
    ]);
    expect(r.all.map((x) => x.name)).toEqual(["사", "라", "가", "나", "바", "마", "다"]);
    expect(r.split).toBe(true);
    expect(r.bottom.map((x) => x.name)).toEqual(["마", "바", "나"]);
  });
});

describe("거래대금 평소 (설계 3.4)", () => {
  const days = (n: number, v = 100, start = "2026-08-01"): TvDay[] =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(`${start}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return { day: d.toISOString().slice(0, 10), tv: { "theme:1": v + i } };
    });

  it("기록 0·4·5·19·25·30일: 5개 미만이면 비율 없음, 평소는 가장 최근 20개 평균", () => {
    expect(tvBaseline([], "theme:1", null)).toEqual({ avg: null, days: 0 });
    const four = tvBaseline(days(4), "theme:1", null);
    expect(four.days).toBe(4);
    expect(tvRatio(200, four.avg, four.days)).toBeNull();
    const five = tvBaseline(days(5), "theme:1", null);
    expect(five).toEqual({ avg: 102, days: 5 });
    expect(tvRatio(204, five.avg, five.days)).toBe(200);
    expect(tvBaseline(days(19), "theme:1", null).days).toBe(19);
    // 25일 중 가장 최근 20일 (105~124 → 평균 114.5)
    expect(tvBaseline(days(25), "theme:1", null)).toEqual({ avg: 114.5, days: 20 });
    expect(tvBaseline(days(30), "theme:1", null).days).toBe(20);
  });

  it("오늘(excludeDay)은 평소에서 뺀다", () => {
    const ds = days(6);
    const last = ds.at(-1)!.day;
    expect(tvBaseline(ds, "theme:1", last)).toEqual({ avg: 102, days: 5 });
  });

  it("평소가 0 이면 비율 없음, 1,000% 넘는 값도 그대로 (앱이 '넘음'으로 보임)", () => {
    expect(tvRatio(10, 0, 20)).toBeNull();
    expect(tvRatio(1_234, 100, 20)).toBe(1234);
  });

  it("기록 넣기: 같은 날은 바꾸고 최근 25개만", () => {
    let d: TvDay[] = [];
    for (const x of days(30)) d = pushTvDay(d, x);
    expect(d).toHaveLength(TV_KEEP_DAYS);
    expect(d[0]!.day).toBe("2026-08-06");
    d = pushTvDay(d, { day: d.at(-1)!.day, tv: { "theme:1": 1 } });
    expect(d).toHaveLength(TV_KEEP_DAYS);
    expect(d.at(-1)!.tv["theme:1"]).toBe(1);
  });
});

describe("문구 (설계 2.6)", () => {
  it("서버가 만드는 모든 문구가 금지어 검사를 통과한다", () => {
    const texts = allServerTexts();
    expect(texts.length).toBeGreaterThan(20);
    for (const t of texts) expect(themeWordingProblems(t), t).toEqual([]);
  });

  it("금지어 검사가 실제로 잡는다 (강세·수혜·주목·전망·수 있습니다)", () => {
    expect(themeWordingProblems("반도체 강세 테마")).toContain("강세");
    expect(themeWordingProblems("수혜 테마")).toContain("수혜");
    expect(themeWordingProblems("주목할 테마")).toContain("주목");
    expect(themeWordingProblems("오를 수 있습니다")).toEqual(expect.arrayContaining(["오를", "수 있습니다"]));
  });

  it("연결하지 못한 종목 문구 (설계 표)", () => {
    expect(unmappedText("index", { code: "QQQ", name: "QQQ", market: "US", index: "나스닥100 지수" })).toBe("QQQ · 나스닥100 지수 전체를 따르는 상품이라 테마로 묶지 않았습니다");
    expect(unmappedText("index", { code: "X", name: "X", market: "US" })).toBe("X · 지수 전체를 따르는 상품이라 테마로 묶지 않았습니다");
    expect(unmappedText("none", { code: "ABCD", name: "ABCD", market: "US" })).toBe("ABCD · 미분류 · 테마·업종 정보가 없습니다");
    expect(unmappedText("failed", { code: "ABCD", name: "ABCD", market: "US" })).toBe("ABCD · 분류를 받지 못했습니다 (잠시 뒤 다시 시도)");
    expect(unmappedText("preparing", { code: "005930", name: "삼성전자", market: "KR" })).toBe("삼성전자 · 한국 테마 목록을 처음 준비하는 중입니다 (약 2분)");
  });

  it("시장 안내 줄이 사실과 같다: 한국 표를 준비하는 동안 한국 종목은 업종으로도 묶지 않는다", () => {
    expect(MARKET_NOTE_KR_INDEX).toBe("한국 테마 목록을 처음 준비하는 중이라 한국 종목은 준비가 끝나면 보여 드립니다");
    expect(classifyHolding(kr("005930", "삼성전자", { krThemes: null, krIndustry: "278" })).groups).toEqual([]);
    expect(ticsMissingNote(2)).toBe("토스 테마 분류를 받지 못한 2종목은 업종으로 묶었습니다 (잠시 뒤 다시 받습니다)");
    for (const t of [MARKET_NOTE_KR_INDEX, MARKET_NOTE_US_BOOK_FAILED, ticsMissingNote(2)]) expect(themeWordingProblems(t), t).toEqual([]);
  });

  it("기준 줄: 한국 테마 구성을 받은 시각이 있을 때만 마지막 줄", () => {
    expect(basisLines(null).some((l) => l.includes("주 1회"))).toBe(false);
    expect(basisLines(koDateTime("2026-09-27T05:40:00+09:00")).at(-1)).toBe("한국 테마 구성은 주 1회 받은 목록입니다 (마지막: 9월 27일 (일) 05:40).");
  });
});
