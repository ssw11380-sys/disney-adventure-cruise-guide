import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ StyleSheet: { create: (x: unknown) => x, absoluteFill: {} }, Pressable: () => null, Text: () => null, View: () => null, Animated: { Value: class {}, View: () => null } }));
vi.mock("@/theme", () => ({ useTheme: () => ({}), changeColor: () => "#000", font: {}, space: {} }));

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
});
