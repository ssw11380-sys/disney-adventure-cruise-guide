import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { cleanupRenders, render } from "./miniRender";

/**
 * 관심 그룹 제공자·저장 차례 (3-34, 플래그 watchGroups) — 실제 QueryClient 로.
 *  - 꺼짐: 서버를 부르지 않고 꺼짐 값 (잔고·메뉴가 지금 그대로)
 *  - 켬: 배치를 받아 내려 줌, 예전 서버 404 · on:false 는 꺼짐처럼
 *  - 조작: 누르는 즉시 캐시(낙관적) → 차례로 보내고 마지막 응답으로 맞춤, 실패하면 '저장하지 못했습니다' 창 + 서버 값 다시 받기
 *  - 기기 캐시 저장 대상(watchGroups), 종목 상세 ‹ › 가 보이는 관심 순서를 따름
 */
const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  api: {} as Record<string, ReturnType<typeof vi.fn>>,
  alert: vi.fn(),
  announce: vi.fn(),
  view: { selected: "all", collapsed: [] } as { selected: unknown; collapsed: unknown[] },
  setView: vi.fn(),
}));
vi.mock("react-native", () => ({ Alert: { alert: h.alert }, AccessibilityInfo: { announceForAccessibility: h.announce } }));
vi.mock("@/api/hooks", () => ({ useApi: () => h.api, useFeature: (k: string, f = false) => h.flags[k] ?? f }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "http://x", watchView: h.view, setWatchView: h.setView, sort: "created", afterCost: false }) }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));

const { WatchGroupsProvider } = await import("@/components/WatchGroupsProvider");
const { useWatchGroups, WatchOpQueue, WATCH_GROUPS_OFF } = await import("@/lib/watchGroupsQuery");
const { ApiRequestError } = await import("@/api/client");
const { shouldPersist } = await import("@/lib/queryPersist");
const { holdingsOrder } = await import("@/lib/holdingsNav");
const { watchModel } = await import("@/lib/watchGroups");
type State = import("@/lib/watchGroupsQuery").WatchGroupsState;
type Layout = import("@/lib/watchGroups").WatchLayout;

const at = (m: number) => `2026-09-01T09:${String(m).padStart(2, "0")}:00+09:00`;
const w = (code: string, name: string, m: number): RegisteredWithQuote => ({ ...holding(code, quote(code, 100), null, null, undefined, name), createdAt: at(m) });
const LIST = [w("A", "가", 1), w("B", "나", 2), w("C", "다", 3), w("D", "라", 4)];
const LAYOUT: Layout = {
  on: true,
  groups: [{ id: 1, name: "반도체", position: 0 }],
  items: [
    { code: "A", groupId: 1, position: 0 },
    { code: "B", groupId: 1, position: 1 },
  ],
};
const settle = () => new Promise((r) => setTimeout(r, 30));
/** 부르는 쪽이 끝낼 수 있는 응답 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let client: QueryClient;
beforeEach(() => {
  cleanupRenders();
  h.flags = { watchGroups: true };
  h.api = { watchGroups: vi.fn(async () => LAYOUT), moveWatchStock: vi.fn(), createWatchGroup: vi.fn(), renameWatchGroup: vi.fn(), deleteWatchGroup: vi.fn(), orderWatchGroups: vi.fn() };
  h.alert.mockReset();
  h.announce.mockReset();
  h.setView.mockReset();
  h.view = { selected: "all", collapsed: [] };
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["http://x", "stocks"], LIST);
});
afterEach(() => client.clear());

function mount() {
  const seen = { value: WATCH_GROUPS_OFF as State };
  function Probe() {
    seen.value = useWatchGroups();
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <WatchGroupsProvider>
        <Probe />
      </WatchGroupsProvider>
    </QueryClientProvider>,
  );
  return seen;
}
const cache = () => client.getQueryData<Layout>(["http://x", "watchGroups"]);

describe("제공자: 꺼짐 · 켬 · 예전 서버", () => {
  it("꺼짐: 서버를 부르지 않고 꺼짐 값", async () => {
    h.flags = {};
    const seen = mount();
    await settle();
    expect(seen.value).toBe(WATCH_GROUPS_OFF);
    expect(h.api.watchGroups).not.toHaveBeenCalled();
  });

  it("켬: 배치를 받아 on · 준비됨, 기기에 저장한 보기 상태(서버에 없는 그룹은 뺌)", async () => {
    h.view = { selected: 42, collapsed: [1, 42] };
    const seen = mount();
    expect(seen.value.status).toBe("loading");
    await settle();
    expect(seen.value.on).toBe(true);
    expect(seen.value.status).toBe("ready");
    expect(seen.value.layout).toEqual(LAYOUT);
    expect(seen.value.view).toEqual({ selected: "all", collapsed: [1] });
    expect(shouldPersist(["http://x", "watchGroups"], { data: LAYOUT, dataUpdatedAt: Date.now() - 1000, error: null }, Date.now())).toBe(true);
  });

  it("예전 서버(404)·on:false 는 꺼짐처럼, 다른 오류는 편집 화면의 '실패'", async () => {
    h.api.watchGroups!.mockRejectedValueOnce(new ApiRequestError(404, "HTTP_404", "없음"));
    const a = mount();
    await settle();
    expect([a.value.on, a.value.status]).toEqual([false, "off"]);
    client.clear();
    h.api.watchGroups!.mockResolvedValueOnce({ on: false, groups: [], items: [] });
    const b = mount();
    await settle();
    expect([b.value.on, b.value.status]).toEqual([false, "off"]);
    client.clear();
    // 한 번 더 해 보고(retry 1) 그래도 안 되면 실패
    h.api.watchGroups!.mockRejectedValue(new ApiRequestError(500, "INTERNAL", "서버 오류"));
    const c = mount();
    await vi.waitFor(() => expect([c.value.on, c.value.status]).toEqual([false, "error"]), { timeout: 4000, interval: 50 });
    expect(h.api.watchGroups).toHaveBeenCalledTimes(4);
  });
});

describe("조작: 낙관적 반영 · 차례 · 실패", () => {
  it("↑ 세 번 빠르게: 누를 때마다 바로 캐시가 바뀌고 요청은 하나씩, 마지막 응답만 캐시에 쓴다 · 화면 읽기 알림", async () => {
    const seen = mount();
    await settle();
    const replies = [deferred<Layout>(), deferred<Layout>(), deferred<Layout>()];
    let n = 0;
    h.api.moveWatchStock!.mockImplementation(() => replies[n++]!.promise);
    seen.value.ops.move({ code: "B", name: "나" }, 1, 0, "나를 반도체 1번째로 옮겼습니다");
    expect(cache()!.items.filter((i) => i.groupId === 1)).toEqual([
      { code: "A", groupId: 1, position: 1 },
      { code: "B", groupId: 1, position: 0 },
    ]);
    expect(h.announce).toHaveBeenCalledWith("나를 반도체 1번째로 옮겼습니다");
    seen.value.ops.move({ code: "C", name: "다" }, 1, 0);
    seen.value.ops.move({ code: "D", name: "라" }, null, 0);
    await settle();
    // 앞 요청이 끝나기 전에는 다음 요청을 보내지 않는다
    expect(h.api.moveWatchStock).toHaveBeenCalledTimes(1);
    const mid: Layout = { ...LAYOUT, items: [{ code: "A", groupId: 1, position: 1 }, { code: "B", groupId: 1, position: 0 }] };
    replies[0]!.resolve(mid);
    await settle();
    expect(h.api.moveWatchStock).toHaveBeenCalledTimes(2);
    // 중간 응답은 캐시에 쓰지 않는다 (낙관적 값 그대로 — C 가 맨 앞)
    expect(cache()!.items.find((i) => i.code === "C")).toEqual({ code: "C", groupId: 1, position: 0 });
    replies[1]!.resolve(mid);
    await settle();
    const final: Layout = { ...LAYOUT, items: [{ code: "Z", groupId: null, position: 0 }] };
    replies[2]!.resolve(final);
    await settle();
    expect(h.api.moveWatchStock!.mock.calls.map((c) => c[0])).toEqual([
      { code: "B", groupId: 1, index: 0 },
      { code: "C", groupId: 1, index: 0 },
      { code: "D", groupId: null, index: 0 },
    ]);
    expect(cache()).toEqual(final);
  });

  it("실패하면 '저장하지 못했습니다' 창(서버 글 · 연결 안 됨 글)과 서버 값 다시 받기", async () => {
    const seen = mount();
    await settle();
    h.api.moveWatchStock!.mockRejectedValueOnce(new ApiRequestError(404, "NOT_FOUND", "그룹을 찾을 수 없습니다. 목록을 새로 불러옵니다"));
    seen.value.ops.move({ code: "C", name: "다" }, 1, 0);
    await settle();
    expect(h.alert).toHaveBeenCalledWith("저장하지 못했습니다", "그룹을 찾을 수 없습니다. 목록을 새로 불러옵니다", [{ text: "확인" }]);
    expect(h.api.watchGroups).toHaveBeenCalledTimes(2);
    expect(cache()).toEqual(LAYOUT);
    h.api.deleteWatchGroup!.mockRejectedValueOnce(new ApiRequestError(0, "NETWORK", "서버에 연결할 수 없습니다: http://x"));
    seen.value.ops.remove(1);
    expect(cache()!.groups).toEqual([]);
    await settle();
    expect(h.alert).toHaveBeenLastCalledWith("저장하지 못했습니다", "서버에 연결되지 않았습니다. 연결되면 다시 해 주세요.", [{ text: "확인" }]);
    expect(cache()).toEqual(LAYOUT);
  });

  it("이름 창의 만들기·이름 바꾸기는 창을 띄우지 않고 결과를 돌려준다 (만든 그룹 · 서버 글)", async () => {
    const seen = mount();
    await settle();
    h.api.createWatchGroup!.mockResolvedValueOnce({ ...LAYOUT, groups: [...LAYOUT.groups, { id: 5, name: "배당", position: 1 }], created: { id: 5, name: "배당" } });
    expect(await seen.value.ops.create("배당")).toEqual({ ok: true, created: { id: 5, name: "배당" } });
    await settle();
    expect(cache()!.groups.map((g) => g.name)).toEqual(["반도체", "배당"]);
    expect(cache()).not.toHaveProperty("created");
    h.api.renameWatchGroup!.mockRejectedValueOnce(new ApiRequestError(409, "DUPLICATE", "같은 이름의 그룹이 이미 있습니다"));
    expect(await seen.value.ops.rename(1, "배당")).toEqual({ ok: false, message: "같은 이름의 그룹이 이미 있습니다" });
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("'새 그룹 만들고 옮기기': 만들기 뒤에 다른 조작이 차례에 남아 있어도(만들기 응답이 마지막이 아님) 만든 그룹을 캐시에 먼저 넣어, 이어지는 옮기기가 '그룹 없음' 맨 앞으로 새지 않는다", async () => {
    const seen = mount();
    await settle();
    const made = deferred<Layout>();
    h.api.createWatchGroup!.mockImplementationOnce(() => made.promise);
    const pending = seen.value.ops.create("배당");
    // 만들기 응답 전에 들어온 조작 (끝나지 않음)
    h.api.moveWatchStock!.mockImplementation(() => new Promise(() => undefined));
    seen.value.ops.move({ code: "D", name: "라" }, 1, 0);
    await settle();
    made.resolve({ ...LAYOUT, groups: [...LAYOUT.groups, { id: 5, name: "배당", position: 1 }], created: { id: 5, name: "배당" } });
    expect(await pending).toEqual({ ok: true, created: { id: 5, name: "배당" } });
    expect(cache()!.groups.map((g) => [g.id, g.name, g.position])).toEqual([
      [1, "반도체", 0],
      [5, "배당", 1],
    ]);
    expect(cache()).not.toHaveProperty("created");
    // 이어서 만든 그룹 맨 끝(0번째)으로 옮기면 캐시도 그 그룹에 (예전: 모르는 그룹 → 그룹 없음 0번째)
    seen.value.ops.move({ code: "B", name: "나" }, 5, 0, "나를 배당 그룹 맨 끝으로 옮겼습니다");
    expect(cache()!.items.find((i) => i.code === "B")).toEqual({ code: "B", groupId: 5, position: 0 });
    // 옮긴 D 는 낙관적 값 그대로 (만들기 응답이 덮지 않음)
    expect(cache()!.items.find((i) => i.code === "D")).toEqual({ code: "D", groupId: 1, position: 0 });
  });

  it("저장 차례 (순수): 실패가 섞이면 줄이 빌 때 한 번 다시 받는다", async () => {
    const applied: Layout[] = [];
    const deps = { apply: (l: Layout) => void applied.push(l), refetch: vi.fn(), fail: vi.fn() };
    const q = new WatchOpQueue(deps);
    const a = q.run(async () => LAYOUT);
    const b = q.run(async () => {
      throw new Error("실패 글");
    });
    const c = q.run(async () => LAYOUT, { quiet: true });
    expect(q.size).toBe(3);
    await a;
    await b.catch(() => undefined);
    await c;
    expect(deps.fail).toHaveBeenCalledWith("실패 글");
    expect(deps.refetch).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([]);
    await q.run(async () => LAYOUT);
    expect(applied).toEqual([LAYOUT]);
  });
});

describe("조작 중에 받은 서버 배치 (3-34 3차 검토 — 낙관적 화면을 덮지 않기)", () => {
  const moved: Layout = { ...LAYOUT, items: [{ code: "A", groupId: 1, position: 1 }, { code: "B", groupId: 1, position: 0 }] };

  it("저장 차례에 조작이 남은 동안 끝난 GET(잔고 목록이 바뀌어 다시 받기)은 캐시를 덮지 않고, 줄이 비면 마지막 조작 응답을 쓴 뒤 한 번 다시 받아 맞춘다", async () => {
    const seen = mount();
    await settle();
    const reply = deferred<Layout>();
    h.api.moveWatchStock!.mockImplementationOnce(() => reply.promise);
    seen.value.ops.move({ code: "B", name: "나" }, 1, 0);
    const optimistic = cache()!;
    expect(optimistic.items.find((i) => i.code === "B")).toEqual({ code: "B", groupId: 1, position: 0 });
    // 조작 응답 전에 GET 이 나감 (새 종목 E 가 생겨 다시 받기) — 서버는 아직 옛 배치(B 가 2번째)를 준다
    const stale = deferred<Layout>();
    h.api.watchGroups!.mockImplementationOnce(() => stale.promise);
    client.setQueryData(["http://x", "stocks"], [...LIST, w("E", "마", 9)]);
    await settle();
    expect(h.api.watchGroups).toHaveBeenCalledTimes(2);
    stale.resolve(LAYOUT);
    await settle();
    expect(cache()).toEqual(optimistic);
    expect(seen.value.layout.items.find((i) => i.code === "B")).toEqual({ code: "B", groupId: 1, position: 0 });
    // 조작 응답 → 줄이 빔 → 그 응답을 쓰고, 덮지 않은 GET 이 있었으니 한 번 다시 받는다
    h.api.watchGroups!.mockResolvedValue(moved);
    reply.resolve(moved);
    await settle();
    expect(h.api.watchGroups).toHaveBeenCalledTimes(3);
    expect(cache()).toEqual(moved);
  });

  it("조작 중에 나간 GET 이 조작 응답보다 늦게 와도(줄이 이미 빔) 옛 값으로 되돌리지 않는다 — 조작 응답이 그 GET 보다 새것", async () => {
    const seen = mount();
    await settle();
    const reply = deferred<Layout>();
    h.api.moveWatchStock!.mockImplementationOnce(() => reply.promise);
    seen.value.ops.move({ code: "B", name: "나" }, 1, 0);
    const stale = deferred<Layout>();
    h.api.watchGroups!.mockImplementationOnce(() => stale.promise);
    // 앱으로 돌아옴 · 당겨서 새로고침 등으로 다시 받기
    void client.invalidateQueries({ queryKey: ["http://x", "watchGroups"] });
    await settle();
    reply.resolve(moved);
    await settle();
    expect(cache()).toEqual(moved);
    stale.resolve(LAYOUT);
    await settle();
    expect(cache()).toEqual(moved);
    expect(seen.value.layout).toEqual(moved);
    // 조작이 없을 때 받은 값은 그대로 쓴다 (다른 기기에서 바꾼 것)
    const other: Layout = { ...LAYOUT, groups: [...LAYOUT.groups, { id: 2, name: "배당", position: 1 }] };
    h.api.watchGroups!.mockResolvedValueOnce(other);
    seen.value.refetch();
    await settle();
    expect(cache()).toEqual(other);
  });

  it("실패 뒤 다시 시도(retry)한 GET 도 같다: 조작이 남아 있으면 덮지 않는다", async () => {
    const seen = mount();
    await settle();
    const reply = deferred<Layout>();
    h.api.moveWatchStock!.mockImplementationOnce(() => reply.promise);
    seen.value.ops.move({ code: "B", name: "나" }, 1, 0);
    const optimistic = cache()!;
    h.api.watchGroups!.mockRejectedValueOnce(new ApiRequestError(500, "INTERNAL", "서버 오류")).mockResolvedValueOnce(LAYOUT);
    void client.invalidateQueries({ queryKey: ["http://x", "watchGroups"] });
    await vi.waitFor(() => expect(h.api.watchGroups).toHaveBeenCalledTimes(3), { timeout: 4000, interval: 50 });
    await settle();
    expect(cache()).toEqual(optimistic);
    h.api.watchGroups!.mockResolvedValue(moved);
    reply.resolve(moved);
    await settle();
    expect(cache()).toEqual(moved);
    expect(h.api.watchGroups).toHaveBeenCalledTimes(4);
  });

  it("저장 차례 (순수): 보낸 뒤 조작이 없었던 조회만 새것, 줄에 조작이 있을 때 온 조회는 줄이 빌 때 한 번 다시 받기", async () => {
    const applied: Layout[] = [];
    const deps = { apply: (l: Layout) => void applied.push(l), refetch: vi.fn(), fail: vi.fn() };
    const q = new WatchOpQueue(deps);
    const quiet = q.stamp();
    expect(q.fresh(quiet)).toBe(true);
    const before = q.stamp();
    const d = deferred<Layout>();
    const run = q.run(() => d.promise);
    expect(q.fresh(before)).toBe(false);
    expect(q.fresh(q.stamp())).toBe(false);
    d.resolve(LAYOUT);
    await run;
    expect(applied).toEqual([LAYOUT]);
    expect(deps.refetch).toHaveBeenCalledTimes(1);
    // 줄이 빈 뒤: 조작 전에 보낸 조회는 옛것(다시 받기는 적지 않음), 지금 보낸 조회는 새것
    expect(q.fresh(before)).toBe(false);
    expect(q.fresh(q.stamp())).toBe(true);
    await q.run(async () => LAYOUT);
    expect(deps.refetch).toHaveBeenCalledTimes(1);
    // 조작이 줄에 있는 동안 보낸 조회는 줄이 빈 뒤에 돌아와도 옛것 (서버가 그 조작보다 먼저 읽었을 수 있다)
    const d2 = deferred<Layout>();
    const run2 = q.run(() => d2.promise);
    const sentBusy = q.stamp();
    expect(sentBusy).toBe(-1);
    d2.resolve(LAYOUT);
    await run2;
    expect(q.fresh(sentBusy)).toBe(false);
    expect(deps.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("잔고 목록의 종목이 바뀌면 (관심 해제 → 다시 추가 — 3-34 검토 must)", () => {
  const model = (seen: { value: State }, list: RegisteredWithQuote[]) =>
    watchModel(list, seen.value.layout, seen.value.view, true).buckets.map((b) => [b.name, ...b.stocks.map((s) => s.code)]);

  it("관심 해제하면 캐시 배치에서 바로 빼고 서버 배치를 다시 받는다 → 다시 추가하면 '그룹 없음' 맨 끝 (예전 그룹·자리로 되살아나지 않음)", async () => {
    const seen = mount();
    await settle();
    expect(model(seen, LIST)).toEqual([
      ["반도체", "A", "B"],
      ["그룹 없음", "C", "D"],
    ]);
    // 서버: A 행이 지워짐 (B 는 반도체 자리 1 그대로)
    const afterRemove: Layout = { ...LAYOUT, items: [{ code: "B", groupId: 1, position: 1 }] };
    h.api.watchGroups!.mockResolvedValue(afterRemove);
    const without = LIST.filter((s) => s.code !== "A");
    client.setQueryData(["http://x", "stocks"], without);
    await settle();
    expect(cache()!.items.map((i) => i.code)).toEqual(["B"]);
    expect(h.api.watchGroups).toHaveBeenCalledTimes(2);
    // 같은 코드를 다시 추가: 서버는 새 행(그룹 없음 · 자리 없음) → 그룹 없음 맨 끝
    const again = [...without, w("A", "가", 30)];
    client.setQueryData(["http://x", "stocks"], again);
    await settle();
    expect(h.api.watchGroups).toHaveBeenCalledTimes(3);
    expect(model(seen, again)).toEqual([
      ["반도체", "B"],
      ["그룹 없음", "C", "D", "A"],
    ]);
  });

  it("지우고 다시 추가한 것이 한 번의 목록 갱신에 섞여도(같은 코드 · 새 등록 시각) 서버 응답 전에 바로 '그룹 없음' 맨 끝 — 그 그룹 ↑ 번호가 서버와 맞는다", async () => {
    // 캐시: 반도체 [S, K, H] · 서버: S 는 다시 등록돼 그룹 없음, 반도체 [K, H]
    const list = [w("S", "에스", 1), w("K", "케이", 2), w("H", "에이치", 3)];
    const three: Layout = {
      on: true,
      groups: [{ id: 1, name: "반도체", position: 0 }],
      items: [
        { code: "H", groupId: 1, position: 2 },
        { code: "K", groupId: 1, position: 1 },
        { code: "S", groupId: 1, position: 0 },
      ],
    };
    h.api.watchGroups!.mockResolvedValue(three);
    client.setQueryData(["http://x", "stocks"], list);
    const seen = mount();
    await settle();
    expect(model(seen, list)).toEqual([["반도체", "S", "K", "H"], ["그룹 없음"]]);
    const server = deferred<Layout>();
    h.api.watchGroups!.mockImplementation(() => server.promise);
    const readded = [w("K", "케이", 2), w("H", "에이치", 3), w("S", "에스", 40)];
    client.setQueryData(["http://x", "stocks"], readded);
    await settle();
    // 서버 응답 전: 캐시에서 S 를 이미 뺐다
    expect(model(seen, readded)).toEqual([
      ["반도체", "K", "H"],
      ["그룹 없음", "S"],
    ]);
    const serverNow: Layout = { ...three, items: [three.items[0]!, three.items[1]!] };
    server.resolve(serverNow);
    await settle();
    expect(cache()).toEqual(serverNow);
    // H 를 ↑ (반도체 1번째 → 0번째): 앱과 서버가 같은 번호로 계산
    const m = watchModel(readded, seen.value.layout, seen.value.view, true);
    expect(m.pos.get("H")).toEqual({ groupId: 1, groupName: "반도체", index: 1, count: 2 });
    h.api.moveWatchStock!.mockResolvedValueOnce({ ...three, items: [{ code: "H", groupId: 1, position: 0 }, { code: "K", groupId: 1, position: 1 }] });
    seen.value.ops.move({ code: "H", name: "에이치" }, 1, 0);
    // 누르는 즉시 (낙관적): H 0 · K 1 — 서버가 계산할 값과 같다
    expect(cache()!.items).toEqual([
      { code: "H", groupId: 1, position: 0 },
      { code: "K", groupId: 1, position: 1 },
    ]);
    await settle();
    expect(h.api.moveWatchStock).toHaveBeenCalledWith({ code: "H", groupId: 1, index: 0 });
    expect(model(seen, readded)).toEqual([
      ["반도체", "H", "K"],
      ["그룹 없음", "S"],
    ]);
  });

  it("시세만 바뀐 목록(같은 종목 · 같은 등록 시각)은 다시 받지 않는다, 새 종목만 생기면 빼지 않고 다시 받는다, 꺼져 있으면 아무것도 안 한다", async () => {
    const seen = mount();
    await settle();
    client.setQueryData(["http://x", "stocks"], LIST.map((s) => ({ ...s, quote: quote(s.code, 200) })));
    await settle();
    expect(h.api.watchGroups).toHaveBeenCalledTimes(1);
    client.setQueryData(["http://x", "stocks"], [...LIST, w("E", "마", 9)]);
    await settle();
    expect(h.api.watchGroups).toHaveBeenCalledTimes(2);
    expect(seen.value.layout).toEqual(LAYOUT);
    cleanupRenders();
    client.clear();
    h.flags = {};
    client.setQueryData(["http://x", "stocks"], LIST);
    mount();
    await settle();
    client.setQueryData(["http://x", "stocks"], LIST.slice(1));
    await settle();
    expect(h.api.watchGroups).toHaveBeenCalledTimes(2);
    expect(cache()).toBeUndefined();
  });
});

describe("기기 보기 상태 정리를 저장 (3-34 검토)", () => {
  it("서버 배치를 받은 뒤 정리한 값이 저장값과 다르면 한 번 다시 저장 — 그룹 0개인데 '그룹 없음' → '전체', 지운 그룹 칩 → '전체'", async () => {
    h.view = { selected: "none", collapsed: ["none"] };
    h.api.watchGroups!.mockResolvedValue({ on: true, groups: [], items: [] });
    const seen = mount();
    await settle();
    expect(seen.value.view).toEqual({ selected: "all", collapsed: ["none"] });
    expect(h.setView).toHaveBeenCalledTimes(1);
    expect(h.setView).toHaveBeenCalledWith({ selected: "all", collapsed: ["none"] });
  });

  it("정리할 것이 없으면 저장하지 않는다, 기기 캐시의 옛 배치만 있고 아직 받지 못했으면(오프라인) 저장하지 않는다", async () => {
    h.view = { selected: 1, collapsed: [] };
    mount();
    await settle();
    expect(h.setView).not.toHaveBeenCalled();
    cleanupRenders();
    client.clear();
    // 기기 캐시에 옛 배치(그룹 1 없음)만 있고 서버는 응답하지 않음
    client.setQueryData(["http://x", "stocks"], LIST);
    client.setQueryData(["http://x", "watchGroups"], { on: true, groups: [], items: [] }, { updatedAt: Date.now() - 120_000 });
    h.api.watchGroups!.mockImplementation(() => new Promise(() => undefined));
    const seen = mount();
    await settle();
    expect(seen.value.view.selected).toBe("all");
    expect(h.setView).not.toHaveBeenCalled();
  });

  it("받기가 실패하면(한 번 더 해 봐도) 기기 캐시의 옛 배치로 정리한 값을 저장하지 않는다 — 이번 실행에서 서버 배치를 받은 뒤에만 (3-34 3차 검토)", async () => {
    // 기기 캐시: 옛 배치(그룹 1 없음) · 저장값: 그룹 1 칩과 그 접힘 (다른 기기에서 만든 그룹일 수 있다)
    h.view = { selected: 1, collapsed: [1] };
    client.setQueryData(["http://x", "watchGroups"], { on: true, groups: [], items: [] }, { updatedAt: Date.now() - 120_000 });
    h.api.watchGroups!.mockRejectedValue(new ApiRequestError(0, "NETWORK", "서버에 연결할 수 없습니다: http://x"));
    const seen = mount();
    await vi.waitFor(() => expect(h.api.watchGroups).toHaveBeenCalledTimes(2), { timeout: 4000, interval: 50 });
    await settle();
    // 그리기에는 정리한 값('전체'), 저장값은 그대로
    expect(seen.value.view).toEqual({ selected: "all", collapsed: [] });
    expect(h.setView).not.toHaveBeenCalled();
    // 연결되어 서버 배치를 받으면(그룹 1 이 정말 없음) 그때 한 번 저장
    h.api.watchGroups!.mockResolvedValue({ on: true, groups: [], items: [] });
    seen.value.refetch();
    await settle();
    expect(h.setView).toHaveBeenCalledTimes(1);
    expect(h.setView).toHaveBeenCalledWith({ selected: "all", collapsed: [] });
  });
});

describe("종목 상세 ‹ › 순서 (holdingsOrder)", () => {
  it("켜져 있으면 관심은 잔고에 보이는 순서 — 고른 칩 · 접은 그룹 건너뜀, 꺼져 있으면 지금 그대로", () => {
    const list = [{ ...holding("H", quote("H", 1), 3, 1, undefined, "보유"), createdAt: at(0) }, ...LIST];
    expect(holdingsOrder(list, "created", false).watch.map((s) => s.code)).toEqual(["A", "B", "C", "D"]);
    const moved: Layout = { ...LAYOUT, items: [{ code: "A", groupId: 1, position: 1 }, { code: "B", groupId: 1, position: 0 }] };
    expect(holdingsOrder(list, "created", false, { layout: moved, view: { selected: "all", collapsed: [] } }).watch.map((s) => s.code)).toEqual(["B", "A", "C", "D"]);
    expect(holdingsOrder(list, "created", false, { layout: moved, view: { selected: "all", collapsed: [1] } }).watch.map((s) => s.code)).toEqual(["C", "D"]);
    expect(holdingsOrder(list, "created", false, { layout: moved, view: { selected: "none", collapsed: [] } }).watch.map((s) => s.code)).toEqual(["C", "D"]);
    expect(holdingsOrder(list, "created", false, { layout: moved, view: { selected: "all", collapsed: [] } }).held.map((s) => s.code)).toEqual(["H"]);
  });

  it("같은 등록 시각(토스 가져오기 한 번)은 켜도 끈 순서 그대로 — 자리를 정하지 않았으면 서버 목록 차례, 코드 순이 아님 (3-34 3차 검토)", () => {
    const batch = ["ZZZ", "005930", "AAPL", "MSFT"].map((c) => w(c, c, 30));
    const off = holdingsOrder(batch, "created", false).watch.map((s) => s.code);
    expect(off).toEqual(["ZZZ", "005930", "AAPL", "MSFT"]);
    for (const layout of [{ on: true, groups: [], items: [] }, LAYOUT] as Layout[])
      expect(holdingsOrder(batch, "created", false, { layout, view: { selected: "all", collapsed: [] } }).watch.map((s) => s.code)).toEqual(off);
  });
});
