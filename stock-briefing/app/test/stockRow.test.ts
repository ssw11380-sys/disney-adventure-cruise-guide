import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ StyleSheet: { create: (x: unknown) => x, absoluteFill: {} }, Pressable: () => null, Text: () => null, View: () => null, Animated: { Value: class {}, View: () => null } }));
vi.mock("@/theme", () => ({ useTheme: () => ({}), changeColor: () => "#000", font: {}, space: {}, radius: {}, touch: { min: 44 }, fontCap: { row: 1.4, chrome: 1.5 }, slopFor: () => ({}), useFontScale: () => 1 }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

describe("잔고 줄 다시 그리기 조건 (3-17)", () => {
  it("종목 객체·표시 설정·누름 함수가 같으면 다시 그리지 않는다", async () => {
    const { sameRow } = await import("@/components/StockRow");
    const stock = { code: "005930" } as never;
    const onPress = () => undefined;
    const base = { stock, onPress, showKrw: false, afterCost: true };
    expect(sameRow(base, { ...base })).toBe(true);
    expect(sameRow(base, { ...base, stock: { code: "005930" } as never })).toBe(false); // 체결이 온 줄
    expect(sameRow(base, { ...base, showKrw: true })).toBe(false);
    expect(sameRow(base, { ...base, onPress: () => undefined })).toBe(false);
  });

  it("초록 점(부모가 세션·앱 수신 상태로 정한 값)이 바뀐 줄만 다시 그린다 — 5초마다 시각이 바뀌어도 점이 같으면 그대로", async () => {
    const { sameRow } = await import("@/components/StockRow");
    const base = { stock: { code: "VRT" } as never, onPress: () => undefined, showKrw: false, afterCost: true, live: true };
    expect(sameRow(base, { ...base, live: true })).toBe(true);
    expect(sameRow(base, { ...base, live: false })).toBe(false);
  });
});
