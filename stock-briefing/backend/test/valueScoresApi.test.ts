import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { scoreWordingProblems } from "../src/analysis/scoreWording.js";
import { VALUE_WEIGHTS, type ValueReferenceData } from "../src/analysis/valueScore.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Candle } from "../src/domain/types.js";
import { EdgarProvider } from "../src/providers/dart/edgar.js";
import { NasdaqScreener } from "../src/providers/market/nasdaqScreener.js";
import { parseProductFacts } from "../src/providers/market/toss.js";
import { BACKUP_TABLES, restoreBackup } from "../src/services/backupService.js";
import { FEATURES } from "../src/services/featureService.js";
import { compositeOf, type ScoreSources, type ScoresResponse, type ScoreStock } from "../src/services/indicatorScoreService.js";
import { STATUS_TEXT } from "../src/services/indicatorScoreText.js";
import type { FrameRow, ReferenceSources, ScreenerRow } from "../src/services/valueReference.js";
import { weeklyValueChange } from "../src/services/valueScoreService.js";
import { gapText, howLinesV2, VALUE_STATUS_TEXT } from "../src/services/valueScoreText.js";
import { benchOf, candlesOf, tossInfo } from "./fixtures/indicatorScores/load.js";
import { dailyOf, fakeValueSources, monthlyOf, referenceData } from "./fixtures/valueScores/load.js";
import { fakeProviders } from "./helpers.js";

/**
 * 가치 지표 점수 2단계 (3-44, 플래그 indicatorScores + valueScore): GET /api/scores/:code 의 가치·종합, 재무 받기(백그라운드·장 마감 뒤),
 * 주간 비교 기준, 받기 실패·지난 값, 대상 아님, 플래그 끔. 네트워크 없음 — SEC 재무·비교 기준·일봉·월봉은 기록한 공개 자료, 시계는 고정.
 * 기본 시계: 2026-09-28(월) 10:00 KST = 뉴욕 9/27(일) → 가격 기준일 9/25(금)
 */

const kst = (s: string) => new Date(`${s}+09:00`);
const ny = (s: string) => new Date(`${s}-04:00`);

const STOCKS: Record<string, ScoreStock> = {
  NVDA: { code: "NVDA", name: "엔비디아", market: "NASDAQ" },
  MSFT: { code: "MSFT", name: "마이크로소프트", market: "NASDAQ" },
  AAPL: { code: "AAPL", name: "애플", market: "NASDAQ" },
  META: { code: "META", name: "메타", market: "NASDAQ" },
  RGTI: { code: "RGTI", name: "리게티 컴퓨팅", market: "NASDAQ" },
  JPM: { code: "JPM", name: "JP모건 체이스", market: "NYSE" },
  SOXL: { code: "SOXL", name: "SOXL", market: "AMEX", groupCode: "EF" },
  SOXX: { code: "SOXX", name: "iShares Semiconductor ETF", market: "NASDAQ", groupCode: "EF" },
  QQQ: { code: "QQQ", name: "Invesco QQQ Trust", market: "NASDAQ", groupCode: "EF" },
  O: { code: "O", name: "리얼티 인컴", market: "NYSE" },
  "005930": { code: "005930", name: "삼성전자", market: "KOSPI" },
  // 예시 종목 (시험용 — 일봉·재무를 다른 종목 기록으로 빌려 씀)
  ZZNOF: { code: "ZZNOF", name: "예시 종목 (SEC 재무 없음)", market: "NASDAQ" },
  ZZGAP: { code: "ZZGAP", name: "예시 종목 (두 점수 차이 큼)", market: "NASDAQ" },
  ZZREIT: { code: "ZZREIT", name: "예시 종목 (SIC 리츠)", market: "NASDAQ" },
};
/** 일봉 빌려 쓰기: 예시 종목 → 기록 종목 */
const CANDLE_OF: Record<string, string> = { ZZNOF: "AAPL", ZZGAP: "NVDA", ZZREIT: "MSFT", O: "MSFT" };
const TOSS = { SOXL: tossInfo("SOXL"), RGTX: tossInfo("RGTX"), MSFT: tossInfo("MSFT") } as Record<string, Record<string, unknown>>;

function candles(code: string): Candle[] {
  if (code === "JPM") return dailyOf("JPM");
  const c = CANDLE_OF[code] ?? code;
  return candlesOf(/^\d{6}$/.test(c) ? `${c}.KS` : c);
}

function scoreSources(over: { registered?: string[]; product?: Record<string, ReturnType<typeof parseProductFacts> | null>; candles?: Record<string, Candle[]> } = {}) {
  const calls = { candles: [] as string[], monthly: [] as string[] };
  const src: ScoreSources = {
    stock: async (code) => STOCKS[code] ?? null,
    candles: async (code, count) => {
      calls.candles.push(code);
      const cs = over.candles?.[code] ?? candles(code);
      return { code, period: "D", candles: cs.slice(-count), source: "yahoo" };
    },
    benchmark: async (code) => (code === "NASDAQ" ? benchOf("NVDA") : code === "SPX" ? dailyOf("SPX") : code === "KOSPI" ? benchOf("005930.KS") : null),
    product: async (code) => {
      if (over.product && code in over.product) return over.product[code]!;
      return code === "SOXL" || code === "MSFT" ? parseProductFacts(JSON.parse(JSON.stringify(TOSS[code]))) : null;
    },
    registered: async () => (over.registered ?? []).map((c) => STOCKS[c]!),
    monthly: async (code) => {
      calls.monthly.push(code);
      return monthlyOf(CANDLE_OF[code] ?? code);
    },
  };
  return { src, calls };
}

let app: FastifyInstance | null = null;
let db: Db;
let clock = kst("2026-09-28T10:00:00");
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(opts: { score?: ReturnType<typeof scoreSources>; value?: ReturnType<typeof fakeValueSources>; at?: Date; reference?: ValueReferenceData | null; facts?: string[]; flags?: Record<string, boolean> } = {}) {
  clock = opts.at ?? kst("2026-09-28T10:00:00");
  db = await createMigratedDb(":memory:");
  const score = opts.score ?? scoreSources();
  const value = opts.value ?? fakeValueSources({ alias: { ZZGAP: "RGTI", ZZREIT: "MSFT" } });
  app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ scoreSources: score.src, valueSources: value.src }), logger: false, enableScheduler: false, now: () => clock });
  if (opts.flags) await app.inject({ method: "PUT", url: "/api/admin/features", payload: opts.flags });
  if (opts.reference !== null) await app.valueScores.saveReference(opts.reference ?? referenceData());
  for (const c of opts.facts ?? []) await app.valueScores.refreshFacts(c);
  value.calls.facts.length = 0;
  return { app, score, value };
}
const get = async (code: string) => {
  const r = await app!.inject({ method: "GET", url: `/api/scores/${code}` });
  return { status: r.statusCode, body: r.json() as ScoresResponse };
};
function texts(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(texts);
  if (v && typeof v === "object") return Object.values(v).flatMap(texts);
  return [];
}
const US = ["NVDA", "MSFT", "AAPL", "META", "JPM", "RGTI"];

describe("플래그 valueScore (indicatorScores 안의 가치 부분 되돌리기 스위치)", () => {
  it("기본 켜짐, 설명에 '끄면 … 0건'", () => {
    expect(FEATURES.valueScore.default).toBe(true);
    expect(FEATURES.valueScore.description).toMatch(/끄면 .*0건/);
  });

  it("끄면 1단계 그대로 (가치 '계산 준비 중', 종합 없음, 계산 방법 1단계) — SEC·Nasdaq 요청 0건, 가치 기록 0줄, 비교 기준 만들기도 안 함", async () => {
    const { value } = await start({ facts: [], flags: { valueScore: false } });
    const r = await get("NVDA");
    expect(r.status).toBe(200);
    expect(r.body.value).toMatchObject({ status: "pending", label: "계산 준비 중", text: STATUS_TEXT.valuePending, score: null });
    expect(r.body.composite).toMatchObject({ status: "none", reason: "valueMissing" });
    expect(r.body.text.how).not.toEqual(howLinesV2());
    await app!.valueScores.idle();
    expect(await app!.valueScores.buildReference({ force: true })).toBe("off");
    clock = ny("2026-09-25T17:31:00");
    await app!.indicatorScores.runDaily("US", { codes: ["NVDA"] });
    expect(value.calls).toMatchObject({ facts: [], sic: 0, screener: 0, tickers: 0, frames: 0 });
    expect(await db.selectFrom("indicator_scores").selectAll().where("kind", "=", "value").execute()).toEqual([]);
  });

  it("indicatorScores 를 끄면 경로 404, 가치 쪽 요청·계산도 0건", async () => {
    const { value } = await start({ flags: { indicatorScores: false } });
    expect((await get("NVDA")).status).toBe(404);
    expect(await app!.valueScores.buildReference({ force: true })).toBe("off");
    expect(value.calls.facts).toEqual([]);
  });
});

describe("화면 요청은 SEC 를 기다리지 않는다 (저장한 값만 읽고, 없으면 백그라운드로 받기)", () => {
  it("재무가 없으면 바로 '계산 준비 중 — 재무제표를 처음 받는 중', 뒤에서 받은 뒤 1분 지나면 점수와 종합", async () => {
    let release!: () => void;
    const hold = new Map([["NVDA", new Promise<void>((r) => (release = r))]]);
    const value = fakeValueSources({ hold });
    await start({ value });
    const first = await get("NVDA");
    expect(first.body.value).toMatchObject({ status: "pending", label: "계산 준비 중", reason: { code: "pendingFacts", text: VALUE_STATUS_TEXT.pendingFacts } });
    expect(first.body.composite.reason).toBe("valueMissing");
    expect(first.body.trend.status).toBe("ok"); // 추세는 그대로
    expect(value.calls.facts).toEqual(["NVDA"]); // 받기는 시작했지만 응답은 기다리지 않았다
    release();
    await app!.valueScores.idle();
    // 같은 응답은 1분만 기억 (대기 중이었으므로)
    expect((await get("NVDA")).body.value.status).toBe("pending");
    clock = new Date(clock.getTime() + 61_000);
    const second = await get("NVDA");
    expect(second.body.value.status).toBe("ok");
    expect(second.body.composite.status).toBe("ok");
    expect(value.calls.facts).toEqual(["NVDA"]);
  });

  it("비교 기준이 아직 없으면 '계산 준비 중 — 첫 비교 기준을 만드는 중'", async () => {
    await start({ reference: null, facts: ["NVDA"] });
    expect((await get("NVDA")).body.value).toMatchObject({ status: "pending", reason: { code: "pendingReference", text: VALUE_STATUS_TEXT.pendingReference } });
  });
});

describe("GET /api/scores/:code — 미국 보통주 가치 지표 점수", () => {
  it("예시 6종목 (기록한 SEC 재무 · 2026-09-26 비교 기준): 점수·띠·경로·묶음 비중, V = round(Σ 비중 × 묶음 / Σ 비중)", async () => {
    await start({ facts: US });
    const got: Record<string, [number | null, string | null, string | null]> = {};
    for (const c of US) {
      const v = (await get(c)).body.value;
      got[c] = [v.score, v.band, v.path];
      if (v.score === null) continue;
      const valid = v.families.filter((f) => f.scoreExact !== null);
      const W = VALUE_WEIGHTS[v.path!];
      const exact = valid.reduce((a, f) => a + W[f.key] * f.scoreExact!, 0) / valid.reduce((a, f) => a + W[f.key], 0);
      expect(v.scoreExact).toBeCloseTo(exact, 9);
      expect(v.score).toBe(Math.floor(exact + 0.5));
      expect(v.families.map((f) => f.weight)).toEqual(v.path === "financial" ? [35, 30, 10, 15, 10] : [30, 25, 20, 15, 10]);
    }
    expect(got).toEqual(EXPECTED_VALUE);
  });

  it("NVDA: 최근 4분기(2026년 7월까지, 8/26 제출) · 20거래일 평균 주가 · 반도체 업종 비교, 경기 민감이라 PER 에 5년 평균 이익을 섞음 · 경기 정점 표시", async () => {
    await start({ facts: ["NVDA"] });
    const r = (await get("NVDA")).body;
    const v = r.value;
    expect(v.asOf).toMatchObject({ priceThrough: "2026-09-25", fiscalEnd: "2026-07-26", filed: "2026-08-26", form: "10-Q", basis: "TTM", reference: "2026-09-26" });
    expect(v.datesLine).toBe("주가 9월 25일(금)까지 20거래일 평균 · 재무 2026년 7월까지 최근 4분기, 8월 26일(수) 제출 · 비교 기준 9월 26일(토)");
    expect(v.peerLine).toMatch(/^같은 업종\(반도체, \d+개 회사\)·같은 시장과 비교해/);
    expect(v.headline).toBe(`가치 지표 점수 ${v.score}/100 · ${v.band}`);
    expect(v.priceNote).toContain("20거래일 평균 가격 기준");
    const a1 = v.families[0]!.metrics.find((m) => m.key === "A1")!;
    expect(a1.note).toContain("5년 평균 이익을 반씩 섞어");
    expect(v.flags.map((f) => f.key)).toContain("cyclicalPeak");
    // 날짜 줄: 가격 + 재무 기준
    expect(r.asOf.line).toBe("가격 9월 25일(금) 미국 종가 · 재무 2026년 7월까지 4분기");
    // 요약 줄 뜻
    expect(v.text).toMatch(/^재무 숫자가 같은 업종·시장 회사들 사이 어디쯤인지: 여러 지표 순위의 평균이/);
    // 쓰지 않는 지표(70% 규칙: 매출총이익 ÷ 자산, 이자보상배율)는 안내만
    const b3 = v.families[1]!.metrics.find((m) => m.key === "B3")!;
    expect(b3).toMatchObject({ used: false, value: null, score: null });
  });

  it("MSFT (6월 결산, 최근 = 연간 보고서): 재무 '2026년 6월 결산 연간', 자기 지난 5년 비교를 쓴다 (월말 36개 이상)", async () => {
    await start({ facts: ["MSFT"] });
    const v = (await get("MSFT")).body.value;
    expect(v.asOf).toMatchObject({ fiscalEnd: "2026-06-30", basis: "FY", fiscalLabel: "2026년 6월 결산 연간" });
    const a1 = v.families[0]!.metrics.find((m) => m.key === "A1")!;
    expect(a1.positions).toMatch(/지난 5년 중 \d+\/100/);
    expect(a1.mix).toBe("업종 50 · 시장 20 · 지난 5년 30");
    expect(v.peerLine).toContain("이 회사의 지난 5년과 비교해");
  });

  it("JPM (은행): 금융사 경로 35·30·10·15·10, 은행끼리 비교, 금융사 안내 표시", async () => {
    await start({ facts: ["JPM"] });
    const v = (await get("JPM")).body.value;
    expect(v.path).toBe("financial");
    expect(v.families.map((f) => f.metrics.map((m) => m.key))).toEqual([["A1", "A3"], ["B1", "F1", "F2"], ["F3"], ["C1", "C2"], ["E1", "E2"]]);
    expect(v.flags.map((f) => f.key)).toContain("financial");
    expect(v.peerLine).toMatch(/^같은 업종\(대형 은행, \d+개 회사\)·금융사 전체/);
  });

  it("RGTI (적자): 이익 기준 지표 0점 문장, 초기 단계 표시", async () => {
    await start({ facts: ["RGTI"] });
    const v = (await get("RGTI")).body.value;
    const a1 = v.families[0]!.metrics.find((m) => m.key === "A1")!;
    expect(a1).toMatchObject({ value: "적자", score: 0, text: "순이익이 0 이하라 0점으로 계산했습니다." });
    expect(v.flags.map((f) => f.key)).toContain("earlyStage");
  });

  it("종합 = 화면에 보이는 두 정수의 평균 (floor((V + T) / 2 + 0.5)), 차이 30 이상이면 안내 (예시 종목: NVDA 일봉 + RGTI 재무)", async () => {
    await start({ facts: ["NVDA", "ZZGAP"] });
    const n = (await get("NVDA")).body;
    expect(n.composite).toMatchObject({ status: "ok", score: Math.floor((n.value.score! + n.trend.score!) / 2 + 0.5), text: "두 점수의 평균", gap: Math.abs(n.value.score! - n.trend.score!) });
    const g = (await get("ZZGAP")).body;
    expect(g.value.status).toBe("ok");
    expect(Math.abs(g.value.score! - g.trend.score!)).toBeGreaterThanOrEqual(30);
    expect(g.composite).toMatchObject({ status: "ok", gapNote: true, gapText: gapText(Math.abs(g.value.score! - g.trend.score!)) });
  });
});

describe("대상 아님 · 한국 · 받기 실패 · 지난 값", () => {
  it("ETF(SOXL·QQQ)는 가치 '대상 아님', 종합 없음, SEC 요청 0건", async () => {
    const { value } = await start();
    for (const c of ["SOXL", "QQQ"]) {
      const b = (await get(c)).body;
      expect(b.value).toMatchObject({ status: "excluded", label: "대상 아님", text: STATUS_TEXT.valueEtf });
      expect(b.composite.status).toBe("none");
    }
    await app!.valueScores.idle();
    expect(value.calls.facts).toEqual([]);
  });

  it("스팩·우선주·정리매매(토스 상품 정보), 리츠(Nasdaq 업종 · SIC 6798)는 대상 아님", async () => {
    const product = (extra: Record<string, unknown>) => parseProductFacts({ ...JSON.parse(JSON.stringify(TOSS["MSFT"])), ...extra }) as never;
    const spac = { ...product({}), spac: true };
    const pref = { ...product({}), commonShare: false };
    const clear = { ...product({}), clearance: true };
    for (const [p, code] of [
      [spac, "spac"],
      [pref, "preferred"],
      [clear, "clearance"],
    ] as const) {
      await start({ score: scoreSources({ product: { MSFT: p } }), facts: ["MSFT"] });
      expect((await get("MSFT")).body.value).toMatchObject({ status: "excluded", reason: { code } });
      await app!.close();
      app = null;
    }
    await start();
    expect((await get("O")).body.value).toMatchObject({ status: "excluded", reason: { code: "reit", text: VALUE_STATUS_TEXT.reit } });
    await app!.close();
    app = null;
    // SIC 6798: 재무 받기 때 SEC 업종 번호를 저장 → 리츠 (Nasdaq 업종을 모르는 종목도)
    await start({ value: fakeValueSources({ alias: { ZZREIT: "MSFT" }, sicOf: () => 6798 }), facts: ["ZZREIT"] });
    expect((await db.selectFrom("value_fundamentals").select("sic").where("code", "=", "ZZREIT").executeTakeFirst())?.sic).toBe(6798);
    expect((await get("ZZREIT")).body.value).toMatchObject({ status: "excluded", reason: { code: "reit" } });
  });

  it("한국 종목은 3단계까지 '계산 준비 중 — 한국 종목 가치 지표 점수는 다음 단계에서', SEC 요청 0건", async () => {
    const { value } = await start();
    const b = (await get("005930")).body;
    expect(b.value).toMatchObject({ status: "pending", label: "계산 준비 중", text: VALUE_STATUS_TEXT.kr });
    await app!.valueScores.idle();
    expect(value.calls.facts).toEqual([]);
  });

  it("SEC 목록에 없는 종목(외국 회사 등): 백그라운드 확인 뒤 '점수 없음 — SEC 재무제표를 찾지 못했습니다', 하루 동안 다시 묻지 않음", async () => {
    const { value } = await start();
    expect((await get("ZZNOF")).body.value.status).toBe("pending");
    await app!.valueScores.idle();
    clock = new Date(clock.getTime() + 61_000);
    expect((await get("ZZNOF")).body.value).toMatchObject({ status: "insufficient", label: "점수 없음", reason: { code: "notListed" } });
    clock = new Date(clock.getTime() + 3_600_000);
    await get("ZZNOF");
    await app!.valueScores.idle();
    expect(value.calls.facts).toEqual(["ZZNOF"]);
  });

  it("재무 받기 실패: '재무제표를 받지 못했습니다. 잠시 뒤 다시 계산합니다' (5분만 기억, 가치 기록 없음) — 30분 뒤 다시 받기", async () => {
    const value = fakeValueSources({ failFacts: new Set(["NVDA"]) });
    await start({ value, score: scoreSources({ registered: ["NVDA"] }) });
    await get("NVDA");
    await app!.valueScores.idle();
    clock = new Date(clock.getTime() + 61_000);
    const b = (await get("NVDA")).body;
    expect(b.value).toMatchObject({ status: "unavailable", reason: { code: "factsFailed", text: VALUE_STATUS_TEXT.factsFailed } });
    expect(value.calls.facts).toEqual(["NVDA"]);
    clock = new Date(clock.getTime() + 31 * 60_000);
    await get("NVDA");
    await app!.valueScores.idle();
    expect(value.calls.facts).toEqual(["NVDA", "NVDA"]);
  });

  it("지난 값: 재무를 36시간 넘게 새로 받지 못했으면 배지 '지난 값 M/D'·안내, 7일 넘으면 점수 없음 (백그라운드로 다시 받기)", async () => {
    const { value } = await start({ facts: ["MSFT"], value: fakeValueSources({ failFacts: new Set(["MSFT-never"]) }) });
    await db.updateTable("value_fundamentals").set({ fetched_at: "2026-09-25T09:00:00+09:00" }).where("code", "=", "MSFT").execute();
    const v = (await get("MSFT")).body.value;
    expect(v.status).toBe("ok");
    expect(v.badges).toContain("지난 값 9/25");
    expect(v.flags.find((f) => f.key === "carriedForward")?.text).toBe("재무 숫자는 9월 25일(금)에 받은 값입니다 (그 뒤 새로 받지 못함).");
    await app!.valueScores.idle();
    expect(value.calls.facts).toEqual(["MSFT"]); // 백그라운드로 다시 받음 (여기서는 받기 성공 → 다음 요청부터 새 값)
    await db.updateTable("value_fundamentals").set({ fetched_at: "2026-09-20T09:00:00+09:00" }).where("code", "=", "MSFT").execute();
    clock = new Date(clock.getTime() + 6 * 3_600_000 + 1);
    const w = (await get("MSFT")).body.value;
    expect(w).toMatchObject({ status: "unavailable", reason: { code: "factsFailed" } });
  });

  it("비교 기준이 14일 넘게 갱신되지 않으면 '점수 없음 — 비교 기준이 2주 넘게 갱신되지 않았습니다'", async () => {
    await start({ reference: { ...referenceData(), refDate: "2026-09-10" }, facts: ["NVDA"] });
    expect((await get("NVDA")).body.value).toMatchObject({ status: "insufficient", reason: { code: "referenceOld", text: VALUE_STATUS_TEXT.referenceOld } });
  });
});

describe("장 마감 뒤 · 주 1회 비교 기준", () => {
  it("뉴욕 17:30: 등록 미국 종목은 재무가 20시간 넘게 묵었으면 먼저 다시 받고(SEC), 가치 기록을 하루 한 줄 (kind 'value')", async () => {
    const { value } = await start({ score: scoreSources({ registered: ["NVDA", "MSFT", "005930", "SOXL"] }), facts: ["NVDA", "MSFT"], at: ny("2026-09-25T17:31:00") });
    await db.updateTable("value_fundamentals").set({ fetched_at: "2026-09-24T09:00:00+09:00" }).where("code", "=", "NVDA").execute();
    const r = await app!.indicatorScores.runDaily("US");
    expect(r).toMatchObject({ computed: 3, failed: 0 });
    expect(value.calls.facts.sort()).toEqual(["NVDA", "SOXL"]); // MSFT 는 방금 받아 그대로, SOXL 은 SEC 목록에 없음(하루 뒤 다시)
    const rows = await db.selectFrom("indicator_scores").select(["code", "kind", "status", "score_date"]).where("kind", "=", "value").orderBy("code").execute();
    expect(rows).toEqual([
      { code: "MSFT", kind: "value", status: "ok", score_date: "2026-09-25" },
      { code: "NVDA", kind: "value", status: "ok", score_date: "2026-09-25" },
    ]);
    const h = await app!.inject({ method: "GET", url: "/api/scores/NVDA/history?kind=value" });
    expect(h.json()).toMatchObject({ code: "NVDA", kind: "value", items: [{ date: "2026-09-25", status: "ok" }] });
    // 예전 모양 (추세 기록)은 그대로
    expect(Object.keys((await app!.inject({ method: "GET", url: "/api/scores/NVDA/history" })).json() as object)).toEqual(["code", "items"]);
  });

  it("비교 기준 만들기: 플래그가 켜져 있으면 7일 넘게 묵었을 때만(강제는 늘), 결과는 value_references 에 최근 3줄", async () => {
    const screener: ScreenerRow[] = Array.from({ length: 600 }, (_, k) => ({ symbol: `S${k}`, name: "", marketCap: k < 40 ? (k + 1) * 1e9 : null, sector: "Technology", industry: "Semiconductors" }));
    const tickers = new Map(screener.slice(0, 40).map((r, k) => [r.symbol, String(k + 1).padStart(10, "0")]));
    const frame = async (tag: { name: string }, period: string): Promise<FrameRow[]> =>
      ["NetIncomeLoss", "Assets", "StockholdersEquity"].includes(tag.name) && (period === "CY2025" || period === "CY2026Q2I")
        ? Array.from({ length: 40 }, (_, k) => ({ cik: k + 1, ...(period === "CY2025" ? { start: "2025-01-01" } : {}), end: period === "CY2025" ? "2025-12-31" : "2026-06-30", val: (k + 1) * 1e8 }))
        : [];
    const reference: ReferenceSources = { screener: async () => screener, tickers: async () => tickers, frame };
    await start({ value: fakeValueSources({ reference }) });
    (app!.valueScores as unknown as { deps: { referencePauseMs: number } }).deps.referencePauseMs = 0;
    expect(await app!.valueScores.buildReference()).toBe("fresh"); // 시험 기준(9/26)이 이틀 전
    expect(await app!.valueScores.buildReference({ force: true })).toBe("built");
    expect(app!.valueScores.lastBuild).toMatchObject({ ok: true, refDate: "2026-09-28" });
    const rows = await db.selectFrom("value_references").select(["ref_date", "method"]).orderBy("ref_date").execute();
    expect(rows).toEqual([
      { ref_date: "2026-09-26", method: "VALUE-1" },
      { ref_date: "2026-09-28", method: "VALUE-1" },
    ]);
    for (const d of ["2026-10-06", "2026-10-14"]) {
      clock = kst(`${d}T10:00:00`);
      expect(await app!.valueScores.buildReference()).toBe("built");
    }
    expect((await db.selectFrom("value_references").select("ref_date").orderBy("ref_date").execute()).map((r) => r.ref_date)).toEqual(["2026-09-28", "2026-10-06", "2026-10-14"]);
  });
});

describe("지난주 대비 바뀐 이유 (가치, 상세 카드만)", () => {
  const fam = (scores: number[]) => ["price", "quality", "health", "growth", "payout"].map((key, i) => ({ key, weight: [30, 25, 20, 15, 10][i]!, score: scores[i]!, valid: true, why: null, metrics: [] }));
  const core = (shown: number, scores: number[], extra: object = {}) => ({ status: "scored", result: { path: "general", status: "ok", score: shown, shown, band: "가운데쯤", coverageWeight: 100, families: fam(scores), reasons: [] }, avgPrice: 100, period: { end: "2026-07-26", filed: "2026-08-26", form: "10-Q", basis: "TTM" }, priceThrough: "2026-09-18", ...extra }) as never;
  it("화면 정수 차이가 5점 넘을 때만, 같은 쪽으로 움직인 묶음 가운데 비중 × 변화가 가장 큰 것 + 까닭(새 보고서 → 주가 → 비교 기준)", () => {
    expect(weeklyValueChange(core(60, [50, 60, 60, 60, 60]), core(56, [40, 60, 60, 60, 60]), "2026-09-26", "2026-09-26")).toBeNull();
    const price = weeklyValueChange(core(52, [30, 60, 60, 70, 60], { avgPrice: 110 }), core(60, [55, 60, 60, 60, 60], { avgPrice: 100 }), "2026-09-26", "2026-09-26")!;
    expect(price).toMatchObject({ diff: -8, family: "price", familyDiff: -25 });
    expect(price.text).toBe("지난주 9월 18일(금)보다 점수가 8점 낮아졌습니다. 가장 크게 바뀐 묶음은 주가 수준(−25점)이고, 최근 20거래일 평균 주가가 10.0% 올랐습니다.");
    const filing = weeklyValueChange(core(70, [60, 70, 70, 90, 60]), core(62, [60, 70, 70, 50, 60], { period: { end: "2026-04-26", filed: "2026-05-20", form: "10-Q", basis: "TTM" } }), "2026-09-26", "2026-09-26")!;
    expect(filing.cause).toBe("새 보고서(10-Q, 8월 26일(수) 제출)가 반영되었습니다.");
    const ref = weeklyValueChange(core(70, [60, 90, 70, 60, 60]), core(62, [60, 60, 70, 60, 60]), "2026-09-26", "2026-09-19")!;
    expect(ref.cause).toBe("비교 기준(업종 분포)이 9월 26일(토)에 새로 만들어졌습니다.");
  });
});

describe("종합 지표 규칙 (설계 5.4 조합표)", () => {
  const V = (status: string, score: number | null, priceThrough = "2026-09-25") => ({ status, score, asOf: { priceThrough } }) as never;
  const T = (status: string, score: number | null, code?: string) => ({ status, score, reason: code ? { code, text: "" } : null }) as never;
  it("둘 다 있고 같은 날이면 평균, 아니면 없음과 이유 (0점·50점으로 채우지 않음)", () => {
    expect(compositeOf(V("ok", 57), T("ok", 69), "2026-09-25")).toEqual({ status: "ok", score: 63, reason: null, text: "두 점수의 평균", gap: 12, gapNote: false, gapText: null });
    expect(compositeOf(V("partial", 56), T("ok", 69), "2026-09-25").score).toBe(63); // 62.5 → 63
    expect(compositeOf(V("ok", 30), T("ok", 62), "2026-09-25")).toMatchObject({ score: 46, gap: 32, gapNote: true, gapText: gapText(32) });
    expect(compositeOf(V("ok", 40), T("ok", 70), "2026-09-25")).toMatchObject({ gap: 30, gapNote: true });
    expect(compositeOf(V("ok", 41), T("ok", 70), "2026-09-25")).toMatchObject({ gap: 29, gapNote: false });
    expect(compositeOf(V("excluded", null), T("ok", 70), "2026-09-25")).toMatchObject({ status: "none", reason: "valueMissing", text: "없음 · 가치 지표 점수가 없어 합치지 않습니다" });
    expect(compositeOf(V("excluded", null), T("excluded", null, "leveraged"), "2026-09-25")).toMatchObject({ reason: "valueMissing" });
    expect(compositeOf(V("excluded", null), T("excluded", null, "inverse"), "2026-09-25")).toMatchObject({ reason: "bothMissing", text: "없음 · 두 점수가 모두 없습니다" });
    expect(compositeOf(V("ok", 60), T("hold", null), "2026-09-25")).toMatchObject({ reason: "trendMissing", text: "없음 · 추세 지표 점수가 없어 합치지 않습니다" });
    expect(compositeOf(V("ok", 60, "2026-09-24"), T("ok", 70), "2026-09-25")).toMatchObject({ reason: "dateMismatch", text: "없음 · 두 점수의 기준일이 달라 합치지 않았습니다" });
    expect(compositeOf(V("insufficient", null), T("ok", 70), "2026-09-25").reason).toBe("valueMissing");
  });
});

describe("문구 — 서버가 만드는 모든 가치·종합 문장", () => {
  it("예시 종목·대상 아님·점수 없음·지난 값·금융사 응답 전체에 걸리는 낱말이 없다", async () => {
    await start({ facts: [...US, "ZZGAP"] });
    const all: string[] = [];
    for (const c of [...US, "ZZGAP", "SOXL", "QQQ", "005930", "ZZNOF"]) all.push(...texts((await get(c)).body));
    await app!.valueScores.idle();
    clock = new Date(clock.getTime() + 61_000);
    all.push(...texts((await get("ZZNOF")).body));
    const bad = [...new Set(all.flatMap((t) => scoreWordingProblems(t).map((w) => `${w} ← ${t}`)))];
    expect(bad).toEqual([]);
  });
});

describe("DB·백업·출처", () => {
  it("마이그레이션 11: value_fundamentals · value_references, 백업 목록에 있고 JSON 백업에서 되살아난다", async () => {
    await start({ facts: ["MSFT"] });
    const versions = (await db.selectFrom("schema_version" as never).select("version" as never).execute()) as Array<{ version: number }>;
    expect(versions.map((v) => Number(v.version))).toContain(11);
    expect(BACKUP_TABLES).toContain("value_fundamentals");
    expect(BACKUP_TABLES).toContain("value_references");
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const t of ["value_fundamentals", "value_references"] as const) tables[t] = (await db.selectFrom(t).selectAll().execute()) as Record<string, unknown>[];
    const fresh = await createMigratedDb(":memory:");
    const out = await restoreBackup(fresh, "sqlite", { version: 1, createdAt: "x", tables });
    expect(out).toMatchObject({ value_fundamentals: 1, value_references: 1 });
    const row = await fresh.selectFrom("value_fundamentals").select(["code", "cik", "sic"]).executeTakeFirst();
    expect(row).toEqual({ code: "MSFT", cik: "0000789019", sic: 7372 });
  });

  it("SEC 출처: 기존 연락처 User-Agent 그대로, frames 가 없으면(404) 빈 목록, 큰 요청 사이 간격", async () => {
    const seen: Array<{ url: string; ua: string; at: number }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ua: String((init?.headers as Record<string, string>)["user-agent"]), at: Date.now() });
      if (url.includes("/frames/")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ "0": { cik_str: 789019, ticker: "MSFT", title: "Microsoft" } }), { status: 200 });
    }) as typeof fetch;
    const e = new EdgarProvider(fetchFn, () => new Date("2026-09-28T00:00:00Z"), { minGapMs: 60 });
    expect(await e.frameRaw("NetIncomeLoss", "USD", "CY2026")).toEqual({ data: [] });
    expect(await e.frameRaw("Assets", "USD", "CY2026Q2I")).toEqual({ data: [] });
    expect((await e.tickerMap()).get("MSFT")).toBe("0000789019");
    expect(seen[0]!.ua).toBe("stock-briefing/1.0 (personal use; contact: admin@stock-briefing.app)");
    expect(seen[0]!.url).toBe("https://data.sec.gov/api/xbrl/frames/us-gaap/NetIncomeLoss/USD/CY2026.json");
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(55);
  });

  it("Nasdaq 스크리너: 줄을 읽고, 200 이 아니면 오류 (지난 비교 기준을 그대로 쓰게)", async () => {
    const ok = new NasdaqScreener((async () => new Response(JSON.stringify({ data: { rows: [{ symbol: "NVDA", name: "N", marketCap: "1,000.00", sector: "Technology", industry: "Semiconductors" }] } }), { status: 200 })) as typeof fetch);
    expect(await ok.rows()).toEqual([{ symbol: "NVDA", name: "N", marketCap: 1000, sector: "Technology", industry: "Semiconductors" }]);
    const bad = new NasdaqScreener((async () => new Response("no", { status: 403 })) as typeof fetch);
    await expect(bad.rows()).rejects.toThrow(/HTTP 403/);
  });
});

/** 예시 종목 가치 지표 점수 (기록한 SEC 재무 · 2026-09-26 비교 기준을 줄인 것 · 야후 일봉/월봉). 식이나 자료를 바꾸면 값이 바뀐다 */
const EXPECTED_VALUE: Record<string, [number | null, string | null, string | null]> = {
  NVDA: [66, "가운데쯤", "general"],
  MSFT: [62, "가운데쯤", "general"],
  AAPL: [52, "가운데쯤", "general"],
  META: [66, "가운데쯤", "general"],
  JPM: [51, "가운데쯤", "financial"],
  RGTI: [36, "가운데쯤", "general"],
};
