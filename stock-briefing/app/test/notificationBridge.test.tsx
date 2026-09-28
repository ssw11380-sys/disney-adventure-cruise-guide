import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 알림을 눌렀을 때의 이동 (BH-50, BH-64). 실제 NotificationBridge 를 최소 렌더러로 그린다.
 *  - 묶음 알림(→ 브리핑 탭)을 종목 상세 위에서 눌러도 탭 묶음을 하나 더 쌓지 않는다
 *  - OTA "지금 다시 시작"으로 JS 만 다시 뜨면 네이티브가 앱을 켰던 옛 알림 응답을 다시 넘긴다 → 이미 처리한 응답이면 다시 이동하지 않는다
 *  - 브리핑 알림을 받거나 누르면 브리핑 목록을 다시 받는다 (BH-16) — 브리지는 QueryClient 안에서 그린다
 */
const h = vi.hoisted(() => ({
  response: null as unknown,
  canDismiss: false,
  push: vi.fn(),
  navigate: vi.fn(),
  dismissTo: vi.fn(),
  store: new Map<string, string>(),
  /** 앱을 보는 중에 온 알림을 받는 곳 (addNotificationReceivedListener) */
  received: [] as ((n: unknown) => void)[],
  /** 무효화한 쿼리 키 */
  invalidated: [] as unknown[],
  /** 브리핑 3차 1 (notifBack): 지금 화면 주소 · 펼친 가로 2단 · 저장된 캐시 복원 중 · 설정을 읽었는지 */
  path: "/" as string,
  twoPane: false,
  restoring: false,
  ready: true,
}));

/** 설정의 서버 주소 (플래그 캐시 키) */
const API = "https://server.test";

vi.mock("@/lib/useFoldLayout", () => ({
  useFoldLayout: () => ({ on: h.twoPane, width: h.twoPane ? "expanded" : "compact", short: h.twoPane, twoPane: h.twoPane, rail: false }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tanstack/react-query")>()), useIsRestoring: () => h.restoring }));
vi.mock("@/lib/settings", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/settings")>()), useSettings: () => ({ apiUrl: API, ready: h.ready }) }));

vi.mock("expo-notifications", () => ({
  setNotificationHandler: () => undefined,
  setNotificationChannelAsync: async () => null,
  AndroidImportance: { HIGH: 4 },
  useLastNotificationResponse: () => h.response,
  addNotificationReceivedListener: (f: (n: unknown) => void) => {
    h.received.push(f);
    return { remove: () => void h.received.splice(h.received.indexOf(f), 1) };
  },
}));
vi.mock("expo-router", () => ({ router: { push: h.push, navigate: h.navigate, dismissTo: h.dismissTo, canDismiss: () => h.canDismiss }, usePathname: () => h.path }));
vi.mock("expo-device", () => ({ isDevice: true, modelName: "test" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));

/** 알림 응답 (expo-notifications NotificationResponse 모양) */
const tap = (identifier: string, data: Record<string, unknown>, date = Date.parse("2026-09-24T17:00:00+09:00")) => ({
  actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
  notification: { date, request: { identifier, content: { title: "브리핑", body: "", data } } },
});

/**
 * JS 를 새로 띄운다 (앱 시작·OTA 다시 시작): 모듈 상태·화면 상태·쿼리 캐시는 새로, 기기 저장소는 그대로.
 * flags: 저장된 캐시에서 되살린 기능 플래그 (브리핑 3차 1 notifBack 시험용 — 없으면 플래그를 모르는 첫 설치와 같다)
 */
async function boot(opts: { flags?: Record<string, boolean> } = {}) {
  vi.resetModules();
  const R = await import("react");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { render } = await import("./miniRender");
  const { NotificationBridge } = await import("@/components/NotificationBridge");
  const client = new QueryClient();
  if (opts.flags) client.setQueryData([API, "features"], { features: opts.flags, updatedAt: null });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
    h.invalidated.push(filters?.queryKey);
    return invalidate(filters as never);
  }) as typeof client.invalidateQueries;
  return render(R.createElement(QueryClientProvider, { client }, R.createElement(NotificationBridge)));
}
const moves = () => h.push.mock.calls.length + h.navigate.mock.calls.length + h.dismissTo.mock.calls.length;
const settle = () => new Promise((r) => setTimeout(r, 120));

beforeEach(() => {
  h.store.clear();
  h.response = null;
  h.canDismiss = false;
  h.received.length = 0;
  h.invalidated.length = 0;
  h.path = "/";
  h.twoPane = false;
  h.restoring = false;
  h.ready = true;
  for (const f of [h.push, h.navigate, h.dismissTo]) f.mockReset();
});

describe("BH-64: OTA 다시 시작 뒤 옛 알림으로 다시 이동하지 않는다", () => {
  it("알림으로 켠 뒤 같은 프로세스에서 JS 를 다시 띄우면, 다시 넘겨받은 같은 응답으로는 이동하지 않는다 (재현)", async () => {
    h.response = tap("local-digest-1", { type: "briefing", digest: true });
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    // "지금 다시 시작" → 네이티브가 같은 응답을 새 JS 에 다시 준다
    await boot();
    await settle();
    expect(moves()).toBe(1);
  });

  it("다시 시작한 뒤 새로 누른 알림은 이동한다", async () => {
    h.response = tap("local-digest-1", { type: "briefing", digest: true });
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    await boot();
    await settle();
    h.response = tap("remote-42", { type: "briefing", briefingId: 42 });
    await boot();
    await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/42"));
    expect(moves()).toBe(2);
  });

  it("같은 식별자라도 새로 올라온 알림(시각이 다름)이면 이동한다", async () => {
    h.response = tap("same-tag", { type: "briefing", briefingId: 7 }, 1_000);
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    h.response = tap("same-tag", { type: "briefing", briefingId: 8 }, 2_000);
    await boot();
    await vi.waitFor(() => expect(h.push).toHaveBeenLastCalledWith("/briefings/8"));
  });

  it("저장소를 읽지 못해도 이동은 한다", async () => {
    h.store.set("notifications.handled", "{깨진 값");
    h.response = tap("n-1", { type: "briefing", briefingId: 3 });
    await boot();
    await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/3"));
  });
});

describe("BH-50: 묶음 알림은 탭 묶음을 새로 쌓지 않는다", () => {
  it("종목 상세 위(루트 스택에 화면이 쌓임)에서 누르면 기존 탭으로 돌아가 브리핑 탭을 연다 (재현)", async () => {
    h.canDismiss = true;
    h.response = tap("digest-1", { type: "briefing", digest: true });
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    expect(h.dismissTo).toHaveBeenCalledWith("/briefings");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("탭 안에서 누르면 탭만 바꾼다", async () => {
    h.response = tap("digest-2", { type: "briefing", digest: true });
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    expect(h.navigate).toHaveBeenCalledWith("/briefings");
    expect(h.push).not.toHaveBeenCalled();
  });

  it("종목 하나 브리핑 알림은 예전처럼 상세 화면을 연다", async () => {
    h.canDismiss = true;
    h.response = tap("single-1", { type: "briefing", briefingId: 99 });
    await boot();
    await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/99"));
    expect(moves()).toBe(1);
  });
});

describe("BH-16: 브리핑 알림을 받거나 누르면 브리핑 목록을 다시 받는다 (이동 규칙은 그대로)", () => {
  const briefingsKey = (k: unknown) => Array.isArray(k) && k[1] === "briefings";

  it("묶음 알림을 누르면 브리핑 목록을 무효화하고 브리핑 탭으로 (탭 안이면 탭만 바꾼다)", async () => {
    h.response = tap("digest-3", { type: "briefing", digest: true });
    await boot();
    await vi.waitFor(() => expect(moves()).toBe(1));
    expect(h.navigate).toHaveBeenCalledWith("/briefings");
    expect(h.invalidated.some(briefingsKey)).toBe(true);
  });

  it("앱을 보는 중에 온 브리핑 알림도 목록을 다시 받는다 — 이동은 하지 않는다", async () => {
    await boot();
    expect(h.received).toHaveLength(1);
    h.received[0]!({ request: { identifier: "n-9", content: { data: { type: "briefing", briefingId: 9 } } } });
    expect(h.invalidated.some(briefingsKey)).toBe(true);
    await settle();
    expect(moves()).toBe(0);
  });

  it("브리핑이 아닌 알림(가격 알림)은 목록을 건드리지 않는다", async () => {
    await boot();
    h.received[0]!({ request: { identifier: "p-1", content: { data: { type: "price", code: "005930" } } } });
    expect(h.invalidated.some(briefingsKey)).toBe(false);
  });
});

describe("브리핑 3차 1 notifBack: 브리핑 알림을 누르면 대상, '뒤로'는 브리핑 탭", () => {
  const ON = { notifBack: true };
  /** 계좌 앞머리 세션 알림 · 묶음(시장 요약 첫 줄) · 종목 하나 · 가격 알림 */
  const ACCOUNT = { type: "briefing", digest: true, session: "morning", date: "2026-09-28", count: 17, accountBriefingId: 5, briefingId: 42, code: "NVDA", marketSummaryId: 900 };
  const DIGEST = { type: "briefing", digest: true, session: "morning", date: "2026-09-28", count: 17, briefingId: 42, code: "NVDA", marketSummaryId: 900 };
  const STOCK = { type: "briefing", briefingId: 42, code: "NVDA", session: "morning", date: "2026-09-28" };
  const PRICE = { type: "priceAlert", code: "005930" };
  type Fn = { mock: { invocationCallOrder: number[] } };
  const before = (a: Fn, b: Fn) => a.mock.invocationCallOrder[0]! < b.mock.invocationCallOrder[0]!;

  describe("콜드 스타트 (앱이 꺼진 채 알림을 누름 — 잔고 탭 위에서 시작)", () => {
    it("저장된 캐시를 되살리는 동안은 움직이지 않고, 끝나면 브리핑 탭 → 계좌 브리핑 상세 순서로 (뒤로 = 브리핑 탭)", async () => {
      h.restoring = true;
      h.response = tap("cold-1", ACCOUNT);
      const r = await boot({ flags: ON });
      await settle();
      expect(moves()).toBe(0);
      h.restoring = false;
      r.rerender();
      await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/account/5"));
      expect(h.navigate).toHaveBeenCalledWith("/briefings");
      expect(before(h.navigate, h.push)).toBe(true);
      expect(h.dismissTo).not.toHaveBeenCalled();
      expect(moves()).toBe(2);
    });

    it("설정을 아직 못 읽었어도 기다린다 (플래그 캐시 키가 서버 주소라서)", async () => {
      h.ready = false;
      h.response = tap("cold-2", STOCK);
      const r = await boot({ flags: ON });
      await settle();
      expect(moves()).toBe(0);
      h.ready = true;
      r.rerender();
      await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/42"));
      expect(before(h.navigate, h.push)).toBe(true);
    });

    it("되살리기가 1.5초 넘게 끝나지 않으면 플래그를 모르는 것으로 보고 지금처럼 상세만 연다 (스플래시와 같은 한도)", async () => {
      h.restoring = true;
      h.response = tap("cold-3", ACCOUNT);
      await boot();
      await settle();
      expect(moves()).toBe(0);
      await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/account/5"), { timeout: 3_000 });
      expect(moves()).toBe(1);
    });

    it("2단(펼친 가로)이면 새 화면을 쌓지 않고 브리핑 탭 오른쪽 칸에 그 계좌 브리핑을 골라 둔다", async () => {
      h.twoPane = true;
      h.restoring = true;
      h.response = tap("cold-4", ACCOUNT);
      const r = await boot({ flags: ON });
      h.restoring = false;
      r.rerender();
      await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/briefings"));
      const pick = await import("@/lib/briefingPick");
      expect(pick.currentPick()).toEqual({ pick: { kind: "account", id: 5 }, highlight: true });
      expect(h.push).not.toHaveBeenCalled();
      expect(moves()).toBe(1);
    });
  });

  describe("웜 (앱을 쓰는 중에 누름)", () => {
    it("종목 상세 위: 쌓인 화면을 닫고 브리핑 탭으로(dismissTo) → 상세 (뒤로 = 브리핑 탭, 보던 종목 상세는 닫힘)", async () => {
      h.canDismiss = true;
      h.path = "/stocks/005930";
      h.response = tap("warm-1", ACCOUNT);
      await boot({ flags: ON });
      await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/account/5"));
      expect(h.dismissTo).toHaveBeenCalledWith("/briefings");
      expect(before(h.dismissTo, h.push)).toBe(true);
      expect(h.navigate).not.toHaveBeenCalled();
    });

    it("탭 안(잔고 탭 등): 탭만 브리핑으로 바꾸고 → 상세", async () => {
      h.path = "/";
      h.response = tap("warm-2", STOCK);
      await boot({ flags: ON });
      await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/42"));
      expect(h.navigate).toHaveBeenCalledWith("/briefings");
      expect(before(h.navigate, h.push)).toBe(true);
      expect(moves()).toBe(2);
    });

    it("같은 계좌 브리핑을 보던 중: 같은 화면이 두 겹으로 쌓이지 않는다 (브리핑 탭까지 닫고 하나만)", async () => {
      h.canDismiss = true;
      h.path = "/briefings/account/5";
      h.response = tap("warm-3", ACCOUNT);
      await boot({ flags: ON });
      await vi.waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
      expect(h.dismissTo).toHaveBeenCalledTimes(1);
      expect(h.dismissTo).toHaveBeenCalledWith("/briefings");
      await settle();
      expect(moves()).toBe(2);
    });

    it("입력 중 화면(잔고 수정) 위: 입력을 잃지 않게 지금처럼 위에 쌓기만 한다", async () => {
      h.canDismiss = true;
      h.path = "/stocks/005930/edit";
      h.response = tap("warm-4", ACCOUNT);
      await boot({ flags: ON });
      await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/account/5"));
      await settle();
      expect(moves()).toBe(1);
    });

    it("묶음 알림은 지금처럼 브리핑 탭 (종목 상세 위면 dismissTo 한 번)", async () => {
      h.canDismiss = true;
      h.path = "/stocks/005930";
      h.response = tap("warm-5", DIGEST);
      await boot({ flags: ON });
      await vi.waitFor(() => expect(moves()).toBe(1));
      expect(h.dismissTo).toHaveBeenCalledWith("/briefings");
      await settle();
      expect(moves()).toBe(1);
    });

    it("가격 알림은 켜져 있어도 지금 그대로 (종목 상세만 연다)", async () => {
      h.canDismiss = true;
      h.path = "/stocks/AAPL";
      h.response = tap("warm-6", PRICE);
      await boot({ flags: ON });
      await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/stocks/005930"));
      await settle();
      expect(moves()).toBe(1);
    });
  });

  describe("펼친 가로 2단: push 0회, 오른쪽 칸에서 고르기", () => {
    it("종목 알림: 그 종목 브리핑을 고르고(목록 줄 강조) 읽음으로 적는다", async () => {
      h.twoPane = true;
      h.canDismiss = true;
      h.path = "/stocks/005930";
      h.response = tap("pane-1", STOCK);
      await boot({ flags: ON });
      await vi.waitFor(() => expect(h.dismissTo).toHaveBeenCalledWith("/briefings"));
      const pick = await import("@/lib/briefingPick");
      expect(pick.currentPick()).toEqual({ pick: { kind: "stock", id: 42, code: "NVDA" }, highlight: true });
      await vi.waitFor(() => expect(h.store.get("briefings.read")).toBe("[42]"));
      expect(h.push).not.toHaveBeenCalled();
    });

    it("묶음 알림: 알림 첫 줄인 시장 요약을 고른다", async () => {
      h.twoPane = true;
      h.response = tap("pane-2", DIGEST);
      await boot({ flags: ON });
      await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/briefings"));
      const pick = await import("@/lib/briefingPick");
      expect(pick.currentPick()).toEqual({ pick: { kind: "market", id: 900 }, highlight: true });
      await settle();
      expect(h.push).not.toHaveBeenCalled();
      expect(h.store.has("briefings.read")).toBe(false);
    });

    it("가격 알림은 2단에서도 지금 그대로", async () => {
      h.twoPane = true;
      h.response = tap("pane-3", PRICE);
      await boot({ flags: ON });
      await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/stocks/005930"));
      const pick = await import("@/lib/briefingPick");
      expect(pick.currentPick().pick).toBeNull();
    });
  });

  describe("플래그 꺼짐·모름 → 지금과 똑같은 호출", () => {
    for (const [label, flags] of [["꺼짐", { notifBack: false }], ["모름", undefined]] as const) {
      it(`${label}: 종목 상세 위 계좌 알림 → push 만 (뒤로 = 보던 화면)`, async () => {
        h.canDismiss = true;
        h.path = "/stocks/005930";
        h.response = tap(`off-1-${label}`, ACCOUNT);
        await boot(flags ? { flags } : {});
        await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/account/5"));
        await settle();
        expect(moves()).toBe(1);
      });

      it(`${label}: 2단이어도 전체 화면 상세를 쌓고 고르지 않는다`, async () => {
        h.twoPane = true;
        h.response = tap(`off-2-${label}`, STOCK);
        await boot(flags ? { flags } : {});
        await vi.waitFor(() => expect(h.push).toHaveBeenCalledWith("/briefings/42"));
        await settle();
        expect(moves()).toBe(1);
        const pick = await import("@/lib/briefingPick");
        expect(pick.currentPick().pick).toBeNull();
      });
    }
  });

  it("켜져 있어도 같은 응답으로 두 번 움직이지 않는다 (OTA 다시 시작)", async () => {
    h.response = tap("once-1", ACCOUNT);
    await boot({ flags: ON });
    await vi.waitFor(() => expect(moves()).toBe(2));
    await boot({ flags: ON });
    await settle();
    expect(moves()).toBe(2);
  });
});
