import { describe, expect, it } from "vitest";
import { avgText, draftOf, editDraft, holdingPatch, normNum, normText, rebaseDraft } from "@/lib/holdingForm";

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

describe("입력 초안과 서버 값 갱신 (PF-07)", () => {
  it("서버 값이 그대로면 같은 초안 (다시 그리지 않음)", () => {
    const d = editDraft(draftOf("메모"), "쓰는 중");
    expect(rebaseDraft(d, "메모")).toBe(d);
  });
  it("손대지 않은 칸은 새 서버 값을 따른다", () => {
    expect(rebaseDraft(draftOf("10"), "11")).toEqual({ base: "11", value: "11", stale: false });
  });
  it("고치던 칸은 남기고, 서버 값이 바뀐 것을 표시한다", () => {
    const d = rebaseDraft(editDraft(draftOf("10"), "12"), "11");
    expect(d).toEqual({ base: "11", value: "12", stale: true });
    // 새 서버 값과 같게 고치거나, 입력이 새 서버 값과 같아지면 안내를 거둔다
    expect(editDraft(d, "11").stale).toBe(false);
    expect(rebaseDraft(editDraft(draftOf("10"), "11"), "11")).toEqual(draftOf("11"));
  });
  it("저장한 값을 다시 받으면 쉼표·앞뒤 공백 차이로 안내하지 않는다", () => {
    expect(rebaseDraft(editDraft(draftOf("1300000"), "1,350,000"), "1350000", normNum)).toEqual(draftOf("1350000"));
    expect(rebaseDraft(editDraft(draftOf("메모"), "새 메모 "), "새 메모", normText)).toEqual(draftOf("새 메모"));
    // 비교 모양이 같아도 다른 값이면 여전히 고치던 칸
    expect(rebaseDraft(editDraft(draftOf("10"), "12"), "11", normNum)).toEqual({ base: "11", value: "12", stale: true });
  });
});
