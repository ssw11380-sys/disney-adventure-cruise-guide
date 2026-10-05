import { useIsFocused } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { useApi, useFeature } from "@/api/hooks";
import { useAccountView } from "@/lib/account";
import { useSettings } from "@/lib/settings";
import { sessionIdentityVersion, subscribeSession } from "@/lib/session";

let nextScope = 0;
/** 인증값 자체를 캐시 키에 넣지 않고, 인증이 바뀌면 개인 목록을 새 범위에서 읽는다. */
export function useWatchScope() {
  const { apiUrl, apiToken } = useSettings();
  const identity = useSyncExternalStore(subscribeSession, sessionIdentityVersion);
  return useMemo(() => { void apiToken; return [apiUrl, "watchlist", ++nextScope, identity] as const; }, [apiUrl, apiToken, identity]);
}
export function useWatchlist() {
  const api = useApi(), key = useWatchScope();
  const enabled = useFeature("watchlistSteps", false);
  const { member } = useAccountView();
  const focused = useIsFocused();
  const query = useQuery({ queryKey: key, queryFn: api.watchlist, enabled: enabled && !member, subscribed: focused,
    staleTime: 10_000, refetchInterval: 30_000, refetchIntervalInBackground: false, retry: 0 });
  return { ...query, available: enabled && !member };
}
