/** 출처 요청 한 번의 기본 제한 시간 (연결부터 본문 끝까지) */
export const SOURCE_TIMEOUT_MS = 10_000;

/** 본문이 없어야 하는 응답 상태 (new Response 에 본문을 넣으면 오류) */
const NULL_BODY = new Set([204, 205, 304]);

/**
 * fetch 를 연결부터 본문 끝까지 ms 안에 끝낸다. 넘으면 요청을 끊고(abort) TimeoutError 로 실패한다
 * (멈춘 출처 하나가 브리핑·시세 요청을 undici 기본값 약 300초까지 붙잡지 않게).
 * 본문은 미리 다 받아 둔 Response 로 돌려주므로 호출한 쪽의 res.json()/text()/arrayBuffer() 는 더 기다리지 않는다.
 * 주입한 fetch 가 signal 을 따르지 않아도 제한 시간에 끝나게 같이 경쟁시킨다 (indices.ts 와 같은 방식).
 */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit = {},
  ms: number = SOURCE_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new DOMException(`시간 초과 ${ms}ms`, "TimeoutError");
      ctrl.abort(err);
      reject(err);
    }, ms);
  });
  try {
    const res = await Promise.race([fetchFn(url, { ...init, signal: ctrl.signal }), expired]);
    const body = await Promise.race([res.arrayBuffer(), expired]);
    return new Response(NULL_BODY.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } finally {
    clearTimeout(timer);
  }
}
