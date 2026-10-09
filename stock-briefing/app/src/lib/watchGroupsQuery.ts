import React from "react";
import { saveFailText, WATCH_OFF, type WatchLayout } from "@/lib/watchGroups";
import { VIEW_DEFAULT, type WatchView } from "@/lib/watchView";

/**
 * 관심 종목 그룹·순서 (3-34, 기능 플래그 watchGroups) — 화면이 쓰는 상태와 저장 차례.
 * 루트(components/WatchGroupsProvider)가 플래그·서버 배치(/api/watch-groups, 기기 캐시 저장)·기기 보기 상태(settings.watchView)를 한 번 받아 내려 준다 →
 * 잔고 줄·시트 같은 작은 부품이 서버 조회 훅을 직접 부르지 않는다. 제공자가 없으면(테스트·예전 화면) 꺼짐 = 지금 화면 그대로 (lib/uxFlags 와 같은 방식)
 */

/** 이름 창의 저장 결과: 성공이면 만든 그룹(만들기만), 실패면 창 안에 보일 글 */
export type NameSave = { ok: true; created?: { id: number; name: string } } | { ok: false; message: string };

export interface WatchOps {
  /**
   * 종목 하나를 그 그룹의 index 자리로 (끌기·↑↓·맨 위/아래·그룹 옮기기 모두). 누르는 즉시 화면을 바꾸고(낙관적) 차례대로 서버에 보낸다.
   * speech 가 있으면 화면 읽기에 알린다 ('삼성전자를 반도체 1번째로 옮겼습니다')
   */
  move: (stock: { code: string; name: string }, groupId: number | null, index: number, speech?: string | null) => void;
  /** 새 그룹 (서버가 번호를 정하므로 응답을 기다린다) */
  create: (name: string) => Promise<NameSave>;
  rename: (id: number, name: string) => Promise<NameSave>;
  remove: (id: number) => void;
  order: (ids: number[]) => void;
}

export type WatchStatus = "off" | "loading" | "error" | "ready";

export interface WatchGroupsState {
  /** 켜짐 = 플래그 켜짐 + 서버 배치를 받았고 on (예전 서버 404 · 이 계정은 쓸 수 없음 → 꺼짐처럼) */
  on: boolean;
  layout: WatchLayout;
  /** 이 기기의 고른 칩·접은 그룹 (서버에 없는 그룹은 뺀 값) */
  view: WatchView;
  setView: (v: WatchView) => void;
  ops: WatchOps;
  /** '관심 그룹·순서' 화면: 꺼짐 · 처음 불러오는 중 · 처음 불러오기 실패 · 준비됨 */
  status: WatchStatus;
  error: unknown;
  refetch: () => void;
}

const noopSave = async (): Promise<NameSave> => ({ ok: false, message: "관심 그룹 기능이 꺼져 있습니다" });

export const WATCH_GROUPS_OFF: WatchGroupsState = Object.freeze({
  on: false,
  layout: WATCH_OFF,
  view: VIEW_DEFAULT,
  setView: () => {},
  ops: { move: () => {}, create: noopSave, rename: noopSave, remove: () => {}, order: () => {} },
  status: "off",
  error: null,
  refetch: () => {},
}) as WatchGroupsState;

export const WatchGroupsContext = React.createContext<WatchGroupsState>(WATCH_GROUPS_OFF);

export function useWatchGroups(): WatchGroupsState {
  return React.useContext(WatchGroupsContext);
}

/**
 * 저장 차례 (Promise 줄): 누를 때마다 부르는 쪽이 화면을 먼저 바꾸고(낙관적), 요청은 앞 요청이 끝난 뒤 하나씩 보낸다 (↑↑↑ 를 빠르게 눌러도 서버가 차례대로 계산).
 * 서버 응답은 줄에 남은 요청이 없을 때만 캐시에 쓴다 — 중간 응답으로 화면이 한 칸 되돌아갔다 다시 오지 않게.
 * 하나라도 실패하면 창을 띄우고(quiet 가 아니면), 줄이 비었을 때 서버 값을 다시 받아 되돌린다.
 * 배치 조회(GET)와의 경주 (3-34 3차 검토): 조회를 보낸 뒤 조작이 하나라도 들어왔으면 그 조회 값은 낙관적 화면·조작 응답보다 옛것일 수 있어 캐시에 쓰지 않는다
 * (stamp → fresh). 조작이 아직 줄에 있을 때 온 조회였으면 줄이 빌 때 마지막 응답을 쓴 뒤 한 번 다시 받아 맞춘다
 */
export class WatchOpQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private failed = false;
  /** 지금까지 줄에 들어온 조작 수 (조회 stamp) */
  private runs = 0;
  /** 조작이 줄에 있는 동안 조회 값을 버렸다 → 줄이 비면 한 번 다시 받기 */
  private skipped = false;

  constructor(
    private readonly deps: {
      /** 서버가 준 배치를 캐시에 */
      apply: (layout: WatchLayout) => void;
      /** 서버 값을 다시 받기 (실패 뒤 되돌리기 · 조작 중에 온 조회를 버린 뒤 맞추기) */
      refetch: () => void;
      /** 저장 실패 창 */
      fail: (message: string) => void;
    },
  ) {}

  /** 지금 차례를 기다리는 요청 수 (테스트용) */
  get size(): number {
    return this.pending;
  }

  /** 배치 조회를 보낼 때 받아 두는 표시 (돌아오면 fresh 에 넘긴다). 조작이 줄에 있는 동안 보낸 조회는 -1 (서버가 그 조작보다 먼저 읽었을 수 있다) */
  stamp(): number {
    return this.pending > 0 ? -1 : this.runs;
  }

  /**
   * 돌아온 배치 조회 값을 캐시에 써도 되는지: 줄이 빈 채 보냈고, 보낸 뒤 조작이 하나도 없었고, 지금도 줄이 비어 있어야 한다.
   * 줄에 조작이 남아 있으면 줄이 빌 때 한 번 다시 받게 적어 둔다. 줄이 이미 비었으면 마지막 조작 응답(서버가 그 조작 뒤 준 배치 전체)이
   * 캐시에 있어 다시 받지 않는다
   */
  fresh(stamp: number): boolean {
    if (stamp >= 0 && this.pending === 0 && this.runs === stamp) return true;
    if (this.pending > 0) this.skipped = true;
    return false;
  }

  run(send: () => Promise<WatchLayout>, opts: { quiet?: boolean } = {}): Promise<WatchLayout> {
    this.pending++;
    this.runs++;
    const p = this.tail.then(send);
    this.tail = p.catch(() => undefined);
    return p.then(
      (layout) => {
        this.settle(layout);
        return layout;
      },
      (e: unknown) => {
        this.failed = true;
        if (!opts.quiet) this.deps.fail(saveFailText(e));
        this.settle(null);
        throw e;
      },
    );
  }

  private settle(layout: WatchLayout | null): void {
    this.pending--;
    if (this.pending > 0) return;
    const failed = this.failed;
    const again = failed || this.skipped;
    this.failed = false;
    this.skipped = false;
    if (!failed && layout) this.deps.apply(layout);
    if (again) this.deps.refetch();
  }
}
