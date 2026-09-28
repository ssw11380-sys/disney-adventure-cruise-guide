import { useSyncExternalStore } from "react";
import { useFeature } from "@/api/hooks";
import { activeSession, currentSession, isFailOpen, sessionVersion, subscribeSession, type StoredSession } from "./session";

/**
 * 화면이 쓰는 계정 상태 (계정 A단계, 기능 플래그 accounts — 앱 기본 꺼짐).
 *  - on: 이 서버가 계정 모드 (플래그 켜짐, 예전 서버 404 로 fail-open 한 경우 빼고)
 *  - session: 로그인한 세션 (플래그가 꺼져 있으면 null — 설정의 계정 칸이 사라진다)
 *  - member: 주인 아닌 계정 — 잔고·브리핑 탭 안내 띠, 스트림·알림 등록·첫 실행 안내를 하지 않는다
 * 플래그가 꺼져 있으면 on·session 은 꺼짐 = 지금 화면 그대로. 다만 **지금 서버에 주인 아닌 계정의 세션이 남아 있으면 member 는 켜짐** —
 * 서버는 플래그를 끄거나 비상 끄기(ACCOUNTS_DISABLED=1)를 해도 그 세션을 그 계정으로 막으므로(개인 경로 빈 값·403), 화면도 빈 잔고 대신 안내 띠를 보인다.
 * 켜져 있을 때 세션은 서버 주소와 상관없이 지금 것을 본다 — 앱 화면(탭)은 이 서버의 세션이 있을 때만 열리므로(lib/authGate) 같은 서버 것이다.
 * 꺼져 있을 때는 지금 서버 주소의 세션만 본다 (다른 서버로 바꿨으면 그 서버는 세션을 받지 않는다 — 지금 서버 주소는 관문 lib/authGate 가 알려 준다).
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

/** flag: 받은 플래그, session: 지금 세션(서버 주소 상관없이), here: 지금 서버 주소의 세션 */
export function accountViewOf(flag: boolean, session: StoredSession | null, here: StoredSession | null = session): AccountView {
  const on = flag && !(session && isFailOpen(session.apiUrl));
  const s = on ? session : null;
  const offMember = !on && !!here && !isFailOpen(here.apiUrl) && !here.user.isOwner;
  return { on, session: s, member: (!!s && !s.user.isOwner) || offMember };
}

export function useAccountView(): AccountView {
  const flag = useFeature("accounts", false);
  useSessionVersion();
  return accountViewOf(flag, currentSession(), activeSession());
}

/** 주인 아닌 계정 안내 문구 (잔고·브리핑 탭 맨 위) */
export const MEMBER_NOTICE = "개인 종목 기능은 준비 중이에요 — 시장·종목 정보는 지금 볼 수 있어요";

/** 주인 아닌 계정이 비중 화면을 딥링크로 열었을 때 (수량·평균 단가를 넣으라는 말·'잔고로' 버튼 없이) */
export const MEMBER_EMPTY_ALLOCATION = { title: "개인 종목 기능은 준비 중이에요", hint: "내 종목을 담는 기능이 열리면 여기에서 비중을 볼 수 있어요. 시장·종목 정보는 지금 볼 수 있어요." } as const;

/** 주인 아닌 계정의 브리핑 탭 빈 칸 (종목을 추가하라는 말·버튼 없이) */
export const MEMBER_EMPTY_BRIEFINGS = { title: "종목 브리핑은 준비 중이에요", hint: "내 종목을 담는 기능이 열리면 여기에 종목마다 브리핑이 쌓여요." } as const;
