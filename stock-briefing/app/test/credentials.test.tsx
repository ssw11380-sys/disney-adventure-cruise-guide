import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 서버 주소·토큰 저장 (BH-27, BH-66). 실제 설정 탭과 SettingsProvider 를 최소 렌더러로 그리고, 저장소는 휴대폰처럼 늦게 끝나는 가짜로 둔다.
 *  - 주소와 토큰을 함께 바꾸면 새 주소로 옛 토큰을 한 번도 보내지 않는다 (앱이 그리는 값, 위젯이 읽는 저장소 둘 다)
 *  - 토큰 칸을 비워 저장하면 위젯도, 다시 켠 앱도 번들 기본 토큰으로 돌아가지 않는다
 */
const BUNDLED = "BUNDLED-TOKEN";
const h = vi.hoisted(() => {
  vi.stubEnv("EXPO_PUBLIC_API_TOKEN", "BUNDLED-TOKEN");
  vi.stubEnv("EXPO_PUBLIC_API_URL", "");
  return {
    store: new Map<string, string>(),
    /** 저장소가 바뀔 때마다의 (주소|토큰) — 위젯·백그라운드 작업이 그 순간 읽으면 보는 짝 */
    snapshots: [] as string[],
    /** 끝나지 않은 저장소 호출 수 */
    pending: 0,
    /** 설정 탭을 그릴 때마다의 (주소|토큰) — 이 짝으로 요청(useApi)·웹소켓이 나간다 */
    renders: [] as string[],
  };
});

vi.mock("@react-native-async-storage/async-storage", () => {
  const later = async () => {
    h.pending++;
    await new Promise<void>((r) => setTimeout(r, 1));
    h.pending--;
  };
  const snap = () => void h.snapshots.push(`${h.store.get("settings.apiUrl") ?? "-"}|${h.store.get("settings.apiToken") ?? "-"}`);
  return {
    default: {
      getItem: async (k: string) => (await later(), h.store.get(k) ?? null),
      setItem: async (k: string, v: string) => {
        await later();
        h.store.set(k, v);
        snap();
      },
      removeItem: async (k: string) => {
        await later();
        h.store.delete(k);
        snap();
      },
      multiGet: async (keys: string[]) => (await later(), keys.map((k) => [k, h.store.get(k) ?? null])),
      multiSet: async (pairs: [string, string][]) => {
        await later();
        for (const [k, v] of pairs) h.store.set(k, v);
        snap();
      },
      multiRemove: async (keys: string[]) => {
        await later();
        for (const k of keys) h.store.delete(k);
        snap();
      },
    },
  };
});
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
  Platform: { OS: "android" },
  // 넓은 창 배치(3-42, 플래그 foldLayout)가 창 크기를 읽는다 — 휴대폰(접은 폴드8) 크기
  useWindowDimensions: () => ({ width: 475, height: 751, scale: 2.625, fontScale: 1 }),
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.4.0", extra: { apiUrl: "https://prod.test" } } } }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/api/hooks", async () => {
  const s = await import("@/lib/settings");
  return {
    useHealth: () => {
      const { apiUrl, apiToken } = s.useSettings();
      h.renders.push(`${apiUrl}|${apiToken}`);
      return { data: undefined, isError: false, error: null, isFetching: false, refetch: async () => undefined };
    },
    // 설정 탭의 알림 설정('다음 실행' 시각, BH-16)과 기능 플래그(widgetPolish 의 '위젯 종목 금액') — 서버 주소·토큰 저장과는 상관없다
    useNotificationSettings: () => ({ data: undefined, isError: false, error: null, isFetching: false, refetch: async () => undefined }),
    useFeature: (_key: string, fallback = false) => fallback,
  };
});
vi.mock("@/lib/liveStream", () => ({ useLiveStream: () => ({ connected: false, connectedAt: null, lastTickAt: null, ticks: 0 }) }));
vi.mock("@/lib/errorReport", () => ({ flushErrors: async () => "empty", reportError: async () => undefined }));
vi.mock("@/components/Freshness", () => ({ usePull: () => ({ pulling: false, onPull: () => undefined }) }));
vi.mock("@/components/AppUpdateCard", () => ({ AppUpdateCard: "AppUpdateCard" }));
vi.mock("@/components/NotificationSettingsCard", () => ({ NotificationSettingsCard: "NotificationSettingsCard" }));
vi.mock("@/components/TossOpenApiCard", () => ({ TossOpenApiCard: "TossOpenApiCard" }));
vi.mock("@/components/ScreenInfoCard", () => ({ ScreenInfoCard: "ScreenInfoCard" }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Badge: "Badge", Button: "Button", Card: "Card", Chip: "Chip", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Toggle: "Toggle" }));

const { SettingsProvider } = await import("@/lib/settings");
const { default: SettingsScreen } = await import("@/app/(tabs)/settings");

const PROD = "https://prod.test";
type Screen = ReturnType<typeof render>;

/** 앱을 켠다: 저장된 설정을 다 읽을 때까지 */
async function open(): Promise<Screen> {
  const r = render(
    <SettingsProvider>
      <SettingsScreen />
    </SettingsProvider>,
  );
  expect(h.pending).toBeGreaterThan(0); // 저장된 설정 읽는 중
  await vi.waitFor(() => expect(h.pending).toBe(0));
  r.act(() => undefined);
  return r;
}
/** 설정 → 서버 연결을 펼쳐 주소·토큰을 넣고 저장 (저장소 쓰기가 끝날 때까지) */
async function save(r: Screen, url: string, token: string) {
  r.act(() => (r.byLabel("서버 연결").props.onPress as () => void)());
  r.act(() => (r.byLabel("서버 주소").props.onChangeText as (v: string) => void)(url));
  r.act(() => (r.byLabel("API 토큰").props.onChangeText as (v: string) => void)(token));
  const btn = r.all().find((n) => n.type === "Button" && n.props.title === "저장하고 연결 확인");
  expect(btn).toBeDefined();
  h.renders.length = 0;
  h.snapshots.length = 0;
  r.act(() => (btn!.props.onPress as () => void)());
  expect(h.pending).toBeGreaterThan(0);
  await vi.waitFor(() => expect(h.pending).toBe(0));
  r.act(() => undefined);
}
/** 위젯·백그라운드 작업이 서버에 보내는 요청 (저장소에서 주소·토큰을 직접 읽는다) */
async function widgetRequest(): Promise<{ url: string; auth: string | undefined }> {
  const calls: { url: string; auth: string | undefined }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.authorization });
    return new Response("[]", { status: 200 });
  });
  const { loadLatestBriefings } = await import("@/widgets/data");
  await loadLatestBriefings();
  return calls[0]!;
}
/** 앱을 다시 켠다 (모듈 상태·화면 상태를 새로, 저장소는 그대로) */
async function restart(): Promise<{ shown: { apiUrl: string; apiToken: string }; creds: { apiUrl: string; apiToken: string } }> {
  vi.resetModules();
  const R = await import("react");
  const fresh = await import("./miniRender");
  const s = await import("@/lib/settings");
  let shown = { apiUrl: "", apiToken: "" };
  const Probe = () => {
    const v = s.useSettings();
    shown = { apiUrl: v.apiUrl, apiToken: v.apiToken };
    return null;
  };
  const r = fresh.render(R.createElement(s.SettingsProvider, null, R.createElement(Probe)));
  const creds = await s.loadedCredentials();
  r.rerender();
  return { shown, creds };
}
/** 헤더가 어떤 토큰도 싣지 않는다 ("Bearer" 뒤가 비었거나 헤더 없음) */
const noCredential = (auth: string | undefined) => (auth ?? "").replace(/^Bearer/, "").trim() === "";

beforeEach(() => {
  h.store.clear();
  h.snapshots.length = 0;
  h.renders.length = 0;
  h.pending = 0;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => vi.unstubAllEnvs());

describe("BH-27: 서버 주소와 토큰을 함께 바꿔 저장", () => {
  it("새 서버로 옛 토큰을 보내지 않는다 — 화면이 그리는 값도, 위젯이 읽는 저장소도 (재현)", async () => {
    h.store.set("settings.apiUrl", "https://a.test");
    h.store.set("settings.apiToken", "TOKEN-A");
    const r = await open();
    expect(h.renders.at(-1)).toBe("https://a.test|TOKEN-A");
    await save(r, "https://b.test", "TOKEN-B");
    expect(h.renders).not.toContain("https://b.test|TOKEN-A");
    expect(h.renders.at(-1)).toBe("https://b.test|TOKEN-B");
    expect(h.snapshots).not.toContain("https://b.test|TOKEN-A");
    expect(h.snapshots.at(-1)).toBe("https://b.test|TOKEN-B");
    expect(await widgetRequest()).toEqual({ url: "https://b.test/api/briefings/latest", auth: "Bearer TOKEN-B" });
  });

  it("주소를 비워(번들 기본 주소로) 토큰과 함께 바꿔도, 저장소에 옛 주소 + 새 토큰이나 기본 주소 + 옛 토큰 짝이 생기지 않는다", async () => {
    h.store.set("settings.apiUrl", "https://a.test");
    h.store.set("settings.apiToken", "TOKEN-A");
    const r = await open();
    await save(r, "", "TOKEN-P");
    for (const s of h.snapshots) expect(s === "https://a.test|TOKEN-P" || s === "-|TOKEN-A").toBe(false);
    expect(h.snapshots.at(-1)).toBe("-|TOKEN-P");
    expect(await widgetRequest()).toEqual({ url: `${PROD}/api/briefings/latest`, auth: "Bearer TOKEN-P" });
  });

  it("주소만 바꾸면 토큰은 그대로 새 주소로 간다 (예전과 같음)", async () => {
    h.store.set("settings.apiUrl", "https://a.test");
    h.store.set("settings.apiToken", "TOKEN-A");
    const r = await open();
    await save(r, "https://b.test/", "TOKEN-A");
    expect(h.renders.at(-1)).toBe("https://b.test|TOKEN-A");
    expect(h.store.get("settings.apiUrl")).toBe("https://b.test");
    expect(await widgetRequest()).toEqual({ url: "https://b.test/api/briefings/latest", auth: "Bearer TOKEN-A" });
  });
});

describe("BH-66: 토큰 칸을 비워 저장하면 비운 채로 남는다", () => {
  it("번들 토큰이 든 앱에서 다른 서버로 바꾸고 토큰을 비우면 — 앱·위젯·다시 켠 앱 모두 번들 토큰을 보내지 않는다 (재현)", async () => {
    const r = await open();
    expect(h.renders.at(-1)).toBe(`${PROD}|${BUNDLED}`); // 처음 설치: 번들 기본값
    await save(r, "http://192.168.0.10:3000", "");
    // 저장하는 순간(이번 실행)
    expect.soft(h.renders).not.toContain(`http://192.168.0.10:3000|${BUNDLED}`);
    expect.soft(h.renders.at(-1)).toBe("http://192.168.0.10:3000|");
    // 위젯·백그라운드 작업
    const w = await widgetRequest();
    expect.soft(w.url).toBe("http://192.168.0.10:3000/api/briefings/latest");
    expect.soft(w.auth ?? "").not.toContain(BUNDLED);
    expect.soft(noCredential(w.auth)).toBe(true);
    // 위젯도 앱과 같은 규칙: 빈 토큰이면 "Bearer " 같은 빈 헤더가 아니라 헤더 자체를 보내지 않는다 (검증 지적)
    expect.soft(w.auth).toBeUndefined();
    // 다시 켠 앱 (요청·웹소켓·오류 보고가 쓰는 값과 설정 화면 토큰 칸)
    const again = await restart();
    expect.soft(again.creds).toEqual({ apiUrl: "http://192.168.0.10:3000", apiToken: "" });
    expect.soft(again.shown).toEqual({ apiUrl: "http://192.168.0.10:3000", apiToken: "" });
  });

  it("비운 뒤 다시 넣은 토큰은 그 값을 쓴다", async () => {
    const r = await open();
    await save(r, "http://192.168.0.10:3000", "");
    const r2 = await open();
    await save(r2, "http://192.168.0.10:3000", "LAN-TOKEN");
    expect(await widgetRequest()).toEqual({ url: "http://192.168.0.10:3000/api/briefings/latest", auth: "Bearer LAN-TOKEN" });
    expect((await restart()).creds).toEqual({ apiUrl: "http://192.168.0.10:3000", apiToken: "LAN-TOKEN" });
  });

  it("한 번도 저장하지 않았으면 예전처럼 번들 기본 주소·토큰", async () => {
    expect((await restart()).creds).toEqual({ apiUrl: PROD, apiToken: BUNDLED });
    expect(await widgetRequest()).toEqual({ url: `${PROD}/api/briefings/latest`, auth: `Bearer ${BUNDLED}` });
  });
});
