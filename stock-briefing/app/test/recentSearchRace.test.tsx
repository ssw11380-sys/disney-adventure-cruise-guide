import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";
import type { RecentStock } from "@/lib/recentSearch";

const h = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: h.get, setItem: h.set, removeItem: h.remove } }));
const { useRecentSearches } = await import("@/lib/recentSearch");
const old: RecentStock = { code: "OLD", name: "앞서 검색한 종목", market: "NASDAQ" };
const fresh: RecentStock = { code: "NEW", name: "방금 검색한 종목", market: "NASDAQ" };
const last: RecentStock = { code: "LAST", name: "지운 뒤 검색한 종목", market: "NASDAQ" };
function Probe() { return React.createElement("History", useRecentSearches()); }
const draw = () => render(<Probe />);
type Render = ReturnType<typeof draw>;
const api = (r: Render) => r.all().find((n) => n.type === "History")!.props as unknown as ReturnType<typeof useRecentSearches>;
const settle = async (r: Render) => { for (let i = 0; i < 6; i++) { await Promise.resolve(); r.rerender(); } };

/**
 * 실제 React는 pending lane이 있으면 useState updater의 eager 실행을 생략한다.
 * miniRender의 즉시 updater와 별도로, 허용되는 그 배치 순서만 작게 모델링한다.
 * 일반 값/함수형 갱신 모두 render flush 때 순서대로 적용하며 저장소 API는 발행 즉시 기록한다.
 * 실제 Android나 전체 React reconciler를 검증하는 장치는 아니다.
 */
function deferredStateProbe() {
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: Record<string, unknown> | null } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  const actions: (() => void)[] = [];
  const effects: (() => unknown)[] = [];
  let cursor = 0, mounted = false;
  const dispatcher = {
    useState: (initial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (action: unknown) => actions.push(() => {
        slots[i] = typeof action === "function" ? action(slots[i]) : action;
      })];
    },
    useRef: (initial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect: (create: () => unknown) => { if (!mounted) effects.push(create); },
    useCallback: (fn: unknown) => fn,
  };
  const draw = () => {
    cursor = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    try { return useRecentSearches(); } finally { internals.H = previous; }
  };
  let current = draw();
  mounted = true;
  effects.forEach((effect) => effect());
  return {
    get api() { return current; },
    flush() { while (actions.length) actions.shift()!(); current = draw(); },
  };
}
let loaded!: (value: string | null) => void;
beforeEach(() => {
  h.get.mockReset().mockImplementation(() => new Promise<string | null>((resolve) => { loaded = resolve; }));
  h.set.mockReset().mockResolvedValue(undefined);
  h.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanupRenders);

describe("최근 검색 저장소 읽기와 사용자 행동의 순서", () => {
  it("저장소가 늦어도 새 검색을 즉시 보여 주고 기존 이력은 그 뒤에 보존한다", async () => {
    const r = draw();
    r.act(() => api(r).add(fresh));
    expect(api(r).items).toEqual([fresh]);
    loaded(JSON.stringify([old])); await settle(r);
    expect(api(r).items).toEqual([fresh, old]);
    expect(JSON.parse(h.set.mock.calls.at(-1)![1] as string)).toEqual([fresh, old]);
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it("초기 읽기 전에 추가·지우기·다시 검색해도 삭제한 옛 검색은 돌아오지 않는다", async () => {
    const r = draw();
    r.act(() => { api(r).add(fresh); api(r).clear(); api(r).add(last); });
    expect(api(r).items).toEqual([last]);
    loaded(JSON.stringify([old])); await settle(r);
    expect(api(r).items).toEqual([last]);
    expect(JSON.parse(h.set.mock.calls.at(-1)![1] as string)).toEqual([last]);
  });

  it("읽기 완료 후 연속 추가와 지우기는 기존대로 즉시 반영한다", async () => {
    const r = draw(); loaded(JSON.stringify([old])); await settle(r);
    r.act(() => { api(r).add(fresh); api(r).add(last); });
    expect(api(r).items).toEqual([last, fresh, old]);
    r.act(() => api(r).clear());
    expect(api(r).items).toEqual([]);
    expect(h.remove).toHaveBeenCalledWith("search.recent");
  });

  it("React가 추가 updater를 미뤄도 초기 병합 이력이 화면과 저장소에 함께 남는다", async () => {
    let stored: string | null = JSON.stringify([old]);
    h.set.mockImplementation(async (_key: string, value: string) => { stored = value; });
    h.remove.mockImplementation(async () => { stored = null; });
    const r = deferredStateProbe();
    r.api.add(fresh);
    loaded(JSON.stringify([old]));
    await Promise.resolve(); await Promise.resolve();
    r.flush();
    expect(r.api.items).toEqual([fresh, old]);
    expect(JSON.parse(stored!)).toEqual([fresh, old]);
  });

  it("React가 추가 updater를 미뤄도 뒤따른 삭제를 저장소에서 되돌리지 않는다", async () => {
    let stored: string | null = JSON.stringify([old]);
    h.set.mockImplementation(async (_key: string, value: string) => { stored = value; });
    h.remove.mockImplementation(async () => { stored = null; });
    const r = deferredStateProbe();
    loaded(JSON.stringify([old]));
    await Promise.resolve(); await Promise.resolve();
    r.flush();
    r.api.add(fresh);
    r.api.clear();
    r.flush();
    expect(r.api.items).toEqual([]);
    expect(stored).toBeNull();
  });
});
