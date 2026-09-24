import { describe, expect, it } from "vitest";
import { avgText, holdingPatch } from "@/lib/holdingForm";

describe("보유 수정 칸 (3-10)", () => {
  it("평단은 미국 소수 2자리, 국내 정수", () => {
    expect(avgText(232555.333333, "KRW")).toBe("232555");
    expect(avgText(97.456789, "USD")).toBe("97.46");
    expect(avgText(null, "USD")).toBe("");
  });
  it("바꾼 칸만 보낸다 (메모만 고치면 수량·평단은 보내지 않음)", () => {
    const init = { quantity: "9", avgPrice: "232555" };
    expect(holdingPatch(init, init)).toEqual({});
    expect(holdingPatch(init, { quantity: "10", avgPrice: "232555" })).toEqual({ quantity: 10 });
    expect(holdingPatch(init, { quantity: "9", avgPrice: "" })).toEqual({ avgPrice: null });
    expect(holdingPatch(init, { quantity: "0", avgPrice: "232555" })).toEqual({ error: expect.any(String) });
    expect(holdingPatch(init, { quantity: "1,000", avgPrice: "232555" })).toEqual({ quantity: 1000 });
  });
});
