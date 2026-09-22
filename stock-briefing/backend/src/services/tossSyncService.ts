import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";
import type { TossHolding, TossOpenApiProvider } from "../providers/market/tossOpenApi.js";
import { toMarket } from "../providers/market/kisMaster.js";

/**
 * 토스증권 계좌의 보유 종목을 registered_stocks 로 가져온다.
 *  - 보유 중인 종목: 없으면 등록, 있으면 수량·평단(·이름)을 토스 값으로 맞춘다. 메모는 유지.
 *  - 토스에 없는 등록 종목은 건드리지 않는다(관심 종목이거나 다른 증권사 보유일 수 있으므로).
 */
export interface ImportResult {
  accounts: number;
  added: string[];
  updated: string[];
  unchanged: string[];
  holdings: Array<TossHolding & { market: string }>;
}

export class TossSyncService {
  constructor(
    private readonly db: Db,
    private readonly toss: TossOpenApiProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async importHoldings(): Promise<ImportResult> {
    const accounts = await this.toss.accounts();
    const merged = new Map<string, TossHolding>();
    for (const a of accounts) {
      for (const h of await this.toss.holdings(a.accountSeq)) {
        const prev = merged.get(h.code);
        if (!prev) merged.set(h.code, h);
        else {
          // 여러 계좌에 같은 종목이 있으면 수량 합산, 평단은 수량 가중 평균
          const q = prev.quantity + h.quantity;
          const avg = prev.avgPrice !== null && h.avgPrice !== null ? (prev.avgPrice * prev.quantity + h.avgPrice * h.quantity) / q : prev.avgPrice ?? h.avgPrice;
          merged.set(h.code, { ...prev, quantity: q, avgPrice: avg === null ? null : Math.round(avg * 100) / 100 });
        }
      }
    }
    const holdings = [...merged.values()];
    const infos = holdings.length ? await this.toss.stockInfos(holdings.map((h) => h.code)).catch(() => new Map()) : new Map();
    const result: ImportResult = { accounts: accounts.length, added: [], updated: [], unchanged: [], holdings: [] };
    const ts = seoulIso(this.now());
    for (const h of holdings) {
      const info = infos.get(h.code) as { name?: string; market?: string } | undefined;
      const name = info?.name || h.name || h.code;
      const market = toMarket(info?.market ?? (h.currency === "USD" ? "US" : "UNKNOWN"));
      result.holdings.push({ ...h, name, market });
      const existing = await this.db.selectFrom("registered_stocks").selectAll().where("code", "=", h.code).executeTakeFirst();
      if (!existing) {
        await this.db
          .insertInto("registered_stocks")
          .values({ code: h.code, name, market, quantity: h.quantity, avg_price: h.avgPrice, memo: null, created_at: ts, updated_at: ts })
          .execute();
        result.added.push(h.code);
      } else if (existing.quantity !== h.quantity || existing.avg_price !== h.avgPrice || existing.name !== name) {
        await this.db
          .updateTable("registered_stocks")
          .set({ quantity: h.quantity, avg_price: h.avgPrice, name, market, updated_at: ts })
          .where("code", "=", h.code)
          .execute();
        result.updated.push(h.code);
      } else {
        result.unchanged.push(h.code);
      }
    }
    return result;
  }
}
