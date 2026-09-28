import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { NotListedError } from "../src/lib/errors.js";
import { eventsComplete, SCHEDULE_EVENTS_BUDGET_MS } from "../src/routes/filings.js";
import { EVENTS_BUDGET_MS, HoldingEventsService, type HoldingEventSources } from "../src/services/holdingEvents.js";
import { fakeProviders } from "./helpers.js";

/**
 * 3-38 새 공시 알림·일정 화면 — 경로와 위젯 칸 (플래그 filingAlerts·holdingSchedule).
 *  - GET /api/filings/alerts?days=1~3 · GET /api/schedule (둘 다 개인 경로 — 보유 종목으로 거름) · /api/widget &ms=1 의 filingIds · /health 의 filingAlerts
 *  - 끄면 404 · 칸 없음 · 위젯 본문·ETag 가 바이트까지 예전과 같음
 * 녹화한 SEC 응답을 그 시각까지만 돌려주는 가짜 출처 + 고정 시계 (수 7/29 15:00 ET 기준 잡기 → 16:10 ET 새 줄 → 한국 7/30(목) 07:03)
 */
type SubDoc = { filings: { recent: Record<string, unknown[]> } };
const SUB = (t: string): SubDoc => JSON.parse(readFileSync(new URL(`./fixtures/secFilings/sub_${t}.json`, import.meta.url), "utf8")) as SubDoc;
const TICKERS = JSON.parse(readFileSync(new URL("./fixtures/secFilings/company_tickers.json", import.meta.url), "utf8")) as Record<string, { cik_str: number; ticker: string }>;
const CIK = Object.fromEntries(Object.values(TICKERS).map((v) => [v.ticker, String(v.cik_str).padStart(10, "0")])) as Record<string, string>;
const FIXTURE = JSON.parse(readFileSync(new URL("../../shared/fixtures/filingAlerts.json", import.meta.url), "utf8")) as {
  clock: { baseline: string; sweep: string; now: string };
  holdings: Array<{ code: string; name: string }>;
  items: unknown[];
  total: number;
  alerts: unknown[];
};

function asOf(doc: SubDoc, at: Date): SubDoc {
  const r = doc.filings.recent;
  const keep = (r["acceptanceDateTime"] as string[]).map((a, i) => (Date.parse(a) <= at.getTime() ? i : -1)).filter((i) => i >= 0);
  return { ...doc, filings: { recent: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, keep.map((i) => v[i])])) } };
}

const NEW_URL = "/api/widget?indices=1&sessions=1&ui=2&ms=1";

describe("3-38 경로", () => {
  let db: Db | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    await db?.destroy();
    app = undefined;
    db = undefined;
  });

  async function start(opts: { dart?: boolean; events?: boolean; holdings?: Array<{ code: string; name: string; quantity?: number | null }> } = {}) {
    db = await createMigratedDb(":memory:");
    const clock = { now: new Date(FIXTURE.clock.baseline) };
    const sec = { resolves: 0, subs: 0 };
    const holdingEvents: HoldingEventSources = {
      dividends: async (code) => {
        return code === "MSFT" ? [{ exDate: "2026-08-20", payDate: "2026-09-10", cash: 0.91, currency: "USD" } as never] : [];
      },
      calendar: async () => {
        throw new Error("캘린더는 부르지 않는다 (holdingEarnings 꺼짐)");
      },
      productCode: async (code) => code,
    };
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:", ...(opts.dart ? { DART_API_KEY: "test-dart-key" } : {}) }),
      db,
      providers: fakeProviders({
        secFilings: {
          resolveCik: async (code) => {
            sec.resolves++;
            if (!CIK[code]) throw new NotListedError("edgar", code);
            return { cik: CIK[code]! };
          },
          submissionsJson: async (cik) => {
            sec.subs++;
            const t = Object.entries(CIK).find(([, c]) => c === cik)![0];
            return asOf(SUB(t), clock.now);
          },
        },
        ...(opts.events ? { holdingEvents } : {}),
      }),
      logger: false,
      enableScheduler: false,
      now: () => clock.now,
    });
    const rows = opts.holdings ?? FIXTURE.holdings;
    for (const [i, h] of rows.entries()) {
      await db
        .insertInto("registered_stocks")
        .values({ code: h.code, name: h.name, market: /^\d{6}$/.test(h.code) ? "KOSPI" : "NASDAQ", quantity: "quantity" in h ? (h.quantity ?? null) : 3, avg_price: 100, memo: null, created_at: `2026-01-0${i + 1}T00:00:00Z`, updated_at: "x" })
        .execute();
    }
    const at = (iso: string) => void (clock.now = new Date(iso));
    return { clock, sec, at };
  }

  /** 기준 잡기 → 새 줄 → 한국 7/30 07:03 (그때도 5분마다 확인 — 새 줄 없음) */
  async function sweepToNow(at: (iso: string) => void) {
    await app!.filingWatch!.sweep();
    at(FIXTURE.clock.sweep);
    await app!.filingWatch!.sweep();
    at(FIXTURE.clock.now);
    expect(await app!.filingWatch!.sweep()).toMatchObject({ inserted: 0 });
  }

  const get = (url: string) => app!.inject({ method: "GET", url });
  const off = (patch: Record<string, boolean>) => app!.inject({ method: "PUT", url: "/api/admin/features", payload: patch });

  it("GET /api/filings/alerts: 새 줄만 · 최신 먼저 · 한국·미국 동부 벽시계 글 — 공용 픽스처와 같음", async () => {
    const { at } = await start();
    await sweepToNow(at);
    const r = await get("/api/filings/alerts?days=3");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ asOf: "2026-07-30T07:03:00+09:00", items: FIXTURE.alerts });
    expect((await get("/api/filings/alerts")).json().items).toEqual(FIXTURE.alerts);
    // 서버가 처음 본 때가 하루 안 (16:10 ET = 20:10Z, 지금 22:03Z)
    expect((await get("/api/filings/alerts?days=1")).json().items).toHaveLength(2);
    for (const bad of ["0", "4", "x", "1.5"]) expect((await get(`/api/filings/alerts?days=${bad}`)).statusCode, bad).toBe(400);
  });

  it("판 종목은 다음 요청부터 목록·알림에서 빠진다 (보유 수량 0 = 관심 종목)", async () => {
    const { at } = await start();
    await sweepToNow(at);
    await db!.updateTable("registered_stocks").set({ quantity: null }).where("code", "=", "MSFT").execute();
    expect((await get("/api/filings/alerts")).json().items).toEqual([]);
    expect(((await get("/api/schedule")).json() as { filings: { items: Array<{ code: string }> } }).filings.items.some((i) => i.code === "MSFT")).toBe(false);
  });

  it("GET /api/schedule: 최근 30일 공시(공용 픽스처와 같음) · 한국 공시 안내(noDartKey) · 일정 출처가 없으면 events null", async () => {
    const { at } = await start();
    await sweepToNow(at);
    const body = (await get("/api/schedule")).json();
    expect(body).toMatchObject({ asOf: "2026-07-30T07:03:00+09:00", events: null, kr: { filings: "noDartKey" } });
    expect(body.filings.items).toEqual(FIXTURE.items);
    expect(body.filings).toMatchObject({ more: 0, watched: 5, notCovered: [], failed: [], pending: [], warning: null, lastOkAt: "2026-07-30T07:03:00+09:00" });
    expect(FIXTURE.total).toBe(FIXTURE.items.length);
    // 오류가 없으면 실패 칸은 없다
    expect(body).not.toHaveProperty("eventsFailed");
    expect(body).not.toHaveProperty("filingsFailed");
  });

  it("GET /api/schedule: 일정 모으기는 앱 요청 제한(20초)보다 짧은 한도로 · 한쪽이 오류여도 다른 쪽은 그대로 (eventsFailed·filingsFailed)", async () => {
    const { at } = await start({ events: true });
    await sweepToNow(at);
    // 앱 holdingSchedule 요청 제한 20초 (app/src/api/client.ts) — 일정이 느려도 공시 목록과 함께 그 안에 답하게
    expect(SCHEDULE_EVENTS_BUDGET_MS).toBeLessThanOrEqual(12_000);
    expect(SCHEDULE_EVENTS_BUDGET_MS).toBeLessThan(EVENTS_BUDGET_MS);
    const collect = vi.spyOn(HoldingEventsService.prototype, "collect");
    await get("/api/schedule");
    expect(collect.mock.calls[0]![0]).toMatchObject({ budgetMs: SCHEDULE_EVENTS_BUDGET_MS });
    // 일정 오류: 공시 목록은 그대로
    collect.mockRejectedValueOnce(new Error("토스 배당 요약 오류"));
    at("2026-07-29T22:30:00Z");
    let r = await get("/api/schedule");
    expect(r.statusCode).toBe(200);
    let body = r.json();
    expect(body).toMatchObject({ events: null, eventsFailed: true, kr: { filings: "noDartKey" } });
    expect(body.filings.items).toHaveLength(FIXTURE.items.length);
    expect(body).not.toHaveProperty("filingsFailed");
    collect.mockRestore();
    // 공시 목록 오류: 일정은 그대로
    const list = vi.spyOn(app!.filingWatch!, "list").mockRejectedValueOnce(new Error("db 오류"));
    r = await get("/api/schedule");
    expect(r.statusCode).toBe(200);
    body = r.json();
    expect(body).toMatchObject({ filings: null, filingsFailed: true, events: { days: 30 } });
    expect(body).not.toHaveProperty("eventsFailed");
    list.mockRestore();
  });

  it("GET /api/schedule: DART 키가 있으면 notYet, 다가오는 일정은 holdingEvents 를 따르고 holdingEarnings 는 읽기만(캘린더 호출 0) · 일정은 10분 캐시(보유가 바뀌면 새로)", async () => {
    const { at } = await start({ dart: true, events: true });
    const collect = vi.spyOn(HoldingEventsService.prototype, "collect");
    await sweepToNow(at);
    const body = (await get("/api/schedule")).json();
    expect(body.kr).toEqual({ filings: "notYet" });
    expect(body.events).toMatchObject({ days: 30, earnings: false, earningsFailed: false, week: null, us: 5, kr: 0, items: [{ code: "MSFT", kind: "exDividend", date: "2026-08-20", amount: 0.91 }] });
    expect((await get("/api/features")).json().features.holdingEarnings).toBe(false);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0]![0]).toMatchObject({ today: "2026-07-30", asOf: "2026-07-30T07:03:00+09:00", earnings: false });
    at("2026-07-29T22:12:00Z");
    await get("/api/schedule");
    expect(collect).toHaveBeenCalledTimes(1);
    await db!.insertInto("registered_stocks").values({ code: "O", name: "리얼티인컴", market: "NYSE", quantity: 1, avg_price: 50, memo: null, created_at: "2026-02-01T00:00:00Z", updated_at: "x" }).execute();
    await get("/api/schedule");
    expect(collect).toHaveBeenCalledTimes(2);
    at("2026-07-29T22:23:00Z");
    await get("/api/schedule");
    expect(collect).toHaveBeenCalledTimes(3);
    collect.mockRestore();
    // holdingEvents 를 끄면 events null, filingAlerts 를 끄면 filings null
    await off({ holdingEvents: false, filingAlerts: false });
    expect((await get("/api/schedule")).json()).toMatchObject({ events: null, filings: null, kr: { filings: "notYet" } });
  });

  it("GET /api/schedule: 받지 못한 종목·실적이 섞인 일정은 캐시하지 않는다 (다시 열면 다시 모음) — 모두 받은 일정만 10분 캐시 (3-38 리뷰 3)", async () => {
    const { at } = await start({ events: true });
    await sweepToNow(at);
    const real = HoldingEventsService.prototype.collect;
    const collect = vi.spyOn(HoldingEventsService.prototype, "collect");
    // 1) 10초 한도로 MSFT 배당을 받지 못함 → 캐시하지 않음
    collect.mockImplementationOnce(async function (this: HoldingEventsService, input) {
      const v = await real.call(this, input);
      return { ...v, items: [], failed: [{ code: "MSFT", name: "마이크로소프트" }] };
    });
    let body = (await get("/api/schedule")).json();
    expect(body.events.failed).toEqual([{ code: "MSFT", name: "마이크로소프트" }]);
    // 2) 1분 뒤 다시 열면 다시 모은다 (뒤에서 받기가 끝났으면 채워짐)
    at("2026-07-29T22:04:00Z");
    body = (await get("/api/schedule")).json();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(body.events.failed).toEqual([]);
    expect(body.events.items).toMatchObject([{ code: "MSFT", kind: "exDividend" }]);
    // 3) 모두 받은 일정은 10분 캐시
    at("2026-07-29T22:10:00Z");
    await get("/api/schedule");
    expect(collect).toHaveBeenCalledTimes(2);
    // 실적을 받지 못한 결과도 캐시하지 않는다
    at("2026-07-29T22:30:00Z");
    collect.mockImplementationOnce(async function (this: HoldingEventsService, input) {
      return { ...(await real.call(this, input)), earningsFailed: true };
    });
    await get("/api/schedule");
    at("2026-07-29T22:31:00Z");
    await get("/api/schedule");
    expect(collect).toHaveBeenCalledTimes(4);
    collect.mockRestore();
    expect(eventsComplete({ failed: [], earningsFailed: false })).toBe(true);
    expect(eventsComplete({ failed: [{ code: "O", name: "리얼티인컴" }], earningsFailed: false })).toBe(false);
    expect(eventsComplete({ failed: [], earningsFailed: true })).toBe(false);
  });

  it("끄면: 경로 404 (holdingSchedule · filingAlerts), 확인 작업 SEC 호출 0", async () => {
    const { sec } = await start();
    await off({ filingAlerts: false, holdingSchedule: false });
    expect((await get("/api/filings/alerts")).statusCode).toBe(404);
    expect((await get("/api/schedule")).statusCode).toBe(404);
    expect(await app!.filingWatch!.sweep()).toMatchObject({ ran: false, reason: "off" });
    expect(sec).toEqual({ resolves: 0, subs: 0 });
  });

  it("/api/widget: 지금 앱(&ms=1)·켬·새 알림이 있을 때만 filingIds, 끄거나 새 알림이 없거나 예전 앱이면 본문·ETag 가 바이트까지 같음", async () => {
    const { at } = await start();
    await app!.filingWatch!.sweep();
    const before = await get(NEW_URL);
    expect(before.json()).not.toHaveProperty("filingIds");
    const beforeOld = await get("/api/widget");
    at(FIXTURE.clock.sweep);
    await app!.filingWatch!.sweep();
    at(FIXTURE.clock.now);
    const on = await get(NEW_URL);
    expect(on.json().filingIds).toEqual(["0001193125-26-323660", "0001193125-26-323632"]);
    // 칸만 더해졌다
    const { filingIds: _ids, ...rest } = on.json() as Record<string, unknown>;
    expect(JSON.stringify(rest)).toBe(before.body);
    expect(on.headers.etag).not.toBe(before.headers.etag);
    // 예전 앱(표시 없음)은 그대로
    const old = await get("/api/widget");
    expect(old.body).toBe(beforeOld.body);
    expect(old.headers.etag).toBe(beforeOld.headers.etag);
    // 끄면 바이트까지 같다
    await off({ filingAlerts: false });
    const offRes = await get(NEW_URL);
    expect(offRes.body).toBe(before.body);
    expect(offRes.headers.etag).toBe(before.headers.etag);
    // 하루 넘게 지나 알림 기간(3일)이 끝나도 칸 없음
    await off({ filingAlerts: true });
    at("2026-08-02T00:00:00Z");
    expect((await get(NEW_URL)).json()).not.toHaveProperty("filingIds");
  });

  it("/health: 켜져 있을 때만 filingAlerts (마지막으로 모두 받은 시각 · 확인 종목 수 · 경고)", async () => {
    const { at } = await start({ holdings: [...FIXTURE.holdings, { code: "QQQ", name: "Invesco QQQ ETF" }, { code: "005930", name: "삼성전자" }] });
    await sweepToNow(at);
    expect((await get("/health")).json().filingAlerts).toEqual({ lastOkAt: "2026-07-30T07:03:00+09:00", watched: 5, notCovered: 1, failed: [], warning: null });
    // 확인이 멈추면 (SEC 접수 시간에 30분 넘게) stale
    at("2026-07-29T22:40:00Z");
    expect((await get("/health")).json().filingAlerts.warning).toBe("stale");
    await off({ filingAlerts: false });
    expect((await get("/health")).json()).not.toHaveProperty("filingAlerts");
  });

  it("출처를 두지 않은 서버(테스트 기본): 알림 빈 목록 · 화면 filings null · 위젯 칸 없음 · /health 칸 없음", async () => {
    db = await createMigratedDb(":memory:");
    app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(), logger: false, enableScheduler: false });
    expect(app.filingWatch).toBeNull();
    expect((await get("/api/filings/alerts")).json().items).toEqual([]);
    expect((await get("/api/schedule")).json()).toMatchObject({ events: null, filings: null, kr: { filings: "noDartKey" } });
    expect((await get(NEW_URL)).json()).not.toHaveProperty("filingIds");
    expect((await get("/health")).json()).not.toHaveProperty("filingAlerts");
  });
});
