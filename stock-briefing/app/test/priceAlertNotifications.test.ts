import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 가격 알림(3-29)의 알림 목록 줄: 앱이 앞에 있을 때 목록에만 조용히(소리·팝업 없음), 누르면 그 종목 상세, 권한이 이미 있을 때만 '가격 알림' 채널로.
 * 가격 채널 설명은 플래그 없이 '가격·등락률·거래량 알림'으로 (예전 '목표가·급등락'은 권유처럼 읽힘) — 이름·중요도·진동·소리와 브리핑 채널은 그대로
 */
const h = vi.hoisted(() => ({
  channels: [] as [string, Record<string, unknown>][],
  handler: null as null | { handleNotification: (n: unknown) => Promise<unknown> },
  perm: "granted" as string,
  scheduled: [] as unknown[],
  os: "android",
}));

vi.mock("expo-notifications", () => ({
  setNotificationHandler: (x: typeof h.handler) => void (h.handler = x),
  setNotificationChannelAsync: async (id: string, o: Record<string, unknown>) => void h.channels.push([id, o]),
  AndroidImportance: { HIGH: 4 },
  getPermissionsAsync: async () => ({ status: h.perm }),
  scheduleNotificationAsync: async (req: unknown) => void h.scheduled.push(req),
}));
vi.mock("expo-device", () => ({ isDevice: true, modelName: "test" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return h.os;
    },
  },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined } }));

const { ensureAndroidChannel, postPriceAlert, presentationFor, routeForNotification } = await import("@/lib/notifications");

beforeEach(() => {
  h.channels = [];
  h.perm = "granted";
  h.scheduled = [];
  h.os = "android";
});

describe("앱이 앞에 있을 때 보이는 방법 (presentationFor)", () => {
  it("가격 알림은 목록에만·소리 없음, 브리핑·그 밖은 지금 값 그대로", async () => {
    expect(presentationFor({ type: "priceAlert" })).toEqual({ shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });
    const now = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
    expect(presentationFor({ type: "briefing" })).toEqual(now);
    expect(presentationFor(undefined)).toEqual(now);
    // 등록한 처리기가 이 함수를 쓴다
    expect(await h.handler!.handleNotification({ request: { content: { data: { type: "priceAlert", code: "005930" } } } })).toEqual(presentationFor({ type: "priceAlert" }));
    expect(await h.handler!.handleNotification({ request: { content: { data: { type: "briefing" } } } })).toEqual(now);
  });
});

describe("누른 알림 경로", () => {
  it("가격 알림 → 그 종목 상세, 이상한 코드는 이동하지 않음, 브리핑 경로는 그대로", () => {
    expect(routeForNotification({ type: "priceAlert", code: "005930", ruleId: 12 })).toBe("/stocks/005930");
    expect(routeForNotification({ type: "priceAlert", code: "AAPL" })).toBe("/stocks/AAPL");
    expect(routeForNotification({ type: "priceAlert", code: "../x" })).toBeNull();
    expect(routeForNotification({ type: "priceAlert", code: 5930 })).toBeNull();
    expect(routeForNotification({ type: "briefing", briefingId: 7 })).toBe("/briefings/7");
    expect(routeForNotification({ type: "briefing", digest: true })).toBe("/briefings");
    expect(routeForNotification({ accountBriefingId: 3 })).toBe("/briefings/account/3");
  });
});

describe("알림 채널 (앱을 켤 때마다 다시 부름 — 이름·설명은 바뀐다)", () => {
  it("가격 채널: 이름 '가격 알림' · 설명 '가격·등락률·거래량 알림', 중요도·진동·소리는 그대로. 브리핑 채널 인자 그대로", async () => {
    await ensureAndroidChannel();
    expect(h.channels).toEqual([
      ["briefings", { name: "브리핑 알림", description: "오전/오후 브리핑 (세션마다 1건으로 묶음)", importance: 4, vibrationPattern: [0, 250, 250, 250], sound: "default" }],
      ["prices", { name: "가격 알림", description: "가격·등락률·거래량 알림", importance: 4, vibrationPattern: [0, 150, 100, 150], sound: "default" }],
    ]);
  });
});

describe("알림 목록 한 줄 올리기 (postPriceAlert)", () => {
  const content = { title: "가격 알림 · 삼성전자", body: "88,600원 이상 · 지금 88,700원 · 전일 대비 +8.97% · 10:12 기준", data: { type: "priceAlert" as const, code: "005930", ruleId: 12 } };
  it("권한이 이미 있으면 가격 채널로 바로, 없으면 올리지 않는다 (권한을 묻지 않음)", async () => {
    await postPriceAlert(content);
    expect(h.scheduled).toEqual([{ content: { title: content.title, body: content.body, data: content.data }, trigger: { channelId: "prices" } }]);
    h.perm = "denied";
    await postPriceAlert(content);
    expect(h.scheduled).toHaveLength(1);
  });
});
