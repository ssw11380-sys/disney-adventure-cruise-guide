import { describe, expect, it, vi } from "vitest";
import {
  buildKrReference,
  compactKrFacts,
  krAnnualAvailable,
  krAux,
  krAvailable,
  krCandidates,
  krCommonStock,
  krCrossCheck,
  krDue,
  krExclusion,
  krInputs,
  krLiteMetrics,
  KR_CAP_CUT,
  KR_FINANCIAL_UPJONG,
  KR_KEEP_ANNUAL,
  KR_KEEP_QUARTERS,
  KR_NIGHT_CAP,
  mergeKrFacts,
  monthEndOf,
  type KrColRow,
  type KrFacts,
  type KrMember,
} from "../src/analysis/krValue.js";
import { scoreWordingProblems } from "../src/analysis/scoreWording.js";
import { LITE_CORE_METRICS, LITE_FAMILY_METRICS, LITE_METRIC_ORDER, PeerBook, scoreValue, VALUE_WEIGHTS } from "../src/analysis/valueScore.js";
import { NaverDiscover } from "../src/providers/market/naverDiscover.js";
import { NaverFinanceClient, parseKrNumber, parseNaverFinance, parseNaverIntegration } from "../src/providers/market/naverFinance.js";
import { referenceDrop } from "../src/services/valueReference.js";
import { familyRow } from "../src/services/valueScoreService.js";
import {
  familyAbout,
  howLinesV2,
  mixText,
  positionText,
  krCauseQuarter,
  krDatesLine,
  krFirstFillText,
  KR_LITE_NOTE,
  krPeerLine,
  krVersionLine,
  LITE_BADGE,
  LITE_METRIC_NAME,
  metricMeaning,
  metricName,
  positionSentence,
  VALUE_STATUS_TEXT,
} from "../src/services/valueScoreText.js";
import { valueAboutOf } from "../src/services/indicatorScoreText.js";
import { KR_CODES, krWorld, membersRaw, naverRaw, type KrCode } from "./fixtures/krValue/load.js";

/**
 * 한국 간이 가치 (3-44 3단계) — 순수 함수 시험. 네트워크 없음.
 * 네이버 재무 요약은 2026-09-28 에 받은 원본(test/fixtures/krValue), 기대값은 같은 원본 숫자로 시험 안에서 손으로 계산한다
 */

const factsOf = (code: KrCode): KrFacts => {
  const r = naverRaw(code);
  return compactKrFacts(code, parseNaverFinance(r.annual, "annual"), parseNaverFinance(r.quarter, "quarter"), parseNaverIntegration(r.integration))!;
};
const AS_OF = "2026-09-28";

describe("네이버 재무 요약 파서 (설계 B9 — 추정 열 · 열 순서 · 단위)", () => {
  it("실적 열(isConsensus N)만, 열 이름 순서로 — 원본 columns 는 순서가 섞여 온다 (삼성전자 연간 원문: 2025.12 가 먼저)", () => {
    const raw = naverRaw("005930");
    const a = parseNaverFinance(raw.annual, "annual")!;
    // 제목 목록 순서가 뒤집혀 와도 열 이름(202312 …)으로 정렬
    const fi = (raw.annual as { financeInfo: { trTitleList: unknown[]; rowList: unknown[] } }).financeInfo;
    expect(parseNaverFinance({ financeInfo: { ...fi, trTitleList: [...fi.trTitleList].reverse() } }, "annual")!.columns.map((c) => c.key)).toEqual(["202312", "202412", "202512"]);
    expect(a.columns.map((c) => c.end)).toEqual(["2023-12", "2024-12", "2025-12"]);
    expect(a.consensusDropped).toBe(1);
    expect(a.columns.at(-1)!.values).toMatchObject({ revenue: 3_336_059, opIncome: 436_011, netIncome: 452_068, niControlling: 442_610, eps: 6_564, bps: 63_997, dps: 1_668, roe: 10.85, debtRatio: 29.94, quickRatio: 183.27 });
    // 추정 열(2026.12 영업이익 3,876,962 · EPS 47,922)은 어디에도 없다
    expect(JSON.stringify(a)).not.toMatch(/3876962|47922/);
    const q = parseNaverFinance(raw.quarter, "quarter")!;
    expect(q.columns.map((c) => c.key)).toEqual(["202506", "202509", "202512", "202603", "202606"]);
    expect(q.consensusDropped).toBe(1);
    expect(JSON.stringify(q)).not.toMatch(/2045704|1105736/); // 2026.09 추정 매출·영업이익
  });

  it("값 글: 쉼표·단위(배·원·%)·조·억·'-'·N/A, 줄 이름의 단위 괄호(백만원 → 억원)", () => {
    expect([parseKrNumber("3,336,059"), parseKrNumber("-7,193원"), parseKrNumber("12.13배"), parseKrNumber("0.62%"), parseKrNumber("-"), parseKrNumber("N/A"), parseKrNumber(""), parseKrNumber("−2.5")]).toEqual([3_336_059, -7_193, 12.13, 0.62, null, null, null, -2.5]);
    expect(parseKrNumber("1,581조 4,184억")).toBe(1581e12 + 4184e8);
    expect(parseKrNumber("9,474억")).toBe(9474e8);
    const raw = {
      financeInfo: {
        trTitleList: [
          { isConsensus: "N", key: "202512" },
          { isConsensus: "Y", key: "202612" },
        ],
        rowList: [
          { title: "매출액(백만원)", columns: { "202512": { value: "123,400" }, "202612": { value: "999" } } },
          { title: "영업이익", columns: { "202512": { value: "1,200억" } } },
          { title: "EPS(원)", columns: { "202512": { value: "1,500" } } },
          { title: "모르는 줄", columns: { "202512": { value: "7" } } },
        ],
      },
    };
    const t = parseNaverFinance(raw, "annual")!;
    expect(t.columns).toEqual([{ key: "202512", end: "2025-12", values: { revenue: 1_234, opIncome: 1_200, eps: 1_500 } }]);
    expect(parseNaverFinance({ nope: 1 }, "annual")).toBeNull();
  });

  it("요약 지표(integration): 네이버가 보이는 PER·EPS·PBR·BPS·시가총액(원)·업종 번호 — 추정 PER·EPS·목표가는 읽지 않는다", () => {
    const i = parseNaverIntegration(naverRaw("005930").integration)!;
    expect(i).toEqual({ name: "삼성전자", endType: "stock", industryCode: "278", per: 12.13, eps: 22_292, pbr: 3.14, bps: 86_052, perAsOf: "2026-06", marketCap: 1581e12 + 4184e8 });
    expect(JSON.stringify(i)).not.toMatch(/47922|5\.64/); // cnsEps · cnsPer
    expect(parseNaverIntegration(naverRaw("373220").integration)).toMatchObject({ per: null, eps: -7_193 }); // 적자 → PER N/A
  });
});

describe("입력 만들기 (최근 4분기 · 최근 분기 잔액 · 연간 2년 · 결산 + 90일 / 분기 + 45일)", () => {
  it("삼성전자 2026-09-28: 2025.09~2026.06 네 분기 합, BPS 는 2026.06, 1년 전 BPS 2025.06, 연간 2023~2025", () => {
    const inp = krInputs(factsOf("005930"), AS_OF)!;
    expect(inp.quarter).toBe("2026-06");
    expect(inp.ttm).toEqual({ rev: 860_617 + 938_374 + 1_338_734 + 1_714_995, op: 121_661 + 200_737 + 572_328 + 894_924, nic: 120_065 + 192_921 + 471_012 + 712_695, eps: 1_783 + 2_864 + 6_993 + 10_718 });
    expect([inp.bps, inp.bpsYearAgo, inp.debtRatio, inp.quickRatio, inp.dpsFY, inp.fiscalEnd]).toEqual([86_052, 58_135, 31.1, 229.73, 1_668, "2025-12-31"]);
    expect(inp.annual.map((a) => a.k)).toEqual(["2023-12", "2024-12", "2025-12"]);
    // 되짚은 주식 수: 지배주주순이익 ÷ EPS = 약 67억 주 (보통주 59억 + 우선주 8억 — 네이버 EPS 기준)
    expect(inp.shares! / 1e9).toBeCloseTo(6.73, 1);
  });
  it("미래 자료를 섞지 않는다: 분기는 끝 + 45일, 연간은 결산 + 90일 — 같은 달 4분기 열을 쓸 수 있으면(+45일) 그날부터", () => {
    expect([krAvailable("2026-06", 45, "2026-08-13"), krAvailable("2026-06", 45, "2026-08-14"), krAvailable("2025-12", 90, "2026-03-30"), krAvailable("2025-12", 90, "2026-03-31")]).toEqual([false, true, false, true]);
    const before = krInputs(factsOf("005930"), "2026-08-13")!;
    expect(before.quarter).toBe("2026-03");
    expect(before.ttm.eps).toBe(733 + 1_783 + 2_864 + 6_993);
    // 2025.12 분기 열이 있어 2/14(+45일)부터 2025 결산도 쓴다 — 4분기와 연간 실적은 같은 공시로 함께 나온다
    const f = factsOf("005930");
    expect(krInputs(f, "2026-02-13")!.annual.map((a) => a.k)).toEqual(["2023-12", "2024-12"]);
    expect(krInputs(f, "2026-02-14")!.annual.map((a) => a.k)).toEqual(["2023-12", "2024-12", "2025-12"]);
    expect(krInputs(f, "2026-03-30")!.fiscalEnd).toBe("2025-12-31");
    expect([krAnnualAvailable(f, "2025-12", "2026-02-13"), krAnnualAvailable(f, "2025-12", "2026-02-14")]).toEqual([false, true]);
    // 같은 달 분기 열이 없으면 결산 + 90일
    const noQ4: KrFacts = { ...f, q: f.q.filter((r) => r[0] !== "2025-12") };
    expect(krInputs(noQ4, "2026-03-30")!.annual.map((a) => a.k)).toEqual(["2023-12", "2024-12"]);
    expect(krInputs(noQ4, "2026-03-31")!.annual.map((a) => a.k)).toEqual(["2023-12", "2024-12", "2025-12"]);
    expect(krInputs(factsOf("005930"), "2025-08-01")).toBeNull();
    expect(monthEndOf("2026-02")).toBe("2026-02-28");
  });
  it("네 분기가 이어지지 않으면 최근 4분기 합을 만들지 않는다 (값이 빠진 분기도)", () => {
    const f = factsOf("005930");
    const gap: KrFacts = { ...f, q: f.q.filter((r) => r[0] !== "2025-12") };
    expect(krInputs(gap, AS_OF)!.ttm).toEqual({ rev: null, op: null, nic: null, eps: null });
    const hole: KrFacts = { ...f, q: f.q.map((r) => (r[0] === "2026-03" ? ([r[0], null, ...r.slice(2)] as typeof r) : r)) };
    expect(krInputs(hole, AS_OF)!.ttm.rev).toBeNull();
    expect(krInputs(hole, AS_OF)!.ttm.eps).not.toBeNull();
  });
});

describe("1~3월에도 성장 묶음이 빠지지 않는다 (새 결산이 실적 열로 바뀌며 가장 오래된 결산이 표에서 빠지는 때 — 검토 지적)", () => {
  /** 표 모양 바꾸기 (시험용): 있는 열의 값을 빌려 다른 끝 달 열을 만든다 (scale 배) */
  const pick = (rows: readonly KrColRow[], k: string, from: string, scale = 1): KrColRow => {
    const src = rows.find((r) => r[0] === from)!;
    return [k, ...src.slice(1).map((v) => (v === null ? null : (v as number) * scale))] as KrColRow;
  };
  /** 2026년 1월 표: 2025 결산은 아직 추정 열 → 연간 2022(시험용 — 2023 값 × 0.9, 실제 값 아님)·2023·2024, 분기 2024.09~2025.09 */
  const janShape = (f: KrFacts): KrFacts => ({
    ...f,
    a: [pick(f.a, "2022-12", "2023-12", 0.9), pick(f.a, "2023-12", "2023-12"), pick(f.a, "2024-12", "2024-12")],
    q: [pick(f.q, "2024-09", "2025-09", 0.8), pick(f.q, "2024-12", "2025-12", 0.8), pick(f.q, "2025-03", "2026-03", 0.8), pick(f.q, "2025-06", "2025-06"), pick(f.q, "2025-09", "2025-09")],
  });
  /** 2026년 3월 표: 잠정 실적 뒤 2025 결산이 실적 열 → 2022 결산은 표에서 빠짐. 연간 2023~2025, 분기 2024.12~2025.12 (withQ4 false: 4분기 열이 아직 없음) */
  const marShape = (f: KrFacts, withQ4 = true): KrFacts => ({
    ...f,
    a: f.a.filter((r) => r[0] >= "2023-12" && r[0] <= "2025-12"),
    q: [pick(f.q, "2024-12", "2025-12", 0.8), pick(f.q, "2025-03", "2026-03", 0.8), pick(f.q, "2025-06", "2025-06"), pick(f.q, "2025-09", "2025-09"), ...(withQ4 ? [pick(f.q, "2025-12", "2025-12")] : [])],
  });

  it("삼성전자 2026-03-20, 3월 표만 있을 때(이어 둔 앞 결산 없음 — 첫 채우기 등): 4분기 열을 쓸 수 있어 2025 대 2023 성장 — 성장 묶음 그대로, 비중 100", () => {
    const { members, facts } = krWorld();
    const ref = new PeerBook(buildKrReference(members, facts, AS_OF));
    const f = marShape(factsOf("005930"));
    const inp = krInputs(f, "2026-03-20")!;
    expect(inp.annual.map((a) => a.k)).toEqual(["2023-12", "2024-12", "2025-12"]);
    expect(inp.quarter).toBe("2025-12");
    const m = krLiteMetrics(inp, 60_000, false);
    expect([m.C1?.x, m.C2?.x, m.C3?.x].every((x) => typeof x === "number" && Number.isFinite(x))).toBe(true);
    const r = scoreValue({ grade: "lite", path: "general", sector: null, industry: "반도체와반도체장비", cik: "005930", metrics: m, own: {}, peers: ref });
    expect(r.families.find((x) => x.key === "growth")!.valid).toBe(true);
    expect([r.status, r.coverageWeight]).toEqual(["ok", 100]);
  });

  it("잠정 실적 뒤 4분기 +45일 전(2026-02-10): 새로 받은 표에서 빠진 2022 결산을 이어 두어 2024 대 2022 성장 — 이어 두지 않으면 결산 2개뿐('연간 재무 부족')", () => {
    const jan = janShape(factsOf("005930"));
    const mar = marShape(factsOf("005930"));
    const merged = mergeKrFacts(mar, jan);
    expect(merged.a.map((r) => r[0])).toEqual(["2022-12", "2023-12", "2024-12", "2025-12"]);
    expect(merged.q.map((r) => r[0])).toEqual(["2024-09", "2024-12", "2025-03", "2025-06", "2025-09", "2025-12"]);
    const kept = krInputs(merged, "2026-02-10")!;
    expect(kept.annual.map((a) => a.k)).toEqual(["2022-12", "2023-12", "2024-12"]);
    expect(krLiteMetrics(kept, 60_000, false).C1!.x).toBeCloseTo(Math.sqrt(jan.a[2]![1]! / jan.a[0]![1]!) - 1, 12);
    const fresh = krInputs(mar, "2026-02-10")!;
    expect(fresh.annual.map((a) => a.k)).toEqual(["2023-12", "2024-12"]);
    expect(krLiteMetrics(fresh, 60_000, false).C1).toMatchObject({ x: null, why: "fewYears" });
  });

  it("주 1회 비교 기준: 1월 표로 만든 지난 기준(3/8) 뒤 3월 표로 바뀌어도(3/15) 성장 지표 채택 비율이 그대로라 새 기준을 거절하지 않는다", () => {
    const { members, facts } = krWorld();
    const map = (fn: (f: KrFacts) => KrFacts) => new Map([...facts].map(([k, f]) => [k, fn(f)]));
    const jan = map(janShape);
    const prev = buildKrReference(members, jan, "2026-03-08");
    expect(prev.coverage.general["C1"]).toBe(1);
    // 4분기 열이 있으면 새로 받은 표만으로도
    const next = buildKrReference(members, map((f) => marShape(f)), "2026-03-15", prev);
    expect([next.coverage.general["C1"], next.coverage.general["C2"], next.coverage.general["C3"]]).toEqual([1, 1, 1]);
    expect(referenceDrop(prev, next)).toBeNull();
    // 4분기 열이 아직 없고 앞 결산도 이어 두지 않았으면(예전 규칙) 성장 채택 비율이 0 → 새 기준 거절 (지적된 모습)
    const bare = buildKrReference(members, map((f) => marShape(f, false)), "2026-03-15", prev);
    expect(bare.coverage.general["C1"]).toBe(0);
    expect(referenceDrop(prev, bare)).toMatch(/일반 C1 채택 비율 100% → 0%/);
    // 이어 두면 4분기 열이 없어도 2024 대 2022 로 그대로
    const kept = buildKrReference(members, new Map([...facts].map(([k, f]) => [k, mergeKrFacts(marShape(f, false), janShape(f))])), "2026-03-15", prev);
    expect(kept.coverage.general["C1"]).toBe(1);
    expect(referenceDrop(prev, kept)).toBeNull();
  });

  it("이어 두기 규칙: 같은 끝 달은 새 값, 연간 5개·분기 8개까지, 다른 종목 줄은 섞지 않음", () => {
    const f = factsOf("005930");
    const old: KrFacts = { ...f, a: [pick(f.a, "2020-12", "2023-12"), pick(f.a, "2021-12", "2023-12"), pick(f.a, "2022-12", "2023-12"), pick(f.a, "2023-12", "2023-12", 2)], q: Array.from({ length: 8 }, (_, i) => pick(f.q, `${2023 + Math.floor(i / 4)}-${String(3 * (i % 4) + 3).padStart(2, "0")}`, "2025-06")) };
    const m = mergeKrFacts(f, old);
    expect(m.a.map((r) => r[0])).toEqual(["2021-12", "2022-12", "2023-12", "2024-12", "2025-12"]);
    expect(m.a.length).toBe(KR_KEEP_ANNUAL);
    // 2023 결산은 새로 받은 값 (옛 줄은 2배로 바꿔 둔 것)
    expect(m.a[2]).toEqual(f.a[0]);
    expect(m.q.length).toBe(KR_KEEP_QUARTERS);
    expect(m.q.at(-1)![0]).toBe("2026-06");
    expect(mergeKrFacts(f, { ...old, code: "000660" })).toBe(f);
    expect(mergeKrFacts(f, null)).toBe(f);
  });
});

describe("간이 지표 (주당 값 ÷ 20거래일 평균 주가)", () => {
  const price = 270_000;
  it("일반 회사(삼성전자): PER·PBR·PSR, ROE(평균 BPS), 영업이익률, 부채비율·당좌비율, 성장 2년, 배당수익률", () => {
    const inp = krInputs(factsOf("005930"), AS_OF)!;
    const m = krLiteMetrics(inp, price, false);
    const eps = 22_358;
    expect(m.A1).toEqual({ x: eps / price, show: price / eps });
    expect(m.A3).toEqual({ x: 86_052 / price, show: price / 86_052 });
    expect(m.A4!.show).toBeCloseTo(price / ((4_852_720 * 1e8) / inp.shares!), 9);
    expect(m.B1!.x).toBeCloseTo(eps / ((86_052 + 58_135) / 2), 12);
    expect(m.B4!.x).toBeCloseTo(1_789_650 / 4_852_720, 12);
    expect(m.D1).toEqual({ x: -0.311, show: 31.1 });
    expect(m.D5).toEqual({ x: 2.2973, show: 229.73 });
    expect(m.C1!.x).toBeCloseTo(Math.sqrt(3_336_059 / 2_589_355) - 1, 12);
    expect(m.C2!.x).toBeCloseTo((6_564 - 2_131) / 52_002, 12);
    expect(m.C3!.x).toBeCloseTo(436_011 / 3_336_059 - 65_670 / 2_589_355, 12);
    expect(m.E1).toEqual({ x: 1_668 / price, show: (100 * 1_668) / price });
    // 금융 지표는 없다
    expect([m.F1, m.F3]).toEqual([undefined, undefined]);
  });
  it("금융사(KB금융): PER·PBR, ROE·ROA(총자산 = BPS × (1 + 부채비율)), 자기자본 ÷ 총자산 — 일반 지표(PSR·부채비율·당좌비율) 없음", () => {
    const inp = krInputs(factsOf("105560"), AS_OF)!;
    const m = krLiteMetrics(inp, 170_000, true);
    const eps = 4_420 + 1_865 + 5_057 + 5_481;
    expect(m.A1!.x).toBeCloseTo(eps / 170_000, 12);
    expect(m.F1!.x).toBeCloseTo(eps / (172_316 * (1 + 1_282.56 / 100)), 12);
    expect(m.F3!.x).toBeCloseTo(1 / (1 + 12.8256), 12);
    expect([m.A4, m.D1, m.D5, m.B4, m.C3]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
  it("적자(LG에너지솔루션): PER 0점 규칙, 초기 단계 표시는 영업이익이 두 해 모두 0 이하일 때만", () => {
    const inp = krInputs(factsOf("373220"), AS_OF)!;
    expect(inp.ttm.eps!).toBeLessThan(0);
    const m = krLiteMetrics(inp, 350_000, false);
    expect(m.A1).toEqual({ x: -Infinity, show: null, rule: "zeroLoss", why: "lossNi" });
    expect(krAux(inp).earlyStage).toBe(inp.annual.slice(-2).every((a) => (a.op ?? 1) <= 0));
  });
  it("무배당(주당배당금 '-')은 0%, 자본잠식(BPS ≤ 0)은 부채비율 0점·PBR 계산 안 함", () => {
    const f = factsOf("005930");
    const noDiv: KrFacts = { ...f, a: f.a.map((r) => [...r.slice(0, 7), null, ...r.slice(8)] as typeof r) };
    expect(krLiteMetrics(krInputs(noDiv, AS_OF)!, 100_000, false).E1).toEqual({ x: 0, show: 0 });
    const neg: KrFacts = { ...f, q: f.q.map((r) => (r[0] === "2026-06" ? ([...r.slice(0, 6), -100, ...r.slice(7)] as typeof r) : r)) };
    const m = krLiteMetrics(krInputs(neg, AS_OF)!, 100_000, false);
    expect(m.A3).toMatchObject({ x: null, why: "equityNonPositive" });
    expect(m.D1).toMatchObject({ x: -Infinity, why: "capitalImpairment" });
  });
});

describe("대상·후보 (보통주만, 시가총액 하위 20% 뺌)", () => {
  const mem = (code: string, cap: number, over: Partial<KrMember> = {}): KrMember => ({ code, name: `회사${code}`, market: "KOSPI", endType: "stock", price: 1000, marketCap: cap, upjong: "반도체와반도체장비", upjongCode: "278", ...over });
  it("우선주(코드 끝이 0 아님)·스팩·리츠는 대상 아님, ETF·ETN·코넥스는 후보 아님", () => {
    expect([krExclusion("005930", "삼성전자"), krExclusion("005935", "삼성전자우"), krExclusion("00680K", "미래에셋증권2우B"), krExclusion("123450", "하나30호스팩"), krExclusion("330590", "롯데리츠"), krExclusion("0017J0", "세미티에스")]).toEqual([null, "preferred", "preferred", "spac", "reit", null]);
    expect(krCommonStock(mem("069500", 1e12, { endType: "etf" }))).toBe(false);
    expect(krCommonStock(mem("413300", 1e12, { endType: "konex", market: "KONEX" }))).toBe(false);
    expect(krCommonStock(mem("005930", 1e12))).toBe(true);
  });
  it("시가총액 하위 20% 를 빼고 큰 순으로", () => {
    const ms = Array.from({ length: 10 }, (_, i) => mem(`${100000 + i * 10}`, (i + 1) * 1e11));
    const c = krCandidates([...ms, mem("005935", 9e12)]);
    expect(KR_CAP_CUT).toBe(0.2);
    expect(c.map((m) => m.marketCap! / 1e11)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
  });
  it("금융사 경로 업종: 은행·증권·생명보험·손해보험·카드·기타금융", () => {
    expect([...KR_FINANCIAL_UPJONG].sort()).toEqual(["기타금융", "생명보험", "손해보험", "은행", "증권", "카드"].sort());
  });
});

describe("재무 다시 받기 (분기에 한 번 돌아가며 — 공시가 났을 때만, 고정 시계)", () => {
  const row = (lastQuarter: string, fetchedAt: string, annualEnd: string | null = null) => ({ lastQuarter, annualEnd, fetchedAt: `${fetchedAt}T02:30:00+09:00` });
  it("받은 적 없음 → 먼저. 다음 분기가 끝나고 48일이 지나면 새 분기(7일마다 다시), 사업보고서 기다림, 120일이면 돌아가며", () => {
    expect(krDue(null, "2026-09-28")).toEqual({ due: true, priority: 0, why: "missing" });
    // 2026.06 까지 있음 → 2026.09 분기는 11/14 + 3 = 11/17 부터
    expect(krDue(row("2026-06", "2026-08-20"), "2026-11-16").due).toBe(false);
    expect(krDue(row("2026-06", "2026-08-20"), "2026-11-17")).toEqual({ due: true, priority: 1, why: "newQuarter" });
    // 11/17 에 받았는데 아직 없음 → 7일 뒤(11/24) 다시
    expect(krDue(row("2026-06", "2026-11-17"), "2026-11-23").due).toBe(false);
    expect(krDue(row("2026-06", "2026-11-17"), "2026-11-24").why).toBe("newQuarter");
    // 12월 분기는 들어왔는데 연간 열이 아직 2024 결산 → 결산 + 90일(3/31)부터 7일마다
    expect(krDue(row("2025-12", "2026-02-20", "2024-12"), "2026-03-30").due).toBe(false);
    expect(krDue(row("2025-12", "2026-02-20", "2024-12"), "2026-03-31")).toEqual({ due: true, priority: 2, why: "annualPending" });
    expect(krDue(row("2025-12", "2026-04-01", "2025-12"), "2026-04-20").due).toBe(false);
    // 공시와 상관없이 120일
    expect(krDue(row("2026-06", "2026-06-01"), "2026-09-29")).toEqual({ due: true, priority: 3, why: "rotation" });
    expect(KR_NIGHT_CAP).toBe(700);
  });
  it("다음 분기가 결산 달 분기(4분기)면 결산 + 90일(+3일)부터 — 잠정 실적을 내지 않는 회사는 사업보고서로 나오므로 2월 중순~3월 말에 주마다 다시 받지 않는다", () => {
    // 2025.09 까지 있음 → 2025.12 분기(12월 결산)는 12/31 + 93 = 4/3 부터 (예전 45+3 이면 2/17 부터 7일마다)
    expect(krDue(row("2025-09", "2026-01-10", "2024-12"), "2026-02-17").due).toBe(false);
    expect(krDue(row("2025-09", "2026-01-10", "2024-12"), "2026-04-02").due).toBe(false);
    expect(krDue(row("2025-09", "2026-01-10", "2024-12"), "2026-04-03")).toEqual({ due: true, priority: 1, why: "newQuarter" });
    // 연간 열을 모르면 12월 결산으로 본다
    expect(krDue(row("2025-09", "2026-01-10"), "2026-02-17").due).toBe(false);
    // 3월 결산 회사: 2025.12 분기는 보통 분기 (+48일), 2026.03 분기가 결산 달 분기 (+93일)
    expect(krDue(row("2025-09", "2025-12-01", "2025-03"), "2026-02-17")).toMatchObject({ due: true, why: "newQuarter" });
    expect(krDue(row("2025-12", "2026-02-17", "2025-03"), "2026-05-18").due).toBe(false);
    expect(krDue(row("2025-12", "2026-02-17", "2025-03"), "2026-07-02")).toMatchObject({ due: true, why: "newQuarter" });
  });
});

describe("PER·PBR 교차 점검 (같은 가격으로 — 네이버 가격 = PER × EPS)", () => {
  it("8종목 모두 20% 안 (삼성전자 우리 PER 12.09 · 네이버 12.13)", () => {
    for (const c of KR_CODES) expect(krCrossCheck(factsOf(c)).warnings).toEqual([]);
    const s = krCrossCheck(factsOf("005930"));
    expect(s.per!.ours).toBeCloseTo((12.13 * 22_292) / 22_358, 6);
    expect(s.pbr!.ours).toBeCloseTo((12.13 * 22_292) / 86_052, 6);
  });
  it("열이 섞이거나 단위가 틀리면(예: 추정 열이 끼어 EPS 가 커짐) 경고 글", () => {
    const f = factsOf("005930");
    const wrong: KrFacts = { ...f, q: f.q.map((r) => (r[0] === "2026-06" ? ([...r.slice(0, 5), 30_000, ...r.slice(6)] as typeof r) : r)) };
    expect(krCrossCheck(wrong).warnings).toEqual([expect.stringMatching(/^PER 우리 [\d.]+ · 네이버 12\.13$/)]);
    expect(krCrossCheck({ ...f, i: null }).warnings).toEqual([]);
  });
});

describe("한국 비교 기준 · 간이 점수 (한국 회사끼리만)", () => {
  /** 8종목 재무를 조금씩 바꿔 업종마다 20곳씩 복제한 비교 회사 */
  function world() {
    const members: KrMember[] = [];
    const facts = new Map<string, KrFacts>();
    const up: Record<KrCode, [string, string]> = { "005930": ["반도체와반도체장비", "278"], "000660": ["반도체와반도체장비", "278"], "035420": ["양방향미디어와서비스", "300"], "035720": ["양방향미디어와서비스", "300"], "005380": ["자동차", "273"], "105560": ["은행", "301"], "068270": ["생물공학", "261"], "373220": ["전기제품", "283"] };
    for (const c of KR_CODES) {
      const f = factsOf(c);
      for (let k = 0; k < 20; k++) {
        const code = k === 0 ? c : `${(900000 + KR_CODES.indexOf(c) * 1000 + k * 10).toString()}`;
        const scale = 0.6 + 0.04 * k;
        facts.set(code, { ...f, code, q: f.q.map((r) => [r[0], ...r.slice(1).map((v, j) => (v === null ? null : j === 4 || j === 5 || j === 6 ? v * scale : v))] as typeof r) });
        members.push({ code, name: `${c}-${k}`, market: "KOSPI", endType: "stock", price: 100_000, marketCap: 1e12 * (20 - k + 1), upjong: up[c][0], upjongCode: up[c][1] });
      }
    }
    members.push({ code: "069500", name: "KODEX 200", market: "KOSPI", endType: "etf", price: 30_000, marketCap: 9e12, upjong: "기타", upjongCode: "25" });
    return { members, facts };
  }
  it("모양: 시장 KR · 등급 lite · 지표 순서 13개 · 업종 번호표 · 층 표(부문 없이 업종 → 시장) · 금융사 따로", () => {
    const { members, facts } = world();
    const ref = buildKrReference(members, facts, AS_OF);
    expect(ref).toMatchObject({ market: "KR", grade: "lite", refDate: AS_OF, order: [...LITE_METRIC_ORDER], sectors: [""] });
    expect(ref.counts.screener).toBe(members.length);
    // 후보 = 보통주 160곳 가운데 시가총액 하위 20% 뺌 (ETF 제외)
    expect(ref.counts.mapped).toBe(krCandidates(members).length);
    expect(ref.counts.withData).toBe(ref.counts.mapped);
    expect(ref.counts.financial).toBe(ref.peers.filter((p) => p.f === 1).length);
    expect(ref.industryCodes).toMatchObject({ "278": "반도체와반도체장비", "301": "은행", "25": "기타" });
    expect(ref.symbols["069500"]).toBeDefined();
    expect(ref.quotes!["069500"]).toBeUndefined();
    expect(ref.levels!.general["|반도체와반도체장비"]!.length).toBe(2 * LITE_METRIC_ORDER.length);
    expect(ref.peers.every((p) => p.x.length === LITE_METRIC_ORDER.length)).toBe(true);
    expect(ref.coverage.general["A1"]).toBe(1);
  });
  it("삼성전자 간이 점수: 반도체 업종 비교 회사와 한국 시장 — 묶음 5개, 주가 수준은 업종 71 · 시장 29 (자기 지난 5년 없음), 배지 '간이 계산'용 등급", () => {
    const { members, facts } = world();
    const ref = new PeerBook(buildKrReference(members, facts, AS_OF));
    const inp = krInputs(facts.get("005930")!, AS_OF)!;
    const r = scoreValue({ grade: "lite", path: "general", sector: null, industry: "반도체와반도체장비", cik: "005930", metrics: krLiteMetrics(inp, 270_000, false), own: {}, peers: ref });
    expect(r.grade).toBe("lite");
    expect(r.families.map((f) => [f.key, f.metrics.map((m) => m.key)])).toEqual(Object.entries(LITE_FAMILY_METRICS.general));
    expect(r.status === "ok" || r.status === "partial").toBe(true);
    const a1 = r.families[0]!.metrics[0]!;
    expect(a1.peer!.level).toBe("industry");
    expect(Math.round(a1.mix.industry!)).toBe(71);
    // 손계산: V = round(Σ W × 묶음 정수 / Σ W)
    const W = VALUE_WEIGHTS.general;
    const fam = Object.fromEntries(r.families.filter((f) => f.valid).map((f) => [f.key, Math.floor(f.score! + 0.5)]));
    const sum = Object.entries(fam).reduce((a, [k, v]) => a + W[k as keyof typeof W] * v, 0) / Object.keys(fam).reduce((a, k) => a + W[k as keyof typeof W], 0);
    expect(r.shown).toBe(Math.floor(sum + 0.5));
    // 성장 지표 이름은 '2년' (연간 3개 결산)
    const row = familyRow(r.families.find((f) => f.key === "growth")!, { path: "general", grade: "lite", annualEnd: inp.fiscalEnd });
    expect(row.metrics.map((m) => [m.name, m.basis])).toEqual([
      ["매출 성장 (2년 연평균)", "2025년 12월 결산 연간 기준"],
      ["주당이익 증가폭 (2년, 순자산 대비)", "2025년 12월 결산 연간 기준"],
      ["영업이익률 변화 (2년)", "2025년 12월 결산 연간 기준"],
    ]);
    // 묶음 설명·지표 문장·뜻도 '2년' ('최근 3년'·'3년 전보다'로 읽히던 것 — 캡처 확인)
    expect(row.about).toBe("높을수록 최근 2년 늘어난 폭이 큰 편");
    expect(JSON.stringify(row)).not.toMatch(/3년/);
    expect([positionSentence("C1", 90, "lite"), positionSentence("C3", 10, "lite"), metricMeaning("C3", "lite")]).toEqual(["최근 2년 매출이 늘어난 속도가 빠른 편입니다.", "2년 전보다 영업이익률이 낮아진 편입니다.", "100에 가까울수록: 2년 전보다 영업이익률이 높아진 편"]);
    expect(positionSentence("C1", 90)).toBe("최근 3년 매출이 늘어난 속도가 빠른 편입니다.");
  });
  it("KB금융: 금융사 경로(은행 업종) — 금융사끼리만, 핵심 지표 PBR", () => {
    const { members, facts } = world();
    const ref = new PeerBook(buildKrReference(members, facts, AS_OF));
    const r = scoreValue({ grade: "lite", path: "financial", sector: null, industry: "은행", cik: "105560", metrics: krLiteMetrics(krInputs(facts.get("105560")!, AS_OF)!, 170_000, true), own: {}, peers: ref });
    expect(r.path).toBe("financial");
    expect(r.families.map((f) => f.key)).toEqual(["price", "quality", "health", "growth", "payout"]);
    expect(LITE_CORE_METRICS.financial.price).toEqual(["A3"]);
    expect(ref.groupSize("financial", "market", null, "105560")).toBe(ref.ref.peers.filter((p) => p.f === 1).length - 1);
  });
  it("지난 기준(3주 안)의 층을 이어 쓴다 — 미국과 같은 규칙", () => {
    const { members, facts } = world();
    const w1 = buildKrReference(members, facts, "2026-09-20");
    const w2 = buildKrReference(members, facts, AS_OF, w1);
    expect(w2.levels).toEqual(w1.levels);
  });
});

describe("업종 구성 종목 받기 (NaverDiscover 재사용) · 재무 요약 받기 (요청 간격·없는 종목)", () => {
  it("업종 목록 → 업종마다 쪽을 끝까지, 원본 종류(stock·etf·etn·konex)·시가총액(원)·현재가 그대로", async () => {
    const m = membersRaw();
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      const body = url.includes("sectors/all") ? m.sectors : m.pages[/sectorCode=(\d+)/.exec(url)![1]!];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const rows = await new NaverDiscover(fetchFn).krUpjongMembers({ pauseMs: 0 });
    expect(urls.filter((u) => u.includes("sector/item/list")).length).toBe(3);
    expect(rows.find((r) => r.code === "024850")).toEqual({ code: "024850", name: "HLB이노베이션", market: "KOSDAQ", endType: "stock", price: 19_680, marketCap: 624_909_000_000, upjong: "반도체와반도체장비", upjongCode: "278" });
    expect(rows.find((r) => r.code === "413300")?.endType).toBe("konex");
    expect(rows.filter((r) => r.upjongCode === "25").every((r) => r.endType === "etf" || r.endType === "etn")).toBe(true);
    expect(rows.filter((r) => r.upjong === "은행").length).toBeGreaterThan(5);
  });
  it("연간·분기(+ 요약 지표) — 밤 배치(summary false)는 두 번, 없는 종목(409)은 null, 모바일 User-Agent·referer", async () => {
    const seen: Array<{ url: string; ua: string | null }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ua: new Headers(init?.headers).get("user-agent") });
      if (url.includes("999990")) return new Response("{}", { status: 409 });
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof fetch;
    const c = new NaverFinanceClient(fetchFn, { gapMs: 0 });
    expect(await c.finance("005930")).toEqual({ annual: { ok: 1 }, quarter: { ok: 1 }, integration: { ok: 1 } });
    expect(seen.map((s) => s.url.replace("https://m.stock.naver.com/api/stock/", ""))).toEqual(["005930/finance/annual", "005930/finance/quarter", "005930/integration"]);
    expect(seen[0]!.ua).toMatch(/Mobile/);
    seen.length = 0;
    expect(await c.finance("000660", { summary: false })).toEqual({ annual: { ok: 1 }, quarter: { ok: 1 }, integration: null });
    expect(seen.length).toBe(2);
    expect(await c.finance("999990")).toBeNull();
    await expect(c.finance("AAPL")).rejects.toThrow(/한국 종목만/);
  });
  it.each([
    ["시험 설정 40ms", { gapMs: 40 }, 40],
    ["기본 설정 700ms", {}, 700],
  ] as const)("%s: 동시 요청도 간격을 공유하고, 남은 슬롯이 없으면 즉시 시작한다", async (_name, options, gap) => {
    // 호스트가 첫 예약과 fetch 사이에서 실행을 잠시 멈추면 실제 진입 간격은 예약 간격보다 짧아진다.
    // 벽시계 허용 오차를 낮추지 않고 가상 시계로 슬롯 직전·정확한 시점과 동시 호출을 검증한다.
    const start = Date.parse("2026-10-04T11:00:00+09:00");
    vi.useFakeTimers({ now: start });
    try {
      const at: number[] = [], urls: string[] = [];
      const c = new NaverFinanceClient((async (url: string) => {
        at.push(Date.now() - start); urls.push(url);
        return new Response("{}", { status: 200 });
      }) as typeof fetch, options);
      const pending = Promise.all([c.finance("005930", { summary: false }), c.finance("000660", { summary: false })]);
      await vi.advanceTimersByTimeAsync(0);
      expect(at).toEqual([0]);
      for (let slot = 1; slot < 4; slot++) {
        await vi.advanceTimersByTimeAsync(gap - 1);
        expect(at).toHaveLength(slot);
        await vi.advanceTimersByTimeAsync(1);
        expect(at).toEqual(Array.from({ length: slot + 1 }, (_, i) => i * gap));
      }
      expect(await pending).toEqual([{ annual: {}, quarter: {}, integration: null }, { annual: {}, quarter: {}, integration: null }]);
      expect(urls.map((url) => url.replace("https://m.stock.naver.com/api/stock/", ""))).toEqual([
        "005930/finance/annual", "000660/finance/annual", "005930/finance/quarter", "000660/finance/quarter",
      ]);
      // 충분히 쉰 뒤 첫 요청에는 추가 간격을 붙이지 않는다.
      await vi.advanceTimersByTimeAsync(gap * 2);
      const next = c.finance("035420", { summary: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(at).toEqual([0, gap, gap * 2, gap * 3, gap * 5]);
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(at).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(at).toEqual([0, gap, gap * 2, gap * 3, gap * 5, gap * 6]);
    } finally { vi.useRealTimers(); }
  });
});

describe("문구 (금지어 · 미래형) — 한국 간이 틀", () => {
  it("새 문장에 걸리는 낱말이 없다, 상태 글로 시작하지 않는다", () => {
    const texts = [
      LITE_BADGE,
      KR_LITE_NOTE,
      krFirstFillText(34),
      krPeerLine({ level: "industry", nameKo: "반도체와반도체장비", n: 142, path: "general" }),
      krPeerLine({ level: "market", nameKo: null, n: 1850, path: "general" }),
      krPeerLine({ level: "market", nameKo: null, n: 60, path: "financial" }),
      krDatesLine({ priceThrough: "2026-09-23", quarter: "2026-06", reference: "2026-09-27" }),
      krCauseQuarter("2026-06"),
      krVersionLine("2026-09-27"),
      ...howLinesV2(true),
      ...howLinesV2(false),
      ...Object.values(LITE_METRIC_NAME),
      metricMeaning("D5"),
      positionSentence("D5", 80),
      positionSentence("D5", 20),
      metricName("D5", "lite"),
      positionSentence("C1", 90, "lite"),
      positionSentence("C1", 10, "lite"),
      positionSentence("C3", 90, "lite"),
      positionSentence("C3", 10, "lite"),
      metricMeaning("C1", "lite"),
      familyAbout("growth", "lite"),
      valueAboutOf("general", "KR"),
      valueAboutOf("financial", "KR"),
      VALUE_STATUS_TEXT.krOff,
      VALUE_STATUS_TEXT.krNotFound,
      VALUE_STATUS_TEXT.krPendingFacts,
      VALUE_STATUS_TEXT.krNoData,
      VALUE_STATUS_TEXT.krFiscalOld,
    ];
    expect(texts.flatMap((t) => scoreWordingProblems(t).map((w) => `${w} ← ${t}`))).toEqual([]);
    for (const t of [krFirstFillText(10), VALUE_STATUS_TEXT.krOff, VALUE_STATUS_TEXT.krNotFound, VALUE_STATUS_TEXT.krNoData]) expect(t).not.toMatch(/^(계산 준비 중|잠시 보류|점수 없음|대상 아님)/);
    expect(krPeerLine({ level: "industry", nameKo: "반도체와반도체장비", n: 142, path: "general" })).toBe("같은 업종(반도체와반도체장비, 142개 회사)·한국 시장과 비교해, 재무 숫자가 어디쯤인지 정해진 규칙으로 계산한 위치입니다.");
    expect(krPeerLine({ level: "market", nameKo: null, n: 1850, path: "general" })).toBe("한국 상장 회사 1,850개와 비교해, 재무 숫자가 어디쯤인지 정해진 규칙으로 계산한 위치입니다.");
    expect(krDatesLine({ priceThrough: "2026-09-23", quarter: "2026-06", reference: "2026-09-27" })).toBe("주가 9월 23일(수)까지 20거래일 평균 · 재무 2026년 6월까지 최근 4분기(네이버 재무 요약) · 비교 기준 9월 27일(일)");
    // 한국 종목과 미국 종목을 견주지 않는다는 줄 (설계 B8)
    expect(howLinesV2(true).join(" ")).toMatch(/서로의 가치 지표 점수를 견주지 않습니다/);
    expect(howLinesV2(true).join(" ")).not.toMatch(/다음 단계에서/);
  });
  it("한국 카드에서 어긋나던 글 (검토 지적): 주주환원 설명에 '주식 수' 없음 · 계산 방법 첫 줄은 미국 종목 · 한국 줄은 지표 수와 '지난 5년 비교 없음'", () => {
    // 간이 계산 주주환원은 배당수익률 하나 — 같은 카드의 안내('주식 수 변화 지표가 없고')와 맞춘다
    expect(familyAbout("payout", "lite")).toBe("높을수록 주가에 비해 배당이 많은 편");
    expect(familyAbout("payout")).toBe("높을수록 배당이 많거나 주식 수가 줄어든 편");
    expect(KR_LITE_NOTE).toMatch(/주식 수 변화 지표가 없고, 이 회사의 지난 5년과도 비교하지 않습니다/);
    const how = howLinesV2(true);
    expect(how[0]).toMatch(/^가치\(미국 종목\): 재무 숫자 약 20개/);
    const krLine = how.find((l) => l.startsWith("가치(한국 종목)"))!;
    expect(krLine).toMatch(/재무 숫자 11개\(금융사는 8개\)/);
    expect(krLine).toMatch(/이 회사의 지난 5년과는 비교하지 않습니다/);
    // 지표 수는 간이 묶음 표와 같다
    expect(Object.values(LITE_FAMILY_METRICS.general).flat().length).toBe(11);
    expect(Object.values(LITE_FAMILY_METRICS.financial).flat().length).toBe(8);
    expect([...how, familyAbout("payout", "lite")].flatMap((t) => scoreWordingProblems(t))).toEqual([]);
  });
  it("지표 줄의 무리 이름도 '한국 시장'·'한국 금융사 전체' (설명 줄·머리 문장과 같게 — 미국은 그대로)", () => {
    expect(mixText({ industry: 71.4, market: 28.6 }, "industry", "general", "KR")).toBe("업종 71 · 한국 시장 29");
    expect(mixText({ industry: 50, market: 50 }, "market", "financial", "KR")).toBe("한국 금융사 전체 100");
    expect(positionText({ industry: 72, market: 64 }, "industry", "general", "KR")).toBe("업종 안 위치 72/100 · 한국 시장 안 64/100");
    expect(positionText({ industry: 72 }, "market", "financial", "KR")).toBe("한국 금융사 전체 안 위치 72/100");
    expect(mixText({ industry: 71.4, market: 28.6 }, "industry")).toBe("업종 71 · 시장 29");
  });
});
