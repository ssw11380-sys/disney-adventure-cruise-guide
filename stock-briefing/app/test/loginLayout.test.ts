import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/api/client";
import { AUTH_TEXT, authErrorView } from "@/lib/authErrors";
import { heroCandles, heroLayout, LIMIT_COUNT } from "@/lib/loginHero";

/**
 * 로그인 화면 배치 (hero-spec.md 4.2 표의 네 크기 — 위 28·아래 24, 933×704 는 위 24·아래 16)와 그림 기하(5장), 오류 문구
 */
describe("로그인 배치 (hero-spec 4.2)", () => {
  it("360×752 한 칸: 그림 322(안전 영역 포함), 입력 x 24 · 폭 312, 로고 30", () => {
    const l = heroLayout(360, 752, { top: 28, bottom: 24 });
    expect(l).toMatchObject({ mode: "one", gutter: 24, formW: 312, formX: 24, heroW: 360, heroH: 322, logoSize: 30, logoX: 24, logoY: 44 });
    expect(l.plot).toEqual({ x0: 24, y0: 40, w: 312, h: 270 });
  });
  it("475×751 한 칸 (접은 폴드8): 입력 27.5 · 420", () => {
    const l = heroLayout(475, 751, { top: 28, bottom: 24 });
    expect(l).toMatchObject({ mode: "one", formW: 420, formX: 27.5, heroH: 322, logoSize: 30 });
    expect(l.plot).toEqual({ x0: 24, y0: 40, w: 427, h: 270 });
  });
  it("933×704 두 칸 (펼친 폴드8 가로): 왼쪽 그림 513 · 오른쪽 입력 545 · 356, 로고 34", () => {
    const l = heroLayout(933, 704, { top: 24, bottom: 16 });
    expect(l).toMatchObject({ mode: "two", formW: 356, formX: 545, heroW: 513, heroH: 704, logoSize: 34, logoX: 40, logoY: 143.5 });
    expect(l.plot).toEqual({ x0: 40, y0: 139.5, w: 433, h: 433 });
  });
  it("704×933 한 칸 (펼친 폴드8 세로): 가운데 420, 그림 398", () => {
    const l = heroLayout(704, 933, { top: 28, bottom: 24 });
    expect(l).toMatchObject({ mode: "one", gutter: 32, formW: 420, formX: 142, heroH: 398, logoSize: 34, logoX: 142 });
    expect(l.plot).toEqual({ x0: 72, y0: 40, w: 560, h: 346 });
  });
  it("키보드가 뜨면 한 칸 그림을 72dp 로 접는다 (두 칸은 그대로)", () => {
    expect(heroLayout(360, 752, { top: 28, bottom: 24 }, true)).toMatchObject({ heroH: 100, collapsed: true });
    expect(heroLayout(933, 704, { top: 24, bottom: 16 }, true)).toMatchObject({ mode: "two", collapsed: false });
  });
});

describe("그림 기하 (hero-spec 5장)", () => {
  it("360×752: 봉 26개, 몸통 7 · 꼬리 1.5, 한 계단 20.2, 첫 상한가 시가 273.1, 마지막 종가 72.4", () => {
    const g = heroCandles(heroLayout(360, 752, { top: 28, bottom: 24 }).plot);
    expect(g.candles).toHaveLength(26);
    expect(g.candles.filter((c) => c.kind === "limit")).toHaveLength(LIMIT_COUNT);
    expect(g.bw).toBeCloseTo(7, 0);
    expect(g.wickW).toBe(1.5);
    const limits = g.candles.filter((c) => c.kind === "limit");
    expect(limits[0]!.bottom).toBeCloseTo(273.1, 1);
    expect(limits[9]!.top).toBeCloseTo(72.4, 1);
    expect(limits[0]!.bottom - limits[1]!.bottom).toBeCloseTo(20.2, 1);
    // 상한가 봉은 윗꼬리가 없다 (고가 = 종가)
    for (const c of limits) expect(c.high).toBe(c.top);
    // 늘 같은 그림
    expect(heroCandles(heroLayout(360, 752, { top: 28, bottom: 24 }).plot)).toEqual(g);
  });
  it("모든 크기에서 상한가 봉이 로고 상자(+8dp)와 겹치지 않는다", () => {
    for (const [W, H, top, bottom] of [
      [360, 752, 28, 24],
      [475, 751, 28, 24],
      [933, 704, 24, 16],
      [704, 933, 28, 24],
    ] as const) {
      const l = heroLayout(W, H, { top, bottom });
      const g = heroCandles(l.plot);
      // 로고 상자: '가즈아 불기둥' 6글자 ≈ 글자 크기 × 6.2 폭, 높이 = 글자 크기 × 1.3
      const box = { x1: l.logoX + l.logoSize * 6.2 + 8, y1: l.logoY + l.logoSize * 1.3 + 8 };
      for (const c of g.candles.filter((x) => x.kind === "limit")) {
        const overlaps = c.cx - g.bw / 2 < box.x1 && c.top < box.y1;
        expect(overlaps, `${W}×${H} 봉 ${c.cx.toFixed(1)}`).toBe(false);
      }
    }
  });
});

describe("로그인·가입 오류 문구", () => {
  const err = (status: number, code: string, body?: Record<string, unknown>) => new ApiRequestError(status, code, "x", "/api/auth/login", "https://prod.test", body);
  it("인터넷·시간 초과·API 토큰·서버 문제", () => {
    expect(authErrorView(err(0, "NETWORK"))).toEqual({ message: AUTH_TEXT.network, fields: {}, showServer: false, failOpen: false });
    expect(authErrorView(err(0, "TIMEOUT")).message).toBe(AUTH_TEXT.timeout);
    expect(authErrorView(err(401, "UNAUTHORIZED", { error: "UNAUTHORIZED" }))).toMatchObject({ message: "서버 연결 설정을 확인해 주세요 (API 토큰)", showServer: true });
    expect(authErrorView(err(502, "HTTP_502")).message).toBe("서버에 잠시 문제가 있어요. 잠시 뒤 다시 해 주세요");
    expect(authErrorView(err(503, "AUTH_UNAVAILABLE", { code: "auth_unavailable" })).message).toBe(AUTH_TEXT.server);
  });
  it("예전 서버(우리 서버의 404)는 로그인 없이 지금처럼, 다른 곳의 404 는 서버 주소 확인", () => {
    expect(authErrorView(err(404, "NOT_FOUND", { error: "NOT_FOUND", message: "없는 주소입니다" }))).toMatchObject({ failOpen: true, message: null });
    expect(authErrorView(err(404, "HTTP_404"))).toMatchObject({ failOpen: false, showServer: true, message: "서버 주소를 확인해 주세요" });
  });
  it("틀림·잠김·칸별 오류", () => {
    expect(authErrorView(err(400, "BAD_CREDENTIALS", { code: "bad_credentials", message: "아이디 또는 비밀번호가 맞지 않아요" })).message).toBe("아이디 또는 비밀번호가 맞지 않아요");
    expect(authErrorView(err(429, "TOO_MANY_ATTEMPTS", { code: "too_many_attempts", message: "여러 번 틀려서 잠시 막아 두었어요. 10분 뒤에 다시 해 주세요" })).message).toContain("10분 뒤");
    expect(authErrorView(err(400, "INVALID", { code: "invalid", fields: { loginId: "login_id_format", passwordConfirm: "password_mismatch" } }))).toEqual({
      message: null,
      fields: { loginId: "2~20자, 한글·영문·숫자·밑줄(_)만 쓸 수 있어요", passwordConfirm: "비밀번호가 서로 달라요" },
      showServer: false,
      failOpen: false,
    });
    expect(authErrorView(err(409, "LOGIN_ID_TAKEN", { code: "login_id_taken", fields: { loginId: "login_id_taken" } })).fields).toEqual({ loginId: "이미 쓰고 있는 아이디예요" });
  });
});
