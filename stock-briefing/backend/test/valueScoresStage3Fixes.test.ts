import { describe, expect, it } from "vitest";
import { compactCompanyFacts, dividendCutOf, FactBook, mergeCompanyFacts, PREDECESSOR_CIK, spanKind, splitFactor } from "../src/analysis/secFacts.js";
import { scoreWordingProblems } from "../src/analysis/scoreWording.js";
import { REFERENCE_DROP_MAX_DAYS, REFERENCE_STALE_DAYS, referenceDrop } from "../src/services/valueReference.js";
import { defaultValueSources, metricRow } from "../src/services/valueScoreService.js";
import { mixText, topTieNote, VALUE_STATUS_TEXT } from "../src/services/valueScoreText.js";
import { valueAboutOf, VALUE_ABOUT } from "../src/services/indicatorScoreText.js";
import type { MetricScore } from "../src/analysis/valueScore.js";
import type { EdgarProvider } from "../src/providers/dart/edgar.js";
import type { NasdaqScreener } from "../src/providers/market/nasdaqScreener.js";
import { secExtra, SEC_EXTRA } from "./fixtures/valueScores/load.js";

/**
 * 3-44 2단계 검토에서 남은 지적 (3단계와 함께 고침): 비교 기준 거절·묵음 규칙 · 분할 배수 · 특별배당 뒤 '배당 삭감' · 순현금 안내 ·
 * 비교 비중 겹침 · 금융사 설명 줄 · 받은 뒤 SEC 목록에서 빠진 까닭 · COST 12·12·12·16주 분기 · XOM 지주회사 전환.
 * 네트워크 없음 — SEC 재무는 2026-09-28 에 받은 원본을 줄인 것(test/fixtures/valueScores/sec)
 */

const book = (t: (typeof SEC_EXTRA)[number]) => new FactBook(compactCompanyFacts(secExtra(t), "2017-06-01"));
const AS_OF = "2026-09-28";

describe("(a) 비교 기준: 새 기준을 거절하는 동안 지켜 둔 지난 기준이 '점수 없음'이 되지 않는다", () => {
  const counts = (universe: number) => ({ screener: 7000, mapped: 5000, withData: 3800, universe, general: universe - 400, financial: 400 });
  const prev = { refDate: "2026-09-26", counts: counts(3000) };
  const shrunk = (refDate: string) => ({ refDate, counts: counts(1200) });
  it("지난 기준이 13일까지면 치우친 새 기준을 거절하고, 14일째(점수 없음 기준 14일에 닿기 전)부터는 받아들인다", () => {
    expect(REFERENCE_STALE_DAYS).toBe(14);
    expect(REFERENCE_DROP_MAX_DAYS).toBe(13);
    // 토 9/26 기준 → 다음 토 10/3 새 기준 거절 → 매일 09:15 다시 (10/4~10/9 거절)
    for (const d of ["2026-10-03", "2026-10-06", "2026-10-09"]) expect(referenceDrop(prev, shrunk(d))).toMatch(/크게 줄어/);
    // 10/10 = 지난 기준 14일째: 이날까지는 지난 기준으로도 점수가 있다(14일 넘어야 점수 없음) — 새 기준을 받아들여 묵지 않게
    expect(referenceDrop(prev, shrunk("2026-10-10"))).toBeNull();
    // 2단계 규칙(35일)이면 10/11~10/31 사이에 새 기준은 거절되고 지난 기준은 '2주 넘게 갱신되지 않았습니다'가 되었다
  });
});

describe("(b) 분할 배수는 가장 가까운 흔한 배수로 (LRCX 10:1 이 9.5 로 덜 맞춰지던 것)", () => {
  it("흔한 배수와 8% 안이면 그 배수, 아니면 비율 그대로, 40% 안 변화는 1, 1,000배 안팎은 단위 바뀜", () => {
    // LRCX 2023 회계연도 (2024년 10:1 분할을 되짚어 고친 주식 수): 1억 4,063만 → 13억 5,834만 = 9.66배
    const lrcx = book("LRCX").annualHistory(AS_OF, 7);
    const y22 = lrcx.find((a) => a.end === "2022-06-26")!;
    const y23 = lrcx.find((a) => a.end === "2023-06-25")!;
    expect(y23.shares! / y22.shares!).toBeCloseTo(9.659, 3);
    expect(splitFactor(y22.shares, y23.shares)).toBe(10);
    expect([splitFactor(100, 199.1), splitFactor(100, 391.9), splitFactor(100, 146.3), splitFactor(100, 149.8), splitFactor(1000, 101), splitFactor(100, 120)]).toEqual([2, 4, 1.5, 1.5, 1 / 10, 1]);
    // 흔한 배수와 멀면 비율 그대로 (합병 등) — 예전처럼 0.5 단위로 맞추지 않는다
    expect(splitFactor(100, 175)).toBe(1.75);
    // WRB: 2022년까지 천 주 단위 → 2023 주 단위 (419,192 → 409,948,000) = 분할 아님
    expect(splitFactor(419_192, 409_948_000)).toBe(1);
    expect(splitFactor(279_749, 419_192)).toBe(1.5);
    // 10:1 분할 해의 주당배당 0.69 × 10 = 6.9 ≥ 앞 해 6.0 — 줄어든 해 아님 (0.5 단위 9.5 였으면 6.56)
    expect(book("LRCX").dividendCut(AS_OF)).toBe(false);
  });
});

describe("(c) 배당 삭감 표시: 특별배당을 준 해의 다음 해는 앞앞 해와도 견준다 (두 앞 해 모두보다 적을 때만)", () => {
  it("실제 재무: 특별배당 뒤 해로 잘못 붙던 FAST·CTAS·WRB·COST 는 표시 없음, 실제로 줄인 INTC 2023·T 2022·MMM 2024 는 표시", () => {
    const got = Object.fromEntries((["FAST", "CTAS", "WRB", "COST", "INTC", "T", "MMM", "LRCX", "F"] as const).map((t) => [t, book(t).dividendCut(AS_OF)]));
    expect(got).toEqual({ FAST: false, CTAS: false, WRB: false, COST: false, INTC: true, T: true, MMM: true, LRCX: false, F: true });
  });
  it("F(포드)는 특별배당 뒤 해(2023 1.25 → 2024 0.78)로는 표시하지 않지만, 배당을 멈췄다가 다시 준 2021(0.10 < 2020 0.15 < 2019 0.60)이 최근 6개 회계연도 안이라 표시가 남는다 (맞는 표시)", () => {
    const ys = book("F").dividendYears(AS_OF);
    expect(ys.map((y) => [y.end.slice(0, 4), y.dps])).toEqual([
      ["2019", 0.6],
      ["2020", 0.15],
      ["2021", 0.1],
      ["2022", 0.5],
      ["2023", 1.25],
      ["2024", 0.78],
      ["2025", 0.75],
    ]);
    // 2021 을 뺀 2022~2025 만 보면: 2024(특별배당 뒤)는 아니고, 2025(0.75 < 0.78 · < 1.25)는 보조 배당이 줄어 1주당 배당이 줄어든 해
    const tail = ys.slice(3);
    expect(dividendCutOf(tail.slice(0, 3))).toBe(false);
    expect(dividendCutOf(tail)).toBe(true);
  });
  it("규칙: 앞 해만 크고(특별배당) 앞앞 해보다는 크면 줄어든 해가 아님, 앞앞 해 값이 없으면 앞 해만, 분할은 두 쌍 모두 맞춤", () => {
    const y = (dps: number | null, shares = 100) => ({ dps, shares });
    // COST 식: 3.84 → 19.36(특별 15) → 4.92
    expect(dividendCutOf([y(3.84), y(19.36), y(4.92)])).toBe(false);
    // 특별배당 없이 실제로 줄임
    expect(dividendCutOf([y(1), y(1.1), y(0.6)])).toBe(true);
    // 앞앞 해 값이 없으면(배당 시작 해) 앞 해와만
    expect(dividendCutOf([y(null), y(1.46), y(0.74)])).toBe(true);
    // FAST 식: 앞앞 해가 2:1 분할 전(1.24 · 5.8억 주) → 앞 해 0.89(11.5억 주, 특별 포함) → 0.78 : 앞앞 해를 분할 뒤 기준 0.62 로 맞추면 0.78 은 줄지 않음
    expect(dividendCutOf([y(1.24, 575), y(0.89, 1146), y(0.78, 1148)])).toBe(false);
    // 여섯 해(다섯 쌍)만 본다 — 일곱 번째 앞 해는 첫 쌍의 앞앞 해로만
    expect(dividendCutOf([y(5), y(1), y(1), y(1), y(1), y(1), y(1)])).toBe(false);
  });
});

describe("(d)·(f) 순현금 안내와 비교 비중 글", () => {
  const d2: MetricScore = { key: "D2", adopted: true, x: Infinity, show: -5, rule: "topTie", why: "netCash", score: 73, pos: { industry: 68, market: 79 }, mix: { industry: 50, market: 50 }, peer: { level: "industry", name: "IndA", n: 60, median: Infinity, tie: 0.64, tieX: Infinity }, ownN: 0 };
  it("지표 줄의 '위치 점수 73'과 안내의 가운데 값(68)이 어긋나 보이지 않게 — '업종 안 위치는 … (68)'", () => {
    const row = metricRow(d2);
    expect(row.score).toBe(73);
    expect(row.note).toBe("업종 비교 회사의 64%가 같은 맨 위 순위라, 업종 안 위치는 그 무리의 가운데 값(68)입니다.");
    expect(topTieNote("금융사 전체", 40, 80)).toBe("금융사 전체 비교 회사의 40%가 같은 맨 위 순위라, 금융사 전체 안 위치는 그 무리의 가운데 값(80)입니다.");
  });
  it("업종 자리가 시장으로 내려가면 '시장 50 · 시장 50' 대신 '시장 100' (금융사 '금융사 전체 100')", () => {
    expect(mixText({ industry: 50, market: 50 }, "market")).toBe("시장 100");
    expect(mixText({ industry: 50, market: 50 }, "market", "financial")).toBe("금융사 전체 100");
    expect(mixText({ industry: 71.4, market: 28.6 }, "market")).toBe("시장 100");
    expect(mixText({ industry: 50, market: 50 }, "industry", "financial")).toBe("업종 50 · 금융사 전체 50");
    const atMarket = metricRow({ ...d2, rule: undefined, why: undefined, x: 0.1, pos: { industry: 66, market: 66 }, peer: { ...d2.peer!, level: "market", name: null, tie: 0.01, tieX: 0.1, median: 0.1 } }, { path: "financial", annualEnd: null });
    expect(atMarket.mix).toBe("금융사 전체 100");
  });
});

describe("(g)·(h) 설명 줄과 까닭 글", () => {
  it("가치 설명 줄은 비교한 무리에 맞춘다: 금융사 '업종·금융사 전체', 한국 '업종·한국 시장'", () => {
    expect(valueAboutOf("general")).toBe(VALUE_ABOUT);
    expect(valueAboutOf("financial")).toBe("재무 숫자가 같은 업종·금융사 전체 회사들 사이 어디쯤인지");
    expect(valueAboutOf("general", "KR")).toBe("재무 숫자가 같은 업종·한국 시장 회사들 사이 어디쯤인지");
    expect(valueAboutOf("financial", "KR")).toBe("재무 숫자가 같은 업종·한국 금융사 전체 회사들 사이 어디쯤인지");
  });
  it("받은 뒤 SEC 목록에서 빠짐 → '상장 폐지·합병·티커 변경 등' (처음부터 없는 종목은 '외국 회사·새로 상장한 회사 등')", () => {
    expect(VALUE_STATUS_TEXT.notListedAfter).toBe("SEC 재무제표를 찾지 못했습니다 (상장 폐지·합병·티커 변경 등)");
    expect(VALUE_STATUS_TEXT.notListed).toContain("외국 회사·새로 상장한 회사 등");
    for (const t of [VALUE_STATUS_TEXT.notListedAfter, ...["general", "financial"].flatMap((p) => [valueAboutOf(p as "general", "US"), valueAboutOf(p as "general", "KR")])]) expect(scoreWordingProblems(t)).toEqual([]);
  });
});

describe("(j) COST: 12·12·12·16주 분기 — 반기 누적 24주(168일)·3분기 누적 36주(252일)도 누적 기간으로", () => {
  it("기간 종류: 12주 분기 · 16주 분기 · 24·28주 반기 · 36·40주 누적 · 52·53주 연간", () => {
    expect([spanKind("2025-09-01", "2025-11-23"), spanKind("2025-05-12", "2025-08-31"), spanKind("2025-09-01", "2026-02-15"), spanKind("2025-09-01", "2026-05-10")]).toEqual(["Q", "Q", "H", "9M"]);
    expect([spanKind("2025-01-01", "2025-07-15"), spanKind("2025-02-02", "2025-11-08"), spanKind("2024-09-02", "2025-08-31"), spanKind("2023-08-28", "2024-09-01")]).toEqual(["H", "9M", "Y", "Y"]);
    expect([spanKind("2025-01-01", "2025-04-30"), spanKind("2025-01-01", "2025-10-31")]).toEqual(["other", "other"]);
  });
  it("COST 3분기(2026-05-10, 36주 누적 10-Q): 최근 4분기 = 2025 회계연도 + 올해 36주 누적 − 작년 36주 누적", () => {
    const b = book("COST");
    const p = b.latest(AS_OF)!;
    expect(p).toEqual({ end: "2026-05-10", filed: "2026-06-03", form: "10-Q", basis: "TTM" });
    const inp = b.inputs(AS_OF)!;
    const rows = (secExtra("COST")["facts"] as Record<string, Record<string, { units: Record<string, Array<{ start?: string; end: string; val: number; form: string }>> }>>)["us-gaap"]!;
    const v = (tag: string, start: string, end: string) => rows[tag]!.units["USD"]!.find((r) => r.start === start && r.end === end)!.val;
    const ni = v("NetIncomeLoss", "2024-09-02", "2025-08-31") + v("NetIncomeLoss", "2025-09-01", "2026-05-10") - v("NetIncomeLoss", "2024-09-02", "2025-05-11");
    expect(inp.flow.netIncome).toBe(ni);
    expect(inp.flow.ocf).toBeGreaterThan(0);
    expect(inp.flow.capex).toBeGreaterThan(0);
    expect(inp.shares).toBeGreaterThan(4e8);
    expect(inp.annual.length).toBe(6);
  });
});

describe("(k) XOM: 지주회사 전환으로 CIK 가 바뀌어 연간 이력이 비었던 것", () => {
  it("새 CIK(0002115436)에는 전환 뒤 10-Q 하나뿐 → 연간 이력 0. 예전 CIK 재무를 이어 붙이면 6개 회계연도와 최근 4분기", () => {
    expect(PREDECESSOR_CIK["0002115436"]).toBe("0000034088");
    const alone = new FactBook(compactCompanyFacts(secExtra("XOM"), "2017-06-01")).inputs(AS_OF)!;
    expect(alone.annual).toEqual([]);
    const merged = new FactBook(compactCompanyFacts(mergeCompanyFacts(secExtra("XOM"), secExtra("XOM-predecessor")), "2017-06-01"));
    const inp = merged.inputs(AS_OF)!;
    expect(inp.period).toEqual({ end: "2026-06-30", filed: "2026-08-03", form: "10-Q", basis: "TTM" });
    expect(inp.annual.map((a) => a.end)).toEqual(["2020-12-31", "2021-12-31", "2022-12-31", "2023-12-31", "2024-12-31", "2025-12-31"]);
    expect(inp.flow.netIncome).toBeGreaterThan(0);
    // XOM 은 2014년부터 희석 주식 수 없이 기본 주식 수만 보고 → 세 번째 주식 수 태그
    expect(inp.shares).toBeGreaterThan(4e9);
    expect(compactCompanyFacts(mergeCompanyFacts(secExtra("XOM"), secExtra("XOM-predecessor")), "2017-06-01").cik).toBe("0002115436");
  });
  it("실제 출처(defaultValueSources): 새 CIK 이면 예전 CIK 를 한 번 더 받아 합친다, 다른 회사는 한 번", async () => {
    const calls: string[] = [];
    const edgar = {
      companyFactsRaw: async (code: string) => {
        calls.push(code);
        return code === "XOM" ? { cik: "0002115436", raw: secExtra("XOM") } : { cik: "0000909832", raw: secExtra("COST") };
      },
      companyFactsRawByCik: async (cik: string) => {
        calls.push(cik);
        return secExtra("XOM-predecessor");
      },
    } as unknown as EdgarProvider;
    const src = defaultValueSources(edgar, {} as NasdaqScreener);
    const xom = (await src.companyFacts("XOM"))!;
    expect(calls).toEqual(["XOM", "0000034088"]);
    expect(new FactBook(compactCompanyFacts(xom.raw, "2017-06-01")).annualHistory(AS_OF).length).toBe(6);
    await src.companyFacts("COST");
    expect(calls).toEqual(["XOM", "0000034088", "COST"]);
  });
});
