import { describe, expect, it, vi } from "vitest";
import { createMigratedDb } from "../src/db/index.js";
import { TossOpenApiProvider, type TossHolding } from "../src/providers/market/tossOpenApi.js";
import { KrwCostBook, type KrwCostBookState, type KrwCostEntry } from "../src/services/krwCostBook.js";
import { TossAccountSnapshotStore, TOSS_ACCOUNT_SNAPSHOT_KEY } from "../src/services/tossAccountSnapshot.js";
import { EXCLUDED_KEY, TossSyncService } from "../src/services/tossSyncService.js";

const AT = "2026-10-04T10:00:00+09:00";
const holding = (code = "APH", currency: "KRW" | "USD" = "USD", quantity = 2, purchaseAmount = 10): TossHolding =>
  ({ code, currency, quantity, purchaseAmount, name: code, avgPrice: purchaseAmount / quantity, lastPrice: 9, marketValue: 18, marketValueAfterCost: 17.99 });
const entry = (account = 1, code = "APH", changes: Partial<KrwCostEntry> = {}): KrwCostEntry =>
  ({ account, code, quantity: 2, usdCost: 10, krwExact: 14_000, krwEst: 0, applied: {}, updatedAt: AT, ...changes });
const book = (items: KrwCostEntry[] = [entry()]): KrwCostBookState =>
  ({ version: 2, items: Object.fromEntries(items.map((e) => [`${e.account}:${e.code}`, e])), pending: {}, missing: {}, factor: 1, factorHash: null, calib: null });

async function fixture(rows = new Map([[1, [holding()]]]), state: KrwCostBookState = book()) {
  const db = await createMigratedDb(":memory:");
  const provider = new TossOpenApiProvider({} as never);
  const accounts = vi.spyOn(provider, "accounts").mockImplementation(async () => [...rows.keys()].map((accountSeq) => ({ accountSeq })) as never);
  const holdings = vi.spyOn(provider, "holdingsWithOverview").mockImplementation(async (account) => {
    const items = rows.get(account)!;
    const krw = items.filter((h) => h.currency === "KRW").reduce((sum, h) => sum + h.purchaseAmount!, 0);
    const usd = items.filter((h) => h.currency === "USD").reduce((sum, h) => sum + h.purchaseAmount!, 0);
    return { items, overview: { purchaseKrw: krw, purchaseUsd: usd, afterCostKrw: krw, afterCostUsd: usd, rateAfterCost: null },
      accountEvaluation: { gross: { krw, usd }, net: { krw, usd } }, costBasisComplete: true };
  });
  vi.spyOn(provider, "stockInfos").mockResolvedValue(new Map());
  const fx = vi.fn(async () => 1_400);
  const sync = new TossSyncService(db, provider, () => new Date(AT), fx, undefined, async () => true);
  const update = vi.spyOn(sync.costBook, "update").mockResolvedValue(state);
  const load = vi.spyOn(sync.costBook, "load");
  return { db, sync, rows, state, accounts, holdings, fx, update, load, snapshot: async () => (await sync.accountSnapshots.load()).snapshot! };
}

describe("토스 계좌 평가와 같은 보유의 원화 원금", () => {
  it("원본 평가와 묶은 원금으로 손익을 계산하며 실시간 시세와의 차이를 섞지 않는다", async () => {
    const f = await fixture(new Map([[1, [holding("APH", "USD", 2, 700)]]]), book([entry(1, "APH", { usdCost: 700, krwExact: 1_000_000 })]));
    try {
      f.holdings.mockResolvedValue({ items: f.rows.get(1)!, overview: { purchaseKrw: 0, purchaseUsd: 700, afterCostKrw: 0, afterCostUsd: 990_000 / 1_400, rateAfterCost: null },
        accountEvaluation: { gross: { krw: 0, usd: 990_000 / 1_400 }, net: { krw: 0, usd: 990_000 / 1_400 } }, costBasisComplete: true });
      await f.sync.importHoldings();
      const snapshot = await f.snapshot();
      expect(snapshot.costBasis).toEqual({ krw: 1_000_000, estimatedHoldingCount: 0, holdingCount: 1, source: "synced-holdings-cost-book" });
      expect(Math.round(snapshot.gross.usd * snapshot.displayFx!.usdKrw - snapshot.costBasis!.krw)).toBe(-10_000);
      expect(992_100 - snapshot.costBasis!.krw).toBe(-7_900);
      expect(f.accounts).toHaveBeenCalledTimes(1);
      expect(f.holdings).toHaveBeenCalledTimes(1);
      expect(f.fx).toHaveBeenCalledTimes(1);
      expect(f.update).toHaveBeenCalledTimes(1);
      expect(f.load).not.toHaveBeenCalled();
    } finally { await f.db.destroy(); }
  });

  it("다계좌 동일 종목과 동기화 제외 보유는 포함하고 추가 장부·직접 등록 종목은 제외한다", async () => {
    const f = await fixture(new Map([[1, [holding(), holding("005930", "KRW", 1, 50_000)]], [2, [holding("APH", "USD", 3, 20)]]]),
      book([entry(), entry(2, "APH", { quantity: 3, usdCost: 20, krwExact: 0, krwEst: 28_000 }), entry(3, "APH", { krwExact: 1_000_000 }), entry(1, "MSFT", { krwExact: 1_000_000 })]));
    try {
      f.state.factor = 1.01;
      await f.db.insertInto("meta").values({ key: EXCLUDED_KEY, value: JSON.stringify(["APH"]) }).execute();
      await f.db.insertInto("registered_stocks").values({ code: "AAPL", name: "다른 증권사", market: "US", quantity: 100, avg_price: 100, memo: null, created_at: AT, updated_at: AT }).execute();
      await f.sync.importHoldings();
      expect(await f.snapshot()).toMatchObject({ holdingCount: 2, excludedHoldingCount: 1,
        costBasis: { krw: 92_280, estimatedHoldingCount: 1, holdingCount: 2, source: "synced-holdings-cost-book" } });
      expect(f.update).toHaveBeenCalledTimes(1);
      expect(f.holdings).toHaveBeenCalledTimes(2);
    } finally { await f.db.destroy(); }
  });

  it.each(["수량", "달러 원금", "계좌", "종목", "대기", "장부 누락", "음수 원금", "보정 비율", "국내 원금 누락", "장부 저장 실패"])("%s이면 평가금액은 보존하고 원금·손익은 확정하지 않는다", async (kind) => {
    const f = await fixture();
    try {
      if (kind === "수량") f.state.items["1:APH"]!.quantity = 1;
      if (kind === "달러 원금") f.state.items["1:APH"]!.usdCost = 10.01;
      if (kind === "계좌") f.state.items["1:APH"]!.account = 2;
      if (kind === "종목") f.state.items["1:APH"]!.code = "MSFT";
      if (kind === "대기") f.state.pending["1:APH"] = AT;
      if (kind === "장부 누락") delete f.state.items["1:APH"];
      if (kind === "음수 원금") f.state.items["1:APH"]!.krwExact = -1;
      if (kind === "보정 비율") f.state.factor = Infinity;
      if (kind === "국내 원금 누락") f.rows.set(1, [{ ...holding("005930", "KRW"), purchaseAmount: null }]);
      if (kind === "장부 저장 실패") f.update.mockRejectedValue(new Error("test storage failure"));
      await f.sync.importHoldings();
      expect(await f.snapshot()).toMatchObject({ gross: expect.any(Object), costBasis: null });
      expect((await f.sync.accountSnapshots.load()).lastError).toBeNull();
    } finally { await f.db.destroy(); }
  });

  it("정상 빈 계좌는 오래된 장부를 합치지 않고 원금 0원을 보존한다", async () => {
    const f = await fixture(new Map([[1, []]]));
    try {
      await f.sync.importHoldings();
      expect(await f.snapshot()).toMatchObject({ holdingCount: 0, costBasis: { krw: 0, estimatedHoldingCount: 0, holdingCount: 0 } });
    } finally { await f.db.destroy(); }
  });

  it("같은 동기화 반환 장부만 사용하며 뒤이어 저장소가 바뀌어도 스냅샷 원금은 변하지 않는다", async () => {
    const f = await fixture();
    try {
      await f.sync.importHoldings();
      await f.db.insertInto("meta").values({ key: KrwCostBook.KEY, value: JSON.stringify(book([entry(1, "APH", { krwExact: 99_000 })])) }).execute();
      expect((await new TossAccountSnapshotStore(f.db).load()).snapshot?.costBasis?.krw).toBe(14_000);
      expect(f.load).not.toHaveBeenCalled();
    } finally { await f.db.destroy(); }
  });

  it.each([null, { krw: -1 }, { krw: "14000" }, { krw: null }, { holdingCount: 2 }, { estimatedHoldingCount: 2 }, { estimatedHoldingCount: -1 }, { source: "other" }])("손상 원금 %j는 null로 낮추고 계좌 평가 자체는 유지한다", async (change) => {
    const f = await fixture();
    try {
      await f.sync.importHoldings();
      const before = await f.snapshot();
      const costBasis = change === null ? null : { krw: 14_000, holdingCount: 1, estimatedHoldingCount: 0, source: "synced-holdings-cost-book", ...change };
      await f.db.updateTable("meta").set({ value: JSON.stringify({ ...before, costBasis }) }).where("key", "=", TOSS_ACCOUNT_SNAPSHOT_KEY).execute();
      expect((await f.snapshot()).costBasis).toBeNull();
      expect((await f.snapshot()).gross).toEqual(before.gross);
      expect((await f.sync.accountSnapshots.load()).lastError).toBeNull();
    } finally { await f.db.destroy(); }
  });

  it("구 스냅샷의 원금 필드 부재는 0원 원금으로 대신하지 않는다", async () => {
    const f = await fixture();
    try {
      await f.sync.importHoldings();
      const saved = await f.snapshot();
      delete saved.costBasis;
      await f.db.updateTable("meta").set({ value: JSON.stringify(saved) }).where("key", "=", TOSS_ACCOUNT_SNAPSHOT_KEY).execute();
      const loaded = await f.snapshot();
      expect(loaded.costBasis ?? null).toBeNull();
      expect(loaded.gross).toEqual(saved.gross);
    } finally { await f.db.destroy(); }
  });

  it.each([false, undefined])("보유 응답 완전성이 %j이면 기존 평가만 보여주고 원금은 발표하지 않는다", async (complete) => {
    const f = await fixture();
    try {
      const read = f.holdings.getMockImplementation()!;
      f.holdings.mockImplementation(async (account) => ({ ...await read(account), costBasisComplete: complete }) as never);
      await f.sync.importHoldings();
      expect(await f.snapshot()).toMatchObject({ gross: { krw: 0, usd: 10 }, costBasis: null });
    } finally { await f.db.destroy(); }
  });

  it("원본 계좌에 해석할 수 없는 종목이 섞이면 평가를 남기고 부분 원금을 완전한 손익으로 표시하지 않는다", async () => {
    const db = await createMigratedDb(":memory:");
    const rawItem = (symbol: string, purchaseAmount: string) => ({ symbol, name: symbol, currency: "KRW", quantity: "1", averagePurchasePrice: purchaseAmount,
      marketValue: { amount: "15", amountAfterCost: "14", purchaseAmount } });
    const client = { get: vi.fn(async (path: string) => {
      if (path === "/api/v1/accounts") return [{ accountSeq: 1 }];
      if (path === "/api/v1/holdings") return { items: [rawItem("005930", "10"), rawItem("unsupported/code", "0")],
        totalPurchaseAmount: { krw: "10", usd: "0" }, marketValue: { amount: { krw: "30", usd: "0" }, amountAfterCost: { krw: "28", usd: "0" } } };
      throw new Error("추가 외부 호출 금지");
    }) };
    const provider = new TossOpenApiProvider(client as never);
    vi.spyOn(provider, "stockInfos").mockResolvedValue(new Map());
    const sync = new TossSyncService(db, provider, () => new Date(AT), null, undefined, async () => true);
    vi.spyOn(sync.costBook, "update").mockResolvedValue(book([]));
    try {
      await sync.importHoldings();
      expect((await sync.accountSnapshots.load()).snapshot).toMatchObject({ gross: { krw: 30, usd: 0 }, holdingCount: 1, costBasis: null });
      expect(client.get).toHaveBeenCalledTimes(2);
    } finally { await db.destroy(); }
  });
});
