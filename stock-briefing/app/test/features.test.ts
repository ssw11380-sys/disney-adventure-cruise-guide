import { describe, expect, it } from "vitest";
import { featureOn } from "@/lib/features";
import { PERSIST_KEYS, shouldPersist } from "@/lib/queryPersist";

describe("기능 켜고 끄기 (3-15)", () => {
  it("서버가 켠 기능만 켜짐: 못 받았거나 모르는 기능은 꺼짐", () => {
    const flags = { features: { tossReconcile: true, briefingSources: false }, updatedAt: null };
    expect(featureOn(flags, "tossReconcile")).toBe(true);
    expect(featureOn(flags, "briefingSources")).toBe(false);
    expect(featureOn(flags, "futureThing")).toBe(false);
    expect(featureOn(undefined, "tossReconcile")).toBe(false);
  });

  it("마지막으로 받은 플래그는 기기에 저장해 다음 실행 때 바로 쓴다", () => {
    expect(PERSIST_KEYS.has("features")).toBe(true);
    expect(shouldPersist(["http://x", "features"], { data: { features: {} }, dataUpdatedAt: 1000, error: null }, 2000)).toBe(true);
  });
});
