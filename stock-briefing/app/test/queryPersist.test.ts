import { describe, expect, it, vi } from "vitest";
import type { PersistedClient } from "@tanstack/react-query-persist-client";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
const { PERSIST_MAX_AGE_MS, cleanForDisk, shouldPersist } = await import("@/lib/queryPersist");

const NOW = Date.parse("2026-09-24T10:00:00+09:00");
const url = "https://server.test";
const ok = (over: Partial<{ data: unknown; dataUpdatedAt: number; error: unknown }> = {}) => ({ data: [1], dataUpdatedAt: NOW - 60_000, error: null, ...over });

describe("켜자마자 보일 캐시: 저장할 쿼리 고르기", () => {
  it("잔고·지수만 저장", () => {
    expect(shouldPersist([url, "stocks"], ok(), NOW)).toBe(true);
    expect(shouldPersist([url, "indices"], ok(), NOW)).toBe(true);
  });
  it("장 상태·분석·뉴스·발견·종목 상세는 저장하지 않음 (옛 장 상태가 장중 판단을 좌우하지 않게)", () => {
    for (const k of ["market", "analysis", "news", "discoverRank", "discoverThemes", "health", "briefings"]) expect(shouldPersist([url, k], ok(), NOW), k).toBe(false);
    expect(shouldPersist([url, "stock", "005930"], ok(), NOW)).toBe(false);
  });
  it("새로고침이 실패 중이어도 받은 값은 계속 저장 (다음 오프라인 실행 때 보이게)", () => {
    expect(shouldPersist([url, "stocks"], ok({ error: new Error("Network request failed") }), NOW)).toBe(true);
  });
  it("자동 로그인을 끈 세션(계정 A단계): 잔고(개인)는 기기에 적지 않고 지수·플래그는 그대로 — 앱을 닫으면 잔고도 사라지게", () => {
    const off = (u: string) => u !== url;
    expect(shouldPersist([url, "stocks"], ok(), NOW, off)).toBe(false);
    expect(shouldPersist([url, "indices"], ok(), NOW, off)).toBe(true);
    expect(shouldPersist([url, "features"], ok(), NOW, off)).toBe(true);
    expect(shouldPersist(["https://other.test", "stocks"], ok(), NOW, off)).toBe(true);
  });
  it("토큰 오류(401)로 실패 중이면 저장하지 않음", () => {
    expect(shouldPersist([url, "stocks"], ok({ error: { status: 401 } }), NOW)).toBe(false);
  });
  it("받은 값이 없거나 7일 넘었으면 저장하지 않음 (3일은 저장)", () => {
    expect(shouldPersist([url, "stocks"], ok({ data: undefined, dataUpdatedAt: 0 }), NOW)).toBe(false);
    expect(shouldPersist([url, "stocks"], ok({ dataUpdatedAt: NOW - PERSIST_MAX_AGE_MS - 1 }), NOW)).toBe(false);
    expect(shouldPersist([url, "stocks"], ok({ dataUpdatedAt: NOW - 3 * 86_400_000 }), NOW)).toBe(true);
  });
});

describe("관심 그룹 배치(watchGroups — 3-34)도 저장해 켤 때 바로 칩", () => {
  it("저장 대상이고, 저장 → 새 실행에서 되살리면 같은 배치 (앱과 같은 dehydrate 조건 · 디스크에 적는 모양)", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { persistQueryClientRestore, persistQueryClientSave } = await import("@tanstack/react-query-persist-client");
    const { PERSIST_BUSTER } = await import("@/lib/queryPersist");
    expect(shouldPersist([url, "watchGroups"], ok(), NOW)).toBe(true);
    // 개인 데이터: 자동 로그인을 끈 세션이면 잔고처럼 기기에 적지 않는다 (계정 A단계)
    expect(shouldPersist([url, "watchGroups"], ok(), NOW, (u) => u !== url)).toBe(false);
    const layout = {
      on: true,
      groups: [
        { id: 3, name: "반도체", position: 0 },
        { id: 5, name: "배당", position: 1 },
      ],
      items: [
        { code: "000660", groupId: 3, position: 1 },
        { code: "005930", groupId: 3, position: 0 },
      ],
    };
    // 디스크 대신 글 한 줄 (앱의 persister 와 같이 cleanForDisk → JSON)
    let disk: string | null = null;
    const persister = {
      persistClient: async (c: PersistedClient) => void (disk = JSON.stringify(cleanForDisk(c))),
      restoreClient: async () => (disk ? (JSON.parse(disk) as PersistedClient) : undefined),
      removeClient: async () => void (disk = null),
    };
    const dehydrateOptions = { shouldDehydrateQuery: (q: { queryKey: readonly unknown[]; state: { data: unknown; dataUpdatedAt: number; error: unknown } }) => shouldPersist(q.queryKey, q.state, Date.now()) };
    const before = new QueryClient();
    before.setQueryData([url, "watchGroups"], layout);
    before.setQueryData([url, "market"], { open: true });
    await persistQueryClientSave({ queryClient: before, persister, buster: PERSIST_BUSTER, dehydrateOptions });
    expect(disk).toContain("반도체");
    const after = new QueryClient();
    await persistQueryClientRestore({ queryClient: after, persister, maxAge: PERSIST_MAX_AGE_MS, buster: PERSIST_BUSTER });
    expect(after.getQueryData([url, "watchGroups"])).toEqual(layout);
    // 저장 대상이 아닌 것은 되살리지 않음
    expect(after.getQueryData([url, "market"])).toBeUndefined();
    before.clear();
    after.clear();
  });
});

describe("기기에 적을 때 실패 흔적 지우기", () => {
  it("오류 상태의 옛 값 → 성공 상태의 옛 값 (받은 시각·값은 그대로)", () => {
    const client = {
      timestamp: NOW,
      buster: "v2",
      clientState: {
        mutations: [{ state: {} }],
        queries: [
          {
            queryKey: [url, "stocks"],
            queryHash: "h",
            state: { data: [1], dataUpdatedAt: NOW - 5_000, status: "error", error: { message: "x" }, errorUpdatedAt: NOW, fetchFailureCount: 2, fetchFailureReason: { message: "x" }, fetchStatus: "fetching" },
          },
        ],
      },
    } as unknown as PersistedClient;
    const c = cleanForDisk(client);
    const st = c.clientState.queries[0]!.state as unknown as Record<string, unknown>;
    expect(st).toMatchObject({ data: [1], dataUpdatedAt: NOW - 5_000, status: "success", error: null, fetchFailureCount: 0, fetchFailureReason: null, fetchStatus: "idle" });
    expect(c.clientState.mutations).toEqual([]);
  });
});
