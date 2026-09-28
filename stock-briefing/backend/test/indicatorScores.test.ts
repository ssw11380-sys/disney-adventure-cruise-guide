import { readFileSync, writeFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { leverageFacts } from "../src/analysis/leveraged.js";
import { scoreWordingProblems } from "../src/analysis/scoreWording.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Candle } from "../src/domain/types.js";
import { parseProductFacts } from "../src/providers/market/toss.js";
import { BACKUP_TABLES, restoreBackup } from "../src/services/backupService.js";
import { FEATURES } from "../src/services/featureService.js";
import type { TrendShown } from "../src/analysis/trendScore.js";
import { dailyRunDue, latestScoreDate, weeklyChange, type ScoreSources, type ScoresResponse, type ScoreStock } from "../src/services/indicatorScoreService.js";
import { benchFetchFailed, changeText, DISTRIBUTION_NOTE, howLines, leverageBox, STATUS_TEXT, trendNoteText, trendReasonText, underlyingFetchFailed } from "../src/services/indicatorScoreText.js";
import { benchOf, candlesOf, expected, tossInfo } from "./fixtures/indicatorScores/load.js";
import { dailyOf, fakeValueSources, monthlyOf, referenceData } from "./fixtures/valueScores/load.js";
import type { ValueSources } from "../src/services/valueScoreService.js";
import { fakeProviders } from "./helpers.js";

/**
 * 지표 점수 1단계 (3-44, 플래그 indicatorScores): GET /api/scores/:code · 장 마감 뒤 미리 계산·기록 · 레버리지 처리 · 문구.
 * 네트워크 없음 — 일봉은 기록한 야후 공개 일봉(test/fixtures/indicatorScores), 상품 정보는 기록한 토스 웹 응답, 시계는 고정.
 * 미국 9/25(금) · 한국 9/23(수, 9/24~25 추석 휴장) 종가가 마지막 봉이다
 */

const kst = (s: string) => new Date(`${s}+09:00`);
const ny = (s: string, dst = true) => new Date(`${s}${dst ? "-04:00" : "-05:00"}`);

const STOCKS: Record<string, ScoreStock> = {
  NVDA: { code: "NVDA", name: "엔비디아", market: "NASDAQ" },
  MSFT: { code: "MSFT", name: "마이크로소프트", market: "NASDAQ" },
  AAPL: { code: "AAPL", name: "애플", market: "NASDAQ" },
  AVGO: { code: "AVGO", name: "브로드컴", market: "NASDAQ" },
  META: { code: "META", name: "메타", market: "NASDAQ" },
  TSLA: { code: "TSLA", name: "테슬라", market: "NASDAQ" },
  PLTR: { code: "PLTR", name: "팔란티어", market: "NASDAQ" },
  QQQ: { code: "QQQ", name: "Invesco QQQ Trust", market: "NASDAQ", groupCode: "EF" },
  SOXX: { code: "SOXX", name: "iShares Semiconductor ETF", market: "NASDAQ", groupCode: "EF" },
  RGTI: { code: "RGTI", name: "리게티 컴퓨팅", market: "NASDAQ" },
  SOXL: { code: "SOXL", name: "SOXL", market: "AMEX", groupCode: "EF" },
  RGTX: { code: "RGTX", name: "RGTX", market: "NASDAQ", groupCode: "EF" },
  SQQQ: { code: "SQQQ", name: "ProShares UltraPro Short QQQ", market: "NASDAQ", groupCode: "EF" },
  "005930": { code: "005930", name: "삼성전자", market: "KOSPI" },
  "000660": { code: "000660", name: "SK하이닉스", market: "KOSPI" },
  "035420": { code: "035420", name: "NAVER", market: "KOSPI" },
  // 2단계 공용 픽스처 (가치 지표): 은행 · 예시 종목
  JPM: { code: "JPM", name: "JP모건 체이스", market: "NYSE" },
  ZZGAP: { code: "ZZGAP", name: "예시 종목 (두 점수 차이 큼)", market: "NASDAQ" },
  ZZNOF: { code: "ZZNOF", name: "예시 종목 (SEC 재무 없음)", market: "NASDAQ" },
};
const FIX_SYM = (code: string) => (/^\d{6}$/.test(code) ? `${code}.KS` : code);

/** 기록한 일봉으로 만든 자료 묶음. 받은 횟수를 센다 */
function fixtureSources(
  over: {
    candles?: Record<string, Candle[] | Error | (() => Candle[] | Error)>;
    bench?: Record<string, Candle[] | Error | null | (() => Candle[] | Error | null)>;
    product?: Record<string, ReturnType<typeof parseProductFacts> | null>;
    registered?: string[];
    stocks?: Record<string, ScoreStock>;
  } = {},
) {
  const calls = { stock: 0, candles: [] as string[], benchmark: [] as string[], product: 0, registered: 0, fresh: [] as string[] };
  const stocks = { ...STOCKS, ...over.stocks };
  const src: ScoreSources = {
    stock: async (code) => {
      calls.stock++;
      return stocks[code] ?? null;
    },
    candles: async (code, count, opts) => {
      calls.candles.push(code);
      if (opts?.fresh) calls.fresh.push(code);
      const raw = over.candles?.[code];
      const o = typeof raw === "function" ? raw() : raw;
      if (o instanceof Error) throw o;
      const cs = o ?? (code === "JPM" ? dailyOf("JPM") : candlesOf(FIX_SYM(code === "ZZGAP" ? "NVDA" : code === "ZZNOF" ? "AAPL" : code)));
      return { code, period: "D", candles: cs.slice(-count), source: "yahoo" };
    },
    benchmark: async (code) => {
      calls.benchmark.push(code);
      if (over.bench && code in over.bench) {
        const raw = over.bench[code];
        const o = typeof raw === "function" ? raw() : raw;
        if (o instanceof Error) throw o;
        return o ?? null;
      }
      return code === "NASDAQ" ? benchOf("NVDA") : code === "KOSPI" ? benchOf("005930.KS") : code === "SPX" ? dailyOf("SPX") : null;
    },
    product: async (code) => {
      calls.product++;
      if (over.product && code in over.product) return over.product[code]!;
      return code === "SOXL" || code === "RGTX" || code === "MSFT" ? parseProductFacts(JSON.parse(JSON.stringify(TOSS[code]))) : null;
    },
    registered: async () => {
      calls.registered++;
      return (over.registered ?? []).map((c) => stocks[c]!);
    },
    monthly: async (code) => monthlyOf(code === "ZZGAP" ? "NVDA" : code),
  };
  return { src, calls };
}
const TOSS = { SOXL: tossInfo("SOXL"), RGTX: tossInfo("RGTX"), MSFT: tossInfo("MSFT") } as Record<string, Record<string, unknown>>;

let app: FastifyInstance | null = null;
let db: Db;
let clock = kst("2026-09-28T10:00:00");
afterEach(async () => {
  await app?.close();
  app = null;
});

/** 서버 기본은 켜짐 — on: false 면 PUT 없이 기본값 그대로 */
async function start(sources: ScoreSources, at = kst("2026-09-28T10:00:00"), on = true, valueSources?: ValueSources) {
  clock = at;
  db = await createMigratedDb(":memory:");
  app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ scoreSources: sources, ...(valueSources ? { valueSources } : {}) }), logger: false, enableScheduler: false, now: () => clock });
  if (on) await app.inject({ method: "PUT", url: "/api/admin/features", payload: { indicatorScores: true } });
  return app;
}
const rowsOf = async () => db.selectFrom("indicator_scores").select(["code", "score_date", "status", "score", "data"]).orderBy("code").orderBy("score_date").execute();
const get = async (code: string) => {
  const r = await app!.inject({ method: "GET", url: `/api/scores/${code}` });
  return { status: r.statusCode, body: r.json() as ScoresResponse & { error?: string; message?: string } };
};

/** 응답 안의 모든 글 (문구 검사용) */
function texts(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(texts);
  if (v && typeof v === "object") return Object.values(v).flatMap(texts);
  return [];
}

describe("플래그", () => {
  it("서버 기본 켜짐 (나눠 켜기 1단계 추세부터 — 앱에 켜고 끄는 화면이 없어서), 설명에 '끄면 … 0건'", () => {
    expect(FEATURES.indicatorScores.default).toBe(true);
    expect(FEATURES.indicatorScores.description).toMatch(/끄면 .*0건/);
  });

  it("기본값 그대로인 새 서버: 따로 켜지 않아도 /api/scores 200", async () => {
    const { src } = fixtureSources({ registered: ["NVDA"] });
    await start(src, ny("2026-09-25T17:31:00"), false);
    expect((await get("NVDA")).status).toBe(200);
  });

  it("끄면 /api/scores 는 404 이고 계산·일봉·지수·상품 정보 요청이 0건, 장 마감 뒤 예약도 아무것도 하지 않는다", async () => {
    const { src, calls } = fixtureSources({ registered: ["NVDA", "SOXL"] });
    await start(src, ny("2026-09-25T17:31:00"));
    await app!.inject({ method: "PUT", url: "/api/admin/features", payload: { indicatorScores: false } });
    const r = await get("NVDA");
    expect(r.status).toBe(404);
    expect(r.body.message).toBe("지표 점수 기능이 꺼져 있습니다");
    expect((await app!.inject({ method: "GET", url: "/api/scores/NVDA/history" })).statusCode).toBe(404);
    expect(await app!.indicatorScores.runDaily("US")).toEqual({ computed: 0, failed: 0, skipped: "off" });
    expect(calls).toEqual({ stock: 0, candles: [], benchmark: [], product: 0, registered: 0, fresh: [] });
    expect(await db.selectFrom("indicator_scores").selectAll().execute()).toEqual([]);
    // 다시 켜면 바로
    await app!.inject({ method: "PUT", url: "/api/admin/features", payload: { indicatorScores: true } });
    expect((await get("NVDA")).status).toBe(200);
  });
});

describe("GET /api/scores/:code — 보통 종목", () => {
  it("NVDA (월 10:00 KST = 뉴욕 일요일 → 마지막 봉 9/25 금): 추세 69 다소 강함, 가치는 계산 준비 중, 종합 없음", async () => {
    const { src } = fixtureSources();
    await start(src);
    const { status, body } = await get("NVDA");
    expect(status).toBe(200);
    expect(body.asOf).toEqual({ priceDate: "2026-09-25", scoreDate: "2026-09-25", market: "US", line: "가격 9월 25일(금) 미국 종가" });
    const t = body.trend;
    expect(t).toMatchObject({ status: "ok", label: "다소 강함", score: 69, band: "다소 강함", daysAveraged: 5, bars: 300, benchmark: { code: "NASDAQ", name: "나스닥" }, candleSource: "yahoo", reason: null, change: null, reference: null, leveraged: null });
    expect(Math.abs(t.scoreExact! - expected.trend["NVDA"]!.score)).toBeLessThan(1e-9);
    expect(t.headline).toBe("추세 지표 점수 69/100 · 다소 강함");
    expect(t.meaning).toBe("최근 1년 가격·거래량 흐름의 방향과 세기: 상승 쪽 지표가 조금 더 많습니다.");
    expect(t.basisLine).toBe("9월 25일(금) 미국 정규장 종가까지의 가격·거래량으로 정해진 식에 따라 계산했습니다.");
    expect(t.families.map((f) => [f.name, f.weight, f.score])).toEqual([
      ["추세", 35, 69],
      ["모멘텀", 35, 64],
      ["단기 균형", 10, 100],
      ["가격 안정성", 10, 67],
      ["거래량 뒷받침", 10, 54],
    ]);
    // 설계서 11.8 렌더링 예와 같은 사실 문장
    expect(t.families.map((f) => f.text)).toEqual([
      "주가가 200일 이동평균선보다 12.8% 위, 50일선보다 4.2% 위에 있습니다. 50일선은 200일선보다 8.3% 위이고, 200일선은 한 달 전보다 2.0% 올랐습니다.",
      "최근 1개월을 뺀 12개월 동안 +18.5%, 6개월 동안 +22.4% 움직였습니다. 같은 12개월 동안 나스닥보다 2.3%p 높습니다.",
      "RSI 55(중립 구간), 볼린저 밴드 안 위치 65%, 50일선과의 거리는 평소 흔들림의 0.4배입니다. 단기 지표가 모두 보통 범위입니다.",
      "최근 3개월 변동성은 연 39%로 큰 편입니다. 52주 최고 종가보다 4.5% 아래에 있고, 최근 1년 가장 크게 떨어진 폭은 20.2%였습니다.",
      "최근 50거래일 동안 오른 날 거래량이 내린 날의 1.11배입니다. 최근 20일 평균 거래량은 120일 평균의 0.82배입니다.",
    ]);
    expect(t.families[0]!.items.map((i) => [i.key, i.score])).toEqual([
      ["T1", 72],
      ["T2", 66],
      ["T3", 69],
      ["T4", 67],
    ]);
    expect(t.versionLine).toBe("계산 방식 TREND-1 (보정 TREND-CAL-1) · 일봉 야후 · 비교 지수 나스닥(네이버)");
    expect(body.value).toMatchObject({ status: "pending", label: "계산 준비 중", score: null });
    expect(body.composite).toMatchObject({ status: "none", score: null, reason: "valueMissing", text: "없음 · 가치 지표 점수가 없어 합치지 않습니다" });
    expect(body.text.notForecast).toBe("점수는 과거·현재 숫자의 요약이며, 앞으로의 가격을 알려 주지 않습니다.");
    expect(body.text.disclaimerShort).toBe("참고 정보이며 투자 권유가 아닙니다");
  });

  it("예시 13종목의 화면 정수·띠가 설계서 13장과 같다", async () => {
    const { src } = fixtureSources();
    await start(src);
    const got: Record<string, string> = {};
    for (const c of ["NVDA", "MSFT", "AAPL", "AVGO", "META", "TSLA", "PLTR", "QQQ", "SOXX", "RGTI", "005930", "000660", "035420"]) {
      const b = (await get(c)).body;
      got[c] = `${b.trend.score} ${b.trend.band} ${b.trend.families.map((f) => f.score).join("/")}`;
    }
    expect(got).toEqual({
      NVDA: "69 다소 강함 69/64/100/67/54",
      MSFT: "68 다소 강함 70/63/97/55/67",
      AAPL: "76 강함 81/72/97/79/48",
      AVGO: "52 중립 46/50/100/44/44",
      META: "54 중립 67/33/58/59/75",
      TSLA: "43 다소 약함 43/34/96/35/38",
      PLTR: "62 다소 강함 66/56/95/40/57",
      QQQ: "73 강함 79/71/84/87/34",
      SOXX: "73 강함 79/77/86/50/54",
      RGTI: "42 다소 약함 40/37/97/2/55",
      "005930": "68 다소 강함 69/74/94/30/53",
      "000660": "68 다소 강함 70/78/98/20/46",
      "035420": "46 중립 36/41/90/33/68",
    });
  });

  it("일반 ETF(QQQ): 추세는 본인 봉으로, 가치는 대상 아님", async () => {
    const { src } = fixtureSources();
    await start(src);
    const b = (await get("QQQ")).body;
    expect(b.trend.status).toBe("ok");
    expect(b.value).toMatchObject({ status: "excluded", label: "대상 아님", text: "ETF는 여러 종목을 묶은 상품이라, 한 회사의 재무로 계산하는 이 점수를 내지 않습니다." });
  });

  it("모르는 종목은 404, 잘못된 코드는 400", async () => {
    const { src } = fixtureSources();
    await start(src);
    expect((await get("ZZZZ")).status).toBe(404);
    expect((await app!.inject({ method: "GET", url: "/api/scores/%20" })).statusCode).toBe(400);
  });

  it("일봉을 받지 못하면 '점수 없음 — 일봉을 받지 못했습니다' (기록하지 않고 5분 뒤 다시)", async () => {
    const { src, calls } = fixtureSources({ candles: { NVDA: new Error("출처 실패") } });
    await start(src);
    const b = (await get("NVDA")).body;
    expect(b.trend).toMatchObject({ status: "unavailable", label: "점수 없음", reason: { code: "fetchFailed", text: "일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다" }, score: null });
    expect(b.asOf.priceDate).toBeNull();
    expect(await db.selectFrom("indicator_scores").selectAll().execute()).toEqual([]);
    await get("NVDA");
    expect(calls.candles.filter((c) => c === "NVDA")).toHaveLength(1); // 5분 안에는 기억한 값
    clock = new Date(clock.getTime() + 6 * 60_000);
    await get("NVDA");
    expect(calls.candles.filter((c) => c === "NVDA")).toHaveLength(2);
  });

  it("기록이 200거래일보다 짧으면 '점수 없음 — 기록이 N거래일이라…'", async () => {
    const { src } = fixtureSources({ candles: { NVDA: candlesOf("NVDA").slice(-150) } });
    await start(src);
    expect((await get("NVDA")).body.trend).toMatchObject({ status: "unavailable", label: "점수 없음", reason: { code: "short", text: "기록이 150거래일이라 계산할 수 없습니다 (200거래일 필요)" }, score: null, band: null });
  });
});

describe("장 마감 뒤 하루 한 번 (한국 20:10 · 뉴욕 17:30), 휴장일", () => {
  it.each([
    ["KR", kst("2026-09-23T20:09:00"), "2026-09-22"],
    ["KR", kst("2026-09-23T20:10:00"), "2026-09-23"],
    ["KR", kst("2026-09-25T21:00:00"), "2026-09-23"], // 추석
    ["KR", kst("2026-09-28T19:59:00"), "2026-09-23"],
    ["KR", kst("2026-09-28T20:10:00"), "2026-09-28"],
    ["KR", kst("2026-10-05T21:00:00"), "2026-10-02"], // 개천절 대체공휴일
    ["US", ny("2026-09-25T17:29:00"), "2026-09-24"],
    ["US", ny("2026-09-25T17:30:00"), "2026-09-25"],
    ["US", kst("2026-09-26T06:30:00"), "2026-09-25"], // 여름: 한국 06:30
    ["US", kst("2026-09-28T10:00:00"), "2026-09-25"],
    ["US", ny("2026-09-07T18:00:00"), "2026-09-04"], // 노동절
    ["US", kst("2026-12-02T07:29:00"), "2026-11-30"], // 겨울: 한국 07:30 부터
    ["US", kst("2026-12-02T07:30:00"), "2026-12-01"],
    ["US", ny("2026-11-26T18:00:00", false), "2026-11-25"], // 추수감사절
    ["US", ny("2026-11-27T17:30:00", false), "2026-11-27"], // 조기 폐장일도 17:30 뒤
  ] as const)("%s %s → %s", (market, at, date) => expect(latestScoreDate(market, at)).toBe(date));

  it.each([
    ["KR", kst("2026-09-23T20:15:00"), true],
    ["KR", kst("2026-09-23T20:05:00"), false],
    ["KR", kst("2026-09-25T20:15:00"), false], // 추석
    ["US", ny("2026-09-25T17:31:00"), true],
    ["US", ny("2026-09-07T17:31:00"), false], // 노동절
  ] as const)("미리 계산 %s %s → %s", (market, at, due) => expect(dailyRunDue(market, at)).toBe(due));

  it("한국: 20:10 전에는 오늘 봉이 와도 쓰지 않는다 (장중·애프터마켓에 점수가 바뀌지 않게), 20:10 뒤에는 오늘 봉까지", async () => {
    const sam = candlesOf("005930.KS");
    const today: Candle = { date: "2026-09-28", open: 285_500, high: 300_000, low: 285_000, close: 299_000, volume: 30_000_000 };
    const { src } = fixtureSources({ candles: { "005930": [...sam, today] } });
    await start(src, kst("2026-09-28T19:00:00"));
    const before = (await get("005930")).body;
    expect(before.asOf).toMatchObject({ priceDate: "2026-09-23", line: "가격 9월 23일(수) 한국 종가" });
    expect(before.trend.score).toBe(68);
    clock = kst("2026-09-28T20:15:00");
    const after = (await get("005930")).body;
    expect(after.asOf.priceDate).toBe("2026-09-28");
    expect(after.trend.scoreExact).not.toBeCloseTo(before.trend.scoreExact!, 6);
  });

  it("미리 계산: 그 시장 등록 종목만, 휴장일·준비 시각 전에는 건너뜀, 하루 한 줄 기록(다시 계산하면 덮어씀)", async () => {
    const { src, calls } = fixtureSources({ registered: ["NVDA", "SOXL", "005930"] });
    await start(src, ny("2026-09-25T17:00:00"));
    const svc = app!.indicatorScores;
    expect(await svc.runDaily("US")).toEqual({ computed: 0, failed: 0, skipped: "closed" });
    expect(calls.registered).toBe(0);
    clock = ny("2026-09-25T17:31:00");
    expect(await svc.runDaily("US")).toEqual({ computed: 2, failed: 0 });
    const rows = await db.selectFrom("indicator_scores").select(["code", "score_date", "kind", "status", "score", "band", "version"]).orderBy("code").execute();
    expect(rows.map((r) => [r.code, r.score_date, r.kind, r.status, r.band, r.version])).toEqual([
      ["NVDA", "2026-09-25", "trend", "ok", "다소 강함", "TREND-1/TREND-CAL-1"],
      ["SOXL", "2026-09-25", "trend", "excluded", null, "TREND-1/TREND-CAL-1"],
    ]);
    expect(rows[0]!.score).toBeCloseTo(expected.trend["NVDA"]!.score, 9);
    const nvda = JSON.parse((await db.selectFrom("indicator_scores").select("data").where("code", "=", "NVDA").executeTakeFirstOrThrow()).data);
    expect(nvda).toMatchObject({ status: "ok", source: "yahoo", bench: "NASDAQ", asOf: "2026-09-25", bars: 300, daysAveraged: 5 });
    expect(nvda.raw.T1).toBeCloseTo(Math.log(1.128), 2);
    const soxl = JSON.parse((await db.selectFrom("indicator_scores").select("data").where("code", "=", "SOXL").executeTakeFirstOrThrow()).data);
    expect(soxl).toMatchObject({ status: "excluded", reason: "leveraged", leveraged: { L: 3, underlying: "SOXX" }, reference: { status: "ok", source: "yahoo", bench: "NASDAQ" } });
    // 한 번 더 돌려도 줄이 늘지 않는다
    await svc.runDaily("US");
    expect(await db.selectFrom("indicator_scores").selectAll().execute()).toHaveLength(2);
    // 한국: 추석(9/25)은 건너뛰고, 9/23 20:15 에는 삼성전자만
    clock = kst("2026-09-25T20:15:00");
    expect(await svc.runDaily("KR")).toMatchObject({ skipped: "closed" });
    clock = kst("2026-09-23T20:15:00");
    expect(await svc.runDaily("KR")).toEqual({ computed: 1, failed: 0 });
    expect((await app!.inject({ method: "GET", url: "/api/scores/005930/history" })).json()).toEqual({ code: "005930", items: [{ date: "2026-09-23", status: "ok", score: expect.closeTo(expected.trend["005930.KS"]!.score, 9), band: "다소 강함" }] });
  });

  it("따라잡기: 준비 시각 뒤 서버가 다시 켜졌고 오늘 기록이 빠진 등록 종목이 있으면 그 시장만 계산, 다 있으면·준비 전·꺼짐이면 안 함", async () => {
    const { src, calls } = fixtureSources({ registered: ["NVDA", "005930"] });
    await start(src, ny("2026-09-25T17:10:00"));
    const svc = app!.indicatorScores;
    expect(await svc.catchUp()).toEqual([]); // 미국 준비 전, 한국 9/26 06:10 은 전날 거래일 밤이 지남
    clock = ny("2026-09-25T18:00:00");
    expect(await svc.catchUp()).toEqual(["US"]);
    expect((await db.selectFrom("indicator_scores").select("code").execute()).map((r) => r.code)).toEqual(["NVDA"]);
    const before = calls.candles.length;
    expect(await svc.catchUp()).toEqual([]); // 이미 있음
    expect(calls.candles.length).toBe(before);
    await app!.inject({ method: "PUT", url: "/api/admin/features", payload: { indicatorScores: false } });
    clock = kst("2026-09-23T21:00:00");
    expect(await svc.catchUp()).toEqual([]);
  });

  it("미등록 종목(발견 탭에서 연 종목)은 계산해 보여 주되 하루 기록은 남기지 않는다", async () => {
    const { src } = fixtureSources({ stocks: { NVDA: { code: "NVDA", name: "엔비디아", market: "NASDAQ", registered: false } } });
    await start(src);
    expect((await get("NVDA")).body.trend.score).toBe(69);
    expect(await db.selectFrom("indicator_scores").selectAll().execute()).toEqual([]);
  });

  it("같은 기준 거래일이면 다시 계산하지 않는다 (일봉 요청 1번)", async () => {
    const { src, calls } = fixtureSources();
    await start(src);
    await get("NVDA");
    await get("NVDA");
    expect(calls.candles).toEqual(["NVDA"]);
    expect(calls.benchmark).toEqual(["NASDAQ"]);
  });
});

describe("레버리지·인버스", () => {
  it("SOXL: 이 상품 자체 점수 없음 + 기초자산 SOXX 참고 줄(73 강함) + 레버리지 주의 사실 상자", async () => {
    const { src } = fixtureSources();
    await start(src);
    const b = (await get("SOXL")).body;
    const t = b.trend;
    expect(t).toMatchObject({
      status: "excluded",
      label: "이 상품 자체 점수 없음",
      score: null,
      reason: { code: "leveraged", text: "매일 3배를 다시 맞추는 상품이라 이 상품 가격으로는 계산하지 않습니다." },
      basis: { kind: "underlying", code: "SOXX" },
      reference: { code: "SOXX", status: "ok", score: 73, band: "강함", text: "참고: 기초자산 SOXX 추세 지표 73 · 강함", note: "SOXX는 같은 NYSE 반도체 지수를 1배로 따르는 ETF입니다." },
    });
    expect(t.leveraged!.L).toBe(3);
    expect(t.leveraged!.check!.corr).toBeGreaterThan(0.99);
    const f = t.leveraged!.facts!;
    for (const k of ["etf63Pct", "und63Pct", "naiveLx63Pct", "sigEtfAnnPct", "etfMdd1yPct", "volDecayPctPerYear"] as const) expect(f[k]).toBeCloseTo(expected.leveraged["SOXL"]![k], 9);
    const lines = t.leveraged!.box.lines.map((l) => l.parts.map((p) => p.text).join(""));
    expect(t.leveraged!.box.title).toBe("레버리지 상품 주의 · 계산한 사실");
    expect(lines).toEqual([
      "이 상품은 NYSE 반도체 지수 하루 움직임의 3배를 따라가도록 만든 상품입니다.",
      "· 최근 63거래일: 이 상품 −29.8%, 기초자산 −2.9% (단순 3배면 −8.8%)",
      "· 이 상품의 최근 3개월 변동성 연 150%, 최근 1년 가장 크게 떨어진 폭 69.4%",
      "· 계산상 변동성 손실: 기초자산 변동성(연 50.7%)이 1년 이어지고 기초자산이 제자리라고 가정하면, 이 상품 값은 약 53.8% 줄어듭니다.",
      "· 하루 단위로 설계된 상품이라 기간이 길수록 '기초자산 수익률 × 3'과 차이가 커질 수 있습니다.",
    ]);
    // 수익률 숫자만 등락 색 (부호)
    expect(t.leveraged!.box.lines[1]!.parts.filter((p) => p.sign !== undefined).map((p) => Math.sign(p.sign!))).toEqual([-1, -1, -1]);
    expect(b.value).toMatchObject({ status: "excluded", label: "대상 아님" });
    // 설계 5.4 조합표: 레버리지(기초자산 참고만)는 '가치 지표 점수가 없어 합치지 않습니다'
    expect(b.composite).toMatchObject({ status: "none", reason: "valueMissing", text: "없음 · 가치 지표 점수가 없어 합치지 않습니다" });
    expect(b.asOf.priceDate).toBe("2026-09-25");
  });

  it("RGTX: 기초 RGTI 42 다소 약함 (단일 종목 상품이라 '같은 지수' 안내 없음)", async () => {
    const { src } = fixtureSources();
    await start(src);
    const t = (await get("RGTX")).body.trend;
    expect(t.reference).toMatchObject({ code: "RGTI", score: 42, band: "다소 약함", note: null });
    expect(t.leveraged!.box.lines[0]!.parts[0]!.text).toBe("이 상품은 리게티 컴퓨팅 주가 하루 움직임의 2배를 따라가도록 만든 상품입니다.");
    expect(t.leveraged!.facts!.etfMdd1yPct.toFixed(1)).toBe("98.4");
  });

  it("기초자산 일봉이 L배를 따라가지 않으면(엉뚱한 기초) 참고 줄 없이 '기초자산을 확인하지 못해…', 상자에는 상품 자체 값만", async () => {
    const { src } = fixtureSources({ candles: { SOXX: candlesOf("QQQ") } });
    await start(src);
    const t = (await get("SOXL")).body.trend;
    expect(t).toMatchObject({ status: "excluded", label: "이 상품 자체 점수 없음", reference: null, reason: { code: "underlyingUnknown", text: "레버리지 상품의 기초자산을 확인하지 못해 계산하지 않았습니다" } });
    expect(t.leveraged).toMatchObject({ underlying: null, tracks: null });
    const lines = t.leveraged!.box.lines.map((l) => l.parts.map((p) => p.text).join(""));
    expect(lines[0]).toBe("이 상품은 기초자산 하루 움직임의 3배를 따라가도록 만든 상품입니다.");
    expect(lines.some((l) => l.includes("기초자산 −"))).toBe(false);
    expect(lines).toContain("· 이 상품의 최근 3개월 변동성 연 150%, 최근 1년 가장 크게 떨어진 폭 69.4%");
  });

  it("상품 일봉을 받지 못하면 받기 실패(fetchFailed): 정적 표의 기초(SOXL→SOXX)는 참고 줄을 두고, 이름으로 짐작한 기초는 확인할 수 없어 두지 않는다", async () => {
    const table = fixtureSources({ candles: { SOXL: new Error("상품 일봉 실패") } });
    await start(table.src);
    const soxl = (await get("SOXL")).body.trend;
    expect(soxl.reason).toEqual({ code: "fetchFailed", text: "이 상품 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다" });
    expect(soxl.reference).toMatchObject({ code: "SOXX", score: 73 });
    expect(soxl.leveraged).toMatchObject({ facts: null, tracks: "NYSE 반도체 지수" });
    await app!.close();
    app = null;
    const guessed = fixtureSources({
      candles: { IONX: new Error("상품 일봉 실패"), IONQ: candlesOf("RGTI") },
      stocks: { IONX: { code: "IONX", name: "IONX", market: "NASDAQ", groupCode: "EF" }, IONQ: { code: "IONQ", name: "아이온큐", market: "NASDAQ" } },
      product: { IONX: { name: "IONX", englishName: "DEFIANCE DAILY TARGET 2X LONG IONQ ETF", detailName: null, group: "EF", exchange: "NSQ", leverageFactor: 2, singleStockEtp: true, derivativeEtf: true } },
    });
    await start(guessed.src);
    const t = (await get("IONX")).body.trend;
    expect(t).toMatchObject({ status: "excluded", reference: null, reason: { code: "fetchFailed", text: "이 상품 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다" } });
    expect(t.leveraged).toMatchObject({ underlying: null, tracks: null });
  });

  it("인버스(SQQQ)는 대상 아님", async () => {
    const { src } = fixtureSources({ candles: { SQQQ: new Error("기록 없음") } });
    await start(src);
    const b = (await get("SQQQ")).body;
    expect(b.trend).toMatchObject({ status: "excluded", label: "대상 아님", reason: { code: "inverse", text: "인버스 상품은 점수를 내지 않습니다 (기초자산과 반대로 움직이도록 만든 상품)." } });
    expect(b.value.status).toBe("excluded");
  });
});

/** 합성 일봉: 오래 옆걸음하다 최근 5거래일 날마다 7% 내린 종목 (지난주보다 점수가 5점 넘게 바뀜 — 급등은 단기 과열 묶음이 깎아 5점을 잘 넘지 않는다) */
function jumpCandles(): { stock: Candle[]; bench: Candle[] } {
  const stock: Candle[] = [];
  const bench: Candle[] = [];
  const nvda = benchOf("NVDA");
  const dates = nvda.slice(-310).map((c) => c.date);
  let c = 100;
  dates.forEach((date, i) => {
    const prev = c;
    c = i >= dates.length - 5 ? prev * 0.93 : prev * (1 + 0.012 * Math.sin(i * 0.9));
    stock.push({ date, open: prev, high: Math.max(prev, c), low: Math.min(prev, c), close: c, volume: 1_000_000 + (i % 5) * 100_000 + (i >= dates.length - 5 ? 2_000_000 : 0) });
    bench.push({ ...nvda.slice(-310)[i]! });
  });
  return { stock, bench };
}

describe("지난주 대비 바뀐 이유 (상세 카드만)", () => {
  it("화면 정수가 5점 넘게 바뀌면 한 줄: 몇 점 · 어느 묶음이 가장 크게", async () => {
    const { stock } = jumpCandles();
    const { src } = fixtureSources({ candles: { ZJMP: stock }, stocks: { ZJMP: { code: "ZJMP", name: "합성 종목", market: "NASDAQ" } } });
    await start(src);
    const t = (await get("ZJMP")).body.trend;
    expect(t.status).toBe("ok");
    expect(t.change).not.toBeNull();
    const c = t.change!;
    expect(c.diff).toBeLessThan(-5);
    // 가중치 × 묶음 점수 변화가 가장 큰 묶음 (추세 35% 가 50 근처 → 20대로)
    expect(c).toMatchObject({ family: "T", familyName: "추세" });
    expect(c.familyDiff).toBeLessThan(0);
    expect(c.diff).toBe(c.now - c.prev);
    expect(c.from).toBe(stock.at(-6)!.date);
    // 괄호를 겹치지 않게 ('지난주(9월 18일(금))' → '지난주 9월 18일(금)')
    expect(c.text).toMatch(/^지난주 \d+월 \d+일\(.\)보다 점수가 \d+점 낮아졌습니다\. 가장 크게 바뀐 묶음은 (추세|모멘텀|단기 균형|가격 안정성|거래량 뒷받침)\([+−]\d+점\)입니다\.$/);
  });

  it("5점 이하면 없음 (NVDA 는 5거래일 전과 비슷)", async () => {
    const { src } = fixtureSources();
    await start(src);
    expect((await get("NVDA")).body.trend.change).toBeNull();
  });

  it("점수와 반대로 움직인 묶음은 '가장 크게 바뀐 묶음'으로 들지 않는다 (같은 쪽 묶음 가운데 비중 × 변화가 가장 큰 것)", () => {
    const shown = (asOf: string, score: number, fam: Record<"T" | "M" | "O" | "R" | "V", number>) =>
      ({ status: "ok", asOf, score, scoreToday: score, families: Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, { score: v }])) }) as unknown as TrendShown;
    // 추세·모멘텀이 +25 (비중 35 → 875씩), 단기 균형이 −95 (비중 10 → 950): 절댓값은 단기 균형이 가장 크지만 점수는 8점 올랐다
    const prev = shown("2026-09-18", 54.7, { T: 50, M: 50, O: 97, R: 50, V: 50 });
    const now = shown("2026-09-25", 62.7, { T: 75, M: 75, O: 2, R: 50, V: 50 });
    const c = weeklyChange(now, prev)!;
    expect(c).toMatchObject({ prev: 55, now: 63, diff: 8, family: "T", familyName: "추세", familyDiff: 25 });
    expect(c.text).toBe("지난주 9월 18일(금)보다 점수가 8점 높아졌습니다. 가장 크게 바뀐 묶음은 추세(+25점)입니다.");
    // 내려간 때도 같은 규칙
    const down = weeklyChange(prev, { ...now, asOf: "2026-09-11" } as TrendShown)!;
    expect(down).toMatchObject({ diff: -8, family: "T", familyDiff: -25 });
    expect(weeklyChange(now, { ...now, score: 60 } as TrendShown)).toBeNull(); // 5점 이하
  });
});

describe("받기 실패 (설계 5.4 — 받기 실패 · 원래 없음 · 계산 불가를 구분)", () => {
  it("비교 지수(네이버)를 받지 못하면 지수 대비 항목을 뺀 다른 점수를 내지 않고 '점수 없음 — 비교 지수(나스닥) 일봉을 받지 못했습니다', 5분 뒤 다시, 기록 안 함", async () => {
    let down = true;
    const { src, calls } = fixtureSources({ registered: ["NVDA"], bench: { NASDAQ: () => (down ? new Error("네이버 지수 실패") : benchOf("NVDA")) } });
    await start(src, ny("2026-09-25T17:31:00"));
    const b = (await get("NVDA")).body;
    expect(b.trend).toMatchObject({ status: "unavailable", label: "점수 없음", score: null, band: null, reason: { code: "fetchFailed", text: "비교 지수(나스닥) 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다" } });
    expect(b.trend.notes).toEqual([]); // '비교 지수가 없어 … 뺐습니다'(원래 없음)가 아니다
    expect(b.composite).toMatchObject({ reason: "bothMissing" });
    expect(await rowsOf()).toEqual([]);
    // 장 마감 뒤 미리 계산도 실패로 세고 기록하지 않는다
    expect(await app!.indicatorScores.runDaily("US")).toEqual({ computed: 0, failed: 1 });
    expect(await rowsOf()).toEqual([]);
    await get("NVDA");
    const n = calls.benchmark.length;
    await get("NVDA");
    expect(calls.benchmark.length).toBe(n); // 5분 안에는 기억한 값
    down = false;
    clock = new Date(clock.getTime() + 6 * 60_000);
    const ok = (await get("NVDA")).body.trend;
    expect(ok).toMatchObject({ status: "ok", score: 69, band: "다소 강함", benchmark: { code: "NASDAQ" } });
    expect(ok.scoreExact!).toBeCloseTo(expected.trend["NVDA"]!.score, 9);
    expect((await rowsOf()).map((r) => [r.code, r.score_date, r.status])).toEqual([["NVDA", "2026-09-25", "ok"]]);
  });

  it("지수 일봉이 종목 마지막 봉보다 늦거나(아직 오늘 값 없음) 비어 있어도 받기 실패", async () => {
    const lag = fixtureSources({ bench: { NASDAQ: benchOf("NVDA").filter((c) => c.date <= "2026-09-24") } });
    await start(lag.src);
    expect((await get("NVDA")).body.trend.reason).toEqual({ code: "fetchFailed", text: "비교 지수(나스닥) 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다" });
    await app!.close();
    const empty = fixtureSources({ bench: { KOSPI: [] } });
    await start(empty.src);
    expect((await get("005930")).body.trend.reason).toEqual({ code: "fetchFailed", text: "비교 지수(코스피) 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다" });
  });

  it("지수와 상관없는 이유(기록 부족)면 그 이유 그대로, 비교 지수가 원래 없는 상품은 지수 대비 항목만 빼고 계산 (받기 실패 아님)", async () => {
    const { src } = fixtureSources({ candles: { NVDA: candlesOf("NVDA").slice(-150) }, bench: { NASDAQ: new Error("네이버 지수 실패") } });
    await start(src);
    expect((await get("NVDA")).body.trend.reason).toMatchObject({ code: "short" });
  });

  it("기초자산(SOXX) 일봉을 한 번 받지 못하면: '기초자산을 확인하지 못함'이 아니라 받기 실패, 5분 뒤 다시 계산해 참고 줄이 돌아오고 그때 기록", async () => {
    let fails = 1;
    const { src } = fixtureSources({ registered: ["SOXL"], candles: { SOXX: () => (fails-- > 0 ? new Error("야후 실패") : candlesOf("SOXX")) } });
    await start(src, ny("2026-09-25T17:31:00"));
    expect(await app!.indicatorScores.runDaily("US")).toEqual({ computed: 0, failed: 1 });
    const t = (await get("SOXL")).body.trend;
    expect(t).toMatchObject({ status: "excluded", label: "이 상품 자체 점수 없음", reference: null, reason: { code: "fetchFailed", text: "기초자산 SOXX 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다" } });
    // 사실 상자: 따르는 지수(정적 표)와 상품 자체 숫자는 그대로, 기초자산 비교만 빠짐
    expect(t.leveraged).toMatchObject({ L: 3, underlying: null, tracks: "NYSE 반도체 지수" });
    expect(t.leveraged!.facts).toMatchObject({ und63Pct: null, naiveLx63Pct: null });
    const lines = t.leveraged!.box.lines.map((l) => l.parts.map((p) => p.text).join(""));
    expect(lines[0]).toBe("이 상품은 NYSE 반도체 지수 하루 움직임의 3배를 따라가도록 만든 상품입니다.");
    expect(lines).toContain("· 최근 63거래일: 이 상품 −29.8%");
    expect(await rowsOf()).toEqual([]);
    clock = new Date(clock.getTime() + 6 * 60_000);
    const again = (await get("SOXL")).body.trend;
    expect(again).toMatchObject({ reason: { code: "leveraged" }, reference: { code: "SOXX", status: "ok", score: 73, band: "강함" } });
    expect((await rowsOf()).map((r) => [r.code, r.score_date, r.status])).toEqual([["SOXL", "2026-09-25", "excluded"]]);
  });

  it("기초자산의 비교 지수를 받지 못해도 받기 실패 (참고 줄을 다른 점수로 두지 않음)", async () => {
    const { src } = fixtureSources({ bench: { NASDAQ: new Error("네이버 지수 실패") } });
    await start(src);
    const t = (await get("SOXL")).body.trend;
    expect(t).toMatchObject({ reference: null, reason: { code: "fetchFailed", text: "기초자산 SOXX의 비교 지수(나스닥) 일봉을 받지 못했습니다. 잠시 뒤 다시 계산합니다" } });
    expect(t.leveraged!.facts!.und63Pct).toBeCloseTo(expected.leveraged["SOXL"]!.und63Pct, 9); // 사실 상자는 지수와 상관없이 그대로
  });

  it("장 마감 뒤 40분 다시 계산(따라잡기): 받기 실패로 기록이 빠진 종목만 다시", async () => {
    let down = true;
    const { src, calls } = fixtureSources({ registered: ["NVDA", "AAPL"], candles: { AAPL: () => (down ? new Error("출처 실패") : candlesOf("AAPL")) } });
    await start(src, ny("2026-09-25T17:31:00"));
    const svc = app!.indicatorScores;
    expect(await svc.runDaily("US")).toEqual({ computed: 1, failed: 1 });
    expect(calls.fresh).toEqual(["NVDA", "AAPL"]); // 미리 계산은 차트 캐시의 묵은 봉을 쓰지 않는다
    down = false;
    clock = ny("2026-09-25T18:10:00");
    calls.candles.length = 0;
    expect(await svc.catchUp(["US"])).toEqual(["US"]);
    expect(calls.candles).toEqual(["AAPL"]); // NVDA 는 이미 기록이 있어 다시 받지 않는다
    expect((await rowsOf()).map((r) => [r.code, r.status])).toEqual([
      ["AAPL", "ok"],
      ["NVDA", "ok"],
    ]);
    expect(await svc.catchUp(["US"])).toEqual([]);
  });
});

describe("하루 기록", () => {
  it("기준 거래일(scoreDate)로 적는다: 거래정지 종목을 나중에 다시 계산해도 예전 날의 정상 기록을 덮지 않고, 따라잡기가 되풀이되지 않는다", async () => {
    const halted = candlesOf("NVDA").filter((c) => c.date <= "2026-09-10");
    const { src, calls } = fixtureSources({ registered: ["NVDA"], candles: { NVDA: halted } });
    await start(src, ny("2026-09-10T17:31:00"));
    const svc = app!.indicatorScores;
    expect(await svc.runDaily("US")).toEqual({ computed: 1, failed: 0 });
    clock = ny("2026-09-25T17:31:00");
    expect(await svc.runDaily("US")).toEqual({ computed: 1, failed: 0 });
    const rows = await rowsOf();
    expect(rows.map((r) => [r.score_date, r.status, JSON.parse(r.data).priceDate])).toEqual([
      ["2026-09-10", "ok", "2026-09-10"],
      ["2026-09-25", "unavailable", "2026-09-10"],
    ]);
    expect(rows[0]!.score).not.toBeNull();
    expect(JSON.parse(rows[1]!.data)).toMatchObject({ reason: "stale" });
    clock = ny("2026-09-25T18:10:00");
    const before = calls.candles.length;
    expect(await svc.catchUp()).toEqual([]); // 오늘 줄이 있다
    expect(calls.candles.length).toBe(before);
  });

  it("마지막 봉이 기준 거래일보다 앞이면(거래정지·출처 늦음) 30분만 기억한다", async () => {
    const { src, calls } = fixtureSources({ candles: { NVDA: candlesOf("NVDA").filter((c) => c.date <= "2026-09-24") } });
    await start(src);
    expect((await get("NVDA")).body.asOf).toMatchObject({ priceDate: "2026-09-24", scoreDate: "2026-09-25" });
    clock = new Date(clock.getTime() + 20 * 60_000);
    await get("NVDA");
    expect(calls.candles).toEqual(["NVDA"]);
    clock = new Date(clock.getTime() + 11 * 60_000);
    await get("NVDA");
    expect(calls.candles).toEqual(["NVDA", "NVDA"]);
  });
});

describe("그 밖의 상품 규칙", () => {
  it("분배금이 큰 상품(커버드콜·프리미엄 인컴 ETF)은 점수는 내되 안내 한 줄 (추세 계산 9.6), 보통 종목에는 없음", async () => {
    const { src } = fixtureSources({
      candles: { QYLD: candlesOf("QQQ"), JEPQ: candlesOf("QQQ") },
      stocks: { QYLD: { code: "QYLD", name: "Global X NASDAQ 100 Covered Call ETF", market: "NASDAQ", groupCode: "EF" }, JEPQ: { code: "JEPQ", name: "JPMorgan Nasdaq Equity Premium Income ETF", market: "NASDAQ", groupCode: "EF" } },
    });
    await start(src);
    for (const c of ["QYLD", "JEPQ"]) {
      const t = (await get(c)).body.trend;
      expect(t.status).toBe("ok");
      expect(t.notes).toContain("분배금이 큰 상품이라 가격만으로 계산한 추세가 실제 수익보다 낮게 나올 수 있습니다.");
    }
    expect((await get("QQQ")).body.trend.notes).toEqual([]);
  });

  it("종목 마스터가 보통 주식(ST)이라고 하면 이름의 'Bear'·'Short' 로 인버스를 짐작하지 않는다 (토스 상품 정보가 없어도)", async () => {
    const { src } = fixtureSources({
      candles: { BBW: candlesOf("AAPL") },
      stocks: { BBW: { code: "BBW", name: "Build-A-Bear Workshop", market: "NYSE", groupCode: "ST" } },
    });
    await start(src);
    const b = (await get("BBW")).body;
    expect(b.trend.status).toBe("ok");
    expect(b.value).toMatchObject({ status: "pending" });
  });
});

describe("문구 (금지어 · 미래형)", () => {
  it("검사기: 걸려야 할 것과 허용할 것", () => {
    expect(scoreWordingProblems("매수 추천 종목입니다")).toEqual(["매수", "추천"]);
    expect(scoreWordingProblems("앞으로 오를 것")).toEqual(["오를"]);
    expect(scoreWordingProblems("곧 상승할 것입니다")).toEqual(["상승할", "할 것"]);
    expect(scoreWordingProblems("목표가 근처")).toEqual(["목표"]);
    expect(scoreWordingProblems("반등할 가능성이 있습니다")).toEqual(["반등", "할 가능성"]);
    expect(scoreWordingProblems("RSI 72(과매수 구간)")).toEqual([]);
    expect(scoreWordingProblems("200일선은 한 달 전보다 2.0% 올랐습니다.")).toEqual([]);
    expect(scoreWordingProblems("기간이 길수록 '기초자산 수익률 × 3'과 차이가 커질 수 있습니다.")).toEqual([]);
    expect(scoreWordingProblems("점수가 좋아질 수 있습니다")).toEqual(["수 있습니다"]);
  });

  it("서버가 만드는 모든 점수 문장 (예시 종목·레버리지·판단 불가·보류·바뀐 이유·계산 방법)에 걸리는 낱말이 없다", async () => {
    const { stock } = jumpCandles();
    const { src } = fixtureSources({ candles: { ZJMP: stock, SHRT: candlesOf("NVDA").slice(-120) }, stocks: { ZJMP: { code: "ZJMP", name: "합성 종목", market: "NASDAQ" }, SHRT: { code: "SHRT", name: "짧은 기록", market: "NASDAQ" } } });
    await start(src);
    const all: string[] = [];
    for (const c of ["NVDA", "MSFT", "AAPL", "AVGO", "META", "TSLA", "PLTR", "QQQ", "SOXX", "RGTI", "005930", "000660", "035420", "SOXL", "RGTX", "SQQQ", "ZJMP", "SHRT"]) all.push(...texts((await get(c)).body));
    for (const r of [
      { code: "short", bars: 150 },
      { code: "stale", lastDate: "2026-09-01", refDate: "2026-09-25" },
      { code: "split", date: "2026-09-01", ratio: 0.5 },
      { code: "flat", pct: 40 },
      { code: "thin" },
      { code: "coverage", pct: 60 },
    ] as const)
      all.push(trendReasonText(r));
    for (const n of [{ code: "noBench" }, { code: "noVolume" }, { code: "shortYear", bars: 220 }] as const) for (const m of ["overseas", "none", null] as const) all.push(trendNoteText(n, m));
    all.push(...Object.values(STATUS_TEXT), ...howLines(), benchFetchFailed("나스닥"), benchFetchFailed("코스피", "069500"), underlyingFetchFailed("SOXX"), DISTRIBUTION_NOTE);
    for (const diff of [-12, 7]) for (const familyDiff of [-9, 0, 14]) all.push(changeText({ from: "2026-09-18", diff, family: "O", familyDiff }));
    const f = leverageFacts(candlesOf("SOXL"), candlesOf("SOXX"), 3);
    for (const box of [leverageBox(f, 3, "NYSE 반도체 지수"), leverageBox(null, 2, null), leverageBox(leverageFacts(candlesOf("SOXL"), null, 3), 3, null)]) all.push(box.title, ...box.lines.flatMap((l) => l.parts.map((p) => p.text)));
    expect(all.length).toBeGreaterThan(300);
    const bad = all.map((s) => [s, scoreWordingProblems(s)] as const).filter(([, p]) => p.length);
    expect(bad).toEqual([]);
  });
});

describe("공용 픽스처 (앱 화면 테스트·웹 미리보기가 쓰는 서버 응답)", () => {
  /** shared/fixtures/indicatorScores.json — 지금 서버 코드가 기록한 일봉으로 낸 응답과 같아야 한다. 바꿀 때: UPDATE_SCORE_FIXTURE=1 npx vitest run test/indicatorScores.test.ts */
  it("2단계(가치·종합 켜짐): NVDA · MSFT · AAPL · META · JPM(은행) · RGTI(적자) · 차이 큰 예시 · SEC 재무 없는 예시 · 삼성전자 · QQQ · SOXL · RGTX · SQQQ · 짧은 기록 · 지난주 대비 바뀐 종목 · 재무 받는 중 · 가치 끔 · 받기 실패", async () => {
    const { stock } = jumpCandles();
    const { src } = fixtureSources({
      candles: { ZJMP: stock, SHRT: candlesOf("NVDA").slice(-120), SQQQ: new Error("기록 없음") },
      stocks: { ZJMP: { code: "ZJMP", name: "합성 종목", market: "NASDAQ" }, SHRT: { code: "SHRT", name: "짧은 기록", market: "NASDAQ" } },
    });
    const value = fakeValueSources({ alias: { ZZGAP: "RGTI" } });
    await start(src, undefined, true, value.src);
    await app!.valueScores.saveReference(referenceData());
    for (const c of ["NVDA", "MSFT", "AAPL", "META", "JPM", "RGTI", "ZZGAP"]) await app!.valueScores.refreshFacts(c);
    const cases: Record<string, unknown> = {};
    const take = async (c: string, key = c) => {
      const { computedAt: _t, ...body } = (await get(c)).body;
      cases[key] = body;
    };
    for (const c of ["NVDA", "MSFT", "AAPL", "META", "JPM", "RGTI", "ZZGAP", "005930", "QQQ", "SOXL", "RGTX", "SQQQ", "SHRT", "ZJMP"]) await take(c);
    // SEC 목록에 없는 종목: 처음엔 '재무제표를 처음 받는 중' → 백그라운드 확인 뒤 '점수 없음'
    await take("ZZNOF", "ZZNOF_pending");
    await app!.valueScores.idle();
    clock = new Date(clock.getTime() + 61_000);
    await take("ZZNOF");
    // 가치 플래그를 끈 서버 (1단계와 같은 가치 줄)
    await app!.close();
    await start(fixtureSources().src, undefined, true, fakeValueSources().src);
    await app!.inject({ method: "PUT", url: "/api/admin/features", payload: { valueScore: false } });
    await take("NVDA", "NVDA_valueOff");
    // 받기 실패 모습 (앱 화면 테스트용): 네이버 지수·기초자산 일봉을 받지 못한 서버
    await app!.close();
    const down = fixtureSources({ candles: { SOXX: new Error("야후 실패") }, bench: { NASDAQ: new Error("네이버 지수 실패") } });
    await start(down.src, undefined, true, fakeValueSources().src);
    await app!.valueScores.saveReference(referenceData());
    await app!.valueScores.refreshFacts("NVDA");
    for (const c of ["NVDA", "SOXL"]) {
      const { computedAt: _t, ...body } = (await get(c)).body;
      cases[`${c}_fetchFailed`] = body;
    }
    const file = new URL("../../shared/fixtures/indicatorScores.json", import.meta.url);
    const fixture = { note: "지표 점수 2단계 서버 응답 (GET /api/scores/:code, computedAt 제외) — 기록한 야후 공개 일봉(backend/test/fixtures/indicatorScores·valueScores)과 SEC 재무·2026-09-26 비교 기준(backend/test/fixtures/valueScores)으로 서버 코드가 낸 값. 2026-09-28 10:00 KST 기준. ZZ 로 시작하는 코드는 예시 종목(다른 종목 기록을 빌림)", cases };
    if (process.env["UPDATE_SCORE_FIXTURE"] === "1") writeFileSync(file, `${JSON.stringify(fixture, null, 1)}\n`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(fixture);
  });
});

describe("DB·백업", () => {
  it("indicator_scores 는 백업 목록에 있고, JSON 백업에서 되살아난다", async () => {
    expect(BACKUP_TABLES).toContain("indicator_scores");
    const fresh = await createMigratedDb(":memory:");
    const row = { id: 7, score_date: "2026-09-25", code: "NVDA", market: "US", kind: "trend", version: "TREND-1/TREND-CAL-1", status: "ok", score: 68.58, score_today: 68.6, band: "다소 강함", data: "{}", created_at: "2026-09-26T06:31:00+09:00", updated_at: "2026-09-26T06:31:00+09:00" };
    const out = await restoreBackup(fresh, "sqlite", { version: 1, createdAt: "x", tables: { indicator_scores: [row] } });
    expect(out["indicator_scores"]).toBe(1);
    expect(await fresh.selectFrom("indicator_scores").selectAll().execute()).toEqual([row]);
    await fresh.destroy();
  });
});
