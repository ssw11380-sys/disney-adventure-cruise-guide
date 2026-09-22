import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

/**
 * 앱 설정 (현재는 API 주소만). AsyncStorage 에 저장한다.
 * 기본값: EXPO_PUBLIC_API_URL → app.json extra.apiUrl → 플랫폼별 localhost.
 * Android 에뮬레이터는 호스트 PC 가 10.0.2.2 이다. 실기기는 PC 의 LAN IP 를 설정 화면에서 입력.
 */

const KEY = "settings.apiUrl";

function defaultApiUrl(): string {
  const env = process.env.EXPO_PUBLIC_API_URL;
  if (env) return env;
  const extra = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (extra && !(Platform.OS === "android" && extra.includes("localhost"))) return extra;
  return Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://localhost:3000";
}

interface Settings {
  apiUrl: string;
  ready: boolean;
  setApiUrl: (url: string) => Promise<void>;
}

const Ctx = createContext<Settings>({ apiUrl: defaultApiUrl(), ready: false, setApiUrl: async () => {} });

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [apiUrl, setUrl] = useState(defaultApiUrl());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((v) => {
        if (v) setUrl(v);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const setApiUrl = useCallback(async (url: string) => {
    const clean = url.trim().replace(/\/+$/, "");
    setUrl(clean);
    try {
      await AsyncStorage.setItem(KEY, clean);
    } catch {
      /* 저장 실패해도 세션 동안은 유지 */
    }
  }, []);

  const value = useMemo(() => ({ apiUrl, ready, setApiUrl }), [apiUrl, ready, setApiUrl]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): Settings {
  return useContext(Ctx);
}
