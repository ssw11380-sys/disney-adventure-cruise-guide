import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Api } from "@/api/client";

/**
 * 푸시 알림 등록.
 * - Android 에서는 Expo Go 에서 원격 푸시가 동작하지 않는다 (SDK 53+). 개발 빌드(eas build) 필요.
 * - Expo 푸시 토큰을 받으려면 EAS projectId 가 있어야 한다 (`eas init` 이 app.json 에 넣어 준다).
 */

export const ANDROID_CHANNEL = "briefings";
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

export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
    name: "브리핑 알림",
    description: "오전/오후 종목 브리핑",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
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
  if (!pid) throw new PushSetupError("NO_PROJECT_ID", "EAS projectId 가 없습니다. 앱 폴더에서 `eas init` 을 실행한 뒤 다시 빌드하세요.");

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

export async function unregisterPush(api: Api): Promise<void> {
  const token = await getStoredToken();
  if (token) {
    try {
      await api.unregisterDevice(token);
    } catch {
      /* 서버에 없어도 로컬은 지운다 */
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

/** 알림을 눌렀을 때 이동할 경로 */
export function routeForNotification(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  if (data["type"] === "briefing" && typeof data["briefingId"] === "number") return `/briefings/${data["briefingId"]}`;
  if (data["type"] === "briefing" && typeof data["briefingId"] === "string") return `/briefings/${data["briefingId"]}`;
  return null;
}
