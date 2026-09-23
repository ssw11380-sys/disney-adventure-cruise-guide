import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";
import { createApi } from "@/api/client";
import { buildReport, createLimiter, enqueue, type ErrorKind, type ErrorReport } from "./errorScrub";
import { loadedCredentials } from "./settings";

/**
 * 앱 오류를 서버(/api/app-errors)로 보낸다 (자체 수집, 외부 서비스 없음).
 *  - 먼저 기기에 적어 두고(앱이 곧 죽어도 다음 실행 때 보냄) 바로 보내 본다
 *  - 토큰·금액은 errorScrub 규칙으로 지운 뒤에만 저장·전송한다
 *  - 분당 10건, 같은 오류는 분당 1건
 */

const QUEUE_KEY = "errors.pending";
const allow = createLimiter(10);
let screen: string | null = null;
let flushing: Promise<void> | null = null;

/** 지금 보고 있는 화면 경로 (루트 레이아웃이 알려 준다) */
export function setCurrentScreen(path: string | null): void {
  screen = path;
}

function meta() {
  return {
    screen,
    appVersion: Constants.expoConfig?.version ?? null,
    updateId: Updates.updateId ?? null,
    platform: Platform.OS,
  };
}

async function readQueue(): Promise<ErrorReport[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as ErrorReport[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(q: ErrorReport[]): Promise<void> {
  try {
    if (q.length) await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    else await AsyncStorage.removeItem(QUEUE_KEY);
  } catch {
    /* 저장 실패는 무시 (보고는 최선만) */
  }
}

/** 오류 한 건 보고. 보내기를 기다리지 않는다(화면·크래시 처리를 막지 않게) */
export function reportError(kind: ErrorKind, err: unknown): Promise<void> {
  try {
    const r = buildReport(kind, err, meta(), Date.now());
    if (!allow(r, Date.now())) return Promise.resolve();
    return readQueue()
      .then((q) => writeQueue(enqueue(q, r)))
      .then(() => flushErrors())
      .catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

/** 기기에 남은 보고를 보낸다. 성공한 것만 지운다 */
export function flushErrors(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const q = await readQueue();
    if (!q.length) return;
    const { apiUrl, apiToken } = await loadedCredentials();
    if (!apiUrl) return;
    try {
      await createApi(apiUrl, apiToken).reportErrors(q);
      // 보내는 사이 새로 쌓인 것은 남긴다
      const now = await readQueue();
      await writeQueue(now.slice(q.length));
    } catch {
      /* 서버에 못 닿으면 다음 실행 때 다시 */
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

let installed = false;

/** 전역 JS 오류(React Native ErrorUtils)와 처리 안 된 Promise 거부, 웹의 window 오류를 잡는다. 한 번만 설치 */
export function installErrorHandlers(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as {
    ErrorUtils?: { getGlobalHandler: () => (e: unknown, fatal?: boolean) => void; setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void };
    HermesInternal?: { enablePromiseRejectionTracker?: (o: { allRejections: boolean; onUnhandled: (id: number, e: unknown) => void }) => void };
    addEventListener?: (type: string, fn: (ev: { error?: unknown; reason?: unknown; message?: string }) => void) => void;
  };
  if (g.ErrorUtils) {
    const prev = g.ErrorUtils.getGlobalHandler();
    g.ErrorUtils.setGlobalHandler((e, fatal) => {
      void reportError(fatal ? "fatal" : "js", e);
      prev(e, fatal);
    });
  }
  try {
    g.HermesInternal?.enablePromiseRejectionTracker?.({ allRejections: true, onUnhandled: (_id, e) => void reportError("promise", e) });
  } catch {
    /* 지원 안 하는 엔진 */
  }
  if (Platform.OS === "web" && typeof g.addEventListener === "function") {
    g.addEventListener("error", (ev) => void reportError("js", ev.error ?? ev.message));
    g.addEventListener("unhandledrejection", (ev) => void reportError("promise", ev.reason));
  }
  void flushErrors();
}
