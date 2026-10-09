import type { Db } from "../db/index.js";
import { randomUUID } from "node:crypto";
import { PushDispatchStore, type DispatchReceipt } from "./pushDispatchStore.js";

export type PendingReceipt = DispatchReceipt;
const PREFIX = "push-receipt:";
export const RECEIPT_MAX_AGE_MS = 24 * 3_600_000;
export const RECEIPT_LEASE_MS = 5 * 60_000;
type StoredReceipt = PendingReceipt & { lease?: { owner: string; expiresAt: number }; completed?: boolean };
export type ReceiptClaim = { receipt: PendingReceipt; value: string; expiresAt: number };

/** 영수증마다 별도 키를 사용해 다른 서버의 대기 목록을 덮어쓰지 않는다. */
export class ReceiptStore {
  readonly dispatches: PushDispatchStore;
  constructor(private readonly db: Db) { this.dispatches = new PushDispatchStore(db); }

  async save(receipts: PendingReceipt[]): Promise<void> {
    if (!receipts.length) return;
    const unique = [...new Map(receipts.map((r) => [r.receiptId, r])).values()];
    for (let i = 0; i < unique.length; i += 200) {
      const batch = unique.slice(i, i + 200);
      await this.db.transaction().execute(async (trx) => {
        const accepted: PendingReceipt[] = [];
        for (const receipt of batch) if (await this.dispatches.prepareQueue(trx, receipt)) accepted.push(receipt);
        if (accepted.length) await trx.insertInto("meta").values(accepted.map((r) => ({ key: PREFIX + r.receiptId, value: JSON.stringify(r) })))
          .onConflict((oc) => oc.column("key").doNothing()).execute();
      });
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
        else pending.push({ receiptId: r.receiptId, token: r.token, receivedAt: r.receivedAt, ...(r.dispatchKey ? { dispatchKey: r.dispatchKey } : {}) });
      } catch { expired.push(row.key); }
    }
    await this.removeKeys(expired);
    return pending;
  }

  async remove(receipts: PendingReceipt[]): Promise<void> {
    await this.removeKeys(receipts.map((r) => PREFIX + r.receiptId));
  }

  /** 여러 서버가 같은 값을 읽어도 CAS에 성공한 작업만 외부 영수증을 조회한다. */
  async claim(receipts: PendingReceipt[], now: number): Promise<{ claims: ReceiptClaim[]; waiting: PendingReceipt[] }> {
    const claimed: ReceiptClaim[] = [];
    const waiting: PendingReceipt[] = [];
    const owner = randomUUID();
    for (let i = 0; i < receipts.length; i += 200) {
      const keys = receipts.slice(i, i + 200).map((r) => PREFIX + r.receiptId);
      const rows = await this.db.selectFrom("meta").selectAll().where("key", "in", keys).execute();
      for (const row of rows) {
        const r = JSON.parse(row.value) as StoredReceipt;
        if (r.completed) {
          await this.db.deleteFrom("meta").where("key", "=", row.key).where("value", "=", row.value).execute();
          continue;
        }
        if (now - r.receivedAt >= RECEIPT_MAX_AGE_MS) continue;
        if (r.lease && r.lease.expiresAt > now) { waiting.push(r); continue; }
        const expiresAt = now + RECEIPT_LEASE_MS;
        const value = JSON.stringify({ ...r, lease: { owner, expiresAt } });
        const result = await this.db.updateTable("meta").set({ value }).where("key", "=", row.key).where("value", "=", row.value).executeTakeFirst();
        if (Number(result.numUpdatedRows) > 0) claimed.push({ receipt: r, value, expiresAt });
        else waiting.push(r);
      }
    }
    return { claims: claimed, waiting };
  }

  /** 소유권을 DB에서 다시 확인하고 같은 트랜잭션에서만 기기 상태를 바꾼다. */
  async finish(claim: ReceiptClaim, now: number | (() => number), disableReason?: string): Promise<{ owned: boolean; removed: boolean }> {
    const currentTime = typeof now === "function" ? now : () => now;
    if (claim.expiresAt <= currentTime()) return { owned: false, removed: false };
    const key = PREFIX + claim.receipt.receiptId;
    const completed = JSON.stringify({ ...claim.receipt, completed: true });
    const owned = await this.db.transaction().execute(async (trx) => {
      if (claim.expiresAt <= currentTime()) return false;
      const result = await trx.updateTable("meta").set({ value: completed }).where("key", "=", key).where("value", "=", claim.value).executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) return false;
      if (claim.expiresAt <= currentTime()) throw new Error("푸시 영수증 처리권 만료");
      if (disableReason) await trx.updateTable("devices").set({ enabled: 0, disabled_reason: disableReason }).where("token", "=", claim.receipt.token).execute();
      return true;
    });
    if (!owned) return { owned: false, removed: false };
    // 정리 실패 때도 완료 표시를 남겨 다음 서버가 기기 비활성화를 반복하지 않는다.
    try {
      await this.db.deleteFrom("meta").where("key", "=", key).where("value", "=", completed).execute();
      return { owned: true, removed: true };
    } catch { return { owned: true, removed: false }; }
  }

  async release(claims: ReceiptClaim[]): Promise<void> {
    for (const claim of claims) {
      const { lease: _lease, completed: _completed, ...receipt } = claim.receipt as StoredReceipt;
      await this.db.updateTable("meta").set({ value: JSON.stringify(receipt) }).where("key", "=", PREFIX + receipt.receiptId).where("value", "=", claim.value).execute();
    }
  }

  private async removeKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 200) await this.db.deleteFrom("meta").where("key", "in", keys.slice(i, i + 200)).execute();
  }
}
