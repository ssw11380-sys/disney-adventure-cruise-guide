import { describe, expect, it } from "vitest";
import { canReuse, shouldSkipFetch } from "@/widgets/payload";

const NOW = Date.parse("2026-10-10T13:00:00+09:00");
const market = { label: "휴장", open: false, nextChangeAt: "2026-10-12T09:00:00+09:00" };
describe("위젯 빠른 갱신의 휴장·연속 실행", () => {
  it("장 마감 뒤 Android 실행 기회를 2시간 자체 생략으로 놓치지 않는다", () => {
    const last = { at: NOW - 15 * 60_000, market };
    expect(shouldSkipFetch(last, NOW, true)).toBe(false);
    expect(shouldSkipFetch(last, NOW, false)).toBe(true);
    expect(shouldSkipFetch(last, NOW)).toBe(true);
  });
  it("연속 위젯 크기 변경은 1분까지 재사용하되 휴장이라고 더 연장하지 않는다", () => {
    expect(canReuse({ at: NOW - 59_999, market }, NOW, true)).toBe(true);
    expect(canReuse({ at: NOW - 60_000, market }, NOW, true)).toBe(false);
    expect(canReuse({ at: NOW - 15 * 60_000, market }, NOW, true)).toBe(false);
    expect(canReuse({ at: NOW - 15 * 60_000, market }, NOW, false)).toBe(true);
  });
  it("장중도 동일한 짧은 재사용 한도를 지키고 시계가 역행하면 조회한다", () => {
    expect(canReuse({ at: NOW - 60_000, market: { ...market, open: true } }, NOW, true)).toBe(false);
    expect(canReuse({ at: NOW + 1, market }, NOW, true)).toBe(false);
    expect(canReuse(null, NOW, true)).toBe(false);
  });
});
