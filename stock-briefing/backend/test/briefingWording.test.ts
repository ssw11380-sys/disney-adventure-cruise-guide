import { describe, expect, it } from "vitest";
import { computeTechnicalSummary } from "../src/analysis/indicators.js";
import type { Quote } from "../src/domain/types.js";
import { snapshotForPrompt } from "../src/services/briefingService.js";
import {
  cleanDetail,
  cleanPrevious,
  codeSummaryLine,
  countLine,
  findBanned,
  safeSummary,
  sourceText,
  unknownNumbers,
  type WordingSnapshot,
} from "../src/services/briefingWording.js";
import type { BriefingSnapshot } from "../src/services/collector.js";
import { makeQuote } from "./helpers.js";

/**
 * 브리핑 2차 6 — 종목 브리핑 AI 글 검사기 (순수 함수, 플래그 briefingSafeWording).
 * 금지어 검사 · 오탐 막기 · 출처 예외 · 가격 줄 · 개수 줄 · 두 줄 요약 · 상세 정리 · 직전 요약 정리 · 숫자 대조(로그만) · 프롬프트 데이터
 */

const q = (over: Partial<Quote>): Quote => ({ ...makeQuote("000660", "toss"), ...over });
const news = (title: string, summary: string | null = null) => ({ title, url: "https://example.com", source: "한경", publishedAt: "2026-09-22T00:00:00.000Z", summary });
const disc = (title: string) => ({ receiptNo: "1", title, filedAt: "2026-09-22", filer: "SK하이닉스", url: "https://dart.fss.or.kr" });
const snap = (over: Partial<WordingSnapshot> = {}): WordingSnapshot => ({ quote: q({ price: 84_300, changeRate: 3.56, priceBasis: "KRX 정규장" }), news: [], disclosures: [], ...over });

describe("금지어 검사 (findBanned)", () => {
  it.each([
    "뉴스 요약 (긍정)",
    "가까운 지지 $171.06, 저항 $185.32",
    "다음 세션 체크포인트",
    "85,000원 저항 확인",
    "저가 매수 기회",
    "오를 것으로 보입니다",
    "보유자 관점에서 의미 있는 구간",
    "RSI 과매수 구간",
    "비중을 줄이세요",
    "이익 실현을 고려하세요",
    "지금이 기회입니다",
    "오를 전망입니다",
    "반등이 기대된다",
    "상승 여력이 있습니다",
    "추가 상승을 확인하겠습니다",
  ])("걸림: %s", (line) => expect(findBanned(line, "")).not.toBeNull());

  it.each([
    "외국인 순매수 3일째",
    "기관 매도세 이어짐",
    "지지부진한 거래",
    "매도 우위",
    "외국인 매수 우위",
    "공개매수 발표",
    "고려아연 자사주 소각",
    "지지율 조사 발표",
    "이번 달 거래량 증가",
    "실적 전망 상향 (한경)",
    "RSI(14) 58.20",
  ])("안 걸림 (수급 사실·비슷한 낱말): %s", (line) => expect(findBanned(line, "")).toBeNull());

  it("출처 예외: 출처에 그대로 있는 더 긴 말의 일부면 넘어가고, 따로 쓰인 말은 줄째로 같아도 걸린다", () => {
    expect(findBanned("- 주식매수선택권부여에관한신고 (공시)", "주식매수선택권부여에관한신고")).toBeNull();
    expect(findBanned("- 증권가 목표가 상향 (한경)", "증권가, SK하이닉스 목표가 상향")).toBe("목표가");
    expect(findBanned("- 관세 우려에 반도체 약세 (연합뉴스)", "관세 우려에 반도체 약세")).toBe("우려");
  });

  it("출처 글은 뉴스 제목·요약과 공시 제목을 잇는다 (없으면 빈 글)", () => {
    expect(sourceText(snap({ news: [news("제목 1", "요약 1"), news("제목 2")], disclosures: [disc("공시 1")] }))).toBe("제목 1\n요약 1\n제목 2\n공시 1");
    expect(sourceText(snap({ news: null, disclosures: null }))).toBe("");
  });
});

describe("가격 줄 (codeSummaryLine)", () => {
  it("원화 · 정규장 기준은 붙이지 않는다", () => {
    expect(codeSummaryLine(q({ price: 84_300, changeRate: 3.56, priceBasis: "KRX 정규장" }))).toBe("84,300원 · 전일 대비 +3.56%");
    expect(codeSummaryLine(q({ price: 84_300.4, changeRate: 3.56, priceBasis: "정규장" }))).toBe("84,300원 · 전일 대비 +3.56%");
  });
  it("원화 · KRX+NXT 통합 → (NXT 포함)", () => {
    expect(codeSummaryLine(q({ price: 84_300, changeRate: 3.56, priceBasis: "KRX+NXT 통합" }))).toBe("84,300원 · 전일 대비 +3.56% (NXT 포함)");
  });
  it("달러 1 이상은 천 단위 쉼표·소수 2자리, 기준 없음", () => {
    expect(codeSummaryLine(q({ currency: "USD", price: 1234.5, changeRate: 0.12 }))).toBe("$1,234.50 · 전일 대비 +0.12%");
  });
  it("1달러 미만은 소수 4자리", () => {
    expect(codeSummaryLine(q({ currency: "USD", price: 0.81234, changeRate: -2.5, priceBasis: "정규장" }))).toBe("$0.8123 · 전일 대비 -2.50%");
  });
  it("주간거래 · 시간외 포함 · 시세 지연은 기준 표시 뒤", () => {
    expect(codeSummaryLine(q({ currency: "USD", price: 11.34, changeRate: -9.79, priceBasis: "주간거래" }))).toBe("$11.34 · 전일 대비 -9.79% (주간거래)");
    expect(codeSummaryLine(q({ currency: "USD", price: 10.61, changeRate: -6.44, priceBasis: "최근 체결(시간외 포함)" }))).toBe("$10.61 · 전일 대비 -6.44% (시간외 포함)");
    expect(codeSummaryLine(q({ currency: "USD", price: 10.61, changeRate: -6.44, priceBasis: "최근 체결(시간외 포함)", stale: true }))).toBe("$10.61 · 전일 대비 -6.44% (시간외 포함) (시세 지연)");
    expect(codeSummaryLine(q({ price: 84_300, changeRate: 1, priceBasis: "프리마켓" }))).toBe("84,300원 · 전일 대비 +1.00% (프리마켓)");
  });
  it("등락률 0 · 시세 없음", () => {
    expect(codeSummaryLine(q({ price: 84_300, changeRate: 0, priceBasis: "KRX 정규장" }))).toBe("84,300원 · 전일 대비 0.00%");
    expect(codeSummaryLine(null)).toBe("가격 확인 안 됨");
  });
});

describe("개수 줄 (countLine)", () => {
  it("뉴스·공시 모두 확인 안 됨", () => expect(countLine(snap({ news: null, disclosures: null }))).toBe("뉴스·공시 확인 안 됨"));
  it("뉴스 N개 · 공시 M개", () => {
    expect(countLine(snap({ news: [news("a"), news("b")], disclosures: [disc("c")] }))).toBe("최근 뉴스 2건 · 공시 1건");
    expect(countLine(snap({ news: [news("a")], disclosures: [] }))).toBe("최근 뉴스 1건");
    expect(countLine(snap({ news: [], disclosures: [disc("c")] }))).toBe("공시 1건");
    expect(countLine(snap({ news: [], disclosures: [] }))).toBe("새 뉴스·공시 없음");
  });
  it("공시 확인 안 됨 (뉴스만)", () => {
    expect(countLine(snap({ news: [news("a"), news("b"), news("c")], disclosures: null }))).toBe("최근 뉴스 3건");
    expect(countLine(snap({ news: [], disclosures: null }))).toBe("새 뉴스 없음");
  });
  it("뉴스 확인 안 됨 (공시만)", () => {
    expect(countLine(snap({ news: null, disclosures: [disc("c"), disc("d")] }))).toBe("공시 2건");
    expect(countLine(snap({ news: null, disclosures: [] }))).toBe("새 공시 없음");
  });
});

describe("두 줄 요약 (safeSummary)", () => {
  const FAKE = "- **주가** 100,000원 (+1.01%)\n2. 뉴스 요약 한 줄\n3. 내일 체크포인트\n4. 넘치는 줄";
  it("가짜 모델 요약 → 가격 줄 + 가격 숫자가 없는 첫 사실 줄", () => {
    expect(safeSummary(snap(), FAKE)).toBe("84,300원 · 전일 대비 +3.56%\n뉴스 요약 한 줄");
  });
  it("모두 걸리거나 숫자 줄뿐이면 가격 줄 + 개수 줄", () => {
    const s = snap({ news: [news("a")], disclosures: [] });
    expect(safeSummary(s, "84,300원 마감\n+3.56% 상승\n저가 매수 기회입니다")).toBe("84,300원 · 전일 대비 +3.56%\n최근 뉴스 1건");
    expect(safeSummary(snap({ news: null, disclosures: null }), "$12.30 거래\n다음 세션 체크포인트")).toBe("84,300원 · 전일 대비 +3.56%\n뉴스·공시 확인 안 됨");
    expect(safeSummary(snap(), "")).toBe("84,300원 · 전일 대비 +3.56%\n새 뉴스·공시 없음");
  });
  it("첫 줄과 같은 줄은 건너뛴다 · 시세가 없으면 '가격 확인 안 됨'", () => {
    expect(safeSummary(snap({ quote: null }), "가격 확인 안 됨\n외국인 순매수 3일째")).toBe("가격 확인 안 됨\n외국인 순매수 3일째");
  });
});

describe("상세 글 정리 (cleanDetail)", () => {
  const OK = "## 한 줄 요약\n실적 발표가 있었습니다.\n\n## 주가 흐름\n종가 84,300원 (+3.56%)\n\n## 수급\n외국인 순매수 3일째";

  it("걸린 것이 없으면 글자 하나 바꾸지 않는다", () => {
    const r = cleanDetail(OK, "");
    expect(r.text).toBe(OK);
    expect(r.dropped).toBe(0);
    const crlf = OK.replace(/\n/g, "\r\n");
    expect(cleanDetail(crlf, "").text).toBe(crlf);
  });

  it("걸린 줄만 빼고 끝에 안내 줄", () => {
    const r = cleanDetail("## 뉴스와 공시\n- 신규 수주 공시 (공시)\n- 증권가 전망 기사 (긍정)\n\n## 수급\n외국인 순매수 3일째", "");
    expect(r.text).toBe("## 뉴스와 공시\n- 신규 수주 공시 (공시)\n\n## 수급\n외국인 순매수 3일째\n\n(문장 검사에서 1줄을 뺐습니다)");
    expect(r.dropped).toBe(1);
  });

  it("걸린 제목(## 다음 세션 체크포인트)은 그 아래 줄까지 모두 뺀다", () => {
    const r = cleanDetail("## 주가 흐름\n종가 84,300원\n\n## 다음 세션 체크포인트\n1. 85,000원\n2. 실적 발표\n3. 거래량\n\n## 수급\n외국인 순매수", "");
    expect(r.text).toBe("## 주가 흐름\n종가 84,300원\n\n## 수급\n외국인 순매수\n\n(문장 검사에서 3줄을 뺐습니다)");
    expect(r.dropped).toBe(3);
  });

  it("내용 줄이 모두 빠진 제목도 뺀다 (빈 제목)", () => {
    const r = cleanDetail("## 주가 흐름\n종가 84,300원\n\n## 기술적 상황\n가까운 지지 $171.06, 저항 $185.32\nRSI 과매수 구간\n\n## 수급\n외국인 순매수", "");
    expect(r.text).toBe("## 주가 흐름\n종가 84,300원\n\n## 수급\n외국인 순매수\n\n(문장 검사에서 2줄을 뺐습니다)");
    expect(r.dropped).toBe(2);
  });

  it("빈 줄이 3줄 넘게 이어지면 1줄로", () => {
    const r = cleanDetail("## 가\n첫 줄\n\n\n오를 전망입니다\n\n\n끝 줄", "");
    expect(r.text).toBe("## 가\n첫 줄\n\n끝 줄\n\n(문장 검사에서 1줄을 뺐습니다)");
  });

  it("출처 예외: 공시 제목 속 긴 말은 남는다", () => {
    const detail = "## 뉴스와 공시\n- 주식매수선택권부여에관한신고 (공시)";
    expect(cleanDetail(detail, "주식매수선택권부여에관한신고")).toEqual({ text: detail, dropped: 0 });
  });
});

describe("직전 브리핑 요약 정리 (cleanPrevious)", () => {
  it("걸린 것이 없으면 그대로", () => {
    const s = "2026-09-22 오전: 84,300원 · 전일 대비 +3.56%\n외국인 순매수 3일째";
    expect(cleanPrevious(s, "")).toBe(s);
  });
  it("날짜 머리는 두고 걸린 줄을 뺀다", () => {
    expect(cleanPrevious("2026-09-22 오전: 주가 184만원 마감\n189만원 저항 확인\n외국인 순매수", "")).toBe("2026-09-22 오전: 주가 184만원 마감\n외국인 순매수");
    // 첫 줄이 걸리면 둘째 줄이 머리 뒤로
    expect(cleanPrevious("2026-09-22 오후: 내일 체크포인트\n외국인 순매수", "")).toBe("2026-09-22 오후: 외국인 순매수");
  });
  it("모두 걸리면 '(검사에서 모두 뺌)'", () => {
    expect(cleanPrevious("2026-09-22 오후: 가까운 지지 $171.06\n다음 세션 체크포인트", "")).toBe("2026-09-22 오후: (검사에서 모두 뺌)");
  });
});

describe("숫자 대조 (unknownNumbers, 로그만)", () => {
  it("데이터에 없는 숫자를 센다 (10 이하 정수·쉼표·소수 자리 차이는 넘어감)", () => {
    const r = unknownNumbers("주가 84,300원 (+3.56%), RSI 58.20, 91,000원", '{"price":84300,"changeRate":3.56,"rsi14":58.2}');
    expect(r.count).toBe(1);
    expect(r.sample[0]).toContain("91,000");
  });
  it("연·월·순서·작은 정수는 보지 않는다", () => {
    expect(unknownNumbers("2026년 9월 실적, 3일 연속, 5번째, 2건", "")).toEqual({ count: 0, sample: [] });
  });
  it("표본은 앞 5개", () => {
    const r = unknownNumbers("11원, 12원, 13원, 14원, 15원, 16원, 17원", "");
    expect(r.count).toBe(7);
    expect(r.sample).toEqual(["11원", "12원", "13원", "14원", "15원"]);
  });
});

describe("프롬프트 데이터 (snapshotForPrompt)", () => {
  const candles = Array.from({ length: 130 }, (_, i) => {
    const c = 100_000 + Math.round(Math.sin(i / 7) * 5000) + i * 50;
    return { date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), open: c - 200, high: c + 800, low: c - 900, close: c, volume: 1_000_000 + i * 1000 };
  });
  const technical = computeTechnicalSummary(candles)!;
  const s: BriefingSnapshot = {
    stock: { code: "000660", name: "SK하이닉스", market: "KOSPI", quantity: 10, avgPrice: 150_000 },
    quote: makeQuote("000660", "kis"),
    recentCandles: candles.slice(-10),
    technical,
    news: [news("SK하이닉스 뉴스")],
    disclosures: null,
    investorFlow: null,
    holding: null,
    missing: [],
  };

  it("옵션 없으면 예전과 같은 객체", () => {
    expect(snapshotForPrompt(s)).toEqual({
      stock: s.stock,
      marketState: null,
      quote: s.quote,
      holding: null,
      technical,
      recentCandles: s.recentCandles,
      news: [{ title: "SK하이닉스 뉴스", source: "한경", publishedAt: "2026-09-22T09:00", summary: null }],
      disclosures: undefined,
      investorFlow: null,
    });
    expect(snapshotForPrompt(s, {})).toEqual(snapshotForPrompt(s));
    expect(snapshotForPrompt(s, { safe: false })).toEqual(snapshotForPrompt(s));
  });

  it("safe 면 지지·저항 후보·RSI 구간 이름·MACD 교차 이름만 빠지고 maAlignment 는 남는다", () => {
    const t = snapshotForPrompt(s, { safe: true }).technical as Record<string, unknown>;
    expect(t).not.toHaveProperty("supportResistance");
    expect(t).not.toHaveProperty("rsiZone");
    expect(t).not.toHaveProperty("macdCross");
    expect(t.maAlignment).toBe(technical.maAlignment);
    const { supportResistance: _s, rsiZone: _r, macdCross: _m, ...rest } = technical;
    expect(t).toEqual(rest);
    // 원본 스냅숏은 건드리지 않는다
    expect(s.technical).toHaveProperty("supportResistance");
    expect(snapshotForPrompt({ ...s, technical: null }, { safe: true }).technical).toBeNull();
  });
});
