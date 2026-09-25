import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from "react-native";

/**
 * 접고 펼 때 잔고 스크롤 위치 이어 보기 (3-42 웨이브 B, 기능 플래그 foldLayout).
 * 휴대폰 줄(58)과 넓은 표 줄(44)은 높이가 달라 스크롤 위치(숫자)로는 같은 자리를 찾을 수 없다 →
 * 맨 위에 보이던 종목 코드를 기억했다가, 배치가 바뀐 뒤 그 줄이 고정 머리 바로 아래에 오게 다시 맞춘다.
 * 기억은 모듈에 둔다: 폰을 접고 펼 때 화면이 새로 만들어져도(탭 막대 위치가 바뀌는 등) 이어진다.
 */

/**
 * 배치 이름: 줄 위치가 달라지는 배치마다 다른 이름 (휴대폰 목록 "list" / 넓은 표 "table-1"(계좌 띠 한 줄)·"table-2"(두 줄) 등).
 * 이름이 바뀌면 맨 위 종목으로 다시 맞춘다. null 은 기능이 꺼져 있음 (추적하지 않는다 = 지금과 똑같다)
 */
export type AnchorMode = string;

export interface RowPos {
  code: string;
  /** 줄이 속한 구역 (보유·관심) — 그 구역 머리가 위에 고정된다 */
  section: string;
  y: number;
  h: number;
}

export interface HeadPos {
  y: number;
  h: number;
}

/**
 * 스크롤 위치에서 맨 위에 보이는 종목: 위에 고정된 구역 머리 바로 아래, 반 이상 보이는 첫 줄.
 * 첫 줄이 그대로 보이면(표 앞의 계좌 칸이 보이는 등 아직 표를 내리지 않았으면) null — 배치가 바뀌어도 맨 위에 둔다
 */
export function topAnchor(rows: readonly RowPos[], heads: Readonly<Record<string, HeadPos>>, scrollY: number): string | null {
  const sorted = [...rows].sort((a, b) => a.y - b.y);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    const head = heads[r.section]?.h ?? 0;
    if (r.y + r.h / 2 > scrollY + head) return i === 0 ? null : r.code;
  }
  return sorted.at(-1)?.code ?? null;
}

/** 다시 맞출 스크롤 위치: 그 줄이 구역 머리(고정) 바로 아래에 오게 */
export function anchorOffset(row: RowPos, head: HeadPos | undefined): number {
  return Math.max(0, row.y - (head?.h ?? 0));
}

/** 앱 전체가 기억하는 마지막 배치와 맨 위 종목 (화면이 새로 만들어져도 남는다) */
const memory: { mode: AnchorMode | null; code: string | null } = { mode: null, code: null };

/** 테스트용: 기억을 지운다 (앱을 새로 연 것과 같다) */
export function forgetHoldingsAnchor(): void {
  memory.mode = null;
  memory.code = null;
}

/** 테스트용: 지금 기억한 값 */
export function holdingsAnchorMemory(): { mode: AnchorMode | null; code: string | null } {
  return { ...memory };
}

type Tagged<T> = T & { mode: AnchorMode };

export interface HoldingsAnchor {
  ref: RefObject<ScrollView | null>;
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** 사용자가 직접 끌기 시작하면 아직 못 맞춘 복원은 버린다 (사라진 종목을 기다리며 기억을 막지 않게) */
  onScrollBeginDrag: () => void;
  /** 줄 위치 (스크롤 내용 기준 y) */
  row: (code: string, section: string, y: number, h: number) => void;
  /** 구역 머리 위치 */
  head: (section: string, e: LayoutChangeEvent) => void;
}

/**
 * 잔고 스크롤 이어 보기 훅. mode 가 null 이면(기능 꺼짐) 부르는 쪽이 아무것도 붙이지 않는다.
 * 돌려주는 함수들은 늘 같은 함수다 (줄의 memo 비교가 참조로 보므로, 체결이 온 줄만 다시 그리는 것을 지킨다 — 3-17)
 */
export function useHoldingsAnchor(mode: AnchorMode | null): HoldingsAnchor {
  const ref = useRef<ScrollView | null>(null);
  const rows = useRef(new Map<string, Tagged<RowPos>>());
  const heads = useRef(new Map<string, Tagged<HeadPos>>());
  const cur = useRef<AnchorMode | null>(mode);
  /** 배치가 바뀐 뒤 맞출 종목 (code null = 맨 위로). 없으면 맞출 것 없음 */
  const pending = useRef<{ code: string | null } | null>(null);

  const tryRestore = useCallback(() => {
    const p = pending.current;
    const m = cur.current;
    if (!p || !m) return;
    if (p.code === null) {
      ref.current?.scrollTo({ y: 0, animated: false });
      pending.current = null;
      return;
    }
    const r = rows.current.get(p.code);
    const h = r ? heads.current.get(r.section) : undefined;
    // 새 배치에서 그 줄과 구역 머리를 아직 재지 못했으면 기다린다 (재는 대로 다시 부른다)
    if (!r || r.mode !== m || !h || h.mode !== m) return;
    ref.current?.scrollTo({ y: anchorOffset(r, h), animated: false });
    pending.current = null;
    memory.code = p.code;
  }, []);

  // 그린 직후(줄 위치를 재기 전)에 배치를 바꾼다: 바뀌었으면 기억한 맨 위 종목으로 맞출 준비
  useLayoutEffect(() => {
    cur.current = mode;
    if (mode === null) return;
    if (memory.mode !== null && memory.mode !== mode) {
      pending.current = { code: memory.code };
      // 앞 배치에서 잰 위치는 새 배치에서 쓸 수 없다
      rows.current.clear();
      heads.current.clear();
    }
    memory.mode = mode;
    tryRestore();
  }, [mode, tryRestore]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const m = cur.current;
    if (!m || pending.current) return;
    const list = [...rows.current.values()].filter((r) => r.mode === m);
    const hs: Record<string, HeadPos> = {};
    for (const [k, h] of heads.current) if (h.mode === m) hs[k] = h;
    memory.mode = m;
    memory.code = topAnchor(list, hs, e.nativeEvent.contentOffset.y);
  }, []);

  const onScrollBeginDrag = useCallback(() => {
    pending.current = null;
  }, []);

  const row = useCallback(
    (code: string, section: string, y: number, h: number) => {
      const m = cur.current;
      if (!m) return;
      rows.current.set(code, { code, section, y, h, mode: m });
      if (pending.current) tryRestore();
    },
    [tryRestore],
  );

  const head = useCallback(
    (section: string, e: LayoutChangeEvent) => {
      const m = cur.current;
      if (!m) return;
      const { y, height } = e.nativeEvent.layout;
      heads.current.set(section, { y, h: height, mode: m });
      if (pending.current) tryRestore();
    },
    [tryRestore],
  );

  return useMemo(() => ({ ref, onScroll, onScrollBeginDrag, row, head }), [onScroll, onScrollBeginDrag, row, head]);
}
