import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Api } from "@/api/client";
import { featuresQuery, useApi, useFeatures } from "@/api/hooks";
import { useSessionVersion } from "./account";
import { featureOn } from "./features";
import { accountsSeenFor, isFailOpen, noteActiveServer, sessionFor, sessionLoaded, type StoredSession } from "./session";
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

/** 이번 실행에서 기능 플래그를 새로 받은 서버 주소 */
const freshDone = new Set<string>();
export function resetFreshFeaturesForTests(): void {
  freshDone.clear();
}

/**
 * 설정(서버 주소)을 다 읽은 뒤 그 서버 주소의 기능 플래그를 이번 실행에서 한 번 새로 받는다 (기기 저장 캐시가 30초 안 된 것이어도 — 서버 모드가
 * 바뀐 직후 앱을 켜도 옛 accounts 값을 믿지 않게). 검증 4차: 예전에는 관문이 처음 그려질 때(설정을 읽기 전 — 번들 기본 주소) 받아, 진짜 주소로
 * 바뀐 뒤에는 되살린 캐시를 그대로 믿었다. 받기 시작했으면 true
 */
export function freshFeaturesOnce(qc: QueryClient, api: Pick<Api, "features">, apiUrl: string): boolean {
  if (freshDone.has(apiUrl)) return false;
  freshDone.add(apiUrl);
  void qc.fetchQuery({ ...featuresQuery(api, apiUrl), staleTime: 0 }).catch(() => undefined);
  return true;
}

/** 받은 플래그 (없으면 null = 모름). 설정을 다 읽은 뒤 그 서버 주소로 한 번 새로 받는다 */
export function useAccountsFlag(): boolean | null {
  const { apiUrl, ready } = useSettings();
  const qc = useQueryClient();
  const api = useApi();
  const features = useFeatures();
  useEffect(() => {
    if (ready) freshFeaturesOnce(qc, api, apiUrl);
  }, [ready, apiUrl, qc, api]);
  return features.data ? featureOn(features.data, "accounts", false) : null;
}

export function useAuthGate(): AuthGate {
  const { apiUrl, ready } = useSettings();
  noteActiveServer(apiUrl); // 화면 안내(lib/account)가 지금 서버의 세션을 보게 — 값만 적는다
  const flag = useAccountsFlag();
  useSessionVersion();
  return gateOf({ settingsReady: ready, loaded: sessionLoaded(), flag, seen: accountsSeenFor(apiUrl), failOpen: isFailOpen(apiUrl), session: sessionFor(apiUrl) });
}
