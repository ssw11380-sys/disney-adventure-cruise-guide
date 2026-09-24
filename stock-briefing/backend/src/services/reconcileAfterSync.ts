import type { FeatureService } from "./featureService.js";
import type { ReconcileService } from "./reconcileService.js";
import type { StockService } from "./stockService.js";
import type { ImportResult } from "./tossSyncService.js";

/** 동기화 뒤 토스 대조 (3-13). 플래그(tossReconcile)가 꺼져 있으면 시세 조회·기록·경고 모두 하지 않는다 (3-15) */
export function reconcileAfterSync(deps: { features: FeatureService; reconcile: ReconcileService; stocks: Pick<StockService, "listWithFreshQuotes"> }) {
  return async (r: ImportResult): Promise<void> => {
    const excluded = new Set(r.excluded);
    const items = r.holdings.filter((h) => !excluded.has(h.code));
    if (!items.length || !(await deps.features.enabled("tossReconcile"))) return;
    await deps.reconcile.record(await deps.stocks.listWithFreshQuotes(), items);
  };
}
