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
import { dailyRunDue, latestScoreDate, type ScoreSources, type ScoresResponse, type ScoreStock } from "../src/services/indicatorScoreService.js";
import { howLines, leverageBox, STATUS_TEXT, trendNoteText, trendReasonText } from "../src/services/indicatorScoreText.js";
import { benchOf, candlesOf, expected, tossInfo } from "./fixtures/indicatorScores/load.js";
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
};
const FIX_SYM = (code: string) => (/^\d{6}$/.test(code) ? `${code}.KS` : code);

/** 기록한 일봉으로 만든 자료 묶음. 받은 횟수를 센다 */
function fixtureSources(over: { candles?: Record<string, Candle[] | Error>; product?: Record<string, ReturnType<typeof parseProductFacts> | null>; registered?: string[]; stocks?: Record<string, ScoreStock> } = {}) {
  const calls = { stock: 0, candles: [] as string[], benchmark: [] as string[], product: 0, registered: 0 };
  const stocks = { ...STOCKS, ...over.stocks };
  const src: ScoreSources = {
    stock: async (code) => {
      calls.stock++;
      return stocks[code] ?? null;
    },
    candles: async (code, count) => {
      calls.candles.push(code);
      const o = over.candles?.[code];
      if (o instanceof Error) throw o;
      const cs = o ?? candlesOf(FIX_SYM(code));
      return { code, period: "D", candles: cs.slice(-count), source: "yahoo" };
    },
    benchmark: async (code) => {
      calls.benchmark.push(code);
      return code === "NASDAQ" ? benchOf("NVDA") : code === "KOSPI" ? benchOf("005930.KS") : null;
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

async function start(sources: ScoreSources, at = kst("2026-09-28T10:00:00")) {
  clock = at;
  db = await createMigratedDb(":memory:");
  app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ scoreSources: sources }), logger: false, enableScheduler: false, now: () => clock });
  return app;
}
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
  it("서버 기본 켜짐 (사용자 승인), 설명에 '끄면 … 0건'", () => {
    expect(FEATURES.indicatorScores.default).toBe(true);
    expect(FEATURES.indicatorScores.description).toMatch(/끄면 .*0건/);
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
    expect(calls).toEqual({ stock: 0, candles: [], benchmark: [], product: 0, registered: 0 });
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
    expect(b.composite).toMatchObject({ status: "none", reason: "bothMissing" });
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
    expect(c.text).toMatch(/^지난주\(\d+월 \d+일\(.\)\)보다 점수가 \d+점 낮아졌습니다\. 가장 크게 바뀐 묶음은 (추세|모멘텀|단기 균형|가격 안정성|거래량 뒷받침)\([+−]\d+점\)입니다\.$/);
  });

  it("5점 이하면 없음 (NVDA 는 5거래일 전과 비슷)", async () => {
    const { src } = fixtureSources();
    await start(src);
    expect((await get("NVDA")).body.trend.change).toBeNull();
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
    all.push(...Object.values(STATUS_TEXT), ...howLines());
    const f = leverageFacts(candlesOf("SOXL"), candlesOf("SOXX"), 3);
    for (const box of [leverageBox(f, 3, "NYSE 반도체 지수"), leverageBox(null, 2, null), leverageBox(leverageFacts(candlesOf("SOXL"), null, 3), 3, null)]) all.push(box.title, ...box.lines.flatMap((l) => l.parts.map((p) => p.text)));
    expect(all.length).toBeGreaterThan(300);
    const bad = all.map((s) => [s, scoreWordingProblems(s)] as const).filter(([, p]) => p.length);
    expect(bad).toEqual([]);
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
