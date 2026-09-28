import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback, useMemo } from "react";
import { AccessibilityInfo, Alert } from "react-native";
import { ApiRequestError } from "@/api/client";
import { useApi, useFeature } from "@/api/hooks";
import type { RegisteredWithQuote } from "@/api/types";
import { useSettings } from "@/lib/settings";
import { applyToLayout, cleanGroupName, normalizeView, saveFailText, WATCH_OFF, type WatchLayout, type WatchOp } from "@/lib/watchGroups";
import { WatchGroupsContext, WatchOpQueue, WATCH_GROUPS_OFF, type NameSave, type WatchGroupsState, type WatchOps, type WatchStatus } from "@/lib/watchGroupsQuery";
import type { WatchView } from "@/lib/watchView";

/** 캐시에는 배치만 (만들기 응답의 created 는 빼고) */
const bare = (l: WatchLayout): WatchLayout => ({ on: l.on, groups: l.groups, items: l.items });

/**
 * 관심 종목 그룹·순서 (3-34, 기능 플래그 watchGroups) 제공자 — 루트 레이아웃이 화면 전체를 감싼다.
 *  - 플래그가 꺼져 있으면 서버를 부르지 않고(쿼리 enabled: false) 아래에 꺼짐(WATCH_GROUPS_OFF)을 내려 준다 → 잔고·메뉴·밀기·화면 읽기 동작이 지금 그대로
 *  - 켜져 있으면 /api/watch-groups 배치를 받는다 (60초 동안 새것으로 보고, 앱으로 돌아올 때 다시 · 기기 캐시에 저장해 켤 때 바로 — lib/queryPersist).
 *    예전 서버의 404 는 꺼짐, 배치의 on:false(이 계정은 쓸 수 없음 등)도 꺼짐처럼
 *  - 조작은 lib/watchGroupsQuery 의 저장 차례로: 누르는 즉시 캐시를 바꾸고(lib/watchGroups applyToLayout — 서버와 같은 규칙) 차례로 보낸 뒤 마지막 응답으로 맞춘다.
 *    실패하면 '저장하지 못했습니다' 창과 서버 값으로 되돌림
 *  - 고른 칩·접은 그룹은 기기 설정(settings.watchView)
 */
export function WatchGroupsProvider({ children }: { children: React.ReactNode }) {
  const flag = useFeature("watchGroups", false);
  const api = useApi();
  const qc = useQueryClient();
  const { apiUrl, watchView, setWatchView } = useSettings();
  const key = useMemo(() => [apiUrl, "watchGroups"] as const, [apiUrl]);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      try {
        return bare(await api.watchGroups());
      } catch (e) {
        // 예전 서버(경로 없음)는 꺼짐
        if (e instanceof ApiRequestError && e.status === 404) return WATCH_OFF;
        throw e;
      }
    },
    enabled: flag,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  const layout = flag && query.data?.on ? query.data : null;
  const status: WatchStatus = !flag ? "off" : query.data ? (query.data.on ? "ready" : "off") : query.isError ? "error" : "loading";

  const queue = useMemo(
    () =>
      new WatchOpQueue({
        apply: (l) => qc.setQueryData(key, bare(l)),
        refetch: () => void qc.invalidateQueries({ queryKey: key }),
        fail: (message) => Alert.alert("저장하지 못했습니다", message, [{ text: "확인" }]),
      }),
    [qc, key],
  );
  /** 누르는 즉시 캐시를 바꾼다 (받는 중인 조회가 덮지 않게 먼저 멈춤) */
  const optimistic = useCallback(
    (op: WatchOp) => {
      const cur = qc.getQueryData<WatchLayout>(key);
      if (!cur?.on) return;
      void qc.cancelQueries({ queryKey: key });
      qc.setQueryData(key, applyToLayout(cur, qc.getQueryData<RegisteredWithQuote[]>([apiUrl, "stocks"]) ?? [], op));
    },
    [qc, key, apiUrl],
  );
  const ops = useMemo<WatchOps>(() => {
    const named = async (send: () => Promise<WatchLayout>): Promise<NameSave> => {
      try {
        const l = await queue.run(send, { quiet: true });
        // 만든 그룹: 앞선 조작이 아직 차례에 남아 있으면 이 응답은 캐시에 쓰이지 않는다(마지막 응답만) → 그룹 하나만 먼저 넣어 둔다.
        // 곧바로 이어지는 '새 그룹 만들고 옮기기'의 낙관적 옮기기가 모르는 그룹이라 '그룹 없음' 맨 앞으로 새지 않게
        const made = l.created ? l.groups.find((g) => g.id === l.created!.id) : undefined;
        const cur = qc.getQueryData<WatchLayout>(key);
        if (made && cur?.on && !cur.groups.some((g) => g.id === made.id)) qc.setQueryData(key, { ...cur, groups: [...cur.groups, made] });
        return { ok: true, ...(l.created ? { created: l.created } : null) };
      } catch (e) {
        return { ok: false, message: saveFailText(e) };
      }
    };
    return {
      move: (stock, groupId, index, speech) => {
        optimistic({ kind: "move", code: stock.code, groupId, index });
        if (speech) AccessibilityInfo.announceForAccessibility(speech);
        queue.run(() => api.moveWatchStock({ code: stock.code, groupId, index })).catch(() => undefined);
      },
      create: (name) => named(() => api.createWatchGroup(name)),
      rename: (id, name) => {
        const cur = qc.getQueryData<WatchLayout>(key);
        if (cur?.on) qc.setQueryData(key, { ...cur, groups: cur.groups.map((g) => (g.id === id ? { ...g, name: cleanGroupName(name) } : g)) });
        return named(() => api.renameWatchGroup(id, name));
      },
      remove: (id) => {
        optimistic({ kind: "delete", groupId: id });
        queue.run(() => api.deleteWatchGroup(id)).catch(() => undefined);
      },
      order: (ids) => {
        optimistic({ kind: "order", ids });
        queue.run(() => api.orderWatchGroups(ids)).catch(() => undefined);
      },
    };
  }, [api, queue, optimistic, qc, key]);

  const setView = useCallback((v: WatchView) => void setWatchView(v), [setWatchView]);
  const again = query.refetch;
  const refetch = useCallback(() => void again(), [again]);
  const view = useMemo(() => normalizeView(watchView, layout), [watchView, layout]);
  const value = useMemo<WatchGroupsState>(
    () => (flag ? { on: !!layout, layout: layout ?? WATCH_OFF, view, setView, ops, status, error: query.error, refetch } : WATCH_GROUPS_OFF),
    [flag, layout, view, setView, ops, status, query.error, refetch],
  );
  return <WatchGroupsContext.Provider value={value}>{children}</WatchGroupsContext.Provider>;
}
