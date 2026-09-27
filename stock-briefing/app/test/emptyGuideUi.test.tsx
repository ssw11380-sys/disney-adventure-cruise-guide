import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 오류 화면·끊김 띠의 '설정 열기' (3-24, 기능 플래그 emptyGuide — 화면이 onOpenSettings 를 줄 때만).
 *  - 서버 연결 문제(주소·인터넷·시간 초과·토큰)만: 설정 칸 이름에 맞춘 문구 + '다시 시도' · '설정 열기'
 *  - 서버가 준 다른 오류(404·500), 주지 않으면: 지금 그대로 (오류 글 + 다시 시도)
 */
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  Switch: "Switch",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, connectedAt: null, lastTickAt: null, ticks: 0 }) }));
vi.mock("@/lib/useNow", () => ({ useNow: () => Date.parse("2026-09-28T01:10:00Z") }));

const { ErrorView } = await import("@/components/ui");
const { StaleBanner } = await import("@/components/Freshness");
const { ApiRequestError } = await import("@/api/client");

const network = new ApiRequestError(0, "NETWORK", "서버에 연결할 수 없습니다: http://wrong.example");
const auth = new ApiRequestError(401, "UNAUTHORIZED", "API 토큰이 틀리거나 비어 있습니다. 설정 > 서버 주소 아래에 토큰을 입력하세요.");
const server = new ApiRequestError(500, "HTTP_500", "서버 오류 (500)");
const buttons = (r: ReturnType<typeof render>) => r.all().filter((n) => n.type === "Pressable" && n.props.accessibilityRole === "button");

describe("오류 화면", () => {
  it("서버 주소가 틀림(연결 안 됨): 설정 칸 이름 문구 + 다시 시도 · 설정 열기", () => {
    const open = vi.fn();
    const r = render(<ErrorView error={network} onRetry={() => undefined} onOpenSettings={open} />);
    expect(r.text()).toContain("서버에 연결할 수 없습니다");
    expect(r.text()).toContain("설정 > 서버 연결에서 '서버 주소'를 확인하세요.");
    // 서버 주소(내부 값)를 화면에 그대로 드러내지 않는다
    expect(r.text()).not.toContain("wrong.example");
    expect(buttons(r).map((b) => b.props.accessibilityLabel)).toEqual(["다시 시도", "설정 열기, 서버 연결"]);
    (r.byLabel("설정 열기, 서버 연결").props.onPress as () => void)();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("토큰이 틀림: 'API 토큰' (예전 '설정 > 서버 주소 아래에 토큰' 같은 다른 칸 이름 없음)", () => {
    const r = render(<ErrorView error={auth} onRetry={() => undefined} onOpenSettings={() => undefined} />);
    expect(r.text()).toContain("API 토큰이 맞지 않습니다");
    expect(r.text()).toContain("설정 > 서버 연결에서 'API 토큰'을 확인하세요.");
    expect(r.text()).not.toContain("서버 주소 아래");
  });

  it("서버가 준 다른 오류·설정 열기를 주지 않으면 지금 그대로", () => {
    const a = render(<ErrorView error={server} onRetry={() => undefined} onOpenSettings={() => undefined} />);
    expect(a.text()).toBe("서버 오류 (500)다시 시도");
    const b = render(<ErrorView error={network} onRetry={() => undefined} />);
    expect(b.text()).toBe("서버에 연결할 수 없습니다: http://wrong.example다시 시도");
    expect(buttons(b)).toHaveLength(1);
  });
});

describe("끊김 띠 (값은 두고 위에 한 줄)", () => {
  const q = (error: unknown) => ({ data: [1], isError: true, error, dataUpdatedAt: Date.parse("2026-09-28T01:03:21Z"), fetchStatus: "idle" as const });

  it("연결 끊김 + 설정 열기 (글은 알림으로, 버튼은 따로)", () => {
    const open = vi.fn();
    const r = render(<StaleBanner query={q(network)} onOpenSettings={open} />);
    expect(r.text()).toContain("연결 끊김 · 10:03:21 기준 · 다시 연결 중");
    const btn = r.byLabel("설정 열기, 서버 연결");
    (btn.props.onPress as () => void)();
    expect(open).toHaveBeenCalledTimes(1);
    expect(btn.props.hitSlop).toBeTruthy();
  });

  it("토큰 오류: 'API 토큰 확인 필요' + 설정 열기 (예전 끝의 '설정에서 토큰 입력'은 버튼이 대신)", () => {
    const r = render(<StaleBanner query={q(auth)} onOpenSettings={() => undefined} />);
    expect(r.text()).toContain("API 토큰 확인 필요 · 10:03:21 기준");
    expect(r.text()).not.toContain("설정에서 토큰 입력");
  });

  it("주지 않으면 지금 그대로 (한 덩어리 알림, 버튼 없음)", () => {
    const r = render(<StaleBanner query={q(auth)} />);
    expect(r.text()).toBe("토큰 확인 필요 · 10:03:21 기준 · 설정에서 토큰 입력");
    expect(r.has("설정 열기, 서버 연결")).toBe(false);
    // 서버 오류(500)는 설정으로 고칠 수 없으니 버튼 없음
    expect(render(<StaleBanner query={q(server)} onOpenSettings={() => undefined} />).has("설정 열기, 서버 연결")).toBe(false);
  });
});
