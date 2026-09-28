import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { MarketSummaryData } from "../src/services/marketSummaryCalc.js";
import type { MarketSummary, MarketSummarySources } from "../src/services/marketSummaryService.js";
import { buildWidgetPayload, widgetSummary } from "../src/services/widgetPayload.js";
import { fakeProviders, FakeGenerator } from "./helpers.js";

/**
 * 시장 전체 요약 — 브리핑 위젯 첫 줄 (플래그 marketSummary, 2단계).
 * 서버는 위젯을 그리는 새 앱이 /api/widget …&ms=1 로 물을 때만 features.marketSummary 와 가장 최근 요약의 숫자(ms)를 넣는다.
 * 예전 앱(표시 없음)의 응답·ETag 는 요약·플래그와 상관없이 바이트까지 그대로다. 끄면 요약을 조회하지도 않는다.
 * 요약은 공용 픽스처(shared/fixtures/marketSummary.json — 앱과 같은 데이터)를 DB 에 그대로 넣는다 (출처 호출 없음, 고정 값)
 */

const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/marketSummary.json", import.meta.url), "utf8")) as { cases: Array<{ name: string; data: MarketSummaryData }> };
const MONDAY = shared.cases[0]!.data; // 9/28(월) 아침 — 금요일(9/25) 미국 장
const KR_DAY = shared.cases[1]!.data; // 9/23(수) 오후 — 오늘 한국 장
const KR_HOLIDAY = shared.cases[2]!.data; // 9/25(금) 오후 추석 — 직전 거래일 9/23 값

/** 출처는 부르지 않는다 (요약은 DB 에 바로 넣는다). 불리면 테스트가 실패하게 */
const noSources = new Proxy({} as MarketSummarySources, {
  get: (_t, key) => (key === "then" ? undefined : () => Promise.reject(new Error("이 테스트는 출처를 부르지 않는다"))),
});

const OLD_URLS = ["/api/widget", "/api/widget?indices=1", "/api/widget?indices=1&sessions=1", "/api/widget?indices=1&sessions=1&ui=2", "/api/widget?indices=1&sessions=1&ui=2&board=1"];
const NEW_URL = "/api/widget?indices=1&sessions=1&ui=2&ms=1";

describe("GET /api/widget: 브리핑 위젯 첫 줄 (시장 요약, &ms=1 만)", () => {
  let db: Db | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const start = async (o: { withService?: boolean } = {}) => {
    db = await createMigratedDb(":memory:");
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ generator: new FakeGenerator(), ...(o.withService === false ? {} : { marketSummary: noSources }) }),
      logger: false,
      enableScheduler: false,
    });
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { numberBasis: false } });
  };
  const insert = async (d: MarketSummaryData, status: "ok" | "failed" = "ok") => {
    await db!
      .insertInto("market_summaries")
      .values({ summary_date: d.date, session: d.session, market: d.market, status, summary: "요약", data: JSON.stringify(d), created_at: `${d.date}T${d.session === "morning" ? "08:30" : "16:00"}:05+09:00` })
      .execute();
    return (await db!.selectFrom("market_summaries").select("id").where("summary_date", "=", d.date).where("session", "=", d.session).executeTakeFirstOrThrow()).id;
  };
  const raw = async (url: string, headers: Record<string, string> = {}) => {
    const r = await app!.inject({ method: "GET", url, headers });
    return { status: r.statusCode, body: r.body, etag: String(r.headers.etag ?? "") };
  };
  const get = async (url: string) => JSON.parse((await raw(url)).body) as { features: Record<string, boolean>; ms?: Record<string, unknown> };
  const setFlag = (on: boolean) => app!.inject({ method: "PUT", url: "/api/admin/features", payload: { marketSummary: on } });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await db?.destroy();
    app = undefined;
    db = undefined;
  });

  it("예전 앱 주소(표시 없음)는 요약이 생겨도·플래그를 꺼도 응답과 ETag 가 바이트까지 같다 — features 에 marketSummary 도 없다", async () => {
    await start();
    const before = await Promise.all(OLD_URLS.map((u) => raw(u)));
    await insert(MONDAY);
    const withSummary = await Promise.all(OLD_URLS.map((u) => raw(u)));
    await setFlag(false);
    const off = await Promise.all(OLD_URLS.map((u) => raw(u)));
    OLD_URLS.forEach((u, i) => {
      expect(withSummary[i]!.body, u).toBe(before[i]!.body);
      expect(withSummary[i]!.etag, u).toBe(before[i]!.etag);
      expect(off[i]!.body, u).toBe(before[i]!.body);
      expect(before[i]!.body, u).not.toMatch(/"ms"|marketSummary/);
    });
    // 예전 앱이 받아 둔 ETag 로 물으면 요약이 생긴 뒤에도 304
    expect((await raw(OLD_URLS[3]!, { "if-none-match": before[3]!.etag })).status).toBe(304);
  });

  it("새 앱(&ms=1): 가장 최근 요약의 숫자만 — 월요일 아침은 금요일(9/25) 미국 장, 지수 4개, 내 종목은 개수만", async () => {
    await start();
    await insert(KR_DAY);
    const id = await insert(MONDAY);
    const body = await get(NEW_URL);
    expect(body.features.marketSummary).toBe(true);
    expect(body.ms).toEqual({
      id,
      date: "2026-09-28",
      session: "morning",
      market: "US",
      marketDate: "2026-09-25",
      basisDate: "2026-09-25",
      holiday: null,
      phase: "final",
      asOf: MONDAY.asOf,
      indices: [
        { code: "NASDAQ", name: "나스닥", changeRate: 0.48, date: "2026-09-25" },
        { code: "SPX", name: "S&P500", changeRate: 0.51, date: "2026-09-25" },
        { code: "DJI", name: "다우", changeRate: 0.93, date: "2026-09-25" },
        { code: "SOX", name: "필라반도체", changeRate: 1.41, date: "2026-09-25" },
      ],
      holdings: { compared: 12, high: 2, low: 3, similar: 7 },
    });
    // 문장은 넣지 않는다 ('밤사이'·'오늘'은 앱이 그릴 때 보는 날짜로) — 뉴스·업종·환율도 넣지 않는다
    expect(JSON.stringify(body.ms)).not.toMatch(/밤사이|오늘|뉴스|원\/달러|업종/);
    // 새 앱의 다른 칸은 예전 주소와 같다 (ms·features.marketSummary 만 더해짐)
    const old = await get("/api/widget?indices=1&sessions=1&ui=2");
    const { ms: _ms, ...rest } = body;
    expect({ ...rest, features: { ...rest.features, marketSummary: undefined } }).toEqual({ ...old, features: { ...old.features, marketSummary: undefined } });
  });

  it("한국 휴장 오후(추석): 휴장 날짜·이름과 직전 거래일(9/23) — 앱이 '오늘 한국 휴장'과 날짜를 붙인다", async () => {
    await start();
    await insert(KR_DAY);
    await insert(KR_HOLIDAY);
    const ms = (await get(NEW_URL)).ms!;
    expect(ms).toMatchObject({ date: "2026-09-25", market: "KR", marketDate: "2026-09-25", basisDate: "2026-09-23", holiday: { date: "2026-09-25", name: "추석" } });
    expect((ms.indices as Array<{ date: string }>).map((i) => i.date)).toEqual(["2026-09-23", "2026-09-23"]);
  });

  it("끄면: features.marketSummary 는 false, ms 없음, 요약을 조회하지도 않는다", async () => {
    await start();
    await insert(MONDAY);
    await setFlag(false);
    const list = vi.spyOn(app!.marketSummaries!, "list");
    const body = await get(NEW_URL);
    expect(body.features.marketSummary).toBe(false);
    expect(body).not.toHaveProperty("ms");
    expect(list).not.toHaveBeenCalled();
    // 다시 켜면 바로 (저장된 요약 그대로)
    await setFlag(true);
    expect((await get(NEW_URL)).ms).toMatchObject({ date: "2026-09-28" });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("가장 최근 요약이 실패면 첫 줄 없음 (더 옛 성공 요약을 대신 보이지 않는다). 요약이 없거나 서비스가 없어도 없음", async () => {
    await start();
    expect(await get(NEW_URL)).not.toHaveProperty("ms");
    await insert(KR_DAY);
    await insert(MONDAY, "failed");
    expect(await get(NEW_URL)).not.toHaveProperty("ms");
    await app!.close();
    await db!.destroy();
    await start({ withService: false });
    await insert(MONDAY);
    const body = await get(NEW_URL);
    expect(body.features.marketSummary).toBe(true);
    expect(body).not.toHaveProperty("ms");
  });

  it("요약을 읽다 실패해도 위젯 응답은 첫 줄 없이 나간다", async () => {
    await start();
    await insert(MONDAY);
    vi.spyOn(app!.marketSummaries!, "list").mockRejectedValue(new Error("DB 오류"));
    const r = await raw(NEW_URL);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).not.toHaveProperty("ms");
  });

  it("WV2: 저장된 'ok' 요약의 모양이 달라도(지수 칸 없음·깨진 JSON·지수 항목 null 등) 위젯 응답은 200 — 첫 줄만 빠지고 나머지는 예전과 같다", async () => {
    await start();
    const old = await get("/api/widget?indices=1&sessions=1&ui=2");
    const insertRaw = async (data: string, date: string) =>
      db!
        .insertInto("market_summaries")
        .values({ summary_date: date, session: "morning", market: "US", status: "ok", summary: "요약", data, created_at: `${date}T08:30:05+09:00` })
        .execute();
    const { indices: _i, ...noIndices } = MONDAY;
    const bad = [
      JSON.stringify(noIndices), // 지수 칸이 없는 예전 모양
      JSON.stringify({ ...MONDAY, indices: null }),
      JSON.stringify({ ...MONDAY, indices: [null, 3] }),
      JSON.stringify({ ...MONDAY, indices: "나스닥" }),
      JSON.stringify({ ...MONDAY, holiday: "추석" }),
      JSON.stringify({ ...MONDAY, date: 20260928 }),
      JSON.stringify("문자열"),
      "null",
      "{깨진 JSON",
    ];
    let day = 1;
    for (const data of bad) {
      await insertRaw(data, `2026-10-${String(day++).padStart(2, "0")}`); // 늘 가장 최근 요약이 되게 날짜를 올린다
      const r = await raw(NEW_URL);
      expect(r.status, data).toBe(200);
      const body = JSON.parse(r.body) as Record<string, unknown> & { features: Record<string, boolean> };
      expect(body, data).not.toHaveProperty("ms");
      expect(body.features.marketSummary).toBe(true);
      const { features, ...rest } = body;
      const { features: oldFeatures, ...oldRest } = old as unknown as Record<string, unknown> & { features: Record<string, boolean> };
      expect(rest, data).toEqual(oldRest);
      expect({ ...features, marketSummary: undefined }).toEqual({ ...oldFeatures, marketSummary: undefined });
    }
  });

  it("WV2: 요약 목록이 이상한 값(undefined)을 주거나 동기로 던져도 위젯 응답은 200, 첫 줄 없음", async () => {
    await start();
    await insert(MONDAY);
    const list = vi.spyOn(app!.marketSummaries!, "list");
    list.mockResolvedValue(undefined as unknown as MarketSummary[]);
    let r = await raw(NEW_URL);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).not.toHaveProperty("ms");
    list.mockImplementation(() => {
      throw new Error("동기 오류");
    });
    r = await raw(NEW_URL);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).not.toHaveProperty("ms");
  });

  it("ETag: 새 요약이 저장되면 새 앱(&ms=1)의 ETag 는 바뀌고(새 첫 줄을 받게), 예전 앱의 ETag 는 그대로", async () => {
    await start();
    await insert(KR_DAY);
    const [n1, o1] = [await raw(NEW_URL), await raw(OLD_URLS[3]!)];
    await insert(MONDAY);
    const [n2, o2] = [await raw(NEW_URL), await raw(OLD_URLS[3]!)];
    expect(n2.etag).not.toBe(n1.etag);
    expect(o2.etag).toBe(o1.etag);
    // 같은 요약이면 304
    expect((await raw(NEW_URL, { "if-none-match": n2.etag })).status).toBe(304);
  });
});

describe("widgetSummary (순수 함수)", () => {
  const row = (d: MarketSummaryData | null, status: "ok" | "failed" = "ok"): MarketSummary => ({ id: 3, date: d?.date ?? "2026-09-28", session: "morning", market: "US", status, summary: "", createdAt: "2026-09-28T08:30:05+09:00", data: d });

  it("실패·데이터 없음·지수를 하나도 못 받은 요약은 null", () => {
    expect(widgetSummary(null)).toBeNull();
    expect(widgetSummary(undefined)).toBeNull();
    expect(widgetSummary(row(MONDAY, "failed"))).toBeNull();
    expect(widgetSummary(row(null))).toBeNull();
    expect(widgetSummary(row({ ...MONDAY, indices: MONDAY.indices.map((i) => ({ ...i, changeRate: null })) }))).toBeNull();
  });

  it("받지 못한 지수는 changeRate null 로 그대로(순서 유지), 비교한 종목이 없으면 holdings null, 등락률은 소수 둘째 자리", () => {
    const d: MarketSummaryData = {
      ...MONDAY,
      indices: MONDAY.indices.map((i, k) => (k === 1 ? { ...i, changeRate: null, missing: "받지 못함" } : k === 0 ? { ...i, changeRate: 0.4800000001 } : i)),
      holdings: MONDAY.holdings ? { ...MONDAY.holdings, compared: 0, high: [], low: [], similar: [] } : null,
    };
    const w = widgetSummary(row(d))!;
    expect(w.indices.map((i) => i.changeRate)).toEqual([0.48, null, 0.93, 1.41]);
    expect(w.holdings).toBeNull();
  });

  it("WV2: 모양이 다른 저장본은 던지지 않고 null (예전 모양·칸 빠짐·깨진 값). 내 종목 칸만 깨졌으면 지수 첫 줄은 두고 holdings 만 null", () => {
    const raw = (data: unknown) => row(data as MarketSummaryData);
    const { indices: _i, ...noIndices } = MONDAY;
    for (const d of [
      noIndices,
      { ...MONDAY, indices: null },
      { ...MONDAY, indices: {} },
      { ...MONDAY, indices: [null] },
      { ...MONDAY, indices: [{ code: 1, name: "나스닥", changeRate: 0.4 }] },
      { ...MONDAY, session: "evening" },
      { ...MONDAY, market: "JP" },
      { ...MONDAY, phase: undefined },
      { ...MONDAY, basisDate: null },
      { ...MONDAY, holiday: { name: "추석" } },
      "문자열",
      42,
      [],
    ]) {
      expect(() => widgetSummary(raw(d)), JSON.stringify(d).slice(0, 60)).not.toThrow();
      expect(widgetSummary(raw(d)), JSON.stringify(d).slice(0, 60)).toBeNull();
    }
    // 등락률이 문자열·NaN 이면 그 지수만 받지 못한 것으로
    const w = widgetSummary(raw({ ...MONDAY, indices: MONDAY.indices.map((i, k) => (k === 2 ? { ...i, changeRate: "0.93" } : k === 3 ? { ...i, changeRate: Number.NaN } : i)) }))!;
    expect(w.indices.map((i) => i.changeRate)).toEqual([0.48, 0.51, null, null]);
    // 내 종목 칸이 깨졌으면 둘째 줄만 빠진다
    expect(widgetSummary(raw({ ...MONDAY, holdings: { compared: 12, high: 2, low: 3, similar: 7 } }))!.holdings).toBeNull();
    expect(widgetSummary(raw({ ...MONDAY, holdings: "12종목" }))!.holdings).toBeNull();
    expect(widgetSummary(raw({ ...MONDAY, holdings: { ...MONDAY.holdings, compared: "12" } }))!.holdings).toBeNull();
    // 게터가 던지는 이상한 객체도 null
    const trap = { ...MONDAY };
    Object.defineProperty(trap, "indices", { get: () => { throw new Error("깨진 값"); }, enumerable: true });
    expect(widgetSummary(raw(trap))).toBeNull();
  });

  it("buildWidgetPayload: 넘긴 첫 줄만 ms 로 (없으면 칸도 없음)", () => {
    const w = widgetSummary(row(MONDAY))!;
    expect(buildWidgetPayload([], [], null, { summary: w }).ms).toBe(w);
    expect(buildWidgetPayload([], [], null, { summary: null })).not.toHaveProperty("ms");
    expect(buildWidgetPayload([], [], null, {})).not.toHaveProperty("ms");
  });
});
