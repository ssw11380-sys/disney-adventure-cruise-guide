/**
 * 회원가입·비밀번호 검사 규칙 (계정 A단계, 플래그 accounts). 앱 app/src/lib/authRules.ts 와 같은 규칙 —
 * 둘 다 shared/fixtures/authRules.json 으로 같은 결과를 내는지 테스트한다.
 *  - 아이디: 앞뒤 공백을 지우고 NFC, 2~20자, 한글 음절·영문·숫자·밑줄만 (자모 단독 불가). 비교는 소문자(대소문자 무시)
 *  - 비밀번호: 8~64자, 영문과 숫자를 모두, 아이디와 달라야 함 (다듬지 않는다 — 앞뒤 공백도 비밀번호의 일부)
 *  - 이메일: 앞뒤 공백을 지우고 소문자, 254자까지, '로컬@도메인.최상위' 모양 (확인 메일은 없다)
 */
export type FieldCode = "required" | "login_id_format" | "password_length" | "password_mix" | "password_same_as_id" | "password_mismatch" | "email_format";
export type SignupField = "loginId" | "password" | "passwordConfirm" | "email";
export type FieldErrors = Partial<Record<SignupField, FieldCode>>;

export const LOGIN_ID_RE = /^[가-힣A-Za-z0-9_]{2,20}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** 보이는 아이디: 앞뒤 공백 없이 NFC */
export function normalizeLoginId(raw: string): string {
  return raw.trim().normalize("NFC");
}

/** 비교용 아이디 (대소문자 무시) */
export function loginIdKey(raw: string): string {
  return normalizeLoginId(raw).toLowerCase();
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 비밀번호 비교·해시에 쓰는 모양 (NFC — 같은 글자를 다른 조합으로 넣어도 같게) */
export function normalizePassword(raw: string): string {
  return raw.normalize("NFC");
}

export function loginIdError(raw: string): FieldCode | null {
  const id = normalizeLoginId(raw);
  if (!id) return "required";
  return LOGIN_ID_RE.test(id) ? null : "login_id_format";
}

/** 새 비밀번호 검사 (회원가입·비밀번호 바꾸기 공통) */
export function passwordError(raw: string, loginId: string): FieldCode | null {
  if (!raw) return "required";
  const pw = normalizePassword(raw);
  const len = [...pw].length;
  if (len < PASSWORD_MIN || len > PASSWORD_MAX) return "password_length";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "password_mix";
  if (loginId && pw.toLowerCase() === loginIdKey(loginId)) return "password_same_as_id";
  return null;
}

export function confirmError(password: string, confirm: string): FieldCode | null {
  if (!confirm) return "required";
  return normalizePassword(password) === normalizePassword(confirm) ? null : "password_mismatch";
}

export function emailError(raw: string): FieldCode | null {
  const e = normalizeEmail(raw);
  if (!e) return "required";
  return e.length <= EMAIL_MAX && EMAIL_RE.test(e) ? null : "email_format";
}

export interface SignupInput {
  loginId: string;
  password: string;
  passwordConfirm: string;
  email: string;
}

/** 칸별 첫 오류 (모두 맞으면 빈 객체) */
export function signupErrors(input: SignupInput): FieldErrors {
  const out: FieldErrors = {};
  const id = loginIdError(input.loginId);
  if (id) out.loginId = id;
  const pw = passwordError(input.password, id ? "" : input.loginId);
  if (pw) out.password = pw;
  const cf = confirmError(input.password, input.passwordConfirm);
  if (cf) out.passwordConfirm = cf;
  const em = emailError(input.email);
  if (em) out.email = em;
  return out;
}
