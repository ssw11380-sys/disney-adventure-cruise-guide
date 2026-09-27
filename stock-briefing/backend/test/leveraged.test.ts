import { describe, expect, it } from "vitest";
import { classifyProduct, LEVERAGED_TABLE, leverageFacts, verifyUnderlying } from "../src/analysis/leveraged.js";
import { parseProductFacts } from "../src/providers/market/toss.js";
import { candlesOf, expected, tossInfo } from "./fixtures/indicatorScores/load.js";

/**
 * 레버리지·인버스·채권형 상품 가리기와 레버리지 주의 사실 상자 (3-44 1단계).
 * 순서: 토스 웹 상품 정보(leverageFactor·singleStockEtp) → 정적 표 → 이름 규칙. 기초자산은 표 → (미국 단일 종목 상품만) 이름.
 * 찾은 기초자산은 일봉으로 한 번 더 확인한다 — 상품 하루 수익이 기초자산 하루 수익의 L배를 따라가지 않으면 기초자산을 모르는 것으로 본다
 */

describe("토스 웹 상품 정보 읽기 (v2/stock-infos 기록 2026-09-28)", () => {
  it("SOXL: ETF · 3배 · 지수형(단일 종목 아님) · 거래소 AMX", () => {
    expect(parseProductFacts(tossInfo("SOXL"))).toEqual({
      name: "SOXL",
      englishName: "DIREXION SHARES ETF TRUST DAILY SEMICONDUCTOR BULL 3X SHS",
      detailName: "디렉시온 미국 반도체 3배 ETF",
      group: "EF",
      exchange: "AMX",
      leverageFactor: 3,
      singleStockEtp: false,
      derivativeEtf: true,
    });
  });
  it("RGTX: ETF · 2배 · 단일 종목형", () => expect(parseProductFacts(tossInfo("RGTX"))).toMatchObject({ group: "EF", exchange: "NSQ", leverageFactor: 2, singleStockEtp: true }));
  it("MSFT: 주권 · 배수 0", () => expect(parseProductFacts(tossInfo("MSFT"))).toMatchObject({ group: "ST", exchange: "NSQ", leverageFactor: 0, singleStockEtp: false, derivativeEtf: false }));
  it("칸이 없거나 이상하면 null", () => expect(parseProductFacts({ group: 3, leverageFactor: "x" })).toEqual({ name: null, englishName: null, detailName: null, group: null, exchange: null, leverageFactor: null, singleStockEtp: null, derivativeEtf: null }));
});

describe("상품 가리기", () => {
  it("SOXL → 레버리지 3배, 기초 SOXX (같은 NYSE 반도체 지수를 1배로 따르는 ETF, 정적 표)", () => {
    expect(classifyProduct("SOXL", "SOXL", parseProductFacts(tossInfo("SOXL")))).toEqual({ kind: "leveraged", L: 3, underlying: "SOXX", tracks: "NYSE 반도체 지수", source: "table", etf: true });
  });
  it("RGTX → 레버리지 2배, 기초 RGTI", () => {
    expect(classifyProduct("RGTX", "RGTX", parseProductFacts(tossInfo("RGTX")))).toMatchObject({ kind: "leveraged", L: 2, underlying: "RGTI", source: "table" });
  });
  it("표에 없는 미국 단일 종목 상품은 이름에서 기초 티커를 찾는다 (토스 배수·단일 종목 표시가 있을 때)", () => {
    expect(classifyProduct("IONX", "IONX", { englishName: "DEFIANCE DAILY TARGET 2X LONG IONQ ETF", group: "EF", leverageFactor: 2, singleStockEtp: true })).toMatchObject({ kind: "leveraged", L: 2, underlying: "IONQ", source: "name" });
    // 지수형(단일 종목 아님)은 이름으로 짐작하지 않는다
    expect(classifyProduct("XXXL", "XXXL", { englishName: "SOME DAILY SECTOR BULL 3X SHARES", group: "EF", leverageFactor: 3, singleStockEtp: false })).toMatchObject({ kind: "leveraged", L: 3, underlying: null });
  });
  it("토스 정보가 없어도 이름으로 레버리지를 알아보고, 기초는 표에서", () => {
    expect(classifyProduct("TQQQ", "ProShares UltraPro QQQ", null)).toMatchObject({ kind: "leveraged", L: 3, underlying: "QQQ" });
    expect(classifyProduct("122630", "KODEX 레버리지", null)).toMatchObject({ kind: "leveraged", L: 2, underlying: "069500" });
    // 한국 상품은 이름으로 기초를 짐작하지 않는다
    expect(classifyProduct("999990", "ACME 반도체 레버리지", null)).toMatchObject({ kind: "leveraged", L: 2, underlying: null });
  });
  it("인버스 (배수 음수·이름) → 제외", () => {
    expect(classifyProduct("SQQQ", "ProShares UltraPro Short QQQ", null)).toEqual({ kind: "inverse", etf: true });
    expect(classifyProduct("114800", "KODEX 인버스", null)).toMatchObject({ kind: "inverse" });
    expect(classifyProduct("252670", "KODEX 200선물인버스2X", null)).toMatchObject({ kind: "inverse" });
    expect(classifyProduct("ZZZZ", "ZZZZ", { group: "EF", leverageFactor: -2 })).toMatchObject({ kind: "inverse" });
  });
  it("채권·금리형 ETF → 제외 ('Ultra-Short Income' 은 인버스가 아니라 채권)", () => {
    expect(classifyProduct("153130", "KODEX 단기채권", { group: "EF" })).toEqual({ kind: "bond", etf: true });
    expect(classifyProduct("JPST", "JPMorgan Ultra-Short Income ETF", { group: "EF" })).toMatchObject({ kind: "bond" });
    expect(classifyProduct("TLT", "iShares 20+ Year Treasury Bond ETF", { group: "EF" })).toMatchObject({ kind: "bond" });
  });
  it("일반 주식·일반 ETF", () => {
    expect(classifyProduct("MSFT", "마이크로소프트", parseProductFacts(tossInfo("MSFT")))).toEqual({ kind: "normal", etf: false });
    expect(classifyProduct("QQQ", "Invesco QQQ Trust", { group: "EF", leverageFactor: 0 })).toEqual({ kind: "normal", etf: true });
    expect(classifyProduct("069500", "KODEX 200", null)).toEqual({ kind: "normal", etf: true });
    expect(classifyProduct("005930", "삼성전자", null)).toEqual({ kind: "normal", etf: false });
    // 회사 이름의 'Bull'·'Ultra' 는 레버리지가 아니다
    expect(classifyProduct("BULL", "Webull Corp", { group: "ST", leverageFactor: 0 })).toMatchObject({ kind: "normal" });
    expect(classifyProduct("UCTT", "Ultra Clean Holdings", null)).toMatchObject({ kind: "normal" });
  });
  it("정적 표: 배수 1 초과, 기초 코드 형식", () => {
    for (const [code, v] of Object.entries(LEVERAGED_TABLE)) {
      expect(v.L, code).toBeGreaterThan(1);
      expect(v.underlying, code).toMatch(/^(\d{6}|[A-Z]{1,5})$/);
    }
  });
});

describe("기초자산 확인 (일봉으로)", () => {
  it("SOXL 하루 수익 ≈ SOXX 의 3배 (최근 63거래일 상관 0.999) → 확인됨", () => {
    const v = verifyUnderlying(candlesOf("SOXL"), candlesOf("SOXX"), 3);
    expect(v.ok).toBe(true);
    expect(v.days).toBe(63);
    expect(v.corr).toBeGreaterThan(0.99);
    expect(v.beta).toBeGreaterThan(2.8);
    expect(v.beta).toBeLessThan(3.1);
  });
  it("RGTX ≈ RGTI 의 2배 → 확인됨", () => {
    const v = verifyUnderlying(candlesOf("RGTX"), candlesOf("RGTI"), 2);
    expect(v).toMatchObject({ ok: true, days: 63 });
    expect(v.beta).toBeCloseTo(2, 0);
  });
  it("엉뚱한 기초(SOXL ↔ QQQ, RGTX ↔ QQQ)는 확인되지 않는다", () => {
    expect(verifyUnderlying(candlesOf("SOXL"), candlesOf("QQQ"), 3).ok).toBe(false);
    expect(verifyUnderlying(candlesOf("RGTX"), candlesOf("QQQ"), 2).ok).toBe(false);
  });
  it("맞춘 날이 40일 미만이면 확인할 수 없음 (null)", () => {
    expect(verifyUnderlying(candlesOf("SOXL").slice(-30), candlesOf("SOXX"), 3)).toMatchObject({ ok: null, days: 29 });
  });
});

describe("레버리지 주의 사실 상자 (설계 예시 9.5 와 같은 값)", () => {
  it("SOXL: 63거래일 −29.8% · 기초 −2.9% · 단순 3배 −8.8% · 변동성 연 150% · 1년 최대 낙폭 69.4% · 변동성 손실 53.8%", () => {
    const f = leverageFacts(candlesOf("SOXL"), candlesOf("SOXX"), 3)!;
    const e = expected.leveraged.SOXL!;
    for (const k of ["sigUnderlyingAnnPct", "sigEtfAnnPct", "volDecayPctPerYear", "etf63Pct", "und63Pct", "naiveLx63Pct", "etfMdd1yPct"] as const) expect(Math.abs(f[k]! - e[k]), k).toBeLessThan(1e-9);
    expect([f.etf63Pct, f.und63Pct, f.naiveLx63Pct, f.sigEtfAnnPct, f.etfMdd1yPct, f.volDecayPctPerYear, f.sigUnderlyingAnnPct].map((v) => v!.toFixed(1))).toEqual(["-29.8", "-2.9", "-8.8", "150.0", "69.4", "53.8", "50.7"]);
    expect(f).toMatchObject({ L: 3, asOf: "2026-09-25", from: expect.stringMatching(/^2026-06-/) });
  });
  it("RGTX: −36.5% · −9.3% · −18.5% · 155% · 98.4% · 46.0%", () => {
    const f = leverageFacts(candlesOf("RGTX"), candlesOf("RGTI"), 2)!;
    expect([f.etf63Pct, f.und63Pct, f.naiveLx63Pct, f.sigEtfAnnPct, f.etfMdd1yPct, f.volDecayPctPerYear].map((v) => v!.toFixed(1))).toEqual(["-36.5", "-9.3", "-18.5", "155.4", "98.4", "46.0"]);
  });
  it("기초자산이 없으면 상품 자체 값(변동성·최대 낙폭)만", () => {
    const f = leverageFacts(candlesOf("SOXL"), null, 3)!;
    expect(f.und63Pct).toBeNull();
    expect(f.volDecayPctPerYear).toBeNull();
    expect(f.sigEtfAnnPct!.toFixed(1)).toBe("150.0");
  });
  it("기록이 64봉보다 짧으면 null", () => expect(leverageFacts(candlesOf("SOXL").slice(-50), candlesOf("SOXX"), 3)).toBeNull());
});
