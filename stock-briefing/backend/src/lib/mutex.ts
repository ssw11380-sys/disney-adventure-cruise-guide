/** 한 번에 하나씩 실행 (Promise 줄 세우기). 앞 작업이 실패해도 다음 작업은 돈다 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * 등록 종목 쓰기(앱의 등록·수정·삭제와 토스 동기화)를 한 줄로 세운다.
 * 동기화 도중 삭제가 끼어들어 방금 지운 종목이 다시 들어가거나, 제외 목록을 동시에 고쳐 한쪽이 사라지는 일을 막는다
 */
export const holdingsWriteLock = new Mutex();
