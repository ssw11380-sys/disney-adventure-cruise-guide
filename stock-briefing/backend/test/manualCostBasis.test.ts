import { describe, expect, it } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Quote } from "../src/domain/types.js";
import { TossOpenApiProvider, type TossHolding } from "../src/providers/market/tossOpenApi.js";
import { evaluate, StockService } from "../src/services/stockService.js";
import { TossSyncService } from "../src/services/tossSyncService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider } from "./helpers.js";
import { client, NOW } from "./tossFake.js";

/**
 * PF-05: 토스 잠금이 풀린 뒤(키 없음·동기화 0분·3시간 넘게 멈춤) 직접 고친 수량·평단이
 * 옛 토스 매입금액·원화 장부에 가려져 손익(부호까지)이 틀리던 문제.
 * 토스: 수량 10·매입금액 1,000 → 잠금 해제 → 평단만 200 으로 → 현재가 150 이면 매입금액 2,000·손익 -500(-25%) 이어야 한다.
 */
const AT = "2026-09-24T11:00:00+09:00";
type Mode = "no-api" | "sync-zero" | "stale-sync" | "live";
const UNLOCKED: Mode[] = ["no-api", "sync-zero", "stale-sync"];

/** 달러 시세 (환율 1,400) */
class UsdQuotes extends FakeQuoteProvider {
  override async getQuote(code: string): Promise<Quote> {
    return { ...(await super.getQuote(code)), currency: "USD", fxRate: 1400 };
  }
}

async function seed(mode: Mode, opts: { code?: string; usd?: boolean } = {}): Promise<{ db: Db; svc: StockService; code: string }> {
  const code = opts.code ?? (opts.usd ? "TSLA" : "005930");
  const db = await createMigratedDb(":memory:");
  await db
    .insertInto("registered_stocks")
    .values({ code, name: "fixture", market: opts.usd ? "NASDAQ" : "KOSPI", quantity: 10, avg_price: 100, memo: null, created_at: AT, updated_at: AT })
    .execute();
  const syncedAt = mode === "stale-sync" ? "2026-09-23T11:00:00+09:00" : AT;
  const currency = opts.usd ? "USD" : "KRW";
  await db
    .insertInto("meta")
    .values([
      { key: "toss_holdings_codes", value: JSON.stringify([code]) },
      { key: "toss_holdings_detail", value: JSON.stringify({ syncedAt, items: { [code]: { quantity: 10, purchaseAmount: 1000, costRate: 0.002, currency } } }) },
    ])
    .execute();
  if (opts.usd) {
    const book = {
      version: 2,
      items: { [`1:${code}`]: { account: 1, code, quantity: 10, usdCost: 1000, krwExact: 1_300_000, krwEst: 0, applied: {}, updatedAt: syncedAt } },
      pending: {},
      missing: {},
      calib: null,
      factor: 1,
      factorHash: null,
    };
    await db.insertInto("meta").values({ key: "krw_cost_book", value: JSON.stringify(book) }).execute();
  }
  const quotes = opts.usd ? new UsdQuotes("usd", { price: 150 }) : new FakeQuoteProvider("krw", { price: 150 });
  const svc = new StockService({
    db,
    quotes,
    search: new FakeSearchProvider(),
    master: new FakeMasterProvider(),
    now: () => new Date(AT),
    tossOpenApi: mode === "no-api" ? null : { baseFallbacks: 0 },
    tossSyncMinutes: mode === "sync-zero" ? 0 : 10,
  });
  return { db, svc, code };
}

async function evaluationOf(svc: StockService, code: string) {
  const row = (await svc.listWithQuotes()).find((s) => s.code === code)!;
  // 상세 화면(GET /api/stocks/:code)도 같은 재료로 계산한다
  const meta = await svc.holdingMeta();
  const detail = evaluate((await svc.get(code))!, row.quote, meta.detail.get(code), meta.krw.get(code));
  expect(detail).toStrictEqual(row.evaluation);
  return row;
}

describe("PF-05 잠금이 풀린 뒤 직접 고친 평단", () => {
  for (const mode of UNLOCKED) {
    it(`${mode}: 수량은 그대로 평단만 고치면 직접 저장한 매입금액으로 손익을 낸다`, async () => {
      const { db, svc, code } = await seed(mode);
      expect((await svc.tossSynced()).size).toBe(0);
      await expect(svc.update(code, { avgPrice: 200 })).resolves.toMatchObject({ quantity: 10, avgPrice: 200 });
      const row = await evaluationOf(svc, code);
      expect(row.avgPrice).toBe(200);
      expect(row.evaluation).toMatchObject({ marketValue: 1500, costBasis: 2000, profit: -500, profitRate: -25, costRate: null, afterCost: null });
      // 그 뒤 메모만 고쳐도 직접 넣은 값 그대로
      await svc.update(code, { memo: "메모" });
      expect((await evaluationOf(svc, code)).evaluation).toMatchObject({ costBasis: 2000, profit: -500 });
      await db.destroy();
    });

    it(`${mode}: 메모만 고치면(수량·평단을 같은 값으로 보내도) 토스 매입금액·비용 비율을 그대로 쓴다`, async () => {
      const { db, svc, code } = await seed(mode);
      await svc.update(code, { memo: "메모만" });
      await svc.update(code, { quantity: 10, avgPrice: 100, memo: "같은 값" });
      const row = await evaluationOf(svc, code);
      expect(row.memo).toBe("같은 값");
      expect(row.evaluation).toMatchObject({ costBasis: 1000, profit: 500, profitRate: 50, costRate: 0.002 });
      await db.destroy();
    });

    it(`${mode}: 해외 종목은 평단을 고치면 옛 원화 장부도 쓰지 않고, 메모만 고치면 원화 매입금액을 그대로 둔다`, async () => {
      const memoOnly = await seed(mode, { usd: true });
      await memoOnly.svc.update(memoOnly.code, { memo: "메모" });
      expect((await evaluationOf(memoOnly.svc, memoOnly.code)).evaluation).toMatchObject({ costBasis: 1000, costBasisKrw: 1_300_000, krwCostSource: "exact" });
      await memoOnly.db.destroy();

      const edited = await seed(mode, { usd: true });
      await edited.svc.update(edited.code, { avgPrice: 200 });
      expect((await evaluationOf(edited.svc, edited.code)).evaluation).toMatchObject({ costBasis: 2000, profit: -500, costBasisKrw: null, krwCostSource: null });
      // 재연동: 동기화가 토스 값·평가 기준을 다시 쓰면 남겨 둔 원화 장부(토스 값)를 다시 쓴다
      await edited.db.updateTable("registered_stocks").set({ avg_price: 100 }).where("code", "=", edited.code).execute();
      const detail = { syncedAt: AT, items: { [edited.code]: { quantity: 10, purchaseAmount: 1000, costRate: 0.002, currency: "USD" } } };
      await edited.db.updateTable("meta").set({ value: JSON.stringify(detail) }).where("key", "=", "toss_holdings_detail").execute();
      expect((await evaluationOf(edited.svc, edited.code)).evaluation).toMatchObject({ costBasis: 1000, costBasisKrw: 1_300_000, krwCostSource: "exact" });
      await edited.db.destroy();
    });

    it(`${mode}: 지웠다가 수량·평단을 넣어 다시 등록해도 옛 토스 매입금액을 쓰지 않는다`, async () => {
      const { db, svc, code } = await seed(mode);
      await svc.refreshMaster();
      // 동기화가 멈춰 잠금만 풀린 경우(stale-sync)는 마지막 토스 스냅샷에 있던 종목이라 동기화에서도 뺀다 (BH-46, 다시 등록하면 다시 맞춤)
      expect(await svc.remove(code)).toEqual({ tossExcluded: mode === "stale-sync" });
      await svc.register({ code, quantity: 10, avgPrice: 200 });
      expect((await evaluationOf(svc, code)).evaluation).toMatchObject({ costBasis: 2000, profit: -500 });
      await db.destroy();
    });
  }

  it("동기화가 살아 있으면(잠금) 지금처럼 수량·평단은 막히고 토스 매입금액·원화 장부로 평가한다", async () => {
    const { db, svc, code } = await seed("live", { usd: true });
    expect((await svc.tossSynced()).has(code)).toBe(true);
    await expect(svc.update(code, { avgPrice: 200 })).rejects.toMatchObject({ code: "TOSS_LOCKED" });
    await svc.update(code, { memo: "메모" });
    const row = await evaluationOf(svc, code);
    expect(row).toMatchObject({ avgPrice: 100, tossSynced: true });
    expect(row.evaluation).toMatchObject({ costBasis: 1000, profit: 500, costRate: 0.002, costBasisKrw: 1_300_000, krwCostSource: "exact" });
    await db.destroy();
  });

  it("잠긴 종목을 지웠다가(동기화 제외) 다시 등록하면 다시 잠기고 토스 기준을 그대로 둔다", async () => {
    const { db, svc, code } = await seed("live");
    await svc.refreshMaster();
    expect(await svc.remove(code)).toEqual({ tossExcluded: true });
    await svc.register({ code, quantity: 10, avgPrice: 100 });
    expect((await svc.tossSynced()).has(code)).toBe(true);
    expect((await evaluationOf(svc, code)).evaluation).toMatchObject({ costBasis: 1000, profit: 500, costRate: 0.002 });
    await db.destroy();
  });

  it("실제 동기화: 멈춘 사이 고친 평단으로 평가하고, 다시 동기화되면 토스 값·토스 매입금액으로 돌아온다", async () => {
    const db = await createMigratedDb(":memory:");
    let now = NOW().getTime();
    const clock = () => new Date(now);
    const p = new TossOpenApiProvider(client(), { now: NOW });
    const origin = p.holdingsWithOverview.bind(p);
    // 토스 매입금액은 평단×수량과 조금 다르다 (NAVER 9주 · 평단 232,555 → 매입금액 2,100,000 으로 둔다)
    p.holdingsWithOverview = async (seq: number) => {
      const r = await origin(seq);
      return { ...r, items: r.items.map((h) => (h.code === "035420" ? { ...h, purchaseAmount: 2_100_000 } : h)) };
    };
    const sync = new TossSyncService(db, p, clock);
    const svc = new StockService({ db, quotes: new FakeQuoteProvider("x", { price: 250_000 }), search: new FakeSearchProvider(), master: new FakeMasterProvider(), tossOpenApi: p, now: clock });
    const naver = async () => (await svc.listWithQuotes()).find((s) => s.code === "035420")!;

    await sync.importHoldings();
    expect(await naver()).toMatchObject({ tossSynced: true, quantity: 9, avgPrice: 232555, evaluation: { costBasis: 2_100_000, profit: 150_000 } });

    now += 4 * 3_600_000; // 동기화가 4시간 멈춤 → 잠금 해제
    await svc.update("035420", { avgPrice: 300_000 });
    expect(await naver()).toMatchObject({ tossSynced: false, avgPrice: 300_000, evaluation: { costBasis: 2_700_000, profit: -450_000 } });

    await sync.importHoldings(); // 재연동
    expect(await naver()).toMatchObject({ tossSynced: true, quantity: 9, avgPrice: 232555, evaluation: { costBasis: 2_100_000, profit: 150_000 } });
    await db.destroy();
  });
});

/**
 * PF-05 뒤 수정 화면의 "원화 매입금액" 저장: 직접 고친 해외 종목은 토스 기준이 지워져 원화 장부를 평가에 쓰지 않는다.
 * 그런데 저장하면 applied 로 돌려줘 앱이 "저장됨 — 원화 손익이 토스 앱과 같은 기준으로 계산됩니다"를 띄우던 문제.
 * 이제 값은 장부에 두되(다음 동기화 뒤 쓴다) skipped 에 reason "manual" 로 돌려준다.
 */
describe("원화 매입금액 저장 — 직접 고친 해외 종목", () => {
  /** 계좌 1개 · TSLA 10주 · 매입금액 $1,000 (매수 주문 하나로 설명됨) */
  const fakeToss = () =>
    ({
      async accounts() {
        return [{ accountNo: "1", accountSeq: 1, accountType: "BROKERAGE" }];
      },
      async holdingsWithOverview() {
        const items: TossHolding[] = [{ code: "TSLA", name: "테슬라", currency: "USD", quantity: 10, avgPrice: 100, lastPrice: 150, purchaseAmount: 1000 }];
        return { items, overview: { purchaseKrw: 0, purchaseUsd: 1000, afterCostKrw: 0, afterCostUsd: 0, rateAfterCost: null } };
      },
      async ordersForBook() {
        return [{ orderId: "o1", side: "BUY", quantity: 10, amount: 1000, at: "2026-09-01T23:00:00+09:00" }];
      },
      async usdKrwAt() {
        return 1400;
      },
      async stockInfos(codes: string[]) {
        return new Map(codes.map((c) => [c, { name: "테슬라", market: "NASDAQ" }]));
      },
    }) as unknown as TossOpenApiProvider;

  /** 토스 키는 있지만 자동 동기화 0분(수동 가져오기만) → 잠그지 않는다 */
  async function setup() {
    const db = await createMigratedDb(":memory:");
    const clock = () => new Date(AT);
    const sync = new TossSyncService(db, fakeToss(), clock);
    const svc = new StockService({
      db,
      quotes: new UsdQuotes("usd", { price: 150 }),
      search: new FakeSearchProvider(),
      master: new FakeMasterProvider(),
      now: clock,
      tossOpenApi: { baseFallbacks: 0 },
      tossSyncMinutes: 0,
    });
    await sync.importHoldings();
    return { db, sync, svc };
  }

  it("평단을 직접 고친 뒤 넣은 값은 applied 가 아니라 manual 로 돌려주고, 다음 동기화 뒤에 쓴다 (재현)", async () => {
    const { db, sync, svc } = await setup();
    // 대조: 토스 기준으로 평가 중이면 저장 즉시 원화 손익에 쓴다
    expect(await sync.setExactKrw({ TSLA: 1_300_000 })).toEqual({ applied: ["TSLA"], skipped: [] });
    expect((await evaluationOf(svc, "TSLA")).evaluation).toMatchObject({ costBasis: 1000, costBasisKrw: 1_300_000, krwCostSource: "exact" });

    await svc.update("TSLA", { avgPrice: 101 }); // 잠금 밖에서 평단 직접 고침 → 토스 기준 지움
    expect(await sync.setExactKrw({ TSLA: 1_310_000 })).toEqual({ applied: [], skipped: [{ code: "TSLA", reason: "manual" }] });
    // 지금 평가는 직접 넣은 평단 그대로 (원화는 현재 환율 환산)
    expect((await evaluationOf(svc, "TSLA")).evaluation).toMatchObject({ costBasis: 1010, costBasisKrw: null, krwCostSource: null });
    // 값은 장부에 남는다
    expect((await svc.krwCosts()).get("TSLA")).toMatchObject({ krw: 1_310_000, source: "exact" });

    // 다음 동기화가 토스 값·평가 기준을 다시 채우면 넣어 둔 값을 쓰고, 다시 저장하면 바로 applied
    await sync.importHoldings();
    expect(await evaluationOf(svc, "TSLA")).toMatchObject({ avgPrice: 100, evaluation: { costBasis: 1000, costBasisKrw: 1_310_000, krwCostSource: "exact" } });
    expect(await sync.setExactKrw({ TSLA: 1_320_000 })).toEqual({ applied: ["TSLA"], skipped: [] });
    await db.destroy();
  });

  it("수량을 직접 고친 종목, 토스 기준 수량과 등록 수량이 다른 종목도 manual. 등록하지 않은 종목은 전처럼 applied", async () => {
    const { db, sync, svc } = await setup();
    await svc.update("TSLA", { quantity: 12 });
    expect((await sync.setExactKrw({ TSLA: 1_300_000 })).skipped).toEqual([{ code: "TSLA", reason: "manual" }]);

    // 예전 서버에서 직접 고쳐 토스 기준이 남아 있지만 수량이 다른 종목 (평가가 토스 기준을 쓰지 않는다)
    await sync.importHoldings();
    await db.updateTable("registered_stocks").set({ quantity: 11 }).where("code", "=", "TSLA").execute();
    expect(await sync.setExactKrw({ TSLA: 1_300_000 })).toEqual({ applied: [], skipped: [{ code: "TSLA", reason: "manual" }] });
    expect((await evaluationOf(svc, "TSLA")).evaluation).toMatchObject({ costBasisKrw: null });

    await db.deleteFrom("registered_stocks").where("code", "=", "TSLA").execute();
    expect(await sync.setExactKrw({ TSLA: 1_300_000 })).toEqual({ applied: ["TSLA"], skipped: [] });
    await db.destroy();
  });
});
