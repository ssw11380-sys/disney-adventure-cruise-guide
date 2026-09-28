import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { FeatureService } from "../src/services/featureService.js";
import { JournalService, minuteKey, type JournalFxSources } from "../src/services/journalService.js";
import { REASONS } from "../src/services/journalCalc.js";
import { TAX_EXCLUDE_REASON } from "../src/services/taxRules.js";
import { fakeProviders } from "./helpers.js";

/**
 * 매매일지 (3-37, 플래그 tradeJournal) — 서버 경로. DB 에 3-36 모양의 스냅샷·체결을 직접 넣고(예시 값 — 실제 계좌와 무관) 고정 시계로 묻는다. 네트워크 없음.
 * 계좌 3:
 *  - SOXL(미국): 9/1 10주 $320.40 · 9/23 20주 $700 매수, 9/25 5주 $187.50 매도 → 첫 미국 스냅샷(9/25, 25주 $850.33)과 맞음 → 'history-checked' +$17.43 · 원화 +24,703원
 *  - 삼성전자: 9/23 스냅샷 10주 700,000원 → 매도 주문 1건이 9/28·9/29 두 날에 2주씩 (며칠에 걸친 부분 체결) → 몫마다 +10,000원
 *  - NAVER: 주문 없이 9/23 10주 → 9/28 20주 (이관 추정 줄)
 */

const TS = (s: string) => `${s}+09:00`;
const NOW = new Date("2026-09-30T20:00:00+09:00");

type H = { code: string; name: string; qty: number; cost: number; price: number; costKrw?: number | null; account?: number };
function snapRow(date: string, market: "KR" | "US", asOf: string, holdings: H[], extra: { doubts?: unknown[]; fx?: number; accounts?: number[] } = {}) {
  const data = {
    version: 1,
    priceBasis: "",
    regularCloseBasis: "",
    fx: market === "US" ? { usdKrw: extra.fx ?? 1390, source: "toss", asOf } : null,
    holdings: holdings.map((h) => ({
      account: h.account ?? 3,
      code: h.code,
      name: h.name,
      currency: market === "KR" ? "KRW" : "USD",
      quantity: h.qty,
      avgPrice: h.qty ? Math.round((h.cost / h.qty) * 1e4) / 1e4 : null,
      price: h.price,
      regularClose: h.price,
      regularCloseSource: "naver",
      purchaseAmount: h.cost,
      marketValue: h.qty * h.price,
      marketValueAfterCost: h.qty * h.price * 0.998,
      valueKrw: null,
      valueAfterCostKrw: null,
      costKrw: market === "US" ? (h.costKrw ?? null) : h.cost,
      costKrwSource: market === "US" ? (h.costKrw ? "book-exact" : null) : "toss",
    })),
    totals: { holdings: holdings.length, valueKrw: null, valueAfterCostKrw: null, costKrw: null, valueUsd: null, costUsd: null },
    accounts: (extra.accounts ?? [3]).map((account) => ({ account, purchaseKrw: 0, purchaseUsd: 0, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null })),
    ...(extra.doubts ? { doubts: extra.doubts } : {}),
  };
  return {
    snapshot_date: date,
    market,
    status: "ok",
    method: "close",
    as_of: asOf,
    scheduled_at: asOf,
    source: "toss-openapi",
    reason: null,
    holdings_count: holdings.length,
    total_value_krw: null,
    data: JSON.stringify(data),
    created_at: asOf,
    updated_at: asOf,
  };
}

type F = { q: number; a: number; at: string; basis?: "filled" | "ordered" | "seen" };
function tradeRow(orderId: string, code: string, side: "BUY" | "SELL", fills: F[], opts: { status?: "CLOSED" | "OPEN"; raw?: Record<string, unknown>; account?: number } = {}) {
  const q = fills.reduce((s, f) => s + f.q, 0);
  const a = fills.reduce((s, f) => s + f.a, 0);
  const last = fills.at(-1)!;
  const kr = /^\d/.test(code);
  return {
    account: opts.account ?? 3,
    order_id: orderId,
    code,
    market: kr ? "KR" : "US",
    side,
    quantity: q,
    amount: a,
    price: Math.round((a / q) * 1e6) / 1e6,
    currency: kr ? "KRW" : "USD",
    fee: null,
    tax: null,
    executed_at: last.at,
    executed_date: last.at.slice(0, 10),
    time_basis: last.basis ?? "filled",
    order_status: opts.status ?? "CLOSED",
    source: "toss-orders",
    raw: JSON.stringify(opts.raw ?? { orderId, side }),
    fills: JSON.stringify(fills.map((f) => ({ q: f.q, a: f.a, at: f.at, basis: f.basis ?? "filled", seenAt: f.at }))),
    created_at: last.at,
    updated_at: last.at,
  };
}

async function seed(db: Db) {
  await db
    .insertInto("account_snapshots")
    .values([
      snapRow("2026-09-23", "KR", TS("2026-09-23T16:05:00"), [
        { code: "005930", name: "삼성전자", qty: 10, cost: 700_000, price: 72_000 },
        { code: "035420", name: "NAVER", qty: 10, cost: 2_000_000, price: 210_000 },
      ]),
      snapRow("2026-09-25", "US", TS("2026-09-26T05:05:00"), [{ code: "SOXL", name: "SOXL", qty: 25, cost: 850.33, price: 38, costKrw: 1_179_047 }]),
      snapRow("2026-09-28", "KR", TS("2026-09-28T16:05:00"), [
        { code: "005930", name: "삼성전자", qty: 8, cost: 560_000, price: 75_000 },
        { code: "035420", name: "NAVER", qty: 20, cost: 4_300_000, price: 220_000 },
      ]),
      snapRow("2026-09-29", "KR", TS("2026-09-29T16:05:00"), [
        { code: "005930", name: "삼성전자", qty: 6, cost: 420_000, price: 76_000 },
        { code: "035420", name: "NAVER", qty: 20, cost: 4_300_000, price: 221_000 },
      ]),
    ])
    .execute();
  await db
    .insertInto("trade_executions")
    .values([
      tradeRow("o1", "SOXL", "BUY", [{ q: 10, a: 320.4, at: TS("2026-09-01T23:00:00") }]),
      tradeRow("o2", "SOXL", "BUY", [{ q: 20, a: 700, at: TS("2026-09-23T23:00:00") }]),
      tradeRow("o3", "SOXL", "SELL", [{ q: 5, a: 187.5, at: TS("2026-09-25T23:10:04") }]),
      tradeRow("k1", "005930", "SELL", [
        { q: 2, a: 150_000, at: TS("2026-09-28T10:00:00") },
        { q: 2, a: 150_000, at: TS("2026-09-29T10:00:00") },
      ]),
    ])
    .execute();
  const f = (at: string, rate: number) => ({ kind: "toss-usdkrw", at: minuteKey(at), rate, source: "toss", fetched_at: at });
  await db.insertInto("fx_rates").values([f(TS("2026-09-01T23:00:00"), 1390), f(TS("2026-09-23T23:00:00"), 1385), f(TS("2026-09-25T23:10:04"), 1389.4)]).execute();
  await db.insertInto("registered_stocks").values({ code: "005930", name: "삼성전자", market: "KOSPI", quantity: 6, avg_price: 70_000, memo: "장기 보유", created_at: "x", updated_at: "x" }).execute();
}

async function setup(opts: { now?: Date; flags?: Record<string, boolean>; seed?: boolean } = {}) {
  const db = await createMigratedDb(":memory:");
  if (opts.seed !== false) await seed(db);
  const now = () => opts.now ?? NOW;
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(), logger: false, enableScheduler: false, now });
  if (opts.flags) await app.inject({ method: "PUT", url: "/api/admin/features", payload: opts.flags });
  const get = async (url: string) => {
    const r = await app.inject({ method: "GET", url });
    return { status: r.statusCode, body: r.json() };
  };
  return { db, app, get };
}

describe("매매일지 목록 (GET /api/journal)", () => {
  it("날짜별(새것부터)·몫마다 한 줄, 매도는 이동평균법 실현손익, 요약 합계 = 줄의 합", async () => {
    const { get, app } = await setup();
    const { status, body } = await get("/api/journal?from=2026-09-01&to=2026-09-30");
    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.recordSince).toBe("2026-09-23");
    expect(body.verified).toEqual({ krRealized: false, usRealizedUsd: false, usRealizedKrw: false, headline: "gross" });
    expect(body.days.map((d: { date: string }) => d.date)).toEqual(["2026-09-29", "2026-09-28", "2026-09-25", "2026-09-23", "2026-09-01"]);
    const all = body.days.flatMap((d: { items: unknown[] }) => d.items) as Array<Record<string, any>>;
    const o3 = all.find((x) => x.orderId === "o3")!;
    expect(o3).toMatchObject({ kind: "fill", code: "SOXL", name: "SOXL", side: "SELL", currency: "USD", quantity: 5, amount: 187.5, price: 37.5, timeBasis: "filled", part: null, note: null });
    expect(o3.realized).toMatchObject({ status: "ok", basis: "history-checked", anchorDate: "2026-09-25", gross: 17.43, rate: 10.25, costAmount: 170.07 });
    expect(o3.realized.krw).toMatchObject({ gross: 24_703, sellFx: 1389.4, estimated: true });
    // 며칠에 걸친 부분 체결: 몫마다 한 줄 + '이 날 2주 (주문 4주 중)'
    const k1 = all.filter((x) => x.orderId === "k1");
    expect(k1.map((x) => [x.quantity, x.orderQuantity, x.part, x.realized.gross, x.realized.basis])).toEqual([
      [2, 4, { index: 2, count: 2 }, 10_000, "snapshot"],
      [2, 4, { index: 1, count: 2 }, 10_000, "snapshot"],
    ]);
    // 매수 상세: 이 매수 뒤 평균 구매가
    expect(all.find((x) => x.orderId === "o2")!.afterBuy).toEqual({ avgCost: 34.0133, quantity: 30 });
    // 주문 내역으로 설명되지 않은 수량 변화 줄 (주문 없이 수량이 는 NAVER — 무엇이 달라졌는지, 짐작 이름표 없음)
    const chg = all.find((x) => x.kind === "change")!;
    expect(chg).toMatchObject({ code: "035420", name: "NAVER", side: null, quantity: 10, realized: null, change: { kind: "unexplained", qty: 10, text: "수량 10 → 20주 · 그 사이 기록된 매매 없음", guess: null } });
    // 요약: 매도마다 반올림한 값의 합 · 계산에서 뺀 매도 없음
    expect(body.summary).toMatchObject({ orders: 4, buys: 2, sells: 2, unknownSells: 0, excludedSells: [], costs: { toss: 0, estimated: 2, none: 1 } }); // 미국 매도는 첫 미국 스냅샷 전이라 비용 비율이 없음
    expect(body.summary.realized).toEqual({ KRW: 20_000, USD: 17.43, krwTotal: 44_703, krwTotalEstimated: true, estimatedIncluded: false });
    const dayK = body.days.find((d: { date: string }) => d.date === "2026-09-28");
    expect(dayK.realized).toMatchObject({ KRW: 10_000, USD: null });
    expect(body.stocks).toEqual([
      { code: "SOXL", name: "SOXL", count: 3 },
      { code: "005930", name: "삼성전자", count: 1 },
    ]);
    await app.close();
  });

  it("목록 건수 = 저장한 체결 건수: 기간 안에 몫이 있는 주문 수를 DB 로 센 수와 같다 (며칠 부분 체결은 1건, §9-16)", async () => {
    const { get, db, app } = await setup();
    const n = Number((await sql<{ n: number }>`select count(*) as n from trade_executions`.execute(db)).rows[0]!.n);
    expect((await get("/api/journal?from=2026-09-01&to=2026-09-30")).body.summary.orders).toBe(n);
    // 9/29 하루만: k1 의 둘째 몫만 있어도 주문 1건
    const one = (await get("/api/journal?from=2026-09-29&to=2026-09-29")).body;
    expect(one.summary.orders).toBe(1);
    expect(one.days[0].items).toHaveLength(1);
    await app.close();
  });

  it("종목으로 거르면 그 종목 줄만 + 머리 카드 (지금 보유·기록된 실현손익·종목 메모)", async () => {
    const { get, app } = await setup();
    const { body } = await get("/api/journal?from=2026-09-01&to=2026-09-30&code=005930");
    expect(new Set(body.days.flatMap((d: { items: Array<{ code: string }> }) => d.items.map((x) => x.code)))).toEqual(new Set(["005930"]));
    expect(body.head).toMatchObject({
      code: "005930",
      name: "삼성전자",
      holding: { quantity: 6, avgCost: 70_000, currency: "KRW", asOf: TS("2026-09-29T16:05:00") },
      orders: 1,
      buys: 0,
      sells: 1,
      realized: { amount: 20_000, currency: "KRW", sells: 2, unknown: 0 },
      firstTrade: "2026-09-28",
      lastTrade: "2026-09-29",
      memo: "장기 보유",
    });
    // 종목 고르기 목록은 종목을 골랐어도 기간 안 체결이 있는 모든 종목 (다른 종목으로 바로 바꿀 수 있게)
    expect(body.stocks).toEqual([
      { code: "SOXL", name: "SOXL", count: 3 },
      { code: "005930", name: "삼성전자", count: 1 },
    ]);
    const st = (await get("/api/journal/stock/SOXL")).body;
    expect(st).toMatchObject({ enabled: true, code: "SOXL", holding: { quantity: 25, avgCost: 34.0132 }, orders: 3, realized: { amount: 17.43, currency: "USD" } });
    await app.close();
  });

  it("기간 검증: from > to · 400일 넘음 · 틀린 종목 코드는 400", async () => {
    const { get, app } = await setup();
    expect((await get("/api/journal?from=2026-09-30&to=2026-09-01")).status).toBe(400);
    expect((await get("/api/journal?from=2025-01-01&to=2026-09-30")).status).toBe(400);
    expect((await get("/api/journal?code=../x")).status).toBe(400);
    await app.close();
  });
});

describe("거래 메모 (PUT /api/journal/notes)", () => {
  it("저장·목록에 보임·빈 글이면 지움, 토스 동기화로 같은 주문을 다시 받아도 메모 그대로 (§9-25)", async () => {
    const { app, get, db } = await setup();
    const put = (payload: unknown) => app.inject({ method: "PUT", url: "/api/journal/notes", payload });
    const r = await put({ account: 3, orderId: "o3", note: "  실적 발표 뒤 일부 정리  " });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ account: 3, orderId: "o3", note: "실적 발표 뒤 일부 정리" });
    const note = async () => (await get("/api/journal?from=2026-09-01&to=2026-09-30")).body.days.flatMap((d: { items: Array<{ orderId: string; note: string | null }> }) => d.items).find((x: { orderId: string }) => x.orderId === "o3").note;
    expect(await note()).toBe("실적 발표 뒤 일부 정리");
    // 토스 동기화가 같은 주문을 고쳐 써도(누적 값·시각 갱신) 메모는 다른 표라 그대로
    await db.updateTable("trade_executions").set({ updated_at: TS("2026-09-30T09:00:00"), order_status: "CLOSED" }).where("order_id", "=", "o3").execute();
    expect(await note()).toBe("실적 발표 뒤 일부 정리");
    // 줄바꿈은 빈칸으로, 제어 문자는 지운다
    const ctrl = String.fromCharCode(1);
    expect((await put({ account: 3, orderId: "o3", note: `첫 줄\n둘째${ctrl} 줄` })).json().note).toBe("첫 줄 둘째 줄");
    // 빈 글 → 지움
    expect((await put({ account: 3, orderId: "o3", note: "" })).json().note).toBeNull();
    expect(await db.selectFrom("trade_notes").selectAll().execute()).toEqual([]);
    expect(await note()).toBeNull();
    await app.close();
  });

  it("200자 넘음·제어 문자만은 400, 없는 주문은 404", async () => {
    const { app } = await setup();
    const put = (payload: unknown) => app.inject({ method: "PUT", url: "/api/journal/notes", payload });
    expect((await put({ account: 3, orderId: "o3", note: "가".repeat(200) })).statusCode).toBe(200);
    expect((await put({ account: 3, orderId: "o3", note: "가".repeat(201) })).statusCode).toBe(400);
    expect((await put({ account: 3, orderId: "o3", note: String.fromCharCode(1, 2) })).statusCode).toBe(400);
    expect((await put({ account: 3, orderId: "nope", note: "메모" })).statusCode).toBe(404);
    expect((await put({ account: 9, orderId: "o3", note: "메모" })).statusCode).toBe(404);
    expect((await put({ orderId: "o3", note: "메모" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("플래그 꺼짐 (§9-26)", () => {
  for (const flags of [{ tradeJournal: false }, { tradeRecords: false }]) {
    it(`${Object.keys(flags)[0]} 가 꺼져 있으면 읽기는 빈 값, 메모 쓰기는 409, 관리 점검은 enabled false`, async () => {
      const { get, app } = await setup({ flags });
      expect((await get("/api/journal")).body).toEqual({ enabled: false, days: [], stocks: [] });
      expect((await get("/api/journal/stock/005930")).body).toEqual({ enabled: false });
      expect((await get("/api/journal/returns")).body).toEqual({ enabled: false, ready: false });
      expect((await get("/api/journal/tax")).body).toEqual({ enabled: false });
      expect((await get("/api/admin/journal/check")).body).toEqual({ enabled: false });
      const r = await app.inject({ method: "PUT", url: "/api/journal/notes", payload: { account: 3, orderId: "o3", note: "x" } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe("FEATURE_OFF");
      expect((await app.inject({ method: "POST", url: "/api/admin/journal/fx", payload: {} })).statusCode).toBe(409);
      await app.close();
    });
  }
});

describe("기간 수익률 (GET /api/journal/returns)", () => {
  const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
  async function withSnaps(n: number, now: Date) {
    const t = await setup({ seed: false, now });
    await t.db
      .insertInto("account_snapshots")
      .values(DAYS.slice(0, n).map((d, i) => snapRow(d, "KR", TS(`${d}T16:05:00`), [{ code: "005930", name: "삼성전자", qty: 10, cost: 700_000, price: 70_000 + i * 1000 }])))
      .execute();
    return t;
  }

  it("기록이 10거래일 전이면 숫자 없이 준비 전 (지금 3거래일, 기록 시작일)", async () => {
    const { get, app } = await withSnaps(3, new Date("2026-09-30T20:00:00+09:00"));
    const { body } = await get("/api/journal/returns?preset=1M&market=KR");
    expect(body).toMatchObject({ enabled: true, ready: false, tradingDays: 3, needDays: 10, twr: null, recordSince: "2026-09-28", clippedToRecordStart: true });
    await app.close();
  });

  it("12거래일이면 시간가중 수익률·기간 손익, 고른 기간이 기록보다 길면 기록 시작일부터 (§9-20)", async () => {
    const { get, app } = await withSnaps(12, new Date("2026-10-15T20:00:00+09:00"));
    const { body } = await get("/api/journal/returns?preset=1M&market=KR");
    expect(body).toMatchObject({ ready: true, tradingDays: 12, requested: { from: "2026-09-15", to: "2026-10-15" }, actual: { from: "2026-09-28", to: "2026-10-15" }, clippedToRecordStart: true, currency: "KRW" });
    // 700,000 → 810,000 (사고판 것 없음) = +15.71%
    expect(body.twr).toBe(15.71);
    expect(body.pnl).toBe(110_000);
    expect(body.series).toHaveLength(12);
    expect((await get("/api/journal/returns?preset=custom&from=2026-10-01")).status).toBe(400);
    await app.close();
  });

  it("회귀: 기록이 12거래일이면 1주(기간 안 거래일 6일 이하)도 숫자가 나온다 — 공개 조건은 기록 전체 길이", async () => {
    const { get, app } = await withSnaps(12, new Date("2026-10-15T20:00:00+09:00"));
    const { body } = await get("/api/journal/returns?preset=1W&market=KR");
    expect(body).toMatchObject({ ready: true, recordDays: 12, requested: { from: "2026-10-08", to: "2026-10-15" }, actual: { from: "2026-10-08", to: "2026-10-15" } });
    expect(body.tradingDays).toBeLessThanOrEqual(6);
    expect(body.twr).not.toBeNull();
    await app.close();
  });

});

describe("해외주식 양도세 추정 (GET /api/journal/tax)", () => {
  const std = (at: string, rate: number) => ({ kind: "krw-std", at, rate, source: "smbs", fetched_at: "x" });

  it("결제일 기준환율로 취득가액(매수 결제일)·양도가액(매도 결제일)을 원화로 — 공제 이하면 세액 0 (§9-22·23)", async () => {
    const { db, get, app } = await setup();
    // 매수 9/1(뉴욕) → 국내 결제 9/3, 9/23 → 9/28(추석·주말), 매도 9/25 → 9/29
    await db.insertInto("fx_rates").values([std("2026-09-03", 1369.4), std("2026-09-28", 1352), std("2026-09-29", 1350)]).execute();
    const { body } = await get("/api/journal/tax?year=2026");
    expect(body).toMatchObject({ enabled: true, year: 2026, years: [2026], complete: true, fxPending: 0, excluded: [] });
    expect(body.rules).toMatchObject({ rate: 0.22, deduction: 2_500_000, method: "moving-average", lawYear: 2026 });
    expect(body.items).toEqual([
      {
        key: "3:o3:0",
        code: "SOXL",
        name: "SOXL",
        tradeDate: "2026-09-25",
        settleDate: "2026-09-29",
        settleSource: "estimated",
        quantity: 5,
        proceedsUsd: 187.5,
        costsUsd: null,
        fxSell: { rate: 1350, source: "smbs", date: "2026-09-29", provisional: false },
        proceedsKrw: 253_125,
        costKrw: 230_859,
        costsKrw: null,
        gainKrw: 22_266,
      },
    ]);
    expect(body.totals).toEqual({ gains: 22_266, losses: 0, net: 22_266, base: 0, nationalTax: 0, localTax: 0, tax: 0, sells: 1 });
    // 국내: 양도세는 계산하지 않고 증권거래세는 토스 값이 있을 때만 (없음)
    expect(body.kr).toEqual({ securitiesTax: { amount: null, sells: 1, source: null } });
    await app.close();
  });

  it("결제일 환율: 아직 받지 않았으면 '받는 중', 받아 본 기간인데 고시가 없는 날은 직전 고시, 받기를 다 해 봐도 없으면 빠진 매도", async () => {
    const { db, get, app } = await setup();
    await db.insertInto("fx_rates").values([std("2026-09-03", 1369.4), std("2026-09-28", 1352)]).execute();
    let b = (await get("/api/journal/tax")).body;
    expect(b).toMatchObject({ fxPending: 1, complete: false, excluded: [] });
    expect(b.totals.sells).toBe(0);
    // 받아 본 기간(9/1~9/30) 안인데 9/29 줄이 없음 → 직전 고시(9/28)
    await db.insertInto("meta").values({ key: "journal_fx_state", value: JSON.stringify({ stdCovered: [["2026-09-01", "2026-09-30"]], tries: {} }) }).execute();
    b = (await get("/api/journal/tax")).body;
    expect(b.items[0].fxSell).toEqual({ rate: 1352, source: "smbs", date: "2026-09-28", provisional: false });
    // 받아 보지 못한 채 여러 번 실패 → 빠진 매도
    await db.updateTable("meta").set({ value: JSON.stringify({ stdCovered: [], tries: { "2026-09-29": { n: 3, last: "x" } } }) }).where("key", "=", "journal_fx_state").execute();
    b = (await get("/api/journal/tax")).body;
    expect(b.excluded).toEqual([{ code: "SOXL", name: "SOXL", count: 1, reason: "결제일 환율을 받지 못했어요" }]);
    await app.close();
  });

  it("결제일이 아직 오지 않은 매도는 최근 고시 환율로 잠정 계산", async () => {
    const { db, get, app } = await setup({ now: new Date("2026-09-28T20:00:00+09:00") });
    await db.insertInto("fx_rates").values([std("2026-09-03", 1369.4), std("2026-09-28", 1352)]).execute();
    const b = (await get("/api/journal/tax")).body;
    expect(b.items[0].fxSell).toEqual({ rate: 1352, source: "smbs", date: "2026-09-28", provisional: true });
    await app.close();
  });

  it("기록 전에 산 몫(첫 스냅샷과 주문 내역이 맞지 않음)은 취득가를 몰라 빼고 까닭을 적는다", async () => {
    const { db, get, app } = await setup();
    await db.deleteFrom("trade_executions").where("order_id", "=", "o1").execute();
    await db.insertInto("fx_rates").values([std("2026-09-03", 1369.4), std("2026-09-28", 1352), std("2026-09-29", 1350)]).execute();
    const b = (await get("/api/journal/tax")).body;
    expect(b.excluded).toEqual([{ code: "SOXL", name: "SOXL", count: 1, reason: "기록 시작 전에 산 몫이라 취득가를 몰라요" }]);
    // 목록에서도 그 매도는 '실현손익 모름'
    const list = (await get("/api/journal?from=2026-09-01&to=2026-09-30")).body;
    const o3 = list.days.flatMap((d: { items: Array<Record<string, any>> }) => d.items).find((x: { orderId: string }) => x.orderId === "o3");
    expect(o3.realized).toMatchObject({ status: "unknown-cost", gross: null, reason: REASONS.beforeRecord });
    expect(list.summary.unknownSells).toBe(1);
    expect(list.summary.realized.USD).toBeNull();
    await app.close();
  });
});

describe("배경 환율 받기", () => {
  async function svc(fx: JournalFxSources, flag = true) {
    const db = await createMigratedDb(":memory:");
    await seed(db);
    await db.deleteFrom("fx_rates").execute();
    const features = new FeatureService(db, () => NOW);
    if (!flag) await features.set({ tradeJournal: false });
    const warns: string[] = [];
    const s = new JournalService({ db, features, fx, now: () => NOW, pauseMs: 0, log: { info: () => {}, warn: (_o, m) => void warns.push(m) } });
    return { db, s, warns };
  }
  const business = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const s = d.toISOString().slice(0, 10);
      if (![0, 6].includes(d.getUTCDay()) && !["2026-09-24", "2026-09-25"].includes(s)) out.push(s);
    }
    return out;
  };

  it("미국 체결 몫마다 토스 과거 환율, 결제일마다 매매기준율을 없을 때만 받는다 (두 번째는 0건)", async () => {
    const calls = { toss: [] as string[], std: [] as string[], naver: 0 };
    const { db, s } = await svc({
      tossAt: async (iso) => (calls.toss.push(iso), 1390),
      std: async (from, to) => (calls.std.push(`${from}~${to}`), business(from, to).map((d) => ({ date: d, rate: 1350 }))),
      naver: async () => (calls.naver++, business("2026-09-01", "2026-09-30").map((d) => ({ date: d, rate: 1351 }))),
    });
    await s.tick();
    expect(calls.toss).toEqual([minuteKey(TS("2026-09-01T23:00:00")), minuteKey(TS("2026-09-23T23:00:00")), minuteKey(TS("2026-09-25T23:10:04"))]);
    expect(calls.std).toEqual(["2026-09-03~2026-09-29"]);
    const std = await db.selectFrom("fx_rates").select(["at", "source"]).where("kind", "=", "krw-std").orderBy("at").execute();
    expect(std.map((r) => r.at)).toEqual(expect.arrayContaining(["2026-09-03", "2026-09-28", "2026-09-29"]));
    expect(new Set(std.map((r) => r.source))).toEqual(new Set(["smbs"]));
    await s.tick();
    expect(calls.toss).toHaveLength(3);
    expect(calls.std).toHaveLength(1);
  });

  it("매매기준율이 하나은행 고시와 1% 넘게 다르면 쓰지 않고 그날은 하나은행 값으로 대신, 매매기준율을 못 받으면 하나은행 값", async () => {
    const { db, s, warns } = await svc({
      tossAt: async () => 1390,
      std: async (from, to) => business(from, to).map((d) => ({ date: d, rate: d === "2026-09-28" ? 1500 : 1350 })),
      naver: async () => business("2026-09-01", "2026-09-30").map((d) => ({ date: d, rate: 1351 })),
    });
    await s.tick();
    const r = await db.selectFrom("fx_rates").select(["at", "rate", "source"]).where("kind", "=", "krw-std").where("at", "=", "2026-09-28").executeTakeFirst();
    expect(r).toEqual({ at: "2026-09-28", rate: 1351, source: "naver-hana" });
    expect(warns.some((w) => w.includes("1% 넘게"))).toBe(true);
    const failing = await svc({ tossAt: async () => 1390, std: async () => Promise.reject(new Error("503")), naver: async () => business("2026-09-01", "2026-09-30").map((d) => ({ date: d, rate: 1351 })) });
    await failing.s.tick();
    const rows = await failing.db.selectFrom("fx_rates").select(["at", "source"]).where("kind", "=", "krw-std").execute();
    expect(rows.length).toBe(3);
    expect(new Set(rows.map((x) => x.source))).toEqual(new Set(["naver-hana"]));
  });

  const fxState = async (db: Db) => {
    const row = await db.selectFrom("meta").select("value").where("key", "=", "journal_fx_state").executeTakeFirst();
    return row ? (JSON.parse(row.value) as { stdCovered: Array<[string, string]>; tries: Record<string, { n: number }> }) : null;
  };

  it("회귀: 매매기준율 응답이 예외 없이 빈 배열(모양 바뀜·HTTP 200 오류 페이지)이면 받지 못한 것으로 보고 하나은행 값으로 대신 — 받아 본 기간으로 적지 않는다", async () => {
    const { db, s, warns } = await svc({ tossAt: async () => 1390, std: async () => [], naver: async () => business("2026-09-01", "2026-09-30").map((d) => ({ date: d, rate: 1351 })) });
    await s.tick();
    const rows = await db.selectFrom("fx_rates").select(["at", "source"]).where("kind", "=", "krw-std").orderBy("at").execute();
    expect(rows).toEqual([
      { at: "2026-09-03", source: "naver-hana" },
      { at: "2026-09-28", source: "naver-hana" },
      { at: "2026-09-29", source: "naver-hana" },
    ]);
    expect((await fxState(db))!.stdCovered).toEqual([]);
    expect(warns.some((w) => w.includes("비었거나 모자라"))).toBe(true);
    const tax = await s.tax(2026);
    expect(tax.excluded).toEqual([]);
    expect(tax.items[0]!.fxSell).toEqual({ rate: 1351, source: "naver-hana", date: "2026-09-29", provisional: false });
  });

  it("회귀: 빈 응답이고 하나은행 값도 없으면 '받는 중'으로 남기고 받기 횟수를 올린다 (영구 '받지 못함'이 아님)", async () => {
    const { db, s } = await svc({ tossAt: async () => 1390, std: async () => [], naver: async () => [] });
    await s.tick();
    const st = (await fxState(db))!;
    expect(st.stdCovered).toEqual([]);
    expect(Object.fromEntries(Object.entries(st.tries).filter(([k]) => !k.startsWith("t:")).map(([k, v]) => [k, v.n]))).toEqual({ "2026-09-03": 1, "2026-09-28": 1, "2026-09-29": 1 });
    const tax = await s.tax(2026);
    expect(tax.fxPending).toBe(1);
    expect(tax.excluded).toEqual([]);
  });

  it("회귀: 매매기준율 줄이 중간에 끊기면(늦게 올라옴) 받아 본 기간은 마지막 줄까지만 — 그 뒤 결제일을 며칠 전 고시로 조용히 메우지 않는다", async () => {
    const upTo = "2026-09-23";
    const { db, s } = await svc({
      tossAt: async () => 1390,
      std: async (from, to) => business(from, to).filter((d) => d <= upTo).map((d) => ({ date: d, rate: 1350 })),
      naver: async () => business("2026-09-01", upTo).map((d) => ({ date: d, rate: 1351 })),
    });
    await s.tick();
    const st = (await fxState(db))!;
    expect(st.stdCovered).toEqual([["2026-09-03", upTo]]);
    expect(st.tries["2026-09-28"]?.n).toBe(1);
    expect(st.tries["2026-09-29"]?.n).toBe(1);
    const tax = await s.tax(2026);
    // 9/29 결제 매도는 9/23 고시로 계산되지 않고 '받는 중'
    expect(tax.fxPending).toBe(1);
    expect(tax.items).toEqual([]);
  });

  it("플래그가 꺼져 있으면 환율 요청 0건 (§9-26)", async () => {
    const calls = { n: 0 };
    const { s } = await svc({ tossAt: async () => (calls.n++, 1390), std: async () => (calls.n++, []), naver: async () => (calls.n++, []) }, false);
    await s.tick();
    expect(calls.n).toBe(0);
  });

  it("관리 점검: 짝마다 원장 대조와 빠진 환율", async () => {
    const { s } = await svc({});
    const c = await s.check();
    if (!c.enabled) throw new Error("켜져 있어야 함");
    expect(c.pairs.find((p) => p.code === "SOXL")).toMatchObject({ preAnchor: "checked", anchors: 1, unexplained: 0, priceJumps: 0 });
    expect(c.pairs.find((p) => p.code === "035420")).toMatchObject({ unexplained: 1 });
    expect(c.fx.tossMissing).toBe(3);
    expect(c.fx.stdPending).toEqual(["2026-09-03", "2026-09-28", "2026-09-29"]);
  });
});

describe("검토 반영 7차 보수 규칙: 기록과 설명되지 않는 변화가 있던 기간은 합계·양도세·수익률 어디에도 틀린 숫자를 넣지 않는다", () => {
  const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
  const LATER = new Date("2026-10-15T20:00:00+09:00");
  const at = (i: number, hm: string) => TS(`${DAYS[i]}T${hm}:00`);
  const items = (body: { days: Array<{ items: Array<Record<string, any>> }> }) => body.days.flatMap((d) => d.items);
  const b = { code: "000660", name: "SK하이닉스", qty: 10, cost: 1000, price: 100 };
  const std = (d: string) => ({ kind: "krw-std", at: d, rate: 1350, source: "smbs", fetched_at: "x" });
  const usSnaps = (held: H) => [snapRow("2026-09-25", "US", TS("2026-09-26T05:05:00"), [held]), snapRow("2026-09-28", "US", TS("2026-09-29T05:05:00"), [])];
  const dropped = { status: "unexplained", reason: REASONS.unexplained, gross: null, rate: null, costAmount: null, avgCost: null };
  /** 한국 12거래일 계좌: 삼성전자(i 번째 날 holdings(i)) + 늘 그대로인 SK하이닉스 */
  async function kr(holdings: (i: number) => H[], trades: ReturnType<typeof tradeRow>[]) {
    const t = await setup({ seed: false, now: LATER });
    await t.db
      .insertInto("account_snapshots")
      .values(DAYS.map((d, i) => snapRow(d, "KR", at(i, "16:05"), [...holdings(i), b])))
      .execute();
    if (trades.length) await t.db.insertInto("trade_executions").values(trades).execute();
    const returns = (await t.get("/api/journal/returns?preset=1M&market=KR")).body;
    const list = (await t.get("/api/journal?from=2026-09-28&to=2026-10-15")).body;
    await t.app.close();
    return { returns, list, rows: items(list) };
  }
  const sam = (qty: number, cost: number, price: number): H => ({ code: "005930", name: "삼성전자", qty, cost, price });

  it("무상증자 10→15 (매도 없음): 수익률은 그 구간을 건너뛰어 0% · 목록에 '기록과 다름' 줄과 이름표 (그대로 두면 −14.29%)", async () => {
    const { returns, rows } = await kr((i) => [i < 6 ? sam(10, 1500, 150) : sam(15, 1500, 100)], []);
    expect(returns).toMatchObject({ ready: true, twr: 0, pnl: 0, buys: 0, sells: 0, uncertainSkipped: [DAYS[6]] });
    expect(returns.transfersEstimated).toBeUndefined();
    expect(rows.filter((x) => x.kind === "change")).toMatchObject([
      { code: "005930", side: null, quantity: 5, change: { kind: "unexplained", qty: 5, text: "수량 10 → 15주 · 그 사이 기록된 매매 없음", guess: "무상증자·주식배당(주식 수 ×1.5)으로 보여요(추정)" } },
    ]);
  });

  it("1→4 분할 + 같은 날 5주 매도: 그 매도는 실현손익 합계에서 빠지고 '계산에서 뺀 매도'에 까닭·바뀐 것·이름표 · 수익률 0% (예전 추정 0 이 합계에)", async () => {
    const { returns, list, rows } = await kr((i) => [i < 6 ? sam(10, 1000, 100) : sam(35, 875, 25)], [tradeRow("s1", "005930", "SELL", [{ q: 5, a: 125, at: at(6, "10:00") }])]);
    expect(returns).toMatchObject({ ready: true, twr: 0, pnl: 0, sells: 125, uncertainSkipped: [DAYS[6]] });
    const change = "수량 10 → 35주 · 기록된 매매대로라면 5주";
    expect(rows.find((x) => x.orderId === "s1")!.realized).toMatchObject({ ...dropped, change, guess: "1→4 분할로 보여요(추정)" });
    expect(list.summary.realized).toMatchObject({ KRW: null, USD: null, krwTotal: null, estimatedIncluded: false });
    expect(list.summary.excludedSells).toEqual([
      { key: "3:s1:0", code: "005930", name: "삼성전자", date: "2026-10-07", quantity: 5, currency: "KRW", reason: REASONS.unexplained, change, guess: "1→4 분할로 보여요(추정)" },
    ]);
    expect(list.days.find((d: { date: string }) => d.date === "2026-10-07").realized).toMatchObject({ KRW: null });
  });

  it("1→4 분할 뒤 같은 날 모두 매도 · 4→1 병합 뒤 모두 매도 (다음 기록 0주): 손익 없음, 이름표만, 수익률 0% (예전 가짜 −75%·+75% → 4차 추정 0)", async () => {
    const split = await kr((i) => (i < 6 ? [sam(1000, 1_000_000, 1000)] : []), [tradeRow("s4", "005930", "SELL", [{ q: 4000, a: 1_000_000, at: at(6, "10:00") }])]);
    expect(split.returns).toMatchObject({ ready: true, twr: 0, pnl: 0, buys: 0, sells: 1_000_000, uncertainSkipped: [DAYS[6]] });
    expect(split.rows.find((x) => x.orderId === "s4")!.realized).toMatchObject({ ...dropped, guess: "1→4 분할로 보여요(추정)" });
    expect(split.rows.filter((x) => x.kind === "change")).toMatchObject([{ quantity: 3000, change: { kind: "unexplained", qty: 3000, text: "기록된 매도가 그때 가진 수량보다 많았어요 · 수량 1,000 → 0주" } }]);
    expect(split.list.summary.realized.KRW).toBeNull();
    const merge = await kr((i) => (i < 6 ? [sam(1000, 1_000_000, 1000)] : []), [tradeRow("s5", "005930", "SELL", [{ q: 250, a: 1_000_000, at: at(6, "10:00") }])]);
    expect(merge.returns).toMatchObject({ ready: true, twr: 0, pnl: 0 });
    expect(merge.rows.find((x) => x.orderId === "s5")!.realized).toMatchObject({ ...dropped, guess: "4→1 병합으로 보여요(추정)" });
    expect(merge.rows.filter((x) => x.kind === "change")).toMatchObject([{ quantity: 750, change: { qty: -750, text: "수량 1,000 → 0주 · 기록된 매매대로라면 750주" } }]);
  });

  it("주문 내역에 없는 입고 5주 + 15주 모두 매도: 손익 없음 · 수익률은 입고 흐름 값을 매기지 않고 그 구간을 건너뜀 (예전 순서 추정 +300 · +12%)", async () => {
    const { returns, rows } = await kr((i) => (i < 6 ? [sam(10, 1000, 100)] : []), [tradeRow("s2", "005930", "SELL", [{ q: 15, a: 1800, at: at(6, "10:00") }])]);
    expect(returns).toMatchObject({ ready: true, twr: 0, pnl: 0, buys: 0, sells: 1800, uncertainSkipped: [DAYS[6]] });
    expect(rows.find((x) => x.orderId === "s2")!.realized).toMatchObject({ ...dropped, change: "기록된 매도가 그때 가진 수량보다 많았어요 · 수량 10 → 0주", guess: null });
  });

  it("종목이 통째로 사라지거나(전량 출고·상장폐지) 일부만 나가면(주문 내역에 없음) 그 구간은 건너뜀 — 가짜 손실 없이 0%", async () => {
    const whole = await kr((i) => (i < 6 ? [sam(1, 1000, 1000)] : []), []);
    expect(whole.returns).toMatchObject({ ready: true, twr: 0, pnl: 0, sells: 0, uncertainSkipped: [DAYS[6]] });
    const half = await kr((i) => [i < 6 ? sam(1, 1000, 1000) : sam(0.5, 500, 1000)], []);
    expect(half.returns).toMatchObject({ ready: true, twr: 0, pnl: 0, uncertainSkipped: [DAYS[6]] });
    expect(half.rows.filter((x) => x.kind === "change")).toMatchObject([{ quantity: 0.5, change: { qty: -0.5, text: "수량 1 → 0.5주 · 그 사이 기록된 매매 없음" } }]);
  });

  it("1→4 분할 + 입고 400주 + 400주 매도 · 1/10 병합 뒤 크게 내린 가격에 모두 매도 · 거래정지 날 0주였다가 분할 4,000주 매도: 모두 손익 없음·수익률 0% (예전 추정 경로 −40.5% · +49.85% · −74.98%)", async () => {
    const mixed = await kr((i) => [i < 6 ? sam(1000, 1_000_000, 1000) : sam(4000, 1_000_000, 250)], [tradeRow("s8", "005930", "SELL", [{ q: 400, a: 100_000, at: at(6, "10:00") }])]);
    expect(mixed.returns).toMatchObject({ ready: true, twr: 0, pnl: 0, buys: 0, sells: 100_000, uncertainSkipped: [DAYS[6]] });
    expect(mixed.rows.find((x) => x.orderId === "s8")!.realized).toMatchObject({ ...dropped, guess: null });
    expect(mixed.rows.filter((x) => x.kind === "change")).toHaveLength(1);
    const merged = await kr((i) => (i < 6 ? [sam(1000, 1_000_000, 1000)] : []), [tradeRow("s9", "005930", "SELL", [{ q: 100, a: 600_000, at: at(6, "10:00") }])]);
    expect(merged.returns).toMatchObject({ ready: true, twr: 0, pnl: 0, uncertainSkipped: [DAYS[6]] });
    expect(merged.rows.find((x) => x.orderId === "s9")!.realized).toMatchObject(dropped);
    const halted = await kr((i) => (i < 6 ? [sam(1000, 1_000_000, 1000)] : []), [tradeRow("s7", "005930", "SELL", [{ q: 4000, a: 1_000_000, at: at(7, "10:00") }])]);
    expect(halted.returns).toMatchObject({ ready: true, twr: 0, pnl: 0, buys: 0, sells: 1_000_000, uncertainSkipped: [DAYS[6], DAYS[7]] });
    expect(halted.rows.find((x) => x.orderId === "s7")!.realized).toMatchObject(dropped);
  });

  it("권리락 뒤 새 주식이 늦게 들어옴 + 그 사이 매도 (한국 −50%): 권리락부터 새 주식 기록까지 매도는 '계산에서 뺀 매도', 수익률은 그 구간을 건너뜀 · 새 주식 뒤 매도는 토스 평균에서 보통 계산", async () => {
    const rows: Array<[number, number, number]> = [
      [1000, 1_000_000, 1000],
      [1000, 1_000_000, 1000],
      [1000, 1_000_000, 500],
      [800, 800_000, 505],
      [800, 800_000, 510],
      [1800, 800_000, 500],
    ];
    const r = await kr((i) => {
      const x = rows[i] ?? [900, 400_000, 520];
      return [sam(x[0], x[1], x[2])];
    }, [tradeRow("w1", "005930", "SELL", [{ q: 200, a: 101_000, at: at(3, "10:00") }]), tradeRow("w2", "005930", "SELL", [{ q: 900, a: 468_000, at: at(6, "10:00") }])]);
    expect(r.rows.find((x) => x.orderId === "w1")!.realized).toMatchObject({ ...dropped, reason: REASONS.possibleAction, change: "9월 30일 기록: 주가 1,000원 → 500원 (−50%) · 주식 수 1,000주 그대로", guess: "1→2 분할·무상증자일 수 있어요(추정)" });
    expect(r.rows.find((x) => x.orderId === "w2")!.realized).toMatchObject({ status: "ok", gross: 68_000, costAmount: 400_000 });
    expect(r.list.summary.realized.KRW).toBe(68_000);
    expect(r.list.summary.excludedSells.map((x: { key: string; reason: string }) => [x.key, x.reason])).toEqual([["3:w1:0", REASONS.possibleAction]]);
    expect(r.rows.filter((x) => x.kind === "change").map((x) => x.change.kind)).toEqual(["unexplained", "possible-action"]);
    // 새 주식 뒤 구간(+36,000 ÷ 901,000)만 · 기간 손익도 그 구간 몫만
    expect(r.returns).toMatchObject({ ready: true, twr: 4, pnl: 36_000, uncertainSkipped: [DAYS[2], DAYS[3], DAYS[4], DAYS[5]] });
  });

  it("분사처럼 수량은 같은데 토스 매입금액이 줄고 새 종목이 들어옴: 수익률은 그 구간을 건너뜀 (새 종목 매입금액과 상관없이 — 예전 짝짓기 경로 −16.67%)", async () => {
    for (const childCost of [20_000, 30_000]) {
      const t = await setup({ seed: false, now: LATER });
      const parent = (cost: number, price: number): H => ({ code: "005930", name: "삼성전자", qty: 1000, cost, price });
      const child: H = { code: "000660", name: "SK하이닉스", qty: 200, cost: childCost, price: 100 };
      await t.db
        .insertInto("account_snapshots")
        .values(DAYS.map((d, i) => snapRow(d, "KR", at(i, "16:05"), i < 6 ? [parent(100_000, 100)] : [parent(80_000, 80), child])))
        .execute();
      expect((await t.get("/api/journal/returns?preset=1M&market=KR")).body).toMatchObject({ ready: true, twr: 0, pnl: 0, buys: 0, uncertainSkipped: [DAYS[6]] });
      await t.app.close();
    }
  });

  it("계좌가 새로 기록에 들어오면(계좌 목록이 바뀜) 그 구간은 건너뜀 — 새 계좌 보유가 수익으로 보이지 않게", async () => {
    const t = await setup({ seed: false, now: LATER });
    const other: H = { code: "005930", name: "삼성전자", qty: 10, cost: 1000, price: 100, account: 4 };
    await t.db
      .insertInto("account_snapshots")
      .values(DAYS.map((d, i) => (i < 6 ? snapRow(d, "KR", at(i, "16:05"), [b]) : snapRow(d, "KR", at(i, "16:05"), [b, other], { accounts: [3, 4] }))))
      .execute();
    expect((await t.get("/api/journal/returns?preset=1M&market=KR")).body).toMatchObject({ ready: true, twr: 0, pnl: 0, uncertainSkipped: [DAYS[6]] });
    await t.app.close();
  });

  it("양도세: 미국 분할 날 매도 · 분할 뒤 모두 매도 · 많이 판 매도 · 1대8 병합 · 가격 모르는 병합 — 모두 합계에서 빠지고 '계산에서 뺀 매도'에 (includeUncertain 이어도)", async () => {
    const cases: Array<{ held: H; sell: [number, number]; guess: string | null; change: string; later?: boolean }> = [
      { held: { code: "SOXL", name: "SOXL", qty: 10, cost: 1000, price: 100, costKrw: 1_390_000 }, sell: [5, 125], guess: "1→4 분할로 보여요(추정)", change: "수량 10 → 35주 · 기록된 매매대로라면 5주", later: true },
      { held: { code: "SOXL", name: "SOXL", qty: 1000, cost: 100_000, price: 100, costKrw: 139_000_000 }, sell: [4000, 100_000], guess: "1→4 분할로 보여요(추정)", change: "기록된 매도가 그때 가진 수량보다 많았어요 · 수량 1,000 → 0주" },
      { held: { code: "SOXL", name: "SOXL", qty: 10, cost: 1000, price: 100, costKrw: 1_390_000 }, sell: [15, 1800], guess: null, change: "기록된 매도가 그때 가진 수량보다 많았어요 · 수량 10 → 0주" },
      { held: { code: "SOXL", name: "SOXL", qty: 1003, cost: 100_300, price: 100, costKrw: 139_417_000 }, sell: [126, 100_800], guess: "8→1 병합으로 보여요(추정)", change: "수량 1,003 → 0주 · 기록된 매매대로라면 877주" },
      { held: { code: "SOXL", name: "SOXL", qty: 1000, cost: 100_000, price: 0, costKrw: 139_000_000 }, sell: [250, 100_000], guess: null, change: "수량 1,000 → 0주 · 기록된 매매대로라면 750주" },
    ];
    for (const c of cases) {
      const t = await setup({ seed: false });
      const snaps = c.later
        ? [snapRow("2026-09-25", "US", TS("2026-09-26T05:05:00"), [c.held]), snapRow("2026-09-28", "US", TS("2026-09-29T05:05:00"), [{ ...c.held, qty: 35, cost: 875, price: 25, costKrw: 1_216_250 }])]
        : usSnaps(c.held);
      await t.db.insertInto("account_snapshots").values(snaps).execute();
      await t.db
        .insertInto("trade_executions")
        .values([tradeRow("b1", "SOXL", "BUY", [{ q: c.held.qty, a: c.held.cost, at: TS("2026-09-01T23:00:00") }]), tradeRow("x1", "SOXL", "SELL", [{ q: c.sell[0], a: c.sell[1], at: TS("2026-09-28T23:30:00") }])])
        .execute();
      await t.db.insertInto("fx_rates").values([std("2026-09-03"), std("2026-09-30")]).execute();
      for (const inc of ["", "&includeUncertain=1"]) {
        const { body } = await t.get(`/api/journal/tax?year=2026${inc}`);
        expect(body.items, c.change).toEqual([]);
        expect(body.totals, c.change).toMatchObject({ net: 0, tax: 0, sells: 0 });
        expect(body, c.change).toMatchObject({ complete: false, estimatedIncluded: 0, uncertainExcluded: 0, uncertainGainKrw: null });
        expect(body.excluded, c.change).toEqual([{ code: "SOXL", name: "SOXL", count: 1, reason: TAX_EXCLUDE_REASON.unexplained }]);
        expect(body.unexplainedSells, c.change).toEqual([
          { key: "3:x1:0", code: "SOXL", name: "SOXL", tradeDate: "2026-09-28", settleDate: "2026-09-30", quantity: c.sell[0], proceedsUsd: c.sell[1], reason: REASONS.unexplained, change: c.change, guess: c.guess },
        ]);
      }
      await t.app.close();
    }
  });

  it("양도세: 분사 당일 매도(토스 매입금액만 줄어듦) · 분할 날 늦게 본 매수 + 매도 — 합계에서 빠짐 · 분사가 기록된 뒤 매도는 달러 손익은 토스 값으로 보통, 결제일 원화 취득가는 모름", async () => {
    const t = await setup({ seed: false });
    await t.db
      .insertInto("account_snapshots")
      .values([
        snapRow("2026-09-25", "US", TS("2026-09-26T05:05:00"), [{ code: "SOXL", name: "SOXL", qty: 1000, cost: 100_000, price: 100, costKrw: 139_000_000 }]),
        snapRow("2026-09-28", "US", TS("2026-09-29T05:05:00"), [{ code: "SOXL", name: "SOXL", qty: 500, cost: 40_000, price: 40, costKrw: 55_600_000 }]),
      ])
      .execute();
    await t.db
      .insertInto("trade_executions")
      .values([
        tradeRow("b1", "SOXL", "BUY", [{ q: 1000, a: 100_000, at: TS("2026-09-01T23:00:00") }]),
        tradeRow("p2", "SOXL", "SELL", [{ q: 500, a: 20_000, at: TS("2026-09-28T23:30:00") }]),
        tradeRow("p3", "SOXL", "SELL", [{ q: 100, a: 4_200, at: TS("2026-09-29T23:30:00") }]),
      ])
      .execute();
    await t.db.insertInto("fx_rates").values([std("2026-09-03"), std("2026-09-30"), std("2026-10-01")]).execute();
    const { body } = await t.get("/api/journal/tax?year=2026");
    expect(body.items).toEqual([]);
    expect(body.excluded).toEqual([
      { code: "SOXL", name: "SOXL", count: 1, reason: TAX_EXCLUDE_REASON.unexplained },
      { code: "SOXL", name: "SOXL", count: 1, reason: TAX_EXCLUDE_REASON.changed },
    ]);
    expect(body.unexplainedSells).toMatchObject([{ key: "3:p2:0", change: "토스 매입금액 $40,000.00 · 기록된 매매대로라면 $50,000.00 (수량 500주는 같아요)" }]);
    const list = items((await t.get("/api/journal?from=2026-09-01&to=2026-09-30")).body);
    expect(list.find((x) => x.orderId === "p2")!.realized).toMatchObject(dropped);
    expect(list.find((x) => x.orderId === "p3")!.realized).toMatchObject({ status: "ok", gross: -3_800, costAmount: 8_000 });
    await t.app.close();

    const u = await setup({ seed: false });
    await u.db
      .insertInto("account_snapshots")
      .values([
        snapRow("2026-09-25", "US", TS("2026-09-26T05:05:00"), [{ code: "SOXL", name: "SOXL", qty: 1000, cost: 100_000, price: 100, costKrw: 139_000_000 }]),
        snapRow("2026-09-28", "US", TS("2026-09-29T05:05:00"), [{ code: "SOXL", name: "SOXL", qty: 4000, cost: 120_000, price: 25, costKrw: 166_800_000 }]),
      ])
      .execute();
    await u.db
      .insertInto("trade_executions")
      .values([
        tradeRow("b1", "SOXL", "BUY", [{ q: 1000, a: 100_000, at: TS("2026-09-01T23:00:00") }]),
        tradeRow("e4", "SOXL", "SELL", [{ q: 2000, a: 50_000, at: TS("2026-09-28T23:30:00") }]),
        tradeRow("b2", "SOXL", "BUY", [{ q: 2000, a: 70_000, at: TS("2026-09-29T05:05:00"), basis: "seen" }]),
      ])
      .execute();
    await u.db.insertInto("fx_rates").values([std("2026-09-03"), std("2026-09-30"), std("2026-10-01")]).execute();
    const ub = (await u.get("/api/journal/tax?year=2026")).body;
    expect(ub).toMatchObject({ items: [], uncertainExcluded: 0, estimatedIncluded: 0 });
    expect(ub.unexplainedSells.map((x: { key: string }) => x.key)).toEqual(["3:e4:0"]);
    await u.app.close();
  });

  it("보통 매매만 있는 계좌는 그대로: 실현손익·양도세·수익률이 이 변경 전과 같다 (계산에서 뺀 매도 0건)", async () => {
    const { get, db, app } = await setup();
    // 첫 양도세 테스트와 같은 결제일 환율 (9/3 1,369.4 · 9/28 1,352 · 9/29 1,350) — 같은 +22,266원
    await db.insertInto("fx_rates").values([{ ...std("2026-09-03"), rate: 1369.4 }, { ...std("2026-09-28"), rate: 1352 }, std("2026-09-29")]).execute();
    const list = (await get("/api/journal?from=2026-09-01&to=2026-09-30")).body;
    expect(list.summary.excludedSells).toEqual([]);
    expect(list.summary.realized).toEqual({ KRW: 20_000, USD: 17.43, krwTotal: 44_703, krwTotalEstimated: true, estimatedIncluded: false });
    const tax = (await get("/api/journal/tax?year=2026")).body;
    expect(tax).toMatchObject({ complete: true, excluded: [], unexplainedSells: [], totals: { net: 22_266, sells: 1 } });
    await app.close();
  });
});

describe("검토 반영: 매매기준율 '받아 본 기간'은 실제로 온 줄이 있는 곳만", () => {
  const business = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      const s = d.toISOString().slice(0, 10);
      if (![0, 6].includes(d.getUTCDay()) && !["2026-09-24", "2026-09-25"].includes(s)) out.push(s);
    }
    return out;
  };
  const fxState = async (db: Db) => {
    const row = await db.selectFrom("meta").select("value").where("key", "=", "journal_fx_state").executeTakeFirst();
    return row ? (JSON.parse(row.value) as { stdCovered: Array<[string, string]>; tries: Record<string, { n: number; last: string }> }) : null;
  };
  /** 2024-10 · 2025-03 · 2025-04 매수, 2025-07 · 2026-09 매도 (예시 — 실제 계좌와 무관). 결제일(국내) 2024-10-10 · 2025-03-13 · 2025-04-17 · 2025-07-10 · 2026-09-28 */
  async function svc(std: (from: string, to: string) => Promise<Array<{ date: string; rate: number }>>, naver: () => Promise<Array<{ date: string; rate: number }>>) {
    const db = await createMigratedDb(":memory:");
    await db
      .insertInto("trade_executions")
      .values([
        tradeRow("u1", "AMD", "BUY", [{ q: 1, a: 100, at: TS("2024-10-08T23:00:00") }]),
        tradeRow("u2", "AMD", "BUY", [{ q: 1, a: 110, at: TS("2025-03-11T23:00:00") }]),
        tradeRow("u3", "AMD", "BUY", [{ q: 1, a: 120, at: TS("2025-04-15T23:00:00") }]),
        tradeRow("u4", "AMD", "SELL", [{ q: 1, a: 130, at: TS("2025-07-08T23:00:00") }]),
        tradeRow("u5", "AMD", "SELL", [{ q: 1, a: 140, at: TS("2026-09-22T23:00:00") }]),
      ])
      .execute();
    const clock = { now: NOW };
    const features = new FeatureService(db, () => clock.now);
    const calls: string[] = [];
    const s = new JournalService({
      db,
      features,
      fx: { tossAt: async () => 1390, std: async (from, to) => (calls.push(`${from}~${to}`), std(from, to)), naver },
      now: () => clock.now,
      pauseMs: 0,
      log: { info: () => {}, warn: () => {} },
    });
    return { db, s, calls, clock };
  }
  const covered = (st: { stdCovered: Array<[string, string]> }, d: string) => st.stdCovered.some(([a, b]) => d >= a && d <= b);
  const EARLY = ["2024-10-10", "2025-03-13", "2025-04-17"];

  it("회귀: 응답 줄이 2025-06 부터만 있으면(앞 해 조각이 빔) 그 앞 결제일은 받아 본 기간이 아니다 — 며칠 전 고시로 메우지 않고 1시간 뒤 다시 받는다", async () => {
    const { db, s, calls, clock } = await svc(
      async (from, to) => business(from, to).filter((d) => d >= "2025-06-02").map((d) => ({ date: d, rate: 1350 })),
      async () => business("2025-09-29", "2026-09-30").map((d) => ({ date: d, rate: 1351 })),
    );
    await s.tick();
    const st = (await fxState(db))!;
    for (const d of EARLY) {
      expect(covered(st, d)).toBe(false);
      expect(st.tries[d]?.n).toBe(1);
    }
    expect(st.stdCovered.length).toBeGreaterThan(0);
    expect(st.stdCovered.every(([a]) => a >= "2025-06-02")).toBe(true);
    const have = (await db.selectFrom("fx_rates").select("at").where("kind", "=", "krw-std").execute()).map((r) => r.at);
    for (const d of EARLY) expect(have).not.toContain(d);
    expect(have).toEqual(expect.arrayContaining(["2025-07-10", "2026-09-28"]));
    // 2025 매도는 매수 결제일 환율을 아직 못 받아 '받는 중' (지어낸 환율로 계산하지 않음)
    expect((await s.tax(2025)).fxPending).toBe(1);
    // 기다리는 동안은 묻지 않고, 1시간 뒤 빈 곳만 다시 묻는다
    const n = calls.length;
    await s.tick();
    expect(calls.length).toBe(n);
    clock.now = new Date(NOW.getTime() + 61 * 60_000);
    await s.tick();
    expect(calls.length).toBeGreaterThan(n);
    expect(calls[n]!.startsWith("2024-10-10~")).toBe(true);
    // 받기를 다 해 봐도 없으면 '받지 못함' — 그래도 앞선 고시로 메우지 않는다
    const cur = (await fxState(db))!;
    await db
      .updateTable("meta")
      .set({ value: JSON.stringify({ ...cur, tries: Object.fromEntries(EARLY.map((d) => [d, { n: 3, last: "x" }])) }) })
      .where("key", "=", "journal_fx_state")
      .execute();
    const tax = await s.tax(2025);
    expect(tax.fxPending).toBe(0);
    expect(tax.items).toEqual([]);
    expect(tax.excluded).toEqual([{ code: "AMD", name: "AMD", count: 1, reason: "결제일 환율을 받지 못했어요" }]);
  });

  it("회귀: 줄 사이가 영업일 3일보다 길게 비면(가운데 조각이 빔) 그 사이 결제일은 받아 본 기간이 아니다 · 짧은 빈칸은 직전 고시", async () => {
    const { db, s } = await svc(async (from, to) => business(from, to).filter((d) => d < "2025-04-01" || d > "2025-05-30").map((d) => ({ date: d, rate: 1350 })), async () => []);
    await s.tick();
    const st = (await fxState(db))!;
    expect(covered(st, "2025-03-13")).toBe(true);
    expect(covered(st, "2025-04-17")).toBe(false);
    expect(st.tries["2025-04-17"]?.n).toBe(1);
    // 짧은 빈칸(영업일 1~3일 — 목록에 없는 휴일 등)은 받아 본 기간 안: 직전 고시
    const two = await svc(async (from, to) => business(from, to).filter((d) => d !== "2025-04-17").map((d) => ({ date: d, rate: 1350 })), async () => []);
    await two.s.tick();
    const st2 = (await fxState(two.db))!;
    expect(covered(st2, "2025-04-17")).toBe(true);
    expect(st2.tries["2025-04-17"]).toBeUndefined();
  });

  it("회귀: 예전 모양의 넓은 '받아 본 기간'이 남아 있어도 직전 고시가 영업일 3일보다 오래되면 쓰지 않는다 ('받는 중')", async () => {
    const t = await setup();
    const row = (at: string, rate: number) => ({ kind: "krw-std", at, rate, source: "smbs", fetched_at: "x" });
    await t.db.insertInto("fx_rates").values([row("2026-09-03", 1369.4), row("2026-09-18", 1352)]).execute();
    await t.db.insertInto("meta").values({ key: "journal_fx_state", value: JSON.stringify({ stdCovered: [["2026-09-01", "2026-09-30"]], tries: {} }) }).execute();
    // 9/28 결제 매수·9/29 결제 매도: 9/18 고시와 사이 영업일 9/21·22·23·28·29 — 3일보다 많음
    const b = (await t.get("/api/journal/tax?year=2026")).body;
    expect(b.items).toEqual([]);
    expect(b.fxPending).toBe(1);
    await t.app.close();
  });
});

describe("검토 반영: 매매기준율 조각·받아 본 기간 계산 (순수)", () => {
  it("한 해씩 조각 (2/29 시작은 다음 해 2/28까지) · 온 줄 사이 빠진 영업일 3일까지만 한 구간", async () => {
    const { coveredSpans, yearChunks } = await import("../src/services/journalService.js");
    expect(yearChunks("2024-10-10", "2026-09-28")).toEqual([
      ["2024-10-10", "2025-10-09"],
      ["2025-10-10", "2026-09-28"],
    ]);
    expect(yearChunks("2028-02-29", "2029-03-10")).toEqual([
      ["2028-02-29", "2029-02-28"],
      ["2029-03-01", "2029-03-10"],
    ]);
    expect(yearChunks("2026-09-03", "2026-09-29")).toEqual([["2026-09-03", "2026-09-29"]]);
    // 9/18(금) 다음 줄이 9/23(수): 사이 영업일 9/21·22 → 한 구간 · 9/23 다음 9/30: 사이 9/28·29 (9/24·25 추석) → 한 구간
    expect(coveredSpans(["2026-09-17", "2026-09-18", "2026-09-23", "2026-09-30"])).toEqual([["2026-09-17", "2026-09-30"]]);
    // 9/1(화) 다음 9/7(월): 사이 영업일 3일(9/2·3·4) → 한 구간 · 9/1 다음 9/8: 4일 → 끊는다
    expect(coveredSpans(["2026-09-01", "2026-09-07"])).toEqual([["2026-09-01", "2026-09-07"]]);
    expect(coveredSpans(["2026-09-01", "2026-09-08", "2026-09-09"])).toEqual([
      ["2026-09-01", "2026-09-01"],
      ["2026-09-08", "2026-09-09"],
    ]);
    expect(coveredSpans([])).toEqual([]);
  });

  it("검토 반영 3차: 2025 추석(평일 5일)·설(평일 4일) 연휴를 건너뛴 두 줄은 한 구간 — 빠진 영업일로 세지 않는다", async () => {
    const { coveredSpans } = await import("../src/services/journalService.js");
    expect(coveredSpans(["2025-10-01", "2025-10-02", "2025-10-10", "2025-10-13"])).toEqual([["2025-10-01", "2025-10-13"]]);
    expect(coveredSpans(["2025-01-23", "2025-01-24", "2025-01-31"])).toEqual([["2025-01-23", "2025-01-31"]]);
  });
});

describe("검토 반영 3차: 2025 추석 연휴 전후 미국 매수·매도가 양도세 추정에서 빠지지 않는다", () => {
  it("미국 2025-10-02 매수(국내 결제일 10/10) · 10/20 매도: 결제일 고시로 계산, '받는 중'·'받지 못함' 없음", async () => {
    const { KR_BANK_HOLIDAYS_PAST } = await import("../src/services/taxRules.js");
    // 실제 모양의 응답: 주말·공휴일에는 줄이 없다 (예시 환율 — 실제 값과 무관)
    const bankDays = (from: string, to: string) => {
      const out: Array<{ date: string; rate: number }> = [];
      for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
        const s = d.toISOString().slice(0, 10);
        if (![0, 6].includes(d.getUTCDay()) && !KR_BANK_HOLIDAYS_PAST.has(s)) out.push({ date: s, rate: s === "2025-10-10" ? 1420 : 1400 });
      }
      return out;
    };
    const db = await createMigratedDb(":memory:");
    await db
      .insertInto("trade_executions")
      .values([tradeRow("h1", "AMD", "BUY", [{ q: 2, a: 300, at: TS("2025-10-02T23:00:00") }]), tradeRow("h2", "AMD", "SELL", [{ q: 1, a: 170, at: TS("2025-10-20T23:00:00") }])])
      .execute();
    const features = new FeatureService(db, () => NOW);
    const s = new JournalService({
      db,
      features,
      fx: { tossAt: async () => 1400, std: async (from, to) => bankDays(from, to), naver: async () => [] },
      now: () => NOW,
      pauseMs: 0,
      log: { info: () => {}, warn: () => {} },
    });
    await s.tick();
    const tax = await s.tax(2025);
    expect(tax.fxPending).toBe(0);
    expect(tax.excluded).toEqual([]);
    expect(tax.items).toHaveLength(1);
    // 취득가 = $150 × 10/10 고시 1,420 · 양도가 = $170 × 10/22 고시 1,400 (참고용 추정)
    expect(tax.items[0]).toMatchObject({ settleDate: "2025-10-22", costKrw: 213_000, proceedsKrw: 238_000, gainKrw: 25_000 });
  });
});

