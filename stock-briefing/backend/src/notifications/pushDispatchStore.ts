import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import type { PushSendResult } from "./push.js";

const PREFIX = "push-dispatch:";
export const DISPATCH_UNCERTAIN_AFTER_MS = 5 * 60_000;
export type DispatchReceipt = { receiptId: string; token: string; receivedAt: number; dispatchKey?: string };
type DispatchState = "sending" | "uncertain" | "acknowledged" | "queued" | "failed";
type RecordValue = { state: DispatchState; startedAt: number; updatedAt: number; owner: string; receipt?: DispatchReceipt };
export type DispatchClaim = { key: string; token: string; value: string; record: RecordValue };
export type DeliveryStatus = { sending: number; uncertain: number; accepted: number; failed: number; lastUncertainAt: string | null };

/** 발송 전에 기록한다. 응답을 잃은 발송은 성공으로 바꾸거나 자동 재발송하지 않는다. */
export class PushDispatchStore {
  constructor(private readonly db: Db) {}

  async begin(eventId: string, tokens: string[], now: number): Promise<DispatchClaim[]> {
    const owner = randomUUID();
    const claims = [...new Set(tokens)].map((token): DispatchClaim => {
      const key = PREFIX + createHash("sha256").update(JSON.stringify([eventId, token])).digest("hex");
      const record: RecordValue = { state: "sending", owner, startedAt: now, updatedAt: now };
      return { key, token, record, value: JSON.stringify(record) };
    });
    const acquired = new Set<string>();
    const acquire = async (db: Db) => {
      for (let i = 0; i < claims.length; i += 200) {
        const rows = await db.insertInto("meta").values(claims.slice(i, i + 200).map(({ key, value }) => ({ key, value })))
          .onConflict((oc) => oc.column("key").doNothing()).returning("key").execute();
        for (const row of rows) acquired.add(row.key);
      }
    };
    // 한 배치는 단일 INSERT 자체가 원자적이다. 여러 배치일 때만 앞 배치가 남지 않게 묶는다.
    if (claims.length > 200) await this.db.transaction().execute(acquire);
    else await acquire(this.db);
    return claims.filter((claim) => acquired.has(claim.key));
  }

  /** ACK를 먼저 남겨 영수증 목록 저장 실패·종료 뒤에도 받은 ID를 복원한다. */
  async checkpoint(claims: DispatchClaim[], results: PushSendResult["results"], now: number): Promise<void> {
    const byToken = new Map(results.map((result) => [result.token, result]));
    await this.db.transaction().execute(async (trx) => {
      for (const claim of claims) {
        const result = byToken.get(claim.token);
        const uncertain = !result || (!result.ok && (!result.error || result.error.startsWith("SendFailed:")));
        const record: RecordValue = {
          ...claim.record, updatedAt: now,
          state: uncertain ? "uncertain" : result.ok ? "acknowledged" : "failed",
          ...(result?.ok && result.receiptId ? { receipt: { receiptId: result.receiptId, token: result.token, receivedAt: now, dispatchKey: claim.key } } : {}),
        };
        // 정상 ACK에 영수증이 없는 제공자는 전달 확인과 영수증 조회를 구분한다.
        if (record.state === "acknowledged" && !record.receipt) record.state = "queued";
        const value = JSON.stringify(record);
        await trx.updateTable("meta").set({ value }).where("key", "=", claim.key).where("value", "=", claim.value).execute();
      }
    });
  }

  async recover(now: number): Promise<DispatchReceipt[]> {
    const rows = await this.db.selectFrom("meta").selectAll().where("key", "like", `${PREFIX}%`).execute();
    const receipts: DispatchReceipt[] = [];
    for (const row of rows) {
      const record = parse(row.value);
      if (!record) continue; // 모르는/손상된 기록을 삭제해 중복 발송의 잠금을 풀지 않는다.
      if (record.state === "acknowledged" && record.receipt) receipts.push({ ...record.receipt, dispatchKey: row.key });
      // 다른 서버가 아직 응답을 기다릴 수 있으므로 sending 값은 바꾸지 않는다.
      // 기한을 넘긴 상태는 status에서 uncertain으로 읽어 늦은 ACK의 CAS를 방해하지 않는다.
    }
    return receipts;
  }

  /** 같은 트랜잭션에서 ACK→queued를 먼저 획득한 작업만 영수증을 넣는다. 늦은 복원은 완료된 ID를 되살리지 않는다. */
  async prepareQueue(db: Db, receipt: DispatchReceipt): Promise<boolean> {
    if (!receipt.dispatchKey?.startsWith(PREFIX)) return true;
    const row = await db.selectFrom("meta").selectAll().where("key", "=", receipt.dispatchKey).executeTakeFirst();
    if (!row) throw new Error("푸시 발송 기록을 찾을 수 없습니다");
    const record = parse(row.value);
    if (!record) throw new Error("푸시 발송 기록을 읽을 수 없습니다");
    if (record.state === "queued" || record.state === "failed") return false;
    if (record.state === "acknowledged" && record.receipt?.receiptId !== receipt.receiptId) return false;
    const { receipt: _receipt, ...compact } = record;
    const result = await db.updateTable("meta").set({ value: JSON.stringify({ ...compact, state: "queued", updatedAt: receipt.receivedAt }) })
      .where("key", "=", row.key).where("value", "=", row.value).executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async status(now: number): Promise<DeliveryStatus> {
    const rows = await this.db.selectFrom("meta").select("value").where("key", "like", `${PREFIX}%`).execute();
    const status: DeliveryStatus = { sending: 0, uncertain: 0, accepted: 0, failed: 0, lastUncertainAt: null };
    let last: number | null = null;
    for (const row of rows) {
      const record = parse(row.value);
      if (!record) { status.uncertain++; continue; }
      if (record.state === "uncertain" || (record.state === "sending" && now - record.startedAt >= DISPATCH_UNCERTAIN_AFTER_MS)) {
        status.uncertain++; last = Math.max(last ?? 0, record.startedAt);
      } else if (record.state === "sending") status.sending++;
      else if (record.state === "failed") status.failed++;
      else status.accepted++;
    }
    status.lastUncertainAt = last === null ? null : new Date(last).toISOString();
    return status;
  }
}

function parse(value: string): RecordValue | null {
  try {
    const record = JSON.parse(value) as RecordValue;
    if (!record || !["sending", "uncertain", "acknowledged", "queued", "failed"].includes(record.state)
      || typeof record.owner !== "string" || !Number.isFinite(record.startedAt) || !Number.isFinite(record.updatedAt)) return null;
    if (record.receipt && (typeof record.receipt.receiptId !== "string" || typeof record.receipt.token !== "string" || !Number.isFinite(record.receipt.receivedAt))) return null;
    return record;
  } catch { return null; }
}
