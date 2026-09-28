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

  /** 이 조건에 맞는 키를 모두 지운다 (비상 주인 비밀번호 되돌리기 — 그 아이디의 IP 별 잠금을 모두 푼다) */
  clearWhere(match: (key: string) => boolean): void {
    for (const k of [...this.fails.keys()]) if (match(k)) this.fails.delete(k);
  }
}

/** 한 아이디를 모든 IP 에서 합쳐 이만큼 연속으로 틀리면 그 아이디 전체를 잠근다 (IP 별 5번보다 훨씬 높게 — 남이 주인을 잠그기 어렵게) */
export const GLOBAL_LOCK_FAILS = 50;

/**
 * 로그인 잠금 (검증 4차): **아이디 + IP** 별로 5번 틀리면 10분 — 남이 다른 곳(IP)에서 주인 아이디를 일부러 틀려도 주인 폰(다른 IP)은 잠기지 않는다.
 * 아이디 전체 잠금은 모든 IP 를 합쳐 GLOBAL_LOCK_FAILS 번 (여러 IP 로 나눠 비밀번호를 맞혀 보는 것을 막는 몫 — IP 별 로그인 10분 20번 제한과 함께).
 * 없는 아이디도 같은 규칙 (잠김 응답으로 계정이 있는지 알 수 없게). 맞으면 그 IP 와 아이디 전체 횟수를 지운다
 */
export class LoginGuard {
  private readonly perIp: LoginLock;
  private readonly global: LoginLock;

  constructor(now: () => number, maxFails = 5, lockMs = 10 * 60_000, globalFails = GLOBAL_LOCK_FAILS) {
    this.perIp = new LoginLock(now, maxFails, lockMs, 20_000);
    this.global = new LoginLock(now, globalFails, lockMs);
  }

  private static k(id: string, ip: string): string {
    return `${id}|${ip}`;
  }

  /** 잠겨 있으면 남은 초 (그 IP 잠금과 아이디 전체 잠금 중 긴 쪽), 아니면 0 */
  lockedFor(id: string, ip: string): number {
    return Math.max(this.perIp.lockedFor(LoginGuard.k(id, ip)), this.global.lockedFor(id));
  }

  /** 틀림 한 번. 이번에 잠겼으면(또는 이미 잠겨 있으면) 남은 초 */
  fail(id: string, ip: string): number {
    return Math.max(this.perIp.fail(LoginGuard.k(id, ip)), this.global.fail(id));
  }

  succeed(id: string, ip: string): void {
    this.perIp.succeed(LoginGuard.k(id, ip));
    this.global.succeed(id);
  }

  /** 그 아이디의 모든 잠금을 푼다 */
  clear(id: string): void {
    this.global.succeed(id);
    this.perIp.clearWhere((k) => k.startsWith(`${id}|`));
  }
}

/**
 * 사용자별 하루 '서로 다른 것' 수 (날짜 글이 바뀌면 새로). 계정 A단계 검증 4차: 주인 아닌 계정의 AI 분석(종목·종류)·지표 점수(종목) 하루 한도.
 * **캐시에 있든 없든 똑같이 센다** — 새로 만드는 것만 세면 한도를 다 쓴 뒤 '캐시에 있으면 200, 없으면 429' 로 주인이 연 종목·주인 등록 종목
 * (장 마감 뒤 미리 계산)을 알아낼 수 있다. 오늘 이미 본 것은 다시 봐도 세지 않는다
 */
export class DistinctDailyQuota {
  private readonly used = new Map<string, Set<string>>();

  constructor(
    readonly limit: number,
    private readonly today: () => string,
  ) {}

  /** item 을 본다. 오늘 이미 봤거나 한도 안이면 true (처음이면 센다), 넘으면 false (세지 않는다) */
  take(userId: number, item: string): boolean {
    const day = this.today();
    const key = `${day}|${userId}`;
    for (const k of this.used.keys()) if (!k.startsWith(`${day}|`)) this.used.delete(k);
    let seen = this.used.get(key);
    if (!seen) {
      seen = new Set();
      this.used.set(key, seen);
    }
    if (seen.has(item)) return true;
    if (seen.size >= this.limit) return false;
    seen.add(item);
    return true;
  }
}
