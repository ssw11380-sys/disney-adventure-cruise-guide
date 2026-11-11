import { useEffect } from "react";

/**
 * 지금 화면에서 보고 있는 종목 (종목 상세·전체 화면 차트) — 서버 실시간 스트림에 "이 종목도 같이 보내 달라"고 알리는 목록.
 * 서버는 등록 종목(보유·관심)만 실시간으로 보내므로, 등록하지 않은 종목(발견·검색에서 연 종목)은 이 목록에 넣어
 * 붙어 있는 동안 같이 받는다 → 3초 폴링을 기다리지 않고 1초 안에 가격이 바뀐다.
 * 화면이 겹쳐 열릴 수 있어(상세 위에 전체 화면 차트) 종목마다 센다. 예전 서버는 모르는 메시지라 무시한다 (그때는 지금처럼 3초 폴링).
 * 소켓은 lib/liveStream 이 쥐고 있다 — 붙을 때 보내는 함수를 여기에 걸어 둔다 (setViewingSender)
 */
const viewing = new Map<string, number>();
let sender: (() => void) | null = null;

/** 보고 있는 종목 코드 (서버에 보내는 전체 목록) */
export function viewingCodes(): string[] {
  return [...viewing.keys()];
}

/** 소켓이 붙으면 '목록 보내기' 함수를 걸고(붙자마자 한 번 보낸다), 끊기면 null */
export function setViewingSender(send: (() => void) | null): void {
  sender = send;
  if (send && viewing.size > 0) send();
}

/** 이 함수가 지금 걸린 보내기 함수인지 (옛 소켓이 늦게 끊기며 새 소켓의 것을 지우지 않게) */
export function isViewingSender(send: () => void): boolean {
  return sender === send;
}

/** 종목 하나를 보기 시작한다. 돌려준 함수를 부르면 그만 본다 (테스트·훅이 같이 쓴다) */
export function viewStock(code: string): () => void {
  viewing.set(code, (viewing.get(code) ?? 0) + 1);
  sender?.();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (viewing.get(code) ?? 1) - 1;
    if (n <= 0) viewing.delete(code);
    else viewing.set(code, n);
    sender?.();
  };
}

/** 종목 화면이 보이는 동안 그 종목을 실시간으로 받는다 (가려지거나 닫히면 뺀다). code 가 없으면 아무것도 하지 않는다 */
export function useStreamView(code: string | null | undefined): void {
  useEffect(() => (code ? viewStock(code) : undefined), [code]);
}
