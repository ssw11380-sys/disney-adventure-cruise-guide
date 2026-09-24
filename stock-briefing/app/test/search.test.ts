import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

describe("검색 (3-18)", () => {
  it("최근 검색: 맨 앞에, 같은 종목은 한 번만, 10개까지", async () => {
    const { pushRecent } = await import("@/lib/recentSearch");
    let list = Array.from({ length: 10 }, (_, i) => ({ code: String(i), name: `종목${i}`, market: "KOSPI" as const }));
    list = pushRecent(list, { code: "5", name: "종목5", market: "KOSPI" });
    expect(list.map((x) => x.code)).toEqual(["5", "0", "1", "2", "3", "4", "6", "7", "8", "9"]);
    list = pushRecent(list, { code: "NEW", name: "새", market: "NASDAQ" });
    expect(list).toHaveLength(10);
    expect(list[0]!.code).toBe("NEW");
    expect(list.map((x) => x.code)).not.toContain("9");
  });

  it("보여 줄 결과: 이번 입력의 전체 결과 → 이번 입력의 마스터 결과(바로) → 이전 결과(깜빡임 없이)", async () => {
    const { pickSearch } = await import("@/api/hooks");
    const full = (data: string | undefined, ph = false, err = false) => ({ data, isPlaceholderData: ph, isError: err, error: err ? new Error("x") : null });
    const local = (data: string | undefined, ph = false) => ({ data, isPlaceholderData: ph });
    expect(pickSearch("삼성", full("F"), local("L"))).toMatchObject({ data: "F", pending: false });
    expect(pickSearch("삼성", full("old", true), local("L"))).toMatchObject({ data: "L", pending: true }); // 마스터가 먼저
    expect(pickSearch("삼성", full("old", true), local("oldL", true))).toMatchObject({ data: "old", pending: true }); // 이전 결과 유지
    expect(pickSearch("삼성", full(undefined, false, true), local(undefined))).toMatchObject({ isError: true });
    expect(pickSearch("", full("F"), local("L"))).toMatchObject({ data: undefined, pending: false });
  });
});
