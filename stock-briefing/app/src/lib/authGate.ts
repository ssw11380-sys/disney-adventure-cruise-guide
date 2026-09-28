import { useFeatures } from "@/api/hooks";
import { useSessionVersion } from "./account";
import { featureOn } from "./features";
import { accountsSeenFor, isFailOpen, sessionFor, sessionLoaded, type StoredSession } from "./session";
import { useSettings } from "./settings";

/**
 * 로그인 화면을 보일지 (계정 A단계, 앱 루트 _layout 의 Stack.Protected 가 쓴다).
 *  - 이 서버 주소의 세션이 있으면 → 바로 앱 (서버에 닿지 않아도 — 인터넷이 없어도 로그아웃되지 않는다)
 *  - 세션이 없고 계정 모드면 → 로그인 화면. 계정 모드 = 받은 플래그 accounts(없으면 이 기기가 이 서버에서 계정 모드를 본 적 있는지)
 *  - 그 밖(예전 서버·플래그 꺼짐·모름) → 지금처럼 로그인 없이
 *  - 로그인·가입이 우리 서버의 404(예전 서버)였으면 이번 실행 동안 로그인 없이 (fail-open)
 * 저장된 설정·세션을 다 읽기 전(ready=false)에는 로그인 화면으로 바꾸지 않는다 (스플래시가 가린다)
 */
export interface AuthGate {
  ready: boolean;
  on: boolean;
  needsLogin: boolean;
  session: StoredSession | null;
}

export function gateOf(o: { settingsReady: boolean; loaded: boolean; flag: boolean | null; seen: boolean; failOpen: boolean; session: StoredSession | null }): AuthGate {
  const on = !o.failOpen && (o.flag ?? o.seen);
  const ready = o.settingsReady && o.loaded;
  return { ready, on, session: o.session, needsLogin: ready && on && !o.session };
}

/** 받은 플래그 (없으면 null = 모름) */
export function useAccountsFlag(): boolean | null {
  const features = useFeatures();
  return features.data ? featureOn(features.data, "accounts", false) : null;
}

export function useAuthGate(): AuthGate {
  const { apiUrl, ready } = useSettings();
  const flag = useAccountsFlag();
  useSessionVersion();
  return gateOf({ settingsReady: ready, loaded: sessionLoaded(), flag, seen: accountsSeenFor(apiUrl), failOpen: isFailOpen(apiUrl), session: sessionFor(apiUrl) });
}
