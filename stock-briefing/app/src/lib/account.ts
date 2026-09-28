import { useSyncExternalStore } from "react";
import { useFeature } from "@/api/hooks";
import { currentSession, isFailOpen, sessionVersion, subscribeSession, type StoredSession } from "./session";

/**
 * 화면이 쓰는 계정 상태 (계정 A단계, 기능 플래그 accounts — 앱 기본 꺼짐).
 *  - on: 이 서버가 계정 모드 (플래그 켜짐, 예전 서버 404 로 fail-open 한 경우 빼고)
 *  - session: 로그인한 세션 (플래그가 꺼져 있으면 null — 설정의 계정 칸이 사라진다)
 *  - member: 주인 아닌 계정 — 잔고·브리핑 탭 안내 띠, 스트림·알림 등록·첫 실행 안내를 하지 않는다
 * 플래그가 꺼져 있으면 모두 꺼짐 = 지금 화면 그대로.
 * 세션은 서버 주소와 상관없이 지금 것을 본다 — 앱 화면(탭)은 이 서버의 세션이 있을 때만 열리므로(lib/authGate) 같은 서버 것이다.
 * (lib/settings 를 부르지 않는다 — 탭 화면 테스트가 설정 모듈 없이 그린다)
 */
export interface AccountView {
  on: boolean;
  session: StoredSession | null;
  member: boolean;
}

export function useSessionVersion(): number {
  return useSyncExternalStore(subscribeSession, sessionVersion, sessionVersion);
}

export function accountViewOf(flag: boolean, session: StoredSession | null): AccountView {
  const on = flag && !(session && isFailOpen(session.apiUrl));
  const s = on ? session : null;
  return { on, session: s, member: !!s && !s.user.isOwner };
}

export function useAccountView(): AccountView {
  const flag = useFeature("accounts", false);
  useSessionVersion();
  return accountViewOf(flag, currentSession());
}

/** 주인 아닌 계정 안내 문구 (잔고·브리핑 탭 맨 위) */
export const MEMBER_NOTICE = "개인 종목 기능은 준비 중이에요 — 시장·종목 정보는 지금 볼 수 있어요";
