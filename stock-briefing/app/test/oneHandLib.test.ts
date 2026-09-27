import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 3-24 한 손 조작·빈 화면·첫 실행 안내의 순수 함수: 스와이프 계산 · 햅틱 규칙 · 연결 오류 문구 · 첫 실행 판단 · 지우기 문구 · 설정 열기 주소
 */
const h = vi.hoisted(() => ({ store: new Map<string, string>(), navigate: vi.fn(), dismissTo: vi.fn(), canDismiss: false, failRead: false }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      if (h.failRead) throw new Error("읽기 실패");
      return h.store.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    multiGet: async (keys: string[]) => {
      if (h.failRead) throw new Error("읽기 실패");
      return keys.map((k) => [k, h.store.get(k) ?? null]);
    },
  },
}));
vi.mock("expo-router", () => ({ router: { navigate: h.navigate, dismissTo: h.dismissTo, canDismiss: () => h.canDismiss } }));

const { swipeActionWidth, swipeActiveRange, swipeOffset, swipeOpenWidth, swipeSettleOpen, swipePanConfig } = await import("@/lib/rowSwipe");
const { haptic, hapticAllowed, hapticCall, installHaptics, setHapticPolicy } = await import("@/lib/haptics");
const { addressBanner, authBanner, connectionKind, connectionText } = await import("@/lib/connectionError");
const { cacheFromEarlierRun, claimFirstRun, FIRST_RUN_KEY, firstRunDecision, forgetFirstRunClaim, hasPriorUse, markFirstRun, priorUseFrom, readFirstRun } = await import("@/lib/firstRun");
const { removeConfirm, removeKind, removeLabel, rowA11yActions } = await import("@/lib/rowActions");
const { openServerSettings, serverOpenRequest, serverSettingsParams } = await import("@/lib/settingsLink");
const { ApiRequestError } = await import("@/api/client");
const { emptyGuideToRemember, UX_OFF, uxFlagsFrom } = await import("@/lib/uxFlags");
const { headTitleMaxWidth } = await import("@/lib/detailLayout");
const { sessionNow } = await import("@/lib/briefingRun");
const { oneHand } = await import("@/tokens");
/** 차트 드래그 기준 (components/chart/PriceChart chartPanConfig — test/chartGesture 가 지킨다) */
const chartPanConfig = { activeX: 14, failY: 10 };

beforeEach(() => {
  h.store.clear();
  h.navigate.mockReset();
  h.dismissTo.mockReset();
  h.canDismiss = false;
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
    expect(connectionKind(new ApiRequestError(404, "NOT_FOUND", "종목을 찾을 수 없습니다: X", "/api/stocks/X"))).toBeNull();
    expect(connectionKind(new ApiRequestError(500, "HTTP_500", "서버 오류 (500)"))).toBeNull();
    // 서버에 닿지만 앱의 서버가 아닌 주소: Railway 하위 주소 오타 'Application not found'·다른 사이트 404 웹 페이지(서버 오류 코드 없음)
    expect(connectionKind(new ApiRequestError(404, "HTTP_404", "Application not found", "/api/stocks?quotes=1"))).toBe("address");
    expect(connectionKind(new ApiRequestError(404, "HTTP_404", "서버 오류 (404)"))).toBe("address");
    // 성공 응답인데 JSON 이 아님 (웹 페이지)
    expect(connectionKind(new ApiRequestError(200, "NOT_JSON", "x", "/api/features"))).toBe("address");
    // 우리 서버의 없는 주소(NOT_FOUND)라도 늘 있는 목록 경로면 주소(경로)가 틀린 것 — 예: 주소 끝에 '/api' 를 더 붙임
    expect(connectionKind(new ApiRequestError(404, "NOT_FOUND", "없는 주소입니다: GET /api/api/stocks", "/api/stocks?quotes=1"))).toBe("address");
    expect(connectionKind(new ApiRequestError(404, "NOT_FOUND", "x", "/health"))).toBe("address");
    // 5xx 웹 페이지(배포 중 등)는 주소 문제가 아니다
    expect(connectionKind(new ApiRequestError(502, "HTTP_502", "서버 오류 (502)", "/api/stocks?quotes=1"))).toBeNull();
    expect(connectionKind(new Error("x"))).toBeNull();
    expect(connectionKind(null)).toBeNull();
  });

  it("문구: 무엇을 어디서 확인할지 (예전 '설정 > 서버 주소 아래에 토큰' 같은 틀린 칸 이름 없음)", () => {
    expect(connectionText("network")).toEqual({ title: "서버에 연결할 수 없습니다", hint: "인터넷 연결을 확인하세요. 계속되면 설정 > 서버 연결에서 '서버 주소'를 확인하세요." });
    expect(connectionText("timeout").hint).toContain("설정 > 서버 연결에서 '서버 주소'");
    expect(connectionText("auth")).toEqual({ title: "API 토큰이 맞지 않습니다", hint: "설정 > 서버 연결에서 'API 토큰'을 확인하세요." });
    expect(connectionText("address")).toEqual({ title: "서버 주소가 맞지 않습니다", hint: "이 주소에서 앱의 서버를 찾지 못했습니다. 설정 > 서버 연결에서 '서버 주소'를 확인하세요." });
    expect(authBanner("14:03:21")).toBe("API 토큰 확인 필요 · 14:03:21 기준");
    expect(addressBanner("14:03:21")).toBe("서버 주소 확인 필요 · 14:03:21 기준");
    for (const k of ["network", "timeout", "auth", "address"] as const) expect(JSON.stringify(connectionText(k))).not.toMatch(/서버 주소 아래/);
  });
});

describe("첫 실행 안내: 이 기기에서 처음 쓰는 사람만 한 번, 사용 흔적이 있으면 건너뜀", () => {
  it("판단: 흔적을 모르면 기다림, 없으면 보임, 있으면 기존 사용자", () => {
    expect(firstRunDecision(undefined)).toBe("wait");
    expect(firstRunDecision(false)).toBe("show");
    expect(firstRunDecision(true)).toBe("existing");
  });

  it("사용 흔적: 바꾼 설정·연 브리핑·검색·차트 설정, 지난 실행의 쿼리 캐시 (이번 실행에 적힌 캐시는 아님)", () => {
    const boot = 1_000_000;
    const m = (pairs: [string, string | null][]) => new Map(pairs);
    expect(priorUseFrom(m([]), boot)).toBe(false);
    expect(priorUseFrom(m([["settings.sort", "profit"]]), boot)).toBe(true);
    expect(priorUseFrom(m([["briefings.read", "[1]"]]), boot)).toBe(true);
    // 저절로 적힐 수 있는 키(토큰 이전 등)는 보지 않는다
    expect(priorUseFrom(m([["settings.apiToken", "x"]]), boot)).toBe(false);
    expect(cacheFromEarlierRun(JSON.stringify({ timestamp: boot - 1 }), boot)).toBe(true);
    expect(cacheFromEarlierRun(JSON.stringify({ timestamp: boot + 10 }), boot)).toBe(false);
    expect(cacheFromEarlierRun(null, boot)).toBe(false);
    // 모르는 모양은 흔적으로 (확실하지 않을 때 억지로 띄우지 않는다)
    expect(cacheFromEarlierRun("{", boot)).toBe(true);
    expect(cacheFromEarlierRun(JSON.stringify({}), boot)).toBe(true);
  });

  it("저장소: 흔적 읽기, 못 읽으면 있는 것으로", async () => {
    expect(await hasPriorUse(1_000)).toBe(false);
    h.store.set("search.recent", "[]");
    expect(await hasPriorUse(1_000)).toBe(true);
    h.store.clear();
    h.failRead = true;
    expect(await hasPriorUse(1_000)).toBe(true);
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

describe("플래그 세 개 (서버 값, fallback 꺼짐) + 연결 오류 안내", () => {
  it("받은 값대로, 없으면 꺼짐. 연결 오류 안내는 emptyGuide 가 켜졌거나, 플래그를 못 받은 채 조회가 실패하고 마지막으로 받은 값이 끔이 아닐 때", () => {
    const on = { features: { oneHand: true, firstRun: false, emptyGuide: true } } as never;
    expect(uxFlagsFrom(on, false)).toEqual({ oneHand: true, firstRun: false, emptyGuide: true, connectionGuide: true, flagsMissing: false });
    // 받는 중(아직 실패 아님): 모두 꺼짐
    expect(uxFlagsFrom(undefined, false)).toEqual({ oneHand: false, firstRun: false, emptyGuide: false, connectionGuide: false, flagsMissing: false });
    // 서버 주소·토큰이 틀려 플래그 조회가 실패, 받은 적 없음: 빈 화면 안내는 꺼진 채, 연결 오류 안내('설정 열기')만 켠다 — 서버가 끌 수도 없는 상황
    expect(uxFlagsFrom(undefined, true, null)).toEqual({ oneHand: false, firstRun: false, emptyGuide: false, connectionGuide: true, flagsMissing: true });
    // 마지막으로 받은 값(서버 주소와 상관없이 기기에 기억)이 끔이면: 주소를 틀리게 바꿔 새 주소의 플래그가 없어도 켜지 않는다
    expect(uxFlagsFrom(undefined, true, false).connectionGuide).toBe(false);
    expect(uxFlagsFrom(undefined, true, true).connectionGuide).toBe(true);
    // 기억을 아직 읽는 중이면 켜지 않는다
    expect(uxFlagsFrom(undefined, true, undefined).connectionGuide).toBe(false);
    // 지금 주소에서 끔을 받았으면(저장된 값 포함) 실패 중이어도 끔
    const off = { features: { emptyGuide: false } } as never;
    expect(uxFlagsFrom(off, true, null).connectionGuide).toBe(false);
    expect(UX_OFF).toEqual({ oneHand: false, firstRun: false, emptyGuide: false, connectionGuide: false, flagsMissing: false });
  });

  it("기억할 값: 받은 플래그의 emptyGuide (받지 못했으면 기억을 바꾸지 않음)", () => {
    expect(emptyGuideToRemember(undefined)).toBeUndefined();
    expect(emptyGuideToRemember({ features: { emptyGuide: true } } as never)).toBe(true);
    expect(emptyGuideToRemember({ features: {} } as never)).toBe(false);
  });
});

describe("설정 열기: 설정 탭 '서버 연결' 칸 (누를 때마다 새 요청)", () => {
  it("주소와 요청 읽기", () => {
    expect(serverSettingsParams(123)).toEqual({ open: "server", at: "123" });
    // 탭 안(잔고·브리핑·발견): 탭만 바꾼다
    openServerSettings();
    expect(h.navigate).toHaveBeenCalledTimes(1);
    expect(h.dismissTo).not.toHaveBeenCalled();
    const arg = h.navigate.mock.calls[0]![0] as { pathname: string; params: { open: string; at: string } };
    expect(arg.pathname).toBe("/settings");
    expect(arg.params.open).toBe("server");
    // 루트 스택 위(종목 상세·비중·브리핑 상세): 기존 탭까지 닫고 간다 (탭 묶음을 하나 더 쌓지 않게)
    h.canDismiss = true;
    openServerSettings();
    expect(h.navigate).toHaveBeenCalledTimes(1);
    expect(h.dismissTo).toHaveBeenCalledTimes(1);
    expect(h.dismissTo.mock.calls[0]![0]).toMatchObject({ pathname: "/settings", params: { open: "server" } });
    expect(serverOpenRequest({ open: "server", at: "5" })).toBe("5");
    expect(serverOpenRequest({ open: ["server"], at: ["6"] })).toBe("6");
    expect(serverOpenRequest({ open: "server" })).toBe("server");
    expect(serverOpenRequest({})).toBeNull();
    expect(serverOpenRequest({ open: "other", at: "1" })).toBeNull();
  });
});

describe("그 밖의 계산 (3-24 리뷰 수정)", () => {
  it("스와이프 시작 범위: 닫힌 줄은 왼쪽만, 열린 줄은 양쪽", () => {
    expect(swipeActiveRange(false)).toEqual([-14, 100_000]);
    expect(swipeActiveRange(true)).toEqual([-14, 14]);
  });

  it("머리 제목 최대 폭: 창 폭 − 제목 시작 72 − 오른쪽 버튼 실제 폭(모르면 44) − 24", () => {
    expect(headTitleMaxWidth(475, null)).toBe(335);
    expect(headTitleMaxWidth(475, 112)).toBe(267);
    // 글자 130% 의 '☆ 관심 추가' (약 128)
    expect(headTitleMaxWidth(411, 128)).toBe(187);
    expect(headTitleMaxWidth(100, 200)).toBe(0);
  });

  it("빈 브리핑 탭 '지금 만들기' 세션: 한국 시각 정오 전 오전, 정오부터 오후 (고정 시계)", () => {
    expect(sessionNow(Date.parse("2026-09-28T02:59:00Z"))).toBe("morning"); // 11:59 KST
    expect(sessionNow(Date.parse("2026-09-28T03:00:00Z"))).toBe("afternoon"); // 12:00 KST
    expect(sessionNow(Date.parse("2026-09-27T20:00:00Z"))).toBe("morning"); // 05:00 KST
  });
});
