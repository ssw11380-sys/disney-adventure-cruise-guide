import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";
import { ApiRequestError, createApi } from "@/api/client";
import { buildReport, createLimiter, enqueue, type ErrorKind, type ErrorReport } from "./errorScrub";
import { loadedCredentials } from "./settings";

/**
 * 앱 오류를 서버(/api/app-errors)로 보낸다 (자체 수집, 외부 서비스 없음).
 *  - 대기열은 메모리에 두고 기기(AsyncStorage)에 그대로 적는다(읽기 없이 쓰기 한 번 → 강제 종료 직전에도 남을 가능성을 높임)
 *  - 강제 종료(fatal)는 기기에 적을 때까지(최대 1.5초) 기다린 뒤 원래 처리(앱 종료)로 넘긴다 → 다음 실행 때 보낸다
 *  - 보낸 건만 id 로 지운다. 서버가 형식 오류(400·404·413·422)로 거절한 묶음은 버린다(매 실행마다 같은 것을 다시 보내지 않게)
 *  - 토큰·금액은 errorScrub 규칙으로 지운 뒤에만 저장·전송한다. 분당 10건, 같은 오류는 분당 1건
 */

const QUEUE_KEY = "errors.pending";
const FATAL_WAIT_MS = 1_500;
const CREDENTIALS_WAIT_MS = 5_000;
const allow = createLimiter(10);
let screen: string | null = null;
let queue: ErrorReport[] = [];
let loaded: Promise<void> | null = null;
let flushing: Promise<FlushResult> | null = null;

export type FlushResult = "sent" | "empty" | "retry" | "dropped";

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

/** 앱을 켤 때 한 번: 지난 실행에서 못 보낸 보고를 메모리로 */
function loadQueue(): Promise<void> {
  if (!loaded)
    loaded = AsyncStorage.getItem(QUEUE_KEY)
      .then((raw) => {
        const v = raw ? (JSON.parse(raw) as unknown) : [];
        const saved = Array.isArray(v) ? (v as ErrorReport[]).filter((r) => r && typeof r.id === "string") : [];
        // 로딩 중에 새로 난 것은 뒤에 둔다
        queue = [...saved, ...queue].slice(-20);
      })
      .catch(() => undefined);
  return loaded;
}

function persist(): Promise<void> {
  const snapshot = queue;
  return (snapshot.length ? AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(snapshot)) : AsyncStorage.removeItem(QUEUE_KEY)).catch(() => undefined);
}

const within = <T,>(p: Promise<T>, ms: number): Promise<T | undefined> => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/**
 * 오류 한 건 보고. 돌려주는 Promise 는 "기기에 적기"까지만 기다린다(보내기는 뒤에서).
 * 같은 오류가 분당 한도를 넘으면 조용히 버린다.
 */
export function reportError(kind: ErrorKind, err: unknown): Promise<void> {
  try {
    const now = Date.now();
    const r = buildReport(kind, err, meta(), now);
    if (!allow(r, now)) return Promise.resolve();
    // 지난 실행의 대기열을 읽은 뒤에 붙여 적는다 (먼저 적으면 남아 있던 것을 덮어쓴다)
    const saved = loadQueue().then(() => {
      queue = enqueue(queue, r);
      return persist();
    });
    void saved.then(() => flushErrors());
    return saved;
  } catch {
    return Promise.resolve();
  }
}

/** 기기에 남은 보고를 보낸다. 보낸 것(또는 서버가 형식 오류로 거절한 것)만 대기열에서 지운다 */
export function flushErrors(): Promise<FlushResult> {
  if (flushing) return flushing;
  flushing = (async (): Promise<FlushResult> => {
    await loadQueue();
    const batch = queue.slice(0, 20);
    if (!batch.length) return "empty";
    const creds = await within(loadedCredentials(), CREDENTIALS_WAIT_MS);
    if (!creds?.apiUrl) return "retry";
    const ids = new Set(batch.map((r) => r.id));
    let result: FlushResult;
    try {
      // 서버는 id 를 쓰지 않는다
      await createApi(creds.apiUrl, creds.apiToken).reportErrors(batch.map(({ id: _id, ...rest }) => rest));
      result = "sent";
    } catch (e) {
      const status = e instanceof ApiRequestError ? e.status : 0;
      // 형식 오류·없는 주소·너무 큼: 다시 보내도 같다 → 버린다. 네트워크·인증·한도·서버 오류: 다음에 다시
      if ([400, 404, 413, 422].includes(status)) result = "dropped";
      else return "retry";
    }
    queue = queue.filter((r) => !ids.has(r.id));
    await persist();
    // 보내는 사이 새로 쌓인 것이 있으면 이어서 보낸다
    if (result === "sent" && queue.length) setTimeout(() => void flushErrors(), 0);
    return result;
  })()
    .catch((): FlushResult => "retry")
    .finally(() => {
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
      const saved = reportError(fatal ? "fatal" : "js", e);
      // 강제 종료는 기기에 적을 시간을 준 뒤 원래 처리로 (그대로 넘기면 적기 전에 앱이 끝난다)
      if (fatal) void within(saved, FATAL_WAIT_MS).finally(() => prev(e, fatal));
      else prev(e, fatal);
    });
  }
  // 개발 모드에서는 RN 이 LogBox 용 추적기를 이미 달아 두므로 덮어쓰지 않는다(릴리스 빌드에서만)
  if (!__DEV__) {
    try {
      g.HermesInternal?.enablePromiseRejectionTracker?.({ allRejections: true, onUnhandled: (_id, e) => void reportError("promise", e) });
    } catch {
      /* 지원 안 하는 엔진 */
    }
  }
  if (Platform.OS === "web" && typeof g.addEventListener === "function") {
    g.addEventListener("error", (ev) => void reportError("js", ev.error ?? ev.message));
    g.addEventListener("unhandledrejection", (ev) => void reportError("promise", ev.reason));
  }
  void loadQueue().then(() => flushErrors());
}
