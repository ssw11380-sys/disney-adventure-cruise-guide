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
  it("토큰 오류(401)로 실패 중이면 저장하지 않음", () => {
    expect(shouldPersist([url, "stocks"], ok({ error: { status: 401 } }), NOW)).toBe(false);
  });
  it("받은 값이 없거나 7일 넘었으면 저장하지 않음 (3일은 저장)", () => {
    expect(shouldPersist([url, "stocks"], ok({ data: undefined, dataUpdatedAt: 0 }), NOW)).toBe(false);
    expect(shouldPersist([url, "stocks"], ok({ dataUpdatedAt: NOW - PERSIST_MAX_AGE_MS - 1 }), NOW)).toBe(false);
    expect(shouldPersist([url, "stocks"], ok({ dataUpdatedAt: NOW - 3 * 86_400_000 }), NOW)).toBe(true);
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
