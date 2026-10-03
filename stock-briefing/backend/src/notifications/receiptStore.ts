import type { Db } from "../db/index.js";

export type PendingReceipt = { receiptId: string; token: string; receivedAt: number };
const PREFIX = "push-receipt:";
export const RECEIPT_MAX_AGE_MS = 24 * 3_600_000;

/** 영수증마다 별도 키를 사용해 다른 서버의 대기 목록을 덮어쓰지 않는다. */
export class ReceiptStore {
  constructor(private readonly db: Db) {}

  async save(receipts: PendingReceipt[]): Promise<void> {
    if (!receipts.length) return;
    const unique = [...new Map(receipts.map((r) => [r.receiptId, r])).values()];
    for (let i = 0; i < unique.length; i += 200) {
      await this.db.insertInto("meta").values(unique.slice(i, i + 200).map((r) => ({ key: PREFIX + r.receiptId, value: JSON.stringify(r) })))
        .onConflict((oc) => oc.column("key").doNothing()).execute();
    }
  }

  async load(now: number): Promise<PendingReceipt[]> {
    const rows = await this.db.selectFrom("meta").selectAll().where("key", "like", `${PREFIX}%`).execute();
    const pending: PendingReceipt[] = [];
    const expired: string[] = [];
    for (const row of rows) {
      try {
        const value: unknown = JSON.parse(row.value);
        if (typeof value !== "object" || value === null) throw new Error("영수증 형식 오류");
        const r = value as Partial<PendingReceipt>;
        if (typeof r.receiptId !== "string" || typeof r.token !== "string" || typeof r.receivedAt !== "number" || !Number.isFinite(r.receivedAt) || row.key !== PREFIX + r.receiptId) throw new Error("영수증 형식 오류");
        if (now - r.receivedAt >= RECEIPT_MAX_AGE_MS) expired.push(row.key);
        else pending.push(r as PendingReceipt);
      } catch { expired.push(row.key); }
    }
    await this.removeKeys(expired);
    return pending;
  }

  async remove(receipts: PendingReceipt[]): Promise<void> {
    await this.removeKeys(receipts.map((r) => PREFIX + r.receiptId));
  }

  private async removeKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 200) await this.db.deleteFrom("meta").where("key", "in", keys.slice(i, i + 200)).execute();
  }
}
