import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fieldMessage, HELP, loginIdKey, normalizeEmail, normalizeLoginId, passwordError, signupErrors, type SignupInput } from "@/lib/authRules";

/** 회원가입 규칙: 서버(backend/src/auth/rules.ts)와 같은 결과인지 공용 픽스처로 (shared/fixtures/authRules.json) */
const fx = JSON.parse(readFileSync(new URL("../../shared/fixtures/authRules.json", import.meta.url), "utf8")) as {
  signup: Array<{ name: string; input: SignupInput; fields: Record<string, string>; normalized?: { loginId: string; loginIdKey: string; email: string } }>;
};

describe("회원가입 규칙 (공용 픽스처)", () => {
  for (const c of fx.signup) {
    it(c.name, () => {
      expect(signupErrors(c.input)).toEqual(c.fields);
      if (c.normalized) {
        expect(normalizeLoginId(c.input.loginId)).toBe(c.normalized.loginId);
        expect(loginIdKey(c.input.loginId)).toBe(c.normalized.loginIdKey);
        expect(normalizeEmail(c.input.email)).toBe(c.normalized.email);
      }
    });
  }
});

describe("문구 (쉬운 말, 느낌표·이모지 없음)", () => {
  it("칸별 오류 코드마다 한국어 문구", () => {
    expect(fieldMessage("loginId", "required")).toBe("아이디를 넣어 주세요");
    expect(fieldMessage("password", "required")).toBe("비밀번호를 넣어 주세요");
    expect(fieldMessage("passwordConfirm", "password_mismatch")).toBe("비밀번호가 서로 달라요");
    expect(fieldMessage("password", "password_same_as_id")).toBe("아이디와 다른 비밀번호를 써 주세요");
    expect(fieldMessage("loginId", "login_id_taken")).toBe("이미 쓰고 있는 아이디예요");
    expect(fieldMessage("email", "email_taken")).toBe("이미 가입한 이메일이에요");
    const all = ["required", "login_id_format", "password_length", "password_mix", "password_same_as_id", "password_mismatch", "email_format", "login_id_taken", "email_taken", "bad_current_password", "모름"].map((c) => fieldMessage("x", c));
    for (const m of [...all, HELP.loginId, HELP.password]) {
      expect(m).not.toMatch(/[!！]/);
      expect(m).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(m).not.toMatch(/수익|추천|보장|대박/);
    }
  });

  it("비밀번호 바꾸기도 같은 규칙 (아이디와 같으면 안 됨)", () => {
    expect(passwordError("seo12345", "SEO12345")).toBe("password_same_as_id");
    expect(passwordError("1111", "서성원")).toBe("password_length");
    expect(passwordError("abcd1234", "서성원")).toBeNull();
  });
});
