/**
 * 관심 칸의 보기 상태 (3-34, 기능 플래그 watchGroups): 고른 칩 · 접은 그룹. 이 기기에만 둔다 (설정 settings.watchView — 정렬 설정과 같은 곳, lib/settings).
 * 그룹·순서 자체는 서버에 있다 (lib/watchGroups). 설정 모듈이 읽으므로 다른 모듈을 불러오지 않는 작은 파일로 둔다
 */

/** 칩: 전체 · 그룹 번호 · 그룹 없음 */
export type WatchSelected = "all" | "none" | number;
/** 접은 그룹: 그룹 번호 · 그룹 없음 */
export type WatchFold = number | "none";

export interface WatchView {
  selected: WatchSelected;
  collapsed: WatchFold[];
}

export const VIEW_DEFAULT: WatchView = Object.freeze({ selected: "all", collapsed: [] as WatchFold[] }) as WatchView;

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** 기기 저장값 → 보기 상태. 망가진 값·모르는 모양이면 기본('전체' · 모두 펼침) */
export function parseWatchView(raw: string | null | undefined): WatchView {
  if (!raw) return VIEW_DEFAULT;
  try {
    const v = JSON.parse(raw) as { v?: unknown; selected?: unknown; collapsed?: unknown } | null;
    if (v?.v !== 1) return VIEW_DEFAULT;
    const selected: WatchSelected = v.selected === "none" || isId(v.selected) ? v.selected : "all";
    const collapsed = Array.isArray(v.collapsed) ? [...new Set(v.collapsed.filter((c): c is WatchFold => c === "none" || isId(c)))] : [];
    return { selected, collapsed };
  } catch {
    return VIEW_DEFAULT;
  }
}

export function serializeWatchView(view: WatchView): string {
  return JSON.stringify({ v: 1, selected: view.selected, collapsed: view.collapsed });
}

export function selectChip(view: WatchView, key: WatchSelected): WatchView {
  return { ...view, selected: key };
}

export function toggleFold(view: WatchView, fold: WatchFold): WatchView {
  return { ...view, collapsed: view.collapsed.includes(fold) ? view.collapsed.filter((c) => c !== fold) : [...view.collapsed, fold] };
}
