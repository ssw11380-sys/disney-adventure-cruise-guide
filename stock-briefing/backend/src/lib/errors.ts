export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
  }
}

/** 토스 계좌에서 맞추는 종목의 수량·평단을 앱에서 바꾸려 함 */
export class TossLockedError extends AppError {
  constructor(message: string) {
    super(409, "TOSS_LOCKED", message);
  }
}

/** 외부 데이터 소스 호출 실패. 체인의 다음 소스로 넘어가는 신호로 쓴다. */
export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

/** AbortSignal.timeout 이 끊은 요청인지 — 시간 초과는 다시 불러도 또 그만큼 걸리므로 재시도하지 않는다 */
export function isTimeoutError(e: unknown): boolean {
  return typeof e === "object" && e !== null && ((e as { name?: unknown }).name === "TimeoutError" || (e as { name?: unknown }).name === "AbortError");
}

/** p 를 ms 만 기다리고, 넘으면 fallback (p 는 뒤에서 끝나도 무시) */
export function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((res) => {
    timer = setTimeout(() => res(fallback), ms);
  });
  return Promise.race([p.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}
