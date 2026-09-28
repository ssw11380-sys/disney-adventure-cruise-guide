import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IndicatorScores } from "@/api/types";
import { barFraction, compositeLine, familySpeech, flagPreview, itemLine, leverageSpeech, metricSpeech, moreFlagsText, nameWidth, SCORE_LABELS, showComposite, stackRows, summarySpeech, trendHasScore, trendSpeech, valueHasScore, valueSpeech, valueWaiting } from "@/lib/scoreView";

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
  it("NVDA: '가치 지표 66점, 0에서 100 중, 가운데쯤' · '추세 지표 69점, 다소 강함' · 종합 68 (설계 5.7-F)", () => {
    expect(trendSpeech(S["NVDA"]!.trend)).toBe("추세 지표 69점, 다소 강함");
    expect(valueSpeech(S["NVDA"]!.value)).toBe("가치 지표 66점, 0에서 100 중, 가운데쯤");
    expect(summarySpeech(S["NVDA"]!)).toBe("지표 점수. 가치 지표 66점, 0에서 100 중, 가운데쯤. 추세 지표 69점, 다소 강함. 종합 지표 68점, 두 점수의 평균.");
    // 가치 플래그를 끈 서버·예전 서버: 1단계와 같은 문장
    expect(summarySpeech(S["NVDA_valueOff"]!)).toBe("지표 점수. 가치 지표, 계산 준비 중. 추세 지표 69점, 다소 강함. 종합 지표 없음, 가치 지표 점수가 없어 합치지 않습니다.");
  });
  it("두 점수 차이 30 이상: 종합 뒤에 차이 안내를 이어 읽는다 (마침표 겹침 없음)", () => {
    const sp = summarySpeech(S["ZZGAP"]!);
    expect(sp).toContain("종합 지표 52점, 두 점수의 평균. 두 점수의 차이가 35점이라 평균만으로는 상태가 잘 드러나지 않습니다. 두 점수를 함께 보세요.");
    expect(sp).not.toMatch(/\.\./);
  });
  it("가치 점수 없음·대상 아님·한국: 상태 글", () => {
    expect(valueSpeech(S["ZZNOF"]!.value)).toBe("가치 지표, 점수 없음");
    expect(valueSpeech(S["SOXL"]!.value)).toBe("가치 지표, 대상 아님");
    expect(valueSpeech(S["005930"]!.value)).toBe("가치 지표, 계산 준비 중");
    const partial = { ...S["NVDA"]!.value, status: "partial" as const, badges: ["일부 지표 없이 계산", "지난 값 9/24"] };
    expect(valueSpeech(partial)).toBe("가치 지표 66점, 0에서 100 중, 가운데쯤, 일부 지표 없이 계산, 지난 값 9/24");
  });
  it("가치 묶음·지표 줄 화면 읽기", () => {
    const f = S["NVDA"]!.value.families![0]!;
    expect(familySpeech(f)).toBe(`주가 수준 ${f.score}점, 비중 30`);
    const a1 = f.metrics.find((m) => m.key === "A1")!;
    expect(metricSpeech(a1)).toBe(`PER (이익 대비 주가) ${a1.value}, 위치 점수 ${a1.score}`);
    const b3 = S["NVDA"]!.value.families![1]!.metrics.find((m) => m.key === "B3")!;
    expect(metricSpeech(b3)).toBe("매출총이익 ÷ 자산, 값 없음, 비교할 회사 자료가 모자라(70% 미만) 이 지표는 쓰지 않았습니다.");
  });
  it("삼성전자: 68 다소 강함", () => expect(trendSpeech(S["005930"]!.trend)).toBe("추세 지표 68점, 다소 강함"));
  it("SOXL: 이 상품 자체 점수 없음 + 기초자산 참고", () => {
    expect(summarySpeech(S["SOXL"]!)).toBe("지표 점수. 가치 지표, 대상 아님. 추세 지표, 이 상품 자체 점수 없음. 참고: 기초자산 SOXX 추세 지표 73 · 강함. 종합 지표 없음, 가치 지표 점수가 없어 합치지 않습니다.");
  });
  it("레버리지 주의 상자: 줄 앞 '·'·줄 끝 마침표를 떼고 이어 읽는다 (마침표 겹침 없음)", () => {
    const sp = leverageSpeech(S["SOXL"]!.trend.leveraged!.box);
    expect(sp).not.toMatch(/\.\./);
    expect(sp).not.toContain("·  ");
    expect(sp.startsWith("레버리지 상품 주의 · 계산한 사실. 이 상품은 NYSE 반도체 지수 하루 움직임의 3배를 따라가도록 만든 상품입니다. 최근 63거래일: 이 상품 −29.8%")).toBe(true);
    expect(sp.endsWith("차이가 커질 수 있습니다.")).toBe(true);
  });
  it("점수 없음·대상 아님·받기 실패", () => {
    expect(trendSpeech(S["NVDA_fetchFailed"]!.trend)).toBe("추세 지표, 점수 없음");
    expect(valueSpeech(S["NVDA_fetchFailed"]!.value)).toBe("가치 지표 66점, 0에서 100 중, 가운데쯤");
    expect(trendSpeech(S["SHRT"]!.trend)).toBe("추세 지표, 점수 없음");
    expect(trendSpeech(S["SQQQ"]!.trend)).toBe("추세 지표, 대상 아님");
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
      QQQ: true,
      SOXL: false,
      RGTX: false,
      SQQQ: false,
      SHRT: false,
      ZJMP: true,
      ZZNOF_pending: true,
      ZZNOF: true,
      NVDA_valueOff: true,
      NVDA_fetchFailed: false,
      SOXL_fetchFailed: false,
    });
    // 가치 줄은 미국 보통주 점수만 (한국 · ETF · 받는 중 · SEC 재무 없음 · 가치 끔은 상태 글)
    expect(Object.entries(S).filter(([, v]) => valueHasScore(v.value)).map(([k]) => k)).toEqual(["NVDA", "MSFT", "AAPL", "META", "JPM", "RGTI", "ZZGAP", "NVDA_fetchFailed"]);
  });
  it("종합 숫자는 두 점수가 모두 있을 때만 = 두 정수의 평균, 없으면 '없음'과 이유 (설계 5.4 '없으면 없다고')", () => {
    for (const s of Object.values(S)) {
      expect(showComposite(s)).toBe(valueHasScore(s.value) && trendHasScore(s.trend));
      if (showComposite(s)) expect(s.composite.score).toBe(Math.floor((s.value.score! + s.trend.score!) / 2 + 0.5));
    }
    expect(compositeLine(S["NVDA"]!)).toEqual({ score: 68, label: "68", reason: "두 점수의 평균", gapText: null });
    expect(compositeLine(S["SOXL"]!)).toEqual({ score: null, label: "없음", reason: "가치 지표 점수가 없어 합치지 않습니다", gapText: null });
    expect(compositeLine(S["SQQQ"]!)).toEqual({ score: null, label: "없음", reason: "두 점수가 모두 없습니다", gapText: null });
    expect(compositeLine(S["NVDA_fetchFailed"]!)).toEqual({ score: null, label: "없음", reason: "추세 지표 점수가 없어 합치지 않습니다", gapText: null });
    expect(compositeLine(S["ZZGAP"]!)).toEqual({ score: 52, label: "52", reason: "두 점수의 평균", gapText: "두 점수의 차이가 35점이라 평균만으로는 상태가 잘 드러나지 않습니다. 두 점수를 함께 보세요." });
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
    expect(valueWaiting(S["005930"])).toBe(false);
    expect(valueWaiting(S["NVDA"])).toBe(false);
    expect(valueWaiting(S["NVDA_valueOff"])).toBe(false);
    expect(valueWaiting(null)).toBe(false);
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
