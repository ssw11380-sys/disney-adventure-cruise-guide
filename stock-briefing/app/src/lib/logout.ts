import type { Api } from "@/api/client";
import { clearSession, sessionFor } from "./session";

/**
 * 직접 로그아웃 (계정 A단계, 설정 > 계정).
 *  - 주인 계정이면 먼저 이 기기의 알림 등록을 서버에서 뺀다 (로그아웃한 폰으로 주인 브리핑 알림이 가지 않게 — 앱 루트가 setBeforeLogout 으로 끼운다, 5초까지만 기다림)
 *  - 이 기기만: 서버에 알리고(실패해도 진행) 저장한 세션을 지운다
 *  - 모든 기기: 서버가 모든 세션을 끊어야 하므로, 서버 요청이 실패하면 오류를 던지고 아무것도 지우지 않는다
 */
let beforeLogout: ((api: Api) => Promise<void>) | null = null;

export function setBeforeLogout(fn: ((api: Api) => Promise<void>) | null): void {
  beforeLogout = fn;
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
  else await api.logout().catch(() => undefined);
  await clearSession("logout");
}
