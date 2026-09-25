import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

/**
 * 이 기기에서 연 브리핑 id (3-42 웨이브 D, 기능 플래그 foldLayout). 넓은 창 브리핑 목록의 '미확인 점'과
 * 처음 열 때 고를 브리핑(첫 미확인)에 쓴다. 네이티브 모듈 없이 AsyncStorage 만 쓰고, 최근 300개만 남긴다.
 * 플래그가 꺼져 있으면 읽지도 적지도 않는다 (부르는 쪽이 enabled 로 막는다)
 */
export const READ_KEY = "briefings.read"; // JSON: number[] (연 브리핑 id, 오래된 것부터)
const KEEP = 300;
const EMPTY: ReadonlySet<number> = new Set();

/** 불러온 뒤의 id 목록 (null = 아직 저장소를 읽지 않음) */
let ids: number[] | null = null;
/** 불러오기 전에 적힌 id (불러온 목록 뒤에 붙인다) */
let early: number[] = [];
let view: ReadState = { read: EMPTY, ready: false };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  view = { read: new Set([...(ids ?? []), ...early]), ready: ids !== null };
  for (const l of listeners) l();
}

const valid = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0;

function load(): Promise<void> {
  loading ??= AsyncStorage.getItem(READ_KEY)
    .then((raw) => {
      const v: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter(valid) : [];
    })
    .catch(() => [] as number[])
    .then((stored) => {
      ids = [...stored.filter((x) => !early.includes(x)), ...early].slice(-KEEP);
      const wrote = early.length > 0;
      early = [];
      publish();
      if (wrote) save();
    });
  return loading;
}

function save(): void {
  if (ids) void AsyncStorage.setItem(READ_KEY, JSON.stringify(ids)).catch(() => undefined);
}

/** 브리핑을 읽은 것으로 적는다 (같은 id 는 뒤로 옮김). 저장소를 아직 읽지 않았으면 읽은 뒤에 합쳐 적는다 */
export function markBriefingRead(id: number): void {
  if (!valid(id)) return;
  if (ids === null) {
    if (early.includes(id)) return;
    early = [...early, id];
    publish();
    void load();
    return;
  }
  if (ids[ids.length - 1] === id) return;
  ids = [...ids.filter((x) => x !== id), id].slice(-KEEP);
  publish();
  save();
}

/** 테스트용: 기억을 지운다 (앱을 새로 연 것과 같다) */
export function forgetRead(): void {
  ids = null;
  early = [];
  loading = null;
  publish();
}

export interface ReadState {
  read: ReadonlySet<number>;
  /** 저장소를 다 읽었는지 (읽기 전에는 미확인 점·처음 고를 브리핑을 정하지 않는다) */
  ready: boolean;
}

const OFF: ReadState = Object.freeze({ read: EMPTY, ready: true });
const off = () => OFF;
const noSubscribe = () => () => undefined;
const current = () => view;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  void load();
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * 읽은 브리핑 id 모음과 불러오기가 끝났는지. enabled 가 false 면(플래그 꺼짐) 저장소를 건드리지 않고 빈 모음.
 * 값은 바뀔 때만 새 객체다 (받는 쪽 memo·effect 가 다시 돌지 않게)
 */
export function useReadBriefings(enabled: boolean): ReadState {
  return useSyncExternalStore(enabled ? subscribe : noSubscribe, enabled ? current : off);
}
