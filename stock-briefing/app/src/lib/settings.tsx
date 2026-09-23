import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

/**
 * 앱 설정. AsyncStorage 에 저장한다.
 *  - apiUrl/apiToken: 서버 주소·토큰. 기본값 EXPO_PUBLIC_API_URL → app.json extra.apiUrl → 플랫폼별 localhost.
 *  - sort: 내 종목 정렬
 *  - showKrw: 미국 종목을 원화로 환산해 표시
 * 위젯(백그라운드)도 같은 키를 읽으므로 키 이름을 바꾸면 widgets/ 쪽도 같이 바꿔야 한다.
 */

export const STORAGE_KEYS = {
  apiUrl: "settings.apiUrl",
  apiToken: "settings.apiToken",
  sort: "settings.sort",
  showKrw: "settings.showKrw",
  themeMode: "settings.themeMode",
} as const;

export type ThemeMode = "dark" | "light" | "system";
export const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "dark", label: "다크" },
  { value: "light", label: "라이트" },
  { value: "system", label: "시스템" },
];

export type SortKey = "created" | "name" | "changeRate" | "profit" | "value" | "market";
export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "created", label: "등록순" },
  { value: "changeRate", label: "등락률" },
  { value: "profit", label: "평가손익" },
  { value: "value", label: "평가금액" },
  { value: "name", label: "이름" },
  { value: "market", label: "시장" },
];

export function defaultApiUrl(): string {
  const env = process.env.EXPO_PUBLIC_API_URL;
  if (env) return env;
  const extra = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (extra && !(Platform.OS === "android" && extra.includes("localhost"))) return extra;
  return Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://localhost:3000";
}

interface Settings {
  apiUrl: string;
  /** 서버 API_TOKEN 과 같은 값. 비어 있으면 헤더를 보내지 않는다 */
  apiToken: string;
  sort: SortKey;
  showKrw: boolean;
  themeMode: ThemeMode;
  ready: boolean;
  setApiUrl: (url: string) => Promise<void>;
  setApiToken: (token: string) => Promise<void>;
  setSort: (sort: SortKey) => Promise<void>;
  setShowKrw: (on: boolean) => Promise<void>;
  setThemeMode: (m: ThemeMode) => Promise<void>;
}

const noop = async () => {};
const Ctx = createContext<Settings>({ apiUrl: defaultApiUrl(), apiToken: "", sort: "created", showKrw: false, themeMode: "dark", ready: false, setApiUrl: noop, setApiToken: noop, setSort: noop, setShowKrw: noop, setThemeMode: noop });

async function persist(key: string, value: string | null): Promise<void> {
  try {
    if (value === null || value === "") await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, value);
  } catch {
    /* 저장 실패해도 세션 동안은 유지 */
  }
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [apiUrl, setUrl] = useState(defaultApiUrl());
  const [apiToken, setToken] = useState(process.env.EXPO_PUBLIC_API_TOKEN ?? "");
  const [sort, setSortState] = useState<SortKey>("created");
  const [showKrw, setShowKrwState] = useState(false);
  const [themeMode, setThemeModeState] = useState<ThemeMode>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.multiGet([STORAGE_KEYS.apiUrl, STORAGE_KEYS.apiToken, STORAGE_KEYS.sort, STORAGE_KEYS.showKrw, STORAGE_KEYS.themeMode])
      .then((pairs) => {
        const m = new Map(pairs);
        const u = m.get(STORAGE_KEYS.apiUrl);
        const t = m.get(STORAGE_KEYS.apiToken);
        const s = m.get(STORAGE_KEYS.sort);
        const k = m.get(STORAGE_KEYS.showKrw);
        if (u) setUrl(u);
        if (t) setToken(t);
        if (s && SORT_OPTIONS.some((o) => o.value === s)) setSortState(s as SortKey);
        if (k) setShowKrwState(k === "1");
        const tm = m.get(STORAGE_KEYS.themeMode);
        if (tm && THEME_OPTIONS.some((o) => o.value === tm)) setThemeModeState(tm as ThemeMode);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const setApiToken = useCallback(async (token: string) => {
    const clean = token.trim();
    setToken(clean);
    await persist(STORAGE_KEYS.apiToken, clean);
  }, []);
  const setApiUrl = useCallback(async (url: string) => {
    const clean = url.trim().replace(/\/+$/, "");
    setUrl(clean);
    await persist(STORAGE_KEYS.apiUrl, clean);
  }, []);
  const setSort = useCallback(async (s: SortKey) => {
    setSortState(s);
    await persist(STORAGE_KEYS.sort, s);
  }, []);
  const setShowKrw = useCallback(async (on: boolean) => {
    setShowKrwState(on);
    await persist(STORAGE_KEYS.showKrw, on ? "1" : "0");
  }, []);

  const setThemeMode = useCallback(async (m: ThemeMode) => {
    setThemeModeState(m);
    await persist(STORAGE_KEYS.themeMode, m);
  }, []);

  const value = useMemo(
    () => ({ apiUrl, apiToken, sort, showKrw, themeMode, ready, setApiUrl, setApiToken, setSort, setShowKrw, setThemeMode }),
    [apiUrl, apiToken, sort, showKrw, themeMode, ready, setApiUrl, setApiToken, setSort, setShowKrw, setThemeMode],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): Settings {
  return useContext(Ctx);
}
