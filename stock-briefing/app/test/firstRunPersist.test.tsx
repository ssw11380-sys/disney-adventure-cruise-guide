import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import React from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";

/**
 * 첫 실행 안내(3-24, 기능 플래그 firstRun) — 실제 배포 순서 그대로, 쿼리 캐시 저장기(lib/queryPersist)와 실제 QueryClient 를 붙여서 본다.
 * APK 1.4.0 을 새로 설치하면 app.json fallbackToCacheTimeout 0 이라 **첫 실행은 APK 에 든 번들**(이 기능 없음)로 돈다.
 * 그 번들도 잔고·플래그를 받아 rq.cache 를 적는다. OTA 는 두 번째 실행부터 적용된다.
 * 예전 방식(기기 흔적: 지난 실행의 rq.cache 가 있으면 기존 사용자)은 여기서 '기존 사용자'로 적어 새 사용자에게 안내가 뜨지 않았다.
 * 이제는 이번 실행에서 서버에서 새로 받은 자료(등록 종목 0개 + 토스 연동 없음)로 정한다.
 * 시계는 고정: 첫 실행(APK 번들) 2026-09-27 08:50, 두 번째 실행(OTA) 09:00, 세 번째 실행 21:00 (한국 시각)
 */
const h = vi.hoisted(() => {
  const PREV = Date.parse("2026-09-27T08:50:00+09:00");
  const BOOT = Date.parse("2026-09-27T09:00:00+09:00");
  // Date 만 고정한다 (저장기의 throttle 은 Date.now 로 다음 실행 시각을 잰다). setTimeout 은 진짜
  vi.useFakeTimers({ toFake: ["Date"], now: BOOT });
  const URL = "https://server.test";
  return {
    PREV,
    BOOT,
    URL,
    store: new Map<string, string>(),
    push: vi.fn(),
    // 서버: 인터넷 연결 · 등록 종목 · 토스 연동
    server: { online: true, stocks: [] as { code: string; name: string }[], toss: { configured: false, sync: null } as { configured: boolean; sync: { lastRunAt: string | null } | null } },
    calls: { stocks: 0, health: 0 },
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));
vi.mock("expo-router", () => ({
  router: { push: h.push },
  useRootNavigationState: () => ({ key: "root" }),
  usePathname: () => "/",
}));
// 앱의 조회 훅과 같은 키·설정 (api/hooks useRegisteredStocks · useHealth), 서버만 가짜
vi.mock("@/api/hooks", () => {
  const offline = () => new Error(`서버에 연결할 수 없습니다: ${h.URL}`);
  return {
    useFeatures: () => ({ data: undefined, isError: false }),
    useRegisteredStocks: () =>
      useQuery({
        queryKey: [h.URL, "stocks"],
        queryFn: async () => {
          h.calls.stocks += 1;
          if (!h.server.online) throw offline();
          return h.server.stocks;
        },
        staleTime: 30_000,
        retry: 0,
      }),
    useHealth: () =>
      useQuery({
        queryKey: [h.URL, "health"],
        queryFn: async () => {
          h.calls.health += 1;
          if (!h.server.online) throw offline();
          return { ok: true, time: "", schedule: null, disclaimer: "", tossOpenApi: { ...h.server.toss, outboundIp: null, client: null, realtime: null } };
        },
        staleTime: 30_000,
        retry: 0,
      }),
  };
});
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ haptics: true }) }));

const { FirstRunGate } = await import("@/components/UxBridge");
const { BOOT_AT, FIRST_RUN_KEY, forgetFirstRunClaim, markFirstRun } = await import("@/lib/firstRun");
const { UxFlagsContext } = await import("@/lib/uxFlags");
const { queryPersister, PERSIST_BUSTER, PERSIST_MAX_AGE_MS, PERSIST_STORAGE_KEY, shouldPersist } = await import("@/lib/queryPersist");
const { persistQueryClient } = await import("@tanstack/react-query-persist-client");

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  cleanupRenders();
  h.store.clear();
  h.push.mockReset();
  h.server = { online: true, stocks: [], toss: { configured: false, sync: null } };
  h.calls = { stocks: 0, health: 0 };
  forgetFirstRunClaim();
  vi.setSystemTime(h.BOOT);
});

const flush = () => new Promise((res) => setTimeout(res, 0));
type Launched = { r: { rerender: () => void } };
/** 비동기 일(저장소 읽기·조회)을 기다리며 다시 그린다 (miniRender 는 effect 밖 상태 변경을 다음 그리기에서 반영). ok 가 없으면 n 번 */
const settle = async (x: Launched, ok: () => boolean = () => false, n = 50) => {
  for (let i = 0; i < n && !ok(); i++) {
    await flush();
    x.r.rerender();
  }
};

/** 첫 실행(APK 에 든 번들)이 남기는 rq.cache: 그 번들도 잔고·플래그를 받아 적는다 (firstRun 은 모르는 플래그) */
function embeddedFirstLaunchCache(stocks: unknown[]) {
  const state = (data: unknown) => ({
    data,
    dataUpdateCount: 1,
    dataUpdatedAt: h.PREV,
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
  h.store.set(
    PERSIST_STORAGE_KEY,
    JSON.stringify({
      timestamp: h.PREV,
      buster: PERSIST_BUSTER,
      clientState: {
        mutations: [],
        queries: [
          { queryKey: [h.URL, "features"], queryHash: JSON.stringify([h.URL, "features"]), state: state({ features: {}, updatedAt: null }) },
          { queryKey: [h.URL, "stocks"], queryHash: JSON.stringify([h.URL, "stocks"]), state: state(stocks) },
        ],
      },
    }),
  );
}

/** 앱 한 번 켜기: 쿼리 캐시 복원(PersistQueryClientProvider 와 같은 설정) 뒤 서버에서 받은 firstRun 켬으로 게이트를 붙인다 */
async function launch() {
  forgetFirstRunClaim();
  const qc = new QueryClient();
  const [unsubscribe, restored] = persistQueryClient({
    queryClient: qc,
    persister: queryPersister,
    maxAge: PERSIST_MAX_AGE_MS,
    buster: PERSIST_BUSTER,
    dehydrateOptions: { shouldDehydrateQuery: (q) => shouldPersist(q.queryKey, q.state, Date.now()), shouldDehydrateMutation: () => false },
  });
  await restored;
  const r = render(
    <QueryClientProvider client={qc}>
      <UxFlagsContext.Provider value={{ oneHand: true, firstRun: true, emptyGuide: true, connectionGuide: true, flagsMissing: false }}>
        <FirstRunGate />
      </UxFlagsContext.Provider>
    </QueryClientProvider>,
  );
  // 끄기: 화면을 닫고(effect 정리·구독 해제) 저장기 구독을 끊는다
  return { qc, r, close: () => (cleanupRenders(), unsubscribe(), qc.clear()) };
}

describe("APK 새 설치: 첫 실행은 APK 번들(rq.cache 를 적음), 두 번째 실행부터 OTA", () => {
  it("캐시가 있어도 등록 종목 0개 + 토스 연동 없음을 새로 받으면 한 번 띄운다. 다음 실행에는 다시 띄우지 않는다", async () => {
    expect(BOOT_AT).toBe(h.BOOT);
    embeddedFirstLaunchCache([]);
    const a = await launch();
    // 복원한 캐시(지난 실행에 받은 빈 목록)만으로는 정하지 않는다: 서버에서 새로 받은 뒤에 연다
    await settle(a, () => h.push.mock.calls.length > 0);
    expect(h.calls.stocks).toBeGreaterThanOrEqual(1);
    expect(h.calls.health).toBeGreaterThanOrEqual(1);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith("/welcome");
    // 안내 화면이 열리며 '본 것'으로 적는다 (app/welcome)
    await markFirstRun("seen");
    a.close();

    // 세 번째 실행: 여전히 종목 0개여도 다시 띄우지 않는다
    vi.setSystemTime(h.BOOT + 12 * 3_600_000);
    const b = await launch();
    await settle(b, () => false, 10);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.store.get(FIRST_RUN_KEY)).toBe("seen");
    b.close();
  });

  it("보유 종목이 있는 기존 사용자: 띄우지 않고 '건너뜀'으로 적는다 (다음 실행에도 안 띄움)", async () => {
    embeddedFirstLaunchCache([{ code: "005930", name: "삼성전자" }]);
    h.server.stocks = [{ code: "005930", name: "삼성전자" }];
    const a = await launch();
    await settle(a, () => h.store.get(FIRST_RUN_KEY) !== undefined);
    expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
    expect(h.push).not.toHaveBeenCalled();
    a.close();
    // 나중에 종목을 모두 지워도 한 번 적은 기록은 다시 판단하지 않는다
    h.server.stocks = [];
    const b = await launch();
    await settle(b, () => false, 10);
    expect(h.push).not.toHaveBeenCalled();
    b.close();
  });

  it("토스가 연결된 서버(종목은 아직 0개 — 곧 자동 동기화): 기존 사용자로 본다", async () => {
    embeddedFirstLaunchCache([]);
    h.server.toss = { configured: true, sync: null };
    const a = await launch();
    await settle(a, () => h.store.get(FIRST_RUN_KEY) !== undefined);
    expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
    expect(h.push).not.toHaveBeenCalled();
    a.close();
  });

  it("오프라인으로 처음 켬: 아무것도 적지 않고 기다렸다가, 연결되면 띄운다 (기존 사용자로 굳지 않는다)", async () => {
    embeddedFirstLaunchCache([]);
    h.server.online = false;
    const a = await launch();
    await settle(a, () => h.calls.stocks > 0 && h.calls.health > 0);
    await settle(a, () => false, 5);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.store.get(FIRST_RUN_KEY)).toBeUndefined();
    a.close();

    // 다음 실행도 오프라인 → 여전히 기록 없음
    vi.setSystemTime(h.BOOT + 60_000);
    const b = await launch();
    await settle(b, () => h.calls.stocks > 1);
    await settle(b, () => false, 5);
    expect(h.store.get(FIRST_RUN_KEY)).toBeUndefined();
    // 같은 실행에서 연결이 돌아옴 → 다시 받으면(잔고 폴링·화면 복귀) 띄운다
    h.server.online = true;
    vi.setSystemTime(h.BOOT + 120_000);
    await b.qc.refetchQueries();
    await settle(b, () => h.push.mock.calls.length > 0);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith("/welcome");
    b.close();
  });
});
