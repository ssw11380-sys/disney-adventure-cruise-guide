import { describe, expect, it } from "vitest";
import { buildDigest, byMove, DEFAULT_PREFS, inQuietHours, planNotifications, quietWarnings } from "@/lib/briefingDigest";
import { estimateText, orderForTab, runConfirm, sessionSeconds } from "@/lib/briefingRun";

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
    expect(m.data).toMatchObject({ type: "briefing", digest: true, count: 17 });
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

describe("설정 경고 (3-19 리뷰)", () => {
  const warn = (text: string) => ({ text, warn: true });
  it("브리핑 시간이 조용한 시간 안이면 경고", () => {
    const base = { quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", morningTime: "06:30", afternoonTime: "16:00", morningEnabled: true, afternoonEnabled: true };
    expect(quietWarnings(base)).toEqual([warn("오전 브리핑(06:30)이 조용한 시간 안이라 알림이 가지 않습니다")]);
    expect(quietWarnings({ ...base, morningTime: "08:30" })).toEqual([]);
    expect(quietWarnings({ ...base, morningEnabled: false })).toEqual([]);
    expect(quietWarnings({ ...base, quietEnabled: false })).toEqual([]);
  });

  // BH-58: 서버는 세션이 끝난 시각(모든 종목과 계좌 요약을 만든 뒤)으로 조용한 시간을 본다 — 안내도 끝나는 시각 기준의 결과를 말한다
  it("조용한 시간 경계에 걸치면 끝나는 예상 시각(17종목 약 7분 뒤) 기준으로 알림이 가는지·안 가는지를 말한다", () => {
    const base = { quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", morningTime: "06:55", afternoonTime: "21:55", morningEnabled: true, afternoonEnabled: true };
    const w = quietWarnings(base, sessionSeconds(17)); // 18 × 25초 = 7분 30초 → 07:02:30 · 22:02:30 에 끝남
    expect(w).toEqual([
      // 06:55 시작 → 07:02 끝: 서버는 알림을 보낸다 → 가는 쪽으로 안내 (주의 색 아님)
      { text: "오전 브리핑(06:55)은 약 07:02에 다 만들어져, 조용한 시간이 끝난 뒤라 알림이 갑니다 (예상)", warn: false },
      // 21:55 시작 → 22:02 끝: 서버는 알림을 보내지 않는다 → 주의
      warn("오후 브리핑(21:55)은 약 22:02에 다 만들어져, 조용한 시간이라 알림이 가지 않을 수 있습니다"),
    ]);
  });

  it("시작과 끝이 모두 조용한 시간이면 예전처럼 단정하고, 모두 밖이면 경고 없음", () => {
    const base = { quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", morningTime: "06:30", afternoonTime: "16:00", morningEnabled: true, afternoonEnabled: true };
    expect(quietWarnings(base, sessionSeconds(17))).toEqual([warn("오전 브리핑(06:30)이 조용한 시간 안이라 알림이 가지 않습니다")]);
    expect(quietWarnings({ ...base, morningTime: "08:30" }, sessionSeconds(17))).toEqual([]);
    // 자정을 넘겨 끝나도 (23:58 → 00:05, 둘 다 조용한 시간)
    expect(quietWarnings({ ...base, afternoonTime: "23:58", morningEnabled: false }, sessionSeconds(17))).toEqual([warn("오후 브리핑(23:58)이 조용한 시간 안이라 알림이 가지 않습니다")]);
  });

  it("실행 예상 시간: 종목마다 약 25초에 앞뒤 작업(토스 잔고 읽기·계좌 요약) 몫 한 종목을 더한다. 종목 수를 모르면 0 (시작 시각만)", () => {
    expect(sessionSeconds(17)).toBe(18 * 25);
    expect(sessionSeconds(1)).toBe(50);
    expect(sessionSeconds(0)).toBe(0);
  });
});
