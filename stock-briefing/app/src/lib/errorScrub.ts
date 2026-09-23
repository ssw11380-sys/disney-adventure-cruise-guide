/**
 * 앱 오류 보고의 순수 규칙 (RN 의존 없음 → 단위 테스트). 서버도 같은 규칙으로 한 번 더 지운다.
 *  - 토큰·키·푸시 토큰·긴 16진 문자열은 기기를 떠나기 전에 지운다
 *  - 메시지 속 금액·수량으로 보이는 숫자(4자리 이상)도 지운다. 스택의 줄·열 번호는 남긴다
 *  - 같은 오류가 폭주하지 않게 1분 창으로 제한한다
 */

export type ErrorKind = "fatal" | "js" | "render" | "promise" | "test";

export interface ErrorReport {
  kind: ErrorKind;
  message: string;
  stack: string | null;
  screen: string | null;
  occurredAt: string;
  appVersion: string | null;
  updateId: string | null;
  platform: string | null;
}

export function scrubText(text: string, opts: { numbers: boolean }): string {
  let s = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [지움]")
    .replace(/([?&;#]|%3F|%26)(token|access_token|api_token|key)(=|%3D)[^&\s#;"']*/gi, "$1$2=[지움]")
    .replace(/\b(sk-ant-[A-Za-z0-9_-]+|ExponentPushToken\[[^\]]*\])/g, "[지움]")
    .replace(/\b[0-9a-f]{24,}\b/gi, "[지움]");
  if (opts.numbers) s = s.replace(/(?:[$₩]\s?)?\d[\d,]{3,}(\.\d+)?(?:\s?(원|달러|USD|KRW))?/g, "#").replace(/[$₩]\s?\d+(\.\d+)?/g, "#");
  return s;
}

/** 던져진 값(Error 가 아닐 수도 있음)을 보고 한 건으로 */
export function buildReport(kind: ErrorKind, err: unknown, meta: Omit<ErrorReport, "kind" | "message" | "stack" | "occurredAt">, now: number): ErrorReport {
  const e = err instanceof Error ? err : null;
  const raw = e ? `${e.name && e.name !== "Error" ? `${e.name}: ` : ""}${e.message}` : typeof err === "string" ? err : safeJson(err);
  return {
    kind,
    message: scrubText(raw || "(메시지 없음)", { numbers: true }).slice(0, 500),
    stack: e?.stack ? scrubText(e.stack, { numbers: false }).slice(0, 4000) : null,
    screen: meta.screen ? scrubText(meta.screen, { numbers: false }).slice(0, 200) : null,
    occurredAt: new Date(now).toISOString(),
    appVersion: meta.appVersion,
    updateId: meta.updateId,
    platform: meta.platform,
  };
}

function safeJson(v: unknown): string {
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v)?.slice(0, 500) ?? String(v);
  } catch {
    return String(v);
  }
}

/** 1분 창 제한: 전체 maxPerMinute 건, 같은 메시지는 창마다 1건 */
export function createLimiter(maxPerMinute = 10) {
  let start = 0;
  let count = 0;
  let seen = new Set<string>();
  return (r: Pick<ErrorReport, "kind" | "message">, now: number): boolean => {
    if (now - start >= 60_000) {
      start = now;
      count = 0;
      seen = new Set();
    }
    const key = `${r.kind}|${r.message.replace(/\d+/g, "#")}`;
    if (count >= maxPerMinute || seen.has(key)) return false;
    seen.add(key);
    count += 1;
    return true;
  };
}

/** 기기에 남겨 둘 보고 (앱이 죽기 전에 못 보낸 것) — 최근 20건만 */
export function enqueue(queue: ErrorReport[], r: ErrorReport, max = 20): ErrorReport[] {
  return [...queue, r].slice(-max);
}
