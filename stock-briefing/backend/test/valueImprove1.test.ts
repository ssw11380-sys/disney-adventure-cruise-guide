import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildKrReference, krCandidates, krCommonStock, krExclusion, krIsReit, type KrMember } from "../src/analysis/krValue.js";
import { scoreWordingProblems } from "../src/analysis/scoreWording.js";
import { compactCompanyFacts, DIV_WINDOW_MISMATCH, FactBook } from "../src/analysis/secFacts.js";
import { encodeX, lossClump, METRIC_ORDER, PeerBook, type FamilyScore, type MetricScore, type ValueReferenceData } from "../src/analysis/valueScore.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parsePromptFile, PromptStore } from "../src/llm/prompts.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Candle } from "../src/domain/types.js";
import type { GenerateRequest, GenerateResult, TextGenerator } from "../src/llm/generator.js";
import { safeValueText } from "../src/services/analysisService.js";
import { FEATURES } from "../src/services/featureService.js";
import { compositeOf, type ScoreSources, type ScoresResponse, type ScoreStock } from "../src/services/indicatorScoreService.js";
import { krReasonOf } from "../src/services/krValueService.js";
import { bigPeersOf, closeGap, familyRow, flagRows, lossStreak, metricRow, priceNoteOf, reasonOf, type Core, type RowCtx } from "../src/services/valueScoreService.js";
import {
  BANK_HEALTH_NOTE,
  blendRankNote,
  blendRankZeroNote,
  closeGapText,
  compositeFormulaText,
  cyclicalWhy,
  DIRECTION_ABOUT,
  familyAboutOf,
  FIN_HEALTH_ABOUT,
  finPeerFirst,
  gapHideText,
  gapText,
  gapTextV2,
  howLinesV2,
  INSURER_HEALTH_NOTE,
  KR_FIN_MIX_NOTE,
  KR_QUARTER_GAP_TEXT,
  krFewQuartersText,
  lossAccrualText,
  lossClumpSentence,
  lossYearsText,
  moneyEok,
  oneOffAbsText,
  opPerNote,
  PEER_TIMING_NOTE_V2,
  preferredText,
  PRICE_NOTE,
  PRICE_NOTE_BASE,
  PRICE_NOTE_BLEND,
  PRICE_NOTE_SMALL,
  profitMedianText,
  SHARES_MISSING_TEXT,
  thinEquityText,
  twoSidedLine,
  twoSidedMidLine,
  VALUE_FLAG_TEXT,
  VALUE_STATUS_TEXT,
  VALUE_TRAP_V2,
} from "../src/services/valueScoreText.js";
import { readValueTextFlags, VALUE_TEXT_OFF, VALUE_TEXT_ON } from "../src/services/valueTextFlags.js";
import { benchOf, candlesOf } from "./fixtures/indicatorScores/load.js";
import { fakeKrSources, krReference, krWorld } from "./fixtures/krValue/load.js";
import { dailyOf, fakeValueSources, monthlyOf, referenceData, secExtra } from "./fixtures/valueScores/load.js";
import { fakeProviders, VALUE_STAGE1_KEYS, valueStage1 } from "./helpers.js";

/**
 * 가치 점수 개선 1단계 (2026-09-29, 사용자 결정 '추천대로' — 검토 보고서 개선안 [2]·[3]·[4]·[5]·[8 서버]·[9]·[10] + 급한 버그 두 가지).
 *  - 글 플래그 13개: 기본 켬, 끄면 지금과 한 글자도 같음(공용 픽스처 *_stage1Off · 아래 켬/끔 비교), 켜도 점수 숫자는 그대로
 *  - 급한 버그(플래그와 상관없이): 한국 리츠를 이름 속 '리츠' 글자로 가리던 것(메리츠금융지주·블리츠웨이) · KO 배당을 52/53주 창에서 5번 센 것
 * 네트워크 없음 — 기록한 SEC 재무·비교 기준·일봉·네이버 재무 요약, 고정 시계
 */

const kst = (s: string) => new Date(`${s}+09:00`);
let app: FastifyInstance | null = null;
let db: Db;
afterEach(async () => {
  await app?.close();
  app = null;
});

// ── 플래그 ─────────────────────────────────────────────

describe("플래그 13개 (서버 기본 켬, 끄면 지금 그대로)", () => {
  it("모두 서버 FEATURES 에 있고 기본 켬, 설명에 '끄면'", () => {
    for (const k of VALUE_STAGE1_KEYS) {
      expect(FEATURES[k].default, k).toBe(true);
      expect(FEATURES[k].description, k).toMatch(/끄면/);
    }
    expect(Object.keys(VALUE_TEXT_ON)).toEqual(Object.keys(VALUE_TEXT_OFF));
  });
  it("글 플래그 읽기: 켜진 것만 true, 읽기 실패는 끔 (예전 글)", async () => {
    const on = new Set(["valueDirectionWords", "valueWordingFacts"]);
    const t = await readValueTextFlags({ enabled: async (k) => on.has(k) });
    expect(t).toEqual({ ...VALUE_TEXT_OFF, directionWords: true, wordingFacts: true });
    expect(await readValueTextFlags({ enabled: async () => Promise.reject(new Error("DB")) })).toEqual(VALUE_TEXT_OFF);
    expect(await readValueTextFlags(null)).toEqual(VALUE_TEXT_OFF);
  });
});

// ── 켬 ↔ 끔: 점수 숫자는 모두 같다 ─────────────────────────────

const STOCKS: Record<string, ScoreStock> = {
  NVDA: { code: "NVDA", name: "엔비디아", market: "NASDAQ" },
  MSFT: { code: "MSFT", name: "마이크로소프트", market: "NASDAQ" },
  AAPL: { code: "AAPL", name: "애플", market: "NASDAQ" },
  META: { code: "META", name: "메타", market: "NASDAQ" },
  JPM: { code: "JPM", name: "JP모건 체이스", market: "NYSE" },
  RGTI: { code: "RGTI", name: "리게티 컴퓨팅", market: "NASDAQ" },
  COST: { code: "COST", name: "코스트코", market: "NASDAQ" },
  ZZGAP: { code: "ZZGAP", name: "예시 종목 (두 점수 차이 큼)", market: "NASDAQ" },
  "005930": { code: "005930", name: "삼성전자", market: "KOSPI" },
  "000660": { code: "000660", name: "SK하이닉스", market: "KOSPI" },
  "105560": { code: "105560", name: "KB금융", market: "KOSPI" },
};
const US = ["NVDA", "MSFT", "AAPL", "META", "JPM", "RGTI", "COST", "ZZGAP"];
const KR = ["005930", "000660", "105560"];
const candles = (code: string): Candle[] => (code === "JPM" ? dailyOf("JPM") : candlesOf(/^\d{6}$/.test(code) ? `${code}.KS` : code === "ZZGAP" ? "NVDA" : code));
const sources = (): ScoreSources => ({
  stock: async (code) => STOCKS[code] ?? null,
  candles: async (code, count) => ({ code, period: "D", candles: candles(code).slice(-count), source: "yahoo" }),
  benchmark: async (code) => (code === "NASDAQ" ? benchOf("NVDA") : code === "KOSPI" ? benchOf("005930.KS") : code === "SPX" ? dailyOf("SPX") : null),
  product: async () => null,
  registered: async () => [],
  monthly: async (code) => monthlyOf(code === "ZZGAP" ? "NVDA" : code),
});

async function responses(on: boolean): Promise<Record<string, ScoresResponse>> {
  db = await createMigratedDb(":memory:");
  const clock = kst("2026-09-28T10:00:00");
  app = await buildApp({
    config: loadConfig({ DATABASE_URL: ":memory:" }),
    db,
    providers: fakeProviders({ scoreSources: sources(), valueSources: fakeValueSources({ alias: { ZZGAP: "RGTI" } }).src, krValueSources: fakeKrSources().src }),
    logger: false,
    enableScheduler: false,
    now: () => clock,
  });
  await app.inject({ method: "PUT", url: "/api/admin/features", payload: valueStage1(on) });
  await app.valueScores.saveReference(referenceData());
  await app.krValue.saveReference(krReference());
  for (const c of US) await app.valueScores.refreshFacts(c);
  for (const c of KR) await app.krValue.refreshFacts(c);
  const out: Record<string, ScoresResponse> = {};
  for (const c of [...US, ...KR]) out[c] = (await app.inject({ method: "GET", url: `/api/scores/${c}` })).json() as ScoresResponse;
  await app.close();
  app = null;
  return out;
}
/** 점수 칸만 (가치·묶음·지표 위치 점수·쓴 지표·추세·종합의 차이) */
const scoresOf = (r: ScoresResponse) => ({
  value: [r.value.status, r.value.score, r.value.scoreExact, r.value.band, r.value.coverageWeight],
  families: r.value.families.map((f) => [f.key, f.score, f.scoreExact, f.metrics.map((m) => [m.key, m.score, m.used])]),
  trend: [r.trend.status, r.trend.score, r.trend.scoreExact],
  gap: r.composite.gap,
});
const texts = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === "object" ? Object.values(v).flatMap(texts) : []);

describe("켬 ↔ 끔: 점수 숫자는 하나도 바뀌지 않는다 (미국 8 · 한국 3 — 공용 픽스처 종목)", () => {
  it("가치·묶음·지표 위치 점수·추세·두 점수 차이가 모두 같고, 종합은 차이 30 넘는 종목만 숫자 대신 문장 · 새 글에 금지어 0", async () => {
    const off = await responses(false);
    const on = await responses(true);
    for (const c of [...US, ...KR]) {
      expect(scoresOf(on[c]!), c).toEqual(scoresOf(off[c]!));
      const g = off[c]!.composite.gap;
      if (g !== null && g > 30) {
        expect(on[c]!.composite, c).toMatchObject({ status: "none", score: null, reason: "gapWide", text: `없음 · ${gapHideText(g)}` });
        expect(off[c]!.composite.score, c).not.toBeNull();
      } else expect(on[c]!.composite.score, c).toBe(off[c]!.composite.score);
      expect(texts(on[c]).flatMap((t) => scoreWordingProblems(t)), c).toEqual([]);
    }
    // 켜면 실제로 글이 바뀐다 (묶음 설명 · 두 쪽 문장 · 식)
    expect(on["NVDA"]!.value.families[0]!.about).toBe(DIRECTION_ABOUT.price);
    expect(on["NVDA"]!.composite.formula).toBe(compositeFormulaText(on["NVDA"]!.value.score!, on["NVDA"]!.trend.score!));
    expect(off["NVDA"]!.composite.formula).toBeUndefined();
  });
});

// ── [2] 방향 말 · 두 쪽 문장 ─────────────────────────────────

const peer = (o: Partial<NonNullable<MetricScore["peer"]>> = {}): NonNullable<MetricScore["peer"]> => ({ level: "industry", name: "Semiconductors", n: 68, median: 0.02, tie: 0.1, tieX: 1, ...o });
const ms = (key: MetricScore["key"], score: number, o: Partial<MetricScore> = {}): MetricScore => ({
  key,
  adopted: true,
  x: 0.02,
  show: 50,
  score,
  pos: { industry: score, market: score },
  mix: { industry: 71, market: 29 },
  peer: peer(),
  ownN: 0,
  ...o,
});
const fam = (key: FamilyScore["key"], metrics: MetricScore[], score: number): FamilyScore => ({ key, weight: 30, score, valid: true, why: null, metrics });
const ON: RowCtx = { path: "general", annualEnd: "2026-01-25", text: { ...VALUE_TEXT_ON } };

describe("[2] 방향 말 · 두 쪽 문장 (valueDirectionWords · valueFamilyTwoSided)", () => {
  it("묶음 설명은 '막대가 길수록' — 금융사 주가 수준은 매출 없이, 한국 간이는 성장 2년·배당 하나, 끄면 예전 '높을수록'", () => {
    expect(familyAboutOf("price", { direction: true })).toBe("막대가 길수록: 이익·순자산·매출에 비해 주가가 낮은 쪽 (비교 회사 기준)");
    expect(familyAboutOf("price", { direction: true, path: "financial" })).toBe("막대가 길수록: 이익·순자산에 비해 주가가 낮은 쪽 (비교 회사 기준)");
    expect(familyAboutOf("growth", { direction: true, grade: "lite" })).toBe("막대가 길수록: 최근 2년 늘어난 폭이 큰 쪽");
    expect(familyAboutOf("payout", { direction: true, grade: "lite" })).toBe("막대가 길수록: 주가에 비해 배당이 많은 쪽");
    expect(familyAboutOf("price", {})).toBe("높을수록 이익·자산·매출에 비해 주가 수준이 낮은 편");
    // [5] 금융사 건전성은 방향 말을 꺼도 금융사 설명
    expect(familyAboutOf("health", { path: "financial", financial: true })).toBe(FIN_HEALTH_ABOUT);
    expect(PEER_TIMING_NOTE_V2).toContain("주가 수준 막대가 조금 길게(주가가 실제보다 낮은 쪽으로)");
    expect(PEER_TIMING_NOTE_V2).not.toContain("SEC 공통 자료");
  });

  it("엔비디아 주가 수준 49: 길게 만든 지표 80·71 / 짧게 만든 지표 5·25 (보고서 그림 2), 가운데쯤 64 는 빼고, 가장 튀는 순", () => {
    const f = fam("price", [ms("A1", 71), ms("A2", 80), ms("A3", 5), ms("A4", 25), ms("A5", 64)], 49);
    expect(familyRow(f, ON).text).toBe("막대를 길게 만든 지표: 기업가치 ÷ 영업이익 80 · PER 71\n막대를 짧게 만든 지표: PBR 5 · PSR 25");
    // 띠가 높은 편인 묶음은 긴 쪽만, 낮은 편은 짧은 쪽만 (소수 쪽 지표를 대표로 말하지 않게)
    expect(familyRow(fam("quality", [ms("B1", 100), ms("B6", 1)], 70), ON).text).toBe("막대를 길게 만든 지표: ROE 100");
    expect(familyRow(fam("quality", [ms("B1", 90), ms("B4", 10), ms("B2", 5)], 30), ON).text).toBe("막대를 짧게 만든 지표: ROIC 5 · 영업이익률 10");
    // 67 이상·33 이하가 없으면 가운데쯤 지표를 그대로
    expect(familyRow(fam("payout", [ms("E1", 65)], 65), ON).text).toBe("가운데쯤(34~66)인 지표: 배당수익률 65");
    // 끄면 예전 한 줄 (가장 튀는 지표 하나)
    expect(familyRow(f).text).toBe("PBR (순자산 대비 주가) — 순자산에 비해 주가 수준이 높은 편입니다.");
  });

  it("0점 규칙 지표는 '(적자)'처럼 사실을 붙이고, 같은 값 덩어리 지표는 '(비교 회사 77%가 0.0%)'를 붙인다", () => {
    const z = ms("A1", 0, { x: -Infinity, rule: "zeroLoss", why: "lossNi", show: null, pos: { industry: 0, market: 0 } });
    const fcf = ms("A5", 0, { x: -Infinity, rule: "zeroLoss", why: "lossFcf", show: -1.7, pos: { industry: 0, market: 0 } });
    expect(familyRow(fam("price", [z, ms("A3", 9), fcf], 3), ON).text).toBe("막대를 짧게 만든 지표: PER 0(적자) · 잉여현금흐름 수익률 0(마이너스) · PBR 9");
    const e1 = ms("E1", 82, { x: 0.001, show: 0.1, peer: peer({ tie: 0.77, tieX: 0 }) });
    expect(familyRow(fam("payout", [e1, ms("E2", 72)], 77), ON).text).toBe("막대를 길게 만든 지표: 배당수익률 82(비교 회사 77%가 0.0%) · 주식 수 변화 72");
    expect(twoSidedLine(true, [["PER", 71]])).toBe("막대를 길게 만든 지표: PER 71");
    expect(twoSidedMidLine([["ROE", 49], ["ROA", 55]])).toBe("가운데쯤(34~66)인 지표: ROE 49 · ROA 55");
  });

  it("가치 함정 표시도 막대 말로 (끄면 예전 글)", () => {
    const rows = flagRows(["valueTrap"], { ...VALUE_TEXT_OFF, directionWords: true }, { oneOffPct: null, lossYears: null, fallbackText: "", carried: null });
    expect(rows).toEqual([{ key: "valueTrap", text: VALUE_TRAP_V2 }]);
    expect(flagRows(["valueTrap"], VALUE_TEXT_OFF, { oneOffPct: null, lossYears: null, fallbackText: "", carried: null })).toEqual([{ key: "valueTrap", text: VALUE_FLAG_TEXT.valueTrap }]);
  });
});

// ── [3] PER 줄 정직하게 ─────────────────────────────────────

describe("[3] PER 줄 · 적자 회사 덩어리 · 가격 안내 · 영업 외 손익 (점수 그대로)", () => {
  it("적자 회사 덩어리: 흑자 회사 가운데값·적자 비율·흑자 회사끼리 위치 (0점 규칙 회사는 위치 없음)", () => {
    // 업종 10곳: 적자 4 (−∞) + 흑자 6, 시장 20곳: 적자 5 + 흑자 15. 대상 종목 이익수익률 0.05 (PER 20배)
    const ind = [-Infinity, -Infinity, -Infinity, -Infinity, 0.01, 0.02, 0.03, 0.04, 0.06, 0.08];
    const mkt = [...Array(5).fill(-Infinity), ...Array.from({ length: 15 }, (_, i) => 0.01 * (i + 1) + 0.001)];
    const c = lossClump(0.05, ind, mkt, null, { industry: 71, market: 29 }, undefined);
    expect(c.share).toBeCloseTo(0.4, 10);
    expect(c.median).toBeCloseTo(0.035, 10);
    expect(c.pos.industry).toBeCloseTo((100 * 4) / 6, 10);
    expect(c.pos.market).toBeCloseTo((100 * 4) / 15, 10);
    expect(c.score).toBeCloseTo(0.71 * ((100 * 4) / 6) + 0.29 * ((100 * 4) / 15), 10);
    // 자기 값은 뺀다, 0점 규칙(적자) 회사는 흑자 회사끼리 위치를 계산하지 않는다
    expect(lossClump(0.05, [...ind, 0.05].sort((a, b) => a - b), mkt, 0.05, { industry: 71, market: 29 }, undefined).share).toBeCloseTo(0.4, 10);
    expect(lossClump(-Infinity, ind, mkt, null, { industry: 71, market: 29 }, undefined)).toMatchObject({ pos: {}, score: null });
  });

  it("엔비디아 식 PER 줄: 첫 숫자는 최근 4분기 PER '(최근 4분기 · 흔히 쓰는 계산)', 섞은 값은 한 줄, 가운데값은 흑자 회사끼리, 띠가 달라지면 까닭 문장", () => {
    const a1 = ms("A1", 71, {
      x: 1 / 44.8,
      show: 44.8,
      blend: true,
      pos: { industry: 76, market: 57 },
      loss: { share: 0.43, median: 1 / 58.6, pos: { industry: 59, market: 24 }, score: 0.71 * 59 + 0.29 * 24 },
    });
    const ctx: RowCtx = { ...ON, extra: { plainPer: 28.3, cyclical: { byIndustry: true, lo: null, hi: null } } };
    const row = metricRow(a1, ctx);
    expect(row.value).toBe("28.3배 (최근 4분기 · 흔히 쓰는 계산)");
    expect(row.peerMedian).toBe("흑자 회사 가운데값 58.6배 · 비교한 업종 68곳 중 43%는 적자");
    expect(row.positions).toBe("업종 안 위치 76/100 (흑자 회사끼리 59) · 시장 안 57/100 (흑자 회사끼리 24)");
    expect(row.text).toBe("비교한 회사의 43%가 적자라 위치 점수가 크게 나왔습니다. 흑자 회사끼리 보면 가운데쯤입니다.");
    expect(row.note).toBe("순위에는 최근 4분기 이익과 5년 평균 이익을 반씩 섞은 44.8배를 썼습니다(업황에 따라 이익이 크게 오르내리는 업종이라).");
    expect(row.score).toBe(71); // 점수는 그대로
    // 끄면 예전 줄 ('100배 넘음'·섞은 값·예전 섞기 안내)
    const old = metricRow({ ...a1, peer: peer({ median: 1 / 150 }) });
    expect(old).toMatchObject({ value: "44.8배", peerMedian: "업종 가운데값 100배 넘음", positions: "업종 안 위치 76/100 · 시장 안 57/100", text: "이익에 비해 주가 수준이 낮은 편입니다." });
    expect(old.note).toBe("업황에 따라 이익이 크게 오르내리는 회사라, 최근 4분기 이익과 5년 평균 이익을 반씩 섞어 계산했습니다.");
  });

  it("팔란티어 식: 경기 민감 까닭이 이익률이면 실제 숫자, 흑자끼리 띠가 낮으면 그 문장 · 인텔 식: 섞은 이익도 0 이하", () => {
    expect(cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6 })).toBe("최근 5년 영업이익률이 가장 낮은 해 −26.7%, 가장 높은 해 31.6%로 오르내림이 커서");
    expect(lossClumpSentence("A1", 58, 3)).toBe("비교한 회사의 58%가 적자라 위치 점수가 크게 나왔습니다. 흑자 회사끼리 보면 이익에 비해 주가 수준이 높은 편입니다.");
    expect(lossClumpSentence("A2", 47, 50)).toBe("비교한 회사의 47%가 영업적자라 위치 점수가 크게 나왔습니다. 흑자 회사끼리 보면 가운데쯤입니다.");
    expect(profitMedianText("A2", "73.4배", "업종", 64, 47)).toBe("영업이익 흑자 회사 가운데값 73.4배 · 비교한 업종 64곳 중 47%는 영업적자");
    expect(blendRankNote("278.0배", cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6 }))).toContain("섞은 278.0배를 썼습니다(최근 5년 영업이익률이 가장 낮은 해");
    expect(blendRankZeroNote("업황에 따라 이익이 크게 오르내리는 업종이라", true)).toBe("순위에는 최근 4분기 이익과 5년 평균 이익을 반씩 섞은 값을 썼습니다(업황에 따라 이익이 크게 오르내리는 업종이라). 섞은 이익도 0 이하라 0점입니다.");
    const z = ms("A1", 0, { x: -Infinity, rule: "zeroLoss", why: "lossNi", show: null, blend: true, pos: {} });
    expect(metricRow(z, { ...ON, extra: { plainPer: "loss" } }).value).toBe("적자 (최근 4분기 · 흔히 쓰는 계산)");
  });

  it("가격 안내: 기본 · 경기 민감(섞기로 크게 다름) · 마지막 종가가 20일 평균과 5% 넘게 다르면 그 가격의 PER·PBR, 끄면 예전 한 줄", () => {
    const t = { ...VALUE_TEXT_ON };
    expect(priceNoteOf(t, { blend: false, close: null })).toBe(`${PRICE_NOTE_BASE} ${PRICE_NOTE_SMALL}`);
    expect(priceNoteOf(t, { blend: true, close: null })).toBe(`${PRICE_NOTE_BASE} ${PRICE_NOTE_BLEND}`);
    const meta = closeGap(660.86, { date: "2026-09-25", close: 751.66 }, 24.9, 6.49);
    expect(meta).toBe(closeGapText("2026-09-25", 13.74, "28.3배", "7.4배"));
    expect(meta).toBe("9월 25일(금) 종가가 20거래일 평균보다 13.7% 높아, 그 가격으로는 PER 28.3배 · PBR 7.4배입니다.");
    expect(closeGap(100, { date: "2026-09-25", close: 104 }, 20, 2)).toBeNull(); // 5% 안이면 없음
    expect(closeGap(100, { date: "2026-09-25", close: 118 }, null, 6.1)).toBe("9월 25일(금) 종가가 20거래일 평균보다 18.0% 높아, 그 가격으로는 PBR 7.2배입니다."); // 적자: PBR 만
    expect(priceNoteOf(VALUE_TEXT_OFF, { blend: true, close: meta })).toBe(PRICE_NOTE);
  });

  it("영업 외 손익: 세전이익의 30% 이상일 때만 표시(시장 상위 5% 기준 대신) + PER 줄 '영업이익 기준 PER'", () => {
    const base = { lossYears: null, fallbackText: "", carried: null };
    expect(flagRows(["oneOff"], { ...VALUE_TEXT_OFF, oneOffAbs: true }, { ...base, oneOffPct: null })).toEqual([]);
    expect(flagRows(["cyclicalPeak"], { ...VALUE_TEXT_OFF, oneOffAbs: true }, { ...base, oneOffPct: 51 })).toEqual([
      { key: "cyclicalPeak", text: VALUE_FLAG_TEXT.cyclicalPeak },
      { key: "oneOff", text: oneOffAbsText(51) },
    ]);
    expect(flagRows(["oneOff"], VALUE_TEXT_OFF, { ...base, oneOffPct: null })).toEqual([{ key: "oneOff", text: VALUE_FLAG_TEXT.oneOff }]);
    const a1 = ms("A1", 81, { x: 1 / 17.2, show: 17.2 });
    expect(metricRow(a1, { ...ON, extra: { opPer: { taxPct: 18, per: 35 } } }).note).toBe(opPerNote(18, "35.0배"));
    expect(opPerNote(18, "35.0배")).toBe("영업이익으로 계산하면(세금 18% 가정) PER 약 35.0배입니다.");
  });
});

// ── [4] 종합 ─────────────────────────────────────────────

describe("[4] 종합 줄 (compositeFormula · compositeGapHide)", () => {
  const V = (score: number) => ({ status: "ok" as const, score, asOf: { priceThrough: "2026-09-25" } as never });
  const T = (score: number) => ({ status: "ok" as const, score, reason: null });
  it("식 '= (51 + 80) ÷ 2', 차이 25점부터 안내(명령형 없음), 30점 넘으면 숫자 대신 '없음 · 까닭'", () => {
    const on = { formula: true, gapHide: true };
    expect(compositeOf(V(51), T(80), "2026-09-25", on)).toEqual({ status: "ok", score: 66, reason: null, text: "두 점수의 평균", gap: 29, gapNote: true, gapText: "두 점수 차이가 29점입니다. 평균 하나로는 이 차이가 가려집니다.", formula: "= (51 + 80) ÷ 2" });
    expect(compositeOf(V(50), T(75), "2026-09-25", on)).toMatchObject({ score: 63, gapNote: true, gapText: gapTextV2(25) });
    expect(compositeOf(V(50), T(74), "2026-09-25", on)).toMatchObject({ score: 62, gapNote: false, gapText: null });
    expect(compositeOf(V(40), T(70), "2026-09-25", on)).toMatchObject({ status: "ok", score: 55, gap: 30, gapNote: true });
    expect(compositeOf(V(30), T(71), "2026-09-25", on)).toEqual({ status: "none", score: null, reason: "gapWide", text: "없음 · 두 점수 차이가 41점이라 평균을 보이지 않습니다", gap: 41, gapNote: false, gapText: null });
    // 끄면 지금 그대로 (30점부터 안내, '함께 보세요')
    expect(compositeOf(V(51), T(80), "2026-09-25")).toEqual({ status: "ok", score: 66, reason: null, text: "두 점수의 평균", gap: 29, gapNote: false, gapText: null });
    expect(compositeOf(V(30), T(71), "2026-09-25")).toMatchObject({ status: "ok", score: 51, gapText: gapText(41) });
    expect(gapText(41)).toContain("함께 보세요");
    expect(gapTextV2(41)).not.toMatch(/세요/);
    // 없는 점수는 예전처럼 (식·숨김과 상관없이)
    expect(compositeOf({ status: "insufficient", score: null, asOf: { priceThrough: null } as never }, T(60), "2026-09-25", on)).toMatchObject({ status: "none", reason: "valueMissing" });
  });
  it("구성·계산 방법의 종합 줄에 '30점 넘으면 숫자 대신 까닭' (끄면 예전 줄)", () => {
    expect(howLinesV2(true, { gapHide: true })[4]).toMatch(/두 점수 차이가 30점을 넘으면 종합 숫자 대신 그 까닭을 적습니다\.$/);
    expect(howLinesV2(true, { gapHide: false })).toEqual(howLinesV2(true));
  });
});

// ── [5] 금융사 재무 건전성 ─────────────────────────────────

describe("[5] 금융사 재무 건전성 글 (valueFinancialNote · valueInsurerNote)", () => {
  it("은행: 실제 비율 · 업종 가운데값 · 큰 은행 가운데값 + 감독 자본비율과 다른 단순 비율 안내, 한국은 함께 비교한 업종 사실", () => {
    const f3 = ms("F3", 5, { x: 0.075, show: 7.5, peer: peer({ name: "Major Banks", n: 228, median: 0.111 }) });
    const f: FamilyScore = { key: "health", weight: 10, score: 5, valid: true, why: null, metrics: [f3] };
    const ctx: RowCtx = { path: "financial", annualEnd: null, text: { ...VALUE_TEXT_ON }, extra: { finKind: "bank", groupName: "은행", bigPeers: { word: "은행", n: 7, median: 0.093 } } };
    const row = familyRow(f, ctx);
    expect(row.about).toBe("막대가 길수록: 총자산에 비해 자기자본 여유가 큰 쪽");
    expect(row.text).toBe(`자기자본 ÷ 총자산 7.5% · 은행 가운데값 11.1% · 시가총액 500억 달러 넘는 은행 7곳 가운데값 9.3%\n${BANK_HEALTH_NOTE}`);
    expect(row.score).toBe(5);
    // 보험사 (valueInsurerNote) · 한국 금융사 (은행·보험·증권·카드를 함께 비교)
    expect(familyRow(f, { ...ctx, market: "KR", extra: { finKind: "insurer", groupName: null } }).text).toBe(`자기자본 ÷ 총자산 7.5% · 업종 가운데값 11.1%\n${KR_FIN_MIX_NOTE} ${INSURER_HEALTH_NOTE}`);
    // 끄면 예전 한 줄
    expect(familyRow(f, { path: "financial", annualEnd: null }).text).toBe("자기자본 ÷ 총자산 — 총자산에 비해 자기자본이 얇은 편입니다.");
    expect(finPeerFirst("은행", 228, 186)).toBe("같은 업종(은행 · Nasdaq 분류, 228곳 — 그중 186곳은 시가총액 50억 달러 미만)");
  });

  it("큰 은행 가운데값은 시가총액을 아는 회사가 80% 넘을 때만, 3곳 이상일 때만 (JP모건 자신은 뺌)", () => {
    const ix = METRIC_ORDER.indexOf("F3");
    const row = (c: string, t: string, eqA: number) => ({ c, t, s: 0, i: 0, f: 1 as const, x: METRIC_ORDER.map((_, j) => (j === ix ? encodeX(eqA) : null)) });
    const peers = [row("1", "JPM", 0.075), row("2", "BAC", 0.086), row("3", "WFC", 0.093), row("4", "USB", 0.1), row("5", "SML", 0.12)];
    const ref = { v: 1, method: "x", market: "US", refDate: "2026-09-26", screenerDate: "2026-09-26", periods: { annual: [], latest: [], yearAgo: [] }, sectors: ["Finance"], industries: ["Major Banks"], symbols: {}, peers, thresholds: {} as never, coverage: { general: {}, financial: {} }, counts: {} as never, missingFrames: [], quotes: { JPM: [8e11, 300], BAC: [3e11, 45], WFC: [2.5e11, 80], USB: [7e10, 45], SML: [1e9, 20] } } as unknown as ValueReferenceData;
    const book = new PeerBook(ref);
    expect(bigPeersOf(book, "financial", "industry", "Major Banks", "1", "bank")).toEqual({ word: "은행", n: 3, median: 0.093 });
    expect(bigPeersOf(book, "financial", "industry", "Major Banks", "1", "insurer")).toBeNull();
    expect(bigPeersOf(new PeerBook({ ...ref, quotes: { BAC: [3e11, 45] } }), "financial", "industry", "Major Banks", "1", "bank")).toBeNull();
  });
});

// ── [9] 이유 글 · 급한 버그: 한국 리츠 ─────────────────────────

describe("[9] 점수 없음·대상 아님 이유 글 (valueReasonDetail)", () => {
  it("버크셔 B: 주식 수 자료를 읽지 못함 (회사 재무 문제 아님) · 한국 분기 실적 3개 · 빈 값 · 우선주 사실 한 줄, 끄면 예전 글", () => {
    const brk: Core = { status: "insufficient", reason: { code: "priceInvalid", text: VALUE_STATUS_TEXT.priceInvalid }, detail: "sharesMissing" };
    expect(reasonOf(brk, { ...VALUE_TEXT_ON })).toEqual({ code: "sharesMissing", text: SHARES_MISSING_TEXT });
    expect(reasonOf(brk, VALUE_TEXT_OFF)).toEqual(brk.reason);
    const epis: Core = { status: "insufficient", reason: { code: "priceInvalid", text: VALUE_STATUS_TEXT.priceInvalid }, detail: "fewQuarters:3" };
    expect(krReasonOf(epis, { ...VALUE_TEXT_ON })).toEqual({ code: "krFewQuarters", text: krFewQuartersText(3) });
    expect(krFewQuartersText(3)).toBe("재무 요약에 분기 실적이 아직 3개뿐입니다(4개 필요 — 새로 상장했거나 분할로 새로 생긴 회사 등). 회사 재무에 문제가 있다는 뜻은 아닙니다.");
    expect(krReasonOf({ ...epis, detail: "quarterGap" }, { ...VALUE_TEXT_ON })).toEqual({ code: "krQuarterGap", text: KR_QUARTER_GAP_TEXT });
    expect(krReasonOf(epis, VALUE_TEXT_OFF)).toEqual(epis.reason);
    expect(preferredText("삼성전자")).toBe("우선주는 따로 계산하지 않습니다. 같은 회사 보통주(삼성전자) 화면에 가치 지표 점수가 있습니다.");
    expect(preferredText(null)).toBe("우선주는 따로 계산하지 않습니다.");
    expect(VALUE_STATUS_TEXT.preferred).toContain("참고하세요"); // 끄면 예전 글
  });
});

describe("급한 버그: 한국 리츠를 이름 속 '리츠' 글자로 가리던 것 (플래그와 상관없이)", () => {
  it("공식 분류 먼저 — 마스터 리츠 목록 → 마스터 분류 RT → 네이버 업종 280 안의 '리츠' 이름 → 이름 끝 '리츠'", () => {
    // 2026-09-28 네이버 업종 구성 종목: 메리츠금융지주 321(증권) · 블리츠웨이 285(방송과엔터테인먼트) · 이리츠코크렙·SK리츠 280(부동산) · SK디앤디 280(리츠 아님)
    expect(krIsReit("138040", "메리츠금융지주", { upjongCode: "321" })).toBe(false);
    expect(krIsReit("369370", "블리츠웨이엔터테인먼트", { upjongCode: "285" })).toBe(false);
    expect(krIsReit("088260", "이리츠코크렙", { upjongCode: "280" })).toBe(true);
    expect(krIsReit("395400", "SK리츠", { upjongCode: "280" })).toBe(true);
    expect(krIsReit("210980", "SK디앤디", { upjongCode: "280" })).toBe(false);
    // 마스터 분류가 있으면 그것 (한국투자증권 종목 정보 group_code 'RT')
    expect(krIsReit("138040", "메리츠금융지주", { groupCode: "ST" })).toBe(false);
    expect(krIsReit("088260", "이리츠코크렙", { groupCode: "RT" })).toBe(true);
    const master = new Set(["088260", "395400"]);
    expect(krIsReit("088260", "이리츠코크렙", { reitCodes: master })).toBe(true);
    expect(krIsReit("138040", "메리츠금융지주", { reitCodes: master, upjongCode: "280" })).toBe(false);
    // 아무것도 모를 때만 이름 끝
    expect(krIsReit("138040", "메리츠금융지주")).toBe(false);
    expect(krIsReit("395400", "SK리츠")).toBe(true);
    expect(krExclusion("138040", "메리츠금융지주")).toBeNull();
    expect(krExclusion("0088D0", "메리츠제1호스팩")).toBe("spac");
    expect(krExclusion("005935", "삼성전자우")).toBe("preferred");
  });

  it("비교 회사: 메리츠금융지주가 다시 후보·비교 기준에 들어간다 (리츠는 여전히 빠짐)", () => {
    const m = (code: string, name: string, upjong: string, upjongCode: string, cap: number): KrMember => ({ code, name, market: "KOSPI", endType: "stock", price: 10_000, marketCap: cap, upjong, upjongCode });
    const meritz = m("138040", "메리츠금융지주", "증권", "321", 22e12);
    const reit = m("395400", "SK리츠", "부동산", "280", 1.6e12);
    expect(krCommonStock(meritz)).toBe(true);
    expect(krCommonStock(reit)).toBe(false);
    expect(krCommonStock(meritz, new Set(["138040"]))).toBe(false); // 마스터 목록이 있으면 그것대로
    const world = krWorld();
    const members = [...world.members, meritz, reit];
    expect(krCandidates(members).map((x) => x.code)).toContain("138040");
    const facts = new Map(world.facts);
    facts.set("138040", { ...world.facts.get("105560")!, code: "138040" });
    facts.set("395400", { ...world.facts.get("105560")!, code: "395400" });
    const ref = buildKrReference(members, facts, "2026-09-27");
    expect(ref.peers.some((p) => p.c === "138040")).toBe(true);
    expect(ref.peers.some((p) => p.c === "395400")).toBe(false);
  });

  it("화면: 메리츠금융지주는 '대상 아님 · 리츠…' 대신 점수를 계산한다 (마스터 분류 ST)", async () => {
    db = await createMigratedDb(":memory:");
    const clock = kst("2026-09-28T10:00:00");
    const world = krWorld();
    const meritz: KrMember = { code: "138040", name: "메리츠금융지주", market: "KOSPI", endType: "stock", price: 150_000, marketCap: 22e12, upjong: "은행", upjongCode: "301" };
    const kr = fakeKrSources({ members: [...world.members, meritz], alias: { "138040": "105560" } });
    const stocks: Record<string, ScoreStock> = { "138040": { code: "138040", name: "메리츠금융지주", market: "KOSPI", groupCode: "ST" } };
    const src: ScoreSources = { ...sources(), stock: async (c) => stocks[c] ?? null, candles: async (c, n) => ({ code: c, period: "D", candles: candlesOf("005930.KS").slice(-n), source: "yahoo" }) };
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ scoreSources: src, valueSources: fakeValueSources().src, krValueSources: kr.src }), logger: false, enableScheduler: false, now: () => clock });
    await app.krValue.saveReference(buildKrReference(world.members, world.facts, "2026-09-27"));
    await app.krValue.refreshFacts("138040");
    const r = (await app.inject({ method: "GET", url: "/api/scores/138040" })).json() as ScoresResponse;
    expect(r.value.reason?.code).not.toBe("reit");
    expect(r.value.text).not.toContain("리츠");
    expect(["ok", "partial", "hold"]).toContain(r.value.status);
  });
});

// ── [10] 사실과 다른 문장 ───────────────────────────────────

describe("[10] 사실과 다른 설명 문장 (valueWordingFacts)", () => {
  it("순손실 회사의 이익의 현금 뒷받침: 좋은 뜻의 문장 대신 숫자 사실, 묶음 머리 문장으로 고르지 않음 (점수 그대로)", () => {
    const b6 = ms("B6", 98, { x: 0.277, show: -27.7 });
    const ctx: RowCtx = { ...ON, extra: { ni: -2.39e8, ocf: -0.61e8, unit: "USD" } };
    expect(metricRow(b6, ctx).text).toBe("순손실 회사라 '이익이 현금으로 뒷받침되는지'로 읽지 않습니다. 영업현금흐름(−0.61억 달러)도 마이너스이며, 순손실(−2.39억 달러)보다 작을 뿐입니다.");
    expect(metricRow(b6, ctx).score).toBe(98);
    expect(lossAccrualText("−113억 달러", "149억 달러", false, false)).toBe("순손실 회사라 '이익이 현금으로 뒷받침되는지'로 읽지 않습니다. 순손실(−113억 달러)이지만 영업현금흐름은 149억 달러로 플러스입니다.");
    // 한 줄 머리(두 쪽 끔): 순손실 회사의 현금 뒷받침(98) 대신 다른 지표
    const f = fam("quality", [b6, ms("B1", 3), ms("B4", 6)], 36);
    expect(familyRow(f, { ...ctx, text: { ...VALUE_TEXT_ON, familyTwoSided: false } }).text).toBe("ROE (자기자본이익률) — 자본으로 이익을 내는 효율이 낮은 편입니다.");
    expect(familyRow(f, { path: "general", annualEnd: null }).text).toBe("이익의 현금 뒷받침 — 이익이 현금으로 잘 뒷받침되는 편입니다."); // 끄면 예전
    // 두 쪽 문장에서는 '(순손실 회사)'를 붙인다
    expect(familyRow(f, ctx).text).toBe("막대를 길게 만든 지표: 이익의 현금 뒷받침 98(순손실 회사)\n막대를 짧게 만든 지표: ROE 3 · 영업이익률 6");
    expect([moneyEok(-0.61e8, "USD"), moneyEok(-2.39e8, "USD"), moneyEok(-1.13e10, "USD"), moneyEok(1234e8, "KRW")]).toEqual(["−0.61억 달러", "−2.39억 달러", "−113억 달러", "1,234억원"]);
  });

  it("초기 단계 표시 → 몇 년 연속 영업손실인지 코드가 센다 (자료가 있는 해 모두면 그렇게), 끄면 예전 글", () => {
    const y = (end: string, op: number | null) => ({ end, op });
    expect(lossStreak([y("2021-12-31", -1), y("2022-12-31", -1), y("2023-12-31", -1), y("2024-12-31", -1), y("2025-12-31", -1)])).toEqual({ from: "2021", to: "2025", n: 5, all: true });
    expect(lossStreak([y("2023-12-27", 5), y("2024-12-28", -1), y("2025-12-27", -2)])).toEqual({ from: "2024", to: "2025", n: 2, all: false });
    expect(lossStreak([y("2024-12-31", -1), y("2025-12-31", 3)])).toBeNull();
    expect(lossYearsText("2021", "2025", 5, true)).toBe("2021~2025년, 자료가 있는 5년 모두 영업손실입니다. 영업손실인 회사는 이 점수 방식으로는 낮게 나오는 것이 보통입니다.");
    expect(lossYearsText("2024", "2025", 2, false)).toBe("2024~2025년 2년 연속 영업손실입니다. 영업손실인 회사는 이 점수 방식으로는 낮게 나오는 것이 보통입니다.");
    const o = { oneOffPct: null, lossYears: { from: "2024", to: "2025", n: 2, all: false }, fallbackText: "", carried: null };
    expect(flagRows(["earlyStage"], { ...VALUE_TEXT_OFF, wordingFacts: true }, o)).toEqual([{ key: "earlyStage", text: lossYearsText("2024", "2025", 2, false) }]);
    expect(flagRows(["earlyStage"], VALUE_TEXT_OFF, o)).toEqual([{ key: "earlyStage", text: VALUE_FLAG_TEXT.earlyStage }]);
    expect(thinEquityText(5496.47)).toBe("자본(순자산)이 총자산에 비해 아주 작아(부채비율 5,496%), 순자산으로 나누는 PBR·ROE 는 작은 변화에도 크게 바뀝니다.");
  });
});

// ── 급한 버그: KO 배당 ───────────────────────────────────────

describe("급한 버그: 52/53주 회계연도 배당 창 (KO 배당수익률 2.9% ↔ 남 2.36~2.41%)", () => {
  const ko = () => new FactBook(compactCompanyFacts(secExtra("KO"), "2018-01-01"));
  it("SEC 원본: 연간 87.79억 + 올해 1분기 22.81억 − 작년 1분기 0.89억 = 109.71억 (371일 창 — 4월 1일 배당 두 번) → 주당배당 2.06달러 × 주식 수 로 바꿈", () => {
    const b = ko();
    const E = "2026-04-03";
    expect(b.flowTTM("dividends", "2026-09-25", E)).toBe(8_779_000_000 + 2_281_000_000 - 89_000_000);
    expect(b.flowWindow("dividends", "2026-09-25", E)).toBe(371);
    expect(b.flowTTM("dps", "2026-09-25", E)).toBeCloseTo(2.04 + 0.53 - 0.51, 10);
    const inp = b.inputs("2026-09-25")!;
    expect(inp.period?.end).toBe(E);
    expect(inp.flow.dividends).toBeCloseTo(2.06 * inp.shares!, 0);
    expect(inp.flow.dividends! / 1e8).toBeCloseTo(88.87, 1);
    // 현금 배당(109.7억)과 주당배당 × 주식 수(88.9억)의 차이가 15% 넘어서 바꾼 것 (23%)
    expect(10_971_000_000 / inp.flow.dividends! - 1).toBeGreaterThan(DIV_WINDOW_MISMATCH);
  });
  it("창이 365일 안팎(52주 364 · 윤년 366)인 회사는 그대로 — AT&T(365일, 현금 배당이 주당배당 × 주식 수보다 4% 많아도 그대로)", () => {
    const b = new FactBook(compactCompanyFacts(secExtra("T"), "2018-01-01"));
    const p = b.latest("2026-09-25")!;
    expect(b.flowWindow("dividends", "2026-09-25", p.end)).toBe(365);
    expect(b.inputs("2026-09-25")!.flow.dividends).toBe(b.flowTTM("dividends", "2026-09-25", p.end));
  });
});

// ── [8] AI 가치분석 글 ────────────────────────────────────

class ValueGen implements TextGenerator {
  readonly model = "fake-model";
  requests: GenerateRequest[] = [];
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    const text = "## 주가와 재무 숫자\n| PER | 10.0배 |\n\n## 숫자로 본 변화\n1. 매출은 3년 연속 늘었습니다.\n2. 경기 둔화 우려가 있습니다.\n3. 지금이 매수 기회로 보입니다.";
    return { text, model: this.model, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "end_turn" };
  }
}

describe("[8] AI 가치분석 글 금지어 검사 (valueAiSafeWording, 서버만)", () => {
  async function analysis(on: boolean) {
    db = await createMigratedDb(":memory:");
    const gen = new ValueGen();
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: gen }), logger: false, enableScheduler: false, now: () => kst("2026-09-28T10:00:00") });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { valueAiSafeWording: on } });
    const res = await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/value" });
    return { res: res.json() as { content: string }, gen };
  }
  it("켜면 새 프롬프트('평가하는 애널리스트' 없음)로 만들고 걸린 줄을 뺀다 · 끄면 예전 프롬프트·글 그대로", async () => {
    const on = await analysis(true);
    expect(on.gen.requests[0]!.system).not.toContain("평가하는 애널리스트");
    expect(on.gen.requests[0]!.system).toContain("편집자");
    expect(on.res.content).toContain("매출은 3년 연속 늘었습니다.");
    expect(on.res.content).not.toContain("우려");
    expect(on.res.content).not.toContain("매수");
    expect(on.res.content).toMatch(/\(문장 검사에서 2줄을 뺐습니다\)$/);
    await app!.close();
    app = null;
    const off = await analysis(false);
    expect(off.gen.requests[0]!.system).toContain("평가하는 애널리스트");
    expect(off.res.content).toContain("경기 둔화 우려가 있습니다.");
  });
  it("전에 만든 글(캐시)도 보일 때 같은 검사 · 걸린 것이 없으면 한 글자도 바꾸지 않음 · 새 프롬프트 파일", async () => {
    expect(safeValueText("## 매출\n매출은 늘었습니다.")).toBe("## 매출\n매출은 늘었습니다.");
    expect(safeValueText("## 강점\n1. 저평가 매력\n## 매출\n늘었습니다.")).toBe("## 매출\n늘었습니다.\n\n(문장 검사에서 1줄을 뺐습니다)");
    const p = await new PromptStore().load("value_analysis_safe");
    expect(p.system).not.toContain("평가하는 애널리스트");
    expect(p.system).not.toMatch(/^## (강점|리스크|가치투자 관점 요약)/m);
    expect(p.userTemplate).toContain("{{data_json}}");
    expect(parsePromptFile("value_analysis_safe", "a\n=== USER ===\nb").userTemplate).toBe("b");
  });
});

// ── 새 글 전부 금지어 검사 ───────────────────────────────────

describe("새 글 틀 전부 금지어·미래형 검사", () => {
  it("걸리는 낱말이 없다", () => {
    const all: string[] = [
      ...Object.values(DIRECTION_ABOUT),
      familyAboutOf("price", { direction: true, path: "financial" }),
      familyAboutOf("growth", { direction: true, grade: "lite" }),
      familyAboutOf("payout", { direction: true, grade: "lite" }),
      FIN_HEALTH_ABOUT,
      PEER_TIMING_NOTE_V2,
      VALUE_TRAP_V2,
      twoSidedLine(true, [["PER", 71]]),
      twoSidedLine(false, [["PBR", "0(적자)"]]),
      twoSidedMidLine([["ROE", 50]]),
      blendRankNote("44.8배", cyclicalWhy({ byIndustry: true, lo: null, hi: null })),
      blendRankZeroNote(cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6 }), false),
      ...["A1", "A2"].flatMap((k) => [profitMedianText(k as "A1", "58.6배", "업종", 68, 43), lossClumpSentence(k as "A1", 43, 50), lossClumpSentence(k as "A1", 43, 80), lossClumpSentence(k as "A1", 43, 10)]),
      PRICE_NOTE_BASE,
      PRICE_NOTE_BLEND,
      PRICE_NOTE_SMALL,
      closeGapText("2026-09-25", -7.3, "22.2배", "10.1배")!,
      oneOffAbsText(51),
      opPerNote(18, "35.0배"),
      finPeerFirst("은행", 228, 186),
      BANK_HEALTH_NOTE,
      INSURER_HEALTH_NOTE,
      KR_FIN_MIX_NOTE,
      SHARES_MISSING_TEXT,
      krFewQuartersText(3),
      KR_QUARTER_GAP_TEXT,
      preferredText("삼성전자"),
      preferredText(null),
      lossAccrualText("−2.39억 달러", "−0.61억 달러", true, true),
      lossAccrualText("−2.39억 달러", "−3.00억 달러", true, false),
      lossAccrualText("−113억 달러", "149억 달러", false, false),
      lossYearsText("2021", "2025", 5, true),
      lossYearsText("2024", "2025", 2, false),
      thinEquityText(5496),
      gapTextV2(29),
      gapHideText(41),
      compositeFormulaText(51, 80),
      ...howLinesV2(true, { gapHide: true }),
    ];
    expect(all.length).toBeGreaterThan(45);
    const bad = all.map((s) => [s, scoreWordingProblems(s)] as const).filter(([, p]) => p.length);
    expect(bad).toEqual([]);
    // '~하세요' 명령형도 없음 (규정 검토 C-11)
    expect(all.filter((s) => /세요|십시오/.test(s))).toEqual([]);
  });
});
