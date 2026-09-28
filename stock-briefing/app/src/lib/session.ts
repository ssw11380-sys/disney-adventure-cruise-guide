/**
 * 로그인 세션 (계정 A단계, 기능 플래그 accounts). React·React Native 를 불러오지 않는 모듈 — 앱·위젯·백그라운드 작업이 같이 쓴다.
 * 저장소는 lib/sessionStorage 가 AsyncStorage 를 끼워 준다 (테스트는 가짜를 끼우거나 메모리만).
 *
 * 가장 중요한 규칙 — "웬만해선 로그아웃되지 않게":
 *  - 자동 로그인 켬: 세션 토큰을 기기에 저장(auth.session.v1 — 키 이름을 바꾸지 않는다, OTA 뒤에도 그대로). 서버 기한 1년, 쓸 때마다 연장
 *  - 자동 로그인 끔: 메모리에만 (앱을 완전히 닫으면 다시 로그인). 서버 기한 12시간
 *  - 세션을 지우는 것은 ① 직접 로그아웃 ② 서버가 401 + code "session_invalid" 를 준 때(보낸 토큰이 지금 토큰과 같을 때만) 뿐.
 *    인터넷 오류·시간 초과·5xx·예전 서버 404·API 토큰 오류(401 UNAUTHORIZED)·403·429·503 은 절대 지우지 않는다
 *  - 세션은 그 세션을 준 서버 주소로만 보낸다 (주소가 다르면 없는 것으로)
 */

export interface AccountUser {
  id: number;
  loginId: string;
  email: string | null;
  isOwner: boolean;
  /** 처음 비밀번호(1111)를 쓰는 중 */
  usingInitialPassword: boolean;
}

export interface StoredSession {
  apiUrl: string;
  token: string;
  remember: boolean;
  user: AccountUser;
  savedAt: number;
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** 자동 로그인 세션 (자동 로그인 켬일 때만 저장) */
export const SESSION_KEY = "auth.session.v1";
/** 이 기기가 이 서버에서 계정 모드를 봤는지 (토큰 없음) — 오프라인으로 켜도 로그인 화면을 알맞게 */
export const DEVICE_KEY = "auth.device.v1";
/** '자동 로그인' 체크의 마지막 선택 */
export const REMEMBER_KEY = "auth.rememberPref.v1";

export type EndReason = "invalid" | "logout";

let storage: KeyValueStorage | null = null;
let current: StoredSession | null = null;
let seen: { apiUrl: string; on: boolean } | null = null;
let rememberPref = true;
let loading: Promise<void> | null = null;
let loaded = false;
let ended: EndReason | null = null;
/** 로그인·가입이 404(예전 서버·플래그 꺼짐)였던 서버 주소 — 이번 실행 동안 로그인 없이 지금처럼 (fail-open) */
let failOpen: string | null = null;
/** 처음 비밀번호로 로그인한 직후 권유 시트를 한 번 */
let initialPrompt = false;
let version = 0;
const listeners = new Set<() => void>();

const clean = (url: string) => url.trim().replace(/\/+$/, "");
export const sameServer = (a: string, b: string): boolean => clean(a) === clean(b);

function emit(): void {
  version++;
  for (const l of [...listeners]) l();
}

/** 저장소를 끼운다 (앱 시작·위젯 작업). 다시 끼우면 다시 읽는다 */
export function installSessionStorage(s: KeyValueStorage | null): void {
  storage = s;
  loading = null;
  loaded = false;
}

function isUser(u: unknown): u is AccountUser {
  const x = u as Partial<AccountUser> | null;
  return !!x && typeof x.id === "number" && typeof x.loginId === "string" && typeof x.isOwner === "boolean";
}

function parseSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof v.apiUrl !== "string" || typeof v.token !== "string" || !v.token || !isUser(v.user)) return null;
    return {
      apiUrl: v.apiUrl,
      token: v.token,
      remember: true,
      user: { ...v.user, email: v.user.email ?? null, usingInitialPassword: v.user.usingInitialPassword === true },
      savedAt: typeof v.savedAt === "number" ? v.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 저장된 세션·기기 표시·자동 로그인 선택을 한 번 읽는다 (여러 번 불러도 한 번). 저장소가 없으면(테스트) 바로 끝.
 * 읽기가 실패해도 저장된 값을 지우지 않는다 (다음 실행에 다시 읽는다)
 */
export function loadSession(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!storage) {
    loaded = true;
    return Promise.resolve();
  }
  const s = storage;
  loading ??= (async () => {
    try {
      const [rawSession, rawDevice, rawRemember] = await Promise.all([s.getItem(SESSION_KEY), s.getItem(DEVICE_KEY), s.getItem(REMEMBER_KEY)]);
      // 읽는 사이 로그인했으면 그 세션을 둔다
      current ??= parseSession(rawSession);
      if (!seen && rawDevice) {
        try {
          const d = JSON.parse(rawDevice) as { apiUrl?: unknown; accountsSeen?: unknown };
          if (typeof d.apiUrl === "string") seen = { apiUrl: d.apiUrl, on: d.accountsSeen === true };
        } catch {
          /* 무시 */
        }
      }
      if (rawRemember === "0") rememberPref = false;
    } catch {
      /* 읽지 못함: 세션 없이 (저장된 값은 그대로) */
    } finally {
      loaded = true;
      emit();
    }
  })();
  return loading;
}

export function sessionLoaded(): boolean {
  return loaded;
}

/** 이 서버 주소의 세션 (없으면 null). 읽기 전에는 null */
export function sessionFor(apiUrl: string): StoredSession | null {
  return current && sameServer(current.apiUrl, apiUrl) ? current : null;
}

/** 지금 로그인한 세션 (서버 주소와 상관없이 — 화면 안내용. 요청에는 sessionFor 로 그 서버 것만) */
export function currentSession(): StoredSession | null {
  return current;
}

/** 요청에 붙일 세션 토큰 (읽기가 끝나길 기다린다) */
export async function sessionTokenFor(apiUrl: string): Promise<string | null> {
  await loadSession();
  return sessionFor(apiUrl)?.token ?? null;
}

/** 직접 fetch 하는 곳(위젯·백그라운드)의 머리글 */
export async function sessionHeaders(apiUrl: string): Promise<Record<string, string>> {
  const t = await sessionTokenFor(apiUrl);
  return t ? { "x-session-token": t } : {};
}

async function write(fn: (s: KeyValueStorage) => Promise<void>): Promise<void> {
  if (!storage) return;
  try {
    await fn(storage);
  } catch {
    /* 저장 실패해도 이번 실행 동안은 메모리로 */
  }
}

/** 로그인·가입 성공: 자동 로그인 켬이면 기기에 저장, 끔이면 메모리에만 (전에 저장한 세션은 지운다) */
export async function saveSession(s: Omit<StoredSession, "savedAt"> & { savedAt?: number }): Promise<void> {
  current = { ...s, apiUrl: clean(s.apiUrl), savedAt: s.savedAt ?? Date.now() };
  ended = null;
  if (failOpen && sameServer(failOpen, s.apiUrl)) failOpen = null;
  seen = { apiUrl: clean(s.apiUrl), on: true };
  emit();
  const saved = current;
  await write(async (st) => {
    if (saved.remember) await st.setItem(SESSION_KEY, JSON.stringify(saved));
    else await st.removeItem(SESSION_KEY);
    await st.setItem(DEVICE_KEY, JSON.stringify({ apiUrl: saved.apiUrl, accountsSeen: true }));
  });
}

/** 서버가 준 새 사용자 정보(이메일·처음 비밀번호 표시)로 바꾼다 — 토큰은 그대로 */
export async function updateSessionUser(apiUrl: string, user: AccountUser): Promise<void> {
  const s = sessionFor(apiUrl);
  if (!s || s.user.id !== user.id) return;
  current = { ...s, user };
  emit();
  const saved = current;
  if (saved.remember) await write((st) => st.setItem(SESSION_KEY, JSON.stringify(saved)));
}

/** 세션을 지운다 (직접 로그아웃·세션 끊김). 기기 표시(계정 모드를 봄)는 남긴다 — 다음에 로그인 화면이 나오게 */
export async function clearSession(reason: EndReason): Promise<void> {
  if (!current) return;
  current = null;
  ended = reason;
  emit();
  await write((st) => st.removeItem(SESSION_KEY));
}

/**
 * 서버가 401 session_invalid 를 줬을 때 (api/client). 보낸 토큰이 지금 토큰과 같을 때만 로그아웃 —
 * 다시 로그인한 뒤 늦게 도착한 옛 요청의 응답이 새 세션을 지우지 않게. 지웠으면 true
 */
export function handleSessionInvalid(apiUrl: string, sentToken: string | null | undefined): boolean {
  const s = sessionFor(apiUrl);
  if (!s || !sentToken || s.token !== sentToken) return false;
  void clearSession("invalid");
  return true;
}

/** 이 서버가 계정 모드인지 기억 (플래그를 받았을 때·403 session_required 를 받았을 때) */
export function markAccountsSeen(apiUrl: string, on: boolean): void {
  if (seen && sameServer(seen.apiUrl, apiUrl) && seen.on === on) return;
  seen = { apiUrl: clean(apiUrl), on };
  emit();
  void write((st) => st.setItem(DEVICE_KEY, JSON.stringify({ apiUrl: clean(apiUrl), accountsSeen: on })));
}

export function accountsSeenFor(apiUrl: string): boolean {
  return !!seen && sameServer(seen.apiUrl, apiUrl) && seen.on;
}

/** 로그인·가입이 404: 예전 서버 → 이번 실행 동안 로그인 없이 지금처럼 */
export function markFailOpen(apiUrl: string): void {
  failOpen = clean(apiUrl);
  markAccountsSeen(apiUrl, false);
  emit();
}

export function isFailOpen(apiUrl: string): boolean {
  return !!failOpen && sameServer(failOpen, apiUrl);
}

export function rememberPreference(): boolean {
  return rememberPref;
}

export function setRememberPreference(on: boolean): void {
  rememberPref = on;
  void write((st) => st.setItem(REMEMBER_KEY, on ? "1" : "0"));
}

/** 마지막으로 세션이 끝난 까닭 (로그인 화면이 '다시 로그인해 주세요'를 한 번 보여 준다) */
export function lastEndReason(): EndReason | null {
  return ended;
}

export function requestInitialPasswordPrompt(): void {
  initialPrompt = true;
  emit();
}

export function initialPasswordPromptPending(): boolean {
  return initialPrompt;
}

export function dismissInitialPasswordPrompt(): void {
  if (!initialPrompt) return;
  initialPrompt = false;
  emit();
}

/** useSyncExternalStore 용 */
export function subscribeSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function sessionVersion(): number {
  return version;
}

/** 테스트용: 모듈 상태를 처음으로 */
export function resetSessionForTests(): void {
  storage = null;
  current = null;
  seen = null;
  rememberPref = true;
  loading = null;
  loaded = false;
  ended = null;
  failOpen = null;
  initialPrompt = false;
  version = 0;
  listeners.clear();
}
