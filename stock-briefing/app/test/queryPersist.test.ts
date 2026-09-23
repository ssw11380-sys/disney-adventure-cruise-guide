import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
const { PERSIST_MAX_AGE_MS, shouldPersist } = await import("@/lib/queryPersist");

describe("켜자마자 보일 캐시: 저장할 쿼리 고르기", () => {
  const url = "https://server.test";
  it("잔고·지수·장 상태만 저장", () => {
    expect(shouldPersist([url, "stocks"], "success")).toBe(true);
    expect(shouldPersist([url, "indices"], "success")).toBe(true);
    expect(shouldPersist([url, "market"], "success")).toBe(true);
  });
  it("분석·뉴스·발견·종목 상세는 저장하지 않음", () => {
    for (const k of ["analysis", "news", "discoverRank", "discoverThemes", "health", "briefings"]) expect(shouldPersist([url, k], "success"), k).toBe(false);
    expect(shouldPersist([url, "stock", "005930"], "success")).toBe(false);
    expect(shouldPersist([url, "stocks", "extra"], "success")).toBe(false);
  });
  it("실패한 쿼리(오류 상태)는 저장하지 않음", () => {
    expect(shouldPersist([url, "stocks"], "error")).toBe(false);
    expect(shouldPersist([url, "stocks"], "pending")).toBe(false);
  });
  it("7일 지난 캐시는 버림 (3일 된 캐시는 쓴다)", () => {
    expect(PERSIST_MAX_AGE_MS).toBe(7 * 86_400_000);
    expect(3 * 86_400_000).toBeLessThan(PERSIST_MAX_AGE_MS);
  });
});
