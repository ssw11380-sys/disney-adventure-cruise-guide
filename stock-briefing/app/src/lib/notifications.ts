import AsyncStorage from "@react-native-async-storage/async-storage";
import type { QueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { ApiRequestError, type Api } from "@/api/client";
import type { BriefingPick } from "@/lib/briefingPick";
import { parseBriefingId, parseStockCode } from "@/lib/freshness";
import type { AlertNotification } from "@/lib/priceAlerts";

/**
 * 푸시 알림 등록.
 * - Android 에서는 Expo Go 에서 원격 푸시가 동작하지 않는다 (SDK 53+). 개발 빌드(eas build) 필요.
 * - Expo 푸시 토큰을 받으려면 EAS projectId 가 있어야 한다 (`eas init` 이 app.json 에 넣어 준다).
 */

export const ANDROID_CHANNEL = "briefings";
/** 가격 알림(가격·등락률·거래량) 채널 — 브리핑과 따로 끄고 켤 수 있게 미리 만든다 (3-19) */
export const PRICE_CHANNEL = "prices";
const TOKEN_KEY = "push.expoToken";

/**
 * 앱이 앞에 있을 때 온 알림을 어떻게 보일지 (순수 함수). 브리핑 알림은 지금처럼 배너·목록·소리.
 * 가격 알림(3-29)은 앱이 앞에 있을 때만 올리고 화면 위 카드·진동이 이미 알리므로 목록에만, 소리·팝업 없이
 * (expo-notifications 안드로이드는 shouldPlaySound: false 면 채널 소리·진동과 상관없이 조용히 올린다)
 */
export function presentationFor(data: Record<string, unknown> | undefined): { shouldShowBanner: boolean; shouldShowList: boolean; shouldPlaySound: boolean; shouldSetBadge: boolean } {
  if (data?.["type"] === "priceAlert") return { shouldShowBanner: false, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false };
  return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
}

// 앱이 포그라운드일 때도 배너/목록에 표시 (가격 알림은 목록에만 조용히)
Notifications.setNotificationHandler({
  handleNotification: async (n) => presentationFor(n.request.content.data as Record<string, unknown> | undefined),
});

export class PushSetupError extends Error {
  constructor(
    public readonly code: "NOT_DEVICE" | "EXPO_GO" | "PERMISSION" | "NO_PROJECT_ID" | "TOKEN",
    message: string,
  ) {
    super(message);
    this.name = "PushSetupError";
  }
}

/** 안드로이드 알림 채널 2개: 브리핑·가격. 사용자가 기기 설정에서 채널별로 끄고 소리를 바꿀 수 있다 */
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
    name: "브리핑 알림",
    description: "오전/오후 브리핑 (세션마다 1건으로 묶음)",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    sound: "default",
  });
  await Notifications.setNotificationChannelAsync(PRICE_CHANNEL, {
    name: "가격 알림",
    description: "가격·등락률·거래량 알림",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 150, 100, 150],
    sound: "default",
  });
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
}

/** 권한 요청 → 토큰 발급 → 서버 등록. 성공하면 토큰을 돌려준다. */
export async function registerForPush(api: Api): Promise<string> {
  if (!Device.isDevice) throw new PushSetupError("NOT_DEVICE", "에뮬레이터/시뮬레이터에서는 푸시 알림을 받을 수 없습니다. 실기기로 테스트하세요.");
  if (Constants.appOwnership === "expo") {
    throw new PushSetupError("EXPO_GO", "Expo Go 에서는 푸시 알림이 동작하지 않습니다. 개발 빌드(eas build)로 설치한 앱에서 켜 주세요.");
  }
  await ensureAndroidChannel();
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") throw new PushSetupError("PERMISSION", "알림 권한이 거부되었습니다. 기기 설정에서 이 앱의 알림을 허용해 주세요.");

  const pid = projectId();
  if (!pid) throw new PushSetupError("NO_PROJECT_ID", "이 앱 설치본에는 알림 설정 정보가 빠져 있습니다. 최신 앱을 다시 설치해 주세요.");

  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId: pid })).data;
  } catch (e) {
    throw new PushSetupError("TOKEN", `푸시 토큰 발급 실패: ${(e as Error).message}`);
  }
  await api.registerDevice({ token, platform: Platform.OS === "android" ? "android" : Platform.OS === "ios" ? "ios" : "unknown", deviceName: Device.modelName });
  try {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore */
  }
  return token;
}

/** 서버에서 이 기기를 빼지 못함 — 서버는 계속 보내므로 알림은 아직 켜져 있다 */
export class PushUnregisterError extends Error {
  constructor(reason: string) {
    super(`알림을 끄지 못해 아직 켜져 있습니다. 잠시 뒤 다시 꺼 주세요.\n${reason}`);
    this.name = "PushUnregisterError";
  }
}

/**
 * 서버에서 이 기기를 뺀 뒤에만 저장된 토큰을 지운다 (N1).
 * 연결 실패·5xx 등으로 못 빼면 토큰을 남기고 던진다 — 다시 끌 때 같은 토큰으로 재시도. 이미 지워진 기기(404)는 성공으로 본다
 */
export async function unregisterPush(api: Api): Promise<void> {
  const token = await getStoredToken();
  if (token) {
    try {
      await api.unregisterDevice(token);
    } catch (e) {
      if (!(e instanceof ApiRequestError && e.status === 404)) throw new PushUnregisterError(e instanceof Error ? e.message : String(e));
    }
  }
  try {
    await AsyncStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export async function getStoredToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * 브리핑 알림(세션 묶음·종목·계좌)이면 브리핑 캐시(목록·계좌 브리핑·지난 브리핑)를 무효화한다. 알림을 받았을 때·눌렀을 때 NotificationBridge 가 부른다 —
 * 브리핑 탭은 가려져도 마운트된 채라, 새 브리핑 알림을 눌러 들어와도 전에 받은 목록이 그대로 보였다 (BH-16). 브리핑 알림이면 true
 */
export function refreshBriefingsFor(qc: Pick<QueryClient, "invalidateQueries">, apiUrl: string, data: Record<string, unknown> | undefined): boolean {
  if (data?.["type"] !== "briefing") return false;
  void qc.invalidateQueries({ queryKey: [apiUrl, "briefings"] });
  return true;
}

/** 알림을 눌렀을 때 이동할 경로 */
export function routeForNotification(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  // 계좌 브리핑이 앞머리인 세션 알림(3-31)은 계좌 브리핑 화면으로. 예전 앱은 이 칸을 몰라 아래 digest 규칙대로 브리핑 탭으로 간다
  const account = data["accountBriefingId"];
  if ((typeof account === "number" && account > 0) || (typeof account === "string" && /^[1-9]\d*$/.test(account))) return `/briefings/account/${account}`;
  // 세션 묶음 알림은 브리핑 탭으로 (변동 큰 순으로 모두 보인다). 예전 앱은 digest 를 몰라 1위 종목 브리핑으로 간다
  if (data["digest"] === true) return "/briefings";
  if (data["type"] === "briefing" && typeof data["briefingId"] === "number") return `/briefings/${data["briefingId"]}`;
  if (data["type"] === "briefing" && typeof data["briefingId"] === "string") return `/briefings/${data["briefingId"]}`;
  // 가격 알림(3-29)은 그 종목 상세로. 코드는 화면 주소에 넣기 전에 거른다 ("../x" 같은 값은 이동하지 않음)
  if (data["type"] === "priceAlert" && typeof data["code"] === "string") {
    const code = parseStockCode(data["code"]);
    if (code) return `/stocks/${code}`;
  }
  return null;
}

/**
 * 알림을 누른 뒤 옮겨 가는 방법 (브리핑 3차 1, 플래그 notifBack — NotificationBridge 가 부른다).
 *  - legacy: 지금 그대로 (openNotificationPath). 플래그 꺼짐·모름, 브리핑이 아닌 알림(가격 알림), 입력 중인 화면 위
 *  - tab: 브리핑 탭만 (묶음 알림 · 2단인데 고를 시장 요약이 없는 묶음 알림)
 *  - tabThenPush: 브리핑 탭으로 바꾼 뒤 상세를 쌓는다 → '뒤로' = 브리핑 탭 (폰·접은 화면·펼친 세로 카드 격자)
 *  - pane: 펼친 가로 2단 — 새 화면을 쌓지 않고 브리핑 탭 오른쪽 칸에서 그 브리핑을 고른다
 */
export type NotificationNav = { kind: "legacy"; path: string } | { kind: "tab" } | { kind: "tabThenPush"; path: string } | { kind: "pane"; pick: BriefingPick };

export interface NotificationNavContext {
  /** 플래그 notifBack (모르면 false → 지금 그대로) */
  back: boolean;
  /** 펼친 가로 2단인지 (useFoldLayout().twoPane) */
  twoPane: boolean;
  /** 지금 화면 주소 (usePathname). 모르면 null */
  path: string | null;
}

/** 입력을 잃을 수 있는 화면: 잔고 수정·종목 검색·이동평균선·첫 실행 안내 (알림을 눌러도 닫지 않고 지금처럼 위에 쌓기만 한다) */
const INPUT_SCREENS: readonly RegExp[] = [/^\/stocks\/[^/]+\/edit\/?$/, /^\/stocks\/add\/?$/, /^\/chart-lines\/?$/, /^\/welcome\/?$/];

export function isInputScreen(path: string | null | undefined): boolean {
  return !!path && INPUT_SCREENS.some((re) => re.test(path));
}

/** 알림 data 의 id (숫자 또는 숫자 글자) */
function idOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : null;
  return typeof v === "string" ? parseBriefingId(v) : null;
}

/** 2단 오른쪽 칸에서 고를 브리핑: 계좌 브리핑 · 종목 브리핑 · 묶음이면 알림 첫 줄의 시장 요약 (id 가 이상하면 null) */
function paneFor(path: string, data: Record<string, unknown>): BriefingPick | null {
  const account = /^\/briefings\/account\/([^/]+)$/.exec(path);
  if (account) {
    const id = parseBriefingId(account[1]);
    return id ? { kind: "account", id } : null;
  }
  if (path === "/briefings") {
    const id = idOf(data["marketSummaryId"]);
    return id ? { kind: "market", id } : null;
  }
  const stock = /^\/briefings\/([^/]+)$/.exec(path);
  if (!stock) return null;
  const id = parseBriefingId(stock[1]);
  if (!id) return null;
  const code = typeof data["code"] === "string" ? parseStockCode(data["code"]) : null;
  return code ? { kind: "stock", id, code } : { kind: "stock", id };
}

/**
 * 알림을 누른 뒤 어디로 어떻게 갈지 (순수 함수 — 표 테스트 test/notifBack.test.ts). 이동할 곳이 없으면 null.
 * 켜져 있으면 브리핑 알림의 '뒤로'가 브리핑 탭이 되게 한다 (지금은 콜드 스타트면 잔고 탭, 앱을 쓰던 중이면 보던 화면)
 */
export function notificationNav(data: Record<string, unknown> | undefined, ctx: NotificationNavContext): NotificationNav | null {
  const path = routeForNotification(data);
  if (!path || !data) return null;
  if (!ctx.back || data["type"] !== "briefing" || isInputScreen(ctx.path)) return { kind: "legacy", path };
  if (ctx.twoPane) {
    const pick = paneFor(path, data);
    if (pick) return { kind: "pane", pick };
  }
  return path === "/briefings" ? { kind: "tab" } : { kind: "tabThenPush", path };
}

/**
 * 가격 알림 한 줄을 휴대폰 알림 목록에 올린다 (3-29, 앱이 앞에 있을 때만 불린다 — lib/priceAlerts notifyPriceAlert 로 넣어 준다).
 * 알림 권한이 이미 있을 때만 (이 기능은 권한을 묻지 않는다). 채널은 trigger 에서만 읽힌다 (backgroundBriefings 와 같음). 실패는 조용히 넘긴다
 */
export async function postPriceAlert(content: AlertNotification): Promise<void> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== "granted") return;
    await Notifications.scheduleNotificationAsync({
      content: { title: content.title, body: content.body, data: content.data },
      trigger: Platform.OS === "android" ? { channelId: PRICE_CHANNEL } : null,
    });
  } catch {
    /* 알림 목록 줄은 없어도 되는 것 (화면 위 카드·진동은 이미 알렸다) */
  }
}
