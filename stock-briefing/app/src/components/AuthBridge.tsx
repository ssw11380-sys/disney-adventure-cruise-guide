import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useApi } from "@/api/hooks";
import { condReset } from "@/api/condCache";
import { useSessionVersion } from "@/lib/account";
import { useAccountsFlag } from "@/lib/authGate";
import { queryPersister } from "@/lib/queryPersist";
import { markAccountsSeen, sessionFor, sessionLoaded, updateSessionUser } from "@/lib/session";
import { useSettings } from "@/lib/settings";

/** /api/auth/me 로 사용자 정보(이메일·처음 비밀번호 표시)를 다시 받는 간격 — 앱을 켤 때 한 번, 앞으로 돌아왔을 때 이만큼 지났으면 */
const ME_EVERY_MS = 6 * 3_600_000;

/**
 * 계정 A단계의 앱 루트 연결 (app/_layout 이 providers 안에 둔다).
 *  - 받은 플래그 accounts 를 기기에 기억 (오프라인으로 켜도 로그인 화면을 알맞게 — lib/session DEVICE_KEY)
 *  - 계정이 바뀌면(로그인·로그아웃·다른 사람) react-query 캐시·기기 저장 캐시·조건부 요청 기억을 비운다 → 다른 사람의 잔고가 한 순간도 보이지 않게
 *  - 로그인 정보 새로 받기 (/api/auth/me). 실패해도 아무것도 하지 않는다 — 로그아웃은 401 session_invalid 일 때만 (api/client)
 */
export function AuthBridge() {
  const { apiUrl, ready } = useSettings();
  const flag = useAccountsFlag();
  const qc = useQueryClient();
  const api = useApi();
  useSessionVersion();
  const session = sessionFor(apiUrl);
  const loaded = sessionLoaded();

  useEffect(() => {
    if (flag !== null) markAccountsSeen(apiUrl, flag);
  }, [flag, apiUrl]);

  const key = session ? `${session.apiUrl}|${session.user.id}` : null;
  const prev = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!ready || !loaded) return;
    if (prev.current !== undefined && prev.current !== key) {
      qc.clear();
      void queryPersister.removeClient();
      condReset();
    }
    prev.current = key;
  }, [key, ready, loaded, qc]);

  const token = session?.token ?? null;
  useEffect(() => {
    if (!token || flag === false) return;
    let last = 0;
    const check = () => {
      if (Date.now() - last < ME_EVERY_MS) return;
      last = Date.now();
      void api
        .me()
        .then((r) => updateSessionUser(apiUrl, r.user))
        .catch(() => undefined);
    };
    check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") check();
    });
    return () => sub.remove();
  }, [token, apiUrl, api, flag]);
  return null;
}
