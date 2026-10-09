import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useApi } from "@/api/hooks";
import { currentCredentials, useSettings } from "./settings";
import { sessionIdentityVersion, sessionVersion, subscribeSession } from "./session";
import { createTossImportFlow } from "./tossImport";

type Scope = { apiUrl: string; apiToken: string; identity: number; ready: boolean; flow: ReturnType<typeof createTossImportFlow> };
const flows = new WeakMap<QueryClient, Scope>();

/** 두 진입점이 같은 진행 상태·완료 안내·개별 복원을 공유한다. 네트워크 조회는 사용자가 누를 때만 한다. */
export function useTossImportFlow() {
  const api = useApi();
  const qc = useQueryClient();
  const { apiUrl, apiToken, ready } = useSettings();
  useSyncExternalStore(subscribeSession, sessionVersion, sessionVersion);
  const identity = sessionIdentityVersion();
  let scope = flows.get(qc);
  if (!scope || scope.apiUrl !== apiUrl || scope.apiToken !== apiToken || scope.identity !== identity || scope.ready !== ready) {
    scope = { apiUrl, apiToken, identity, ready, flow: createTossImportFlow({
      api,
      isCurrent: () => {
        const current = currentCredentials();
        return ready && current.apiUrl === apiUrl && current.apiToken === apiToken && sessionIdentityVersion() === identity;
      },
      invalidate: () => {
        for (const key of ["stocks", "briefings", "tossStatus", "tossAccountSnapshot"]) void qc.invalidateQueries({ queryKey: [apiUrl, key] });
      },
    }) };
    flows.set(qc, scope);
  }
  const state = useSyncExternalStore(scope.flow.subscribe, scope.flow.snapshot, scope.flow.snapshot);
  return { ...state, run: scope.flow.run };
}
