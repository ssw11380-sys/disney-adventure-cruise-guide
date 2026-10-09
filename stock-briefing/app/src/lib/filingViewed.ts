import { useCallback, useEffect, useSyncExternalStore } from "react";
import { addFilingViewed, readFilingViewed } from "@/lib/filingSeen";

/**
 * '일정·공시' 화면에서 펼쳐 본 공시 (3-38) — '새 공시' 칩과 계좌 상세 링크의 '· 새 공시 N건'이 같은 값을 본다.
 * 기기에 저장(lib/filingSeen)하고, 화면끼리는 이 저장소로 바로 알린다 (화면에서 펼치고 돌아오면 링크 수가 줄어든다)
 */
let viewed: ReadonlySet<string> = new Set();
let loaded = false;
const listeners = new Set<() => void>();

function emit(next: ReadonlySet<string>): void {
  viewed = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** 테스트용: 기억을 지운다 */
export function forgetFilingViewed(): void {
  viewed = new Set();
  loaded = false;
}

/** 펼쳐 본 접수 번호 집합과 '펼쳐 봄' 적기 */
export function useFilingViewed(): [ReadonlySet<string>, (accession: string) => void] {
  const set = useSyncExternalStore(subscribe, () => viewed);
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void readFilingViewed().then((list) => {
      if (list.length) emit(new Set([...viewed, ...list]));
    });
  }, []);
  const mark = useCallback((accession: string) => {
    if (viewed.has(accession)) return;
    emit(new Set([...viewed, accession]));
    void addFilingViewed(accession);
  }, []);
  return [set, mark];
}
