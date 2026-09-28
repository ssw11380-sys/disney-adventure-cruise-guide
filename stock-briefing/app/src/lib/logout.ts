import { ApiRequestError, type Api } from "@/api/client";
import { addPendingLogout, clearSession, dropPendingLogout, pendingLogoutsFor, sessionFor } from "./session";

/**
 * 직접 로그아웃 (계정 A단계, 설정 > 계정).
 *  - 주인 계정이면 먼저 이 기기의 알림 등록을 서버에서 뺀다 (로그아웃한 폰으로 주인 브리핑 알림이 가지 않게 — 앱 루트가 setBeforeLogout 으로 끼운다, 5초까지만 기다림).
 *    못 빼도 서버가 로그아웃할 때 이 세션으로 등록한 기기를 지운다. 기기에 적어 둔 알림 토큰은 남긴다 — 주인으로 다시 로그인하면 그대로 다시 등록 (setPushRebind)
 *  - 이 기기만: 서버에 알리고(실패해도 진행) 저장한 세션을 지운다. 인터넷·서버 오류로 알리지 못했으면 그 세션 토큰을 적어 두고
 *    다음에 앱이 켜지거나 앞으로 돌아왔을 때 다시 알린다 (flushPendingLogouts — 서버 세션이 살아 있으면 그 세션의 기기로 알림이 계속 가므로)
 *  - 모든 기기: 서버가 모든 세션을 끊어야 하므로, 서버 요청이 실패하면 오류를 던지고 아무것도 지우지 않는다
 *  - 주인 아닌 계정인데 서버가 로그아웃 주소를 모르면(404 — 로그인 기능이 꺼진 비상 모드) 세션을 **지우지 않고** 던진다 (검증 5차):
 *    비상 모드 서버는 세션 머리글이 없는 요청을 API 토큰만으로 주인으로 보므로, 세션을 잊으면 그 폰에 주인 잔고·브리핑이 보인다.
 *    세션을 계속 보내야 서버가 그 계정으로 막는다 (설정의 계정 칸도 비상 모드에서는 [로그아웃]을 보이지 않는다)
 */
let beforeLogout: ((api: Api) => Promise<void>) | null = null;
let pushRebind: ((api: Api) => Promise<void>) | null = null;

export function setBeforeLogout(fn: ((api: Api) => Promise<void>) | null): void {
  beforeLogout = fn;
}

/**
 * 알림을 켜 둔 기기를 지금 세션으로 다시 등록하는 함수 (앱 루트가 끼운다 — 이 모듈이 알림 모듈을 불러오지 않게).
 * 주인으로 로그인한 뒤(AuthBridge)와 비밀번호를 바꾼 뒤(서버가 계정 전 등록을 지운다) 부른다
 */
export function setPushRebind(fn: ((api: Api) => Promise<void>) | null): void {
  pushRebind = fn;
}

/** 알림 등록 다시 묶기 (실패해도 조용히 — 다음 로그인·앱 실행 때 다시) */
export async function rebindPushNow(api: Api): Promise<void> {
  if (!pushRebind) return;
  await pushRebind(api).catch(() => undefined);
}

async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p.catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

export async function logout(api: Api, apiUrl: string, all = false): Promise<void> {
  const s = sessionFor(apiUrl);
  if (!s) return;
  if (s.user.isOwner && beforeLogout) await within(beforeLogout(api), 5_000);
  if (all) await api.logoutAll();
  else
    await api.logout().catch((e: unknown) => {
      if (!s.user.isOwner && e instanceof ApiRequestError && e.status === 404) throw new LogoutUnavailableError();
      return reachedServer(e) ? undefined : addPendingLogout(apiUrl, s.token);
    });
  await clearSession("logout");
}

/** 로그인 기능이 꺼진 서버(비상 모드)에서 주인 아닌 계정이 로그아웃하려 함 — 세션을 지우지 않았다 */
export class LogoutUnavailableError extends Error {
  constructor() {
    super("로그인 기능이 잠시 꺼져 있어 지금은 로그아웃할 수 없어요. 다시 켜지면 로그아웃할 수 있어요.");
    this.name = "LogoutUnavailableError";
  }
}

/** 서버가 답한 오류(4xx — 세션이 이미 끝남 등)면 true. 인터넷 오류·시간 초과·5xx·모르는 오류는 false (다시 알려야 한다) */
function reachedServer(e: unknown): boolean {
  return e instanceof ApiRequestError && e.status >= 400 && e.status < 500;
}

/** 알리지 못했던 로그아웃을 다시 알린다 (앱 루트가 켤 때·앞으로 돌아왔을 때). 서버가 답하면(끝남·이미 끝난 세션) 지우고, 닿지 않으면 남긴다 */
export async function flushPendingLogouts(api: Api, apiUrl: string): Promise<void> {
  for (const token of await pendingLogoutsFor(apiUrl)) {
    try {
      await api.logoutSession(token);
      await dropPendingLogout(token);
    } catch (e) {
      if (reachedServer(e)) await dropPendingLogout(token);
    }
  }
}
