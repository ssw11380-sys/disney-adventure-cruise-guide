import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IndicatorScores } from "@/api/types";
import { barFraction, compositeLine, familyLabel, familySpeech, flagPreview, formulaSpeech, itemLine, leverageSpeech, metricMain, metricSpeech, moreFlagsText, nameWidth, reasonOnly, SCORE_LABELS, showComposite, stackRows, summarySpeech, trendHasScore, trendSpeech, valueHasScore, valueJumpY, valueSpeech, valueWaiting, weightJoin, WEIGHT_JOIN } from "@/lib/scoreView";

/**
 * 지표 점수 화면 모양 (3-44 — 2단계부터 가치·종합). 서버 응답은 공용 픽스처(shared/fixtures/indicatorScores.json — 서버 테스트가 지금 서버 코드의 응답과 같은지 본다).
 * 앱에 고정된 글(줄 이름·버튼·화면 읽기 틀)도 서버와 같은 금지어 검사를 통과해야 한다
 */
const fx = JSON.parse(readFileSync(new URL("../../shared/fixtures/indicatorScores.json", import.meta.url), "utf8")) as { cases: Record<string, IndicatorScores> };
const S = fx.cases;

/** 서버 검사기(backend/src/analysis/scoreWording.ts)의 금지어 정규식을 그대로 읽어 쓴다 */
const src = readFileSync(new URL("../../backend/src/analysis/scoreWording.ts", import.meta.url), "utf8");
const BANNED = new RegExp(/SCORE_BANNED_RE =\s*\/(.+)\/;/.exec(src)![1]!);
const FUTURE = new RegExp(/SCORE_FUTURE_RE = \/(.+)\/;/.exec(src)![1]!);
const ALLOW = [...src.matchAll(/"([^"]*수 있습니다)"/g)].map((m) => m[1]!);
const problems = (s: string) => {
  let t = s.replace(/과매수|과매도/g, "");
  const out = t.match(new RegExp(BANNED.source, "g")) ?? [];
  for (const a of ALLOW) t = t.split(a).join("");
  return [...out, ...(t.match(new RegExp(FUTURE.source, "g")) ?? [])];
};
const texts = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === "object" ? Object.values(v).flatMap(texts) : []);

describe("화면 읽기 문장", () => {
  it("NVDA: '가치 지표 67점, 0에서 100 중, 높은 편' · '추세 지표 69점, 다소 강함' · 종합 68 (설계 5.7-F)", () => {
    expect(trendSpeech(S["NVDA"]!.trend)).toBe("추세 지표 69점, 다소 강함");
    expect(valueSpeech(S["NVDA"]!.value)).toBe("가치 지표 67점, 0에서 100 중, 높은 편");
    expect(summarySpeech(S["NVDA"]!)).toBe("지표 점수. 가치 지표 67점, 0에서 100 중, 높은 편. 추세 지표 69점, 다소 강함. 종합 지표 68점, 두 점수의 평균.");
    // 가치 플래그를 끈 서버: 상태 글과 보이는 이유 줄까지 읽는다 (검토 지적: 상태 글 '지금 계산하지 않음' · 이유도 TalkBack 이 읽게)
    expect(summarySpeech(S["NVDA_valueOff"]!)).toBe("지표 점수. 가치 지표, 지금 계산하지 않음, 가치 지표 점수는 지금 계산하지 않습니다. 추세 지표 69점, 다소 강함. 종합 지표 없음, 가치 지표 점수가 없어 합치지 않습니다.");
  });
  it("두 점수 차이 30 이상: 종합 뒤에 차이 안내를 이어 읽는다 (마침표 겹침 없음 — 가치 점수 개선 1단계 플래그를 끈 서버)", () => {
    const sp = summarySpeech(S["ZZGAP_stage1Off"]!);
    expect(sp).toContain("종합 지표 50점, 두 점수의 평균. 두 점수의 차이가 39점이라 평균만으로는 상태가 잘 드러나지 않습니다. 두 점수를 함께 보세요.");
    expect(sp).not.toMatch(/\.\./);
  });
  it("가치 점수 개선 1단계 [4]: 차이 30 넘으면 '종합 지표 없음, 까닭' · 식은 '67과 69를 더해 2로 나눈 값'으로 읽는다 (앱 플래그 compositeFormula 일 때만)", () => {
    expect(summarySpeech(S["ZZGAP"]!)).toContain("종합 지표 없음, 두 점수 차이가 39점이라 평균을 보이지 않습니다.");
    expect(summarySpeech(S["ZZGAP"]!, true)).toBe(summarySpeech(S["ZZGAP"]!));
    expect(summarySpeech(S["NVDA"]!, true)).toBe("지표 점수. 가치 지표 67점, 0에서 100 중, 높은 편. 추세 지표 69점, 다소 강함. 종합 지표 68점, 두 점수의 평균, 67과 69를 더해 2로 나눈 값.");
    expect(summarySpeech(S["NVDA"]!)).toBe("지표 점수. 가치 지표 67점, 0에서 100 중, 높은 편. 추세 지표 69점, 다소 강함. 종합 지표 68점, 두 점수의 평균.");
    expect([formulaSpeech("= (51 + 80) ÷ 2"), formulaSpeech("= (42 + 65) ÷ 2"), formulaSpeech("= (100 + 9) ÷ 2"), formulaSpeech("= (30 + 70) ÷ 2")]).toEqual([
      "51과 80을 더해 2로 나눈 값",
      "42와 65를 더해 2로 나눈 값",
      "100과 9를 더해 2로 나눈 값",
      "30과 70을 더해 2로 나눈 값",
    ]);
    // 25~30점 차이 안내 (명령형 없음)
    const ko = { ...S["NVDA"]!, composite: { status: "ok", score: 66, reason: null, text: "두 점수의 평균", gap: 29, gapNote: true, gapText: "두 점수 차이가 29점입니다. 평균 하나로는 이 차이가 가려집니다.", formula: "= (51 + 80) ÷ 2" } } as const;
    expect(summarySpeech(ko, true)).toContain("종합 지표 66점, 두 점수의 평균, 51과 80을 더해 2로 나눈 값. 두 점수 차이가 29점입니다. 평균 하나로는 이 차이가 가려집니다.");
    expect(summarySpeech(ko, true)).not.toMatch(/\.\.|세요/);
  });
  it("가치 점수 없음·대상 아님·한국: 상태 글과 이유 (보이는 이유 줄을 화면 읽기도 읽는다)", () => {
    expect(valueSpeech(S["ZZNOF"]!.value)).toBe("가치 지표, 점수 없음, SEC 재무제표를 찾지 못했습니다 (외국 회사·새로 상장한 회사 등)");
    expect(valueSpeech(S["SOXL"]!.value)).toBe("가치 지표, 대상 아님, ETF는 여러 종목을 묶은 상품이라, 한 회사의 재무로 계산하는 이 점수를 내지 않습니다");
    // 한국 가치를 끈 서버 (3단계 되돌리기 스위치 krValueScore)
    expect(valueSpeech(S["005930_krOff"]!.value)).toBe("가치 지표, 지금 계산하지 않음, 한국 종목 가치 지표 점수는 지금 계산하지 않습니다");
    expect(valueSpeech(S["ZZNOF_pending"]!.value)).toBe("가치 지표, 계산 준비 중, 재무제표를 처음 받는 중입니다 (보통 몇 분 안)");
    // 예전 서버(이유 없이 label·text 만)도 그대로 읽는다
    expect(valueSpeech({ method: "VALUE-1", status: "pending", label: "계산 준비 중", score: null, band: null, about: "", text: "" })).toBe("가치 지표, 계산 준비 중");
    const partial = { ...S["NVDA"]!.value, status: "partial" as const, badges: ["일부 지표 없이 계산", "지난 값 9/24"] };
    expect(valueSpeech(partial)).toBe("가치 지표 67점, 0에서 100 중, 높은 편, 일부 지표 없이 계산, 지난 값 9/24");
  });
  it("가치 묶음·지표 줄 화면 읽기 (가치 점수 개선 1단계 플래그를 끈 서버의 예전 글)", () => {
    const f = S["NVDA_stage1Off"]!.value.families![0]!;
    expect(familySpeech(f)).toBe(`주가 수준 ${f.score}점, 비중 30`);
    const a1 = f.metrics.find((m) => m.key === "A1")!;
    // 리뷰: 줄 전체를 한 덩어리로 읽으므로 보이는 글(가운데값·비교별 위치·비중·문장·안내·뜻)을 모두 담는다. '72/100' 은 '100 중 72'
    expect(metricSpeech(a1)).toBe(
      "PER (이익 대비 주가) 44.8배, 업종 가운데값 100배 넘음. 위치 점수 71. 업종 안 위치 100 중 76, 시장 안 100 중 57. 비중 업종 71, 시장 29. 이익에 비해 주가 수준이 낮은 편입니다. 업황에 따라 이익이 크게 오르내리는 회사라, 최근 4분기 이익과 5년 평균 이익을 반씩 섞어 계산했습니다. 100에 가까울수록: 이익에 비해 주가 수준이 낮은 편.",
    );
    for (const part of [a1.name, a1.value!, a1.peerMedian!, a1.text.replace(/\.$/, ""), a1.note!.replace(/\.$/, "")]) expect(metricSpeech(a1)).toContain(part);
    expect(metricSpeech(a1)).not.toMatch(/\.\.|\/100|→/);
    const e1 = S["NVDA"]!.value.families![4]!.metrics.find((m) => m.key === "E1")!;
    // 같은 값 덩어리에 좌우된 지표: '배당이 많은 편' 대신 중립 문장 (검토 지적)
    expect(metricSpeech(e1)).toContain("비교한 회사 대부분(77%)이 0.0%라 위치 점수가 크게 나왔습니다");
    expect(metricSpeech(e1)).not.toContain("배당이 많은 편입니다");
    // 연간 재무 지표는 기준 글도 읽는다
    const c1 = S["NVDA"]!.value.families![3]!.metrics.find((m) => m.key === "C1")!;
    expect(c1.basis).toBe("2026년 1월 결산 연간 기준");
    expect(metricSpeech(c1)).toContain(`, 업종 가운데값 ${c1.peerMedian!.replace("업종 가운데값 ", "")}. 2026년 1월 결산 연간 기준. 위치 점수`);
    const b3 = S["NVDA"]!.value.families![1]!.metrics.find((m) => m.key === "B3")!;
    expect(metricSpeech(b3)).toBe("매출총이익 ÷ 자산, 값 없음, 비교할 회사 자료가 모자라(70% 미만) 이 지표는 쓰지 않았습니다.");
    // 가치 점수 개선 1단계 [3] (서버 기본 켬): 최근 4분기 PER · 흑자 회사 가운데값 · 흑자 회사끼리 위치도 한 문장으로 읽는다
    const a1n = S["NVDA"]!.value.families![0]!.metrics.find((m) => m.key === "A1")!;
    expect(metricSpeech(a1n)).toContain("PER (이익 대비 주가) 27.9배 (최근 4분기, 흔히 쓰는 계산), 흑자 회사 가운데값 58.6배, 비교한 업종 68곳 중 43%는 적자.");
    expect(metricSpeech(a1n)).toContain("업종 안 위치 100 중 76 (흑자 회사끼리 59)");
    expect(metricSpeech(a1n)).toContain("순위에는 최근 4분기 이익과 5년 평균 이익을 반씩 섞은 44.8배를 썼습니다");
    expect(metricSpeech(a1n)).not.toMatch(/\.\.|\/100|→/);
    // [2] 두 쪽 문장은 묶음 글 그대로 (두 줄)
    expect(S["NVDA"]!.value.families![0]!.text).toBe("막대를 길게 만든 지표(위치 점수): 기업가치 ÷ 영업이익 80 · PER 71\n막대를 짧게 만든 지표(위치 점수): PBR 5 · PSR 25");
    expect(S["NVDA"]!.value.families![0]!.about).toBe("막대가 길수록: 이익·순자산·매출에 비해 주가가 낮은 쪽 (비교 회사 기준)");
  });
  it("삼성전자: 68 다소 강함", () => expect(trendSpeech(S["005930"]!.trend)).toBe("추세 지표 68점, 다소 강함"));
  it("SOXL: 이 상품 자체 점수 없음 + 기초자산 참고", () => {
    // 추세 줄은 보이는 이유 글까지 읽는다 (3단계 검토 지적)
    expect(summarySpeech(S["SOXL"]!)).toBe(
      "지표 점수. 가치 지표, 대상 아님, ETF는 여러 종목을 묶은 상품이라, 한 회사의 재무로 계산하는 이 점수를 내지 않습니다. 추세 지표, 이 상품 자체 점수 없음, 매일 3배를 다시 맞추는 상품이라 이 상품 가격으로는 계산하지 않습니다. 참고: 기초자산 SOXX 추세 지표 73 · 강함. 종합 지표 없음, 가치 지표 점수가 없어 합치지 않습니다.",
    );
  });
  it("레버리지 주의 상자: 줄 앞 '·'·줄 끝 마침표를 떼고 이어 읽는다 (마침표 겹침 없음)", () => {
    const sp = leverageSpeech(S["SOXL"]!.trend.leveraged!.box);
    expect(sp).not.toMatch(/\.\./);
    expect(sp).not.toContain("·  ");
    expect(sp.startsWith("레버리지 상품 주의 · 계산한 사실. 이 상품은 NYSE 반도체 지수 하루 움직임의 3배를 따라가도록 만든 상품입니다. 최근 63거래일: 이 상품 −29.8%")).toBe(true);
    expect(sp.endsWith("차이가 커질 수 있습니다.")).toBe(true);
  });
  it("점수 없음·대상 아님·받기 실패", () => {
    expect(trendSpeech(S["NVDA_fetchFailed"]!.trend)).toBe("추세 지표, 점수 없음, 비교 지수(나스닥) 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다");
    expect(valueSpeech(S["NVDA_fetchFailed"]!.value)).toBe("가치 지표 67점, 0에서 100 중, 높은 편");
    expect(trendSpeech(S["SHRT"]!.trend)).toBe("추세 지표, 점수 없음, 기록이 120거래일이라 계산할 수 없습니다 (200거래일 필요)");
    expect(trendSpeech(S["SQQQ"]!.trend)).toBe("추세 지표, 대상 아님, 인버스 상품은 점수를 내지 않습니다 (기초자산과 반대로 움직이도록 만든 상품)");
  });
  it("묶음: '추세 69점, 비중 35' · 항목 점수 한 줄", () => {
    const f = S["NVDA"]!.trend.families[0]!;
    expect(familySpeech(f)).toBe("추세 69점, 비중 35");
    expect(itemLine(f)).toBe("200일선과 거리 72 · 50일선과 거리 66 · 50일선 대 200일선 69 · 200일선 기울기 67");
  });
});

describe("보이는 모양", () => {
  it("막대 비율 0~1, 점수 없으면 null", () => {
    expect([barFraction(69), barFraction(0), barFraction(100), barFraction(130), barFraction(-5), barFraction(null)]).toEqual([0.69, 0, 1, 1, 0, null]);
  });
  it("점수 줄은 본인 점수가 있을 때만 (레버리지·인버스·짧은 기록은 상태 글)", () => {
    expect(Object.fromEntries(Object.entries(S).map(([k, v]) => [k, trendHasScore(v.trend)]))).toEqual({
      NVDA: true,
      MSFT: true,
      AAPL: true,
      META: true,
      JPM: true,
      RGTI: true,
      ZZGAP: true,
      "005930": true,
      "000660": true,
      "105560": true,
      COST: true,
      QQQ: true,
      SOXL: false,
      RGTX: false,
      SQQQ: false,
      SHRT: false,
      ZJMP: true,
      ZSPL: false,
      ZZNOF_pending: true,
      ZZNOF: true,
      NVDA_valueOff: true,
      "005930_krOff": true,
      NVDA_change: true,
      NVDA_fetchFailed: false,
      SOXL_fetchFailed: false,
      NVDA_stage1Off: true,
      JPM_stage1Off: true,
      ZZGAP_stage1Off: true,
      "105560_stage1Off": true,
    });
    // 가치 줄은 미국 보통주 · 한국 보통주(간이) 점수만 (ETF · 받는 중 · SEC 재무 없음 · 가치 끔 · 한국 가치 끔은 상태 글)
    expect(Object.entries(S).filter(([, v]) => valueHasScore(v.value)).map(([k]) => k).sort()).toEqual(
      ["000660", "005930", "105560", "AAPL", "COST", "JPM", "META", "MSFT", "NVDA", "NVDA_change", "NVDA_fetchFailed", "RGTI", "ZZGAP", "NVDA_stage1Off", "JPM_stage1Off", "ZZGAP_stage1Off", "105560_stage1Off"].sort(),
    );
  });
  it("종합 숫자는 두 점수가 모두 있을 때만 = 두 정수의 평균, 없으면 '없음'과 이유 (설계 5.4 '없으면 없다고') · 차이 30 넘으면 숫자 대신 까닭 (1단계 [4])", () => {
    for (const s of Object.values(S)) {
      const wide = s.composite.reason === "gapWide";
      expect(showComposite(s)).toBe(valueHasScore(s.value) && trendHasScore(s.trend) && !wide);
      if (showComposite(s)) expect(s.composite.score).toBe(Math.floor((s.value.score! + s.trend.score!) / 2 + 0.5));
      if (wide) expect(Math.abs(s.value.score! - s.trend.score!)).toBeGreaterThan(30);
    }
    expect(compositeLine(S["NVDA"]!)).toEqual({ score: 68, label: "68", reason: "두 점수의 평균", gapText: null });
    expect(compositeLine(S["NVDA"]!, true)).toEqual({ score: 68, label: "68", reason: "두 점수의 평균", gapText: null, formula: "= (67 + 69) ÷ 2" });
    expect(compositeLine(S["NVDA_stage1Off"]!, true)).toEqual({ score: 68, label: "68", reason: "두 점수의 평균", gapText: null });
    expect(compositeLine(S["SOXL"]!)).toEqual({ score: null, label: "없음", reason: "가치 지표 점수가 없어 합치지 않습니다", gapText: null });
    expect(compositeLine(S["SQQQ"]!)).toEqual({ score: null, label: "없음", reason: "두 점수가 모두 없습니다", gapText: null });
    expect(compositeLine(S["NVDA_fetchFailed"]!)).toEqual({ score: null, label: "없음", reason: "추세 지표 점수가 없어 합치지 않습니다", gapText: null });
    expect(compositeLine(S["ZZGAP_stage1Off"]!)).toEqual({ score: 50, label: "50", reason: "두 점수의 평균", gapText: "두 점수의 차이가 39점이라 평균만으로는 상태가 잘 드러나지 않습니다. 두 점수를 함께 보세요." });
    expect(compositeLine(S["ZZGAP"]!, true)).toEqual({ score: null, label: "없음", reason: "두 점수 차이가 39점이라 평균을 보이지 않습니다", gapText: null });
    expect(compositeLine(S["105560"]!)).toEqual({ score: null, label: "없음", reason: "두 점수 차이가 34점이라 평균을 보이지 않습니다", gapText: null });
    // 예전 서버(차이 안내 칸 없음)
    const old = { ...S["NVDA"]!, composite: { status: "ok", score: 63, reason: null, text: "63 · 두 점수의 평균", gap: 12, gapNote: false } } as const;
    expect(compositeLine(old)).toEqual({ score: 63, label: "63", reason: "두 점수의 평균", gapText: null });
    expect(summarySpeech(old).endsWith("종합 지표 63점, 두 점수의 평균.")).toBe(true);
  });
  it("요약 카드 펼침의 표시는 최대 2개 + '표시 n개 더 — 가치분석 탭'", () => {
    const v = { ...S["NVDA"]!.value, flags: [1, 2, 3, 4].map((i) => ({ key: `k${i}`, text: `표시 ${i}` })) };
    expect(flagPreview(v)).toEqual({ shown: v.flags.slice(0, 2), more: 2 });
    expect(flagPreview(S["SOXL"]!.value)).toEqual({ shown: [], more: 0 });
    expect([moreFlagsText(2, false), moreFlagsText(1, true)]).toEqual(["표시 2개 더 — 가치분석 탭", "표시 1개 더 — 가치 탭"]);
  });
  it("가치 지표가 서버 백그라운드 받기를 기다리는 동안만 1분마다 다시 묻는다 (한국 '계산 준비 중'은 아님)", () => {
    expect(valueWaiting(S["ZZNOF_pending"])).toBe(true);
    // 오랜만에 연 종목(재무를 새로 받는 중)도 기다리는 중 — '받지 못했습니다'가 아니다 (리뷰)
    const withReason = (code: string) => ({ ...S["NVDA"]!, value: { ...S["NVDA_valueOff"]!.value, label: "계산 준비 중", reason: { code, text: "" } } });
    expect(valueWaiting(withReason("pendingRefresh"))).toBe(true);
    expect(valueWaiting(withReason("pendingReference"))).toBe(true);
    // 서버가 받는·만드는 중이 아니면(비교 기준이 아직 없고 쉬는 중 · 만들기 실패 · SEC 목록에서 빠짐) 다시 묻지 않는다 (검토 지적: 1분마다 끝없이 묻던 것)
    for (const code of ["referenceMissing", "referenceFailed", "notListed", "factsFailed", "off"]) expect(valueWaiting(withReason(code)), code).toBe(false);
    expect(valueWaiting(S["005930"])).toBe(false);
    expect(valueWaiting(S["NVDA"])).toBe(false);
    expect(valueWaiting(S["NVDA_valueOff"])).toBe(false);
    expect(valueWaiting(null)).toBe(false);
  });
  it("지표 줄 값 · 가운데값 (연간 기준 글) · 묶음 이름 비중 이음 · 가치 상세 카드로 스크롤할 자리", () => {
    expect(metricMain({ value: "32.9%", peerMedian: "업종 가운데값 13.1%", basis: "2026년 1월 결산 연간 기준" })).toBe("32.9% · 업종 가운데값 13.1% (2026년 1월 결산 연간 기준)");
    expect(metricMain({ value: "44.8배", peerMedian: "업종 가운데값 100배 넘음", basis: null })).toBe("44.8배 · 업종 가운데값 100배 넘음");
    expect(metricMain({ value: null, peerMedian: null })).toBe("");
    expect(familyLabel("수익성과 이익의 질", 25)).toBe("수익성과 이익의 질 · 25");
    expect([valueJumpY(0, 1234), valueJumpY(900, 0), valueJumpY(0, 3)]).toEqual([1226, 892, 0]);
  });
  it("글자 130% 부터 두 줄", () => {
    expect([stackRows(1), stackRows(1.15), stackRows(1.3), stackRows(2)]).toEqual([false, false, true, true]);
  });
  it("이름 칸 폭은 글자 배율만큼 (폴드8 기본 115% 에서 '가치 지표'가 접히지 않게, 130% 까지)", () => {
    expect([nameWidth(64, 1), nameWidth(64, 1.15), nameWidth(64, 1.3), nameWidth(64, 2), nameWidth(64, 0.85)]).toEqual([64, 74, 84, 84, 64]);
  });
});

describe("문구", () => {
  it("검사기 정규식을 읽었다", () => {
    expect(problems("매수 추천")).toEqual(["매수", "추천"]);
    expect(problems("RSI 72(과매수 구간)")).toEqual([]);
    expect(problems("앞으로 오를 수 있습니다")).toEqual(["오를", "수 있습니다"]);
  });
  it("앱 고정 글과 서버 응답 문장(픽스처 전부)에 걸리는 낱말이 없다", () => {
    const all = [...Object.values(SCORE_LABELS), ...texts(fx)];
    expect(all.length).toBeGreaterThan(200);
    expect(all.map((s) => [s, problems(s)] as const).filter(([, p]) => p.length)).toEqual([]);
  });
});

describe("3단계 — 한국 간이 가치 · 2단계 남은 지적 (화면 읽기·묶음 이름 줄바꿈)", () => {
  it("한국 종목: 가치 점수 + '간이 계산' 배지를 화면 읽기도 읽는다, 종합은 두 정수의 평균", () => {
    const k = S["005930"]!;
    expect(k.value.grade).toBe("lite");
    expect(k.value.badges).toEqual(["간이 계산"]);
    expect(valueHasScore(k.value)).toBe(true);
    expect(valueSpeech(k.value)).toBe(`가치 지표 ${k.value.score}점, 0에서 100 중, ${k.value.band}, 간이 계산`);
    expect(showComposite(k)).toBe(true);
    expect(k.asOf.line).toMatch(/^가격 9월 23일\(수\) 한국 종가 · 재무 2026년 6월까지 4분기$/);
    // 한국 가치를 끈 서버: '지금 계산하지 않음' — 앱은 다시 묻지 않는다
    expect(valueSpeech(S["005930_krOff"]!.value)).toBe("가치 지표, 지금 계산하지 않음, 한국 종목 가치 지표 점수는 지금 계산하지 않습니다");
    expect(valueWaiting(S["005930_krOff"])).toBe(false);
  });
  it("한국 비교 회사 첫 채우기(며칠)는 1분마다 다시 묻지 않는다, 대상 종목 재무를 처음 받는 중은 다시 묻는다", () => {
    const withReason = (code: string) => ({ ...S["NVDA"]!, value: { ...S["NVDA_valueOff"]!.value, label: "계산 준비 중", reason: { code, text: "" } } });
    expect(valueWaiting(withReason("krFirstFill"))).toBe(false);
    expect(valueWaiting(withReason("krOff"))).toBe(false);
    expect(valueWaiting(withReason("pendingFacts"))).toBe(true);
  });
  it("추세 줄 화면 읽기는 보이는 이유 글까지 (레버리지 · 분할 보류) — 상태 글을 두 번 읽지 않는다", () => {
    expect(trendSpeech(S["SOXL"]!.trend)).toBe("추세 지표, 이 상품 자체 점수 없음, 매일 3배를 다시 맞추는 상품이라 이 상품 가격으로는 계산하지 않습니다");
    const hold = S["ZSPL"]!.trend;
    expect(hold).toMatchObject({ status: "hold", label: "잠시 보류", reason: { code: "split", text: "주식 분할·병합 반영을 확인하는 중입니다" } });
    expect(trendSpeech(hold)).toBe("추세 지표, 잠시 보류, 주식 분할·병합 반영을 확인하는 중입니다");
    // 예전 서버 이유 글 '잠시 보류 — …' 도 상태 글을 떼고 읽는다
    const old = { ...hold, reason: { code: "split", text: "잠시 보류 — 주식 분할·병합 반영을 확인하는 중입니다" } };
    expect(trendSpeech(old)).toBe("추세 지표, 잠시 보류, 주식 분할·병합 반영을 확인하는 중입니다");
    expect([reasonOnly("잠시 보류", "잠시 보류 — 가"), reasonOnly("점수 없음", "기록이 모자랍니다"), reasonOnly("x", null)]).toEqual(["가", "기록이 모자랍니다", null]);
  });
  it("묶음 이름 비중 이음: 보통은 줄바꿈 없는 빈칸, 큰 글씨(130% 이상)는 '·' 앞에서 줄을 바꿀 수 있게 ('가격 안정 / 성 · 10' 으로 낱말 가운데서 끊기던 것)", () => {
    expect(weightJoin(1)).toBe(WEIGHT_JOIN);
    expect(weightJoin(1.15)).toBe(WEIGHT_JOIN);
    expect(weightJoin(2)).toBe(" · ");
    expect(familyLabel("가격 안정성", 10, 2)).toBe("가격 안정성 · 10");
    // 빈칸은 '가격'과 '안정성' 사이, '안정성'과 '·' 사이 — '·'와 숫자 사이는 줄바꿈 없는 빈칸
    expect(familyLabel("가격 안정성", 10, 2).split(" ")).toEqual(["가격", "안정성", "· 10"]);
  });
});
