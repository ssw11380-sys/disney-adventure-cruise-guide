import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildKrReference, KR_SOURCE, type KrMember } from "../src/analysis/krValue.js";
import { scoreWordingProblems } from "../src/analysis/scoreWording.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Candle } from "../src/domain/types.js";
import { BACKUP_TABLES } from "../src/services/backupService.js";
import { FEATURES } from "../src/services/featureService.js";
import type { ScoreSources, ScoresResponse, ScoreStock } from "../src/services/indicatorScoreService.js";
import { KR_LITE_NOTE, LITE_BADGE, VALUE_STATUS_TEXT } from "../src/services/valueScoreText.js";
import { benchOf, candlesOf } from "./fixtures/indicatorScores/load.js";
import { fakeKrSources, KR_CODES, KR_NAMES, krWorld, type KrCode } from "./fixtures/krValue/load.js";
import { fakeValueSources, referenceData } from "./fixtures/valueScores/load.js";
import { fakeProviders, valueStage1 } from "./helpers.js";

/**
 * 한국 간이 가치 (3-44 3단계, 플래그 indicatorScores + valueScore + krValueScore): GET /api/scores/:code 의 한국 가치·종합,
 * 재무 요약 받기(백그라운드·밤 배치 — 분기에 한 번 돌아가며), 비교 기준(일요일 새벽), 첫 채우기, 대상 아님, 플래그 끔.
 * 네트워크 없음 — 네이버 재무 요약·일봉은 기록한 공개 자료(test/fixtures/krValue · indicatorScores), 비교 회사는 합성(krWorld), 시계는 고정.
 * 기본 시계 2026-09-28(월) 10:00 KST → 한국 가격 기준일 9/23(수) (9/24~25 추석 휴장)
 */

const kst = (s: string) => new Date(`${s}+09:00`);
const STOCKS: Record<string, ScoreStock> = {
  ...Object.fromEntries(KR_CODES.map((c) => [c, { code: c, name: KR_NAMES[c], market: "KOSPI" }])),
  "005935": { code: "005935", name: "삼성전자우", market: "KOSPI" },
  "069500": { code: "069500", name: "KODEX 200", market: "KOSPI", groupCode: "EF" },
  "123450": { code: "123450", name: "하나30호스팩", market: "KOSDAQ" },
  "999990": { code: "999990", name: "예시 새내기", market: "KOSPI" },
  NVDA: { code: "NVDA", name: "엔비디아", market: "NASDAQ" },
};
const CANDLES: Record<string, string> = { "005930": "005930.KS", "000660": "000660.KS", "035420": "035420.KS", "105560": "105560.KS" };

function scoreSources(over: { registered?: string[] } = {}) {
  const src: ScoreSources = {
    stock: async (code) => STOCKS[code] ?? null,
    candles: async (code, count) => {
      const cs: Candle[] = candlesOf(CANDLES[code] ?? (code === "NVDA" ? "NVDA" : "005930.KS"));
      return { code, period: "D", candles: cs.slice(-count), source: "naver" };
    },
    benchmark: async (code) => (code === "KOSPI" ? benchOf("005930.KS") : code === "NASDAQ" ? benchOf("NVDA") : null),
    product: async () => null,
    registered: async () => (over.registered ?? []).map((c) => STOCKS[c]!),
    monthly: async () => null,
  };
  return src;
}

let app: FastifyInstance | null = null;
let db: Db;
let clock = kst("2026-09-28T10:00:00");
const logs: Array<{ msg: string; obj: Record<string, unknown> }> = [];
afterEach(async () => {
  await app?.close();
  app = null;
  logs.length = 0;
});

/** 합성 비교 회사 가운데 픽스처에 없는 코드는 원래 종목 재무로 (비교 회사 복제) */
const aliasAll = () => Object.fromEntries(krWorld().members.filter((m) => /^9\d{5}$/.test(m.code)).map((m) => [m.code, KR_CODES[Math.floor((Number(m.code) - 900000) / 1000)]!] as const)) as Record<string, KrCode>;

async function start(opts: { members?: KrMember[]; registered?: string[]; failFinance?: Set<string>; kr?: boolean; reference?: boolean; facts?: string[]; nightCap?: number } = {}) {
  clock = kst("2026-09-28T10:00:00");
  db = await createMigratedDb(":memory:");
  const world = krWorld();
  const kr = fakeKrSources({ members: opts.members ?? world.members, ...(opts.failFinance ? { failFinance: opts.failFinance } : {}), alias: aliasAll() });
  app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ scoreSources: scoreSources({ registered: opts.registered ?? [] }), valueSources: fakeValueSources().src, krValueSources: kr.src }), logger: false, enableScheduler: false, now: () => clock });
  const deps = (app.krValue as unknown as { deps: { log: unknown; nightCap?: number; minMembers?: number } }).deps;
  deps.log = { info: (obj: Record<string, unknown>, msg: string) => logs.push({ msg, obj }), warn: (obj: Record<string, unknown>, msg: string) => logs.push({ msg, obj }) };
  // 합성 세상은 보통주 161곳 (실제 2,765)
  deps.minMembers = 100;
  if (opts.nightCap) (app.krValue as unknown as { deps: { nightCap?: number } }).deps.nightCap = opts.nightCap;
  // 이 파일은 3단계 글을 본다 — 가치 점수 개선 1단계 글 플래그는 끈 채 (끄면 지금과 같음을 함께 확인). 새 글은 valueImprove1.test.ts
  await app.inject({ method: "PUT", url: "/api/admin/features", payload: { ...valueStage1(false), ...(opts.kr === false ? { krValueScore: false } : {}) } });
  if (opts.reference !== false) {
    // 일요일 새벽 비교 기준 (합성 비교 회사 · 기록한 재무)
    await app.krValue.saveReference(buildKrReference(world.members, world.facts, "2026-09-27"));
  }
  for (const c of opts.facts ?? []) await app.krValue.refreshFacts(c);
  kr.calls.finance.length = 0;
  kr.calls.summary.length = 0;
  return kr;
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

describe("플래그 krValueScore (서버 기본 켜짐 — 끄면 한국만 2단계 그대로)", () => {
  it("플래그 목록에 있고 기본 켜짐", () => {
    expect(FEATURES.krValueScore.default).toBe(true);
    expect(FEATURES.krValueScore.description).toMatch(/간이 계산/);
  });
  it("끄면 한국 가치 줄은 '지금 계산하지 않음'(종합 없음) · 네이버 재무 요청 0건 · 밤 배치도 아무것도 안 함 · 미국 가치는 그대로", async () => {
    const kr = await start({ kr: false });
    const b = (await get("005930")).body;
    expect(b.value).toMatchObject({ status: "pending", label: "지금 계산하지 않음", reason: { code: "krOff", text: VALUE_STATUS_TEXT.krOff }, grade: null });
    expect(b.composite).toMatchObject({ status: "none", reason: "valueMissing" });
    expect(b.text.how.join(" ")).toContain("한국 종목 가치 지표 점수는 지금 계산하지 않습니다.");
    expect(await app!.krValue.nightly()).toMatchObject({ skipped: "off" });
    await app!.krValue.idle();
    expect(kr.calls.finance).toEqual([]);
    expect(kr.calls.members).toBe(0);
  });
});

describe("한국 간이 가치 점수 (요약 카드 · 가치분석 탭이 쓰는 모양)", () => {
  it("삼성전자: 재무를 처음 받는 중(백그라운드, 앱은 1분마다 다시) → 받은 뒤 점수·띠·'간이 계산' 배지·날짜 줄·종합", async () => {
    const kr = await start();
    const first = (await get("005930")).body;
    expect(first.value).toMatchObject({ status: "pending", label: "계산 준비 중", reason: { code: "pendingFacts", text: VALUE_STATUS_TEXT.krPendingFacts } });
    await app!.krValue.idle();
    // 대상 종목은 요약 지표까지 세 번 (교차 점검 · 업종 번호)
    expect(kr.calls.finance).toEqual(["005930"]);
    expect(kr.calls.summary).toEqual([true]);
    clock = new Date(clock.getTime() + 61_000);
    const b = (await get("005930")).body;
    const v = b.value;
    expect(v).toMatchObject({ status: "ok", grade: "lite", path: "general", badges: [LITE_BADGE] });
    expect(v.score).toEqual(expect.any(Number));
    expect(v.label).toBe(`${v.score}점 · ${v.band}`);
    expect(v.about).toBe("재무 숫자가 같은 업종·한국 시장 회사들 사이 어디쯤인지");
    expect(b.text.valueAbout).toBe(v.about);
    expect(v.peerLine).toMatch(/^같은 업종\(반도체와반도체장비, \d+개 회사\)·한국 시장과 비교해, 재무 숫자가 어디쯤인지 정해진 규칙으로 계산한 위치입니다\.$/);
    expect(v.datesLine).toBe("주가 9월 23일(수)까지 20거래일 평균 · 재무 2026년 6월까지 최근 4분기(네이버 재무 요약) · 비교 기준 9월 27일(일)");
    expect(v.asOf).toMatchObject({ priceThrough: "2026-09-23", fiscalEnd: "2026-06-30", basis: "TTM", fiscalShort: "재무 2026년 6월까지 4분기", reference: "2026-09-27", filed: null });
    expect(b.asOf.line).toBe("가격 9월 23일(수) 한국 종가 · 재무 2026년 6월까지 4분기");
    expect(v.notes).toContain(KR_LITE_NOTE);
    expect(v.versionLine).toBe("계산 방식 VALUE-1 간이(한국) · 재무 네이버 증권 재무 요약(실적 열만) · 업종 분류 네이버 · 비교 기준 9월 27일(일)");
    expect(v.families.map((f) => [f.key, f.metrics.map((m) => m.key)])).toEqual([
      ["price", ["A1", "A3", "A4"]],
      ["quality", ["B1", "B4"]],
      ["health", ["D1", "D5"]],
      ["growth", ["C1", "C2", "C3"]],
      ["payout", ["E1"]],
    ]);
    // 자기 지난 5년 비교 없이 업종 71 · 한국 시장 29 (무리 이름은 설명 줄·머리 문장처럼 '한국 시장')
    expect(v.families[0]!.metrics[0]!.mix).toBe("업종 71 · 한국 시장 29");
    expect(v.families[0]!.metrics[0]!.positions).toMatch(/^업종 안 위치 \d+\/100 · 한국 시장 안 \d+\/100$/);
    expect(v.families.find((f) => f.key === "payout")!.about).toBe("높을수록 주가에 비해 배당이 많은 편");
    // 종합: 보이는 두 정수의 평균 (두 가격 기준일이 같음)
    expect(b.trend.status).toBe("ok");
    expect(b.composite).toMatchObject({ status: "ok", score: Math.floor((v.score! + b.trend.score!) / 2 + 0.5) });
    // 구성·계산 방법: 한국은 간이 계산 · 미국과 견주지 않음
    expect(b.text.how.join(" ")).toMatch(/네이버 증권 재무 요약.*간이 계산/);
    expect(b.text.how.join(" ")).toMatch(/서로의 가치 지표 점수를 견주지 않습니다/);
    expect(texts(b).flatMap((t) => scoreWordingProblems(t).map((w) => `${w} ← ${t}`))).toEqual([]);
  });

  it("KB금융: 은행 업종 → 금융사 경로(금융사끼리, 비중 35·30·10·15·10), 설명 줄 '업종·한국 금융사 전체'", async () => {
    await start({ facts: ["105560"] });
    const v = (await get("105560")).body.value;
    expect(v).toMatchObject({ status: "ok", grade: "lite", path: "financial", about: "재무 숫자가 같은 업종·한국 금융사 전체 회사들 사이 어디쯤인지" });
    expect(v.families.map((f) => f.weight)).toEqual([35, 30, 10, 15, 10]);
    expect(v.flags.map((f) => f.key)).toContain("financial");
    expect(JSON.stringify(v.families)).not.toMatch(/시장 안/);
    // 지표 줄의 무리 이름도 '한국 금융사 전체' (가운데값 · 위치 · 비중)
    const rows = v.families.flatMap((f) => f.metrics).filter((m) => m.used);
    expect(rows.every((m) => /한국 금융사 전체/.test(`${m.mix}`))).toBe(true);
    expect(JSON.stringify(v.families)).not.toMatch(/(?<!한국 )금융사 전체/);
  });

  it("다시 받을 때 네이버 표에서 빠진 앞 결산·분기는 이어 둔다 (저장한 줄 + 새 줄 — 1~3월 성장 묶음이 빠지지 않게)", async () => {
    await start({ facts: ["005930"] });
    const read = async () => JSON.parse((await db.selectFrom("value_fundamentals").select("data").where("code", "=", "005930").executeTakeFirstOrThrow()).data) as { a: Array<[string]>; q: Array<[string]> };
    const before = await read();
    // 저장한 줄에 표에 없는 앞 결산(2022)·분기(2025.03)를 넣어 두면 다시 받아도 남는다
    const first = before.a[0]!;
    const q0 = before.q[0]!;
    await db.updateTable("value_fundamentals").set({ data: JSON.stringify({ ...before, a: [["2022-12", ...first.slice(1)], ...before.a], q: [["2025-03", ...q0.slice(1)], ...before.q] }), fetched_at: "2026-09-01T00:00:00+09:00" }).where("code", "=", "005930").execute();
    expect(await app!.krValue.refreshFacts("005930", { summary: false })).toBe("ok");
    const after = await read();
    expect(after.a.map((r) => r[0])).toEqual(["2022-12", "2023-12", "2024-12", "2025-12"]);
    expect(after.q.map((r) => r[0])).toEqual(["2025-03", "2025-06", "2025-09", "2025-12", "2026-03", "2026-06"]);
  });

  it("대상 아님: 우선주(코드 끝) · 스팩(이름) · ETF — 네이버 재무 요청 없이", async () => {
    const kr = await start();
    expect((await get("005935")).body.value).toMatchObject({ status: "excluded", label: "대상 아님", reason: { code: "preferred" } });
    expect((await get("123450")).body.value).toMatchObject({ status: "excluded", reason: { code: "spac" } });
    expect((await get("069500")).body.value).toMatchObject({ status: "excluded", reason: { code: "etf" } });
    await app!.krValue.idle();
    expect(kr.calls.finance).toEqual([]);
  });

  it("네이버에 재무 요약이 없는 종목: 백그라운드 확인 뒤 '점수 없음 — 네이버 재무 요약을 찾지 못했습니다', 하루 동안 다시 묻지 않음", async () => {
    const kr = await start();
    expect((await get("999990")).body.value.status).toBe("pending");
    await app!.krValue.idle();
    clock = new Date(clock.getTime() + 61_000);
    expect((await get("999990")).body.value).toMatchObject({ status: "insufficient", reason: { code: "notListed", text: VALUE_STATUS_TEXT.krNotFound } });
    clock = new Date(clock.getTime() + 3_600_000);
    await get("999990");
    await app!.krValue.idle();
    expect(kr.calls.finance).toEqual(["999990"]);
  });

  it("받기 실패: '재무제표를 받지 못했습니다' (5분만 기억, 기록 안 함)", async () => {
    await start({ failFinance: new Set(["000660"]) });
    await get("000660");
    await app!.krValue.idle();
    clock = new Date(clock.getTime() + 61_000);
    expect((await get("000660")).body.value).toMatchObject({ status: "unavailable", reason: { code: "factsFailed" } });
  });

  it("교차 점검: 받을 때 네이버가 보이는 PER·PBR 과 같은 가격으로 견주어 20% 안이면 조용히, 넘으면 경고 기록", async () => {
    await start({ facts: ["005930", "105560"] });
    expect(logs.filter((l) => /20% 넘게/.test(l.msg))).toEqual([]);
  });
});

describe("비교 기준 · 첫 채우기 · 밤 배치 (고정 시계)", () => {
  it("비교 기준이 없고 비교 회사 재무가 60% 에 못 미치면: '비교할 한국 회사 재무를 처음 모으는 중 · 지금 n%' (앱이 다시 묻지 않는 끝나는 상태)", async () => {
    await start({ reference: false, facts: ["005930"] });
    await app!.krValue.members();
    const v = (await get("005930")).body.value;
    expect(v).toMatchObject({ status: "pending", label: "계산 준비 중", reason: { code: "krFirstFill" } });
    expect(v.reason!.text).toMatch(/^비교할 한국 회사 재무를 처음 모으는 중입니다 \(밤마다 나눠 받아 며칠 걸립니다 · 지금 \d+%\)$/);
  });

  it("밤 배치: 받을 때가 된 종목(받은 적 없음 먼저 · 시가총액 큰 순)을 상한까지, 비교 회사는 두 번씩(요약 지표 없이), 재무가 모이면 비교 기준을 만든다", async () => {
    const kr = await start({ reference: false, nightCap: 70 });
    const r1 = await app!.krValue.nightly({ registered: ["005930"] });
    expect(r1).toMatchObject({ fetched: 70, failed: 0, built: "filling" });
    expect(kr.calls.summary.every((s) => s === false)).toBe(true);
    // 첫 순서: 등록 종목 · 시가총액 큰 순 (후보 목록)
    expect(kr.calls.finance.slice(0, 3)).toEqual(["005930", "000660", "005380"]);
    expect(app!.krValue.lastBuild).toMatchObject({ ok: false, filling: true });
    const fill1 = await app!.krValue.fillStatus();
    expect(fill1.ratio).toBeLessThan(0.6);
    // 다음 밤: 남은 후보를 마저 받고 → 60% 넘으면 비교 기준
    clock = kst("2026-09-29T02:30:00");
    const r2 = await app!.krValue.nightly();
    expect(r2.built).toBe("built");
    expect((await app!.krValue.reference())!.refDate).toBe("2026-09-29");
    // 사흘째: 받을 때가 된 종목 없음 (새 분기 11/17 전)
    clock = kst("2026-09-30T02:30:00");
    kr.calls.finance.length = 0;
    expect(await app!.krValue.nightly()).toMatchObject({ due: 0, fetched: 0 });
    expect(kr.calls.finance).toEqual([]);
    // 저장 모양: value_fundamentals, cik 칸 'naver' (새 표 없음 — 백업 목록 그대로)
    const row = await db.selectFrom("value_fundamentals").select(["cik", "sic", "last_filed"]).where("code", "=", "005930").executeTakeFirstOrThrow();
    expect(row).toEqual({ cik: KR_SOURCE, sic: null, last_filed: "2026-06" });
    expect(BACKUP_TABLES).toEqual(expect.arrayContaining(["value_fundamentals", "value_references"]));
  });

  it("업종 구성 종목은 meta 에 저장해 두고 8일 안이면 다시 받지 않는다 · 일요일 새벽(force)은 새로 받는다", async () => {
    const kr = await start();
    await app!.krValue.members();
    await app!.krValue.members();
    expect(kr.calls.members).toBe(1);
    clock = kst("2026-10-04T05:00:00");
    await app!.krValue.buildReference({ force: true });
    expect(kr.calls.members).toBe(2);
  });

  it("미국 재무 정리(30일)는 한국 행을 지우지 않는다 — 한국은 후보에서 빠진 종목만 따로 정리", async () => {
    await start({ facts: ["005930", "105560"] });
    await app!.krValue.members();
    clock = kst("2026-11-15T09:15:00");
    expect(await app!.valueScores.prune([])).toBe(0);
    expect(await app!.krValue.prune([])).toBe(0);
    const w = krWorld();
    // 목록에서 빠지면(상장 폐지 등) 30일 넘은 줄을 지운다
    await db.updateTable("meta").set({ value: JSON.stringify({ date: "2026-11-15", rows: w.members.filter((m) => m.code !== "105560").map((m) => [m.code, m.name, m.market, m.endType, m.price, m.marketCap, m.upjong, m.upjongCode]) }) }).where("key", "=", "krValueMembers").execute();
    expect(await app!.krValue.prune([])).toBe(1);
    expect(await app!.krValue.prune(["005930"])).toBe(0);
  });

  it("등록 한국 종목은 장 마감 뒤(20:10) 계산 전에 20시간 넘게 묵었으면 다시 받고, 하루 기록(kind value)에 등급 lite 로 남는다", async () => {
    const kr = await start({ registered: ["005930"], facts: ["005930"] });
    clock = kst("2026-09-30T20:15:00");
    await app!.indicatorScores.runDaily("KR");
    expect(kr.calls.finance).toEqual(["005930"]);
    const rows = await db.selectFrom("indicator_scores").select(["code", "kind", "status", "data"]).where("kind", "=", "value").execute();
    expect(rows.map((r) => [r.code, r.status])).toEqual([["005930", "ok"]]);
    expect(JSON.parse(rows[0]!.data)).toMatchObject({ grade: "lite", quarter: "2026-06", reference: "2026-09-27" });
  });
});
