/**
 * 메모리 속도 제한·잠금 (계정 A단계, 새 패키지 없음). 서버를 다시 켜면 비워진다 — 지금 Railway 는 1대.
 * 키 수는 상한(maxKeys)을 넘으면 가장 오래된 것부터 버린다.
 */

/** 고정 창 제한: 창(windowMs) 안에서 limit 번까지 */
export class WindowLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {}

  /** 한 번 센다. 넘었으면 ok=false 와 몇 초 뒤에 다시 되는지 */
  hit(key: string): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || t - e.start >= this.windowMs) {
      e = { start: t, count: 0 };
      this.hits.delete(key);
      this.hits.set(key, e);
      this.trim();
    }
    e.count++;
    if (e.count > this.limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((e.start + this.windowMs - t) / 1000)) };
    return { ok: true, retryAfterSec: 0 };
  }

  private trim(): void {
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
  }
}

/**
 * 아이디별 잠금: 연속 maxFails 번 틀리면 lockMs 동안 잠근다 (잠긴 동안은 맞는 비밀번호도 거절). 맞으면 횟수를 지운다.
 * 없는 아이디도 같은 규칙으로 센다 — '잠김' 응답으로 계정이 있는지 알 수 없게
 */
export class LoginLock {
  private readonly fails = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly now: () => number,
    private readonly maxFails = 5,
    private readonly lockMs = 10 * 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  /** 잠겨 있으면 남은 초, 아니면 0 */
  lockedFor(key: string): number {
    const e = this.fails.get(key);
    if (!e || e.lockedUntil <= this.now()) return 0;
    return Math.max(1, Math.ceil((e.lockedUntil - this.now()) / 1000));
  }

  /** 틀림 한 번. 이번에 잠겼으면 잠긴 초 */
  fail(key: string): number {
    const t = this.now();
    let e = this.fails.get(key);
    if (!e || (e.lockedUntil > 0 && e.lockedUntil <= t)) e = { count: 0, lockedUntil: 0 };
    e.count++;
    if (e.count >= this.maxFails) {
      e.count = 0;
      e.lockedUntil = t + this.lockMs;
    }
    this.fails.delete(key);
    this.fails.set(key, e);
    while (this.fails.size > this.maxKeys) this.fails.delete(this.fails.keys().next().value!);
    return this.lockedFor(key);
  }

  succeed(key: string): void {
    this.fails.delete(key);
  }
}

/** 사용자별 하루 횟수 (날짜 글이 바뀌면 새로). 계정 A단계: 주인 아닌 계정이 새로 만드는 AI 분석 수 */
export class DailyQuota {
  private readonly used = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly today: () => string,
  ) {}

  /** 한 번 쓴다. 한도를 넘으면 false (세지 않는다) */
  take(userId: number): boolean {
    const day = this.today();
    const key = `${day}|${userId}`;
    for (const k of this.used.keys()) if (!k.startsWith(`${day}|`)) this.used.delete(k);
    const n = this.used.get(key) ?? 0;
    if (n >= this.limit) return false;
    this.used.set(key, n + 1);
    return true;
  }
}
