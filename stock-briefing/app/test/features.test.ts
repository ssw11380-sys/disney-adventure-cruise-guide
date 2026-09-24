import { describe, expect, it } from "vitest";
import { featureOn, gated } from "@/lib/features";
import { PERSIST_KEYS, shouldPersist } from "@/lib/queryPersist";

describe("기능 켜고 끄기 (3-15)", () => {
  it("서버가 켠 기능만 켜짐: 못 받았거나 모르는 기능은 꺼짐", () => {
    const flags = { features: { tossReconcile: true, briefingSources: false }, updatedAt: null };
    expect(featureOn(flags, "tossReconcile")).toBe(true);
    expect(featureOn(flags, "briefingSources")).toBe(false);
    expect(featureOn(flags, "futureThing")).toBe(false);
    expect(featureOn(undefined, "tossReconcile")).toBe(false);
  });

  it("못 받았을 때(첫 실행·예전 서버 404)는 fallback: 이미 나간 기능은 켜진 채로, 서버 값이 있으면 서버 값", () => {
    expect(featureOn(undefined, "briefingSources", true)).toBe(true);
    expect(featureOn({ features: {}, updatedAt: null }, "briefingSources", true)).toBe(true);
    expect(featureOn({ features: { briefingSources: false }, updatedAt: null }, "briefingSources", true)).toBe(false);
  });

  it("꺼진 기능의 데이터는 화면에 넘기지 않는다 (토스 대조 줄·경고가 같은 값 하나로 그려짐)", () => {
    const rec = { last: null, streakOver: 3, week: { n: 1, withinPct: 0 }, alert: true };
    expect(gated(false, rec)).toBeUndefined();
    expect(gated(true, rec)).toBe(rec);
  });

  it("마지막으로 받은 플래그는 기기에 저장해 다음 실행 때 바로 쓴다", () => {
    expect(PERSIST_KEYS.has("features")).toBe(true);
    expect(shouldPersist(["http://x", "features"], { data: { features: {} }, dataUpdatedAt: 1000, error: null }, 2000)).toBe(true);
  });
});
