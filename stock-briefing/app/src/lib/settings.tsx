import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { parseWatchView, serializeWatchView, VIEW_DEFAULT, type WatchView } from "@/lib/watchView";

/**
 * 앱 설정. AsyncStorage 에 저장한다.
 *  - apiUrl/apiToken: 서버 주소·토큰. 기본값 EXPO_PUBLIC_API_URL → app.json extra.apiUrl → 플랫폼별 localhost.
 *  - sort: 내 종목 정렬
 *  - showKrw: 미국 종목을 원화로 환산해 표시
 *  - widgetRowCurrency: 잔고 위젯(다듬은 모습) 종목 줄의 손익 금액 통화 — 원화(기본, 합계와 같은 기준) · 종목 통화
 *  - haptics: 누를 때 짧은 진동 (3-24, 기능 플래그 oneHand 가 켜져 있을 때만 설정 화면에 보인다. 기본 켬 — lib/haptics)
 *  - density: 잔고 표시 기본 · 촘촘 (3-39, 기능 플래그 densityMode 가 켜져 있을 때만 설정 화면에 보이고 잔고에 쓰인다. 위젯은 읽지 않는다)
 *  - chartHighLow: 차트 최고·최저가 표시 (3-46, 기능 플래그 chartHighLow 가 켜져 있을 때만 설정 화면에 보이고 차트에 쓰인다. 기본 켬)
 *  - watchView: 잔고 관심 칸에서 고른 칩·접은 그룹 (3-34, 기능 플래그 watchGroups 가 켜져 있을 때만 쓰인다. 그룹·순서 자체는 서버 — lib/watchView)
 * 위젯(백그라운드)도 같은 키를 읽으므로 키 이름을 바꾸면 widgets/ 쪽도 같이 바꿔야 한다.
 */

export const STORAGE_KEYS = {
  apiUrl: "settings.apiUrl",
  apiToken: "settings.apiToken",
  sort: "settings.sort",
  showKrw: "settings.showKrw",
  themeMode: "settings.themeMode",
  afterCost: "settings.afterCost",
  widgetRowCurrency: "settings.widgetRowCurrency",
  haptics: "settings.haptics",
  density: "settings.density",
  chartHighLow: "settings.chartHighLow",
  watchView: "settings.watchView",
} as const;

/** 잔고 위젯 종목 줄 손익 금액: 원화(기본) · 종목 통화 */
export type WidgetRowCurrency = "krw" | "native";
export const WIDGET_ROW_OPTIONS: { value: WidgetRowCurrency; label: string }[] = [
  { value: "krw", label: "원화" },
  { value: "native", label: "종목 통화" },
];
/** 저장값 → 설정 (모르는 값·없음은 원화) */
export const widgetRowCurrencyOf = (v: string | null | undefined): WidgetRowCurrency => (v === "native" ? "native" : "krw");

/** 잔고 표시 밀도 (3-39, 기능 플래그 densityMode): 기본 · 촘촘 */
export type Density = "basic" | "dense";
export const DENSITY_OPTIONS: { value: Density; label: string }[] = [
  { value: "basic", label: "기본" },
  { value: "dense", label: "촘촘" },
];
/** 저장값 → 밀도 (모르는 값·없음은 기본) */
export const densityOf = (v: string | null | undefined): Density => (v === "dense" ? "dense" : "basic");

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

/** 서버 주소 입력값 정리 (앞뒤 공백·끝의 / 제거). 비우면 저장하지 않아 다음 실행부터 번들 기본 주소 */
function cleanApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

interface Settings {
  apiUrl: string;
  /** 서버 API_TOKEN 과 같은 값. 비어 있으면 헤더를 보내지 않는다 */
  apiToken: string;
  sort: SortKey;
  showKrw: boolean;
  themeMode: ThemeMode;
  /** 평가금액·손익에서 매도 예상 수수료·세금을 뺀다 (토스 앱 기준, 기본 켬) */
  afterCost: boolean;
  /** 잔고 위젯 종목 줄 손익 금액 통화 (기본 원화) */
  widgetRowCurrency: WidgetRowCurrency;
  /** 누를 때 짧은 진동 (기본 켬, 3-24) */
  haptics: boolean;
  /** 잔고 표시 기본 · 촘촘 (기본 '기본', 3-39 — 플래그 densityMode 가 꺼져 있으면 잔고는 이 값과 상관없이 기본) */
  density: Density;
  /** 차트 최고·최저가 표시 (기본 켬, 3-46 — 플래그 chartHighLow 가 꺼져 있으면 차트는 이 값과 상관없이 지금 그대로) */
  chartHighLow: boolean;
  /** 관심 칸에서 고른 칩·접은 그룹 (3-34 — 기본 '전체' · 모두 펼침) */
  watchView: WatchView;
  ready: boolean;
  setApiUrl: (url: string) => Promise<void>;
  setApiToken: (token: string) => Promise<void>;
  /** 서버 주소와 토큰을 한 번에 바꾼다 — 새 주소로 옛 토큰이 나가는 순간이 없게 (설정 화면 저장) */
  setCredentials: (url: string, token: string) => Promise<void>;
  setSort: (sort: SortKey) => Promise<void>;
  setShowKrw: (on: boolean) => Promise<void>;
  setThemeMode: (m: ThemeMode) => Promise<void>;
  setAfterCost: (on: boolean) => Promise<void>;
  setWidgetRowCurrency: (v: WidgetRowCurrency) => Promise<void>;
  setHaptics: (on: boolean) => Promise<void>;
  setDensity: (v: Density) => Promise<void>;
  setChartHighLow: (on: boolean) => Promise<void>;
  setWatchView: (v: WatchView) => Promise<void>;
}

/**
 * 저장해 둔 서버 주소·토큰을 다 읽은 뒤의 값. 앱 시작 직후(읽기 전) 나가는 요청이 번들 기본 토큰으로 가서
 * 설정 화면의 서버 상태가 틀리게 보이지 않게, 그런 요청은 이 값을 기다렸다가 쓴다 (hooks 의 useApi)
 */
const latest = { apiUrl: defaultApiUrl(), apiToken: process.env.EXPO_PUBLIC_API_TOKEN ?? "" };
/** 후속 변경 요청 직전에 현재 서버·인증을 같은 동기 구간에서 대조한다. 저장소 조회는 하지 않는다. */
export function currentCredentials(): { apiUrl: string; apiToken: string } { return { ...latest }; }
let markLoaded: () => void = () => {};
const loaded = new Promise<void>((resolve) => {
  markLoaded = resolve;
});
export async function loadedCredentials(): Promise<{ apiUrl: string; apiToken: string }> {
  await loaded;
  return { ...latest };
}

const noop = async () => {};

function initialThemeMode(): ThemeMode {
  if (Platform.OS !== "web") return "dark";
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEYS.themeMode);
    return v && THEME_OPTIONS.some((o) => o.value === v) ? (v as ThemeMode) : "dark";
  } catch {
    return "dark";
  }
}
const Ctx = createContext<Settings>({
  apiUrl: defaultApiUrl(),
  apiToken: "",
  sort: "created",
  showKrw: false,
  themeMode: "dark",
  afterCost: true,
  widgetRowCurrency: "krw",
  haptics: true,
  density: "basic",
  chartHighLow: true,
  watchView: VIEW_DEFAULT,
  ready: false,
  setApiUrl: noop,
  setApiToken: noop,
  setCredentials: noop,
  setSort: noop,
  setShowKrw: noop,
  setThemeMode: noop,
  setAfterCost: noop,
  setWidgetRowCurrency: noop,
  setHaptics: noop,
  setDensity: noop,
  setChartHighLow: noop,
  setWatchView: noop,
});

async function persist(key: string, value: string | null): Promise<void> {
  try {
    if (value === null || value === "") await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, value);
  } catch {
    /* 저장 실패해도 세션 동안은 유지 */
  }
}

/**
 * 사용자가 비운 토큰을 저장소에 적는 값 (공백 한 칸). 키를 지우면 "저장한 적 없음"이 되어 앱(다음 실행)과 위젯이 번들 기본 토큰을
 * 다시 쓴다 — 다른 서버로 바꾸고 토큰을 비워도 운영 토큰이 그 서버로 나간다 (BH-66). 앱과 위젯(widgets/data readSettings)은 읽을 때 trim 해서
 * 빈 토큰(헤더 없음)으로 본다. 빈 문자열이 아니라 공백인 것은 예전 번들(OTA 되돌림)이 읽어도 번들 토큰으로 바꾸지 않게 하려는 것.
 * 예전 앱에서 이미 비운(키를 지운) 토큰은 "저장한 적 없음"과 구분할 수 없어 번들 토큰으로 남는다
 */
const CLEARED_TOKEN = " ";
const tokenForStorage = (token: string) => token || CLEARED_TOKEN;
/** 저장된 토큰. 저장한 적 없으면(null) 번들 기본 토큰, 사용자가 비웠으면 빈 값 */
function storedToken(raw: string | null | undefined): string {
  return raw === null || raw === undefined ? (process.env.EXPO_PUBLIC_API_TOKEN ?? "") : raw.trim();
}

/**
 * 서버 주소·토큰을 저장소에 함께 적는다. 위젯·백그라운드 작업은 두 키를 따로 읽으므로 새 주소와 옛 토큰이 짝지어 보이는 순간이 없게
 * 한 번에(multiSet) 적는다. 주소를 비우면(번들 기본 주소로) 키를 지워야 해서 한 번에 못 적으므로, 토큰부터 비운 뒤 주소를 지우고 새 토큰을 적는다 (BH-27)
 */
async function persistCredentials(url: string, token: string): Promise<void> {
  const stored = tokenForStorage(token);
  try {
    if (url) {
      await AsyncStorage.multiSet([
        [STORAGE_KEYS.apiUrl, url],
        [STORAGE_KEYS.apiToken, stored],
      ]);
      return;
    }
    await AsyncStorage.setItem(STORAGE_KEYS.apiToken, CLEARED_TOKEN);
    await AsyncStorage.removeItem(STORAGE_KEYS.apiUrl);
    if (stored !== CLEARED_TOKEN) await AsyncStorage.setItem(STORAGE_KEYS.apiToken, stored);
  } catch {
    /* 저장 실패해도 세션 동안은 유지 */
  }
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [apiUrl, setUrl] = useState(defaultApiUrl());
  const [apiToken, setToken] = useState(process.env.EXPO_PUBLIC_API_TOKEN ?? "");
  const [sort, setSortState] = useState<SortKey>("created");
  const [showKrw, setShowKrwState] = useState(false);
  // 휴대폰은 저장된 설정을 읽을 때까지 스플래시가 가려 준다(_layout 의 SplashGate). 웹은 스플래시가 없어 저장소를 바로 읽는다
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => initialThemeMode());
  const [afterCost, setAfterCostState] = useState(true);
  const [widgetRowCurrency, setWidgetRowCurrencyState] = useState<WidgetRowCurrency>("krw");
  const [haptics, setHapticsState] = useState(true);
  const [density, setDensityState] = useState<Density>("basic");
  const [chartHighLow, setChartHighLowState] = useState(true);
  const [watchView, setWatchViewState] = useState<WatchView>(VIEW_DEFAULT);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.multiGet([STORAGE_KEYS.apiUrl, STORAGE_KEYS.apiToken, STORAGE_KEYS.sort, STORAGE_KEYS.showKrw, STORAGE_KEYS.themeMode, STORAGE_KEYS.afterCost, STORAGE_KEYS.widgetRowCurrency, STORAGE_KEYS.haptics, STORAGE_KEYS.density, STORAGE_KEYS.chartHighLow, STORAGE_KEYS.watchView])
      .then((pairs) => {
        const m = new Map(pairs);
        const u = m.get(STORAGE_KEYS.apiUrl);
        // 토큰은 키가 있으면(사용자가 비운 값 포함) 그 값 — 번들 기본 토큰으로 되돌리지 않는다 (BH-66)
        const t = storedToken(m.get(STORAGE_KEYS.apiToken));
        const s = m.get(STORAGE_KEYS.sort);
        const k = m.get(STORAGE_KEYS.showKrw);
        if (u) setUrl(u);
        setToken(t);
        if (u) latest.apiUrl = u;
        latest.apiToken = t;
        if (s && SORT_OPTIONS.some((o) => o.value === s)) setSortState(s as SortKey);
        if (k) setShowKrwState(k === "1");
        const tm = m.get(STORAGE_KEYS.themeMode);
        if (tm && THEME_OPTIONS.some((o) => o.value === tm)) setThemeModeState(tm as ThemeMode);
        const ac = m.get(STORAGE_KEYS.afterCost);
        if (ac) setAfterCostState(ac === "1");
        setWidgetRowCurrencyState(widgetRowCurrencyOf(m.get(STORAGE_KEYS.widgetRowCurrency)));
        // 저장한 적 없으면 켬
        const hp = m.get(STORAGE_KEYS.haptics);
        if (hp) setHapticsState(hp !== "0");
        setDensityState(densityOf(m.get(STORAGE_KEYS.density)));
        // 차트 최고·최저가 표시: 저장한 적 없으면 켬
        const hl = m.get(STORAGE_KEYS.chartHighLow);
        if (hl) setChartHighLowState(hl !== "0");
        // 관심 칸 칩·접힘: ready 전에 읽어 켤 때 '전체'로 한 번 그렸다가 바뀌지 않게 (망가진 값은 기본)
        setWatchViewState(parseWatchView(m.get(STORAGE_KEYS.watchView)));
      })
      .catch(() => {})
      .finally(() => {
        markLoaded();
        setReady(true);
      });
  }, []);

  const setApiToken = useCallback(async (token: string) => {
    const clean = token.trim();
    latest.apiToken = clean;
    setToken(clean);
    await persist(STORAGE_KEYS.apiToken, tokenForStorage(clean));
  }, []);
  const setApiUrl = useCallback(async (url: string) => {
    const clean = cleanApiUrl(url);
    latest.apiUrl = clean;
    setUrl(clean);
    await persist(STORAGE_KEYS.apiUrl, clean);
  }, []);
  // 주소·토큰을 같은 동기 구간에서 바꿔 한 번에 그린다 (따로 바꾸면 저장을 기다리는 사이 새 주소 + 옛 토큰으로 한 번 그려져
  // 요청·웹소켓이 옛 토큰을 새 서버로 보낸다, BH-27)
  const setCredentials = useCallback(async (url: string, token: string) => {
    const u = cleanApiUrl(url);
    const tk = token.trim();
    latest.apiUrl = u;
    latest.apiToken = tk;
    setUrl(u);
    setToken(tk);
    await persistCredentials(u, tk);
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

  const setAfterCost = useCallback(async (on: boolean) => {
    setAfterCostState(on);
    await persist(STORAGE_KEYS.afterCost, on ? "1" : "0");
  }, []);

  const setWidgetRowCurrency = useCallback(async (v: WidgetRowCurrency) => {
    setWidgetRowCurrencyState(v);
    await persist(STORAGE_KEYS.widgetRowCurrency, v);
  }, []);

  const setHaptics = useCallback(async (on: boolean) => {
    setHapticsState(on);
    await persist(STORAGE_KEYS.haptics, on ? "1" : "0");
  }, []);

  const setDensity = useCallback(async (v: Density) => {
    setDensityState(v);
    await persist(STORAGE_KEYS.density, v);
  }, []);

  const setChartHighLow = useCallback(async (on: boolean) => {
    setChartHighLowState(on);
    await persist(STORAGE_KEYS.chartHighLow, on ? "1" : "0");
  }, []);

  const setWatchView = useCallback(async (v: WatchView) => {
    setWatchViewState(v);
    await persist(STORAGE_KEYS.watchView, serializeWatchView(v));
  }, []);

  const value = useMemo(
    () => ({ apiUrl, apiToken, sort, showKrw, themeMode, afterCost, widgetRowCurrency, haptics, density, chartHighLow, watchView, ready, setApiUrl, setApiToken, setCredentials, setSort, setShowKrw, setThemeMode, setAfterCost, setWidgetRowCurrency, setHaptics, setDensity, setChartHighLow, setWatchView }),
    [apiUrl, apiToken, sort, showKrw, themeMode, afterCost, widgetRowCurrency, haptics, density, chartHighLow, watchView, ready, setApiUrl, setApiToken, setCredentials, setSort, setShowKrw, setThemeMode, setAfterCost, setWidgetRowCurrency, setHaptics, setDensity, setChartHighLow, setWatchView],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): Settings {
  return useContext(Ctx);
}
