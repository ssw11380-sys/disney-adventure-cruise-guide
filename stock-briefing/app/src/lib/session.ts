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
/**
 * 서버에 알리지 못한 로그아웃 (인터넷이 끊긴 채 로그아웃) — 서버 주소와 그 세션 토큰. 다음에 앱이 켜지거나 앞으로 돌아왔을 때 다시 알린다
 * (서버 세션이 살아 있으면 그 세션으로 등록한 기기로 알림이 계속 가므로). 서버가 받으면 지운다
 */
export const PENDING_LOGOUT_KEY = "auth.pendingLogout.v1";
const PENDING_MAX = 5;
/** API가 없는 부팅·위젯 읽기도 끝나야 한다. 앱의 건강 확인 요청과 같은 8초 상한이다. */
export const SESSION_READ_TIMEOUT_MS = 8_000;

export type EndReason = "invalid" | "logout";

let storage: KeyValueStorage | null = null;
let current: StoredSession | null = null;
let seen: { apiUrl: string; on: boolean } | null = null;
let loading: { promise: Promise<void>; cancel: (error: SessionReadError) => void } | null = null;
let loaded = false;
let loadFailed = false;
let identityVersion = 0;
let ended: EndReason | null = null;
/** 로그인·가입이 404(예전 서버·플래그 꺼짐)였던 서버 주소 — 이번 실행 동안 로그인 없이 지금처럼 (fail-open) */
let failOpen: string | null = null;
/** 처음 비밀번호로 로그인한 직후 권유 시트를 한 번 */
let initialPrompt = false;
let pendingLogouts: { apiUrl: string; token: string }[] = [];
/** 폐기 실패 뒤 같은 실행에서 저장소를 다시 끼워도 앞 인증값을 되살리지 않는다. 토큰은 메모리에만 둔다. */
const discardedTokens = new Set<string>();
/** 앱이 지금 쓰는 서버 주소 (관문 lib/authGate 가 설정에서 읽어 알려 준다 — 화면 안내용). 모르면 null */
let activeServer: string | null = null;
let version = 0;
const listeners = new Set<() => void>();
/** 계정이 바뀔 때 부르는 함수 (앱 캐시·위젯 데이터 비우기) — 테스트가 모듈 상태를 지워도 남긴다 (모듈을 읽을 때 한 번 끼우는 쪽이 있다) */
const accountHooks = new Set<(next: StoredSession | null, prev: StoredSession | null) => void>();

/** 누구의 세션인지 (서버 주소 + 사용자). 같은 사람이 다시 로그인하면 같다 */
const accountKey = (s: StoredSession | null): string | null => (s ? `${clean(s.apiUrl)}|${s.user.id}` : null);

/**
 * 계정이 바뀌면(다른 사람으로 로그인·로그아웃·세션 끊김) fn 을 부른다 — 세션을 저장·지우는 **그 자리에서, 화면을 다시 그리기 전에** 동기로.
 * 앱은 여기서 react-query·기기 저장 캐시를 비워 다음 사람에게 앞 사람의 잔고가 한 순간도 그려지지 않게 하고, 위젯 데이터도 지운다.
 * 저장된 세션을 켤 때 읽어 오는 것(loadSession)은 바뀜이 아니다. 해제 함수를 돌려준다
 */
export function onAccountChange(fn: (next: StoredSession | null, prev: StoredSession | null) => void): () => void {
  accountHooks.add(fn);
  return () => void accountHooks.delete(fn);
}

function accountChanged(prev: StoredSession | null, next: StoredSession | null): void {
  if (accountKey(prev) === accountKey(next)) return;
  for (const f of [...accountHooks]) {
    try {
      f(next, prev);
    } catch {
      /* 비우기 실패가 로그인·로그아웃을 막지 않게 */
    }
  }
}

const clean = (url: string) => url.trim().replace(/\/+$/, "");
export const sameServer = (a: string, b: string): boolean => clean(a) === clean(b);

function emit(): void {
  version++;
  for (const l of [...listeners]) l();
}

/** 저장소 오류를 서버 연결 오류나 로그인 해제로 바꾸지 않는다. 내부 저장값·오류 내용은 싣지 않는다. */
export class SessionReadError extends Error {
  constructor(public readonly code: "SESSION_STORAGE" | "SESSION_CHANGED" = "SESSION_STORAGE", message = "저장된 로그인 정보를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.") {
    super(message);
    this.name = "SessionReadError";
  }
}

/** 로컬 폐기 자체가 실패한 경우. 네트워크 오류나 로그아웃 완료로 숨기지 않는다. */
export class SessionPersistenceError extends Error {
  readonly code = "SESSION_PERSISTENCE";
  constructor() {
    super("기기에 남은 로그인 정보를 지우지 못했어요. 이번 실행에서는 사용하지 않지만, 앱을 다시 열면 앞 계정이 돌아올 수 있어요. 기기 저장 상태를 확인한 뒤 다시 로그인해 주세요.");
    this.name = "SessionPersistenceError";
  }
}

const tokenKey = (s: { apiUrl: string; token: string }) => `${clean(s.apiUrl)}\0${s.token}`;
/** 아직 디스크에 남은 인증값의 폐기 표식은 최근 항목 제한으로 밀어내지 않는다. */
function boundedLogouts(list: typeof pendingLogouts, held: StoredSession | null): typeof pendingLogouts {
  const protectedEntry = held ? list.find((p) => tokenKey(p) === tokenKey(held)) : undefined;
  const recent = list.filter((p) => p !== protectedEntry).slice(-(PENDING_MAX - (protectedEntry ? 1 : 0)));
  return protectedEntry ? [protectedEntry, ...recent] : recent;
}

/** 비동기 작업이 시작한 로그인 경계. 사용자 정보 갱신은 유지하고 로그인·로그아웃·저장소 교체만 바뀐다. */
export function sessionIdentityVersion(): number { return identityVersion; }
export function assertSessionIdentity(version: number): void {
  if (version !== identityVersion) throw new SessionReadError("SESSION_CHANGED", "로그인 정보가 바뀌었습니다. 다시 시도해 주세요.");
}

function invalidateSessionRead() {
  identityVersion++;
  const previous = loading;
  loading = null;
  previous?.cancel(new SessionReadError("SESSION_CHANGED", "로그인 정보가 바뀌었습니다. 다시 시도해 주세요."));
}

/** 저장소를 끼운다 (앱 시작·위젯 작업). 다시 끼우면 다시 읽는다 */
export function installSessionStorage(s: KeyValueStorage | null): void {
  invalidateSessionRead();
  storage = s;
  loaded = false;
  loadFailed = false;
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
 * 저장된 세션·기기 표시·못 알린 로그아웃을 한 번 읽는다 (여러 번 불러도 한 번). 저장소가 없으면(테스트) 바로 끝.
 * 시작 화면용 호출은 오류를 던지지 않는다. API 요청은 readSession으로 오류를 받고 다음 요청에서 다시 읽는다.
 */
export async function loadSession(): Promise<void> {
  await readSession().catch(() => undefined);
}

/** 같은 읽기를 공유하되 기한이 지나면 버린다. 기기 읽기 자체는 취소할 수 없어 늦은 결과의 적용을 막는다. */
function readSession(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new SessionReadError());
  if (loaded && !loadFailed) return Promise.resolve();
  if (!storage) {
    loaded = true;
    return Promise.resolve();
  }
  const s = storage;
  if (!loading) {
    let resolve!: () => void;
    let reject!: (error: SessionReadError) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const attempt = { promise, cancel: (error: SessionReadError) => finish(error) };
    const finish = (error?: SessionReadError) => {
      clearTimeout(timer);
      if (loading === attempt) {
        loading = null;
        loaded = true;
        loadFailed = !!error;
        emit();
      }
      if (error) reject(error);
      else resolve();
    };
    loading = attempt;
    timer = setTimeout(() => finish(new SessionReadError("SESSION_STORAGE", "저장된 로그인 정보를 읽는 시간이 초과됐습니다. 다시 시도해 주세요.")), SESSION_READ_TIMEOUT_MS);
    void Promise.resolve().then(async () => {
      try {
        const [rawSession, rawDevice, rawPending] = await Promise.all([s.getItem(SESSION_KEY), s.getItem(DEVICE_KEY), s.getItem(PENDING_LOGOUT_KEY)]);
        if (loading !== attempt) return;
        const restored = parseSession(rawSession);
        const list: unknown = JSON.parse(rawPending ?? "[]");
        if (!Array.isArray(list) || list.some((x) => !x || typeof x.apiUrl !== "string" || typeof x.token !== "string" || !x.token)) throw new SessionReadError();
        const read = list as typeof pendingLogouts;
        pendingLogouts = boundedLogouts([...pendingLogouts, ...read.filter((x) => !pendingLogouts.some((p) => tokenKey(p) === tokenKey(x)))], restored);
        // 읽는 사이 로그인했으면 그 세션을 둔다. 폐기 근거 손상은 빈 목록으로 해석하지 않는다.
        const discarded = restored && (discardedTokens.has(tokenKey(restored)) || pendingLogouts.some((p) => sameServer(p.apiUrl, restored.apiUrl) && p.token === restored.token));
        if (discarded) {
          discardedTokens.add(tokenKey(restored));
          ended = "logout";
          seen ??= { apiUrl: restored.apiUrl, on: true };
        } else current ??= restored;
        if (!seen && rawDevice) {
          try {
            const d = JSON.parse(rawDevice) as { apiUrl?: unknown; accountsSeen?: unknown };
            if (typeof d.apiUrl === "string") seen = { apiUrl: d.apiUrl, on: d.accountsSeen === true };
          } catch {
            /* 무시 */
          }
        }
        finish();
      } catch {
        finish(new SessionReadError());
      }
    });
  }
  const attempt = loading;
  if (!signal) return attempt.promise;
  const onAbort = () => attempt.cancel(new SessionReadError("SESSION_STORAGE", "저장된 로그인 정보를 읽는 시간이 초과됐습니다. 다시 시도해 주세요."));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return attempt.promise.finally(() => signal.removeEventListener("abort", onAbort));
}

export function sessionLoaded(): boolean {
  return loaded;
}

/** 이 서버 주소의 세션 (없으면 null). 읽기 전에는 null */
export function sessionFor(apiUrl: string): StoredSession | null {
  return current && sameServer(current.apiUrl, apiUrl) ? current : null;
}

/** 앱이 지금 쓰는 서버 주소를 알려 준다 (관문이 그릴 때마다 — 값만 적고 알림은 하지 않는다) */
export function noteActiveServer(apiUrl: string): void {
  activeServer = clean(apiUrl);
}

/** 지금 서버 주소의 세션 (서버 주소를 아직 모르면 지금 세션) */
export function activeSession(): StoredSession | null {
  return activeServer === null ? current : sessionFor(activeServer);
}

/** 지금 로그인한 세션 (서버 주소와 상관없이 — 화면 안내용. 요청에는 sessionFor 로 그 서버 것만) */
export function currentSession(): StoredSession | null {
  return current;
}

/**
 * 이 서버의 개인 데이터(잔고 캐시)를 기기에 적어도 되는지 — 자동 로그인을 끈 세션이면 false (앱을 완전히 닫으면 세션과 함께 사라지게).
 * 세션이 없으면(계정 전·플래그 꺼짐) 지금처럼 true
 */
export function persistsPersonal(apiUrl: string): boolean {
  const s = sessionFor(apiUrl);
  return !s || s.remember;
}

/** 요청에 붙일 세션 토큰 (읽기가 끝나길 기다린다) */
export async function sessionTokenFor(apiUrl: string, signal?: AbortSignal): Promise<string | null> {
  const before = identityVersion;
  await readSession(signal);
  if (before !== identityVersion) throw new SessionReadError("SESSION_CHANGED", "로그인 정보가 바뀌었습니다. 다시 시도해 주세요.");
  if (signal?.aborted) throw new SessionReadError();
  return sessionFor(apiUrl)?.token ?? null;
}

/**
 * 위젯·백그라운드 작업이 쓸 세션 (검증 4차 M1). 기기에 저장한 세션(자동 로그인 켬)만 보낸다 — stored.
 * 자동 로그인을 끈 세션(메모리에만)이면 memory: 개인 데이터를 묻지도 적지도 않는다 (위젯은 '로그인하면 보여요' — 앱을 닫으면 사라져야 할 세션이라
 * 홈 화면에 잔고를 남기지 않게. 앱이 떠 있을 때 같은 JS 로 돌아도 같다). 세션이 없으면 none (로그아웃·다시 설치 — 서버가 API 토큰만으로는 주인 데이터를 주지 않는다)
 */
export type BackgroundSession = { kind: "stored"; token: string } | { kind: "memory" } | { kind: "none" };

export async function backgroundSessionFor(apiUrl: string, signal?: AbortSignal): Promise<BackgroundSession> {
  const before = identityVersion;
  await sessionTokenFor(apiUrl, signal);
  if (before !== identityVersion) throw new SessionReadError("SESSION_CHANGED", "로그인 정보가 바뀌었습니다. 다시 시도해 주세요.");
  const s = sessionFor(apiUrl);
  if (!s) return { kind: "none" };
  return s.remember ? { kind: "stored", token: s.token } : { kind: "memory" };
}

async function write(fn: (s: KeyValueStorage) => Promise<void>): Promise<void> {
  if (!storage) return;
  try {
    await fn(storage);
  } catch {
    /* 저장 실패해도 이번 실행 동안은 메모리로 */
  }
}

// 로그인 값의 늦은 쓰기가 로그아웃 삭제나 다음 로그인보다 나중에 남지 않게 같은 저장소 안에서만 순서를 지킨다.
// 메모리 상태·화면 전환은 이미 끝난 뒤이며, 혼자 쓰는 정상 경로는 바로 시작한다. 다른 설정 쓰기는 기다리지 않는다.
const sessionWrites = new WeakMap<KeyValueStorage, Promise<boolean>>();
async function writeSession(fn: (s: KeyValueStorage) => Promise<void>): Promise<boolean> {
  const s = storage;
  if (!s) return true;
  const execute = async () => { try { await fn(s); return true; } catch { return false; } };
  const previous = sessionWrites.get(s);
  const pending = previous ? previous.then(execute, execute) : execute();
  sessionWrites.set(s, pending);
  void pending.then(() => { if (sessionWrites.get(s) === pending) sessionWrites.delete(s); });
  return pending;
}

/** 삭제만 실패한 저장소에서는 인증값 없는 JSON으로 폐기한다. 둘 다 실패하면 바깥에서 현재 메모리 상태를 유지한다. */
async function discardStoredSession(st: KeyValueStorage): Promise<void> {
  try { await st.removeItem(SESSION_KEY); }
  catch { await st.setItem(SESSION_KEY, "null"); }
}

/** 로그인·가입 성공: 자동 로그인 켬이면 기기에 저장, 끔이면 메모리에만 (전에 저장한 세션은 지운다) */
export async function saveSession(s: Omit<StoredSession, "savedAt"> & { savedAt?: number }): Promise<void> {
  invalidateSessionRead();
  loaded = true;
  loadFailed = false;
  const prev = current;
  current = { ...s, apiUrl: clean(s.apiUrl), savedAt: s.savedAt ?? Date.now() };
  if (prev && (prev.token !== s.token || !sameServer(prev.apiUrl, s.apiUrl))) discardedTokens.add(tokenKey(prev));
  discardedTokens.delete(tokenKey(current));
  // 앞 사람의 캐시를 화면이 다시 그려지기 전에 비운다 (자동 로그인을 끈 채 앱을 닫아 세션이 없던 경우도 — 기기에 남은 캐시는 앞 사람 것일 수 있다)
  accountChanged(prev ?? null, current);
  ended = null;
  if (failOpen && sameServer(failOpen, s.apiUrl)) failOpen = null;
  seen = { apiUrl: clean(s.apiUrl), on: true };
  emit();
  const saved = current;
  const identity = identityVersion;
  const persisted = await writeSession(async (st) => {
    if (saved.remember) {
      try { await st.setItem(SESSION_KEY, JSON.stringify(saved)); }
      catch {
        // 자동 로그인 저장 실패를 성공으로 취급하면 위젯이 앞 계정의 저장값을 읽는다.
        // 이 로그인은 메모리에서만 유지하고, 기존 계정의 인증값을 가능한 경로로 폐기한다.
        if (identity === identityVersion && current?.token === saved.token) {
          current = { ...current, remember: false };
          emit();
        }
        await discardStoredSession(st);
      }
    } else await discardStoredSession(st);
  });
  if (!persisted) {
    if (prev) await addPendingLogout(prev.apiUrl, prev.token);
    throw new SessionPersistenceError();
  }
  // 기기 표시는 인증값이 아니므로 이 쓰기를 기다리느라 다음 로그아웃의 세션 삭제가 밀리지 않게 한다.
  if (current?.token === saved.token && sameServer(current.apiUrl, saved.apiUrl)) {
    await write((st) => st.setItem(DEVICE_KEY, JSON.stringify({ apiUrl: saved.apiUrl, accountsSeen: true })));
  }
}

/** 서버가 준 새 사용자 정보(이메일·처음 비밀번호 표시)로 바꾼다 — 토큰은 그대로 */
export async function updateSessionUser(apiUrl: string, user: AccountUser): Promise<void> {
  const s = sessionFor(apiUrl);
  if (!s || s.user.id !== user.id) return;
  current = { ...s, user };
  emit();
  const saved = current;
  const identity = identityVersion;
  if (saved.remember) await writeSession(async (st) => {
    // 대기 중 로그인 저장이 실패해 메모리 전용으로 바뀌었다면 앞서 캡처한 인증값을 다시 남기지 않는다.
    if (identity !== identityVersion || current?.token !== saved.token || !current.remember) return;
    await st.setItem(SESSION_KEY, JSON.stringify(saved));
  });
}

/** 세션을 지운다 (직접 로그아웃·세션 끊김). 기기 표시(계정 모드를 봄)는 남긴다 — 다음에 로그인 화면이 나오게 */
export async function clearSession(reason: EndReason): Promise<void> {
  const wasReading = !!loading;
  invalidateSessionRead();
  loaded = true;
  loadFailed = false;
  if (!current) { if (wasReading) emit(); return; }
  const prev = current;
  current = null;
  discardedTokens.add(tokenKey(prev));
  ended = reason;
  accountChanged(prev, null);
  emit();
  if (!(await writeSession(discardStoredSession))) {
    // 세션 키만 손상된 경우에는 다른 키의 폐기 표식으로 다음 시작의 복원을 막는다.
    await addPendingLogout(prev.apiUrl, prev.token);
    throw new SessionPersistenceError();
  }
}

/**
 * 서버가 401 session_invalid 를 줬을 때 (api/client). 보낸 토큰이 지금 토큰과 같을 때만 로그아웃 —
 * 다시 로그인한 뒤 늦게 도착한 옛 요청의 응답이 새 세션을 지우지 않게. 지웠으면 true
 */
export function handleSessionInvalid(apiUrl: string, sentToken: string | null | undefined): boolean {
  const s = sessionFor(apiUrl);
  if (!s || !sentToken || s.token !== sentToken) return false;
  void clearSession("invalid").catch(() => undefined); // 메모리에서는 이미 폐기했다. 401 처리의 미처리 거부를 만들지 않는다.
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

/**
 * 이 서버에서 로그인이 필요한지 (계정 모드를 봤고 이 서버의 세션이 없음 — 예전 서버 fail-open 빼고). 로그인 화면이 떠 있는 동안
 * 기능 플래그 30초 묻기·가격 알림을 멈추는 데 쓴다 (검증 4차 — 서버는 어차피 403 을 준다). 세션을 저장·지우는 그 자리에서 바로 바뀐다
 */
export function loginRequiredFor(apiUrl: string): boolean {
  return !sessionFor(apiUrl) && accountsSeenFor(apiUrl) && !isFailOpen(apiUrl);
}

/** 주인 개인 데이터를 부르지 않아야 하는지: 로그인이 필요하거나 주인 아닌 계정 (실시간 스트림·가격 알림) */
export function personalBlocked(apiUrl: string): boolean {
  const s = sessionFor(apiUrl);
  return s ? !s.user.isOwner : loginRequiredFor(apiUrl);
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

/** 서버에 알리지 못한 로그아웃을 적어 둔다 (lib/logout — 인터넷 오류·서버 오류로 POST /api/auth/logout 이 닿지 않았을 때) */
export async function addPendingLogout(apiUrl: string, token: string): Promise<void> {
  if (token) discardedTokens.add(tokenKey({ apiUrl, token }));
  if (!token || pendingLogouts.some((p) => tokenKey(p) === tokenKey({ apiUrl, token }))) return;
  pendingLogouts = [...pendingLogouts, { apiUrl: clean(apiUrl), token }];
  if (!storage) { pendingLogouts = boundedLogouts(pendingLogouts, null); return; }
  await writeSession(async (st) => {
    const held = parseSession(await st.getItem(SESSION_KEY));
    pendingLogouts = boundedLogouts(pendingLogouts, held);
    await st.setItem(PENDING_LOGOUT_KEY, JSON.stringify(pendingLogouts));
  });
}

/** 이 서버에 다시 알려야 할 로그아웃 세션 토큰 (읽기가 끝나길 기다린다) */
export async function pendingLogoutsFor(apiUrl: string): Promise<string[]> {
  await readSession();
  return pendingLogouts.filter((p) => sameServer(p.apiUrl, apiUrl)).map((p) => p.token);
}

/** 서버가 받았다(또는 이미 끝난 세션) → 지운다 */
export async function dropPendingLogout(token: string): Promise<void> {
  if (!pendingLogouts.some((p) => p.token === token)) return;
  if (!storage) { pendingLogouts = pendingLogouts.filter((p) => p.token !== token); return; }
  // 서버가 받았어도 로컬의 앞 인증값이 남아 있으면 유일한 폐기 표식을 먼저 지우지 않는다.
  // 로그인 저장과 같은 큐 안에서 읽고 지워, 그 사이 저장된 새 계정을 지우지 않게 한다.
  await writeSession(async (st) => {
    const held = parseSession(await st.getItem(SESSION_KEY));
    if (held?.token === token && pendingLogouts.some((p) => p.token === token && sameServer(p.apiUrl, held.apiUrl))) await discardStoredSession(st);
    const saved = pendingLogouts.filter((p) => p.token !== token);
    if (saved.length) await st.setItem(PENDING_LOGOUT_KEY, JSON.stringify(saved));
    else await st.removeItem(PENDING_LOGOUT_KEY);
    // 저장 성공 뒤 메모리에서도 지운다. 그 사이 추가된 다른 폐기 표식은 보존한다.
    pendingLogouts = pendingLogouts.filter((p) => p.token !== token);
  });
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
  invalidateSessionRead();
  storage = null;
  current = null;
  seen = null;
  loading = null;
  loaded = false;
  loadFailed = false;
  ended = null;
  failOpen = null;
  initialPrompt = false;
  pendingLogouts = [];
  discardedTokens.clear();
  activeServer = null;
  version = 0;
  listeners.clear();
}
