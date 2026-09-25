import AsyncStorage from "@react-native-async-storage/async-storage";
import type { QueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { ApiRequestError, type Api } from "@/api/client";

/**
 * 푸시 알림 등록.
 * - Android 에서는 Expo Go 에서 원격 푸시가 동작하지 않는다 (SDK 53+). 개발 빌드(eas build) 필요.
 * - Expo 푸시 토큰을 받으려면 EAS projectId 가 있어야 한다 (`eas init` 이 app.json 에 넣어 준다).
 */

export const ANDROID_CHANNEL = "briefings";
/** 가격 알림(목표가·급등락) 채널 — 브리핑과 따로 끄고 켤 수 있게 미리 만든다 (3-19) */
export const PRICE_CHANNEL = "prices";
const TOKEN_KEY = "push.expoToken";

// 앱이 포그라운드일 때도 배너/목록에 표시
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
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
    description: "목표가·급등락 알림",
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
  return null;
}
