import { describe, expect, it } from "vitest";
import { TREND_CAL, TREND_H, trendBand, trendDay, trendDisplayed, type TrendOk } from "../src/analysis/trendScore.js";
import type { Candle } from "../src/domain/types.js";
import { benchOf, candlesOf, expected, KR_SYMBOLS, US_SYMBOLS } from "./fixtures/indicatorScores/load.js";

/**
 * 추세 지표 점수 (3-44 1단계, 방법 TREND-1 · 보정 TREND-CAL-1) — 순수 함수.
 * 설계 단계 기준 구현(trend-score.mjs)을 옮긴 것이라, 같은 기록(야후 공개 일봉)에서 같은 값을 내는지 본다 (요구: 0.01 안, 실제 비교는 1e-6).
 * 설계서와 다른 두 곳: 띠는 반올림한 정수로 정하고(69.6 → 70 → 강함), h 상수는 정확한 식(반올림한 66.17 이 아니라)으로 — 둘 다 기준 구현도 식은 같다
 */

const TOL = 1e-6;

function flat(v: unknown, prefix = ""): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v === "number") out[prefix] = v;
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) Object.assign(out, flat(x, prefix ? `${prefix}.${k}` : k));
  return out;
}

describe("기준 구현과 같은 값 (예시 13종목, 9/25 미국 · 9/23 한국 종가)", () => {
  for (const sym of [...US_SYMBOLS, ...KR_SYMBOLS]) {
    it(sym, () => {
      const exp = expected.trend[sym]!;
      const r = trendDisplayed(candlesOf(sym), benchOf(sym));
      expect(r.status).toBe("ok");
      const ok = r as TrendOk & { scoreToday: number; daysAveraged: number };
      expect(ok.asOf).toBe(exp.asOf);
      expect(ok.bars).toBe(exp.bars);
      expect(ok.daysAveraged).toBe(exp.daysAveraged);
      expect(Math.abs(ok.score - exp.score)).toBeLessThan(TOL);
      expect(Math.abs(ok.scoreToday - exp.scoreToday)).toBeLessThan(TOL);
      expect(ok.coverage).toBeCloseTo(exp.coverage, 9);
      for (const [f, s] of Object.entries(exp.families)) expect(Math.abs((ok.families as Record<string, { score: number | null }>)[f]!.score! - s!)).toBeLessThan(TOL);
      for (const [k, s] of Object.entries(exp.subs)) expect(Math.abs((ok.subs as Record<string, number>)[k]! - s), k).toBeLessThan(TOL);
      for (const [k, s] of Object.entries(exp.subsToday)) expect(Math.abs((ok.subsToday as Record<string, number>)[k]! - s), k).toBeLessThan(TOL);
      // 원값(200일선 거리·RSI·변동성 …) — 화면 사실 문장의 숫자
      const got = flat(ok.raw);
      for (const [k, s] of Object.entries(flat(exp.raw))) expect(Math.abs(got[k]! - s), k).toBeLessThan(TOL);
      expect(ok.notes).toEqual([]);
      // 반올림한 정수와 띠 (설계서 13장 표와 같은 정수)
      expect(Math.round(ok.score)).toBe(Math.round(expected.full[sym]!.score));
    });
  }

  it("화면 정수·띠: NVDA 69 다소 강함 · AAPL 76 강함 · 삼성전자 68 다소 강함 · SOXX 73 강함 · RGTI 42 다소 약함 · NAVER 46 중립", () => {
    const show = (s: string) => {
      const r = trendDisplayed(candlesOf(s), benchOf(s)) as TrendOk;
      return `${Math.round(r.score)} ${trendBand(r.score)}`;
    };
    expect(["NVDA", "AAPL", "005930.KS", "SOXX", "RGTI", "035420.KS"].map(show)).toEqual(["69 다소 강함", "76 강함", "68 다소 강함", "73 강함", "42 다소 약함", "46 중립"]);
  });

  it("보정 상수·h 는 설계 값 (TREND-CAL-1, h 는 정확한 식)", () => {
    expect(TREND_CAL.version).toBe(expected.cal);
    expect(TREND_CAL.c).toEqual({ T1: 0.707, T2: 0.731, T3: 0.689, T4: 0.762, M1: 0.811, M2: 0.702, M3: 0.722, M4: 0.667, V1: 0.255, V2: 0.128 });
    // (n−1)(2n−1)/(6n), n = 200 → 66.1675 (설계서 표의 66.17 은 반올림)
    expect(TREND_H.T1).toBeCloseTo((199 * 399) / 1200, 10);
    expect(TREND_H.T2).toBeCloseTo((49 * 99) / 300, 10);
    expect(TREND_H.T3).toBeCloseTo(37.5, 2);
    expect(TREND_H.T4).toBeCloseTo(2.128, 3);
  });
});

describe("띠 (반올림한 정수로)", () => {
  it.each([
    [100, "강함"],
    [70, "강함"],
    [69.5, "강함"],
    [69.49, "다소 강함"],
    [55, "다소 강함"],
    [54.5, "다소 강함"],
    [54.49, "중립"],
    [45, "중립"],
    [44.5, "중립"],
    [44.49, "다소 약함"],
    [30, "다소 약함"],
    [29.5, "다소 약함"],
    [29.49, "약함"],
    [0, "약함"],
  ] as const)("%s → %s", (score, band) => expect(trendBand(score)).toBe(band));
  it("점수가 없으면 null", () => expect(trendBand(null)).toBeNull());
});

/** 합성 일봉: 하루 0.1% 오르고 ±1% 흔들림 (결정적) */
function synth(n: number, opt: { start?: string; drift?: number; volume?: (i: number) => number; close?: (i: number, prev: number) => number } = {}): Candle[] {
  const out: Candle[] = [];
  let d = new Date(`${opt.start ?? "2025-01-02"}T12:00:00Z`);
  let c = 100;
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d = new Date(d.getTime() + 86_400_000);
    const prev = c;
    c = opt.close ? opt.close(i, prev) : prev * (1 + (opt.drift ?? 0.001) + 0.01 * Math.sin(i * 1.7));
    out.push({ date: d.toISOString().slice(0, 10), open: prev, high: Math.max(prev, c), low: Math.min(prev, c), close: c, volume: opt.volume ? opt.volume(i) : 1_000_000 + (i % 7) * 50_000 });
    d = new Date(d.getTime() + 86_400_000);
  }
  return out;
}
const benchLike = (cs: Candle[]) => cs.map((c, i) => ({ ...c, close: 1000 * (1 + 0.0005 * i + 0.004 * Math.cos(i)) }));

describe("최소 기록·판단 불가·보류", () => {
  it("RGTX 봉 180개만: 기준 구현처럼 '기록이 180거래일이라 계산할 수 없음'", () => {
    const r = trendDay(candlesOf("RGTX").slice(0, 180), benchOf("RGTX"));
    expect(expected.shortHistory.status).toBe("unavailable");
    expect(r).toMatchObject({ status: "unavailable", reason: { code: "short", bars: 180 } });
  });

  it("199봉은 판단 불가, 200봉부터 계산 (12개월 항목 없이 — T4·M1·M4 12개월 빠짐)", () => {
    const cs = synth(200);
    const b = benchLike(cs);
    expect(trendDay(cs.slice(1), b)).toMatchObject({ status: "unavailable", reason: { code: "short", bars: 199 } });
    const r = trendDay(cs, b) as TrendOk;
    expect(r.status).toBe("ok");
    expect(r.subs.T4).toBeUndefined();
    expect(r.subs.M1).toBeUndefined();
    expect(r.subs.M4).toBeDefined(); // 6개월 상대강도만
    expect(r.notes).toContainEqual({ code: "shortYear", bars: 200 });
  });

  it("200~252봉에 비교 지수도 없으면 모멘텀 묶음을 못 만들어 판단 불가 (M2+M3 = 0.40 < 0.5)", () => {
    expect(trendDay(synth(230), null)).toMatchObject({ status: "unavailable", reason: { code: "thin" } });
  });

  it("5거래일 평균: 그날 점수들의 평균, 앞 날이 판단 불가면 계산된 날만 (201봉 → 2일)", () => {
    const cs = synth(320);
    const b = benchLike(cs);
    const d = trendDisplayed(cs, b) as TrendOk & { scoreToday: number; daysAveraged: number };
    const days = [0, 1, 2, 3, 4].map((k) => (trendDay(cs.slice(0, cs.length - k), b.filter((x) => x.date <= cs[cs.length - 1 - k]!.date)) as TrendOk).score);
    expect(d.daysAveraged).toBe(5);
    expect(d.score).toBeCloseTo(days.reduce((a, x) => a + x, 0) / 5, 10);
    expect(d.scoreToday).toBeCloseTo(days[0]!, 10);
    const short = trendDisplayed(synth(201), benchLike(synth(201))) as TrendOk & { daysAveraged: number };
    expect(short.daysAveraged).toBe(2);
    // 오늘이 판단 불가면 전체 판단 불가
    expect(trendDisplayed(synth(199), null).status).toBe("unavailable");
  });

  it("분할이 반영되지 않은 듯한 봉(종가·시가 모두 절반)이 최근 253봉 안에 있으면 보류", () => {
    const i = 280;
    const cs = synth(300, { close: (k, prev) => (k === i ? prev / 2 : prev * (1 + 0.001 + 0.01 * Math.sin(k * 1.7))) });
    cs[i] = { ...cs[i]!, open: cs[i - 1]!.close / 2 }; // 시가도 반으로 벌어짐
    expect(trendDay(cs, benchLike(cs))).toMatchObject({ status: "hold", reason: { code: "split", date: cs[i]!.date } });
    // 시가가 벌어지지 않은 급락(장중 −50%)은 보류하지 않는다
    cs[i] = { ...cs[i]!, open: cs[i - 1]!.close };
    expect(trendDay(cs, benchLike(cs)).status).not.toBe("hold");
  });

  it("지수보다 7달력일 넘게 늦은 기록(거래정지 등)은 판단 불가, 지수가 없으면 그 시장의 최근 거래일과 비교", () => {
    const cs = synth(300);
    const b = benchLike(synth(310)); // 10거래일 더 김
    expect(trendDay(cs, b)).toMatchObject({ status: "unavailable", reason: { code: "stale" } });
    expect(trendDay(cs, null, { expectedLast: "2027-01-01" })).toMatchObject({ status: "unavailable", reason: { code: "stale" } });
    expect(trendDay(cs, null, { expectedLast: cs.at(-1)!.date }).status).toBe("ok");
  });

  it("최근 63거래일 중 가격 변화 없는 날이 30% 넘으면 판단 불가", () => {
    const cs = synth(300, { close: (i, prev) => (i > 250 && i % 2 === 0 ? prev : prev * (1 + 0.002 * Math.sin(i))) });
    expect(trendDay(cs, benchLike(cs))).toMatchObject({ status: "unavailable", reason: { code: "flat" } });
  });

  it("거래량 기록이 비어 있는 날이 10% 넘으면 거래량 묶음만 빼고 계산", () => {
    const cs = synth(300, { volume: (i) => (i > 240 && i % 3 === 0 ? 0 : 1_000_000) }); // 최근 120봉 중 19일 (16%)
    const r = trendDay(cs, benchLike(cs)) as TrendOk;
    expect(r.status).toBe("ok");
    expect(r.families.V.score).toBeNull();
    expect(r.coverage).toBeCloseTo(0.9, 10);
    expect(r.notes).toContainEqual({ code: "noVolume" });
  });

  it("같은 봉이면 언제 계산해도 같은 값 (상태 없음)", () => {
    const a = trendDisplayed(candlesOf("NVDA"), benchOf("NVDA"));
    const b = trendDisplayed(candlesOf("NVDA"), benchOf("NVDA"));
    expect(a).toEqual(b);
  });

  it("지수 봉은 종목 날짜 이하의 가장 가까운 값만 쓴다 (뒤 날짜를 더해도 점수가 같다)", () => {
    const cs = candlesOf("NVDA");
    const b = benchOf("NVDA");
    const more = [...b, { date: "2026-09-28", open: 1, high: 1, low: 1, close: 99_999, volume: 0 }];
    expect((trendDay(cs, more) as TrendOk).score).toBeCloseTo((trendDay(cs, b) as TrendOk).score, 12);
  });
});
