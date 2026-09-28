/**
 * 회원가입·비밀번호 검사 규칙 (계정 A단계, 플래그 accounts). 서버 backend/src/auth/rules.ts 와 같은 규칙 —
 * 둘 다 shared/fixtures/authRules.json 으로 같은 결과를 내는지 테스트한다 (app/test/authRules.test.ts).
 * 앱은 칸을 떠날 때·보낼 때 먼저 보여 주고, 최종 판단은 서버가 한다. React Native 를 불러오지 않는 순수 모듈
 */
export type FieldCode = "required" | "login_id_format" | "password_length" | "password_mix" | "password_same_as_id" | "password_mismatch" | "email_format";
export type SignupField = "loginId" | "password" | "passwordConfirm" | "email";
export type FieldErrors = Partial<Record<SignupField, FieldCode>>;

export const LOGIN_ID_RE = /^[가-힣A-Za-z0-9_]{2,20}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 64;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeLoginId(raw: string): string {
  return raw.trim().normalize("NFC");
}

export function loginIdKey(raw: string): string {
  return normalizeLoginId(raw).toLowerCase();
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function loginIdError(raw: string): FieldCode | null {
  const id = normalizeLoginId(raw);
  if (!id) return "required";
  return LOGIN_ID_RE.test(id) ? null : "login_id_format";
}

export function passwordError(raw: string, loginId: string): FieldCode | null {
  if (!raw) return "required";
  const pw = raw.normalize("NFC");
  const len = [...pw].length;
  if (len < PASSWORD_MIN || len > PASSWORD_MAX) return "password_length";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "password_mix";
  if (loginId && pw.toLowerCase() === loginIdKey(loginId)) return "password_same_as_id";
  return null;
}

export function confirmError(password: string, confirm: string): FieldCode | null {
  if (!confirm) return "required";
  return password.normalize("NFC") === confirm.normalize("NFC") ? null : "password_mismatch";
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

/** 칸별 첫 오류 (모두 맞으면 빈 객체) — 서버와 같은 결과 */
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

/** 칸 이름 (빈 칸 문구에 쓴다) */
const REQUIRED: Record<string, string> = {
  loginId: "아이디를 넣어 주세요",
  password: "비밀번호를 넣어 주세요",
  passwordConfirm: "비밀번호를 한 번 더 넣어 주세요",
  email: "이메일을 넣어 주세요",
  current: "지금 비밀번호를 넣어 주세요",
  next: "새 비밀번호를 넣어 주세요",
  nextConfirm: "새 비밀번호를 한 번 더 넣어 주세요",
};

/** 칸 오류 코드 → 쉬운 말 (서버가 준 코드도 같은 문구로) */
export function fieldMessage(field: string, code: string): string {
  switch (code) {
    case "required":
      return REQUIRED[field] ?? "넣어 주세요";
    case "login_id_format":
      return "2~20자, 한글·영문·숫자·밑줄(_)만 쓸 수 있어요";
    case "password_length":
      return "8~64자로 넣어 주세요";
    case "password_mix":
      return "영문과 숫자를 함께 넣어 주세요";
    case "password_same_as_id":
      return "아이디와 다른 비밀번호를 써 주세요";
    case "password_mismatch":
      return "비밀번호가 서로 달라요";
    case "email_format":
      return "이메일 모양을 확인해 주세요";
    case "login_id_taken":
      return "이미 쓰고 있는 아이디예요";
    case "email_taken":
      return "이미 가입한 이메일이에요";
    case "bad_current_password":
      return "지금 비밀번호가 맞지 않아요";
    default:
      return "입력한 내용을 확인해 주세요";
  }
}

/** 회원가입 버튼 아래 한 줄 (이메일을 왜 받는지 — 그 밖의 입력은 없다) */
export const EMAIL_NOTE = "이메일은 비밀번호를 잃어버렸을 때 확인용으로만 씁니다.";

/** 회원가입 칸 도움말 (칸 아래 작은 글) */
export const HELP = {
  loginId: "2~20자, 한글·영문·숫자·밑줄(_)",
  password: "8자 이상, 영문과 숫자를 함께",
} as const;
