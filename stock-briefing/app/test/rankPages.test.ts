import { InfiniteQueryObserver, QueryClient, type InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { DiscoverRank, DiscoverStock } from "@/api/types";
import { checkRankPage, joinRankPages, nextRankPage, restartRankPages, type RankPageParam } from "@/lib/rankPages";

/**
 * 발견 순위 더 보기 (DISC-04): 첫 쪽의 판(ver)을 서버가 잃으면(재시작·최근 5판 밖) 다른 판의 쪽을 이어 붙이지 않고
 * 첫 쪽부터 다시 받는다. 새 서버는 빈 쪽 + restart, 옛 서버는 알리지 않고 지금 목록의 쪽(판이 다름)을 준다.
 */
const codes = Array.from({ length: 250 }, (_, i) => String(i).padStart(6, "0"));
/** 새 목록: 000050 이 1위로 올라왔다 (보고서 재현과 같은 조건) */
const moved = [codes[50]!, ...codes.slice(0, 50), ...codes.slice(51)];
const stock = (code: string): DiscoverStock => ({ code, name: code, market: "KOSPI", currency: "KRW", price: 100, change: 1, changeRate: 1, volume: 1, tradingValue: 1e9 });

function page(p: number, ver: number | undefined, order: string[], extra: Partial<DiscoverRank> = {}): DiscoverRank {
  return { market: "KR", category: "volume", items: order.slice((p - 1) * 50, p * 50).map(stock), page: p, hasMore: order.length > p * 50, marketOpen: true, asOf: null, source: "test", ...(ver === undefined ? {} : { ver }), ...extra };
}

/** 가짜 서버: 판마다 목록을 기억한다. restart() = 서버를 다시 켬(기억한 판을 모두 잃고 목록이 바뀜) */
function fakeServer(kind: "new" | "old") {
  const lists = new Map<number, string[]>([[1, codes]]);
  const s = { cur: 1, calls: [] as string[] };
  return {
    s,
    restart() {
      lists.clear();
      s.cur++;
      lists.set(s.cur, moved);
    },
    rank(p: number, ver?: number): DiscoverRank {
      s.calls.push(`${p}:${ver ?? "-"}`);
      if (p === 1 || ver === undefined) return page(p, s.cur, lists.get(s.cur)!);
      const kept = lists.get(ver);
      if (kept) return page(p, ver, kept);
      // 새 서버: 빈 쪽 + restart, 옛 서버: 알리지 않고 지금 목록의 쪽
      return kind === "new" ? page(p, s.cur, [], { restart: true }) : page(p, s.cur, lists.get(s.cur)!);
    },
  };
}

/** useDiscoverRank 와 같은 요청·다음 쪽 규칙으로 무한 목록을 만든다 */
function observe(server: ReturnType<typeof fakeServer>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = ["https://server.test", "discoverRank", "KR", "volume", 50];
  const obs = new InfiniteQueryObserver<DiscoverRank, Error, InfiniteData<DiscoverRank, RankPageParam>, typeof key, RankPageParam>(qc, {
    queryKey: key,
    queryFn: async ({ pageParam }) => checkRankPage(pageParam, server.rank(pageParam.page, pageParam.ver)),
    initialPageParam: { page: 1 },
    getNextPageParam: nextRankPage,
  });
  const stop = obs.subscribe(() => undefined);
  const shown = () => joinRankPages(qc.getQueryData<InfiniteData<DiscoverRank, RankPageParam>>(key)?.pages).map((i) => i.code);
  return { qc, key, obs, stop, shown };
}

describe("순위 쪽 잇기: 판이 다른 쪽을 붙이지 않는다", () => {
  it("보고서 재현: 첫 쪽을 둔 채 서버가 판을 잃으면 다음 쪽을 붙이지 않고, 첫 쪽부터 다시 받아 빠진 종목·순서가 맞다 (새·옛 서버)", async () => {
    for (const kind of ["new", "old"] as const) {
      const server = fakeServer(kind);
      const { qc, key, obs, stop, shown } = observe(server);
      await obs.refetch();
      expect(shown()).toEqual(codes.slice(0, 50));
      server.restart();
      await obs.fetchNextPage();
      // 예전 앱: 000000~000049 뒤에 새 목록 51~100번째를 붙여 000050 이 빠지고 순위 번호가 어긋났다
      expect(shown()).toEqual(codes.slice(0, 50));
      expect(obs.getCurrentResult().data!.pages.at(-1)).toMatchObject({ restart: true, items: [] });
      expect(obs.getCurrentResult().hasNextPage).toBe(false);
      // 첫 쪽부터 다시: 새 첫 쪽이 올 때까지 옛 판으로 다음 쪽을 묻지 않는다
      const p = restartRankPages(qc, key);
      const trimmed = qc.getQueryData<InfiniteData<DiscoverRank, RankPageParam>>(key)!;
      expect(trimmed.pages).toHaveLength(1);
      expect(trimmed.pages[0]!.hasMore).toBe(false);
      await p;
      const d = qc.getQueryData<InfiniteData<DiscoverRank, RankPageParam>>(key)!;
      expect(d.pages).toHaveLength(1);
      expect(d.pages[0]!.ver).toBe(2);
      expect(shown()).toEqual(moved.slice(0, 50));
      await obs.fetchNextPage();
      expect(shown()).toEqual(moved.slice(0, 100));
      expect(shown()).toContain("000050");
      expect(server.s.calls).toEqual(["1:-", "2:1", "1:-", "2:2"]);
      stop();
    }
  });

  it("판이 남아 있으면 그대로 이어 붙이고, 여러 쪽을 펼친 뒤 새로고침하면 모든 쪽을 새 판으로 다시 받는다", async () => {
    const server = fakeServer("new");
    const { qc, key, obs, stop, shown } = observe(server);
    await obs.refetch();
    await obs.fetchNextPage();
    await obs.fetchNextPage();
    expect(shown()).toEqual(codes.slice(0, 150));
    expect(await restartRankPages(qc, key)).toBeUndefined(); // 다시 받을 일이 없으면 그대로
    expect(qc.getQueryData<InfiniteData<DiscoverRank, RankPageParam>>(key)!.pages).toHaveLength(3);
    server.restart();
    await obs.refetch();
    expect(shown()).toEqual(moved.slice(0, 150));
    expect(qc.getQueryData<InfiniteData<DiscoverRank, RankPageParam>>(key)!.pages.every((p) => p.ver === 2 && !p.restart)).toBe(true);
    stop();
  });

  it("checkRankPage: 뒤 쪽의 판이 요청과 다르거나 restart 면 줄을 비운다 · 첫 쪽·판 없는 옛 서버는 그대로", () => {
    const p2 = page(2, 7, codes);
    expect(checkRankPage({ page: 2, ver: 7 }, p2)).toBe(p2);
    expect(checkRankPage({ page: 2, ver: 6 }, p2)).toMatchObject({ items: [], hasMore: false, restart: true, ver: 7 });
    expect(checkRankPage({ page: 2, ver: 7 }, page(2, 7, [], { restart: true }))).toMatchObject({ items: [], hasMore: false, restart: true });
    const first = page(1, 9, codes);
    expect(checkRankPage({ page: 1 }, first)).toBe(first);
    const bare = page(2, undefined, codes);
    expect(checkRankPage({ page: 2 }, bare)).toBe(bare);
    expect(checkRankPage({ page: 2, ver: 7 }, bare)).toBe(bare);
  });

  it("joinRankPages: 첫 쪽과 같은 판인 쪽까지만, 같은 종목은 한 번 · 판 없는 옛 서버는 모두 잇는다", () => {
    expect(joinRankPages(undefined)).toEqual([]);
    expect(joinRankPages([page(1, 1, codes), page(2, 1, codes)]).map((i) => i.code)).toEqual(codes.slice(0, 100));
    // 쪽 경계에서 같은 종목(000049)이 다시 오면 한 번만
    const dup = joinRankPages([page(1, 1, codes), page(2, 1, [...codes.slice(0, 50), codes[49]!, ...codes.slice(50)])]).map((i) => i.code);
    expect(dup).toEqual(codes.slice(0, 99));
    expect(joinRankPages([page(1, 1, codes), page(2, 2, moved), page(3, 2, moved)]).map((i) => i.code)).toEqual(codes.slice(0, 50));
    expect(joinRankPages([page(1, 1, codes), page(2, 1, [], { restart: true })])).toHaveLength(50);
    expect(joinRankPages([page(1, undefined, codes), page(2, undefined, codes)]).map((i) => i.code)).toEqual(codes.slice(0, 100));
  });
});
