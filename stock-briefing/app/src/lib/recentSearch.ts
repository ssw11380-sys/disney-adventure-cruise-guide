import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ListedStock } from "@/api/types";

/** 최근 검색해 연 종목 (3-18): 최대 10개, 기기에 저장해 재시작 뒤에도 남는다 */
export const RECENT_MAX = 10;
const KEY = "search.recent";

export type RecentStock = Pick<ListedStock, "code" | "name" | "market">;

/** 순수 함수: 맨 앞에 넣고 같은 종목은 한 번만, 최대 max 개 */
export function pushRecent(list: RecentStock[], item: RecentStock, max = RECENT_MAX): RecentStock[] {
  return [{ code: item.code, name: item.name, market: item.market }, ...list.filter((x) => x.code !== item.code)].slice(0, max);
}

export function useRecentSearches(): { items: RecentStock[]; add: (s: RecentStock) => void; clear: () => void } {
  const [items, setItems] = useState<RecentStock[]>([]);
  // 저장은 React의 updater 실행 시점이 아니라 사용자 행동 순서대로 발행한다.
  const current = useRef<RecentStock[]>([]);
  // 느린 초기 읽기가 그 사이의 검색·지우기를 되돌리지 않게 사용자 행동을 따로 기억한다.
  const added = useRef<RecentStock[]>([]);
  const cleared = useRef(false);
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        const v = raw ? (JSON.parse(raw) as unknown) : [];
        if (!alive || cleared.current || !Array.isArray(v)) return;
        const stored = v.filter((x): x is RecentStock => !!x && typeof (x as RecentStock).code === "string");
        const next = [...added.current, ...stored.filter((x) => !added.current.some((s) => s.code === x.code))].slice(0, RECENT_MAX);
        current.current = next;
        setItems(next);
        // 새 검색은 앞에, 기존 이력은 뒤에 보존한다. 화면·검색 요청은 저장소 읽기를 기다리지 않는다.
        if (added.current.length) AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const add = useCallback((s: RecentStock) => {
    added.current = pushRecent(added.current, s);
    const next = pushRecent(current.current, s);
    current.current = next;
    setItems(next);
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);
  const clear = useCallback(() => {
    cleared.current = true;
    added.current = [];
    current.current = [];
    setItems([]);
    AsyncStorage.removeItem(KEY).catch(() => undefined);
  }, []);
  return { items, add, clear };
}
