import { readFileSync } from "node:fs";
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
import { isOldValueText, safeValueCheck, safeValueText, VALUE_AI_ALLOW, VALUE_AI_BANNED } from "../src/services/analysisService.js";
import { cleanDetail } from "../src/services/briefingWording.js";
import { FEATURES } from "../src/services/featureService.js";
import { compositeOf, type ScoreSources, type ScoresResponse, type ScoreStock } from "../src/services/indicatorScoreService.js";
import { krReasonOf } from "../src/services/krValueService.js";
import { bigPeersOf, closeGap, familyRow, flagRows, lossStreak, marginTrend, metricRow, oneOffOf, priceNoteOf, reasonOf, type Core, type RowCtx } from "../src/services/valueScoreService.js";
import {
  BANK_HEALTH_NOTE,
  blendPosPrefix,
  blendRankNote,
  blendRankZeroNote,
  closeGapText,
  compositeFormulaText,
  CYCLICAL_PEAK_MARGIN,
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
  keepWords,
  KR_FIN_MIX_NOTE,
  KR_QUARTER_GAP_TEXT,
  krFewQuartersText,
  LOSS_ACCRUAL_MEANING,
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
  PRICE_NOTE_BLEND_PLAIN,
  PRICE_NOTE_SMALL,
  profitMedianText,
  SHARES_MISSING_TEXT,
  thinEquityText,
  twoSidedItem,
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
/** 두 쪽 문장의 이름·점수 사이 줄바꿈 없는 빈칸 · 숫자와 '점' 사이 보이지 않는 줄 묶음 글자 */
const NB = "\u00a0";
const WJ = "\u2060";
/** 두 쪽 문장 지표 이름 안쪽 묶음 (1단계 검토 3차): 한글 글자 사이 U+2060, ' ÷' 앞은 U+00A0 — 시험용으로 따로 적은 같은 규칙 */
const kw = (name: string) => name.replace(/ ÷/g, `${NB}÷`).replace(/(?<=[가-힣])(?=[가-힣])/g, WJ);
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
    // '주가가 실제보다 낮은 쪽'은 '실제 가치보다 낮다(저평가)'로 읽힐 수 있어 '낮아 보이는 쪽'으로 (검토 지적)
    expect(PEER_TIMING_NOTE_V2).toContain("주가 수준 막대가 조금 길게(이익에 비해 주가가 실제보다 낮아 보이는 쪽으로)");
    expect(PEER_TIMING_NOTE_V2).not.toContain("주가가 실제보다 낮은 쪽");
    expect(PEER_TIMING_NOTE_V2).not.toContain("SEC 공통 자료");
  });

  it("엔비디아 주가 수준 49: 길게 만든 지표 80·71 / 짧게 만든 지표 5·25 (보고서 그림 2), 가운데쯤 64 는 빼고, 가장 튀는 순", () => {
    const f = fam("price", [ms("A1", 71), ms("A2", 80), ms("A3", 5), ms("A4", 25), ms("A5", 64)], 49);
    expect(familyRow(f, ON).text).toBe(`막대를 길게 만든 지표: ${kw("기업가치 ÷ 영업이익")}${NB}80${WJ}점 · PER${NB}71${WJ}점\n막대를 짧게 만든 지표: PBR${NB}5${WJ}점 · PSR${NB}25${WJ}점`);
    // 띠가 높은 편인 묶음은 긴 쪽만, 낮은 편은 짧은 쪽만 (소수 쪽 지표를 대표로 말하지 않게)
    expect(familyRow(fam("quality", [ms("B1", 100), ms("B6", 1)], 70), ON).text).toBe(`막대를 길게 만든 지표: ROE${NB}100${WJ}점`);
    expect(familyRow(fam("quality", [ms("B1", 90), ms("B4", 10), ms("B2", 5)], 30), ON).text).toBe(`막대를 짧게 만든 지표: ROIC${NB}5${WJ}점 · ${kw("영업이익률")}${NB}10${WJ}점`);
    // 67 이상·33 이하가 없으면 가운데쯤 지표를 그대로
    expect(familyRow(fam("payout", [ms("E1", 65)], 65), ON).text).toBe(`가운데쯤(34~66)인 지표: ${kw("배당수익률")}${NB}65${WJ}점`);
    // 끄면 예전 한 줄 (가장 튀는 지표 하나)
    expect(familyRow(f).text).toBe("PBR (순자산 대비 주가) — 순자산에 비해 주가 수준이 높은 편입니다.");
  });

  it("0점 규칙 지표는 '(적자)'처럼 사실을 붙이고, 같은 값 덩어리 지표는 '(비교 회사 77%가 0.0%)'를 붙인다", () => {
    const z = ms("A1", 0, { x: -Infinity, rule: "zeroLoss", why: "lossNi", show: null, pos: { industry: 0, market: 0 } });
    const fcf = ms("A5", 0, { x: -Infinity, rule: "zeroLoss", why: "lossFcf", show: -1.7, pos: { industry: 0, market: 0 } });
    expect(familyRow(fam("price", [z, ms("A3", 9), fcf], 3), ON).text).toBe(`막대를 짧게 만든 지표: PER${NB}0${WJ}점${kw("(적자)")} · ${kw("잉여현금흐름 수익률")}${NB}0${WJ}점${kw("(마이너스)")} · PBR${NB}9${WJ}점`);
    const e1 = ms("E1", 82, { x: 0.001, show: 0.1, peer: peer({ tie: 0.77, tieX: 0 }) });
    expect(familyRow(fam("payout", [e1, ms("E2", 72)], 77), ON).text).toBe(`막대를 길게 만든 지표: ${kw("배당수익률")}${NB}82${WJ}점${kw("(비교 회사 77%가 0.0%)")} · ${kw("주식 수 변화")}${NB}72${WJ}점`);
    expect(twoSidedMidLine([["ROE", 49], ["ROA", 55]])).toBe(`가운데쯤(34~66)인 지표: ROE${NB}49${WJ}점 · ROA${NB}55${WJ}점`);
    // 숫자는 위치 점수라 '점'을 붙인다 (엔비디아 'PER 71'이 'PER 71배'로 읽히던 것 — 바로 아래 PER 줄은 27.9배). 이름과 숫자는 줄바꿈 없는 빈칸으로 묶는다
    // (360 화면에서 'PER' / '70'으로 갈리던 것)
    expect(twoSidedLine(true, [["PER", 71]])).toBe("막대를 길게 만든 지표: PER\u00a071\u2060점");
    expect(twoSidedItem("PER", 0, "(적자)")).toBe("PER\u00a00\u2060점(적\u2060자)");
    // 붙이는 사실 글 안 낱말도 묶는다 (인텔 360 글자 200% '0점(영업적 / 자)'가 갈리던 것)
    expect(twoSidedItem("기업가치 ÷ 영업이익", 0, "(영업적자)")).toBe("기\u2060업\u2060가\u2060치\u00a0÷ 영\u2060업\u2060이\u2060익\u00a00\u2060점(영\u2060업\u2060적\u2060자)");
    expect(twoSidedLine(false, [["PBR", 5]])).not.toMatch(/PBR 5(?!\u2060점)/);
  });

  it("지표 이름 안쪽도 묶는다: 한글 글자 사이 U+2060 · ' ÷' 앞 U+00A0 — '영업이익 / 률 100점'·'기업가치 ÷ 영업이 / 익 78점'처럼 낱말 가운데서 줄이 바뀌지 않게 (1단계 검토 3차)", () => {
    expect(keepWords("영업이익률")).toBe("영\u2060업\u2060이\u2060익\u2060률");
    expect(keepWords("기업가치 ÷ 영업이익")).toBe("기\u2060업\u2060가\u2060치\u00a0÷ 영\u2060업\u2060이\u2060익");
    // 낱말 사이 빈칸은 그대로 (줄은 여기서만 바뀐다) · 영문 이름은 그대로
    expect(keepWords("주당이익 증가폭")).toBe("주\u2060당\u2060이\u2060익 증\u2060가\u2060폭");
    expect(keepWords("PER")).toBe("PER");
    expect(twoSidedItem("영업이익률", 100)).toBe("영\u2060업\u2060이\u2060익\u2060률\u00a0100\u2060점");
    // 보이지 않는 글자를 빼면 예전 글과 한 글자도 같다 (화면 읽기·검색은 같은 글)
    const plain = (s: string) => s.replace(/\u2060/g, "");
    expect(plain(twoSidedLine(true, [["기업가치 ÷ 영업이익", 78], ["PER", 70]])).replace(/\u00a0/g, " ")).toBe("막대를 길게 만든 지표: 기업가치 ÷ 영업이익 78점 · PER 70점");
    // 줄이 바뀔 수 있는 곳: 보통 빈칸만 (이름 속 낱말 사이 · 지표 사이 ' · ' 앞뒤)
    const line = twoSidedLine(true, [["기업가치 ÷ 영업이익", 78], ["주당이익 증가폭", 100], ["이익의 현금 뒷받침", 1]]);
    const breaks = [...line.slice(line.indexOf(": ") + 2)].filter((c) => c === " ").length;
    expect(breaks).toBe(2 * 2 + 1 + 1 + 2); // ' · ' 두 번(빈칸 넷) + '÷' 뒤 하나 + '주당이익 증가폭' 하나 + '이익의 현금 뒷받침' 둘
  });

  it("검사: 공용 픽스처 모든 묶음에서 대표 문장이 묶음 띠와 같은 쪽 (높은 편에 '짧게' 없음 · 낮은 편에 '길게' 없음 — 소수 쪽 문장 0건)", () => {
    const fx = JSON.parse(readFileSync(new URL("../../shared/fixtures/indicatorScores.json", import.meta.url), "utf8")) as { cases: Record<string, ScoresResponse> };
    let checked = 0;
    let pairs = 0;
    for (const [k, c] of Object.entries(fx.cases)) {
      if (k.endsWith("_stage1Off")) continue;
      for (const f of c.value.families ?? []) {
        if (f.score === null || !/막대를|가운데쯤\(34~66\)/.test(f.text)) continue;
        checked++;
        if (f.score >= 67) expect(f.text, `${k} ${f.key}`).not.toContain("막대를 짧게");
        if (f.score <= 33) expect(f.text, `${k} ${f.key}`).not.toContain("막대를 길게");
        // 적힌 위치 점수는 그 묶음 지표의 점수와 같다
        for (const m of f.text.matchAll(/([^:·\n]+?)\u00a0(\d+)\u2060점(?:\([^)]*\))?(?= ·|\n|$)/g)) {
          const name = m[1]!.replace(/\u2060/g, "").replace(/\u00a0/g, " ").trim();
          const row = f.metrics.find((x) => x.name.replace(/ \([^)]*\)$/, "") === name);
          if (row) {
            expect(row.score, `${k} ${name}`).toBe(Number(m[2]));
            pairs++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(pairs).toBeGreaterThan(100);
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
    // 위치·문장은 첫 숫자(28.3배)가 아니라 섞은 값(44.8배)으로 매긴 것 — 위치 줄 앞에 밝힌다 (1단계 검토 3차: 27.9배와 가운데값 58.6배를 견주어 '가운데쯤'을 모순으로 읽던 것)
    expect(row.positions).toBe("순위용 44.8배 기준: 업종 안 위치 76/100 (흑자 회사끼리 59) · 시장 안 57/100 (흑자 회사끼리 24)");
    expect(row.positions).toBe(blendPosPrefix("44.8배", "업종 안 위치 76/100 (흑자 회사끼리 59) · 시장 안 57/100 (흑자 회사끼리 24)"));
    // '크게 나왔습니다'(점수가 높다로 읽힘) 대신 무엇보다 높은지 (1단계 검토 3차)
    expect(row.text).toBe("비교한 회사의 43%가 적자라 흑자 회사끼리만 볼 때보다 위치 점수가 높게 나왔습니다. 흑자 회사끼리 보면 가운데쯤입니다.");
    // 섞지 않는 회사(경기 민감 아님)는 앞머리 없음 · PER 줄 두 값을 끄면 앞머리 없음
    expect(metricRow({ ...a1, blend: false }, ctx).positions).toBe("업종 안 위치 76/100 (흑자 회사끼리 59) · 시장 안 57/100 (흑자 회사끼리 24)");
    expect(metricRow(a1, { ...ctx, text: { ...VALUE_TEXT_ON, perPlain: false } }).positions).toBe("업종 안 위치 76/100 (흑자 회사끼리 59) · 시장 안 57/100 (흑자 회사끼리 24)");
    expect(row.note).toBe("순위에는 최근 4분기 이익과 5년 평균 이익을 반씩 섞은 44.8배를 썼습니다(업황에 따라 이익이 크게 오르내리는 업종이라).");
    expect(row.score).toBe(71); // 점수는 그대로
    // 끄면 예전 줄 ('100배 넘음'·섞은 값·예전 섞기 안내)
    const old = metricRow({ ...a1, peer: peer({ median: 1 / 150 }) });
    expect(old).toMatchObject({ value: "44.8배", peerMedian: "업종 가운데값 100배 넘음", positions: "업종 안 위치 76/100 · 시장 안 57/100", text: "이익에 비해 주가 수준이 낮은 편입니다." });
    expect(old.note).toBe("업황에 따라 이익이 크게 오르내리는 회사라, 최근 4분기 이익과 5년 평균 이익을 반씩 섞어 계산했습니다.");
  });

  it("팔란티어 식: 경기 민감 까닭이 이익률이면 실제 숫자, 흑자끼리 띠가 낮으면 그 문장 · 인텔 식: 섞은 이익도 0 이하", () => {
    expect(cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6 })).toBe("최근 5년 영업이익률이 가장 낮은 해 −26.7%, 가장 높은 해 31.6%로 오르내림이 커서");
    expect(lossClumpSentence("A1", 58, 3)).toBe("비교한 회사의 58%가 적자라 흑자 회사끼리만 볼 때보다 위치 점수가 높게 나왔습니다. 흑자 회사끼리 보면 이익에 비해 주가 수준이 높은 편입니다.");
    expect(lossClumpSentence("A2", 47, 50)).toBe("비교한 회사의 47%가 영업적자라 흑자 회사끼리만 볼 때보다 위치 점수가 높게 나왔습니다. 흑자 회사끼리 보면 가운데쯤입니다.");
    // 보이는 점수가 가운데쯤(36~54)이어도 '크게 나왔습니다'가 붙어 '점수가 높다'로 읽히던 것 (COST PER 49점 · 377300 PER 36점 — 1단계 검토 3차)
    expect(lossClumpSentence("A1", 30, 20)).not.toContain("크게");
    expect(profitMedianText("A2", "73.4배", "업종", 64, 47)).toBe("영업이익 흑자 회사 가운데값 73.4배 · 비교한 업종 64곳 중 47%는 영업적자");
    expect(blendRankNote("278.0배", cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6 }))).toContain("섞은 278.0배를 썼습니다(최근 5년 영업이익률이 가장 낮은 해");
    expect(blendRankZeroNote("업황에 따라 이익이 크게 오르내리는 업종이라", true)).toBe("순위에는 최근 4분기 이익과 5년 평균 이익을 반씩 섞은 값을 썼습니다(업황에 따라 이익이 크게 오르내리는 업종이라). 섞은 이익도 0 이하라 0점입니다.");
    const z = ms("A1", 0, { x: -Infinity, rule: "zeroLoss", why: "lossNi", show: null, blend: true, pos: {} });
    expect(metricRow(z, { ...ON, extra: { plainPer: "loss" } }).value).toBe("적자 (최근 4분기 · 흔히 쓰는 계산)");
  });

  it("1단계 검토 4차 팔란티어: 영업이익률이 해마다 오르기만 했으면 '오르내림' 대신 '해마다 올라 변동 폭이 커서' · 경기 정점 표시도 '변동 폭이 큰'", () => {
    // 팔란티어 2021~2025 영업이익률 −26.7% · −8.5% · 5.4% · 10.8% · 31.6% (해마다 오름)
    expect(marginTrend([-0.267, -0.085, 0.054, 0.108, 0.316])).toBe("up");
    expect(marginTrend([0.3, 0.2, 0.1])).toBe("down");
    expect(marginTrend([0.1, 0.3, 0.2, 0.4])).toBeNull(); // 오르내림
    expect(marginTrend([0.1, null, 0.3])).toBeNull(); // 빈 해가 있으면 '해마다'라고 하지 않는다
    expect(marginTrend([0.1, 0.2])).toBeNull(); // 2년은 '해마다'가 아니다
    expect(marginTrend([0.1, 0.1, 0.2])).toBeNull(); // 같은 해는 오른 것이 아니다
    expect(cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6, steady: "up" })).toBe("최근 5년 영업이익률이 −26.7%에서 31.6%로 해마다 올라 변동 폭이 커서");
    expect(cyclicalWhy({ byIndustry: false, lo: 5.2, hi: 30.4, steady: "down" })).toBe("최근 5년 영업이익률이 30.4%에서 5.2%로 해마다 내려 변동 폭이 커서");
    expect(cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6, steady: null })).toContain("오르내림이 커서");
    // 업종 목록이면 해마다 올랐어도 업종 글 그대로
    expect(cyclicalWhy({ byIndustry: true, lo: -26.7, hi: 31.6, steady: "up" })).toBe("업황에 따라 이익이 크게 오르내리는 업종이라");
    expect(blendRankNote("278.0배", cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6, steady: "up" }))).toBe(
      "순위에는 최근 4분기 이익과 5년 평균 이익을 반씩 섞은 278.0배를 썼습니다(최근 5년 영업이익률이 −26.7%에서 31.6%로 해마다 올라 변동 폭이 커서).",
    );
    expect(CYCLICAL_PEAK_MARGIN).toBe("이익이 최근 몇 년 중 가장 높은 수준입니다. 이익률 변동 폭이 큰 회사는 이익이 많을 때 PER이 낮게 보이는 경향이 있습니다.");
    expect(CYCLICAL_PEAK_MARGIN).not.toContain("오르내");
    // PER 줄 섞기 안내에 그대로 쓰인다 (valueWordingFacts)
    const a1 = ms("A1", 59, { x: 1 / 278, show: 278, blend: true });
    expect(metricRow(a1, { ...ON, extra: { plainPer: 400, cyclical: { byIndustry: false, lo: -26.7, hi: 31.6, steady: "up" } } }).note).toContain("해마다 올라 변동 폭이 커서");
  });

  it("1단계 검토 4차·5차: 머리 문장 회사 수(153개 회사)와 지표 값이 있는 회사 수(152)가 다르면 '이익 자료가 있는 152곳 중'('PER 값이 있는'은 적자 회사에 PER 이 없다고 아는 사람에게 앞뒤가 맞지 않았다) · 같으면 '비교한 업종 N곳 중' · 무리 단계가 다르면 그대로", () => {
    expect(profitMedianText("A1", "20.2배", "업종", 152, 27, true)).toBe("흑자 회사 가운데값 20.2배 · 이익 자료가 있는 152곳 중 27%는 적자");
    expect(profitMedianText("A2", "73.4배", "업종", 64, 47, true)).toBe("영업이익 흑자 회사 가운데값 73.4배 · 영업이익 자료가 있는 64곳 중 47%는 영업적자");
    expect(profitMedianText("A1", "20.2배", "업종", 152, 27, false)).toBe("흑자 회사 가운데값 20.2배 · 비교한 업종 152곳 중 27%는 적자");
    // 'PER 값이 있는'·'값이 있는' 말은 더 쓰지 않는다
    expect(profitMedianText("A1", "20.2배", "업종", 152, 27, true)).not.toMatch(/PER 값이 있는|값이 있는/);
    const a1 = ms("A1", 71, { x: 1 / 44.8, show: 44.8, peer: peer({ n: 152 }), loss: { share: 0.27, median: 1 / 20.2, pos: { industry: 59, market: 24 }, score: 50 } });
    const row = (groupN: NonNullable<RowCtx["extra"]>["groupN"]) => metricRow(a1, { ...ON, extra: { groupN } }).peerMedian;
    expect(row({ level: "industry", n: 153 })).toBe("흑자 회사 가운데값 20.2배 · 이익 자료가 있는 152곳 중 27%는 적자");
    expect(row({ level: "industry", n: 152 })).toBe("흑자 회사 가운데값 20.2배 · 비교한 업종 152곳 중 27%는 적자");
    expect(row({ level: "sector", n: 400 })).toBe("흑자 회사 가운데값 20.2배 · 비교한 업종 152곳 중 27%는 적자");
    expect(row(null)).toBe("흑자 회사 가운데값 20.2배 · 비교한 업종 152곳 중 27%는 적자");
    // 끄면 (valueMedianText) 예전 가운데값 그대로
    expect(metricRow(a1, { ...ON, text: { ...VALUE_TEXT_ON, medianText: false }, extra: { groupN: { level: "industry", n: 153 } } }).peerMedian).not.toContain("자료가 있는");
  });

  it("가격 안내: 기본 · 경기 민감(섞기로 크게 다름) · 마지막 종가가 20일 평균과 5% 넘게 다르면 그 가격의 PER·PBR, 끄면 예전 한 줄", () => {
    const t = { ...VALUE_TEXT_ON };
    expect(priceNoteOf(t, { blend: false, close: null })).toBe(`${PRICE_NOTE_BASE} ${PRICE_NOTE_SMALL}`);
    // PER 줄 첫 숫자가 시세 표와 같은 최근 4분기 PER 이면 다른 것은 순위에 쓴 섞은 값뿐 (예전 'PER은 … 시세 표와 크게 다릅니다'가 보이는 27.9배와 맞지 않던 것 — 1단계 검토 3차)
    expect(priceNoteOf(t, { blend: true, close: null })).toBe(`${PRICE_NOTE_BASE} ${PRICE_NOTE_BLEND_PLAIN}`);
    expect(PRICE_NOTE_BLEND_PLAIN).toBe("이 종목은 순위에 쓴 PER(섞은 값)이 시세 표의 PER과 크게 다릅니다(아래 PER 줄에 두 값을 함께 적었습니다).");
    // PER 줄 두 값(valuePerPlain)을 끄면 PER 줄이 섞은 값이라 예전 문장에서 괄호만 뺀다
    expect(priceNoteOf({ ...t, perPlain: false }, { blend: true, close: null })).toBe(`${PRICE_NOTE_BASE} 이 종목의 PER은 순위용 계산이 달라 시세 표와 크게 다릅니다.`);
    expect(PRICE_NOTE_BLEND).toContain("이 종목의 PER은 순위용 계산이 달라");
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
    // 영업 외 손실 쪽(이자 비용이 큰 버라이즌)은 새 표시를 붙이지 않고 예전 규칙 그대로 (예전 표시가 있으면 그대로, 없으면 없음)
    expect(flagRows([], { ...VALUE_TEXT_OFF, oneOffAbs: true }, { ...base, oneOffPct: null, oneOffLoss: true })).toEqual([]);
    expect(flagRows(["oneOff"], { ...VALUE_TEXT_OFF, oneOffAbs: true }, { ...base, oneOffPct: null, oneOffLoss: true })).toEqual([{ key: "oneOff", text: VALUE_FLAG_TEXT.oneOff }]);
    const a1 = ms("A1", 81, { x: 1 / 17.2, show: 17.2 });
    expect(metricRow(a1, { ...ON, extra: { opPer: { taxPct: 18, per: 35 } } }).note).toBe(opPerNote(18, "35.0배"));
    expect(opPerNote(18, "35.0배")).toBe("영업이익으로 계산하면(세금 18% 가정) PER 약 35.0배입니다.");
  });

  it("영업 외 손익 방향: 영업 외 '이익'이 큰 회사(알파벳)만 표시·영업이익 기준 PER — 영업 외 '손실'(버라이즌 이자)은 없음 (빚 많은 회사가 싸 보이는 숫자를 만들지 않게)", () => {
    // 알파벳 식: 세전 160 · 영업 78 → 영업 외 이익 51%
    expect(oneOffOf(160e9, 78e9)).toEqual({ pct: 51, loss: false });
    // 버라이즌 식 (검토 표본): 세전이익이 영업이익보다 작음 (이자 비용) → 표시·영업이익 기준 PER 없음 (예전: '32%로 커서…' + 'PER 약 9.4배' ↔ 실제 12.7배)
    expect(oneOffOf(22.6e9, 29.8e9)).toEqual({ pct: null, loss: true });
    // 30% 안이면 없음, 값이 없거나 숫자가 아니면 없음
    expect(oneOffOf(100, 75)).toEqual({ pct: null, loss: false });
    expect(oneOffOf(100, 70)).toEqual({ pct: 30, loss: false });
    expect(oneOffOf(-9.9e9, -0.08e9)).toEqual({ pct: null, loss: true }); // 인텔
    expect(oneOffOf(undefined, 1e9)).toEqual({ pct: null, loss: false });
    expect(oneOffOf(Number.NaN, 1e9)).toEqual({ pct: null, loss: false });
    // 기록한 SEC 재무 (2026-09-25 기준): AT&T 세전 261.4억 ≥ 영업 256.0억(30% 안) · 3M 세전 39.0억 < 영업 46.2억(손실 쪽)
    const flow = (t: "T" | "MMM") => new FactBook(compactCompanyFacts(secExtra(t), "2018-01-01")).inputs("2026-09-25")!.flow;
    expect(oneOffOf(flow("T").pretax, flow("T").opIncome)).toEqual({ pct: null, loss: false });
    expect(oneOffOf(flow("MMM").pretax, flow("MMM").opIncome)).toEqual({ pct: null, loss: true });
  });

  it("영업손실 회사(영업이익 ≤ 0)는 새 기준을 쓰지 않고 예전 표시 그대로 — 영업 외 이익으로 세전이익이 흑자인 회사의 유일한 경고가 사라지던 것 (1단계 검토 3차 must)", () => {
    const base = { lossYears: null, fallbackText: "", carried: null };
    const on = { ...VALUE_TEXT_OFF, oneOffAbs: true };
    const rows = (keys: Array<"oneOff">, pretax: number, op: number, t = on) => {
      const o = oneOffOf(pretax, op);
      return flagRows(keys, t, { ...base, oneOffPct: o.pct, oneOffLoss: o.loss });
    };
    // 검토 재현: 세전이익 50억 · 영업이익 −10억 (순이익이 모두 영업 밖에서 — 예전 기준 |50 − (−10)| ÷ 10 = 6, 시장 상위 5%(2.47) 넘음)
    expect(oneOffOf(50e8, -10e8)).toEqual({ pct: null, loss: true });
    expect(rows(["oneOff"], 50e8, -10e8)).toEqual([{ key: "oneOff", text: VALUE_FLAG_TEXT.oneOff }]); // 고치기 전: []
    expect(rows(["oneOff"], 50e8, -10e8, VALUE_TEXT_OFF)).toEqual([{ key: "oneOff", text: VALUE_FLAG_TEXT.oneOff }]); // 끈 것과 같음
    // 영업 외 이익으로 손실이 줄어든 회사 · 영업이익 0 도 같은 쪽 (예전 기준에 안 걸렸으면 표시 없음 그대로)
    expect(oneOffOf(-5e8, -10e8)).toEqual({ pct: null, loss: true });
    expect(oneOffOf(3e8, 0)).toEqual({ pct: null, loss: true });
    expect(rows(["oneOff"], -5e8, -10e8)).toEqual([{ key: "oneOff", text: VALUE_FLAG_TEXT.oneOff }]);
    expect(rows([], 50e8, -10e8)).toEqual([]);
    // 영업이익 기준 PER 도 없음 (영업이익이 플러스이고 영업 외 이익일 때만)
    expect(oneOffOf(50e8, -10e8).pct).toBeNull();
    // 흑자 회사 쪽은 그대로: 30% 넘으면 새 표시, 안 넘으면 표시를 뺀다(예전 기준에 걸렸어도)
    expect(rows(["oneOff"], 100, 60)).toEqual([{ key: "oneOff", text: oneOffAbsText(40) }]);
    expect(rows(["oneOff"], 100, 80)).toEqual([]);
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
    // 하나도 없으면 '0개뿐' 대신 (1단계 검토 3차)
    expect(krFewQuartersText(0)).toBe("재무 요약에 분기 실적이 아직 없습니다(4개 필요 — 새로 상장했거나 분할로 새로 생긴 회사 등). 회사 재무에 문제가 있다는 뜻은 아닙니다.");
    expect(krReasonOf({ ...epis, detail: "fewQuarters:0" }, { ...VALUE_TEXT_ON })).toEqual({ code: "krFewQuarters", text: krFewQuartersText(0) });
    expect(krReasonOf({ ...epis, detail: "quarterGap" }, { ...VALUE_TEXT_ON })).toEqual({ code: "krQuarterGap", text: KR_QUARTER_GAP_TEXT });
    expect(krReasonOf(epis, VALUE_TEXT_OFF)).toEqual(epis.reason);
    expect(preferredText("삼성전자")).toBe("우선주는 따로 계산하지 않습니다. 같은 회사 보통주(삼성전자) 화면에 가치 지표 점수가 있습니다.");
    expect(preferredText(null)).toBe("우선주는 따로 계산하지 않습니다.");
    expect(VALUE_STATUS_TEXT.preferred).toContain("참고하세요"); // 끄면 예전 글
  });
});

describe("[9] 우선주 글 '같은 회사 보통주(○○) 화면에 가치 지표 점수가 있습니다'는 보통주 점수가 실제로 나올 때만", () => {
  async function pref(o: { reference?: boolean; commonCandles?: "ok" | "fail" | "old" } = {}) {
    db = await createMigratedDb(":memory:");
    const clock = kst("2026-09-28T10:00:00");
    const world = krWorld();
    const kr = fakeKrSources({ members: world.members });
    const stocks: Record<string, ScoreStock> = { "005930": { code: "005930", name: "삼성전자", market: "KOSPI" }, "005935": { code: "005935", name: "삼성전자우", market: "KOSPI" } };
    const cs = candlesOf("005930.KS");
    const src: ScoreSources = {
      ...sources(),
      stock: async (c) => stocks[c] ?? null,
      candles: async (c, n) => {
        if (c === "005930" && o.commonCandles === "fail") throw new Error("가짜 일봉 받기 실패");
        // 'old': 기준일보다 한참 전 일봉만 (보통주가 '점수 없음 — 가격 오래됨')
        const got = c === "005930" && o.commonCandles === "old" ? cs.slice(0, -40) : cs;
        return { code: c, period: "D", candles: got.slice(-n), source: "yahoo" };
      },
    };
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ scoreSources: src, valueSources: fakeValueSources().src, krValueSources: kr.src }), logger: false, enableScheduler: false, now: () => clock });
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: valueStage1(true) });
    if (o.reference !== false) await app.krValue.saveReference(buildKrReference(world.members, world.facts, "2026-09-27"));
    await app.krValue.refreshFacts("005930");
    const get = async (c: string) => (await app!.inject({ method: "GET", url: `/api/scores/${c}` })).json() as ScoresResponse;
    return { common: await get("005930"), preferred: await get("005935"), kr };
  }

  it("보통주(삼성전자)에 점수가 있으면 그 문장, 네이버 재무 요청은 하지 않는다", async () => {
    const { common, preferred, kr } = await pref();
    expect(["ok", "partial"]).toContain(common.value.status);
    expect(preferred.value).toMatchObject({ status: "excluded", label: "대상 아님", reason: { code: "preferred", text: preferredText("삼성전자") } });
    expect(kr.calls.finance).toEqual(["005930"]); // 보통주 재무를 미리 받은 한 번뿐 (우선주 화면은 저장한 값만)
  });

  it("보통주가 점수를 못 내면(비교 기준 없음 · 보통주 일봉 받기 실패 · 가격 오래됨) 문장을 붙이지 않는다 — 예전에는 재무 요약에 EPS·BPS 만 있으면 붙였다", async () => {
    for (const o of [{ reference: false }, { commonCandles: "fail" as const }, { commonCandles: "old" as const }]) {
      const { common, preferred } = await pref(o);
      expect(["ok", "partial"], JSON.stringify(o)).not.toContain(common.value.status);
      expect(preferred.value.reason, JSON.stringify(o)).toEqual({ code: "preferred", text: preferredText(null) });
      await app!.close();
      app = null;
    }
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

  it("운영 서버(토스 Open API 마스터 — 리츠 목록 없음, 리츠도 'ST'): 'ST'는 '리츠 아님'의 증거가 아니다 → 네이버 업종 280 안의 '리츠' 이름으로", () => {
    // 검토 재현: krIsReit('395400','SK리츠',{reitCodes:빈 집합, groupCode:'ST', upjongCode:'280'}) 가 false 였다 (리츠 23곳이 운영에서 점수를 받음)
    const toss = { reitCodes: new Set<string>(), groupCode: "ST" };
    expect(krIsReit("395400", "SK리츠", { ...toss, upjongCode: "280" })).toBe(true);
    expect(krIsReit("088260", "이리츠코크렙", { ...toss, upjongCode: "280" })).toBe(true);
    expect(krIsReit("293940", "신한알파리츠", { ...toss, upjongCode: "280" })).toBe(true);
    expect(krExclusion("395400", "SK리츠", { ...toss, upjongCode: "280" })).toBe("reit");
    expect(krExclusion("088260", "이리츠코크렙", { ...toss, upjongCode: "280" })).toBe("reit");
    // 같은 경로에서 리츠가 아닌 회사는 그대로 아님 (메리츠금융지주 321 · 같은 업종 부동산 회사 SK디앤디)
    expect(krIsReit("138040", "메리츠금융지주", { ...toss, upjongCode: "321" })).toBe(false);
    expect(krIsReit("210980", "SK디앤디", { ...toss, upjongCode: "280" })).toBe(false);
    // 업종을 아직 모르면(재무 요약 받기 전) 이름 끝 '리츠'
    expect(krIsReit("395400", "SK리츠", toss)).toBe(true);
    expect(krIsReit("138040", "메리츠금융지주", toss)).toBe(false);
    // 대상 종목(마스터 분류 'ST' 를 넘김)과 비교 회사(넘기지 않음)가 같은 답
    const member: KrMember = { code: "395400", name: "SK리츠", market: "KOSPI", endType: "stock", price: 5_000, marketCap: 1.6e12, upjong: "부동산", upjongCode: "280" };
    expect(krCommonStock(member, new Set())).toBe(false);
    expect(krExclusion("395400", "SK리츠", { ...toss, upjongCode: "280" })).toBe(krExclusion("395400", "SK리츠", { reitCodes: new Set(), upjongCode: "280" }));
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

  it("화면: 운영 서버처럼 마스터 분류 'ST'·리츠 목록 없음이어도 SK리츠·이리츠코크렙은 '대상 아님 · 리츠…' (네이버 업종 280)", async () => {
    db = await createMigratedDb(":memory:");
    const clock = kst("2026-09-28T10:00:00");
    const world = krWorld();
    const kr = fakeKrSources({ members: world.members, alias: { "395400": "105560", "088260": "105560" } });
    const stocks: Record<string, ScoreStock> = {
      "395400": { code: "395400", name: "SK리츠", market: "KOSPI", groupCode: "ST" },
      "088260": { code: "088260", name: "이리츠코크렙", market: "KOSPI", groupCode: "ST" },
    };
    const src: ScoreSources = { ...sources(), stock: async (c) => stocks[c] ?? null, candles: async (c, n) => ({ code: c, period: "D", candles: candlesOf("005930.KS").slice(-n), source: "yahoo" }) };
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ scoreSources: src, valueSources: fakeValueSources().src, krValueSources: kr.src }), logger: false, enableScheduler: false, now: () => clock });
    await app.krValue.saveReference(buildKrReference(world.members, world.facts, "2026-09-27"));
    expect(await app.krValue.reitCodes()).toEqual(new Set()); // 토스 마스터처럼 'RT' 가 한 줄도 없음
    for (const code of ["395400", "088260"]) {
      await app.krValue.refreshFacts(code);
      // 저장한 재무 요약의 네이버 업종 번호를 부동산(280)으로 (기록한 KB금융 재무를 빌렸으므로)
      const row = await db.selectFrom("value_fundamentals").select("data").where("code", "=", code).executeTakeFirstOrThrow();
      const data = JSON.parse(row.data) as { i: { industryCode: string | null } };
      data.i.industryCode = "280";
      await db.updateTable("value_fundamentals").set({ data: JSON.stringify(data), fetched_at: "2026-09-28T09:59:00+09:00" }).where("code", "=", code).execute();
      const r = (await app.inject({ method: "GET", url: `/api/scores/${code}` })).json() as ScoresResponse;
      expect(r.value, code).toMatchObject({ status: "excluded", label: "대상 아님", reason: { code: "reit", text: VALUE_STATUS_TEXT.reit } });
      expect(r.value.score, code).toBeNull();
      expect(r.composite.score, code).toBeNull();
    }
  });

  it("재무를 받기 전에도: 주간 구성 종목 목록의 업종 번호(280)로 이리츠코크렙(이름 끝이 '리츠' 아님)을 바로 '대상 아님' — '계산 준비 중'·네이버 요청 없음 (1단계 검토 3차)", async () => {
    db = await createMigratedDb(":memory:");
    const clock = kst("2026-09-28T10:00:00");
    const world = krWorld();
    const koreit: KrMember = { code: "088260", name: "이리츠코크렙", market: "KOSPI", endType: "stock", price: 5_000, marketCap: 4e11, upjong: "부동산", upjongCode: "280" };
    const meritz: KrMember = { code: "138040", name: "메리츠금융지주", market: "KOSPI", endType: "stock", price: 150_000, marketCap: 22e12, upjong: "증권", upjongCode: "321" };
    const kr = fakeKrSources({ members: [...world.members, koreit, meritz], alias: { "088260": "105560", "138040": "105560" } });
    const stocks: Record<string, ScoreStock> = {
      "088260": { code: "088260", name: "이리츠코크렙", market: "KOSPI", groupCode: "ST" },
      "138040": { code: "138040", name: "메리츠금융지주", market: "KOSPI", groupCode: "ST" },
    };
    const src: ScoreSources = { ...sources(), stock: async (c) => stocks[c] ?? null, candles: async (c, n) => ({ code: c, period: "D", candles: candlesOf("005930.KS").slice(-n), source: "yahoo" }) };
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ scoreSources: src, valueSources: fakeValueSources().src, krValueSources: kr.src }), logger: false, enableScheduler: false, now: () => clock });
    await app.krValue.saveReference(buildKrReference(world.members, world.facts, "2026-09-27"));
    // 주간 구성 종목 목록 저장 (가짜 목록은 작아 최소 개수를 낮춤)
    (app.krValue as unknown as { deps: { minMembers?: number } }).deps.minMembers = 1;
    await app.krValue.members();
    const before = kr.calls.finance.length;
    const r = (await app.inject({ method: "GET", url: "/api/scores/088260" })).json() as ScoresResponse;
    expect(r.value).toMatchObject({ status: "excluded", label: "대상 아님", reason: { code: "reit", text: VALUE_STATUS_TEXT.reit } });
    await new Promise((res) => setTimeout(res, 20));
    expect(kr.calls.finance.slice(before)).not.toContain("088260"); // 네이버 재무 요청 없음 (고치기 전: '계산 준비 중' + 요청 한 번)
    // 목록에서 리츠가 아닌 업종(321)이면 재무 요약 업종 번호가 280 이어도 그대로 계산 대상 (목록이 먼저)
    await app.krValue.refreshFacts("138040");
    const row = await db.selectFrom("value_fundamentals").select("data").where("code", "=", "138040").executeTakeFirstOrThrow();
    const data = JSON.parse(row.data) as { i: { industryCode: string | null } };
    data.i.industryCode = "280";
    await db.updateTable("value_fundamentals").set({ data: JSON.stringify(data), fetched_at: "2026-09-28T09:59:00+09:00" }).where("code", "=", "138040").execute();
    const m = (await app.inject({ method: "GET", url: "/api/scores/138040" })).json() as ScoresResponse;
    expect(m.value.reason?.code).not.toBe("reit");
  });
});

// ── [10] 사실과 다른 문장 ───────────────────────────────────

describe("[10] 사실과 다른 설명 문장 (valueWordingFacts)", () => {
  it("순손실 회사의 이익의 현금 뒷받침: 좋은 뜻의 문장 대신 숫자 사실, 묶음 머리 문장으로 고르지 않음 (점수 그대로)", () => {
    const b6 = ms("B6", 98, { x: 0.277, show: -27.7 });
    const ctx: RowCtx = { ...ON, extra: { ni: -2.39e8, ocf: -0.61e8, unit: "USD" } };
    // 리게티: 음수끼리 '작을 뿐'·'순손실(−2.39억)' 이중 부정 대신 크기로 (검토 지적)
    expect(metricRow(b6, ctx).text).toBe("순손실 회사라 '이익이 현금으로 뒷받침되는지'로 읽지 않습니다. 순손실은 2.39억 달러이고, 영업활동에서도 현금이 0.61억 달러 빠져나갔습니다(순손실보다 적은 금액).");
    expect(metricRow(b6, ctx).text).not.toMatch(/작을 뿐|순손실\(−/);
    // 뜻 줄도 '100에 가까울수록: 이익이 현금으로 잘 뒷받침되는 편'(좋은 뜻) 대신
    expect(metricRow(b6, ctx).meaning).toBe(LOSS_ACCRUAL_MEANING);
    expect(metricRow(b6, { ...ctx, extra: { ni: 2e8, ocf: 1e8, unit: "USD" } }).meaning).toBe("100에 가까울수록: 이익이 현금으로 잘 뒷받침되는 편");
    expect(metricRow(b6, { path: "general", annualEnd: null, extra: ctx.extra }).meaning).toBe("100에 가까울수록: 이익이 현금으로 잘 뒷받침되는 편"); // 끄면 예전
    expect(metricRow(b6, ctx).score).toBe(98);
    expect(metricRow(b6, { ...ctx, extra: { ni: -2.39e8, ocf: -3e8, unit: "USD" } }).text).toBe("순손실 회사라 '이익이 현금으로 뒷받침되는지'로 읽지 않습니다. 순손실은 2.39억 달러이고, 영업활동에서도 현금이 3.00억 달러 빠져나갔습니다(순손실보다 많은 금액).");
    expect(lossAccrualText("113억 달러", "149억 달러", false, false)).toBe("순손실 회사라 '이익이 현금으로 뒷받침되는지'로 읽지 않습니다. 순손실은 113억 달러이지만, 영업현금흐름은 플러스(149억 달러)입니다.");
    // 한 줄 머리(두 쪽 끔): 순손실 회사의 현금 뒷받침(98) 대신 다른 지표
    const f = fam("quality", [b6, ms("B1", 3), ms("B4", 6)], 36);
    expect(familyRow(f, { ...ctx, text: { ...VALUE_TEXT_ON, familyTwoSided: false } }).text).toBe("ROE (자기자본이익률) — 자본으로 이익을 내는 효율이 낮은 편입니다.");
    expect(familyRow(f, { path: "general", annualEnd: null }).text).toBe("이익의 현금 뒷받침 — 이익이 현금으로 잘 뒷받침되는 편입니다."); // 끄면 예전
    // 두 쪽 문장에서도 대표 지표로 고르지 않는다 (보고서 '묶음 머리 문장으로 뽑지 않음(인텔)' — 예전 '막대를 길게 만든 지표: 이익의 현금 뒷받침 98(순손실 회사)')
    expect(familyRow(f, ctx).text).toBe(`막대를 짧게 만든 지표: ROE${NB}3${WJ}점 · ${kw("영업이익률")}${NB}6${WJ}점`);
    expect(familyRow(fam("quality", [b6, ms("B1", 80)], 85), ctx).text).toBe(`막대를 길게 만든 지표: ROE${NB}80${WJ}점`);
    // 그 지표밖에 없으면 '(순손실 회사)'를 붙여 가운데 줄에
    expect(familyRow(fam("quality", [b6], 98), ctx).text).toBe(`가운데쯤(34~66)인 지표: ${kw("이익의 현금 뒷받침")}${NB}98${WJ}점${kw("(순손실 회사)")}`);
    expect([moneyEok(-0.61e8, "USD"), moneyEok(-2.39e8, "USD"), moneyEok(-1.13e10, "USD"), moneyEok(1234e8, "KRW")]).toEqual(["−0.61억 달러", "−2.39억 달러", "−113억 달러", "1,234억원"]);
  });

  it("경기 정점 표시: 이익률 오르내림으로 경기 민감이 된 회사(팔란티어)는 '업황에 따라'를 쓰지 않는다 · 업종 목록(반도체)은 예전 글 · 끄면 예전 글", () => {
    const base = { oneOffPct: null, lossYears: null, fallbackText: "", carried: null };
    expect(flagRows(["cyclicalPeak"], { ...VALUE_TEXT_ON }, { ...base, cyclicalByIndustry: false })).toEqual([{ key: "cyclicalPeak", text: CYCLICAL_PEAK_MARGIN }]);
    expect(CYCLICAL_PEAK_MARGIN).not.toContain("업황");
    expect(flagRows(["cyclicalPeak"], { ...VALUE_TEXT_ON }, { ...base, cyclicalByIndustry: true })).toEqual([{ key: "cyclicalPeak", text: VALUE_FLAG_TEXT.cyclicalPeak }]);
    expect(flagRows(["cyclicalPeak"], VALUE_TEXT_OFF, { ...base, cyclicalByIndustry: false })).toEqual([{ key: "cyclicalPeak", text: VALUE_FLAG_TEXT.cyclicalPeak }]);
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

  // 가치분석 글에 흔한 평가·권유·예측 문장 (검토: 브리핑 금지어만으로는 35개 중 29개가 지나갔다)
  const ATTACKS = [
    "적정 주가는 50,000원 수준입니다.",
    "배당이 꾸준해 장기 보유에 적합해 보입니다.",
    "현재 주가는 과소평가되어 있습니다.",
    "지금 가격이면 담아볼 만합니다.",
    "이제는 팔 때가 된 것 같습니다.",
    "향후 실적 전망이 밝습니다.",
    "내년 매출 증가가 예상되며, 이익도 늘 것입니다.",
    "업종 대비 PER이 낮아 싸다고 볼 수 있습니다.",
    "주가가 비싸 보입니다.",
    "가격 메리트가 큽니다.",
    "안정적인 배당이 강점입니다.",
    "부채 부담이 리스크입니다.",
    "긍정적인 흐름입니다.",
    "실적 개선 가능성이 있습니다.",
    "앞으로 배당을 늘릴 여지가 있습니다.",
    "장기 투자자에게 알맞은 종목입니다.",
    "지금이 좋은 시점입니다.",
    "우량한 재무 구조를 갖추고 있습니다.",
    "저렴한 가격대입니다.",
    "고평가 구간으로 판단됩니다.",
    "가치투자 관점에서 매력적인 수준입니다.",
    "목표 수익률을 20%로 잡을 수 있습니다.",
    "보유를 유지하는 것이 바람직합니다.",
    "추가 상승 여력이 있습니다.",
    "주가가 오를 가능성이 큽니다.",
    "성장성이 뛰어난 회사입니다.",
    "재무 건전성이 양호합니다.",
    "실적 회복이 기대됩니다.",
    "배당 매력이 높습니다.",
    "이 가격대는 부담스럽습니다.",
    "경쟁사보다 저평가된 편입니다.",
    "이익 대비 주가가 합리적인 수준입니다.",
    "하락 위험이 커 보입니다.",
    "비중을 늘리는 것도 방법입니다.",
    "투자 매력이 큰 편입니다.",
    "주가가 적정 가치보다 낮습니다.",
    "올해 하반기 실적이 좋아질 것으로 예상됩니다.",
    "과대평가된 주가입니다.",
    "현금 창출력이 탄탄한 회사입니다.",
  ];
  // 1단계 검토 3차: 가치 판정·시점·권유·영어 (예전 검사로는 54개 중 37개 · 40개 중 24개가 지나갔다 — scratchpad verif-s1c/adv.mts 등)
  const ATTACKS3 = [
    // 가치 판정
    "현재 PER은 역사적 저점 수준입니다.",
    "주가는 바닥권에 있습니다.",
    "PER 8배로 업종 평균보다 크게 할인된 가격에 거래되고 있습니다.",
    "내재가치 대비 할인되어 거래되고 있습니다.",
    "업종 대비 프리미엄을 받고 있습니다.",
    "재무구조가 건전합니다.",
    "재무 상태가 견고합니다.",
    "재무 상태가 매우 건실합니다.",
    "펀더멘털이 견고합니다.",
    "재무 구조가 불안합니다.",
    "탁월한 수익성을 보여 줍니다.",
    "경쟁력 있는 회사입니다.",
    "경쟁력이 높은 회사입니다.",
    "경제적 해자를 갖춘 기업입니다.",
    "경제적 해자가 넓은 기업입니다.",
    "주주 친화적인 배당 정책입니다.",
    "배당 투자자에게 유리한 구조입니다.",
    "주가가 내재가치보다 낮습니다.",
    "현재 주가는 내재가치보다 낮습니다.",
    "밸류에이션 하단에 있습니다.",
    "업사이드가 큽니다.",
    "업사이드가 제한적입니다.",
    "업사이드가 남아 있습니다.",
    "리레이팅이 진행 중입니다.",
    "가치주로 분류됩니다.",
    "저PER 종목입니다.",
    "고배당주입니다.",
    "과열 구간입니다.",
    "주가가 과열되었습니다.",
    "고점 부근입니다.",
    "바닥을 다졌습니다.",
    "PER 12배로 역사적 저점 수준입니다.",
    "현금 창출력이 돋보입니다.",
    "실적이 부진합니다.",
    "재무 체력이 열악합니다.",
    "매우 안정된 재무 구조입니다.",
    "이익 체력이 강합니다.",
    "주가가 이익에 비해 과도하게 높습니다.",
    "밸류에이션이 과도하게 높습니다.",
    "PER이 지나치게 높습니다.",
    "업계 최고 수준입니다.",
    "주가가 이익에 비해 낮게 형성되어 있습니다.",
    "시장 지배력이 압도적입니다.",
    // 권유·행동
    "관심을 가질 필요가 있습니다.",
    "눈여겨볼 필요가 있습니다.",
    "신중한 접근이 필요합니다.",
    "투자 시 유의해야 합니다.",
    "포트폴리오에 편입을 검토할 만합니다.",
    "매집하기에 적당합니다.",
    "장기적으로 들고 가도 됩니다.",
    "배당을 노리는 투자자라면 살펴볼 종목입니다.",
    "지금 사두면 좋습니다.",
    // 예측
    "하반기 반등이 점쳐집니다.",
    "실적 개선이 이어질 것으로 봅니다.",
    "이익은 계속 늘어나겠다.",
    // 영어
    "Strong Buy.",
    "The stock looks undervalued.",
    "BUY rating.",
  ];
  // 새 프롬프트가 쓰는 사실 문장·표 줄 (걸리면 안 됨)
  const FACTS = [
    "## 주가와 재무 숫자",
    "| 항목 | 값 |",
    "| PER | 10.0배 |",
    "| 시가총액 | 1,234조 원 |",
    "## 매출과 이익",
    "매출은 3년 연속 늘었습니다.",
    "영업이익은 2024년 6.6조 원에서 2025년 32.7조 원으로 늘었습니다.",
    "순이익은 2년 연속 줄었습니다.",
    "## 빚과 자본",
    "부채비율 = 부채총계 / 자본총계 = 27.9%",
    "자본총계는 5년 동안 늘었습니다.",
    "ROE = 당기순이익 / 자본총계 = 9.0%",
    "## 배당",
    "주당 배당금은 1,444원으로 2024년과 같습니다.",
    "배당수익률은 1.4%입니다(주당 배당금 ÷ 현재가).",
    "배당 자료는 제공되지 않음 (SEC 연도별 배당 표 없음).",
    "영업현금흐름은 확인 안 됨입니다.",
    "자사주 매입 금액은 확인 안 됨.",
    "## 숫자로 본 변화",
    "1. 영업이익률은 2023년 2.5%에서 2025년 10.9%로 높아졌습니다.",
    "2. EPS는 2,131원, BPS는 57,930원입니다.",
  ];
  // 1단계 검토 3차: 사실 문장인데 걸리던 것(앱 지표 이름·은행 지표·계정 이름·과거 사실)과 새 금지어와 겹치는 사실 말 (걸리면 안 됨)
  const FACTS3 = [
    "공정가치로 평가된 금융자산은 3.2조원입니다.",
    "이익 안정성 자료는 확인 안 됨.",
    "위험가중자산 자료는 확인 안 됨.",
    "| 장기투자자산 | 1.2조원 |",
    "영업이익은 2024년 반등해 12조원입니다.",
    "환율에 따라 원화 금액이 달라질 수 있습니다.",
    "바닥재 매출은 2025년 1.1조원입니다.",
    "유리기판 매출은 늘었습니다.",
    "재무 건전성 묶음 자료는 확인 안 됨.",
    "2023년 S&P 500 지수에 편입되었습니다.",
    "2024년 자회사로 편입하였습니다.",
    "매출은 늘었고 PER은 12.0배입니다.",
    "Best Buy(BBY)의 매출은 2025년 415억 달러입니다.",
    "피해자 보상 비용 2.1억 달러가 영업비용에 들어 있습니다.",
    "건강관리 장비 매출은 늘었습니다.",
    "프리미엄 제품 매출 비중은 30%입니다.",
    "과도기 비용은 없습니다.",
    "매출이 줄었고 영업이익도 줄었습니다.",
    "배당성향 = 배당금 / 순이익 = 25%",
    "이자보상배율은 8.2배입니다.",
  ];
  it("가치분석 금지어: 평가·권유·예측 공격 문장 39개를 모두 빼고, 사실 문장·표 줄은 한 글자도 바꾸지 않는다", () => {
    const passed = ATTACKS.filter((a) => safeValueText(`## 숫자로 본 변화\n1. 매출은 3년 연속 늘었습니다.\n2. ${a}`).includes(a));
    expect(passed).toEqual([]);
    for (const a of ATTACKS) expect(safeValueText(`## 숫자로 본 변화\n1. 매출은 3년 연속 늘었습니다.\n2. ${a}`), a).toBe("## 숫자로 본 변화\n1. 매출은 3년 연속 늘었습니다.\n\n(문장 검사에서 1줄을 뺐습니다)");
    const facts = FACTS.join("\n");
    expect(safeValueText(facts)).toBe(facts);
    // 브리핑 금지어만으로는 대부분 지나갔다 (고치기 전 검사)
    expect(ATTACKS.filter((a) => cleanDetail(`## 변화\n${a}`, "").dropped === 0).length).toBeGreaterThan(20);
  });

  it("1단계 검토 3차: 가치 판정·시점·권유·영어 공격 문장도 모두 빼고, 걸리던 사실 문장(이익 안정성·위험가중자산·공정가치로 평가된·장기투자자산·반등해 12조원)은 그대로", () => {
    const passed = ATTACKS3.filter((a) => safeValueText(`## 숫자로 본 변화\n1. 매출은 3년 연속 늘었습니다.\n2. ${a}`).includes(a));
    expect(passed).toEqual([]);
    expect(ATTACKS3.length).toBeGreaterThan(50);
    for (const f of FACTS3) expect(safeValueCheck(f), f).toEqual({ text: f, dropped: 0 });
    // 같은 줄에 다른 금지어가 있으면 예외 말이 있어도 걸린다
    expect(safeValueCheck("이익 안정성이 높아 안정적입니다.").dropped).toBe(1);
    expect(safeValueCheck("위험가중자산이 늘어 부담입니다.").dropped).toBe(1);
    // 예외 말은 원문 그대로 보인다 (빈칸으로 바꾸는 것은 검사할 때만)
    expect(safeValueText("## 빚과 자본\n위험가중자산 자료는 확인 안 됨.")).toBe("## 빚과 자본\n위험가중자산 자료는 확인 안 됨.");
    // 고치기 전 금지어(가치분석 금지어에서 새 말을 뺀 것)로는 대부분 지나갔다
    const before = new RegExp(VALUE_AI_BANNED.source.split("|내재 ?가치|")[0]!, "g");
    expect(ATTACKS3.filter((a) => cleanDetail(`## 변화\n${a}`, "", before).dropped === 0).length).toBeGreaterThan(30);
  });

  // 1단계 검토 4차: 같은 말의 활용형·돌려 말하기 (3차 검사로는 54개 중 45개가 지나갔다 — scratchpad vs1/adv4.mts)
  const ATTACKS4 = [
    // 싸다·비싸다·나쁘다의 활용
    "주가가 쌉니다.",
    "작년보다 주가가 쌌습니다.",
    "싼 주식입니다.",
    "PER 기준으로 비싼 회사입니다.",
    "주가가 비쌉니다.",
    "작년에는 주가가 비쌌습니다.",
    "주가가 싸네요.",
    "실적이 나빠졌습니다.",
    "재무 상태가 나빴습니다.",
    "주가가 좋았습니다.",
    "이익 대비 주가가 괜찮은 수준입니다.",
    "가성비가 좋은 종목입니다.",
    "헐값에 거래되고 있습니다.",
    "제값을 못 받고 있습니다.",
    // 추측·의견
    "배당이 늘어날 수도 있습니다.",
    "이익이 줄어들 수도 있습니다.",
    "배당 여력이 충분합니다.",
    "실적은 개선되겠습니다.",
    "이익이 늘어난 것으로 봅니다.",
    "주가가 이익을 다 반영하지 못했다고 생각합니다.",
    "이익이 줄어들 것으로 추정됩니다.",
    "주가가 다시 회복할 듯합니다.",
    "지금 들어가도 될까요?",
    // 권유·행동
    "지금은 들어갈 때입니다.",
    "조금씩 모아갈 때입니다.",
    "주식을 모을 때가 왔습니다.",
    "지금 사도 됩니다.",
    "이 가격이면 사도 괜찮습니다.",
    "지금 들어가도 됩니다.",
    "기다리는 편이 낫습니다.",
    "다른 종목보다 이 종목이 낫습니다.",
    "추가로 매입할 시기입니다.",
    "조정 때 사들일 종목입니다.",
    "배당을 노린다면 사 두는 것도 방법입니다.",
    "실적 발표까지 지켜봐야 합니다.",
    "배당 투자자라면 검토해 볼 종목입니다.",
    "지금 사는 게 맞습니다.",
    "이 회사를 살 이유가 충분합니다.",
    "모아갈 가치가 있습니다.",
    "주가가 실적보다 덜 오른 상태라 매수 시점을 기다릴 만합니다.",
    // 예측
    "상승 확률이 높습니다.",
    "배당을 늘릴 회사입니다.",
    "이익이 커질 회사입니다.",
    "성장할 기업입니다.",
    "실적이 나아질 것입니다.",
    "이익은 다시 늘 것입니다.",
    "주가가 다시 올라갈 차례입니다.",
    "주가는 떨어질 일만 남았습니다.",
    "이익 성장세가 지속될 것입니다.",
    "실적이 이어질지 확인해야 합니다.",
    // 영어
    "The stock is cheap.",
    "Shares look attractive at this level.",
    "Big upside from here.",
    "This is a buying opportunity.",
  ];
  // 4차 낱말과 겹치는 사실 문장 (걸리면 안 됨): 에워싸다·차 이름·싸움·'~일까지'·공시한 자사주 계획·되레·되풀이·'것으로 보고했습니다'·지난 일의 '~야 했습니다'·환율 안내
  const FACTS4 = [
    "합병을 둘러싼 소송 비용은 0.3억 달러입니다.",
    "싼타페 판매량은 2025년에 늘었습니다.",
    "경쟁사와의 가격 싸움으로 매출이 줄었습니다.",
    "2025년 12월 31일까지의 실적입니다.",
    "2025년 3분기까지 누적 매출은 30조원입니다.",
    "자사주를 매입할 계획이라고 2025년 공시했습니다.",
    "자기주식을 사들일 계획이라고 2025년 공시했습니다.",
    "매출은 줄었어도 되레 이익은 늘었습니다.",
    "올해도 되풀이된 일회성 비용은 0.2억 달러입니다.",
    "회사는 2024년 벌금 0.1억 달러를 내야 했습니다.",
    "회사는 순이익이 늘어난 것으로 보고했습니다.",
    "환율에 따라 원화 금액이 달라질 수도 있습니다.",
    "주주의 몫인 순이익은 2025년 늘었습니다.",
    "논란에 휩싸인 자회사는 2024년 팔았습니다.",
    "원화로 환산할 때 쓴 환율은 1,380원입니다.",
    "PER은 현재가를 EPS로 나눌 때 12.0배입니다.",
    "배당은 세 차례 늘었습니다.",
    "영업이익률은 2021년부터 해마다 높아졌습니다.",
    "통화가 달라 시가총액과 직접 나누지 않았습니다.",
    "순이익은 2025년 적자로 돌아섰습니다.",
    "영업이익은 흑자로 돌아섰고 순이익도 늘었습니다.",
    "주당 배당금은 2023년 361원에서 2025년 1,444원으로 늘었습니다.",
    "시가총액은 TWD 기준이며 달러로 환산하지 않았습니다.",
  ];
  it("1단계 검토 4차: 활용형(쌉니다·쌌습니다·싼·비쌉니다·나빠졌습니다)·추측(수도 있)·권유(때입니다·사도 됩니다·편이 낫습니다·매입할·사들일)·예측(상승 확률·늘릴 회사) 공격 문장도 모두 빼고, 사실 문장 20개(3차)와 겹치는 사실 문장은 그대로", () => {
    const passed = ATTACKS4.filter((a) => safeValueText(`## 숫자로 본 변화\n1. 매출은 3년 연속 늘었습니다.\n2. ${a}`).includes(a));
    expect(passed).toEqual([]);
    expect(ATTACKS4.length).toBeGreaterThanOrEqual(54);
    expect(FACTS3).toHaveLength(20);
    for (const f of [...FACTS, ...FACTS3, ...FACTS4]) expect(safeValueCheck(f), f).toEqual({ text: f, dropped: 0 });
    // 앞의 공격 문장도 그대로 걸린다
    expect([...ATTACKS, ...ATTACKS3].filter((a) => safeValueCheck(a).dropped === 0)).toEqual([]);
  });

  // 1단계 검토 5차: 직접적인 지시·예측의 흔한 모양 (4차 검사로는 검토 문장 26개 모두 지나갔다 — scratchpad vs5/adv5.mts)
  const ATTACKS5 = [
    // '~면 됩니다'
    "지금 사면 됩니다.",
    "조정 때 사면 됩니다.",
    "팔면 됩니다.",
    "보유하면 됩니다.",
    "계속 보유하시면 됩니다.",
    "담으면 됩니다.",
    "처분하면 됩니다.",
    "갈아타면 됩니다.",
    "지금 사시면 됩니다.",
    "이 가격에 파시면 됩니다.",
    "조금씩 모으면 됩니다.",
    "기다리면 됩니다.",
    "배당만 받으면 됩니다.",
    "지금 사면 되는 가격입니다.",
    "팔면 좋습니다.",
    "정리하면 됩니다.",
    "보유하시면 돼요.",
    // 의견·보유 표현
    "보유 의견입니다.",
    "비중 유지입니다.",
    "중립 의견입니다.",
    "비중 확대 의견입니다.",
    "비중을 유지합니다.",
    // 현재형 예측
    "주가는 곧 오릅니다.",
    "주가는 10만원까지 갑니다.",
    "주가는 오르게 되어 있습니다.",
    "배당은 늘게 됩니다.",
    "주가는 내립니다.",
    "주가는 곧 떨어집니다.",
    "주가는 두 배로 뜁니다.",
    "주가는 상승합니다.",
    "주가는 하락합니다.",
    "주가는 20만원까지 간다.",
    "실적은 좋아지게 되어 있습니다.",
    "이익은 커지게 됩니다.",
    "주가는 회복하게 됩니다.",
    // 영어 투자 의견
    "Buy.",
    "Sell.",
    "Hold.",
    "Rating: Hold",
    "Price target: $200.",
    "We recommend holding the shares.",
    "Overweight.",
    "Underweight.",
    "Accumulate.",
    "Worth buying.",
    "fairly valued",
    "a good entry point",
    "HOLD.",
    "Rating: Neutral",
    "Target price $250.",
    "Equal-weight.",
    "Market Perform.",
    "Good time to buy.",
  ];
  // 걱정·평가 말과 가치를 돌려 말한 문장 (검토 should — 13개 모두 지나갔다)
  const JUDGE5 = [
    "실적이 걱정됩니다.",
    "주가 하락이 염려됩니다.",
    "부채가 많아 조심스럽습니다.",
    "주가가 이익에 비해 너무 높습니다.",
    "재무가 깔끔합니다.",
    "든든한 배당입니다.",
    "믿음직한 회사입니다.",
    "값어치가 있습니다.",
    "제 가치를 인정받지 못하고 있습니다.",
    "공정 가치는 10만원입니다.",
    "주가에 아직 반영되지 않은 가치가 있습니다.",
    "Solid balance sheet.",
    "A great company.",
    "주당 공정가치는 150달러입니다.",
    "주가는 공정가치보다 낮습니다.",
    "Strong balance sheet.",
  ];
  // 5차 낱말과 겹치거나 '~야 할 '·'팔아'에 잘못 걸리던 사실 문장 (걸리면 안 됨)
  const FACTS5 = [
    "1년 안에 갚아야 할 빚(유동부채)은 3.2조원입니다.",
    "2024년 자회사를 팔아 생긴 이익 2.1조원이 순이익에 들어 있습니다.",
    "지급해야 할 배당금은 0.5조원입니다.",
    "회사가 내야 할 법인세는 1.1조원입니다.",
    "2023년 공장을 팔아 얻은 이익은 0.3조원입니다.",
    "자회사 지분을 팔아서 남긴 이익은 0.4조원입니다.",
    "상환해야 할 사채는 1.0조원입니다.",
    "주가는 2025년 한 해 30% 올랐습니다.",
    "주가는 2025년 10만원까지 올랐습니다.",
    "금융자산의 공정가치는 3.2조원입니다.",
    "투자부동산의 공정가치는 1,200억원입니다.",
    "매출 비중은 30%로 유지되었습니다.",
    "해외 매출 비중이 확대되었습니다.",
    "감가상각누계액(Accumulated depreciation)은 2.0조원입니다.",
    "HD현대(HD Hyundai Holdings) 매출은 늘었습니다.",
    "이 비용은 영업비용에 들어갑니다.",
    "배당은 연 2회 지급합니다.",
    "현재가를 EPS로 나누면 PER 12.0배가 됩니다.",
    "주가가 오른 만큼 PER도 높아졌습니다.",
    "이익이 늘게 되었습니다.",
    "경제적 부가가치 자료는 확인 안 됨.",
    "2025년 자사주 2,000억원어치를 사들였습니다.",
  ];
  it("1단계 검토 5차: '~면 됩니다'·'보유 의견'·'비중 유지'·현재형 예측('오릅니다'·'10만원까지 갑니다'·'오르게 되어 있습니다')·영어 투자 의견('Buy.'·'Hold.'·'Price target')·걱정·평가 말도 모두 빼고, '갚아야 할 빚'·'팔아 생긴 이익' 같은 사실 문장은 그대로", () => {
    const passed = [...ATTACKS5, ...JUDGE5].filter((a) => safeValueText(`## 숫자로 본 변화\n1. 매출은 3년 연속 늘었습니다.\n2. ${a}`).includes(a));
    expect(passed).toEqual([]);
    expect(ATTACKS5.length).toBeGreaterThanOrEqual(53);
    // 사실 문장(21 · 3차 20 · 4차 23 · 5차 22)은 한 글자도 바뀌지 않는다
    expect([FACTS.length, FACTS3.length, FACTS4.length]).toEqual([21, 20, 23]);
    for (const f of [...FACTS, ...FACTS3, ...FACTS4, ...FACTS5]) expect(safeValueCheck(f), f).toEqual({ text: f, dropped: 0 });
    // 앞의 공격 문장도 그대로 걸린다
    expect([...ATTACKS, ...ATTACKS3, ...ATTACKS4].filter((a) => safeValueCheck(a).dropped === 0)).toEqual([]);
    // 허용 말('갚아야 할'·'팔아 생긴')은 뒤에 권유가 오면 그대로 걸린다
    for (const a of ["빚을 갚아야 할 때입니다.", "지금은 팔아야 할 시점입니다.", "지금 내야 할 차례입니다.", "주식을 팔아 생긴 현금으로 다른 종목을 사면 됩니다.", "갚아야 할 빚이 많아 부담입니다.", "팔아서 얻은 이익이 크니 다시 사도 됩니다."]) {
      expect(safeValueCheck(a).dropped, a).toBe(1);
    }
    // 고치기 전 금지어(5차 줄을 뺀 것)로는 검토 문장이 모두 지나갔다
    const before = new RegExp(VALUE_AI_BANNED.source.split("|(?<![가-힣])(?:사|팔|파|담으")[0]!, "g");
    expect(before.source.length).toBeLessThan(VALUE_AI_BANNED.source.length);
    const allowBefore = new RegExp(VALUE_AI_ALLOW.source.split("|(?:갚아")[0]!, "g");
    expect(ATTACKS5.slice(0, 8).filter((a) => cleanDetail(`## 변화\n${a}`, "", before, allowBefore).dropped === 0)).toHaveLength(8);
    expect(FACTS5.slice(0, 5).filter((f) => cleanDetail(f, "", before, allowBefore).dropped === 1)).toHaveLength(5);
  });

  // 1단계 검토 6차: '나쁩니다'(나쁘다의 -ㅂ니다 활용)·존댓말 허락('사셔도 됩니다')·'~도 무방/문제없'·'살 시기·차례'·'때죠·때네요'·'더 나은 선택'·'매입 구간'·'늦지 않' (5차 검사로는 지나갔다)
  const ATTACKS6 = [
    // 나쁘다의 '-ㅂ니다' 활용 (4차 줄은 '나빠·나빴·나쁠'만)
    "실적이 나쁩니다.",
    "재무 상태가 나쁩니다.",
    "업황이 나쁩니다.",
    // 존댓말 허락 '~셔도 됩니다'
    "지금 사셔도 됩니다.",
    "계속 보유하셔도 됩니다.",
    "들어가셔도 됩니다.",
    "투자하셔도 됩니다.",
    "매입하셔도 됩니다.",
    "사들이셔도 됩니다.",
    "사 두셔도 됩니다.",
    "파셔도 됩니다.",
    "갖고 계셔도 됩니다.",
    // '~도 무방·문제없'
    "지금 사도 무방합니다.",
    "보유해도 무방합니다.",
    "매입해도 무방합니다.",
    "사도 문제없습니다.",
    // 받침 ㄹ + 시기·차례 · '때죠·때네요'
    "이제는 살 시기입니다.",
    "지금은 팔 시기입니다.",
    "모아갈 시기입니다.",
    "이제 살 차례입니다.",
    "들어갈 때죠.",
    "모을 때네요.",
    // 고르기·시점 말
    "이 종목이 더 나은 선택입니다.",
    "더 나은 투자처입니다.",
    "지금은 매입 구간입니다.",
    "아직 늦지 않았습니다.",
    "지금 사셔도 늦지 않습니다.",
  ];
  // 6차 낱말과 겹치는 사실 문장 (걸리면 안 됨): '~할 시기는'(뒤에 '는'·'에')·'네 차례'·'자사주 매입 기간'
  const FACTS6 = [
    "배당금을 지급할 시기는 매년 4월입니다.",
    "2024년 분기 배당을 네 차례 지급했습니다.",
    "같은 시기에 부채는 줄었습니다.",
    "자사주 매입 기간은 2025년 3월부터 6월입니다.",
  ];
  it("1단계 검토 6차: '나쁩니다'·'사셔도 됩니다'·'사도 무방합니다'·'살 시기입니다'·'들어갈 때죠'·'더 나은 선택'·'매입 구간'·'늦지 않았습니다' 27개도 모두 빼고, 사실 문장 86개(21·20·23·22)는 한 글자도 바꾸지 않는다", () => {
    expect(ATTACKS6).toHaveLength(27);
    const passed = ATTACKS6.filter((a) => safeValueText(`## 숫자로 본 변화\n1. 매출은 3년 연속 늘었습니다.\n2. ${a}`).includes(a));
    expect(passed).toEqual([]);
    for (const a of ATTACKS6) expect(safeValueCheck(a).dropped, a).toBe(1);
    // 사실 문장 86개(1차 21 · 3차 20 · 4차 23 · 5차 22)와 6차 낱말과 겹치는 사실 문장은 그대로
    const facts = [...FACTS, ...FACTS3, ...FACTS4, ...FACTS5];
    expect(facts).toHaveLength(86);
    for (const f of [...facts, ...FACTS6]) expect(safeValueCheck(f), f).toEqual({ text: f, dropped: 0 });
    expect(safeValueText(facts.join("\n"))).toBe(facts.join("\n"));
    // 앞의 공격 문장도 그대로 걸린다
    expect([...ATTACKS, ...ATTACKS3, ...ATTACKS4, ...ATTACKS5, ...JUDGE5].filter((a) => safeValueCheck(a).dropped === 0)).toEqual([]);
    // 고치기 전 금지어(6차 줄을 뺀 것)로는 모두 지나갔다
    const before = new RegExp(VALUE_AI_BANNED.source.split("|나쁩|")[0]!, "g");
    expect(before.source.length).toBeLessThan(VALUE_AI_BANNED.source.length);
    expect(ATTACKS6.filter((a) => cleanDetail(`## 변화\n${a}`, "", before, VALUE_AI_ALLOW).dropped === 0)).toEqual(ATTACKS6);
  });

  it("요청 ID로 회수하는 경로(analysisWaitRecovery)도 같은 검사: 응답·상태 확인의 latest·request.result 모두 걸린 줄을 뺀 글, 저장은 원문 · 끄면 원문 그대로", async () => {
    const ID = "value-request-0001";
    for (const on of [true, false]) {
      db = await createMigratedDb(":memory:");
      app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: new ValueGen() }), logger: false, enableScheduler: false, now: () => kst("2026-09-28T10:00:00") });
      await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { valueAiSafeWording: on } });
      const res = (await app.inject({ method: "GET", url: `/api/stocks/000660/analysis/value?requestId=${ID}` })).json() as { content: string };
      const state = (await app.inject({ method: "GET", url: `/api/stocks/000660/analysis/value/state?requestId=${ID}` })).json() as { latest: { content: string }; request: { status: string; result: { content: string } } };
      // 같은 요청 ID 를 다시 보내도 (작업 기록에서 돌려줌) 같은 글
      const again = (await app.inject({ method: "GET", url: `/api/stocks/000660/analysis/value?requestId=${ID}` })).json() as { content: string };
      if (on) {
        expect(res.content).toMatch(/\(문장 검사에서 2줄을 뺐습니다\)$/);
        expect(res.content).not.toContain("매수");
      } else {
        expect(res.content).toContain("지금이 매수 기회로 보입니다.");
      }
      expect(state.latest.content).toBe(res.content);
      expect(state.request).toMatchObject({ status: "completed", result: { content: res.content } });
      expect(again.content).toBe(res.content);
      const row = await db.selectFrom("analyses").select("content").executeTakeFirstOrThrow();
      expect(row.content).toContain("지금이 매수 기회로 보입니다.");
      await app.close();
      app = null;
    }
  });

  it("뺀 줄 수를 서버 기록에 남긴다 ('AI 가치분석 문장 검사' — 새로 만든 글은 0줄이어도, 전에 만든 글은 뺀 줄이 있을 때만)", async () => {
    db = await createMigratedDb(":memory:");
    const lines: string[] = [];
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ generator: new ValueGen() }),
      logger: { level: "info", stream: { write: (l: string) => void lines.push(l) } },
      enableScheduler: false,
      now: () => kst("2026-09-28T10:00:00"),
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { valueAiSafeWording: true } });
    const logs = () => lines.map((l) => JSON.parse(l) as { msg: string; code?: string; dropped?: number; from?: string }).filter((l) => l.msg === "AI 가치분석 문장 검사");
    await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/value" });
    expect(logs()).toEqual([expect.objectContaining({ code: "000660", dropped: 2, from: "new" })]);
    // 전에 만든 글을 다시 볼 때: 뺀 줄이 있으면 'cache' 로 한 번 더
    await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/value" });
    expect(logs().map((l) => l.from)).toEqual(["new", "cache"]);
    // 끄면 기록 없음
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { valueAiSafeWording: false } });
    await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/value" });
    expect(logs()).toHaveLength(2);
  });

  it("예전 프롬프트로 만든 글('## 강점'·'## 리스크'·'## 가치투자 관점 요약')은 그 절을 통째로 뺀다 (7일 캐시 글)", () => {
    const old =
      "## 밸류에이션 스냅샷\n| PER | 10.0배 |\n\n## 강점\n1. 업종 대비 낮은 PER로 가격 메리트가 큽니다.\n2. 안정적인 배당으로 장기 보유에 적합합니다.\n\n## 리스크\n1. 반도체 업황 둔화 시 실적 변동이 큽니다.\n2. 환율 변동 영향이 큽니다.\n\n## 가치투자 관점 요약\n숫자로 보면 이익 대비 주가 수준이 낮은 편입니다. 판단은 독자에게 맡깁니다.";
    expect(isOldValueText(old)).toBe(true);
    expect(isOldValueText("## 주가와 재무 숫자\n| PER | 10.0배 |")).toBe(false);
    const out = safeValueText(old);
    expect(out).toBe("## 밸류에이션 스냅샷\n| PER | 10.0배 |\n\n(문장 검사에서 5줄을 뺐습니다)");
    expect(out).not.toMatch(/강점|리스크|관점/);
  });

  it("켜면 예전 프롬프트로 만든 캐시 글은 쓰지 않고 새로 만든다 · 새로 만들기에 실패하면 예전 글의 평가 절을 뺀 것 · 끄면 캐시 글 그대로", async () => {
    const OLD = "## 밸류에이션 스냅샷\n| PER | 10.0배 |\n\n## 강점\n1. 안정적인 배당으로 장기 보유에 적합합니다.\n\n## 리스크\n1. 업황 둔화 시 실적 변동이 큽니다.";
    async function withCache(on: boolean, gen: TextGenerator) {
      db = await createMigratedDb(":memory:");
      app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ generator: gen }), logger: false, enableScheduler: false, now: () => kst("2026-09-28T10:00:00") });
      await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { valueAiSafeWording: on } });
      // 하루 전에 예전 프롬프트로 만든 글 (TTL 7일 안)
      await db.insertInto("analyses").values({ code: "000660", kind: "value", content: OLD, data_snapshot: "{}", missing_data: "[]", model: "old-model", created_at: "2026-09-27T10:00:00+09:00" }).execute();
      const res = await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/value" });
      const body = res.json() as { content: string; cached: boolean };
      await app.close();
      app = null;
      return { status: res.statusCode, body };
    }
    const gen = new ValueGen();
    const on = await withCache(true, gen);
    expect(gen.requests).toHaveLength(1);
    expect(gen.requests[0]!.system).toContain("편집자");
    expect(on.body.content).toContain("매출은 3년 연속 늘었습니다.");
    expect(on.body.content).not.toMatch(/강점|리스크/);
    // 새로 만들기 실패 (AI 키 없음 등): 예전 글에서 평가 절을 뺀 것
    const failing: TextGenerator = { model: "x", generate: async () => Promise.reject(new Error("가짜 생성 실패")) };
    const fb = await withCache(true, failing);
    expect(fb.status).toBe(200);
    expect(fb.body.content).toBe("## 밸류에이션 스냅샷\n| PER | 10.0배 |\n\n(문장 검사에서 2줄을 뺐습니다)");
    expect(fb.body.cached).toBe(true);
    // 끄면 지금처럼 캐시 글 그대로 (새로 만들지 않음)
    const gen2 = new ValueGen();
    const off = await withCache(false, gen2);
    expect(gen2.requests).toHaveLength(0);
    expect(off.body.content).toBe(OLD);
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
      twoSidedLine(false, [["PBR", 0, "(적자)"]]),
      twoSidedMidLine([["ROE", 50]]),
      blendRankNote("44.8배", cyclicalWhy({ byIndustry: true, lo: null, hi: null })),
      blendRankZeroNote(cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6 }), false),
      blendRankNote("278.0배", cyclicalWhy({ byIndustry: false, lo: -26.7, hi: 31.6, steady: "up" })),
      blendRankNote("12.0배", cyclicalWhy({ byIndustry: false, lo: 5.2, hi: 30.4, steady: "down" })),
      profitMedianText("A1", "20.2배", "업종", 152, 27, "PER"),
      profitMedianText("A2", "73.4배", "업종", 64, 47, "기업가치 ÷ 영업이익"),
      ...["A1", "A2"].flatMap((k) => [profitMedianText(k as "A1", "58.6배", "업종", 68, 43), lossClumpSentence(k as "A1", 43, 50), lossClumpSentence(k as "A1", 43, 80), lossClumpSentence(k as "A1", 43, 10)]),
      PRICE_NOTE_BASE,
      PRICE_NOTE_BLEND,
      PRICE_NOTE_BLEND_PLAIN,
      blendPosPrefix("44.8배", "업종 안 위치 76/100 · 시장 안 57/100"),
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
      krFewQuartersText(0),
      KR_QUARTER_GAP_TEXT,
      preferredText("삼성전자"),
      preferredText(null),
      lossAccrualText("2.39억 달러", "0.61억 달러", true, true),
      lossAccrualText("2.39억 달러", "3.00억 달러", true, false),
      lossAccrualText("113억 달러", "149억 달러", false, false),
      LOSS_ACCRUAL_MEANING,
      CYCLICAL_PEAK_MARGIN,
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
