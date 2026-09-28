import type { FeatureService } from "./featureService.js";
import type { ReconcileService } from "./reconcileService.js";
import type { StockService } from "./stockService.js";
import type { ImportResult } from "./tossSyncService.js";

/**
 * 동기화 뒤 토스 대조 (3-13). 플래그(tossReconcile)가 꺼져 있으면 시세 조회·기록·경고 모두 하지 않는다 (3-15).
 * after: 기록이 끝난 뒤 한 번 (3-32 — 실시간 연결로 앱의 '숫자 기준' 배지를 바로 바꾸게). 플래그 numberBasis 가 켜져 있을 때만 부른다.
 * 기록하지 않았거나 기록이 실패(던짐)하면 부르지 않는다
 */
export function reconcileAfterSync(deps: { features: FeatureService; reconcile: ReconcileService; stocks: Pick<StockService, "listWithFreshQuotes">; after?: () => void }) {
  return async (r: ImportResult): Promise<void> => {
    const excluded = new Set(r.excluded);
    const items = r.holdings.filter((h) => !excluded.has(h.code));
    if (!items.length || !(await deps.features.enabled("tossReconcile"))) return;
    await deps.reconcile.record(await deps.stocks.listWithFreshQuotes(), items);
    if (deps.after && (await deps.features.enabled("numberBasis").catch(() => false))) deps.after();
  };
}
