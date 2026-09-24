import { describe, expect, it, vi } from "vitest";
import type { RecentStock } from "@/lib/recentSearch";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("react-native", () => ({ Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

describe("검색 (3-18)", () => {
  it("최근 검색: 맨 앞에, 같은 종목은 한 번만, 10개까지", async () => {
    const { pushRecent } = await import("@/lib/recentSearch");
    let list: RecentStock[] = Array.from({ length: 10 }, (_, i) => ({ code: String(i), name: `종목${i}`, market: "KOSPI" as const }));
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
    expect(pickSearch("삼성", full("old", true), local("oldL", true))).toMatchObject({ previous: true }); // 흐리게
    expect(pickSearch("삼성", full("old", true), local("L"))).toMatchObject({ previous: false });
    expect(pickSearch("삼성", full(undefined, false, true), local(undefined))).toMatchObject({ isError: true });
    // 토스 검색 실패 + 마스터 결과 있음 → 마스터 결과를 끝난 결과로, 실패는 error 로
    const r = pickSearch("삼성", full(undefined, false, true), local("L"));
    expect(r).toMatchObject({ data: "L", pending: false, isError: false });
    expect(r.error).toBeInstanceOf(Error);
    // 토스 실패, 마스터는 아직(이전 결과) → 기다린다
    expect(pickSearch("삼성", full(undefined, false, true), local("oldL", true))).toMatchObject({ data: "oldL", pending: true, previous: true });
    expect(pickSearch("삼성", full(undefined, false, true), { data: "oldL", isPlaceholderData: true, isError: true })).toMatchObject({ isError: true });
    expect(pickSearch("", full("F"), local("L"))).toMatchObject({ data: undefined, pending: false });
  });
});

describe("알림 설정 미리 반영 (3-19 리뷰)", () => {
  it("mute 는 목록에 더하고 빼며 다른 값은 그대로", async () => {
    const { applySettingsPatch } = await import("@/api/hooks");
    const old = { morningTime: "08:30", afternoonTime: "16:00", morningEnabled: true, afternoonEnabled: true, weekdaysOnly: true, pushEnabled: true, mutedCodes: ["A"], schedule: null };
    expect(applySettingsPatch(old, { mute: { code: "B", muted: true } }).mutedCodes).toEqual(["A", "B"]);
    expect(applySettingsPatch(old, { mute: { code: "A", muted: false } }).mutedCodes).toEqual([]);
    expect(applySettingsPatch(old, { quietEnabled: false })).toMatchObject({ quietEnabled: false, mutedCodes: ["A"] });
  });
});
