import { fieldMessage } from "./authRules";

/**
 * 로그인·회원가입·비밀번호 바꾸기 요청이 실패했을 때 화면에 보일 것 (계정 A단계). 순수 함수 — api/client 의 ApiRequestError 모양만 본다.
 *  - 인터넷·시간 초과: 연결 문구 (세션·입력은 그대로)
 *  - 우리 서버의 404(NOT_FOUND): 예전 서버·플래그 꺼짐 → failOpen (로그인 없이 지금처럼 들어간다)
 *  - 401 (API 토큰): '서버 설정' 버튼과 함께
 *  - 400·409: 칸별 오류(fields) 또는 서버 문구
 *  - 429: 서버 문구 (잠금·너무 잦음)
 *  - 5xx: 잠시 문제
 */
export interface AuthErrorView {
  /** 입력 묶음 위(또는 버튼 위) 한 줄. 칸별 오류만 있으면 null */
  message: string | null;
  /** 칸 이름 → 칸 아래 문구 */
  fields: Record<string, string>;
  /** '서버 설정' 버튼을 함께 보일지 */
  showServer: boolean;
  /** 예전 서버: 로그인 없이 지금처럼 */
  failOpen: boolean;
}

export const AUTH_TEXT = {
  network: "서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요",
  timeout: "서버 응답이 없어요. 잠시 뒤 다시 해 주세요",
  apiToken: "서버 연결 설정을 확인해 주세요 (API 토큰)",
  address: "서버 주소를 확인해 주세요",
  server: "서버에 잠시 문제가 있어요. 잠시 뒤 다시 해 주세요",
  tooMany: "잠시 뒤에 다시 해 주세요",
  badCredentials: "아이디 또는 비밀번호가 맞지 않아요",
  unknown: "잠시 뒤 다시 해 주세요",
  sessionEnded: "다시 로그인해 주세요",
  passwordChanged: "비밀번호를 바꿨어요. 다른 기기는 로그아웃돼요.",
} as const;

/** 429 문구: 남은 초 → 분(올림, 1분 이상). 잠김(여러 번 틀림)과 요청이 너무 잦음을 나눈다 */
export function retryText(serverMessage: string | null, sec: number): string {
  const min = Math.max(1, Math.ceil(sec / 60));
  return serverMessage && /틀려서/.test(serverMessage) ? `여러 번 틀려서 잠시 막아 두었어요. ${min}분 뒤에 다시 해 주세요` : `요청이 너무 잦아요. ${min}분 뒤에 다시 해 주세요`;
}

export function authErrorView(e: unknown): AuthErrorView {
  const x = (e && typeof e === "object" ? e : {}) as { status?: unknown; code?: unknown; body?: unknown };
  const status = typeof x.status === "number" ? x.status : -1;
  const body = (x.body && typeof x.body === "object" ? x.body : {}) as { code?: unknown; message?: unknown; error?: unknown; fields?: unknown };
  const view = (message: string | null, extra: Partial<AuthErrorView> = {}): AuthErrorView => ({ message, fields: {}, showServer: false, failOpen: false, ...extra });
  if (status === 0) return view(x.code === "TIMEOUT" ? AUTH_TEXT.timeout : AUTH_TEXT.network);
  if (status === 404) return body.error === "NOT_FOUND" ? view(null, { failOpen: true }) : view(AUTH_TEXT.address, { showServer: true });
  if (x.code === "NOT_JSON") return view(AUTH_TEXT.address, { showServer: true });
  if (status === 401) return view(AUTH_TEXT.apiToken, { showServer: true });
  if (status >= 500) return view(AUTH_TEXT.server);
  const msg = typeof body.message === "string" && body.message ? body.message : null;
  // 잠김·너무 잦음: 서버가 준 남은 시간(retryAfterSec)으로 몇 분 뒤인지 (검증 4차 — 예전 문구는 늘 '10분 뒤')
  if (status === 429) {
    const sec = typeof (body as { retryAfterSec?: unknown }).retryAfterSec === "number" ? ((body as { retryAfterSec: number }).retryAfterSec) : null;
    if (sec === null) return view(msg ?? AUTH_TEXT.tooMany);
    return view(retryText(msg, sec));
  }
  if (status === 400 || status === 409 || status === 403) {
    const fields: Record<string, string> = {};
    if (body.fields && typeof body.fields === "object") {
      for (const [k, v] of Object.entries(body.fields as Record<string, unknown>)) if (typeof v === "string") fields[k] = fieldMessage(k, v);
    }
    if (body.code === "bad_credentials") return view(AUTH_TEXT.badCredentials);
    return view(Object.keys(fields).length ? null : (msg ?? AUTH_TEXT.unknown), { fields });
  }
  return view(msg ?? AUTH_TEXT.unknown);
}
