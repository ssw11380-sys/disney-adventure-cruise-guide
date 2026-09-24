import { describe, expect, it } from "vitest";
import { buildDigest, byMove, DEFAULT_PREFS, inQuietHours, planNotifications } from "@/lib/briefingDigest";
import { estimateText, orderForTab, runConfirm } from "@/lib/briefingRun";

const item = (code: string, changeRate: number | null, session: "morning" | "afternoon" = "afternoon", date = "2026-09-24") => ({
  briefingId: Number(code.replace(/\D/g, "")) || 1,
  code,
  name: `이름${code}`,
  summary: `${code} 요약\n둘째 줄`,
  changeRate,
  session,
  date,
});

describe("알림 묶음 (3-19, 서버와 같은 규칙)", () => {
  it("서버와 같은 문구: 17종목 → 1건, 변동 상위 2개", () => {
    const items = Array.from({ length: 17 }, (_, i) => item(`A${i + 1}`, i === 4 ? -6.2 : i === 9 ? 5 : 0.5));
    const m = buildDigest("afternoon", "2026-09-24", items)!;
    expect(m.title).toBe("오후 브리핑 17종목");
    expect(m.body.split("\n")[0]).toBe("변동 상위 이름A5 -6.20% · 이름A10 +5.00%");
    expect(m.data).toMatchObject({ type: "briefingDigest", count: 17 });
  });

  it("세션별로 묶고, 조용한 시간 0건, 끈 종목 제외, 플래그 끄면 종목마다", () => {
    const now = new Date("2026-09-24T16:10:00+09:00");
    const fresh = [item("A1", 1), item("A2", 2), item("A3", 3, "morning")];
    expect(planNotifications(fresh, DEFAULT_PREFS, now).map((m) => m.title)).toEqual(["오후 브리핑 2종목", "이름A3 오전 브리핑"]);
    expect(planNotifications(fresh, DEFAULT_PREFS, new Date("2026-09-24T22:10:00+09:00"))).toEqual([]);
    expect(planNotifications(fresh, { ...DEFAULT_PREFS, mutedCodes: ["A1", "A3"] }, now).map((m) => m.title)).toEqual(["이름A2 오후 브리핑"]);
    expect(planNotifications(fresh, { ...DEFAULT_PREFS, digest: false }, new Date("2026-09-24T23:00:00+09:00"))).toHaveLength(3);
  });

  it("조용한 시간은 기기 시간대와 상관없이 한국 시간", () => {
    // UTC 13:30 = 한국 22:30
    expect(inQuietHours(DEFAULT_PREFS, new Date("2026-09-24T13:30:00Z"))).toBe(true);
    expect(inQuietHours(DEFAULT_PREFS, new Date("2026-09-24T22:30:00Z"))).toBe(false); // 한국 07:30
  });

  it("변동 큰 순: 절댓값, 모르면 뒤, 같으면 원래 순서", () => {
    const list = [{ c: "a", r: 1 }, { c: "b", r: null }, { c: "c", r: -3 }, { c: "d", r: 1 }];
    expect(byMove(list, (x) => x.r).map((x) => x.c)).toEqual(["c", "a", "d", "b"]);
  });
});

describe("브리핑 탭·수동 생성 (3-19)", () => {
  it("확인 창: 17종목 약 7분, 덮어쓴다고 알림. 1종목은 약 30초", () => {
    expect(runConfirm("afternoon", 17)).toEqual({
      title: "오후 브리핑 17종목 새로 만들기",
      message: "17종목, 약 7분 걸리며 오늘 오후 브리핑을 덮어씁니다. 그동안 다른 생성은 할 수 없습니다.",
    });
    expect(estimateText(1)).toBe("약 30초");
  });

  it("탭 순서: 변동 큰 순 + 상위 3, 플래그를 끄면 등록순", () => {
    const items = ["a", "b", "c", "d", "e"].map((code) => ({ code }));
    const rates = new Map<string, number | null>([["a", 0.1], ["b", -4], ["c", null], ["d", 2.5], ["e", -0.3]]);
    const o = orderForTab(items, rates, true);
    expect(o.list.map((i) => i.code)).toEqual(["b", "d", "e", "a", "c"]);
    expect(o.top.map((i) => i.code)).toEqual(["b", "d", "e"]);
    expect(orderForTab(items, rates, false)).toEqual({ list: items, top: [] });
  });
});
