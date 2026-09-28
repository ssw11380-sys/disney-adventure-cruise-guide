import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));
vi.mock("expo-notifications", () => ({ setNotificationHandler: () => undefined }));
vi.mock("expo-device", () => ({ isDevice: true, modelName: "test" }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));

const { isInputScreen, memberNotificationNav, notificationNav, routeForNotification } = await import("@/lib/notifications");

/**
 * 브리핑 3차 1 — 알림 뒤로 가기 (플래그 notifBack): 알림을 누르면 어디로, 어떻게 가는지 (순수 함수 표).
 *  - 끔·모름 → 지금 그대로(legacy: routeForNotification 경로를 openNotificationPath 로)
 *  - 켬 · 폰·접은 화면·카드 격자 → 브리핑 탭으로 바꾼 뒤 상세를 쌓는다 ('뒤로' = 브리핑 탭). 묶음은 탭만
 *  - 켬 · 펼친 가로 2단 → 새 화면을 쌓지 않고 오른쪽 칸에서 고른다 (묶음은 시장 요약 — 알림 첫 줄)
 *  - 가격 알림·입력 중 화면(잔고 수정·종목 검색·이동평균선·첫 실행 안내) 위 → 지금 그대로
 */

/** 알림 4종 (서버 notifications/digest.ts · 앱 lib/briefingDigest.ts 의 data 모양) */
const N = {
  account: { type: "briefing", digest: true, session: "morning", date: "2026-09-28", count: 17, accountBriefingId: 5, briefingId: 42, code: "NVDA", marketSummaryId: 900 },
  digest: { type: "briefing", digest: true, session: "morning", date: "2026-09-28", count: 17, briefingId: 42, code: "NVDA", marketSummaryId: 900 },
  stock: { type: "briefing", briefingId: 42, code: "NVDA", session: "morning", date: "2026-09-28" },
  price: { type: "priceAlert", code: "005930" },
} as const;
/** 창 3종: 폰(접은 화면) · 펼친 세로 카드 격자(2단 아님) · 펼친 가로 2단 */
const W = { phone: false, grid: false, pane: true } as const;
/** 지금 화면 4종: 탭 안 · 종목 상세(쌓인 화면) · 같은 계좌 브리핑 · 입력 중 모달 */
const P = { tab: "/", stacked: "/stocks/005930", sameAccount: "/briefings/account/5", input: "/stocks/005930/edit" } as const;

type Kind = keyof typeof N;
type Win = keyof typeof W;
type Where = keyof typeof P;

/** 기대값: 켬일 때 */
function expected(n: Kind, w: Win, p: Where) {
  const legacy = { kind: "legacy", path: routeForNotification(N[n] as Record<string, unknown>) };
  if (n === "price" || p === "input") return legacy;
  if (W[w]) {
    if (n === "account") return { kind: "pane", pick: { kind: "account", id: 5 } };
    if (n === "stock") return { kind: "pane", pick: { kind: "stock", id: 42, code: "NVDA" } };
    return { kind: "pane", pick: { kind: "market", id: 900 } };
  }
  if (n === "account") return { kind: "tabThenPush", path: "/briefings/account/5" };
  if (n === "stock") return { kind: "tabThenPush", path: "/briefings/42" };
  return { kind: "tab" };
}

describe("notificationNav 표 (알림 4종 × 창 3종 × 지금 화면 4종)", () => {
  for (const n of Object.keys(N) as Kind[])
    for (const w of Object.keys(W) as Win[])
      for (const p of Object.keys(P) as Where[]) {
        const data = N[n] as Record<string, unknown>;
        it(`켬 · ${n} · ${w} · ${p}`, () => {
          expect(notificationNav(data, { back: true, twoPane: W[w], path: P[p] })).toEqual(expected(n, w, p));
        });
        it(`끔 · ${n} · ${w} · ${p} → 지금 그대로`, () => {
          expect(notificationNav(data, { back: false, twoPane: W[w], path: P[p] })).toEqual({ kind: "legacy", path: routeForNotification(data) });
        });
      }
});

describe("notificationNav 가장자리", () => {
  it("이동할 곳이 없는 알림은 null (지금처럼 아무것도 하지 않음)", () => {
    expect(notificationNav(undefined, { back: true, twoPane: false, path: "/" })).toBeNull();
    expect(notificationNav({ type: "briefing" }, { back: true, twoPane: true, path: "/" })).toBeNull();
    expect(notificationNav({ type: "other" }, { back: true, twoPane: false, path: "/" })).toBeNull();
  });

  it("2단 묶음 알림에 시장 요약이 없으면 탭만 (오른쪽 칸은 지금처럼 첫 미확인)", () => {
    expect(notificationNav({ type: "briefing", digest: true, briefingId: 42 }, { back: true, twoPane: true, path: "/" })).toEqual({ kind: "tab" });
    // 잘못된 요약 id 도 고르지 않는다
    expect(notificationNav({ type: "briefing", digest: true, marketSummaryId: "abc" }, { back: true, twoPane: true, path: "/" })).toEqual({ kind: "tab" });
    expect(notificationNav({ type: "briefing", digest: true, marketSummaryId: "901" }, { back: true, twoPane: true, path: "/" })).toEqual({ kind: "pane", pick: { kind: "market", id: 901 } });
  });

  it("계좌 앞머리 알림은 시장 요약이 있어도 계좌 브리핑을 고른다 (id 는 문자열이어도)", () => {
    expect(notificationNav({ type: "briefing", digest: true, accountBriefingId: "7", marketSummaryId: 900 }, { back: true, twoPane: true, path: "/briefings" })).toEqual({ kind: "pane", pick: { kind: "account", id: 7 } });
    expect(notificationNav({ type: "briefing", digest: true, accountBriefingId: "7" }, { back: true, twoPane: false, path: "/briefings" })).toEqual({ kind: "tabThenPush", path: "/briefings/account/7" });
  });

  it("종목 알림의 코드가 이상하면 코드 없이 고른다 (목록 줄 강조는 받은 브리핑에서 코드를 찾는다)", () => {
    expect(notificationNav({ type: "briefing", briefingId: 42, code: "../x" }, { back: true, twoPane: true, path: "/" })).toEqual({ kind: "pane", pick: { kind: "stock", id: 42 } });
    expect(notificationNav({ type: "briefing", briefingId: "42" }, { back: true, twoPane: true, path: "/" })).toEqual({ kind: "pane", pick: { kind: "stock", id: 42 } });
  });

  it("브리핑 id 가 이상하면 2단에서도 지금처럼 상세 화면(주소가 올바르지 않다는 안내)으로 — 탭 위에 쌓는다", () => {
    expect(notificationNav({ type: "briefing", briefingId: "abc" }, { back: true, twoPane: true, path: "/" })).toEqual({ kind: "tabThenPush", path: "/briefings/abc" });
  });

  it("지금 화면 주소를 모르면(null) 입력 중이 아닌 것으로 본다", () => {
    expect(notificationNav(N.stock as unknown as Record<string, unknown>, { back: true, twoPane: false, path: null })).toEqual({ kind: "tabThenPush", path: "/briefings/42" });
  });
});

describe("isInputScreen: 입력을 잃을 수 있는 화면만", () => {
  it.each([
    ["/stocks/005930/edit", true],
    ["/stocks/AAPL/edit/", true],
    ["/stocks/add", true],
    ["/chart-lines", true],
    ["/welcome", true],
    ["/stocks/005930", false],
    ["/stocks/005930/chart", false],
    ["/briefings/account/5", false],
    ["/briefings", false],
    ["/", false],
    ["/settings", false],
    ["", false],
  ])("%s → %s", (path, want) => {
    expect(isInputScreen(path)).toBe(want);
  });
  it("null → false", () => expect(isInputScreen(null)).toBe(false));
});

describe("pickNotified · holdNotified: 2단에서 알림으로 고른 것은 새 세션을 처음 알아챌 때 한 번 지킨다", () => {
  const A = { kind: "account", id: 13 } as const;
  const S = { kind: "stock", id: 42, code: "NVDA" } as const;

  it("알림으로 고른 것이 없으면(플래그 꺼짐) 늘 false — 2단 규칙이 지금과 같다", async () => {
    const p = await import("@/lib/briefingPick");
    p.forgetPick();
    p.pickBriefing(A, { highlight: true });
    expect(p.holdNotified(A, true, true)).toBe(false);
    expect(p.holdNotified(null, true, true)).toBe(false);
  });

  it("고르면 목록 줄을 강조하고(highlight) 새 세션 + 없음일 때 한 번만 지킨다", async () => {
    const p = await import("@/lib/briefingPick");
    p.forgetPick();
    p.pickNotified(A);
    expect(p.currentPick()).toEqual({ pick: A, highlight: true });
    // 세션이 그대로면 지금 규칙이 이미 지킨다 — 기억은 남긴다
    expect(p.holdNotified(A, true, false)).toBe(false);
    expect(p.holdNotified(A, true, true)).toBe(true);
    expect(p.holdNotified(A, true, true)).toBe(false);
  });

  it("목록이 따라잡으면(없음이 아님) 기억을 지운다", async () => {
    const p = await import("@/lib/briefingPick");
    p.forgetPick();
    p.pickNotified(S);
    expect(p.holdNotified(S, false, false)).toBe(false);
    expect(p.holdNotified(S, true, true)).toBe(false);
  });

  it("다른 것을 고르면(사용자가 누름·저절로 고름) 기억을 지운다 · 같은 것을 강조만 바꾸면 남긴다 · forgetPick 도 지운다", async () => {
    const p = await import("@/lib/briefingPick");
    p.forgetPick();
    p.pickNotified(A);
    p.pickBriefing(A, { highlight: false });
    expect(p.holdNotified(A, true, true)).toBe(true);
    p.pickNotified(A);
    p.pickByUser(S);
    p.pickBriefing(A, { highlight: true });
    expect(p.holdNotified(A, true, true)).toBe(false);
    p.pickNotified(S);
    p.forgetPick();
    expect(p.holdNotified(S, true, true)).toBe(false);
  });
});

describe("계정 A단계: 주인 아닌 계정의 알림 이동 (memberNotificationNav)", () => {
  it("브리핑 알림(계좌·묶음·종목)은 어느 창·화면·플래그에서든 브리핑 탭만 — 상세·2단 고르기 없음. 가격 알림·이동할 곳 없음은 그대로", () => {
    for (const n of Object.keys(N) as Kind[])
      for (const w of Object.keys(W) as Win[])
        for (const p of Object.keys(P) as Where[])
          for (const back of [true, false]) {
            const data = N[n] as Record<string, unknown>;
            const nav = notificationNav(data, { back, twoPane: W[w], path: P[p] });
            const seen = memberNotificationNav(nav, data);
            if (n === "price") expect(seen, `${n}/${w}/${p}/${back}`).toEqual(nav);
            else expect(seen, `${n}/${w}/${p}/${back}`).toEqual({ kind: "tab" });
          }
    expect(memberNotificationNav(null, { type: "briefing" })).toBeNull();
  });
});
