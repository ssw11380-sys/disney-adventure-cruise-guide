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
import { regularCloseLookup, TRADE_RETRIES, TradeRecordService, type RegularClose, type TradeRecordDeps, type TradeRecordToss } from "../src/services/tradeRecordService.js";
import { fakeProviders } from "./helpers.js";

/**
 * 매매 기록 기반 (3-36): 일별 계좌 스냅샷·체결 저장. 네트워크 없음 — 토스는 가짜(FakeToss) 또는 녹화한 모양의 픽스처(test/fixtures/tradeRecords),
 * 시계는 고정. 픽스처의 칸은 서버가 이미 운영에서 읽고 있는 칸(주문: orderId·side·orderedAt·execution.filledQuantity/filledAmount/filledAt,
 * 보유: symbol·quantity·averagePurchasePrice·lastPrice·marketValue)만 쓴다. 값은 예시다
 */

const FIX = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/tradeRecords/${name}`, import.meta.url)), "utf8");
const kst = (s: string) => new Date(`${s}+09:00`);
/** 원화 합계용 환율 — 운영(fundamentals.usdKrwQuote)처럼 실제 출처·받은 시각과 함께 */
const FX = async () => ({ rate: 1390, source: "toss", asOf: "2026-09-28T16:04:30+09:00" });

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
  truncated = new Set<string>();
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
    return { orders: this.orders[`${seq}:${symbol}`] ?? [], truncated: this.truncated.has(`${seq}:${symbol}`) };
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

async function setup(
  opts: {
    flag?: boolean;
    isTradingDate?: (m: "KR" | "US", d: string) => Promise<boolean>;
    /** 시계가 흐르게: now() 를 부를 때마다 이만큼(ms) 간다 (없으면 멈춘 시계) */
    stepMs?: number;
    regularCloses?: TradeRecordDeps["regularCloses"];
  } = {},
) {
  const db = await createMigratedDb(":memory:");
  const clock = { t: kst("2026-09-28T09:00:00") };
  const now = () => {
    const d = new Date(clock.t.getTime());
    if (opts.stepMs) clock.t = new Date(clock.t.getTime() + opts.stepMs);
    return d;
  };
  const features = new FeatureService(db, now);
  if (opts.flag === false) await features.set({ tradeRecords: false });
  const toss = new FakeToss();
  const warns: string[] = [];
  const make = () =>
    new TradeRecordService({
      db,
      toss,
      features,
      displayFx: FX,
      now,
      retryMs: 5 * 60_000,
      pauseMs: 0,
      log: { info: () => {}, warn: (_o, m) => void warns.push(m) },
      ...(opts.isTradingDate ? { isTradingDate: opts.isTradingDate } : {}),
      ...(opts.regularCloses ? { regularCloses: opts.regularCloses } : {}),
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
    expect(us).toMatchObject({ method: "close", scheduledAt: "2026-11-28T03:05:00+09:00", fx: { usdKrw: 1390, source: "toss", asOf: "2026-09-28T16:04:30+09:00" } });
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
    const svc = new TradeRecordService({ db, toss, features: new FeatureService(db, now), displayFx: FX, now, startupDelayMs: 0, tickMs: 60_000, pauseMs: 0 });
    svc.start();
    try {
      await vi.waitFor(async () => expect((await db.selectFrom("account_snapshots").select("method").execute()).map((r) => r.method)).toEqual(["intraday-fallback"]));
    } finally {
      await svc.stop();
    }
  });
});

describe("매매 기록 — 토스 응답을 계좌마다 확인 (한 계좌 몫이 빠진 스냅샷을 남기지 않음)", () => {
  const overview = (purchaseUsd: number | null, purchaseKrw = 0) => ({ purchaseKrw, purchaseUsd, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null });

  it("계좌가 여럿일 때 한 계좌 보유 목록만 비어 오면(그 계좌 요약 매입금액은 있음) 찍지 않고 5분 뒤 다시 — 두 계좌 몫이 다 든 스냅샷, 다음 날 틀린 '추정' 없음", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    const tsla = [holding("TSLA", 2, 300, 377)];
    toss.holdings[7] = [];
    toss.overview[7] = overview(600);
    await at("2026-09-29T05:05:00"); // 미국 9/28 16:05 EDT
    expect(await rows("US")).toEqual([]); // 예전 검사는 계좌 3 에 미국 종목이 있어 valueUsd 380(실제 1134)을 'ok' 로 남겼다
    expect((await svc.status()).markets.US.lastError).toContain("계좌 7: 미국 보유 목록이 비었는데 계좌 요약 매입금액은 $600");
    toss.holdings[7] = tsla;
    delete toss.overview[7];
    await at("2026-09-29T05:10:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]);
    const [s1] = await svc.listSnapshots({ from: "2026-09-28", to: "2026-09-28", market: "US" });
    expect(s1!.holdings.map((h) => [h.account, h.code, h.quantity])).toEqual([
      [3, "SOXL", 10],
      [7, "TSLA", 2],
    ]);
    expect(s1!.totals!.valueUsd).toBe(1134);
    expect(s1!.reason).toBeNull();
    await at("2026-09-30T05:05:00");
    expect((await rows("US")).at(-1)).toBe("US 2026-09-29 ok close");
    expect((await svc.listTrades({ from: "2026-09-28", to: "2026-09-30" })).estimated).toEqual([]); // 예전에는 TSLA +2 '추정'
  });

  it("직전 스냅샷에 있던 계좌가 계좌 목록에서 잠깐 빠지면 찍지 않고 다시", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.holdings[7] = [holding("TSLA", 2, 300, 377)];
    await at("2026-09-29T05:05:00");
    toss.accountList = [3];
    await at("2026-09-30T05:05:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]);
    expect((await svc.status()).markets.US.lastError).toContain("계좌 7: 전에 미국 종목이 있던 계좌가 토스 계좌 목록에서 빠짐");
    toss.accountList = [3, 7];
    await at("2026-09-30T05:10:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
    expect((await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" }))[0]!.totals!.valueUsd).toBe(1134);
  });

  it("목록 일부만 오면(종목 매입금액 합계 ≠ 계좌 요약) 찍지 않고 다시", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)]; // TSLA($600)가 빠진 응답
    toss.overview[3] = overview(930);
    await at("2026-09-29T05:05:00");
    expect(await rows("US")).toEqual([]);
    expect((await svc.status()).markets.US.lastError).toContain("미국 종목 매입금액 합계 $330 ≠ 계좌 요약 $930");
    delete toss.overview[3];
    await at("2026-09-29T05:10:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]);
  });

  it("전부 판 빈 계좌(목록이 비었고 달러 요약도 없음, 전에는 종목이 있었음)는 30분 넘게·두 번 이상 이어지면 받아들여 0종목 스냅샷 — 의심을 reason·doubts 에 적는다", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    await at("2026-09-29T05:05:00");
    toss.holdings[3] = [];
    toss.overview[3] = overview(null);
    for (const t of ["05:05", "05:10", "05:15", "05:20", "05:25", "05:30"]) await at(`2026-09-30T${t}:00`);
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]);
    await at("2026-09-30T05:35:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
    const [s] = await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" });
    expect(s).toMatchObject({ holdings: [], totals: { holdings: 0 } });
    expect(s!.reason).toMatch(/^의심을 안고 저장.*빈 계좌인지 확인할 수 없음/);
    expect(s!.doubts).toEqual([{ kind: "unsure", account: 3, text: expect.stringContaining("계좌 3: 보유 목록이 비었고") }]);
    // 같은 상태가 이어지면 다음 거래일은 의심 없이 곧바로 (직전 스냅샷에 그 계좌 종목이 없으니 확인할 것이 없다 — 날마다 30분씩 늦지 않게)
    await at("2026-10-01T05:05:00");
    expect((await rows("US")).at(-1)).toBe("US 2026-09-30 ok close");
    expect((await svc.listSnapshots({ from: "2026-09-30", to: "2026-09-30", market: "US" }))[0]!).toMatchObject({ reason: null, doubts: [] });
  });

  it("늘 비어 있는 두 번째 계좌(달러 요약 없이 옴)는 의심하지 않는다 — 첫 스냅샷부터 마감 때 곧바로, reason 비어 있음", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("005930", 10, 70000, 71200), holding("SOXL", 10, 33, 38)];
    toss.holdings[7] = [];
    toss.overview[7] = overview(null);
    await at("2026-09-28T16:05:00");
    await at("2026-09-29T05:05:00");
    await at("2026-09-29T16:05:00");
    await at("2026-09-30T05:05:00");
    expect(await rows()).toEqual(["KR 2026-09-28 ok close", "KR 2026-09-29 ok close", "US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
    const snaps = await svc.listSnapshots({ from: "2026-09-28", to: "2026-09-29" });
    expect(snaps.map((s) => s.reason)).toEqual([null, null, null, null]);
    expect(snaps.every((s) => s.doubts.length === 0)).toBe(true);
  });

  it("첫 스냅샷이라도 토스 동기화가 마지막으로 믿은 보유에 종목이 있던 계좌가 통째로 비어 오면(달러 요약도 없음) 믿지 않고 다시", async () => {
    const { toss, at, rows, db } = await setup();
    await db.insertInto("meta").values({ key: "toss_holdings_accounts", value: JSON.stringify({ held: { "3": ["005930"] }, doubt: {} }) }).execute();
    toss.holdings[3] = [];
    toss.overview[3] = overview(null);
    await at("2026-09-28T16:05:00");
    expect(await rows("KR")).toEqual([]);
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    delete toss.overview[3];
    await at("2026-09-28T16:10:00");
    expect(await rows("KR")).toEqual(["KR 2026-09-28 ok close"]);
  });

  it("한 계좌 목록만 계속 비어 오면 그 거래일은 까닭을 적은 빈칸, 24시간 넘게 이어지면 다음 거래일에 의심을 적고 저장", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.holdings[7] = [];
    toss.overview[7] = overview(600);
    await at("2026-09-29T05:05:00");
    await at("2026-09-29T08:30:00");
    await at("2026-09-29T10:00:00"); // 뉴욕 9/28 21:00 — 9/28 거래일이 지남
    expect(await rows("US")).toEqual(["US 2026-09-28 gap"]);
    expect((await svc.listSnapshots({ from: "2026-09-28", to: "2026-09-28", market: "US" }))[0]!.reason).toContain("계좌 7: 미국 보유 목록이 비었는데");
    await at("2026-09-30T05:05:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 gap", "US 2026-09-29 ok close"]);
    const [s] = await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" });
    expect(s!.reason).toMatch(/^의심을 안고 저장\(계좌 몫이 빠졌을 수 있음\) — 계좌 7/);
    expect(s!.holdings.map((h) => h.code)).toEqual(["SOXL"]);
  });

  it("관리 API 로 찍을 때도 의심스러우면 409(SNAPSHOT_DOUBT), force 면 의심을 적고 저장", async () => {
    const { toss, svc, clock } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.holdings[7] = [];
    toss.overview[7] = overview(600);
    clock.t = kst("2026-09-29T05:06:00");
    await expect(svc.snapshotNow("US")).rejects.toMatchObject({ statusCode: 409, code: "SNAPSHOT_DOUBT" });
    const s = await svc.snapshotNow("US", { force: true });
    expect(s).toMatchObject({ status: "ok", date: "2026-09-28" });
    expect(s.reason).toContain("계좌 7");
    expect(s.doubts).toEqual([{ kind: "empty", account: 7, text: "계좌 7: 미국 보유 목록이 비었는데 계좌 요약 매입금액은 $600" }]);
  });

  it("한 번 받아들인 의심이 있어도 다음 날 내용이 다른 의심(잠깐 목록 일부만 옴)은 곧바로 받아들이지 않고 다시 묻는다 — 받아들인 것과 똑같은 상태는 곧바로", async () => {
    const { toss, at, rows, svc } = await setup();
    const soxl = holding("SOXL", 10, 33, 38);
    const tsla = holding("TSLA", 2, 300, 377);
    toss.holdings[3] = [soxl, tsla];
    toss.overview[3] = overview(960); // 종목 합계 $930 과 늘 $30 차이 나는 계좌 (정말 이어지는 상태)
    for (let m = 5; m <= 35; m += 5) await at(`2026-09-29T05:${String(m).padStart(2, "0")}:00`);
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]);
    const [d1] = await svc.listSnapshots({ from: "2026-09-28", to: "2026-09-28", market: "US" });
    expect(d1!.doubts.map((d) => d.text)).toEqual(["계좌 3: 미국 종목 매입금액 합계 $930 ≠ 계좌 요약 $960"]);
    // 다음 거래일: 첫 응답에 TSLA 가 잠깐 빠짐 → 내용이 다른 의심이라 처음부터 센다 (예전에는 곧바로 valueUsd 380 을 'ok close' 로 저장)
    toss.holdings[3] = [soxl];
    await at("2026-09-30T05:05:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]);
    expect((await svc.status()).markets.US.lastError).toContain("$330 ≠ 계좌 요약 $960");
    // 5분 뒤 제대로 온 응답은 어제 받아들인 것과 똑같은 의심이라 곧바로 저장
    toss.holdings[3] = [soxl, tsla];
    await at("2026-09-30T05:10:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
    const [d2] = await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" });
    expect(d2!.totals!.valueUsd).toBe(1134); // TSLA 몫까지 든 값
    expect(d2!.holdings.map((h) => h.code)).toEqual(["SOXL", "TSLA"]);
    expect(d2!.method).toBe("close");
  });

  it("30분짜리 의심은 5분 간격으로 이어 본 것만 센다 — 전날 한 번 본 것으로 다음 날 곧바로 받아들이지 않는다", async () => {
    const { toss, at, rows } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.overview[3] = overview(930);
    await at("2026-09-29T05:05:00"); // 한 번 보고
    toss.fail = "HTTP 503"; // 그 거래일 내내 토스 오류
    await at("2026-09-29T08:00:00");
    await at("2026-09-29T10:00:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 gap"]);
    toss.fail = null;
    await at("2026-09-30T05:05:00"); // 예전에는 '처음 본 지 24시간·두 번째'라 곧바로 저장
    expect(await rows("US")).toEqual(["US 2026-09-28 gap"]);
    for (let m = 10; m <= 35; m += 5) await at(`2026-09-30T05:${m}:00`);
    expect(await rows("US")).toEqual(["US 2026-09-28 gap", "US 2026-09-29 ok close"]);
  });

  it("의심을 센 기록은 상태(meta)에 남아 서버를 다시 켜도 이어 센다 — 24시간짜리 의심이 재배포 때문에 날마다 빈칸이 되지 않는다", async () => {
    const { toss, clock, make, db } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.holdings[7] = [];
    toss.overview[7] = overview(600);
    const run = async (s: string) => {
      clock.t = kst(s);
      const svc = make(); // 매번 새 서버 (Railway 는 병합마다 다시 켠다)
      await svc.tick();
      return svc;
    };
    await run("2026-09-29T05:05:00");
    await run("2026-09-29T05:10:00");
    await run("2026-09-29T10:00:00"); // 9/28 거래일이 지나 빈칸
    const svc = await run("2026-09-30T05:05:00");
    const us = (await db.selectFrom("account_snapshots").select(["snapshot_date", "status"]).where("market", "=", "US").orderBy("snapshot_date").execute()).map((r) => `${r.snapshot_date} ${r.status}`);
    expect(us).toEqual(["2026-09-28 gap", "2026-09-29 ok"]);
    expect((await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" }))[0]!.reason).toMatch(/^의심을 안고 저장.*계좌 7/);
  });

  it("의심을 안고 저장한 스냅샷은 doubts 로 드러나고, '어제와 비교'는 skipDoubted 로 건너뛸 수 있다", async () => {
    const { toss, at, svc } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.holdings[7] = [holding("TSLA", 2, 300, 377)];
    await at("2026-09-29T05:05:00"); // 9/28 믿을 수 있음
    toss.holdings[7] = [];
    toss.overview[7] = overview(600);
    await at("2026-09-30T05:05:00");
    await at("2026-09-30T10:00:00"); // 9/29 빈칸
    await at("2026-10-01T05:05:00"); // 9/30 은 24시간이 넘어 의심을 안고 저장
    const doubted = (await svc.listSnapshots({ from: "2026-09-30", to: "2026-09-30", market: "US" }))[0]!;
    expect(doubted.doubts.map((d) => [d.kind, d.account])).toEqual([["empty", 7]]);
    expect((await svc.previousSnapshot("US", "2026-10-01"))?.date).toBe("2026-09-30");
    expect((await svc.previousSnapshot("US", "2026-10-01", { skipDoubted: true }))?.date).toBe("2026-09-28");
    // 추정도 계좌 7 은 의심 스냅샷을 건너뛴다 (가짜 TSLA −2 없음)
    expect((await svc.listTrades({ from: "2026-09-28", to: "2026-10-01" })).estimated).toEqual([]);
  });
});

describe("매매 기록 — 검토 반영 3: 의심 기준 (계좌·합계·사라진 종목·전부 판 계좌)", () => {
  const overview = (purchaseUsd: number | null, purchaseKrw = 0) => ({ purchaseKrw, purchaseUsd, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null });

  it("늘 비어 있는 계좌가 계좌 목록에서 잠깐 빠져도 의심하지 않는다 — 그 시장 종목이 있던 계좌만 (한국 종목만 있는 계좌가 빠져도 미국 스냅샷은 그대로)", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.accountList = [3, 5, 7];
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.holdings[5] = [];
    toss.overview[5] = overview(null); // 늘 비어 있는 계좌 (달러 요약 없이 옴)
    toss.holdings[7] = [holding("005930", 10, 70000, 71200)];
    await at("2026-09-28T16:05:00"); // 한국 9/28
    await at("2026-09-29T05:05:00"); // 미국 9/28
    toss.accountList = [3, 7]; // 계좌 5 가 잠깐 빠짐 — 예전에는 24시간짜리 의심이라 한국 9/29 가 통째로 빈칸이 됐다
    await at("2026-09-29T16:05:00");
    expect(await rows("KR")).toEqual(["KR 2026-09-28 ok close", "KR 2026-09-29 ok close"]);
    expect((await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "KR" }))[0]!).toMatchObject({ reason: null, doubts: [] });
    toss.accountList = [3, 5]; // 한국 종목만 있는 계좌 7 이 빠짐 — 미국 스냅샷은 곧바로, 한국은 다시 묻는다
    await at("2026-09-30T05:05:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
    expect((await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" }))[0]!).toMatchObject({ reason: null, doubts: [] });
    await at("2026-09-30T16:05:00");
    expect(await rows("KR")).toEqual(["KR 2026-09-28 ok close", "KR 2026-09-29 ok close"]);
    expect((await svc.status()).markets.KR.lastError).toContain("계좌 7: 전에 한국 종목이 있던 계좌가 토스 계좌 목록에서 빠짐");
  });

  it("요약의 1% 보다 작은 종목 하나만 빠진 응답도 믿지 않는다 — 합계는 종목 수 × 1센트까지만, 직전 스냅샷 종목이 매도 없이 사라지면 의심. 정말 판 날은 곧바로", async () => {
    const { toss, at, rows, svc } = await setup();
    const soxl = holding("SOXL", 100, 33, 38); // $3,300
    const aapl = holding("AAPL", 0.1, 200, 230); // $20
    toss.holdings[3] = [soxl, aapl];
    await at("2026-09-29T05:05:00"); // 미국 9/28
    // 9/29: AAPL 이 빠진 응답, 요약은 $3,320 그대로 (예전 1% 허용치 $33.2 안이라 'ok' 로 영구 저장되고 추정에 가짜 AAPL −0.1·+0.1 이 생겼다)
    toss.holdings[3] = [soxl];
    toss.overview[3] = overview(3320);
    await at("2026-09-30T05:05:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]);
    const err = (await svc.status()).markets.US.lastError ?? "";
    expect(err).toContain("$3300 ≠ 계좌 요약 $3320");
    expect(err).toContain("직전 스냅샷의 AAPL 0.1주");
    // 요약까지 AAPL 을 뺀 모양으로 와도(합계는 맞음) 그 사이 매도가 없으면 의심
    toss.overview[3] = overview(3300);
    await at("2026-09-30T05:10:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]);
    expect((await svc.status()).markets.US.lastError).not.toContain("≠");
    // 제대로 온 응답은 곧바로
    toss.holdings[3] = [soxl, aapl];
    delete toss.overview[3];
    await at("2026-09-30T05:15:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
    expect((await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" }))[0]!).toMatchObject({ method: "close", reason: null, doubts: [], totals: { holdings: 2 } });
    // 정말 판 날(매도 체결이 저장됨)은 사라져도 곧바로
    toss.holdings[3] = [soxl];
    toss.orders["3:AAPL"] = [order("a1", "AAPL", "SELL", 0.1, 23, "2026-09-30T23:00:00+09:00")];
    await at("2026-10-01T05:05:00");
    expect((await rows("US")).at(-1)).toBe("US 2026-09-30 ok close");
    expect((await svc.listTrades({ from: "2026-09-28", to: "2026-09-30" })).estimated).toEqual([]);
  });

  it("계좌 하나를 전부 판 날: 목록이 비고 달러 요약이 없어도 저장한 매도가 직전 보유를 모두 설명하면 곧바로 'close' — 의심 없이, '어제와 비교'도 그날을 쓴다", async () => {
    const { toss, at, rows, svc } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.holdings[7] = [holding("TSLA", 2, 300, 377)];
    await at("2026-09-29T05:05:00"); // 미국 9/28
    toss.holdings[7] = [];
    toss.overview[7] = overview(null); // 전부 팔면 토스는 달러 요약 없이 준다
    toss.orders["7:TSLA"] = [order("t9", "TSLA", "SELL", 2, 760, "2026-09-29T23:10:00+09:00")];
    await at("2026-09-30T05:05:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]); // 예전에는 30분 넘게 'unsure' 로 기다렸다 의심을 안고 저장
    const [s] = await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" });
    expect(s).toMatchObject({ method: "close", reason: null, doubts: [] });
    expect((await svc.previousSnapshot("US", "2026-09-30", { skipDoubted: true }))?.date).toBe("2026-09-29");
    expect((await svc.listTrades({ from: "2026-09-28", to: "2026-09-29" })).estimated).toEqual([]);
    // 매도가 모자라면(저장된 매도 4주 < 직전 10주) 예전처럼 'unsure' 로 기다린다
    toss.holdings[3] = [];
    toss.overview[3] = overview(null);
    toss.orders["3:SOXL"] = [order("s9", "SOXL", "SELL", 4, 152, "2026-09-30T23:10:00+09:00")];
    await at("2026-10-01T05:05:00");
    expect((await rows("US")).at(-1)).toBe("US 2026-09-29 ok close");
    expect((await svc.status()).markets.US.lastError).toContain("계좌 3: 보유 목록이 비었고");
  });
});

describe("매매 기록 — 검토 반영 3: 체결 시각·짝·기간·정규장 종가", () => {
  it("체결 시각이 없는 몫·처음 본 주문은 그 스냅샷 시각(as_of)으로 — 시계가 흘러도(부를 때마다 1초) 이미 스냅샷에 든 체결이 다음 구간 '추정'으로 넘어가지 않는다", async () => {
    const { toss, at, svc, db } = await setup({ stepMs: 1000 });
    toss.holdings[3] = [holding("SOXL", 7, 33, 38)];
    await at("2026-09-26T05:05:00"); // 미국 9/25 (금)
    // 9/28: 저장소 픽스처 orders-open.json 모양의 진행 중 주문 p1(체결 시각 없음, 주문 시각만) 3주 + 시각이 하나도 없는 주문 s1 1주
    const p1 = (q: number) => order("p1", "SOXL", "BUY", q, q * 37, null, "OPEN");
    const s1 = (q: number) => ({ ...order("s1", "SOXL", "BUY", q, q * 37, null, "OPEN"), orderedAt: null });
    toss.holdings[3] = [holding("SOXL", 11, 34, 38)];
    toss.orders["3:SOXL"] = [p1(3), s1(1)];
    await at("2026-09-29T05:05:00");
    // 9/29: 두 주문이 2주씩 더 체결 (여전히 체결 시각 없음)
    toss.holdings[3] = [holding("SOXL", 15, 35, 38)];
    toss.orders["3:SOXL"] = [p1(5), s1(3)];
    await at("2026-09-30T05:05:00");
    await at("2026-10-01T05:05:00"); // 9/30: 변화 없음
    const snaps = await svc.listSnapshots({ from: "2026-09-25", to: "2026-09-30", market: "US" });
    expect(snaps.map((s) => `${s.date} ${s.status}`)).toEqual(["2026-09-25 ok", "2026-09-28 ok", "2026-09-29 ok", "2026-09-30 ok"]);
    // 몫의 시각은 그 몫을 본 스냅샷의 as_of 이하 (예전에는 스냅샷을 찍은 뒤 받은 시각이라 몇 초 늦었다)
    const asOf = new Map(snaps.map((s) => [s.date, Date.parse(s.asOf)]));
    const s1Fills = (await svc.listTrades({ from: "2026-09-25", to: "2026-09-30" })).items.find((t) => t.orderId === "s1")!.fills;
    expect(s1Fills.map((f) => f.quantity)).toEqual([1, 2]);
    expect(Date.parse(s1Fills[0]!.at)).toBeLessThanOrEqual(asOf.get("2026-09-28")!);
    expect(Date.parse(s1Fills[1]!.at)).toBeLessThanOrEqual(asOf.get("2026-09-29")!);
    expect(Date.parse(s1Fills[1]!.at)).toBeGreaterThan(asOf.get("2026-09-28")!);
    // 예전에는 SOXL +2(9/28→9/29)·−2(9/29→9/30), s1 도 ±1·±2 가 '추정'으로 나왔다
    expect((await svc.listTrades({ from: "2026-09-25", to: "2026-09-30" })).estimated).toEqual([]);
    // 주문 시각으로 적힌 주문(p1 — 마지막 체결일은 9/28)도 9/29 하루로 물으면 그날 몫(2주)이 있어 나온다
    const d29 = (await svc.listTrades({ from: "2026-09-29", to: "2026-09-29" })).items.find((t) => t.orderId === "p1")!;
    expect(d29).toMatchObject({ executedDate: "2026-09-28", timeBasis: "ordered" });
    expect(d29.fills.filter((f) => f.date === "2026-09-29").map((f) => f.quantity)).toEqual([2]);
    expect((await db.selectFrom("trade_executions").select("order_id").execute()).length).toBe(2);
  });

  it("체결은 그 종목을 가졌던 (계좌, 종목) 짝만 묻는다 — 주문 내역 조회가 늘 오류인 빈 계좌는 묻지 않고, 실패는 짝으로 세어 그 짝만 다시", async () => {
    const { toss, at, svc } = await setup();
    toss.accountList = [3, 5, 7];
    toss.holdings[3] = [holding("005930", 10, 70000, 71200), holding("035420", 9, 232555, 201500)];
    toss.holdings[5] = [];
    toss.holdings[7] = [holding("005930", 1, 71000, 71200)];
    for (const c of ["005930", "035420", "000660"]) toss.ordersFail[`5:${c}`] = "HTTP 403 forbidden"; // 계좌 5 는 주문 내역 조회가 늘 오류
    toss.ordersFail["7:005930"] = "HTTP 429 rate-limit-exceeded";
    // 계좌 없이 온 체결 알림(000660) — 그 시장 종목을 가진 계좌(3·7)에만 묻는다
    await svc.noteOrderEvent({ event: "FILL", order: { symbol: "000660" } });
    await at("2026-09-28T16:05:00");
    expect([...toss.asked].sort()).toEqual(["3:000660", "3:005930", "3:035420", "7:000660", "7:005930"]); // 예전에는 모든 계좌 × 모든 종목 (5:* 가 날마다 실패)
    let st = await svc.status();
    expect(st.trades.failing).toEqual({ KR: ["005930"] });
    expect(st.trades.failingPairs).toEqual({ KR: ["7:005930"] });
    expect(Object.keys(st.trades.coverage).sort()).toEqual(["000660", "035420"]);
    toss.asked = [];
    await at("2026-09-28T16:10:00");
    expect(toss.asked).toEqual(["7:005930"]); // 실패한 짝만 (3:005930 은 다시 묻지 않음)
    delete toss.ordersFail["7:005930"];
    await at("2026-09-28T16:15:00");
    st = await svc.status();
    expect(st.trades.failing).toEqual({});
    expect(st.warning).toBeNull();
    expect(Object.keys(st.trades.coverage).sort()).toEqual(["000660", "005930", "035420"]);
    // 다음 거래일에도 계좌 5 는 묻지 않는다
    toss.asked = [];
    await at("2026-09-29T16:05:00");
    expect(toss.asked.some((a) => a.startsWith("5:"))).toBe(false);
    expect((await svc.status()).trades.failing).toEqual({});
  });

  it("계좌가 온 체결 알림은 그 (계좌, 종목) 짝만 묻는다", async () => {
    const { toss, at, svc } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("SOXL", 10, 30, 38)];
    toss.holdings[7] = [holding("TSLA", 1, 300, 377)];
    await svc.noteOrderEvent({ event: "FILL", accountSeq: 7, order: { symbol: "NVDA" } });
    await at("2026-09-29T05:05:00");
    expect(toss.asked.filter((a) => a.endsWith(":NVDA"))).toEqual(["7:NVDA"]);
  });

  it("종목마다 그 거래일 정규장 종가(regularClose)를 현재가(price)와 따로 적는다 — 받지 못하면 null, 실패해도 스냅샷은 저장", async () => {
    const asked: string[] = [];
    let broken = false;
    const regularCloses: TradeRecordDeps["regularCloses"] = async (market, date, codes) => {
      asked.push(`${market} ${date} ${codes.join(",")}`);
      if (broken) throw new Error("일봉 소스 모두 실패");
      const closes: Record<string, RegularClose> = { "005930": { close: 71000, source: "naver" }, SOXL: { close: 37.5, source: "toss" } };
      return new Map(codes.filter((c) => closes[c]).map((c) => [c, closes[c]!]));
    };
    const { toss, at, svc } = await setup({ regularCloses });
    toss.holdings[3] = [holding("005930", 10, 70000, 71200), holding("SOXL", 25, 33, 38.02), holding("TSLA", 1, 300, 377)];
    await at("2026-09-28T16:05:00");
    await at("2026-09-29T05:05:00");
    expect(asked).toEqual(["KR 2026-09-28 005930", "US 2026-09-28 SOXL,TSLA"]);
    const [kr] = await svc.listSnapshots({ from: "2026-09-28", to: "2026-09-28", market: "KR" });
    expect(kr!.holdings[0]).toMatchObject({ code: "005930", price: 71200, regularClose: 71000, regularCloseSource: "naver", valueKrw: 712000 });
    expect(kr!.priceBasis).toContain("KRX+NXT 통합"); // 현재가 설명은 그대로
    const [us] = await svc.listSnapshots({ from: "2026-09-28", to: "2026-09-28", market: "US" });
    expect(us!.holdings.map((h) => [h.code, h.price, h.regularClose, h.regularCloseSource])).toEqual([
      ["SOXL", 38.02, 37.5, "toss"],
      ["TSLA", 377, null, null],
    ]);
    broken = true;
    await at("2026-09-29T16:05:00");
    const [kr2] = await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "KR" });
    expect(kr2).toMatchObject({ status: "ok", method: "close" });
    expect(kr2!.holdings[0]).toMatchObject({ price: 71200, regularClose: null, regularCloseSource: null });
  });

  it("regularCloseLookup: 그 거래일 봉이 없거나 실패하면 다음 소스, 끝까지 없으면 뺀다 (한국은 네이버만 — 토스 통합 종가를 쓰지 않음)", async () => {
    const src = (name: string, rows: Record<string, Array<[string, number]>>, fail: string[] = []) => ({
      name,
      getCandles: async (code: string) => {
        if (fail.includes(code)) throw new Error(`${name} 실패`);
        return { code, period: "D" as const, candles: (rows[code] ?? []).map(([date, close]) => ({ date, open: close, high: close, low: close, close, volume: 0 })), source: name };
      },
    });
    const look = regularCloseLookup({
      KR: [src("naver", { "005930": [["2026-09-25", 70000], ["2026-09-28", 71000]] })],
      US: [src("toss", { SOXL: [["2026-09-25", 36]], TSLA: [["2026-09-28", 380]] }, ["NVDA"]), src("yahoo", { SOXL: [["2026-09-28", 37.5]], NVDA: [["2026-09-28", 180]] })],
    });
    expect(await look("KR", "2026-09-28", ["005930", "000660"])).toEqual(new Map([["005930", { close: 71000, source: "naver" }]]));
    expect(await look("US", "2026-09-28", ["SOXL", "TSLA", "NVDA", "AMD"])).toEqual(
      new Map([
        ["SOXL", { close: 37.5, source: "yahoo" }],
        ["TSLA", { close: 380, source: "toss" }],
        ["NVDA", { close: 180, source: "yahoo" }],
      ]),
    );
  });
});

describe("매매 기록 — 검토 반영 4: 소수 수량·첫 몫의 시각·그 뒤 산 계좌", () => {
  const overview = (purchaseUsd: number | null, purchaseKrw = 0) => ({ purchaseKrw, purchaseUsd, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null });

  it("소수 여섯째 자리 수량을 전부 판 날도 곧바로 'close' — 0.123444·0.123456주, 다른 종목이 남은 계좌의 16.123444주 (예전에는 넷째 자리로 잘라 가짜 의심)", async () => {
    for (const q of [0.123444, 0.123456]) {
      const { toss, at, rows, svc } = await setup();
      toss.accountList = [3, 7];
      toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
      toss.holdings[7] = [holding("TSLA", q, 300, 377)];
      await at("2026-09-29T05:05:00"); // 미국 9/28
      toss.holdings[7] = [];
      toss.overview[7] = overview(null); // 전부 팔면 토스는 달러 요약 없이 준다
      toss.orders["7:TSLA"] = [order("t9", "TSLA", "SELL", q, Math.round(q * 377 * 100) / 100, "2026-09-29T23:10:00+09:00")];
      await at("2026-09-30T05:05:00");
      expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]); // 0.123444 는 예전에 30분 넘게 'unsure' 뒤 의심을 안고 저장
      expect((await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" }))[0]!).toMatchObject({ method: "close", reason: null, doubts: [] });
      expect((await svc.listTrades({ from: "2026-09-28", to: "2026-09-29" })).estimated).toEqual([]);
    }
    const { toss, at, rows, svc } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 33, 38), holding("AAPL", 16.123444, 200, 230)];
    await at("2026-09-29T05:05:00");
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.orders["3:AAPL"] = [order("a9", "AAPL", "SELL", 16.123444, 3708.39, "2026-09-29T23:10:00+09:00")];
    await at("2026-09-30T05:05:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]); // 예전에는 vanished 'AAPL 16.1234주'
    const [s] = await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" });
    expect(s).toMatchObject({ method: "close", reason: null, doubts: [] });
    expect(s!.holdings.map((h) => h.code)).toEqual(["SOXL"]);
  });

  it("체결 시각 없이 처음 보는 진행 중 주문의 첫 몫은, 주문 시각이 그 짝을 마지막으로 받은 때·직전 스냅샷보다 이르면 그 스냅샷 시각('seen')으로 — 1초씩 흐르는 시계에서 가짜 '추정' 없음", async () => {
    const { toss, at, svc } = await setup({ stepMs: 1000 });
    toss.holdings[3] = [holding("SOXL", 7, 33, 38)];
    await at("2026-09-29T05:05:00"); // 미국 9/28 — 9/28 22:30 에 낸 p2 는 아직 체결 0 이라 토스가 주지 않는다
    // 미국 9/29 에 첫 2주 체결 (진행 중, 체결 시각 없음 — 주문 시각 9/28 22:30 만)
    const p2 = (q: number) => order("p2", "SOXL", "BUY", q, q * 37, null, "OPEN");
    toss.holdings[3] = [holding("SOXL", 9, 33, 38)];
    toss.orders["3:SOXL"] = [p2(2)];
    await at("2026-09-30T05:05:00");
    // 미국 9/30: 그대로 진행 중(주문 시각이 또 와도 첫 몫을 주문 시각으로 되돌리지 않음), 10/1: 1주 더
    await at("2026-10-01T05:05:00");
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.orders["3:SOXL"] = [p2(3)];
    await at("2026-10-02T05:05:00");
    const snaps = await svc.listSnapshots({ from: "2026-09-28", to: "2026-10-01", market: "US" });
    expect(snaps.map((s) => `${s.date} ${s.status}`)).toEqual(["2026-09-28 ok", "2026-09-29 ok", "2026-09-30 ok", "2026-10-01 ok"]);
    const r = await svc.listTrades({ from: "2026-09-28", to: "2026-10-01" });
    const got = r.items.find((t) => t.orderId === "p2")!;
    expect(got).toMatchObject({ executedDate: "2026-09-29", timeBasis: "seen" }); // 예전에는 9/28 (ordered)
    expect(got.fills.map((f) => [f.quantity, f.date, f.basis])).toEqual([
      [2, "2026-09-29", "seen"],
      [1, "2026-10-01", "seen"],
    ]);
    expect(Date.parse(got.fills[0]!.at)).toBeLessThanOrEqual(Date.parse(snaps[1]!.asOf));
    expect(Date.parse(got.fills[0]!.at)).toBeGreaterThan(Date.parse(snaps[0]!.asOf));
    expect(r.estimated).toEqual([]); // 예전에는 SOXL 9/28→9/29 +2 (첫 몫이 주문 시각 9/28 22:30 으로 앞 구간에 들어감)
    // 주문 시각이 그 짝을 마지막으로 받은 때보다 뒤면(그 사이 낸 주문) 예전처럼 주문 시각
    toss.holdings[3] = [holding("SOXL", 11, 33, 38)];
    toss.orders["3:SOXL"] = [p2(3), { ...order("p5", "SOXL", "BUY", 1, 37, null, "OPEN"), orderedAt: "2026-10-02T22:40:00+09:00" }];
    await at("2026-10-03T05:05:00");
    expect((await svc.listTrades({ from: "2026-10-02", to: "2026-10-02" })).items.find((t) => t.orderId === "p5")).toMatchObject({ executedAt: "2026-10-02T22:40:00+09:00", timeBasis: "ordered" });
  });

  it("처음 묻는 짝도 직전 스냅샷보다 이른 주문 시각은 쓰지 않고(그때 체결됐다면 그 스냅샷 보유에 들었다), 그 짝을 마지막으로 받은 때보다 이른 주문 시각도 쓰지 않는다", async () => {
    const { toss, at, svc, clock } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    await at("2026-09-29T05:05:00"); // 미국 9/28 — 9/28 22:30 에 낸 NVDA 주문은 아직 체결 0
    // 미국 9/29 에 NVDA 첫 체결 — 이 계좌에 NVDA 는 처음이라 그 짝을 물은 적이 없다
    toss.holdings[3] = [holding("SOXL", 10, 33, 38), holding("NVDA", 1, 180, 182)];
    toss.orders["3:NVDA"] = [order("n1", "NVDA", "BUY", 1, 180, null, "OPEN")]; // 주문 시각 9/28 22:30
    await at("2026-09-30T05:05:00");
    // 관리 API 로 SOXL 을 06:00 에 받음 — 05:30 에 낸 s1 은 아직 체결 0 이라 오지 않고, 그 뒤 체결
    clock.t = kst("2026-09-30T06:00:00");
    await svc.syncTrades("US", ["SOXL"]);
    toss.holdings[3] = [holding("SOXL", 11, 33, 38), holding("NVDA", 1, 180, 182)];
    toss.orders["3:SOXL"] = [{ ...order("s1", "SOXL", "BUY", 1, 38, null, "OPEN"), orderedAt: "2026-09-30T05:30:00+09:00" }];
    await at("2026-10-01T05:05:00");
    const r = await svc.listTrades({ from: "2026-09-28", to: "2026-09-30" });
    expect(Object.fromEntries(r.items.map((t) => [t.orderId, [t.timeBasis, t.executedDate]]))).toEqual({
      n1: ["seen", "2026-09-29"], // 주문 시각(9/28)으로 적으면 NVDA 9/28→9/29 +1 '추정'
      s1: ["seen", "2026-09-30"], // 주문 시각(미국 9/29 애프터마켓)은 06:00 에 물었을 때 체결이 없었으니 쓰지 않는다
    });
    expect(r.estimated).toEqual([]);
  });

  it("의심 때문에 다시 찍을 때는 그 시장 진행 중 주문의 짝만 다시 물어, 첫 시도 뒤 늘어난 몫을 그 스냅샷 시각으로 — 다음 날로 밀린 가짜 '추정' ± 없음", async () => {
    const { toss, at, rows, svc } = await setup({ stepMs: 1000 });
    toss.holdings[3] = [holding("SOXL", 7, 33, 38)];
    await at("2026-09-29T05:05:00"); // 미국 9/28
    // 미국 9/29 22:30 에 낸 p3 가 1주 체결된 채 진행 중 — 첫 시도는 목록 일부만 온 응답(합계 ≠ 요약)이라 보류
    const p3 = (q: number) => ({ ...order("p3", "SOXL", "BUY", q, q * 37, null, "OPEN"), orderedAt: "2026-09-29T22:30:00+09:00" });
    toss.holdings[3] = [holding("SOXL", 8, 33, 38)];
    toss.overview[3] = overview(999);
    toss.orders["3:SOXL"] = [p3(1)];
    await at("2026-09-30T05:05:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]);
    // 5분 사이 애프터마켓에서 2주 더 체결(여전히 체결 시각 없음), 이번 응답은 제대로
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    delete toss.overview[3];
    toss.orders["3:SOXL"] = [p3(3)];
    toss.asked = [];
    await at("2026-09-30T05:10:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
    expect(toss.asked).toEqual(["3:SOXL"]); // 진행 중 주문의 짝만 (예전에는 묻지 않아 +2 가 다음 날 스냅샷 시각으로 밀렸다)
    await at("2026-10-01T05:05:00");
    const [s29] = await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" });
    const r = await svc.listTrades({ from: "2026-09-28", to: "2026-09-30" });
    const fills = r.items.find((t) => t.orderId === "p3")!.fills;
    expect(fills.map((f) => [f.quantity, f.basis])).toEqual([
      [1, "ordered"],
      [2, "seen"],
    ]);
    expect(Date.parse(fills[1]!.at)).toBeLessThanOrEqual(Date.parse(s29!.asOf));
    expect(r.estimated).toEqual([]); // 예전에는 9/28→9/29 +2, 9/29→9/30 −2
    // 다시 물은 것은 종목별 받은 날·오류를 건드리지 않는다
    expect((await svc.status()).trades).toMatchObject({ lastError: null, failing: {} });
  });

  it("직전 스냅샷에 그 시장 종목이 없던 계좌가 그 뒤 사고 나서 목록에서 빠지면 찍지 않고 다시 — 저장한 매수·토스 동기화·실시간 체결 알림 어느 것으로 알아도", async () => {
    type S = Awaited<ReturnType<typeof setup>>;
    const learn: Record<string, (s: S) => Promise<unknown>> = {
      // 계좌 7 이 목록에 있을 때 관리 API 로 받은 매수
      buy: (s) => s.svc.syncTrades("US", ["TSLA"]),
      // 토스 동기화가 본 보유 (계좌 7 이 빠지자 동기화도 믿지 않고 전 보유를 그대로 둠)
      sync: (s) =>
        s.db
          .insertInto("meta")
          .values({ key: "toss_holdings_accounts", value: JSON.stringify({ held: { "3": ["SOXL"], "7": ["005930", "TSLA"] }, doubt: { "7": { since: "2026-09-30T05:00:00+09:00", count: 1 } } }) })
          .execute(),
      // 계좌가 온 실시간 체결 알림
      alert: (s) => s.svc.noteOrderEvent({ event: "FILL", accountSeq: 7, order: { symbol: "TSLA" } }),
    };
    for (const [how, fn] of Object.entries(learn)) {
      const s = await setup();
      s.toss.accountList = [3, 7];
      s.toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
      s.toss.holdings[7] = [holding("005930", 10, 70000, 71200)];
      await s.at("2026-09-29T05:05:00"); // 미국 9/28 — 계좌 7 은 한국 종목만
      s.toss.holdings[7] = [holding("005930", 10, 70000, 71200), holding("TSLA", 1, 300, 377)];
      s.toss.orders["7:TSLA"] = [order("t1", "TSLA", "BUY", 1, 300, "2026-09-29T23:10:00+09:00")];
      s.clock.t = kst("2026-09-29T23:30:00");
      await fn(s);
      s.toss.accountList = [3]; // 미국 9/29 스냅샷 때 계좌 7 이 잠깐 빠짐
      await s.at("2026-09-30T05:05:00");
      expect(await s.rows("US"), how).toEqual(["US 2026-09-28 ok close"]); // 예전에는 계좌 7 없이 'ok close' → 다음 날 가짜 TSLA 추정
      expect((await s.svc.status()).markets.US.lastError, how).toContain("계좌 7: 직전 스냅샷 뒤 미국 종목을 산 것으로 보이는 계좌가 토스 계좌 목록에서 빠짐");
      s.toss.accountList = [3, 7];
      await s.at("2026-09-30T05:10:00");
      expect(await s.rows("US"), how).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
      const [snap] = await s.svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" });
      expect(snap!.holdings.map((h) => `${h.account}:${h.code}`), how).toEqual(["3:SOXL", "7:TSLA"]);
      expect(snap, how).toMatchObject({ reason: null, doubts: [] });
      await s.at("2026-10-01T05:05:00");
      expect((await s.svc.listTrades({ from: "2026-09-28", to: "2026-09-30" })).estimated, how).toEqual([]);
    }
  });

  it("계좌 하나를 전부 판 날 새로 산 종목(NVDA 1 — 매수 저장됨)이 있는데 목록만 통째로 비어 오면 'ok' 로 남기지 않고 다시 — 오래된 동기화 기록만으로는 전부 판 빈 계좌를 의심하지 않는다", async () => {
    const { toss, at, rows, svc, clock, db } = await setup();
    toss.accountList = [3, 7];
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.holdings[7] = [holding("TSLA", 2, 300, 377)];
    await at("2026-09-29T05:05:00"); // 미국 9/28
    toss.orders["7:TSLA"] = [order("t9", "TSLA", "SELL", 2, 760, "2026-09-29T23:10:00+09:00")];
    toss.orders["7:NVDA"] = [order("n1", "NVDA", "BUY", 1, 180, "2026-09-29T23:20:00+09:00")];
    clock.t = kst("2026-09-29T23:20:03");
    await svc.noteOrderEvent({ event: "FILL", accountSeq: 7, order: { symbol: "NVDA" } });
    toss.holdings[7] = []; // 일시 오류: 정말은 NVDA 1주
    toss.overview[7] = overview(null);
    await at("2026-09-30T05:05:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close"]); // 예전에는 TSLA 매도만 맞춰 보고 NVDA 가 빠진 'ok close' (의심 없음)
    expect((await svc.status()).markets.US.lastError).toContain("계좌 7: 보유 목록이 비었고");
    toss.holdings[7] = [holding("NVDA", 1, 180, 182)];
    delete toss.overview[7];
    await at("2026-09-30T05:10:00");
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
    const [s29] = await svc.listSnapshots({ from: "2026-09-29", to: "2026-09-29", market: "US" });
    expect(s29!.holdings.map((h) => `${h.account}:${h.code}`)).toEqual(["3:SOXL", "7:NVDA"]);
    expect(s29).toMatchObject({ reason: null, doubts: [] });
    // 미국 9/30: 계좌 7 이 NVDA 도 전부 팔아 빈 계좌. 토스 동기화 기록은 오래돼 아직 TSLA·NVDA 가 있다고 해도, 목록에 있는 계좌는 저장한 체결로 가린다
    await db.insertInto("meta").values({ key: "toss_holdings_accounts", value: JSON.stringify({ held: { "3": ["SOXL"], "7": ["TSLA", "NVDA"] }, doubt: {} }) }).execute();
    toss.holdings[7] = [];
    toss.overview[7] = overview(null);
    toss.orders["7:NVDA"] = [order("n1", "NVDA", "BUY", 1, 180, "2026-09-29T23:20:00+09:00"), order("n2", "NVDA", "SELL", 1, 185, "2026-09-30T23:00:00+09:00")];
    await at("2026-10-01T05:05:00");
    expect((await rows("US")).at(-1)).toBe("US 2026-09-30 ok close");
    // 10/1: 계좌 7 은 여전히 빈 계좌 — 직전 스냅샷에 종목이 없고 새로 산 것도 없으니 동기화 기록이 오래돼도 곧바로
    await at("2026-10-02T05:05:00");
    expect((await rows("US")).at(-1)).toBe("US 2026-10-01 ok close");
    expect((await svc.listSnapshots({ from: "2026-10-01", to: "2026-10-01", market: "US" }))[0]!).toMatchObject({ method: "close", reason: null, doubts: [] });
    expect((await svc.listTrades({ from: "2026-09-28", to: "2026-10-01" })).estimated).toEqual([]);
  });
});

describe("매매 기록 — 체결 저장 (토스 주문 내역)", () => {
  it("그 시장 종목의 주문 내역을 받아 주문번호로 한 줄씩 — 다시 받아도 늘지 않고, 부분 체결은 늘어난 만큼 고친다", async () => {
    const { toss, at, svc, db, rows } = await setup();
    toss.holdings[3] = [holding("SOXL", 25, 33, 38.02), holding("TSLA", 1, 300, 377.5)];
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
    // 보유에서 빠진 TSLA 는 그 사이 저장한 매도(ord-10)로 설명돼 곧바로 저장 (체결을 스냅샷 확인보다 먼저 받는다)
    expect(await rows("US")).toEqual(["US 2026-09-28 ok close", "US 2026-09-29 ok close"]);
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

  it("체결 시각이 없는 주문은 처음 받은 시각을 그대로 — 받을 때마다 그날로 밀리지 않고, 체결 시각이 오면 그걸로 고친다", async () => {
    const { toss, at, db } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    const bare = { ...order("s1", "SOXL", "BUY", 2, 76, null), orderedAt: null };
    const filled = order("f1", "SOXL", "BUY", 1, 38, "2026-09-28T22:40:00+09:00");
    toss.orders["3:SOXL"] = [bare, filled];
    await at("2026-09-29T05:05:00");
    const read = () => db.selectFrom("trade_executions").select(["order_id", "executed_at", "executed_date", "time_basis"]).orderBy("order_id").execute();
    const first = await read();
    expect(first).toEqual([
      { order_id: "f1", executed_at: "2026-09-28T22:40:00+09:00", executed_date: "2026-09-28", time_basis: "filled" },
      { order_id: "s1", executed_at: "2026-09-29T05:05:00+09:00", executed_date: "2026-09-28", time_basis: "seen" },
    ]);
    // 다음 날들: s1 은 여전히 시각이 없고, f1 은 체결 시각이 빠진 채(주문 시각만) 와도 처음 값 그대로 (예전에는 9/28 → 9/29 → 9/30 으로 밀림)
    toss.orders["3:SOXL"] = [bare, { ...filled, filledAt: null, orderedAt: "2026-09-28T22:39:00+09:00" }];
    await at("2026-09-30T05:05:00");
    await at("2026-10-01T05:05:00");
    expect(await read()).toEqual(first);
    toss.orders["3:SOXL"] = [{ ...bare, filledAt: "2026-09-28T23:10:00+09:00" }, filled];
    await at("2026-10-02T05:05:00");
    expect((await read()).find((r) => r.order_id === "s1")).toEqual({ order_id: "s1", executed_at: "2026-09-28T23:10:00+09:00", executed_date: "2026-09-28", time_basis: "filled" });
  });

  it("주문 내역을 못 받은 종목은 그 종목만 5분마다 다시 묻고, 못 받는 동안은 경고 — 받은 종목은 받은 날(coverage)을 적는다", async () => {
    const { toss, at, svc } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200), holding("035420", 9, 232555, 201500)];
    toss.ordersFail["3:035420"] = "HTTP 429 rate-limit-exceeded";
    await at("2026-09-28T16:05:00");
    let st = await svc.status();
    expect(st.trades.failing).toEqual({ KR: ["035420"] });
    expect(st.warning).toBe("체결 받기 실패: 한국 1종목(035420)");
    expect(st.trades.lastError).toContain("035420");
    expect(st.trades.coverage).toEqual({ "005930": { first: "2026-09-28", last: "2026-09-28" } });
    toss.asked = [];
    await at("2026-09-28T16:07:00");
    expect(toss.asked).toEqual([]); // 5분 안에는 다시 묻지 않는다
    await at("2026-09-28T16:10:00");
    expect(toss.asked).toEqual(["3:035420"]); // 실패한 종목만
    delete toss.ordersFail["3:035420"];
    await at("2026-09-28T16:15:00");
    st = await svc.status();
    expect(st.trades.failing).toEqual({});
    expect(st.warning).toBeNull();
    expect(st.trades.lastError).toBeNull();
    expect(st.trades.coverage).toEqual({ "005930": { first: "2026-09-28", last: "2026-09-28" }, "035420": { first: "2026-09-28", last: "2026-09-28" } });
  });

  it("다시 묻기를 다 써도 못 받으면 그날은 멈추고 경고를 남기고(로그 포함), 다음 거래일 전체 받기에서 풀리면 경고도 풀린다", async () => {
    const { toss, at, svc, warns } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200), holding("035420", 9, 232555, 201500)];
    toss.ordersFail["3:035420"] = "HTTP 403 forbidden";
    for (let m = 5; m <= 55; m += 5) await at(`2026-09-28T16:${String(m).padStart(2, "0")}:00`);
    expect(toss.asked.filter((a) => a === "3:035420")).toHaveLength(TRADE_RETRIES);
    expect((await svc.status()).warning).toContain("체결 받기 실패: 한국 1종목(035420)");
    expect(warns.some((w) => w.includes("체결 받기 실패: 한국 1종목"))).toBe(true);
    delete toss.ordersFail["3:035420"];
    await at("2026-09-29T16:05:00");
    const st = await svc.status();
    expect(st.trades.failing).toEqual({});
    expect(st.warning).toBeNull();
    expect(st.trades.coverage["035420"]).toEqual({ first: "2026-09-29", last: "2026-09-29" });
    expect(st.trades.coverage["005930"]).toEqual({ first: "2026-09-28", last: "2026-09-29" });
  });

  it("계좌 목록을 못 받는 전체 실패는 그 거래일 받기를 끝내지 않고 5분 뒤 처음부터, 오류를 남긴다", async () => {
    const { toss, at, svc } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    await at("2026-09-28T16:05:00"); // 스냅샷·체결 모두 받음
    toss.fail = "HTTP 500";
    await at("2026-09-29T16:05:00");
    expect((await svc.status()).trades.lastError).toContain("한국: HTTP 500");
    toss.fail = null;
    toss.asked = [];
    await at("2026-09-29T16:10:00");
    expect(toss.asked).toEqual(["3:005930"]);
    expect((await svc.status()).trades.lastError).toBeNull();
  });

  it("관리 API 체결 받기에 종목을 주면 그 시장 종목만 묻는다 (기록 전에 전부 팔아 자동 목록에 없는 종목 채우기)", async () => {
    const { toss, svc } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.orders["3:NVDA"] = [order("n0", "NVDA", "SELL", 3, 540, "2026-03-02T23:00:00+09:00")];
    const r = await svc.syncTrades("US", ["nvda", "005930"]);
    expect(toss.asked).toEqual(["3:NVDA"]);
    expect(r).toMatchObject({ codes: 1, inserted: 1, failedCodes: [] });
    expect((await svc.status()).trades).toMatchObject({ count: 1, earliest: "2026-03-02", coverage: { NVDA: { first: "2026-09-28", last: "2026-09-28" } } });
  });

  it("물은 종목과 다른 종목으로 온 주문은 저장하지 않는다 (토스가 종목 거르기를 무시해도 다른 코드로 적히지 않음) — 한국 'A005930' 모양은 같은 종목", async () => {
    const { toss, svc, db } = await setup();
    toss.orders["3:SOXL"] = [order("x1", "TSLA", "SELL", 1, 377, "2026-09-28T23:00:00+09:00"), order("s1", "SOXL", "BUY", 1, 38, "2026-09-28T23:10:00+09:00")];
    toss.orders["3:TSLA"] = [order("x1", "TSLA", "SELL", 1, 377, "2026-09-28T23:00:00+09:00")];
    toss.orders["3:005930"] = [order("k1", "A005930", "BUY", 1, 71000, "2026-09-28T10:00:00+09:00")];
    const r = await svc.syncTrades("US", ["SOXL"]);
    expect(r).toMatchObject({ inserted: 1, skipped: 1, failedCodes: [] });
    expect(await db.selectFrom("trade_executions").select(["order_id", "code"]).execute()).toEqual([{ order_id: "s1", code: "SOXL" }]);
    // 그 종목을 물으면 그 종목으로 저장되고, 뒤에 다른 종목을 물어도 코드가 바뀌지 않는다
    await svc.syncTrades("US", ["TSLA"]);
    await svc.syncTrades("US", ["SOXL"]);
    await svc.syncTrades("KR", ["005930"]);
    expect(await db.selectFrom("trade_executions").select(["order_id", "code"]).orderBy("order_id").execute()).toEqual([
      { order_id: "k1", code: "005930" },
      { order_id: "s1", code: "SOXL" },
      { order_id: "x1", code: "TSLA" },
    ]);
  });

  it("며칠에 걸친 부분 체결은 받을 때마다 늘어난 몫을 그 시각과 함께 남긴다(fills) — 앞선 몫의 날짜·금액을 잃지 않고 가짜 '추정' 도 없다", async () => {
    const { toss, at, svc } = await setup();
    toss.holdings[3] = [holding("SOXL", 7, 33, 38)];
    await at("2026-09-26T05:05:00"); // 미국 9/25 (금)
    toss.holdings[3] = [holding("SOXL", 10, 34, 38)];
    toss.orders["3:SOXL"] = [order("p1", "SOXL", "BUY", 3, 111, "2026-09-28T23:00:00+09:00", "OPEN")];
    await at("2026-09-29T05:05:00"); // 미국 9/28: 5주 주문 중 3주 체결
    toss.holdings[3] = [holding("SOXL", 12, 34.5, 38)];
    toss.orders["3:SOXL"] = [order("p1", "SOXL", "BUY", 5, 187, "2026-09-29T23:30:00+09:00")];
    await at("2026-09-30T05:05:00"); // 미국 9/29: 나머지 2주 체결
    const r = await svc.listTrades({ from: "2026-09-25", to: "2026-09-30" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ orderId: "p1", quantity: 5, amount: 187, executedAt: "2026-09-29T23:30:00+09:00", status: "CLOSED" });
    expect(r.items[0]!.fills).toEqual([
      { quantity: 3, amount: 111, at: "2026-09-28T23:00:00+09:00", date: "2026-09-28", basis: "filled", seenAt: "2026-09-29T05:05:00+09:00" },
      { quantity: 2, amount: 76, at: "2026-09-29T23:30:00+09:00", date: "2026-09-29", basis: "filled", seenAt: "2026-09-30T05:05:00+09:00" },
    ]);
    expect(r.estimated).toEqual([]); // 예전에는 9/28 +3, 9/29 −3 두 줄
    // 기간으로 물으면 기간과 겹치는 몫이 있는 주문을 준다 — 마지막 체결일(9/29)만 보면 9/28 하루로 물을 때 3주 몫이 빠졌다
    const day = async (d: string) => (await svc.listTrades({ from: d, to: d })).items.map((t) => [t.orderId, t.fills.filter((f) => f.date === d).map((f) => f.quantity)]);
    expect(await day("2026-09-28")).toEqual([["p1", [3]]]);
    expect(await day("2026-09-29")).toEqual([["p1", [2]]]);
    expect(await day("2026-09-25")).toEqual([]);
    expect((await svc.listTrades({ from: "2026-09-28", to: "2026-09-28", code: "TSLA" })).items).toEqual([]);
  });

  it("관리 체결 받기가 도는 동안 예약 확인이 끼어들어도 서로의 상태를 덮어쓰지 않는다 (한 줄로 돌림)", async () => {
    const { toss, svc, clock, db } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    let started = false;
    const orig = toss.orderHistory.bind(toss);
    toss.orderHistory = async (seq: number, symbol: string) => {
      if (symbol === "NVDA") {
        started = true;
        await blocked;
      }
      return orig(seq, symbol);
    };
    clock.t = kst("2026-09-28T16:05:00");
    const admin = svc.syncTrades("US", ["NVDA"]);
    await vi.waitFor(() => expect(started).toBe(true));
    const tick = svc.tick(); // 예전에는 관리 쪽이 시작할 때 읽은 상태로 마지막에 저장해 since·tradesFor·coverage(005930)가 사라졌다
    release();
    await Promise.all([admin, tick]);
    const state = JSON.parse((await db.selectFrom("meta").select("value").where("key", "=", "trade_records_state").executeTakeFirstOrThrow()).value);
    expect(state.since).toEqual({ KR: "2026-09-28" });
    expect(state.tradesFor).toEqual({ KR: "2026-09-28" });
    expect(Object.keys(state.coverage).sort()).toEqual(["005930", "NVDA"]);
  });

  it("주문 한 건을 저장하다 난 오류(해석할 수 없는 체결 시각)는 그 종목 실패로 — 다른 주문·뒤 종목은 받고, 경고에 올린다", async () => {
    const { toss, at, svc, db } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 33, 38), holding("TSLA", 1, 300, 377)];
    toss.orders["3:SOXL"] = [order("bad", "SOXL", "BUY", 1, 38, "어제 밤"), order("ok1", "SOXL", "BUY", 1, 38, "2026-09-28T23:00:00+09:00")];
    toss.orders["3:TSLA"] = [order("t1", "TSLA", "BUY", 1, 377, "2026-09-28T23:05:00+09:00")];
    await at("2026-09-29T05:05:00");
    expect((await db.selectFrom("trade_executions").select("order_id").orderBy("order_id").execute()).map((r) => r.order_id)).toEqual(["ok1", "t1"]);
    const st = await svc.status();
    expect(st.trades.failing).toEqual({ US: ["SOXL"] });
    expect(st.warning).toContain("체결 받기 실패: 미국 1종목(SOXL)");
    expect(st.trades.lastError).toContain("주문 bad 저장 실패");
    expect(st.trades.coverage).toEqual({ TSLA: { first: "2026-09-29", last: "2026-09-29" } });
  });

  it("전체 실패(계좌 목록을 못 받음)가 이어지면 경고에 올리고, 받으면 풀린다", async () => {
    const { toss, at, svc } = await setup();
    toss.holdings[3] = [holding("005930", 10, 70000, 71200)];
    await at("2026-09-28T16:05:00");
    toss.fail = "HTTP 500";
    await at("2026-09-29T16:05:00");
    await at("2026-09-29T16:10:00");
    expect((await svc.status()).warning ?? "").not.toContain("전체 실패"); // 한두 번은 일시 오류로 본다
    await at("2026-09-29T16:15:00");
    expect((await svc.status()).warning).toBe("체결 받기 전체 실패: 한국 9/29 16:05부터 3번");
    toss.fail = null;
    await at("2026-09-29T16:20:00");
    expect((await svc.status()).warning).toBeNull();
  });

  it("주문 내역이 쪽 수 한도를 넘어 오래된 주문을 다 받지 못한 종목은 표시하고 경고한다 — 끝까지 받으면 풀린다", async () => {
    const { toss, at, svc } = await setup();
    toss.holdings[3] = [holding("SOXL", 10, 33, 38)];
    toss.orders["3:SOXL"] = [order("s1", "SOXL", "BUY", 10, 330, "2026-09-28T23:00:00+09:00")];
    toss.truncated.add("3:SOXL");
    await at("2026-09-29T05:05:00");
    let st = await svc.status();
    expect(st.trades.truncated).toEqual(["SOXL"]);
    expect(st.warning).toBe("주문 내역이 너무 많아 오래된 체결을 다 받지 못함: 1종목(SOXL)");
    expect(st.trades.count).toBe(1); // 받은 만큼은 저장
    toss.truncated.clear();
    await at("2026-09-30T05:05:00");
    st = await svc.status();
    expect(st.trades.truncated).toEqual([]);
    expect(st.warning).toBeNull();
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
    const { orders: list, truncated } = await provider.orderHistory(3, "SOXL");
    expect(truncated).toBe(false);
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

  it("종료된 주문이 쪽 수 한도를 넘어 다음 쪽이 남으면 truncated (조용히 끊지 않음)", async () => {
    const asked: string[] = [];
    const provider = new TossOpenApiProvider(
      new TossOpenApiClient({
        clientId: "c",
        clientSecret: "s",
        maxRetryWaitMs: 0,
        now: () => kst("2026-09-28T16:05:00"),
        fetchFn: (async (input: string | URL | Request) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 86400 }), { status: 200 });
          asked.push(url.searchParams.get("status") ?? "");
          if (url.searchParams.get("status") === "OPEN") return new Response(JSON.stringify({ result: { orders: [] } }), { status: 200 });
          return new Response(FIX("orders-closed-p1.json"), { status: 200, headers: { "content-type": "application/json" } }); // 늘 다음 쪽이 있다고 옴
        }) as typeof fetch,
      }),
    );
    const cut = await provider.orderHistory(3, "SOXL", 2);
    expect(cut.truncated).toBe(true);
    expect(asked).toEqual(["CLOSED", "CLOSED", "OPEN"]);
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
    const svc = new TradeRecordService({ db, toss: provider, features: new FeatureService(db, now), displayFx: FX, now, pauseMs: 0 });
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
    const writer = new TradeRecordService({ db, toss, features, displayFx: FX, now: () => clock.t, pauseMs: 0 });
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
      expect((await app.inject({ method: "POST", url: "/api/admin/trade-records/sync-trades", payload: { market: "US", codes: ["NVDA"] } })).statusCode).toBe(503);
      // 체결 받기 종목은 그 시장 종목만, 코드 모양 검사
      expect((await app.inject({ method: "POST", url: "/api/admin/trade-records/sync-trades", payload: { market: "US", codes: ["005930"] } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/admin/trade-records/sync-trades", payload: { market: "US", codes: ["../x"] } })).statusCode).toBe(400);
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
      // 관리 API 상태도 꺼져 있으면 데이터를 주지 않는다 (시작일·빠진 날·체결 건수 없음)
      expect((await app.inject({ method: "GET", url: "/api/admin/trade-records" })).json()).toEqual({ enabled: false });
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
    expect(versions.rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    const idx = await sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name in ('account_snapshots', 'trade_executions') order by name`.execute(db);
    expect(idx.rows.map((r) => r.name)).toEqual(expect.arrayContaining(["uq_account_snapshots_date_market", "uq_trade_executions_account_order"]));
    await db.destroy();
  });
});
