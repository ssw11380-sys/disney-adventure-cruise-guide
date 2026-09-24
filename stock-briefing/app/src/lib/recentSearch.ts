import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
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
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        const v = raw ? (JSON.parse(raw) as unknown) : [];
        if (alive && Array.isArray(v)) setItems(v.filter((x): x is RecentStock => !!x && typeof (x as RecentStock).code === "string").slice(0, RECENT_MAX));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const add = useCallback((s: RecentStock) => {
    setItems((prev) => {
      const next = pushRecent(prev, s);
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    setItems([]);
    AsyncStorage.removeItem(KEY).catch(() => undefined);
  }, []);
  return { items, add, clear };
}
