/**
 * 서버 연결 오류를 설정 화면 칸 이름에 맞춘 말로 (3-24, 기능 플래그 emptyGuide).
 * 설정 화면: '서버 연결' 칸(접혀 있음) 안에 '서버 주소'·'API 토큰' 입력, 그 위 '서버' 칸의 배지 '연결 끊김'·'토큰 필요'.
 * 예전 문구는 "설정 > 서버 주소 아래에 토큰을 입력하세요"처럼 칸 이름과 달랐다 (UX-10). 플래그가 꺼져 있으면 쓰지 않는다 (오류 글 그대로)
 */
export type ConnectionKind = "network" | "timeout" | "auth" | "address";

/** 설정에서 여는 칸 이름 (오류 문구와 설정 화면이 같은 말을 쓴다) */
export const SERVER_SECTION = "서버 연결";
export const URL_FIELD = "서버 주소";
export const TOKEN_FIELD = "API 토큰";

/**
 * 이 앱의 서버라면 늘 있는 목록 경로 (쿼리 앞까지). 여기서 404 가 오면 종목·브리핑이 없어서가 아니라 서버 주소(경로)가 틀린 것이다
 * — 예: 주소 끝에 '/api' 를 더 붙여 '/api/api/stocks' 로 물음 (우리 서버의 없는 주소 404 는 NOT_FOUND 코드를 준다)
 */
export const ALWAYS_PATHS: ReadonlySet<string> = new Set(["/health", "/api/features", "/api/stocks", "/api/briefings/latest", "/api/market/status", "/api/market/indices"]);

/** 응답이 JSON 이 아니었을 때 api/client 가 쓰는 오류 코드 (2xx 인데 웹 페이지(HTML) 등 — 이 앱의 서버가 아닌 주소) */
export const NOT_JSON = "NOT_JSON";

/**
 * 앱 API 오류(api/client ApiRequestError: status·code·path)에서 서버 연결 문제만 고른다. 우리 서버가 준 다른 오류(종목 없음 404·500 등)는 null.
 *  - network·timeout: 서버에 닿지 않음 (status 0)
 *  - auth: 토큰이 틀림 (401)
 *  - address: 서버에는 닿지만 이 앱의 서버 주소가 아님 — ① 서버 오류 코드 없는 404(`HTTP_404`: Railway 하위 주소 오타의
 *    'Application not found', 다른 사이트의 404 웹 페이지) ② JSON 이 아닌 성공 응답(`NOT_JSON`) ③ 늘 있는 목록 경로(ALWAYS_PATHS)의 404
 */
export function connectionKind(error: unknown): ConnectionKind | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { status?: unknown; code?: unknown; path?: unknown };
  if (e.status === 401) return "auth";
  if (e.status === 0 && e.code === "NETWORK") return "network";
  if (e.status === 0 && e.code === "TIMEOUT") return "timeout";
  if (e.code === NOT_JSON && typeof e.status === "number" && e.status > 0) return "address";
  if (e.status === 404) {
    if (e.code === "HTTP_404") return "address";
    if (typeof e.path === "string" && ALWAYS_PATHS.has(e.path.split("?")[0]!)) return "address";
  }
  return null;
}

/** 오류 화면 글: 제목 한 줄 + 무엇을 확인할지 (설정 칸 이름 그대로) */
export function connectionText(kind: ConnectionKind): { title: string; hint: string } {
  switch (kind) {
    case "auth":
      return { title: `${TOKEN_FIELD}이 맞지 않습니다`, hint: `설정 > ${SERVER_SECTION}에서 '${TOKEN_FIELD}'을 확인하세요.` };
    case "address":
      return { title: `${URL_FIELD}가 맞지 않습니다`, hint: `이 주소에서 앱의 서버를 찾지 못했습니다. 설정 > ${SERVER_SECTION}에서 '${URL_FIELD}'를 확인하세요.` };
    case "timeout":
      return { title: "서버 응답이 없습니다", hint: `잠시 뒤 다시 시도하세요. 계속되면 설정 > ${SERVER_SECTION}에서 '${URL_FIELD}'를 확인하세요.` };
    default:
      return { title: "서버에 연결할 수 없습니다", hint: `인터넷 연결을 확인하세요. 계속되면 설정 > ${SERVER_SECTION}에서 '${URL_FIELD}'를 확인하세요.` };
  }
}

/**
 * 끊김 띠(StaleBanner)의 토큰 오류 한 줄 (시각은 부르는 쪽이). 예전: '토큰 확인 필요 · … · 설정에서 토큰 입력' —
 * 띠 오른쪽에 '설정 열기' 버튼이 붙으므로 끝의 안내는 뺀다. 연결 끊김(인터넷·시간 초과)은 예전 문구 그대로
 */
export function authBanner(at: string): string {
  return `${TOKEN_FIELD} 확인 필요 · ${at} 기준`;
}

/** 끊김 띠의 틀린 서버 주소 한 줄 ('다시 연결 중'이 아니라 무엇을 고칠지 — 오른쪽에 '설정 열기') */
export function addressBanner(at: string): string {
  return `${URL_FIELD} 확인 필요 · ${at} 기준`;
}

/**
 * api/client 가 401 오류에 싣는 글 (알림 창·오류 화면에 그대로 보인다). 앱 루트(components/UxBridge)가 연결 오류 안내가 켜졌는지
 * (lib/uxFlags connectionGuide) 알려 주면 칸 이름에 맞춘 문구, 꺼져 있으면 예전 문구 그대로
 */
const AUTH_OLD = "API 토큰이 틀리거나 비어 있습니다. 설정 > 서버 주소 아래에 토큰을 입력하세요.";
const AUTH_NEW = `${TOKEN_FIELD}이 틀리거나 비어 있습니다. 설정 > ${SERVER_SECTION}에서 '${TOKEN_FIELD}'을 확인하세요.`;
let guideWording = false;

export function setConnectionWording(on: boolean): void {
  guideWording = on;
}

export function authMessage(): string {
  return guideWording ? AUTH_NEW : AUTH_OLD;
}
