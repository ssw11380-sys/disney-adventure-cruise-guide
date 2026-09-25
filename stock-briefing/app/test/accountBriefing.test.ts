import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AccountBriefing, RegisteredWithQuote } from "@/api/types";
import { accountCardItem, accountCardSpeech, contributionSpeech, contributionTable } from "@/lib/accountBriefing";
import { buildDigest, DEFAULT_PREFS, digestAccountOf, KR_PREVIOUS_DAY_LINE, planNotifications } from "@/lib/briefingDigest";
import { summarize } from "@/lib/portfolio";

// 알림을 눌렀을 때의 경로(lib/notifications)만 네이티브 모듈을 가짜로
vi.mock("expo-notifications", () => ({ setNotificationHandler: () => undefined }));
vi.mock("expo-device", () => ({ isDevice: true, modelName: "test" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
const { routeForNotification } = await import("@/lib/notifications");

/**
 * 계좌 한 장 브리핑 (3-31) — 앱 쪽.
 *  - 서버가 계산한 총 평가·당일 손익이 앱 잔고 합계(summarize, 비용 차감 기본값)와 같은 기준 (공용 픽스처)
 *  - 기여 표: 상위 + 그 외 = 당일 손익
 *  - 백그라운드(로컬) 알림 문구가 서버 알림과 같고, 세션당 1건 그대로. 플래그를 끄면 예전 문구
 *  - 알림을 누르면 계좌 브리핑 화면, 예전 알림은 예전 경로
 */
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountBriefing.json", import.meta.url), "utf8")) as {
  holdings: RegisteredWithQuote[];
  expected: { totalValue: number; totalCost: number; totalProfit: number; dayPnl: number; usdValue: number; usdDay: number };
};

const briefing = (over: Partial<AccountBriefing> = {}): AccountBriefing => ({
  id: 7,
  date: "2026-09-25",
  session: "morning",
  status: "ok",
  summary: "당일 -2,868,108원 (-1.23%) · 기여 1위 RGTX -1,234,567원\n총 평가금액 123,456,789원",
  detail: "- 설명",
  model: "m",
  template: false,
  createdAt: "2026-09-25T08:40:00+09:00",
  headline: { totalValue: 123_456_789, dayPnl: -2_868_108, dayRate: -1.23, holdings: 17, top: [{ code: "RGTX", name: "RGTX", amount: -1_234_567, changeRate: -8.1 }, { code: "005930", name: "삼성전자", amount: -456_789, changeRate: -1.2 }, { code: "X", name: "셋째", amount: 1, changeRate: 0 }] },
  ...over,
});

describe("플래그 (accountBriefing, 앱 fallback 꺼짐)", () => {
  const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

  it("꺼져 있으면 카드가 없고, 켜져 있어도 목록이 비면(예전 서버 404) 없다", () => {
    expect(accountCardItem(false, [briefing()])).toBeUndefined();
    expect(accountCardItem(true, [])).toBeUndefined();
    expect(accountCardItem(true, undefined)).toBeUndefined();
    expect(accountCardItem(true, [briefing({ id: 9 }), briefing()])?.id).toBe(9);
  });

  it("화면은 플래그 값 하나로: 꺼져 있으면 목록·상세를 요청하지 않는다 (fallback false)", () => {
    const tab = src("app/(tabs)/briefings.tsx");
    expect(tab).toContain('const accountOn = useFeature("accountBriefing", false);');
    expect(tab).toContain("useAccountBriefings(accountOn)");
    expect(tab).toContain("accountCardItem(accountOn, accounts.data)");
    const detail = src("app/briefings/account/[id].tsx");
    expect(detail).toContain('useFeature("accountBriefing", false)');
    expect(detail).toMatch(/useAccountBriefing\(numId \?\? 0, on && numId !== null\)/);
    expect(src("api/hooks.ts")).toMatch(/export function useAccountBriefings\(enabled: boolean\)[\s\S]{0,300}enabled \}\)/);
  });
});

describe("계좌 브리핑 숫자 = 앱 잔고 합계 기준", () => {
  it("공용 픽스처: 앱 summarize(비용 차감 기본값)의 원화 합계가 서버 계좌 브리핑 기대값과 같다", () => {
    const s = summarize(fixture.holdings, true);
    expect(s.krw).not.toBeNull();
    expect(Math.round(s.krw!.value)).toBe(fixture.expected.totalValue);
    expect(Math.round(s.krw!.cost)).toBe(fixture.expected.totalCost);
    expect(Math.round(s.krw!.value - s.krw!.cost)).toBe(fixture.expected.totalProfit);
    expect(Math.round(s.krw!.day)).toBe(fixture.expected.dayPnl);
    expect(Math.round(s.usdInKrw.value)).toBe(fixture.expected.usdValue);
    expect(Math.round(s.usdInKrw.day)).toBe(fixture.expected.usdDay);
  });

  it("기여 표: 상위 종목 + '그 외 N종목' = 당일 손익, 어긋나면 표시", () => {
    const d = { dayPnl: -250_267, contributions: [{ code: "RGTX", name: "리게티 컴퓨팅", currency: "USD" as const, amount: -268_838, changeRate: -8.06, value: 1 }, { code: "005930", name: "삼성전자", currency: "KRW" as const, amount: -12_000, changeRate: -1.65, value: 1 }], others: { count: 3, amount: 30_571 } };
    const t = contributionTable(d);
    expect(t.lines.map((l) => [l.name, l.amount, l.others])).toEqual([["리게티 컴퓨팅", -268_838, false], ["삼성전자", -12_000, false], ["그 외 3종목", 30_571, true]]);
    expect(t.sum).toBe(d.dayPnl);
    expect(t.matches).toBe(true);
    expect(contributionTable({ ...d, others: null }).matches).toBe(false);
    expect(contributionSpeech(t.lines[0]!)).toBe("리게티 컴퓨팅, 기여 268,838원 손실, 8.06% 하락");
    expect(contributionSpeech(t.lines[2]!)).toBe("그 외 3종목, 기여 30,571원 이익");
  });

  it("카드는 한 문장으로 읽힌다", () => {
    expect(accountCardSpeech(briefing())).toBe("내 계좌 브리핑, 9월 25일 (금) 오전, 당일손익 2,868,108원 손실, 1.23% 하락, 총 평가금액 123,456,789원, 기여 1위 RGTX 1,234,567원 손실, 자세히 보기");
    expect(accountCardSpeech(briefing({ status: "failed", headline: null }))).toBe("내 계좌 브리핑, 9월 25일 (금) 오전, 생성 실패, 자세히 보기");
  });
});

describe("알림: 서버와 같은 문구, 세션당 1건 (3-31)", () => {
  const items = [
    { briefingId: 11, code: "RGTX", name: "리게티 컴퓨팅", summary: "요약", changeRate: -8.1 },
    { briefingId: 12, code: "005930", name: "삼성전자", summary: "요약", changeRate: 1.2 },
    { briefingId: 13, code: "000660", name: "SK하이닉스", summary: "요약", changeRate: null },
  ];

  it("서버 buildDigest 와 같은 제목·본문·데이터 (backend/test/accountBriefing.test.ts 와 같은 기대값)", () => {
    const account = { id: 7, dayPnl: -2_868_108, dayRate: -1.23, top: [{ name: "RGTX", amount: -1_234_567 }, { name: "삼성전자", amount: -456_789 }, { name: "셋째", amount: 1 }] };
    const m = buildDigest("morning", "2026-09-25", items, account)!;
    expect(m.title).toBe("오전 계좌 브리핑 · 당일 -2,868,108원 (-1.23%)");
    expect(m.body).toBe("기여 1위 RGTX -1,234,567원 · 2위 삼성전자 -456,789원\n종목 브리핑 3종목 · 변동 상위 리게티 컴퓨팅 -8.10% · 삼성전자 +1.20%");
    expect(m.data).toEqual({ type: "briefing", digest: true, session: "morning", date: "2026-09-25", count: 3, accountBriefingId: 7, briefingId: 11, code: "RGTX" });
    const only = buildDigest("afternoon", "2026-09-25", [], { ...account, dayPnl: 12_000, dayRate: null, top: [{ name: "애플", amount: 12_000 }] })!;
    expect(only).toEqual({ title: "오후 계좌 브리핑 · 당일 +12,000원", body: "기여 1위 애플 +12,000원", data: { type: "briefing", digest: true, session: "afternoon", date: "2026-09-25", count: 0, accountBriefingId: 7 } });
    expect(buildDigest("morning", "2026-09-25", items, null)!.title).toBe("오전 브리핑 3종목");
  });

  it("목록 항목 → 알림 앞머리: 실패했거나 숫자가 없으면 쓰지 않는다", () => {
    expect(digestAccountOf(briefing())).toEqual({ id: 7, dayPnl: -2_868_108, dayRate: -1.23, top: [{ name: "RGTX", amount: -1_234_567 }, { name: "삼성전자", amount: -456_789 }, { name: "셋째", amount: 1 }] });
    expect(digestAccountOf(briefing({ status: "failed" }))).toBeNull();
    expect(digestAccountOf(briefing({ headline: null }))).toBeNull();
    expect(digestAccountOf(undefined)).toBeNull();
  });

  const fresh = [
    ...items.map((i) => ({ ...i, session: "morning" as const, date: "2026-09-25" })),
    { briefingId: 21, code: "AAPL", name: "애플", summary: "요약", changeRate: 0.5, session: "afternoon" as const, date: "2026-09-24" },
  ];
  const now = new Date("2026-09-25T08:45:00+09:00");
  const on = { ...DEFAULT_PREFS, accountBriefing: true };

  it("같은 날짜·세션의 계좌 브리핑이 있으면 그 세션 알림만 계좌 요약이 앞머리 (세션당 1건 그대로)", () => {
    const m = planNotifications(fresh, on, now, [briefing(), briefing({ id: 8, date: "2026-09-23", session: "afternoon" })]);
    expect(m.map((x) => x.title)).toEqual(["오전 계좌 브리핑 · 당일 -2,868,108원 (-1.23%)", "애플 오후 브리핑"]);
    expect(m[0]!.data).toMatchObject({ accountBriefingId: 7, count: 3 });
  });

  it("플래그를 끄면(예전 서버 포함) 계좌 브리핑이 있어도 예전 문구", () => {
    expect(planNotifications(fresh, DEFAULT_PREFS, now, [briefing()]).map((x) => x.title)).toEqual(["오전 브리핑 3종목", "애플 오후 브리핑"]);
    expect(planNotifications(fresh, { ...on, accountBriefing: undefined }, now, [briefing()])[0]!.title).toBe("오전 브리핑 3종목");
  });

  it("모든 종목의 알림을 끈 사용자에게는 계좌 요약도 보내지 않는다(예전처럼 0건, 서버와 같은 규칙). 일부만 끄면 1건, 조용한 시간 0건, 묶음을 끄면 종목마다", () => {
    const muted = { ...on, mutedCodes: ["RGTX", "005930", "000660"] };
    // 등록 종목을 모르면 이 세션의 새 종목 브리핑 종목으로 본다 → 모두 끔
    expect(planNotifications(fresh.slice(0, 3), muted, now, [briefing()])).toEqual([]);
    expect(planNotifications(fresh.slice(0, 3), muted, now, [briefing()], { codes: ["RGTX", "005930", "000660"] })).toEqual([]);
    // 끄지 않은 종목(AAPL)이 있으면 계좌 요약만으로 1건
    const all = ["RGTX", "005930", "000660", "AAPL"];
    const m = planNotifications(fresh.slice(0, 3), muted, now, [briefing()], { codes: all });
    expect(m).toHaveLength(1);
    expect(m[0]!.data).toMatchObject({ accountBriefingId: 7, count: 0 });
    expect(planNotifications(fresh.slice(0, 3), { ...muted, accountBriefing: false }, now, [briefing()], { codes: all })).toEqual([]);
    expect(planNotifications(fresh, on, new Date("2026-09-25T23:00:00+09:00"), [briefing()])).toEqual([]);
    expect(planNotifications(fresh, { ...on, digest: false }, now, [briefing()])).toHaveLength(4);
  });

  it("새 계좌 브리핑만 있는 세션(종목 브리핑이 모두 실패)도 1건 — 서버 푸시와 같게. 이미 알린 것·플래그 꺼짐·모든 종목 끔이면 0건", () => {
    expect(planNotifications([], on, now, [briefing()], { newAccountIds: [7] })).toEqual([
      {
        title: "오전 계좌 브리핑 · 당일 -2,868,108원 (-1.23%)",
        body: "기여 1위 RGTX -1,234,567원 · 2위 삼성전자 -456,789원",
        data: { type: "briefing", digest: true, session: "morning", date: "2026-09-25", count: 0, accountBriefingId: 7 },
      },
    ]);
    expect(planNotifications([], on, now, [briefing()], { newAccountIds: [] })).toEqual([]);
    expect(planNotifications([], { ...on, accountBriefing: false }, now, [briefing()], { newAccountIds: [7] })).toEqual([]);
    expect(planNotifications([], { ...on, mutedCodes: ["A", "B"] }, now, [briefing()], { newAccountIds: [7], codes: ["A", "B"] })).toEqual([]);
    // 같은 세션에 새 종목 브리핑도 있으면 여전히 1건
    expect(planNotifications(fresh.slice(0, 3), on, now, [briefing()], { newAccountIds: [7] })).toHaveLength(1);
  });

  it("한국 휴장: 알림 본문에 국내 등락이 직전 거래일 것임을 한 줄 (서버와 같은 문구), 카드도 읽어 준다", () => {
    const b = briefing({ headline: { ...briefing().headline!, krPreviousDay: true } });
    expect(digestAccountOf(b)).toMatchObject({ krPreviousDay: true });
    const m = planNotifications(fresh.slice(0, 1), on, now, [b])[0]!;
    expect(m.body).toBe(`기여 1위 RGTX -1,234,567원 · 2위 삼성전자 -456,789원\n${KR_PREVIOUS_DAY_LINE}\n종목 브리핑 1종목 · 변동 상위 리게티 컴퓨팅 -8.10%`);
    expect(KR_PREVIOUS_DAY_LINE).toBe("오늘 한국 휴장 · 국내 종목은 직전 거래일 등락");
    expect(accountCardSpeech(b)).toContain("오늘 한국 휴장, 국내 종목은 직전 거래일 등락");
    expect(digestAccountOf(briefing())).not.toHaveProperty("krPreviousDay");
  });
});

describe("알림을 누르면", () => {
  it("계좌 브리핑이 앞머리인 알림은 계좌 브리핑 화면, 묶음은 브리핑 탭, 종목 알림은 그 브리핑", () => {
    expect(routeForNotification({ type: "briefing", digest: true, accountBriefingId: 7, briefingId: 11 })).toBe("/briefings/account/7");
    expect(routeForNotification({ type: "briefing", digest: true, accountBriefingId: "12" })).toBe("/briefings/account/12");
    expect(routeForNotification({ type: "briefing", digest: true, accountBriefingId: "x", briefingId: 11 })).toBe("/briefings");
    expect(routeForNotification({ type: "briefing", digest: true, briefingId: 11 })).toBe("/briefings");
    expect(routeForNotification({ type: "briefing", briefingId: 11 })).toBe("/briefings/11");
  });
});
