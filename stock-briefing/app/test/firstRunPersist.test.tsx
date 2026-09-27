import React from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 첫 실행 안내(3-24, 기능 플래그 firstRun) 리뷰 수정 — 쿼리 캐시 저장기까지 붙여서 본다.
 * 저장기(lib/queryPersist, @tanstack/query-async-storage-persister)는 복원한 뒤 첫 쿼리 변화 때 기다리지 않고 바로 rq.cache 를
 * 이번 실행 시각으로 다시 적는다. 예전에는 firstRun 플래그를 받은 뒤에야 흔적을 읽어서, 복원된 플래그에 firstRun 이 없으면
 * (백엔드 배포 전에 받은 플래그 · 관리자가 나중에 켬 · 플래그 캐시 없음) 읽을 때 캐시가 이미 '이번 실행' 것이라 기존 사용자에게 안내가 떴다.
 * 이제는 lib/firstRun 을 불러오는 순간(앱 루트가 불러옴 — 복원 전) 읽어 둔 값을 쓴다.
 * 시계는 고정: 지난 실행 2026-09-26 21:00, 이번 실행 2026-09-27 09:00 (한국 시각)
 */
const h = vi.hoisted(() => {
  const PREV = Date.parse("2026-09-26T21:00:00+09:00");
  const BOOT = Date.parse("2026-09-27T09:00:00+09:00");
  // Date 만 고정한다 (저장기의 throttle 은 Date.now 로 다음 실행 시각을 잰다). setTimeout 은 진짜
  vi.useFakeTimers({ toFake: ["Date"], now: BOOT });
  const URL = "https://server.test";
  const state = (data: unknown) => ({
    data,
    dataUpdateCount: 1,
    dataUpdatedAt: PREV,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: false,
    status: "success",
    fetchStatus: "idle",
  });
  const store = new Map<string, string>();
  // 지난 실행이 남긴 것은 쿼리 캐시뿐 (설정을 바꾸지 않았고 브리핑·검색·차트 설정도 쓰지 않은 기존 사용자).
  // 저장된 기능 플래그에는 firstRun 이 없다 (백엔드 배포 전에 받은 플래그)
  store.set(
    "rq.cache",
    JSON.stringify({
      timestamp: PREV,
      buster: "v2",
      clientState: {
        mutations: [],
        queries: [
          { queryKey: [URL, "features"], queryHash: JSON.stringify([URL, "features"]), state: state({ features: { oneHand: true, emptyGuide: true }, updatedAt: null }) },
          { queryKey: [URL, "stocks"], queryHash: JSON.stringify([URL, "stocks"]), state: state([{ code: "005930", name: "삼성전자" }]) },
        ],
      },
    }),
  );
  return { PREV, BOOT, URL, store, push: vi.fn() };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
    multiGet: async (keys: string[]) => keys.map((k) => [k, h.store.get(k) ?? null]),
  },
}));
vi.mock("expo-router", () => ({
  router: { push: h.push },
  useRootNavigationState: () => ({ key: "root" }),
  usePathname: () => "/",
}));
vi.mock("@/api/hooks", () => ({ useFeatures: () => ({ data: undefined, isError: false }) }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ haptics: true }) }));

// 앱 루트(app/_layout)처럼: 먼저 UxBridge(→ lib/firstRun)를 불러오고, 그 뒤에 저장기가 복원한다
const { FirstRunGate } = await import("@/components/UxBridge");
const { FIRST_RUN_KEY, hasPriorUse, priorUseFrom, PRIOR_USE_KEYS, QUERY_CACHE_KEY } = await import("@/lib/firstRun");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { queryPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, shouldPersist } = await import("@/lib/queryPersist");
const { QueryClient } = await import("@tanstack/react-query");
const { persistQueryClient } = await import("@tanstack/react-query-persist-client");

afterAll(() => {
  vi.useRealTimers();
});

const flush = () => new Promise((res) => setTimeout(res, 0));
const cacheTs = () => (JSON.parse(h.store.get(QUERY_CACHE_KEY) ?? "{}") as { timestamp?: number }).timestamp;

describe("캐시만 남은 기존 사용자 + 복원된 플래그에 firstRun 없음 → 네트워크로 firstRun 켬을 받음", () => {
  it("저장기가 캐시를 이번 실행 시각으로 덮어도 안내를 띄우지 않고 '건너뜀'으로 적는다", async () => {
    // 복원 (PersistQueryClientProvider 와 같은 설정)
    const qc = new QueryClient();
    const [unsubscribe, restored] = persistQueryClient({
      queryClient: qc,
      persister: queryPersister,
      maxAge: PERSIST_MAX_AGE_MS,
      buster: PERSIST_BUSTER,
      dehydrateOptions: { shouldDehydrateQuery: (q) => shouldPersist(q.queryKey, q.state, Date.now()), shouldDehydrateMutation: () => false },
    });
    await restored;
    expect(qc.getQueryData([h.URL, "features"])).toEqual({ features: { oneHand: true, emptyGuide: true }, updatedAt: null });
    expect(cacheTs()).toBe(h.PREV);

    // 켠 지 1초: 잔고 새로고침 → 저장기가 곧바로(throttle 첫 호출) 캐시를 이번 실행 시각으로 다시 적는다
    vi.setSystemTime(h.BOOT + 1_000);
    qc.setQueryData([h.URL, "stocks"], [{ code: "005930", name: "삼성전자" }]);
    for (let i = 0; i < 20 && cacheTs() === h.PREV; i++) await flush();
    expect(cacheTs()).toBe(h.BOOT + 1_000);
    // 이제 저장소를 새로 읽으면 흔적이 없다 (예전 방식은 여기서 읽어 안내를 띄웠다)
    const now = new Map([...PRIOR_USE_KEYS, QUERY_CACHE_KEY].map((k) => [k, h.store.get(k) ?? null] as const));
    expect(priorUseFrom(now, h.BOOT)).toBe(false);
    // 앱을 켤 때 읽어 둔 흔적은 지난 실행의 캐시다
    expect(await hasPriorUse()).toBe(true);

    // 켠 지 3초: 서버에서 firstRun 켬을 받음 → 게이트가 붙는다
    vi.setSystemTime(h.BOOT + 3_000);
    const r = render(
      <UxFlagsContext.Provider value={{ oneHand: true, firstRun: true, emptyGuide: true, connectionGuide: true, flagsMissing: false }}>
        <FirstRunGate />
      </UxFlagsContext.Provider>,
    );
    await flush();
    r.rerender();
    await flush();
    r.rerender();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
    unsubscribe();
  });
});
