import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, migrate, type Db } from "../src/db/index.js";
import { TossOpenApiClient, TossOpenApiProvider, type TossHolding, type TossOrderRecord } from "../src/providers/market/tossOpenApi.js";
import { BACKUP_TABLES, BackupService, restoreBackup } from "../src/services/backupService.js";
import { FeatureService } from "../src/services/featureService.js";
import { TradeRecordService, type TradeRecordToss } from "../src/services/tradeRecordService.js";
import { fakeProviders } from "./helpers.js";

/**
 * 매매 기록 기반 (3-36): 일별 계좌 스냅샷·체결 저장. 네트워크 없음 — 토스는 가짜(FakeToss) 또는 녹화한 모양의 픽스처(test/fixtures/tradeRecords),
 * 시계는 고정. 픽스처의 칸은 서버가 이미 운영에서 읽고 있는 칸(주문: orderId·side·orderedAt·execution.filledQuantity/filledAmount/filledAt,
 * 보유: symbol·quantity·averagePurchasePrice·lastPrice·marketValue)만 쓴다. 값은 예시다
 */

const FIX = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/tradeRecords/${name}`, import.meta.url)), "utf8");
const kst = (s: string) => new Date(`${s}+09:00`);

type Overview = { purchaseKrw: number; purchaseUsd: number | null; afterCostKrw: number; afterCostUsd: number; rateAfterCost: number | null };

const holding = (code: string, quantity: number, avgPrice: number, lastPrice: number, currency: "KRW" | "USD" = /^\d/.test(code) ? "KRW" : "USD"): TossHolding => ({
  code,
  name: code,
  currency,
  quantity,
  avgPrice,
  lastPrice,
  purchaseAmount: Math.round(quantity * avgPrice * 100) / 100,
  marketValue: Math.round(quantity * lastPrice * 100) / 100,
  marketValueAfterCost: Math.round(quantity * lastPrice * 0.998 * 100) / 100,
});

/** 계좌·보유·주문을 테스트에서 바꿀 수 있는 가짜 토스 */
class FakeToss implements TradeRecordToss {
  calls = { accounts: 0, holdings: 0, orders: 0 };
  fail: string | null = null;
  ordersFail: Record<string, string> = {};
  accountList = [3];
  holdings: Record<number, TossHolding[]> = { 3: [] };
  overview: Record<number, Overview> = {};
  orders: Record<string, TossOrderRecord[]> = {};
  asked: string[] = [];
  async accounts() {
    this.calls.accounts++;
    if (this.fail) throw new Error(this.fail);
    return this.accountList.map((accountSeq) => ({ accountNo: "x", accountSeq, accountType: "BROKERAGE" }));
  }
  async holdingsWithOverview(seq: number) {
    this.calls.holdings++;
    if (this.fail) throw new Error(this.fail);
    const items = this.holdings[seq] ?? [];
    const sum = (cur: "KRW" | "USD", k: "purchaseAmount" | "marketValueAfterCost") => items.filter((h) => h.currency === cur).reduce((s, h) => s + (h[k] ?? 0), 0);
    return {
      items,
      overview: this.overview[seq] ?? { purchaseKrw: sum("KRW", "purchaseAmount"), purchaseUsd: sum("USD", "purchaseAmount"), afterCostKrw: sum("KRW", "marketValueAfterCost"), afterCostUsd: sum("USD", "marketValueAfterCost"), rateAfterCost: null },
    };
  }
  async orderHistory(seq: number, symbol: string) {
    this.calls.orders++;
    this.asked.push(`${seq}:${symbol}`);
    const f = this.ordersFail[`${seq}:${symbol}`];
    if (f) throw new Error(f);
    return this.orders[`${seq}:${symbol}`] ?? [];
  }
}

const order = (orderId: string, symbol: string, side: "BUY" | "SELL", quantity: number, amount: number, filledAt: string | null, status: "CLOSED" | "OPEN" = "CLOSED"): TossOrderRecord => ({
  orderId,
  symbol,
  side,
  status,
  quantity,
  amount,
  currency: null,
  filledAt,
  orderedAt: filledAt ?? "2026-09-28T22:30:00+09:00",
  raw: { orderId, side },
});

async function setup(opts: { flag?: boolean; isTradingDate?: (m: "KR" | "US", d: string) => Promise<boolean> } = {}) {
  const db = await createMigratedDb(":memory:");
  const clock = { t: kst("2026-09-28T09:00:00") };
  const now = () => new Date(clock.t.getTime());
  const features = new FeatureService(db, now);
  if (opts.flag === false) await features.set({ tradeRecords: false });
  const toss = new FakeToss();
  const warns: string[] = [];
  const make = () =>
    new TradeRecordService({
      db,
      toss,
      features,
      displayFx: async () => 1390,
      now,
      retryMs: 5 * 60_000,
      pauseMs: 0,
      log: { info: () => {}, warn: (_o, m) => void warns.push(m) },
      ...(opts.isTradingDate ? { isTradingDate: opts.isTradingDate } : {}),
    });
  const svc = make();
  const at = async (s: string) => {
    clock.t = kst(s);
    await svc.tick();
  };
  /** 저장된 스냅샷 줄 (market 을 주면 그 시장만) — 두 시장의 예약이 같은 시계에서 함께 돌므로 보통 한 시장만 본다 */
  const rows = async (market?: "KR" | "US") =>
    (await db.selectFrom("account_snapshots").select(["snapshot_date", "market", "status", "method", "reason"]).orderBy("market").orderBy("snapshot_date").execute())
      .filter((r) => !market || r.market === market)
      .map((r) => `${r.market} ${r.snapshot_date} ${r.status}${r.method ? ` ${r.method}` : ""}`);
  return { db, clock, now, features, toss, svc, make, at, rows, warns };
}

describe("매매 기록 — 스냅샷 예약·따라잡기 (3-36)", () => {
  it("한국은 16:05 에 한국 종목만 'close' 로 한 번, 같은 시각에 여러 번 돌리거나 다른 서버가 돌려도 한 줄", async () => {
    const { toss, at, rows, make, svc, db } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200), holding("SOXL", 25, 33, 38.02)];
    await at("2026-09-28T16:04:00");
    expect(await rows()).toEqual([]);
    expect(toss.calls.holdings).toBe(0);
    await at("2026-09-28T16:05:00");
    expect(await rows()).toEqual(["KR 2026-09-28 ok close"]);
    const holdingsCalls = toss.calls.holdings;
    await svc.tick();
    await make().tick();
    expect(await rows()).toEqual(["KR 2026-09-28 ok close"]);
    expect(toss.calls.holdings).toBe(holdingsCalls); // 이미 있으면 토스를 다시 부르지 않는다
    const [snap] = await svc.listSnapshots({ from: "2026-09-28", to: "2026-09-28" });
    expect(snap).toMatchObject({
      date: "2026-09-28",
      market: "KR",
      status: "ok",
      method: "close",
      asOf: "2026-09-28T16:05:00+09:00",
      scheduledAt: "2026-09-28T16:05:00+09:00",
      source: "toss-openapi",
      totals: { holdings: 1, valueKrw: 712000, costKrw: 700000 },
    });
    expect(snap!.holdings.map((h) => h.code)).toEqual(["005930"]);
    const row = await db.selectFrom("account_snapshots").select(["total_value_krw", "holdings_count"]).executeTakeFirstOrThrow();
    expect(row).toEqual({ total_value_krw: 712000, holdings_count: 1 });
  });

  it("미국은 정규장 마감 5분 뒤: 서머타임 끝난 뒤(EST)는 06:05, 조기 폐장일(11/27)은 03:05 KST, 원화는 그때 환율로", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.holdings[3] = [holding("SOXL", 25, 33, 38.02), holding("005930", 1, 70000, 70000)];
    await at("2026-10-31T05:05:00"); // 금 10/30 16:05 EDT
    await at("2026-11-03T05:30:00"); // 월 11/2 15:30 EST — 아직
    expect(await rows("US")).toEqual(["US 2026-10-30 ok close"]);
    await at("2026-11-03T06:05:00");
    await at("2026-11-28T03:04:00");
    expect(await rows("US")).toContain("US 2026-11-02 ok close");
    expect(await rows("US")).not.toContain("US 2026-11-27 ok close");
    await at("2026-11-28T03:05:00");
    const us = (await svc.listSnapshots({ from: "2026-11-27", to: "2026-11-27", market: "US" }))[0]!;
    expect(us).toMatchObject({ method: "close", scheduledAt: "2026-11-28T03:05:00+09:00", fx: { usdKrw: 1390, source: "display" } });
    expect(us.holdings.map((h) => h.code)).toEqual(["SOXL"]);
    expect(us.totals.valueKrw).toBe(Math.round(25 * 38.02 * 1390));
  });

  it("추석(9/24~25)·주말·개천절 대체(10/5)·한글날(10/9)에는 스냅샷도 빠진 날도 없다", async () => {
    const { toss, at, rows, svc, clock } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    for (const d of ["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"]) {
      await at(`${d}T16:05:00`);
      await at(`${d}T23:59:00`);
    }
    const kr = await rows("KR");
    expect(kr).toEqual(["2026-09-23", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-12"].map((d) => `KR ${d} ok close`));
    clock.t = kst("2026-10-12T17:00:00");
    const st = await svc.status();
    expect(st.markets.KR).toMatchObject({ since: "2026-09-23", missing5: [], missing30: [], stored: 10, gaps: 0 });
    expect(st.warning ?? "").not.toContain("한국"); // (미국은 이 시계로 마감 창을 거의 지나쳐 빈칸이 있다)
  });

  it("서버가 꺼져 있던 거래일은 빈칸 표시(gap)만 남기고 값을 지어내지 않는다 — 켜진 뒤 그날 마감부터 다시", async () => {
    const { toss, at, rows, svc, warns } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    await at("2026-09-28T16:05:00");
    await at("2026-10-01T10:00:00"); // 9/29·9/30 꺼져 있었음, 10/1 은 아직 마감 전
    expect(await rows()).toEqual(["KR 2026-09-28 ok close", "KR 2026-09-29 gap", "KR 2026-09-30 gap"]);
    const gap = (await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29" }))[0]!;
    expect(gap).toMatchObject({ status: "gap", method: null, totals: null, holdings: [] });
    expect(gap.reason).toMatch(/스냅샷 없음/);
    expect(warns.some((w) => w.includes("9/29"))).toBe(true);
    await at("2026-10-01T16:05:00");
    expect((await rows()).at(-1)).toBe("KR 2026-10-01 ok close");
    await at("2026-10-01T17:00:00");
    const st = await svc.status();
    expect(st.markets.KR.missing5).toEqual(["2026-09-30", "2026-09-29"]);
    expect(st.missing5).toEqual([
      { market: "KR", date: "2026-09-30" },
      { market: "KR", date: "2026-09-29" },
    ]);
    expect(st.warning).toBe("최근 5거래일 중 스냅샷 없는 날: 한국 9/29·9/30");
    expect(st).toMatchObject({ since: "2026-09-28", days: 2 });
  });

  it("마감 직후를 놓쳤어도 같은 거래일 안이면(한국은 다음 거래일 08:00 전) 그때 값을 'intraday-fallback' 으로 — 토요일에 본 금요일도", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    await at("2026-09-28T18:40:00");
    await at("2026-10-03T11:00:00"); // 9/29~10/2 는 gap, 10/2 는 토요일에 찍음
    expect(await rows("KR")).toEqual(["KR 2026-09-28 ok intraday-fallback", "KR 2026-09-29 gap", "KR 2026-09-30 gap", "KR 2026-10-01 gap", "KR 2026-10-02 ok intraday-fallback"]);
    const s = (await svc.listSnapshots({ from: "2026-10-02", to: "2026-10-02", market: "KR" }))[0]!;
    expect(s).toMatchObject({ asOf: "2026-10-03T11:00:00+09:00", scheduledAt: "2026-10-02T16:05:00+09:00" });
  });

  it("토스 오류는 5분마다 다시, 그 거래일이 지나면 까닭을 적은 빈칸 — 건강 점검은 마감 30분 뒤부터 빠진 날로 본다", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    toss.fail = "토스 계좌 조회 실패";
    await at("2026-09-28T16:05:00");
    const calls = toss.calls.accounts;
    await at("2026-09-28T16:07:00");
    expect(toss.calls.accounts).toBe(calls); // 5분 안에는 다시 묻지 않는다
    await at("2026-09-28T16:10:00");
    expect(toss.calls.accounts).toBeGreaterThan(calls);
    expect(await rows()).toEqual([]);
    await at("2026-09-28T16:40:00");
    const st = await svc.status();
    expect(st.markets.KR).toMatchObject({ since: "2026-09-28", missing5: ["2026-09-28"], lastError: expect.stringContaining("토스 계좌 조회 실패") });
    expect(st.warning).toContain("한국 9/28");
    toss.fail = null;
    await at("2026-09-29T08:30:00");
    expect(await rows("KR")).toEqual(["KR 2026-09-28 gap"]);
    expect((await svc.listSnapshots({ from: "2026-09-28", to: "2026-09-28", market: "KR" }))[0]!.reason).toContain("토스 계좌 조회 실패");
    await at("2026-09-29T16:05:00");
    expect((await rows("KR")).at(-1)).toBe("KR 2026-09-29 ok close");
  });

  it("보유가 비었는데 요약에 원화 매입금액이 있으면 믿지 않고 다시 (빈 스냅샷을 남기지 않는다). 정말 없으면 0종목 스냅샷", async () => {
    const { toss, at, rows } = await setup();
    toss.holdings[3] = [];
    toss.overview[3] = { purchaseKrw: 700000, purchaseUsd: 0, afterCostKrw: 700000, afterCostUsd: 0, rateAfterCost: 0 };
    await at("2026-09-28T16:05:00");
    expect(await rows()).toEqual([]);
    toss.overview[3] = { purchaseKrw: 0, purchaseUsd: 0, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null };
    await at("2026-09-28T16:11:00");
    expect(await rows()).toEqual(["KR 2026-09-28 ok close"]);
  });

  it("달력이 그날을 휴장이라 하면(예상 못 한 휴장) 스냅샷도 빈칸도 만들지 않고, 건강 점검도 빠진 날로 세지 않는다", async () => {
    const { toss, at, rows, svc } = await setup({ isTradingDate: async (m, d) => !(m === "KR" && d === "2026-09-29") });
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    await at("2026-09-28T16:05:00");
    await at("2026-09-29T16:05:00");
    await at("2026-09-30T16:05:00");
    expect(await rows("KR")).toEqual(["KR 2026-09-28 ok close", "KR 2026-09-30 ok close"]);
    await at("2026-09-30T17:00:00");
    expect((await svc.status()).markets.KR.missing5).toEqual([]);
  });

  it("미국 추수감사절(11/26)은 스냅샷도 빈칸도 없고, 다음 날 조기 폐장(11/27)은 03:05 KST 에 찍는다", async () => {
    const { toss, at, rows } = await setup();
    toss.holdings[3] = [holding("SOXL", 25, 33, 38.02)];
    await at("2026-11-26T06:05:00"); // 수 11/25 16:05 EST
    await at("2026-11-27T06:05:00"); // 목 11/26 휴장 — 아직 11/25 세션
    await at("2026-11-27T12:00:00");
    await at("2026-11-28T03:05:00"); // 금 11/27 13:05 EST (조기 폐장)
    await at("2026-11-28T12:00:00");
    expect(await rows("US")).toEqual(["US 2026-11-25 ok close", "US 2026-11-27 ok close"]);
  });

  it("최근 5거래일에 빠진 날이 있으면 로그로 한 번 경고하고, 같은 내용은 되풀이하지 않는다", async () => {
    const { toss, at, warns } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    await at("2026-09-28T16:05:00");
    await at("2026-10-01T10:00:00");
    await at("2026-10-01T10:40:00");
    await at("2026-10-01T11:20:00");
    const health = warns.filter((w) => w.includes("최근 5거래일"));
    expect(health).toHaveLength(1);
    expect(health[0]).toContain("한국 9/29·9/30");
  });

  it("플래그를 끄면 아무것도 쓰지 않고 토스도 부르지 않는다", async () => {
    const { toss, at, rows, db, svc } = await setup({ flag: false });
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    await at("2026-09-28T16:05:00");
    await at("2026-09-29T16:05:00");
    expect(await rows()).toEqual([]);
    expect(toss.calls).toEqual({ accounts: 0, holdings: 0, orders: 0 });
    expect(await db.selectFrom("trade_executions").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("meta").select("key").where("key", "=", "trade_records_state").execute()).toEqual([]);
    await expect(svc.snapshotNow("KR")).rejects.toThrow(/꺼져/);
  });

  it("start(): 서버를 켜면 곧 한 번 돌아 놓친 스냅샷을 따라잡는다", async () => {
    const db = await createMigratedDb(":memory:");
    const toss = new FakeToss();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    const now = () => kst("2026-09-28T19:00:00");
    const svc = new TradeRecordService({ db, toss, features: new FeatureService(db, now), displayFx: async () => 1390, now, startupDelayMs: 0, tickMs: 60_000, pauseMs: 0 });
    svc.start();
    try {
      await vi.waitFor(async () => expect((await db.selectFrom("account_snapshots").select("method").execute()).map((r) => r.method)).toEqual(["intraday-fallback"]));
    } finally {
      await svc.stop();
    }
  });
});

describe("매매 기록 — 체결 저장 (토스 주문 내역)", () => {
  it("스냅샷 뒤 그 시장 종목의 주문 내역을 받아 주문번호로 한 줄씩 — 다시 받아도 늘지 않고, 부분 체결은 늘어난 만큼 고친다", async () => {
    const { toss, at, svc, db } = await setup();
    toss.holdings[3] = [holding("SOXL", 25, 33, 38.02), holding("TSLA", 2, 300, 377.5)];
    toss.orders["3:SOXL"] = [
      order("ord-1", "SOXL", "BUY", 20, 700, "2026-09-23T22:40:02+09:00"),
      order("ord-1", "SOXL", "BUY", 20, 700, "2026-09-23T22:40:02+09:00"), // 페이지 경계에서 한 번 더 온 줄
      order("ord-4", "SOXL", "BUY", 2, 76, null, "OPEN"),
    ];
    toss.orders["3:TSLA"] = [order("ord-9", "TSLA", "SELL", 1, 377.5, "2026-09-28T23:30:00+09:00")];
    await at("2026-09-29T05:05:00");
    const first = await db.selectFrom("trade_executions").select(["order_id", "code", "market", "side", "quantity", "amount", "price", "currency", "executed_at", "executed_date", "time_basis", "order_status"]).orderBy("order_id").execute();
    expect(first).toEqual([
      { order_id: "ord-1", code: "SOXL", market: "US", side: "BUY", quantity: 20, amount: 700, price: 35, currency: "USD", executed_at: "2026-09-23T22:40:02+09:00", executed_date: "2026-09-23", time_basis: "filled", order_status: "CLOSED" },
      { order_id: "ord-4", code: "SOXL", market: "US", side: "BUY", quantity: 2, amount: 76, price: 38, currency: "USD", executed_at: "2026-09-28T22:30:00+09:00", executed_date: "2026-09-28", time_basis: "ordered", order_status: "OPEN" },
      { order_id: "ord-9", code: "TSLA", market: "US", side: "SELL", quantity: 1, amount: 377.5, price: 377.5, currency: "USD", executed_at: "2026-09-28T23:30:00+09:00", executed_date: "2026-09-28", time_basis: "filled", order_status: "CLOSED" },
    ]);
    // 다음 날: 부분 체결이 끝나고(5주), TSLA 는 전량 매도해 보유에서 빠졌지만 지난 스냅샷에 있어 여전히 묻는다
    toss.holdings[3] = [holding("SOXL", 28, 33.5, 38)];
    toss.orders["3:SOXL"] = [order("ord-1", "SOXL", "BUY", 20, 700, "2026-09-23T22:40:02+09:00"), order("ord-4", "SOXL", "BUY", 5, 190, "2026-09-29T22:31:00+09:00")];
    toss.orders["3:TSLA"] = [order("ord-9", "TSLA", "SELL", 1, 377.5, "2026-09-28T23:30:00+09:00"), order("ord-10", "TSLA", "SELL", 1, 380, "2026-09-29T23:00:00+09:00")];
    toss.asked = [];
    await at("2026-09-30T05:05:00");
    expect(toss.asked.sort()).toEqual(["3:SOXL", "3:TSLA"]);
    const second = await db.selectFrom("trade_executions").select(["order_id", "quantity", "amount", "executed_at", "time_basis", "order_status"]).orderBy("order_id").execute();
    expect(second).toEqual([
      { order_id: "ord-1", quantity: 20, amount: 700, executed_at: "2026-09-23T22:40:02+09:00", time_basis: "filled", order_status: "CLOSED" },
      { order_id: "ord-10", quantity: 1, amount: 380, executed_at: "2026-09-29T23:00:00+09:00", time_basis: "filled", order_status: "CLOSED" },
      { order_id: "ord-4", quantity: 5, amount: 190, executed_at: "2026-09-29T22:31:00+09:00", time_basis: "filled", order_status: "CLOSED" },
      { order_id: "ord-9", quantity: 1, amount: 377.5, executed_at: "2026-09-28T23:30:00+09:00", time_basis: "filled", order_status: "CLOSED" },
    ]);
    // 저장한 체결 건수 = 토스 주문 내역(체결된 주문) 건수
    const st = await svc.status();
    expect(st.trades).toMatchObject({ count: 4, earliest: "2026-09-23", source: "toss-orders", lastError: null });
    const sync = await svc.syncTrades("US");
    expect(sync).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
  });

  it("같은 주문번호라도 계좌가 다르면 다른 줄, 한 종목 조회가 실패해도 나머지는 저장하고 오류를 남긴다", async () => {
    const { toss, at, db, svc } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("005930", 10, 70000, 71200), holding("035420", 9, 232555, 201500)];
    toss.holdings[7] = [holding("005930", 1, 71000, 71200)];
    toss.orders["3:005930"] = [order("A1", "005930", "BUY", 10, 700000, "2026-09-28T09:01:00+09:00")];
    toss.orders["7:005930"] = [order("A1", "005930", "BUY", 1, 71000, "2026-09-28T10:00:00+09:00")];
    toss.ordersFail["3:035420"] = "HTTP 429 rate-limit-exceeded";
    await at("2026-09-28T16:05:00");
    const rows = await db.selectFrom("trade_executions").select(["account", "order_id", "quantity", "market", "currency"]).orderBy("account").execute();
    expect(rows).toEqual([
      { account: 3, order_id: "A1", quantity: 10, market: "KR", currency: "KRW" },
      { account: 7, order_id: "A1", quantity: 1, market: "KR", currency: "KRW" },
    ]);
    expect((await svc.status()).trades.lastError).toContain("035420");
  });

  it("토스 실시간 체결 알림으로 본 종목은 보유·등록에 없어도(하루 안에 사고판 종목) 그 시장 주문 내역을 묻는다 — 끄면 기억하지 않음", async () => {
    const { toss, at, svc, db, clock, features } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 30, 38)];
    toss.orders["3:NVDA"] = [order("n1", "NVDA", "BUY", 2, 360, "2026-09-28T23:00:00+09:00"), order("n2", "NVDA", "SELL", 2, 366, "2026-09-29T01:00:00+09:00")];
    clock.t = kst("2026-09-29T01:00:03");
    await svc.noteOrderEvent({ event: "FILL", accountSeq: 3, order: { symbol: "nvda", orderId: "n2" } });
    await svc.noteOrderEvent({ event: "FILL", accountSeq: 3, order: { symbol: "A005930" } }); // 한국 종목은 A 를 뗀다
    await svc.noteOrderEvent({ event: "FILL", order: { symbol: "../../x" } }); // 모양이 틀리면 무시
    await at("2026-09-29T05:05:00"); // 한국 9/28(늦게 찍음)·미국 9/28 둘 다 체결을 받는다 — 시장마다 그 시장 종목만
    expect([...toss.asked].sort()).toEqual(["3:005930", "3:NVDA", "3:SOXL"]);
    expect((await db.selectFrom("trade_executions").select("order_id").orderBy("order_id").execute()).map((r) => r.order_id)).toEqual(["n1", "n2"]);
    await features.set({ tradeRecords: false });
    const before = await db.selectFrom("meta").select("value").where("key", "=", "trade_records_seen").executeTakeFirst();
    await svc.noteOrderEvent({ event: "FILL", order: { symbol: "AMD" } });
    expect(await db.selectFrom("meta").select("value").where("key", "=", "trade_records_seen").executeTakeFirst()).toEqual(before);
  });

  it("스냅샷 사이 수량 변화가 주문 내역으로 설명되지 않으면 '추정' 으로 따로 보여 준다 (저장은 하지 않음)", async () => {
    const { toss, at, svc } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 30, 38)];
    await at("2026-09-29T05:05:00");
    toss.holdings[3] = [holding("SOXL", 15, 31, 38)];
    toss.orders["3:SOXL"] = [order("o1", "SOXL", "BUY", 3, 111, "2026-09-29T23:00:00+09:00")];
    await at("2026-09-30T05:05:00");
    const r = await svc.listTrades({ from: "2026-09-28", to: "2026-09-30" });
    expect(r.items.map((t) => t.orderId)).toEqual(["o1"]);
    expect(r.estimated).toEqual([expect.objectContaining({ code: "SOXL", fromDate: "2026-09-28", toDate: "2026-09-29", tradedQty: 3, unexplainedQty: 2, estimated: true })]);
  });
});

describe("토스 주문 내역 조회 (녹화한 모양의 픽스처)", () => {
  it("종료된 주문을 cursor 로 끝까지, 이어서 진행 중 주문 — 체결 0 은 빼고, 계좌번호 칸은 저장하지 않는다", async () => {
    const asked: string[] = [];
    const provider = new TossOpenApiProvider(
      new TossOpenApiClient({
        clientId: "c",
        clientSecret: "s",
        maxRetryWaitMs: 0,
        now: () => kst("2026-09-28T16:05:00"),
        fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 86400 }), { status: 200 });
          const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
          asked.push(`${url.pathname}?${url.searchParams.toString()} acct=${headers["x-tossinvest-account"]}`);
          if (url.pathname !== "/api/v1/orders") return new Response("{}", { status: 404 });
          const status = url.searchParams.get("status");
          const body = status === "OPEN" ? FIX("orders-open.json") : url.searchParams.get("cursor") === "cursor-p2" ? FIX("orders-closed-p2.json") : FIX("orders-closed-p1.json");
          return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
      }),
    );
    const list = await provider.orderHistory(3, "SOXL");
    expect(asked).toEqual([
      "/api/v1/orders?status=CLOSED&symbol=SOXL&limit=100 acct=3",
      "/api/v1/orders?status=CLOSED&symbol=SOXL&limit=100&cursor=cursor-p2 acct=3",
      "/api/v1/orders?status=OPEN&symbol=SOXL acct=3",
    ]);
    expect(list.map((o) => [o.orderId, o.side, o.status, o.quantity, o.amount, o.filledAt])).toEqual([
      ["ord-soxl-3", "SELL", "CLOSED", 5, 187.5, "2026-09-25T23:10:04+09:00"],
      ["ord-soxl-1", "BUY", "CLOSED", 20, 700, "2026-09-23T22:40:02+09:00"],
      ["ord-soxl-0", "BUY", "CLOSED", 10, 320.4, "2026-09-01T23:00:01+09:00"],
      ["ord-soxl-1", "BUY", "CLOSED", 20, 700, "2026-09-23T22:40:02+09:00"],
      ["ord-soxl-4", "BUY", "OPEN", 2, 76, null],
    ]);
    expect(list[1]!.raw).not.toHaveProperty("accountNo");
    expect(list[4]!.orderedAt).toBe("2026-09-28T22:35:00+09:00");
  });

  it("보유 조회 픽스처로 찍은 스냅샷: 토스가 준 수량·평단·현재가·평가금액 그대로", async () => {
    const provider = new TossOpenApiProvider(
      new TossOpenApiClient({
        clientId: "c",
        clientSecret: "s",
        maxRetryWaitMs: 0,
        now: () => kst("2026-09-28T16:05:00"),
        fetchFn: (async (input: string | URL | Request) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 86400 }), { status: 200 });
          if (url.pathname === "/api/v1/accounts") return new Response(JSON.stringify({ result: [{ accountNo: "x", accountSeq: 3, accountType: "BROKERAGE" }] }), { status: 200 });
          if (url.pathname === "/api/v1/holdings") return new Response(FIX("holdings-account-3.json"), { status: 200 });
          if (url.pathname === "/api/v1/orders") return new Response(JSON.stringify({ result: { orders: [], hasNext: false } }), { status: 200 });
          return new Response("{}", { status: 404 });
        }) as typeof fetch,
      }),
    );
    const db = await createMigratedDb(":memory:");
    const now = () => kst("2026-09-28T16:05:00");
    const svc = new TradeRecordService({ db, toss: provider, features: new FeatureService(db, now), displayFx: async () => 1390, now, pauseMs: 0 });
    await svc.tick();
    const [kr] = await svc.listSnapshots({ from: "2026-09-28", to: "2026-09-28", market: "KR" });
    expect(kr!.holdings.map((h) => [h.code, h.quantity, h.avgPrice, h.price, h.marketValue])).toEqual([
      ["005930", 10, 70000, 71200, 712000],
      ["035420", 9, 232555, 201500, 1813500],
    ]);
    expect(kr!.totals).toMatchObject({ holdings: 2, valueKrw: 2525500, costKrw: 2792995 });
    expect(kr!.accounts).toEqual([{ account: 3, purchaseKrw: 2792995, purchaseUsd: 1575.4, afterCostKrw: 2520247, afterCostUsd: 1892.35, rateAfterCost: 0.0421 }]);
  });
});

describe("매매 기록 — 읽기 API · /health · 백업 · 마이그레이션", () => {
  async function appWithRecords(flag = true) {
    const db = await createMigratedDb(":memory:");
    const now = () => kst("2026-10-01T17:00:00");
    const features = new FeatureService(db, now);
    const toss = new FakeToss();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200), holding("SOXL", 25, 33, 38.02)];
    toss.orders["3:005930"] = [order("K1", "005930", "BUY", 10, 700000, "2026-09-28T09:01:00+09:00")];
    const clock = { t: kst("2026-09-28T16:05:00") };
    const writer = new TradeRecordService({ db, toss, features, displayFx: async () => 1390, now: () => clock.t, pauseMs: 0 });
    for (const t of ["2026-09-28T16:05:00", "2026-09-29T05:05:00", "2026-10-01T10:00:00", "2026-10-01T16:05:00"]) {
      clock.t = kst(t);
      await writer.tick();
    }
    if (!flag) await features.set({ tradeRecords: false });
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(), logger: false, enableScheduler: false, now });
    return { app, db };
  }

  it("GET /api/snapshots · /api/trades · /api/trade-records 와 /health 의 tradeRecords (켜져 있을 때만)", async () => {
    const { app, db } = await appWithRecords();
    try {
      const snaps = (await app.inject({ method: "GET", url: "/api/snapshots?from=2026-09-28&to=2026-10-01" })).json();
      expect(snaps.enabled).toBe(true);
      expect(snaps.items.map((s: { market: string; date: string; status: string }) => `${s.market} ${s.date} ${s.status}`)).toEqual([
        "KR 2026-09-28 ok",
        "US 2026-09-28 ok",
        "KR 2026-09-29 gap",
        "US 2026-09-29 gap",
        "KR 2026-09-30 gap",
        "US 2026-09-30 gap",
        "KR 2026-10-01 ok",
      ]);
      const krOnly = (await app.inject({ method: "GET", url: "/api/snapshots?from=2026-09-28&to=2026-10-01&market=KR" })).json();
      expect(krOnly.items).toHaveLength(4);
      expect((await app.inject({ method: "GET", url: "/api/snapshots?from=2026-9-28" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/api/snapshots?from=2025-01-01&to=2026-10-01" })).statusCode).toBe(400); // 400일 넘는 범위
      const trades = (await app.inject({ method: "GET", url: "/api/trades?from=2026-09-01&to=2026-10-01" })).json();
      expect(trades).toMatchObject({ enabled: true, source: "toss-orders", items: [{ orderId: "K1", code: "005930", side: "BUY", quantity: 10, price: 70000, executedDate: "2026-09-28" }] });
      expect((await app.inject({ method: "GET", url: "/api/trades?from=2026-09-01&to=2026-10-01&code=SOXL" })).json().items).toEqual([]);
      const status = (await app.inject({ method: "GET", url: "/api/trade-records" })).json();
      expect(status).toMatchObject({ enabled: true, since: "2026-09-28", days: 2, markets: { KR: { missing5: ["2026-09-30", "2026-09-29"] } } });
      const health = (await app.inject({ method: "GET", url: "/health" })).json();
      expect(health.tradeRecords).toMatchObject({ since: "2026-09-28", days: 2, warning: "최근 5거래일 중 스냅샷 없는 날: 한국 9/29·9/30, 미국 9/29·9/30", trades: { count: 1 } });
      expect(health.ok).toBe(true);
      const admin = (await app.inject({ method: "GET", url: "/api/admin/trade-records" })).json();
      expect(admin).toMatchObject({ enabled: true, toss: false });
      // 토스 키가 없는 서버에서는 지금 찍기·체결 받기를 할 수 없다
      expect((await app.inject({ method: "POST", url: "/api/admin/trade-records/snapshot", payload: { market: "KR" } })).statusCode).toBe(503);
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  it("플래그를 끄면 새 경로는 빈 값, /health 에 칸이 없고, 관리 실행은 409", async () => {
    const { app, db } = await appWithRecords(false);
    try {
      expect((await app.inject({ method: "GET", url: "/api/snapshots?from=2026-09-28&to=2026-10-01" })).json()).toEqual({ enabled: false, items: [] });
      expect((await app.inject({ method: "GET", url: "/api/trades" })).json()).toEqual({ enabled: false, items: [], estimated: [] });
      expect((await app.inject({ method: "GET", url: "/api/trade-records" })).json()).toEqual({ enabled: false });
      expect((await app.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty("tradeRecords");
      expect((await app.inject({ method: "POST", url: "/api/admin/trade-records/snapshot", payload: { market: "KR" } })).statusCode).toBe(409);
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  it("어제와 비교용: 그 날짜 전 가장 가까운 스냅샷(빈칸 건너뜀)", async () => {
    const { app, db } = await appWithRecords();
    try {
      const svc = app.tradeRecords;
      expect((await svc.previousSnapshot("KR", "2026-10-01"))?.date).toBe("2026-09-28");
      expect(await svc.previousSnapshot("KR", "2026-09-28")).toBeNull();
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  it("새 표 두 개가 백업 목록에 있고, 예전 백업(새 표 없음)도 그대로 되살아난다", async () => {
    expect(BACKUP_TABLES).toContain("account_snapshots");
    expect(BACKUP_TABLES).toContain("trade_executions");
    const { app, db } = await appWithRecords();
    await app.close();
    const dir = await mkdtemp(join(tmpdir(), "trbk-"));
    const st = await new BackupService({ db, dialect: "sqlite", dir, key: "k", now: () => kst("2026-10-01T07:10:00") }).run();
    expect(st.lastCounts).toMatchObject({ account_snapshots: 7, trade_executions: 1 });
    const fresh = await createMigratedDb(":memory:");
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const t of ["account_snapshots", "trade_executions"]) tables[t] = (await sql<Record<string, unknown>>`select * from ${sql.table(t)}`.execute(db)).rows;
    expect(await restoreBackup(fresh, "sqlite", { version: 1, createdAt: "x", tables })).toMatchObject({ account_snapshots: 7, trade_executions: 1 });
    const old = await createMigratedDb(":memory:");
    expect(await restoreBackup(old, "sqlite", { version: 1, createdAt: "x", tables: { registered_stocks: [] } })).toMatchObject({ account_snapshots: 0, trade_executions: 0 });
    await db.destroy();
  });

  it("마이그레이션 8: 두 표와 고유 색인, 두 번 돌려도 안전", async () => {
    const db: Db = await createMigratedDb(":memory:");
    await migrate(db, "sqlite");
    const versions = await sql<{ version: number }>`select version from schema_version order by version`.execute(db);
    expect(versions.rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const idx = await sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name in ('account_snapshots', 'trade_executions') order by name`.execute(db);
    expect(idx.rows.map((r) => r.name)).toEqual(expect.arrayContaining(["uq_account_snapshots_date_market", "uq_trade_executions_account_order"]));
    await db.destroy();
  });
});
