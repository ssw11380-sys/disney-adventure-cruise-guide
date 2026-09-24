import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { DiscoverRank, DiscoverStock } from "@/api/types";

/**
 * 발견 순위 쪽 잇기. 뒤 쪽은 첫 쪽과 같은 목록 판(ver)에서 받아야 한다 — 판이 다른 쪽을 붙이면
 * 그 사이 순위가 바뀐 종목이 빠지고 순위 번호가 어긋난다.
 *  - 새 서버: 그 판을 잃었으면(재시작·최근 5판 밖) 빈 쪽 + restart 를 준다
 *  - 옛 서버: 알리지 않고 지금 목록의 쪽을 준다 → 받은 판이 요청한 판과 다르다
 * 어느 쪽이든 그 쪽의 줄은 버리고 restart 로 표시한다. 목록은 첫 쪽부터 다시 받는다 (restartRankPages)
 */

/** 순위 쪽 요청: 몇 쪽인지와 첫 쪽이 준 목록 판 (판을 주지 않는 옛 서버면 없음) */
export type RankPageParam = { page: number; ver?: number };

/**
 * 다음 쪽 요청. 서버 상한(20쪽)과 빈 쪽에서 멈춘다 (빈 "더 보기"가 끝없이 이어지지 않게).
 * 다음 쪽은 앞 쪽과 같은 목록 판(ver)에서 받는다 — 그 사이 서버 목록이 바뀌어도 줄이 빠지거나 겹치지 않게
 */
export function nextRankPage(last: DiscoverRank): RankPageParam | undefined {
  return last.hasMore && last.items.length > 0 && last.page < 20 ? { page: last.page + 1, ver: last.ver } : undefined;
}

/** 받은 뒤 쪽이 요청한 판에서 이어진 것인지 확인한다. 아니면 줄을 비우고 restart (그 쪽에서 더 받지 않는다) */
export function checkRankPage(param: RankPageParam, res: DiscoverRank): DiscoverRank {
  if (param.page <= 1 || param.ver === undefined) return res;
  const moved = res.restart === true || (res.ver !== undefined && res.ver !== param.ver);
  return moved ? { ...res, items: [], hasMore: false, restart: true } : res;
}

/** 받은 쪽을 이어 붙인다: 첫 쪽과 같은 판인 쪽까지만, 같은 종목은 한 번만 (쪽 경계에서 순위가 바뀐 종목이 두 번 나오지 않게) */
export function joinRankPages(pages: readonly DiscoverRank[] | undefined): DiscoverStock[] {
  const ver = pages?.[0]?.ver;
  const seen = new Set<string>();
  const out: DiscoverStock[] = [];
  for (const p of pages ?? []) {
    if (p.restart || (ver !== undefined && p.ver !== undefined && p.ver !== ver)) break;
    for (const it of p.items) {
      if (seen.has(it.code)) continue;
      seen.add(it.code);
      out.push(it);
    }
  }
  return out;
}

/**
 * 판이 다른 쪽(restart)을 받았으면 첫 쪽부터 다시 받는다. 새 첫 쪽이 올 때까지는 가진 첫 쪽만 두고 더 받지 않는다
 * (옛 판으로 다음 쪽을 다시 물어 같은 일이 되풀이되지 않게). 받은 시각은 그대로 둔다
 */
export function restartRankPages(qc: QueryClient, key: QueryKey): Promise<void> {
  const d = qc.getQueryData<InfiniteData<DiscoverRank, RankPageParam>>(key);
  const first = d?.pages[0];
  if (!d || !first || !d.pages.some((p) => p.restart)) return Promise.resolve();
  const updatedAt = qc.getQueryState(key)?.dataUpdatedAt;
  qc.setQueryData<InfiniteData<DiscoverRank, RankPageParam>>(key, { pages: [{ ...first, hasMore: false }], pageParams: d.pageParams.slice(0, 1) }, { updatedAt });
  return qc.refetchQueries({ queryKey: key, exact: true });
}
