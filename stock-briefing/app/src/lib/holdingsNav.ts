import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/api/hooks";
import type { RegisteredWithQuote } from "@/api/types";
import { sortHoldings, splitHoldings } from "@/lib/portfolio";
import { useSettings, type SortKey } from "@/lib/settings";

/**
 * 종목 상세의 ‹ n/17 › (3-42 웨이브 C, 기능 플래그 foldLayout): 잔고 화면과 같은 순서로 이전·다음 보유 종목으로 바꿔 끼운다.
 *  - 순서는 잔고 화면과 같은 함수(lib/portfolio sortHoldings → splitHoldings)와 같은 정렬 설정(settings.sort)으로 만든다.
 *    보유 종목이면 보유 구역에서, 관심 종목이면 관심 구역에서 넘긴다 (미등록 종목은 넘길 목록이 없다)
 *  - 넘기는 동안에는 처음 연 때의 순서를 그대로 쓴다 (등락률순이면 체결마다 순서가 바뀌어 ‹ › 가 튀지 않게) — 모듈 저장소
 *  - 잔고 목록은 서버에 새로 묻지 않고 잔고 화면·체결 스트림이 채운 캐시를 읽기만 한다 (위젯 브리지와 같은 방식)
 * 순서 계산은 React Native 를 쓰지 않는 순수 함수로 두어 테스트한다
 */

export interface NavItem {
  code: string;
  name: string;
}

/** 잔고 화면의 두 구역 순서 (보유 · 관심) */
export interface HoldingsOrder {
  held: NavItem[];
  watch: NavItem[];
}

export type NavKind = "held" | "watch";

/** 넘기는 구역과 그 순서 */
export interface NavSection {
  kind: NavKind;
  items: readonly NavItem[];
}

export interface HoldingsNav {
  kind: NavKind;
  /** 넘기는 순서 전체 (고정한 순서) */
  items: readonly NavItem[];
  /** 0부터 */
  index: number;
  total: number;
  prev: NavItem | null;
  next: NavItem | null;
}

const item = (s: RegisteredWithQuote): NavItem => ({ code: s.code, name: s.name });

/** 잔고 화면과 같은 순서 (정렬 설정·비용 차감 설정이 같으면 화면 줄 순서와 같다) */
export function holdingsOrder(list: readonly RegisteredWithQuote[], sort: SortKey, afterCost: boolean): HoldingsOrder {
  const { held, watch } = splitHoldings(sortHoldings([...list], sort, afterCost));
  return { held: held.map(item), watch: watch.map(item) };
}

/** 이 종목이 든 구역 (없으면 null — 미등록 종목) */
export function sectionOf(order: HoldingsOrder, code: string): NavSection | null {
  if (order.held.some((s) => s.code === code)) return { kind: "held", items: order.held };
  if (order.watch.some((s) => s.code === code)) return { kind: "watch", items: order.watch };
  return null;
}

/** 목록 안의 위치와 앞뒤 종목. 끝에서는 넘기지 않는다(처음 ↔ 끝으로 돌지 않음). 목록에 없으면 null */
export function navAt(kind: NavKind, items: readonly NavItem[], code: string): HoldingsNav | null {
  const index = items.findIndex((s) => s.code === code);
  if (index < 0) return null;
  return { kind, items, index, total: items.length, prev: items[index - 1] ?? null, next: items[index + 1] ?? null };
}

/** 가운데 글자 '3/17' */
export function navLabel(nav: HoldingsNav): string {
  return `${nav.index + 1}/${nav.total}`;
}

/** 화면 읽기: '보유 17종목 중 3번째' */
export function navSpeech(nav: HoldingsNav): string {
  return `${nav.kind === "held" ? "보유" : "관심"} ${nav.total}종목 중 ${nav.index + 1}번째`;
}

// ── 모듈 저장소 ──

const memory: { kind: NavKind | null; items: readonly NavItem[] | null; last: string | null } = { kind: null, items: null, last: null };

/** 테스트용: 기억을 지운다 (앱을 새로 연 것과 같다) */
export function forgetHoldingsNav(): void {
  memory.kind = null;
  memory.items = null;
  memory.last = null;
}

/**
 * ‹ › 로 넘길 때: 지금 화면이 쓰는 순서(고정한 순서)를 남기고, 넘어갈 종목을 '마지막에 본 종목'으로 둔다.
 * 다음 화면(fromNav)이 같은 순서를 이어 쓴다
 */
export function rememberNav(nav: HoldingsNav, to: string): void {
  memory.kind = nav.kind;
  memory.items = nav.items;
  memory.last = to;
}

/**
 * ‹ › 로 마지막에 연 종목 코드. 잔고 화면이 돌아왔을 때 그 줄로 스크롤해 강조할 때 한 번 읽고 지운다
 * (잔고 화면 쪽 연결은 잔고 표 작업에서 — 이 모듈은 값만 둔다)
 */
export function takeLastViewed(): string | null {
  const last = memory.last;
  memory.last = null;
  return last;
}

/**
 * 넘기는 동안 이어 쓸 순서: ‹ › 로 온 화면(fromNav)이고 기억한 순서에 이 종목이 있으면 그 순서, 아니면 null(지금 캐시로 새로 만든다)
 */
export function recallNav(code: string, fromNav: boolean): NavSection | null {
  if (!fromNav || !memory.items || !memory.kind) return null;
  return memory.items.some((s) => s.code === code) ? { kind: memory.kind, items: memory.items } : null;
}

/**
 * 종목 상세의 이전·다음. active 가 false(휴대폰 화면)면 캐시를 읽기만 하고 아무것도 계산하지 않는다 → 다시 그리지 않는다.
 * 처음 구한 순서를 고정한다 (그 뒤 시세가 바뀌어 정렬 순서가 바뀌어도 ‹ › 의 순서는 그대로)
 */
export function useHoldingsNav(code: string, fromNav: boolean, active: boolean): HoldingsNav | null {
  const api = useApi();
  const { apiUrl, sort, afterCost } = useSettings();
  const [frozen, setFrozen] = useState<NavSection | null>(() => recallNav(code, fromNav));
  const want = active && !frozen;
  const select = useCallback(
    (list: RegisteredWithQuote[]) => (want ? sectionOf(holdingsOrder(list, sort, afterCost), code) : null),
    [want, sort, afterCost, code],
  );
  // 잔고 목록 캐시를 읽기만 한다 (enabled: false — 서버에 묻지 않음). 고정한 뒤에는 select 가 null 이라 체결이 와도 다시 그리지 않는다
  const fresh = useQuery<RegisteredWithQuote[], Error, NavSection | null>({ queryKey: [apiUrl, "stocks"], queryFn: api.listStocks, enabled: false, select }).data;
  if (want && fresh) setFrozen(fresh);
  const section = frozen ?? null;
  useEffect(() => {
    // 넘길 때(rememberNav) 외에도, 연 화면의 순서를 남겨 둔다 → 이 화면에서 ‹ › 로 연 다음 화면이 같은 순서를 쓴다
    if (section) {
      memory.kind = section.kind;
      memory.items = section.items;
    }
  }, [section]);
  return active && section ? navAt(section.kind, section.items, code) : null;
}
