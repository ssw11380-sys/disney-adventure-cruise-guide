/**
 * 서버 연결 오류를 설정 화면 칸 이름에 맞춘 말로 (3-24, 기능 플래그 emptyGuide).
 * 설정 화면: '서버 연결' 칸(접혀 있음) 안에 '서버 주소'·'API 토큰' 입력, 그 위 '서버' 칸의 배지 '연결 끊김'·'토큰 필요'.
 * 예전 문구는 "설정 > 서버 주소 아래에 토큰을 입력하세요"처럼 칸 이름과 달랐다 (UX-10). 플래그가 꺼져 있으면 쓰지 않는다 (오류 글 그대로)
 */
export type ConnectionKind = "network" | "timeout" | "auth";

/** 설정에서 여는 칸 이름 (오류 문구와 설정 화면이 같은 말을 쓴다) */
export const SERVER_SECTION = "서버 연결";
export const URL_FIELD = "서버 주소";
export const TOKEN_FIELD = "API 토큰";

/** 앱 API 오류(api/client ApiRequestError: status·code)에서 서버 연결 문제만 고른다. 서버가 준 다른 오류(404·500 등)는 null */
export function connectionKind(error: unknown): ConnectionKind | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { status?: unknown; code?: unknown };
  if (e.status === 401) return "auth";
  if (e.status === 0 && e.code === "NETWORK") return "network";
  if (e.status === 0 && e.code === "TIMEOUT") return "timeout";
  return null;
}

/** 오류 화면 글: 제목 한 줄 + 무엇을 확인할지 (설정 칸 이름 그대로) */
export function connectionText(kind: ConnectionKind): { title: string; hint: string } {
  switch (kind) {
    case "auth":
      return { title: `${TOKEN_FIELD}이 맞지 않습니다`, hint: `설정 > ${SERVER_SECTION}에서 '${TOKEN_FIELD}'을 확인하세요.` };
    case "timeout":
      return { title: "서버 응답이 없습니다", hint: `잠시 뒤 다시 시도하세요. 계속되면 설정 > ${SERVER_SECTION}에서 '${URL_FIELD}'를 확인하세요.` };
    default:
      return { title: "서버에 연결할 수 없습니다", hint: `인터넷 연결을 확인하세요. 계속되면 설정 > ${SERVER_SECTION}에서 '${URL_FIELD}'를 확인하세요.` };
  }
}

/**
 * 끊김 띠(StaleBanner)의 토큰 오류 한 줄 (시각은 부르는 쪽이). 예전: '토큰 확인 필요 · … · 설정에서 토큰 입력' —
 * 띠 오른쪽에 '설정 열기' 버튼이 붙으므로 끝의 안내는 뺀다. 연결 끊김(주소·인터넷)은 예전 문구 그대로
 */
export function authBanner(at: string): string {
  return `${TOKEN_FIELD} 확인 필요 · ${at} 기준`;
}
