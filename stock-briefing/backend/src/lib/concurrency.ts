/** items 를 동시에 최대 limit 개씩 처리한다 (순서 유지). fn 이 던지면 전체가 실패하므로 필요하면 fn 안에서 잡는다 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/**
 * 키별 '끝나면 알림' (계정 A단계 검증 6차): 백그라운드 받기(재무)가 끝나기를 잠깐 기다리는 요청이 쓴다.
 * wait(key, ms) 는 done(key) 가 불리면 true, ms 가 지나면 false (기다리는 동안 서버가 닫혀도 프로세스를 붙잡지 않게 타이머는 unref)
 */
export class DoneWaiters {
  private readonly waiting = new Map<string, Set<(ok: boolean) => void>>();

  wait(key: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let set = this.waiting.get(key);
      if (!set) {
        set = new Set();
        this.waiting.set(key, set);
      }
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        const s = this.waiting.get(key);
        s?.delete(finish);
        if (s && s.size === 0) this.waiting.delete(key);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, ms));
      timer.unref?.();
      set.add(finish);
    });
  }

  done(key: string): void {
    for (const f of [...(this.waiting.get(key) ?? [])]) f(true);
  }
}
