import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IndicatorScores } from "@/api/types";
import { barFraction, compositeLine, familySpeech, itemLine, leverageSpeech, nameWidth, SCORE_LABELS, showComposite, stackRows, summarySpeech, trendHasScore, trendSpeech } from "@/lib/scoreView";

/**
 * 지표 점수 화면 모양 (3-44 1단계). 서버 응답은 공용 픽스처(shared/fixtures/indicatorScores.json — 서버 테스트가 지금 서버 코드의 응답과 같은지 본다).
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
  it("NVDA: '추세 지표 69점, 다소 강함' (가치는 계산 준비 중, 종합은 없음)", () => {
    expect(trendSpeech(S["NVDA"]!.trend)).toBe("추세 지표 69점, 다소 강함");
    expect(summarySpeech(S["NVDA"]!)).toBe("지표 점수. 가치 지표, 계산 준비 중. 추세 지표 69점, 다소 강함. 종합 지표 없음, 가치 지표 점수가 없어 합치지 않습니다.");
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
    expect(Object.fromEntries(Object.entries(S).map(([k, v]) => [k, trendHasScore(v.trend)]))).toEqual({ NVDA: true, "005930": true, QQQ: true, SOXL: false, RGTX: false, SQQQ: false, SHRT: false, ZJMP: true, NVDA_fetchFailed: false, SOXL_fetchFailed: false });
  });
  it("종합 숫자는 두 점수가 모두 있을 때만, 없으면 '없음'과 이유 (설계 5.4 '없으면 없다고')", () => {
    for (const s of Object.values(S)) expect(showComposite(s)).toBe(false);
    expect(compositeLine(S["NVDA"]!)).toEqual({ score: null, label: "없음", reason: "가치 지표 점수가 없어 합치지 않습니다" });
    expect(compositeLine(S["SOXL"]!)).toEqual({ score: null, label: "없음", reason: "가치 지표 점수가 없어 합치지 않습니다" });
    expect(compositeLine(S["SQQQ"]!)).toEqual({ score: null, label: "없음", reason: "두 점수가 모두 없습니다" });
    const both = { ...S["NVDA"]!, composite: { status: "ok", score: 63, reason: null, text: "63 · 두 점수의 평균", gap: 12, gapNote: false } } as const;
    expect(compositeLine(both)).toEqual({ score: 63, label: "63", reason: "두 점수의 평균" });
    expect(summarySpeech(both).endsWith("종합 지표 63점, 두 점수의 평균.")).toBe(true);
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
