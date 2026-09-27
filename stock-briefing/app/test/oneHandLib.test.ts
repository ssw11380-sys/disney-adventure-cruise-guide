import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 3-24 한 손 조작·빈 화면·첫 실행 안내의 순수 함수: 스와이프 계산 · 햅틱 규칙 · 연결 오류 문구 · 첫 실행 판단 · 지우기 문구 · 설정 열기 주소
 */
const h = vi.hoisted(() => ({ store: new Map<string, string>(), navigate: vi.fn(), failRead: false }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      if (h.failRead) throw new Error("읽기 실패");
      return h.store.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => void h.store.set(k, v),
  },
}));
vi.mock("expo-router", () => ({ router: { navigate: h.navigate } }));

const { swipeActionWidth, swipeOffset, swipeOpenWidth, swipeSettleOpen, swipePanConfig } = await import("@/lib/rowSwipe");
const { haptic, hapticAllowed, hapticCall, installHaptics, setHapticPolicy } = await import("@/lib/haptics");
const { authBanner, connectionKind, connectionText } = await import("@/lib/connectionError");
const { claimFirstRun, FIRST_RUN_KEY, firstRunDecision, forgetFirstRunClaim, markFirstRun, readFirstRun } = await import("@/lib/firstRun");
const { removeConfirm, removeKind, removeLabel, rowA11yActions } = await import("@/lib/rowActions");
const { openServerSettings, serverOpenRequest, serverSettingsParams } = await import("@/lib/settingsLink");
const { ApiRequestError } = await import("@/api/client");
const { oneHand } = await import("@/tokens");
/** 차트 드래그 기준 (components/chart/PriceChart chartPanConfig — test/chartGesture 가 지킨다) */
const chartPanConfig = { activeX: 14, failY: 10 };

beforeEach(() => {
  h.store.clear();
  h.navigate.mockReset();
  h.failRead = false;
  forgetFirstRunClaim();
  installHaptics(null, "android");
  setHapticPolicy({ oneHand: false, user: true });
});

describe("잔고 줄 스와이프 계산", () => {
  it("차트 드래그와 같은 기준: 가로 14dp 에 시작, 그 전에 세로 10dp 면 포기 (세로 스크롤이 이긴다)", () => {
    expect(swipePanConfig).toEqual({ activeX: 14, failY: 10 });
    expect(swipePanConfig.activeX).toBe(chartPanConfig.activeX);
    expect(swipePanConfig.failY).toBe(chartPanConfig.failY);
  });

  it("버튼 폭: 100% 72dp, 큰 글씨는 배율만큼(줄 상한 140% 까지) — 버튼 두 개면 두 배", () => {
    expect(swipeActionWidth(1)).toBe(72);
    expect(swipeActionWidth(0.85)).toBe(72);
    expect(swipeActionWidth(1.3)).toBe(94);
    expect(swipeActionWidth(2)).toBe(101);
    expect(swipeOpenWidth(2, 1)).toBe(144);
  });

  it("끄는 동안 위치: 오른쪽으로는 제자리까지만, 왼쪽으로는 다 열린 곳까지만 (버튼 뒤 빈 곳이 드러나지 않게)", () => {
    const w = 144;
    expect(swipeOffset(30, false, w)).toBe(0);
    expect(swipeOffset(-50, false, w)).toBe(-50);
    expect(swipeOffset(-144, false, w)).toBe(-144);
    expect(swipeOffset(-184, false, w)).toBe(-144);
    expect(swipeOffset(-10_000, false, w)).toBe(-144);
    // 열린 줄에서 시작: 오른쪽으로 밀면 닫히는 쪽
    expect(swipeOffset(0, true, w)).toBe(-144);
    expect(swipeOffset(100, true, w)).toBe(-44);
    expect(swipeOffset(400, true, w)).toBe(0);
  });

  it("놓을 때: 40% 넘게 밀면 열림, 아니면 닫힘. 빠르게 튕기면 방향대로", () => {
    const w = 144;
    expect(swipeSettleOpen(-57, 0, false, w)).toBe(false);
    expect(swipeSettleOpen(-58, 0, false, w)).toBe(true);
    expect(swipeSettleOpen(-20, -oneHand.swipeFlingV, false, w)).toBe(true);
    expect(swipeSettleOpen(-130, oneHand.swipeFlingV, false, w)).toBe(false);
    // 열린 줄: 조금 오른쪽으로 밀었다 놓으면 그대로 열림, 많이 밀면 닫힘
    expect(swipeSettleOpen(40, 0, true, w)).toBe(true);
    expect(swipeSettleOpen(90, 0, true, w)).toBe(false);
    expect(swipeSettleOpen(-50, 0, false, 0)).toBe(false);
  });
});

describe("햅틱: 새 곳은 oneHand 켜짐 + 설정 켬일 때만, 차트 십자선은 플래그가 꺼져 있으면 예전처럼 늘", () => {
  it("허용 규칙", () => {
    for (const k of ["select", "press", "success", "error"] as const) {
      expect(hapticAllowed(k, { oneHand: false, user: true })).toBe(false);
      expect(hapticAllowed(k, { oneHand: true, user: true })).toBe(true);
      expect(hapticAllowed(k, { oneHand: true, user: false })).toBe(false);
    }
    expect(hapticAllowed("chart", { oneHand: false, user: false })).toBe(true);
    expect(hapticAllowed("chart", { oneHand: true, user: true })).toBe(true);
    expect(hapticAllowed("chart", { oneHand: true, user: false })).toBe(false);
  });

  it("안드로이드는 시스템 햅틱(터치 진동 설정을 따름)을 먼저, 없는 기종이면 진동기로. 차트는 예전 selectionAsync 그대로", () => {
    expect(hapticCall("chart", "android")).toEqual({ first: { fn: "selectionAsync" }, fallback: null });
    expect(hapticCall("select", "android")).toEqual({ first: { fn: "performAndroidHapticsAsync", arg: "segment-tick" }, fallback: { fn: "selectionAsync" } });
    expect(hapticCall("press", "android").first).toEqual({ fn: "performAndroidHapticsAsync", arg: "long-press" });
    expect(hapticCall("success", "android")).toEqual({ first: { fn: "performAndroidHapticsAsync", arg: "confirm" }, fallback: { fn: "notificationAsync", arg: "success" } });
    expect(hapticCall("error", "ios")).toEqual({ first: { fn: "notificationAsync", arg: "error" }, fallback: null });
  });

  it("엔진이 없거나(테스트·웹) 허용되지 않으면 부르지 않고, 기종에 없는 종류는 대신 진동기", async () => {
    const calls: string[] = [];
    const engine = {
      selectionAsync: async () => void calls.push("selection"),
      impactAsync: async (s: never) => void calls.push(`impact:${s}`),
      notificationAsync: async (s: never) => void calls.push(`notify:${s}`),
      performAndroidHapticsAsync: async (s: never) => {
        if (s === ("confirm" as never)) throw new Error("이 기종에 없음");
        calls.push(`android:${s}`);
      },
    };
    haptic("select");
    expect(calls).toEqual([]);
    installHaptics(engine, "android");
    haptic("select"); // 플래그 꺼짐
    haptic("chart"); // 예전 그대로 울림
    setHapticPolicy({ oneHand: true, user: true });
    haptic("select");
    haptic("success");
    setHapticPolicy({ oneHand: true, user: false });
    haptic("press");
    haptic("chart");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["selection", "android:segment-tick", "notify:success"]);
  });
});

describe("연결 오류 문구는 설정 칸 이름('서버 연결' · '서버 주소' · 'API 토큰')과 같게", () => {
  it("서버 연결 문제만 고른다 (서버가 준 다른 오류는 그대로)", () => {
    expect(connectionKind(new ApiRequestError(0, "NETWORK", "서버에 연결할 수 없습니다: http://x"))).toBe("network");
    expect(connectionKind(new ApiRequestError(0, "TIMEOUT", "서버 응답이 없습니다 (시간 초과)"))).toBe("timeout");
    expect(connectionKind(new ApiRequestError(401, "UNAUTHORIZED", "API 토큰이 틀리거나 비어 있습니다."))).toBe("auth");
    expect(connectionKind(new ApiRequestError(404, "NOT_FOUND", "없음"))).toBeNull();
    expect(connectionKind(new ApiRequestError(500, "HTTP_500", "서버 오류 (500)"))).toBeNull();
    expect(connectionKind(new Error("x"))).toBeNull();
    expect(connectionKind(null)).toBeNull();
  });

  it("문구: 무엇을 어디서 확인할지 (예전 '설정 > 서버 주소 아래에 토큰' 같은 틀린 칸 이름 없음)", () => {
    expect(connectionText("network")).toEqual({ title: "서버에 연결할 수 없습니다", hint: "인터넷 연결을 확인하세요. 계속되면 설정 > 서버 연결에서 '서버 주소'를 확인하세요." });
    expect(connectionText("timeout").hint).toContain("설정 > 서버 연결에서 '서버 주소'");
    expect(connectionText("auth")).toEqual({ title: "API 토큰이 맞지 않습니다", hint: "설정 > 서버 연결에서 'API 토큰'을 확인하세요." });
    expect(authBanner("14:03:21")).toBe("API 토큰 확인 필요 · 14:03:21 기준");
    for (const k of ["network", "timeout", "auth"] as const) expect(JSON.stringify(connectionText(k))).not.toMatch(/서버 주소 아래/);
  });
});

describe("첫 실행 안내: 새 사용자(등록 종목 0)만 한 번, 기존 사용자는 건너뜀", () => {
  it("판단: 목록을 모르면 기다림, 0개면 보임, 있으면 기존 사용자", () => {
    expect(firstRunDecision(undefined)).toBe("wait");
    expect(firstRunDecision(0)).toBe("show");
    expect(firstRunDecision(17)).toBe("existing");
  });

  it("저장: 본 것·건너뜀을 적고 읽는다. 못 읽으면 본 것으로 (억지로 띄우지 않는다)", async () => {
    expect(await readFirstRun()).toBeNull();
    await markFirstRun("existing");
    expect(h.store.get(FIRST_RUN_KEY)).toBe("existing");
    expect(await readFirstRun()).toBe("existing");
    await markFirstRun("seen");
    expect(await readFirstRun()).toBe("seen");
    h.store.set(FIRST_RUN_KEY, "이상한 값");
    expect(await readFirstRun()).toBeNull();
    h.failRead = true;
    expect(await readFirstRun()).toBe("seen");
  });

  it("이번 실행에서 저절로 띄우는 것은 한 번만", () => {
    expect(claimFirstRun()).toBe(true);
    expect(claimFirstRun()).toBe(false);
  });
});

describe("지우기 문구: 토스 종목은 '동기화 제외', 보유는 '삭제', 관심은 '관심 해제' — 늘 확인 창", () => {
  it("이름과 확인 창", () => {
    const toss = { name: "삼성전자", quantity: 120, tossSynced: true };
    const held = { name: "NAVER", quantity: 15 };
    const watch = { name: "브로드컴", quantity: null };
    expect([removeKind(toss), removeKind(held), removeKind(watch)]).toEqual(["sync", "delete", "unwatch"]);
    expect([removeLabel(toss), removeLabel(held), removeLabel(watch)]).toEqual(["동기화 제외", "삭제", "관심 해제"]);
    expect(removeConfirm(toss).title).toBe("동기화 제외하고 삭제");
    expect(removeConfirm(toss).message).toContain("다시 나타나지 않습니다");
    expect(removeConfirm(toss).confirm).toBe("동기화 제외");
    expect(removeConfirm(held)).toMatchObject({ title: "종목 삭제", confirm: "삭제" });
    expect(removeConfirm(watch)).toMatchObject({ title: "관심 해제", confirm: "관심 해제" });
    for (const s of [toss, held, watch]) expect(removeConfirm(s).message).toContain("지난 브리핑은 남습니다");
  });

  it("화면 읽기 동작: 수정 · 지우기 · 메뉴 열기", () => {
    expect(rowA11yActions({ name: "a", quantity: 1, tossSynced: true })).toEqual([
      { name: "edit", label: "수정" },
      { name: "remove", label: "동기화 제외" },
      { name: "longpress", label: "메뉴 열기" },
    ]);
  });
});

describe("설정 열기: 설정 탭 '서버 연결' 칸 (누를 때마다 새 요청)", () => {
  it("주소와 요청 읽기", () => {
    expect(serverSettingsParams(123)).toEqual({ open: "server", at: "123" });
    openServerSettings();
    expect(h.navigate).toHaveBeenCalledTimes(1);
    const arg = h.navigate.mock.calls[0]![0] as { pathname: string; params: { open: string; at: string } };
    expect(arg.pathname).toBe("/settings");
    expect(arg.params.open).toBe("server");
    expect(serverOpenRequest({ open: "server", at: "5" })).toBe("5");
    expect(serverOpenRequest({ open: ["server"], at: ["6"] })).toBe("6");
    expect(serverOpenRequest({ open: "server" })).toBe("server");
    expect(serverOpenRequest({})).toBeNull();
    expect(serverOpenRequest({ open: "other", at: "1" })).toBeNull();
  });
});
