import type { Db } from "../db/index.js";

export type TossCurrencyTotals = { krw: number; usd: number };
export interface TossAccountTotals { gross: TossCurrencyTotals; net: TossCurrencyTotals }
export interface TossAccountSnapshot extends TossAccountTotals {
  source: "toss-openapi";
  scope: "all-toss-stock-holdings";
  excludesCash: true;
  includesExcludedHoldings: true;
  /** 공급자 평가 시각이 아니라 계좌별 응답을 수신한 구간이다. */
  receivedFrom: string;
  receivedAt: string;
  accountCount: number;
  holdingCount: number;
  excludedHoldingCount: number;
  displayFx: { usdKrw: number; receivedAt: string; source: "app-display-fx"; kind: "reference" } | null;
}

export const TOSS_ACCOUNT_SNAPSHOT_KEY = "toss_account_snapshot";
export const TOSS_ACCOUNT_SNAPSHOT_ERROR_KEY = "toss_account_snapshot_error";
const SNAPSHOT_TIME_KEY = "toss_account_snapshot_received_at";
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const amount = (value: unknown): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
};
function currencies(value: unknown, noUsdHoldings: boolean): TossCurrencyTotals | null {
  const fields = object(value);
  const krw = amount(fields?.krw), usd = fields?.usd === null && noUsdHoldings ? 0 : amount(fields?.usd);
  return krw !== null && usd !== null ? { krw, usd } : null;
}

/** 계좌 요약의 원액만 읽는다. 누락·빈 문자열·음수는 0원으로 바꾸지 않는다. */
export function parseTossAccountTotals(value: unknown): TossAccountTotals | null {
  const root = object(value), marketValue = object(root?.marketValue);
  const items = root?.items;
  // 공식 계약상 해외 보유가 없으면 usd:null이다. 목록으로 없음이 확인된 명시적 null만 0달러로 해석한다.
  const validItems = Array.isArray(items) && items.every((v) => {
    const item = object(v);
    return item && typeof item.symbol === "string" && item.symbol.length > 0 && (item.currency === "KRW" || item.currency === "USD") && amount(item.quantity) !== null;
  });
  if (Array.isArray(items) && !validItems) return null;
  const noUsdHoldings = validItems && !items.some((v) => { const item = object(v)!; return item.currency === "USD" && amount(item.quantity)! > 0; });
  const gross = currencies(marketValue?.amount, noUsdHoldings), net = currencies(marketValue?.amountAfterCost, noUsdHoldings);
  return gross && net && net.krw <= gross.krw && net.usd <= gross.usd ? { gross, net } : null;
}

export function sumTossAccountTotals(values: Array<TossAccountTotals | null | undefined>): TossAccountTotals | null {
  if (!values.length || values.some((v) => !v)) return null;
  const result: TossAccountTotals = { gross: { krw: 0, usd: 0 }, net: { krw: 0, usd: 0 } };
  for (const kind of ["gross", "net"] as const) for (const currency of ["krw", "usd"] as const) {
    const amounts = values.map((v) => v![kind][currency]);
    if (amounts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    result[kind][currency] = decimalSum(amounts);
  }
  return Object.values(result).every((v) => Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) ? result : null;
}

/** 계좌 간 합산에서 0.1 + 0.2 같은 이진 부동소수 오차를 피하며 원액 소수 자릿수를 유지한다. */
function decimalSum(values: number[]): number {
  const parts = values.map((value) => {
    const [coefficient = "0", exponent = "0"] = value.toString().split("e");
    const fraction = coefficient.split(".")[1]?.length ?? 0;
    return { digits: BigInt(coefficient.replace(".", "")), scale: fraction - Number(exponent) };
  });
  const scale = Math.max(0, ...parts.map((v) => v.scale));
  const total = parts.reduce((sum, v) => sum + v.digits * 10n ** BigInt(scale - v.scale), 0n).toString().padStart(scale + 1, "0");
  return Number(scale ? `${total.slice(0, -scale)}.${total.slice(-scale)}` : total);
}

/** 이전 완전한 값은 갱신 실패로 지우지 않는다. 계좌 번호·종목 원문은 저장하거나 노출하지 않는다. */
export class TossAccountSnapshotStore {
  private volatileError: string | null = null;
  constructor(private readonly db: Db) {}
  async load(): Promise<{ snapshot: TossAccountSnapshot | null; lastError: string | null }> {
    const rows = await this.db.selectFrom("meta").select(["key", "value"]).where("key", "in", [TOSS_ACCOUNT_SNAPSHOT_KEY, TOSS_ACCOUNT_SNAPSHOT_ERROR_KEY]).execute();
    let snapshot: TossAccountSnapshot | null = null;
    const raw = rows.find((r) => r.key === TOSS_ACCOUNT_SNAPSHOT_KEY)?.value;
    if (raw) try {
      const value = JSON.parse(raw) as TossAccountSnapshot;
      const totals = parseTossAccountTotals({ marketValue: { amount: value.gross, amountAfterCost: value.net } });
      if (totals && value.source === "toss-openapi" && value.scope === "all-toss-stock-holdings" && value.excludesCash === true && value.includesExcludedHoldings === true
        && Number.isFinite(Date.parse(value.receivedFrom)) && Number.isFinite(Date.parse(value.receivedAt)) && Date.parse(value.receivedAt) >= Date.parse(value.receivedFrom)
        && Number.isInteger(value.accountCount) && value.accountCount > 0 && Number.isInteger(value.holdingCount) && value.holdingCount >= 0
        && Number.isInteger(value.excludedHoldingCount) && value.excludedHoldingCount >= 0 && value.excludedHoldingCount <= value.holdingCount
        && (value.displayFx === null || (value.displayFx.kind === "reference" && value.displayFx.source === "app-display-fx" && Number.isFinite(value.displayFx.usdKrw) && value.displayFx.usdKrw > 0 && Number.isFinite(Date.parse(value.displayFx.receivedAt))))) snapshot = { ...value, ...totals };
    } catch { /* 깨진 기록은 원본 평가로 발표하지 않는다. */ }
    return { snapshot, lastError: this.volatileError ?? rows.find((r) => r.key === TOSS_ACCOUNT_SNAPSHOT_ERROR_KEY)?.value ?? (raw && !snapshot ? "저장된 토스 계좌 평가를 확인할 수 없습니다." : null) };
  }
  async save(snapshot: TossAccountSnapshot): Promise<void> {
    const saved = await this.db.transaction().execute(async (tx) => {
      // 이 행의 원자적 조건 갱신이 계좌 평가 전체 쓰기의 순서를 보호한다(SQLite·Postgres 공통).
      const won = await tx.insertInto("meta").values({ key: SNAPSHOT_TIME_KEY, value: snapshot.receivedAt })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value: snapshot.receivedAt }).where("meta.value", "<=", snapshot.receivedAt)).returning("value").executeTakeFirst();
      if (!won) return false;
      const value = JSON.stringify(snapshot);
      await tx.insertInto("meta").values({ key: TOSS_ACCOUNT_SNAPSHOT_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
      await tx.deleteFrom("meta").where("key", "=", TOSS_ACCOUNT_SNAPSHOT_ERROR_KEY).execute();
      return true;
    });
    if (saved) this.volatileError = null;
  }
  async failed(message: string): Promise<void> {
    this.volatileError = message;
    try {
      await this.db.insertInto("meta").values({ key: TOSS_ACCOUNT_SNAPSHOT_ERROR_KEY, value: message }).onConflict((oc) => oc.column("key").doUpdateSet({ value: message })).execute();
    } catch { /* 저장소 장애 동안에도 이 프로세스는 이전 시각과 실패 상태를 유지한다. */ }
  }
}
