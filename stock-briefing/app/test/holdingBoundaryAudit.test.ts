import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "@/api/client";
import { draftOf, editDraft, holdingInput, holdingPatch, normNum, rebaseDraft, tradePatch } from "@/lib/holdingForm";
import { resetSessionForTests } from "@/lib/session";

afterEach(() => { vi.unstubAllGlobals(); resetSessionForTests(); });

describe("보유 입력 추가 검증 — 숫자와 빈 값의 구분", () => {
  it.each(["Infinity", "1e309", "9".repeat(310)])("등록 수량의 유한하지 않은 값 %s는 거절한다", (value) => {
    expect(holdingInput(value, "100")).toHaveProperty("error");
  });
  it.each(["Infinity", "1e309"])("평단의 유한하지 않은 값 %s는 거절한다", (value) => {
    expect(holdingInput("10", value)).toHaveProperty("error");
    expect(holdingPatch({ quantity: "10", avgPrice: "100" }, { quantity: "10", avgPrice: value })).toHaveProperty("error");
  });
  it("수정 양식은 수량을 JSON의 null로 바꾸는 무한값을 요청 전에 막는다", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }));
    const patch = holdingPatch({ quantity: "10", avgPrice: "100" }, { quantity: "1e309", avgPrice: "100" });
    // 편집 화면과 같은 분기: 입력 오류면 전송하지 않는다. 실제 클라이언트의 직렬화까지 실행한다.
    if (!("error" in patch)) await createApi("https://offline.test").updateStock("AAPL", patch);
    expect(bodies).toEqual([]);
  });
  it.each(["-10", "1x0"])("잘못 입력한 %s를 원래 10과 같다고 보아 새 서버 값으로 덮지 않는다", (value) => {
    const draft = editDraft(draftOf("10"), value, normNum);
    expect(rebaseDraft(draft, "11", normNum)).toEqual({ base: "11", value, stale: true });
  });
  it("잘못된 음수 초안을 같은 크기의 양수 서버 갱신으로 바꾸지 않는다", () => {
    const draft = editDraft(draftOf("9"), "-10", normNum);
    expect(rebaseDraft(draft, "10", normNum)).toEqual({ base: "10", value: "-10", stale: true });
  });
  it("쉼표와 소수 표기의 같은 정상 숫자는 새 서버 값을 따른다", () => {
    const draft = editDraft(draftOf("1000"), "1,000.00", normNum);
    expect(rebaseDraft(draft, "1001", normNum)).toEqual(draftOf("1001"));
    expect(holdingInput("0.5", "0.0001234")).toEqual({ quantity: 0.5, avgPrice: 0.0001234, noAvg: false });
  });
  it("의도적으로 비운 칸과 전체 매도는 기존대로 null을 보낸다", () => {
    expect(holdingPatch({ quantity: "10", avgPrice: "100" }, { quantity: "", avgPrice: "" })).toEqual({ quantity: null, avgPrice: null });
    expect(tradePatch({ quantity: 10, avgPrice: 100 }, { quantity: 0, avgPrice: null })).toEqual({ quantity: null, avgPrice: null });
  });
  it("체결 계산의 유한하지 않은 값은 이미 저장 전에 막는다", () => {
    expect(tradePatch({ quantity: 10, avgPrice: 100 }, { quantity: Infinity, avgPrice: 100 })).toHaveProperty("error");
  });
});
