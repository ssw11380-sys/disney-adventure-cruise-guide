import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StackRouter } from "expo-router/build/react-navigation/routers";
import { render } from "./miniRender";

/**
 * 3-24 리뷰 수정 (기능 플래그 emptyGuide — 연결 오류 안내).
 *  - 틀린 서버 주소: 서버에는 닿지만 이 앱의 서버가 아닌 응답(Railway 'Application not found' 404·다른 사이트 404 웹 페이지·JSON 이 아닌 성공 응답·
 *    늘 있는 목록 경로의 404)을 'address' 로 알아본다 → 오류 화면·끊김 띠에 '설정 열기'와 '서버 주소' 문구
 *  - 401 글: 연결 오류 안내가 켜지면 칸 이름 문구 ('설정 > 서버 연결에서 'API 토큰''), 꺼져 있으면 예전 글 그대로
 *  - '설정 열기' 라우터: 종목 상세(루트 스택 위)에서 눌러도 탭 묶음을 하나 더 쌓지 않는다 (StackRouter 로 흉내)
 *  - 연결 오류 안내 예외: 마지막으로 받은 emptyGuide 를 서버 주소와 상관없이 기억 → 서버가 끈 뒤 주소를 틀리게 바꿔도 켜지지 않는다
 */
const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  features: { data: undefined as unknown, isError: false },
  navigate: vi.fn(),
  dismissTo: vi.fn(),
  canDismiss: false,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => h.store.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.store.set(k, v),
    multiGet: async (keys: string[]) => keys.map((k) => [k, h.store.get(k) ?? null]),
  },
}));
vi.mock("expo-router", () => ({
  router: { navigate: h.navigate, dismissTo: h.dismissTo, canDismiss: () => h.canDismiss, push: vi.fn() },
  useRootNavigationState: () => ({ key: "root" }),
}));
vi.mock("@/api/hooks", () => ({ useFeatures: () => h.features }));
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ haptics: true }) }));

const { ApiRequestError, createApi } = await import("@/api/client");
const { connectionKind, setConnectionWording } = await import("@/lib/connectionError");
const { openServerSettings } = await import("@/lib/settingsLink");
const { UxFlagsProvider, ConnectionWordingBridge } = await import("@/components/UxBridge");
const { UxFlagsContext, useUx } = await import("@/lib/uxFlags");

const realFetch = globalThis.fetch;
let reply: () => Response = () => new Response("{}", { status: 200 });
let asked: string[] = [];
beforeEach(() => {
  asked = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return reply();
  }) as typeof fetch;
  h.store.clear();
  h.features = { data: undefined, isError: false };
  h.navigate.mockReset();
  h.dismissTo.mockReset();
  h.canDismiss = false;
  setConnectionWording(false);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setConnectionWording(false);
});

const failOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as InstanceType<typeof ApiRequestError>;
  }
  throw new Error("실패하지 않음");
};
const api = createApi("https://stock-briefing-typo.up.railway.app", "t");

describe("틀린 서버 주소를 'address' 로 (서버에는 닿지만 앱의 서버가 아님)", () => {
  it("Railway 하위 주소 오타: 404 {\"message\":\"Application not found\"} (서버 오류 코드 없음)", async () => {
    reply = () => new Response(JSON.stringify({ message: "Application not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const e = await failOf(api.listStocks());
    expect(e).toBeInstanceOf(ApiRequestError);
    expect([e.status, e.code, e.path]).toEqual([404, "HTTP_404", "/api/stocks?quotes=1"]);
    expect(connectionKind(e)).toBe("address");
  });

  it("다른 사이트의 404 웹 페이지(HTML), JSON 이 아닌 성공 응답(웹 페이지)", async () => {
    reply = () => new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } });
    expect(connectionKind(await failOf(api.features()))).toBe("address");
    // 예전에는 빈 값(null)을 성공으로 넘겨 빈 잔고처럼 보였다 (버그 수정 — 플래그와 상관없음)
    reply = () => new Response("<!doctype html><title>포털</title>", { status: 200, headers: { "content-type": "text/html" } });
    const e = await failOf(api.listStocks());
    expect([e.status, e.code]).toEqual([200, "NOT_JSON"]);
    expect(e.message).toContain("앱의 서버가 아닐 수 있습니다");
    expect(connectionKind(e)).toBe("address");
  });

  it("우리 서버의 종목 없음(NOT_FOUND)·서버 오류·배포 중 502 웹 페이지는 주소 문제가 아니다 (지금 그대로)", async () => {
    reply = () => new Response(JSON.stringify({ error: "NOT_FOUND", message: "종목을 찾을 수 없습니다: ZZZ" }), { status: 404 });
    const nf = await failOf(api.getStock("ZZZ"));
    expect(nf.message).toBe("종목을 찾을 수 없습니다: ZZZ");
    expect(connectionKind(nf)).toBeNull();
    reply = () => new Response("<html>Bad Gateway</html>", { status: 502 });
    expect(connectionKind(await failOf(api.listStocks()))).toBeNull();
    reply = () => new Response(JSON.stringify({ error: "INTERNAL", message: "x" }), { status: 500 });
    expect(connectionKind(await failOf(api.listStocks()))).toBeNull();
  });

  it("우리 서버인데 주소 끝에 경로를 더 붙임: 늘 있는 목록 경로의 없는 주소 404 → address", async () => {
    reply = () => new Response(JSON.stringify({ error: "NOT_FOUND", message: "없는 주소입니다: GET /api/api/stocks" }), { status: 404 });
    const wrong = createApi("https://stock-briefing.up.railway.app/api", "t");
    const e = await failOf(wrong.listStocks());
    expect(asked.at(-1)).toBe("https://stock-briefing.up.railway.app/api/api/stocks?quotes=1");
    expect(connectionKind(e)).toBe("address");
  });

  it("빈 본문·204 는 그대로 성공", async () => {
    reply = () => new Response(null, { status: 204 });
    await expect(api.removeStock("005930")).resolves.toBeUndefined();
    reply = () => new Response("", { status: 200 });
    await expect(api.features()).resolves.toBeNull();
  });
});

describe("401 글: 연결 오류 안내가 켜지면 설정 칸 이름 문구 (알림 창·오류 화면 모두)", () => {
  it("꺼져 있으면 예전 글, 켜지면 새 글", async () => {
    reply = () => new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 });
    expect((await failOf(api.listStocks())).message).toBe("API 토큰이 틀리거나 비어 있습니다. 설정 > 서버 주소 아래에 토큰을 입력하세요.");
    setConnectionWording(true);
    expect((await failOf(api.removeStock("005930"))).message).toBe("API 토큰이 틀리거나 비어 있습니다. 설정 > 서버 연결에서 'API 토큰'을 확인하세요.");
  });

  it("루트의 ConnectionWordingBridge 가 connectionGuide 를 알려 준다", async () => {
    reply = () => new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 });
    const on = { oneHand: false, firstRun: false, emptyGuide: true, connectionGuide: true, flagsMissing: false };
    render(
      <UxFlagsContext.Provider value={on}>
        <ConnectionWordingBridge />
      </UxFlagsContext.Provider>,
    );
    expect((await failOf(api.listStocks())).message).toContain("설정 > 서버 연결에서 'API 토큰'");
    render(
      <UxFlagsContext.Provider value={{ ...on, emptyGuide: false, connectionGuide: false }}>
        <ConnectionWordingBridge />
      </UxFlagsContext.Provider>,
    );
    expect((await failOf(api.listStocks())).message).toContain("설정 > 서버 주소 아래에 토큰");
  });
});

describe("'설정 열기' 라우터: 종목 상세 위에서 눌러도 탭 묶음을 하나 더 쌓지 않는다", () => {
  // 루트 스택: (tabs) 위에 종목 상세 (expo-router 57 이 쓰는 react-navigation StackRouter 그대로)
  const router = StackRouter({});
  const opts = { routeNames: ["(tabs)", "stocks/[code]/index"], routeParamList: {}, routeGetIdList: {} } as never;
  type S = ReturnType<typeof router.getInitialState>;
  /** expo-router 의 dismissTo = POP_TO, navigate = NAVIGATE (중첩 경로 /settings 는 (tabs) 안의 settings) */
  const simulate = (start: S) => {
    let state = start;
    const apply = (type: "POP_TO" | "NAVIGATE", href: { params: Record<string, string> }) => {
      state = router.getStateForAction(state, { type, payload: { name: "(tabs)", params: { screen: "settings", params: href.params } } } as never, opts) as S;
    };
    openServerSettings({
      canDismiss: () => state.routes.length > 1,
      dismissTo: ((href: { params: Record<string, string> }) => apply("POP_TO", href)) as never,
      navigate: ((href: { params: Record<string, string> }) => apply("NAVIGATE", href)) as never,
    });
    return state;
  };
  const base = router.getInitialState(opts) as S;
  const onDetail = router.getStateForAction(base, { type: "PUSH", payload: { name: "stocks/[code]/index", params: { code: "005930" } } } as never, opts) as S;

  it("상세 위: 경로 2개 → 1개 (기존 탭으로 돌아가 설정 탭 + 서버 연결 요청)", () => {
    expect(onDetail.routes.map((r) => r.name)).toEqual(["(tabs)", "stocks/[code]/index"]);
    const after = simulate(onDetail);
    expect(after.routes.map((r) => r.name)).toEqual(["(tabs)"]);
    expect(after.routes[0]!.params).toMatchObject({ screen: "settings", params: { open: "server" } });
    // 예전(navigate) 이었다면: 탭 묶음이 하나 더 쌓여 3개
    const old = router.getStateForAction(onDetail, { type: "NAVIGATE", payload: { name: "(tabs)", params: { screen: "settings" } } } as never, opts) as S;
    expect(old.routes.map((r) => r.name)).toEqual(["(tabs)", "stocks/[code]/index", "(tabs)"]);
  });

  it("탭 안(잔고에서): 경로 1개 그대로, 탭만 설정으로", () => {
    const after = simulate(base);
    expect(after.routes).toHaveLength(1);
    expect(after.routes[0]!.params).toMatchObject({ screen: "settings", params: { open: "server" } });
  });
});

describe("연결 오류 안내 예외는 서버가 준 끔을 기억한다 (서버 주소와 상관없이)", () => {
  const Probe = () => {
    const ux = useUx();
    return <Text>{`${ux.connectionGuide}:${ux.flagsMissing}`}</Text>;
  };
  const Text = "Text" as unknown as React.ComponentType<{ children: React.ReactNode }>;
  const flush = () => new Promise((res) => setTimeout(res, 0));
  const mount = async () => {
    const r = render(
      <UxFlagsProvider>
        <Probe />
      </UxFlagsProvider>,
    );
    await flush();
    r.rerender();
    return r;
  };

  it("받은 적 없음 + 플래그 조회 실패 → 끔 (새 기능은 앱 fallback 꺼짐 — 이 기기가 켬을 받은 적이 있을 때만 예외)", async () => {
    h.features = { data: undefined, isError: true };
    expect((await mount()).text()).toBe("false:true");
  });

  it("서버 주소를 바꿔 새 주소의 플래그를 받는 중에는 직전 값을 그대로 둔다 (켬→끔→켬으로 설정 칸이 다시 그려지지 않게)", async () => {
    h.features = { data: { features: { emptyGuide: true } }, isError: false };
    const r = await mount();
    expect(r.text()).toBe("true:false");
    // 새 주소: 아직 받는 중 (값 없음·실패 아님)
    h.features = { data: undefined, isError: false };
    r.rerender();
    expect(r.text()).toBe("true:false");
    // 새 주소에서 받음 (끔) → 그 값
    h.features = { data: { features: { emptyGuide: false } }, isError: false };
    r.rerender();
    expect(r.text()).toBe("false:false");
    // 앱을 막 켜서 한 번도 받지 못한 채 받는 중이면 모두 꺼짐 (직전 값이 없다)
    h.store.clear();
    h.features = { data: undefined, isError: false };
    expect((await mount()).text()).toBe("false:false");
  });

  it("서버가 끔을 준 뒤 주소를 틀리게 바꿈(새 주소의 플래그 없음·실패) → 끔. 다음 실행(기기 기억)도 끔", async () => {
    h.features = { data: { features: { emptyGuide: false } }, isError: false };
    const r = await mount();
    expect(r.text()).toBe("false:false");
    expect(h.store.get("ux.lastEmptyGuide")).toBe("0");
    h.features = { data: undefined, isError: true };
    r.rerender();
    expect(r.text()).toBe("false:true");
    // 다음 실행: 기기에 기억한 끔
    expect((await mount()).text()).toBe("false:true");
  });

  it("서버가 켬을 준 적이 있으면 틀린 주소에서도 켬", async () => {
    h.store.set("ux.lastEmptyGuide", "1");
    h.features = { data: undefined, isError: true };
    expect((await mount()).text()).toBe("true:true");
  });
});
