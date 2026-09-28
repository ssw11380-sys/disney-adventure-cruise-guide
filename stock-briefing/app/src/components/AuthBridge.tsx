import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useApi } from "@/api/hooks";
import { condReset } from "@/api/condCache";
import { useSessionVersion } from "@/lib/account";
import { useAccountsFlag } from "@/lib/authGate";
import { flushPendingLogouts, rebindPushNow } from "@/lib/logout";
import { queryPersister } from "@/lib/queryPersist";
import { markAccountsSeen, onAccountChange, sessionFor, updateSessionUser } from "@/lib/session";
import { useSettings } from "@/lib/settings";

/** /api/auth/me 로 사용자 정보(이메일·처음 비밀번호 표시)를 다시 받는 간격 — 앱을 켤 때 한 번, 앞으로 돌아왔을 때 이만큼 지났으면 */
const ME_EVERY_MS = 6 * 3_600_000;

/**
 * 계정 A단계의 앱 루트 연결 (app/_layout 이 providers 안에 둔다).
 *  - 받은 플래그 accounts 를 기기에 기억 (오프라인으로 켜도 로그인 화면을 알맞게 — lib/session DEVICE_KEY). 설정(서버 주소)을 다 읽은 뒤에만 —
 *    읽기 전에는 번들 기본 주소라, 다른 서버에서 본 표시를 덮어쓰지 않게
 *  - 계정이 바뀌면(로그인·로그아웃·다른 사람) react-query 캐시·기기 저장 캐시·조건부 요청 기억을 비운다. 세션을 저장·지우는 그 자리에서
 *    (lib/session onAccountChange — 화면을 다시 그리기 전에) 비우므로 다른 사람의 잔고가 한 순간도 그려지지 않는다
 *  - 주인으로 로그인하면(새 세션) 이 기기의 알림 등록을 새 세션에 다시 묶는다 — 알림을 켜 둔 기기만 (서버는 세션을 끊을 때 그 등록을 지운다).
 *    자동 로그인을 끈 세션이면 묶지 않는다 (검증 5차: 앱을 닫으면 로그아웃되는 폰에 최대 12시간 주인 브리핑·계좌 요약 푸시가 가지 않게 — 위젯·백그라운드 알림과 같은 규칙.
 *    서버도 그런 세션의 기기에는 보내지 않는다)
 *  - 로그인 정보 새로 받기 (/api/auth/me). 실패해도 아무것도 하지 않는다 — 로그아웃은 401 session_invalid 일 때만 (api/client)
 *  - 인터넷이 끊긴 채 로그아웃해 서버에 알리지 못한 세션을 켤 때·앞으로 돌아왔을 때 다시 알린다 (lib/logout flushPendingLogouts)
 */
export function AuthBridge() {
  const { apiUrl, ready } = useSettings();
  const flag = useAccountsFlag();
  const qc = useQueryClient();
  const api = useApi();
  useSessionVersion();
  const session = sessionFor(apiUrl);

  useEffect(() => {
    if (ready && flag !== null) markAccountsSeen(apiUrl, flag);
  }, [ready, flag, apiUrl]);

  useEffect(
    () =>
      onAccountChange(() => {
        qc.clear();
        void queryPersister.removeClient();
        condReset();
      }),
    [qc],
  );

  useEffect(() => {
    if (!ready) return;
    void flushPendingLogouts(api, apiUrl);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void flushPendingLogouts(api, apiUrl);
    });
    return () => sub.remove();
  }, [ready, api, apiUrl]);

  const token = session?.token ?? null;
  const owner = session?.user.isOwner === true;
  const remember = session?.remember === true;
  useEffect(() => {
    if (!token || !owner || !remember || flag === false) return;
    void rebindPushNow(api);
  }, [token, owner, remember, flag, api]);

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
