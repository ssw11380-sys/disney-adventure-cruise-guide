import { useSyncExternalStore } from "react";
import type { Briefing } from "@/api/types";

/**
 * 넓은 창 브리핑 탭에서 고른 브리핑 (3-42 웨이브 D, 기능 플래그 foldLayout).
 * 2단 오른쪽 칸에 무엇을 보일지는 뒤로 가기 기록(주소)이 아니라 이 작은 저장소에 둔다 → 목록을 눌러도 뒤로 가기는 지금과 같다.
 * 화면 하나의 상태가 아니라 모듈에 두는 까닭: 폰을 접고 펴거나 돌려 배치가 바뀌어도(2단 ↔ 카드 격자 ↔ 폰 목록) 같은 브리핑을 이어 본다.
 *  - highlight: 넓은 창에서 고른 것인지. 접은 화면(폰 목록)은 이 값이 true 일 때만 그 줄을 강조한다
 *    (접은 채로 연 브리핑은 강조하지 않는다 → 접은 화면만 쓰는 사람에게는 지금과 똑같다)
 * 뒤로 가기·알림·위젯 경로는 바꾸지 않는다: 전체 화면 브리핑이 열리면 그 화면이 여기에 적어, 탭으로 돌아오면 그 브리핑이 골라져 있다
 */
export type BriefingPick = { kind: "stock"; id: number } | { kind: "account"; id: number };

export interface PickState {
  pick: BriefingPick | null;
  highlight: boolean;
}

const EMPTY: PickState = Object.freeze({ pick: null, highlight: false });
let state: PickState = EMPTY;
const listeners = new Set<() => void>();

export function currentPick(): PickState {
  return state;
}

export function samePick(a: BriefingPick | null | undefined, b: BriefingPick | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.id === b.id;
}

/** 브리핑을 고른다. 같은 값이면 알리지 않는다 (다시 그리지 않게) */
export function pickBriefing(pick: BriefingPick | null, opts: { highlight: boolean }): void {
  if (samePick(state.pick, pick) && state.highlight === opts.highlight) return;
  state = pick ? { pick, highlight: opts.highlight } : EMPTY;
  for (const l of listeners) l();
}

/** 테스트용: 고른 것을 지운다 (앱을 새로 연 것과 같다) */
export function forgetPick(): void {
  state = EMPTY;
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** 고른 브리핑 (바뀌면 다시 그린다 — 그리는 사이에 바뀐 값도 놓치지 않게 useSyncExternalStore) */
export function usePick(): PickState {
  return useSyncExternalStore(subscribe, currentPick);
}

/** 브리핑의 세션 순서 값 (날짜 + 오전·오후). 클수록 최근 */
function sessionKey(b: Pick<Briefing, "date" | "session">): string {
  return `${b.date}-${b.session === "afternoon" ? 1 : 0}`;
}

/** 목록에서 가장 최근 세션 (미확인 점은 이 세션의 브리핑에만 붙는다 — 예전 브리핑 전부에 점이 찍히지 않게) */
export function latestSession(list: readonly Pick<Briefing, "date" | "session">[]): string | null {
  let best: string | null = null;
  for (const b of list) {
    const k = sessionKey(b);
    if (best === null || k > best) best = k;
  }
  return best;
}

/** 아직 읽지 않은 브리핑: 가장 최근 세션에 만들어졌고(실패 제외), 이 기기에서 연 적이 없다 */
export function isUnread(b: Pick<Briefing, "id" | "date" | "session" | "status">, read: ReadonlySet<number>, latest: string | null): boolean {
  return b.status === "ok" && latest !== null && sessionKey(b) === latest && !read.has(b.id);
}

/** 목록 줄의 짧은 시각 "9/25 오전" (브리핑 날짜 + 세션) */
export function briefingWhen(b: Pick<Briefing, "date" | "session">): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(b.date);
  const day = m ? `${Number(m[1])}/${Number(m[2])}` : b.date;
  return `${day} ${b.session === "afternoon" ? "오후" : "오전"}`;
}

/** 한국 날짜 "2026-09-25" (한국은 서머타임이 없어 9시간을 더해 UTC 날짜로 읽는다) */
const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const KST_TIME = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * 만든 시각 "08:02" — 브리핑 날짜와 같은 날(한국 시각)이면 시각만, 다른 날이면 null (부르는 쪽이 날짜까지 쓴다).
 * 넓은 창 브리핑 본문 머리를 한 줄에 담으려고 쓴다
 */
export function createdTimeSameDay(b: Pick<Briefing, "date" | "createdAt">): string | null {
  const d = new Date(b.createdAt);
  if (Number.isNaN(d.getTime())) return null;
  return kstDay(d) === b.date ? KST_TIME.format(d) : null;
}

/**
 * 카드 격자 열 수: 칸 최소 폭(큰 글씨는 늘어난 배율의 절반만큼 넓힘)이 들어가는 만큼, 1~max 열.
 * width 는 격자가 실제로 받은 폭(좌우 여백 제외), gap 은 칸 사이 간격
 */
export function gridColumns(width: number, fontScale: number, opts: { minW: number; gap: number; max: number; cap: number }): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  const s = Math.min(Math.max(Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1, 1), opts.cap);
  const minW = opts.minW * (1 + (s - 1) / 2);
  return Math.max(1, Math.min(opts.max, Math.floor((width + opts.gap) / (minW + opts.gap))));
}

/** 넓은 창에서 브리핑 탭을 처음 열 때 고를 브리핑: 보이는 순서에서 첫 미확인, 없으면 맨 위 */
export function firstPick(list: readonly Pick<Briefing, "id" | "date" | "session" | "status">[], read: ReadonlySet<number>): number | null {
  if (!list.length) return null;
  const latest = latestSession(list);
  return (list.find((b) => isUnread(b, read, latest)) ?? list[0]!).id;
}
