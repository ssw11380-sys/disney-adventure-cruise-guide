import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/api/client";
import { AUTH_TEXT, authErrorView } from "@/lib/authErrors";
import { heroCandles, heroLayout, LIMIT_COUNT, logoBox } from "@/lib/loginHero";

/**
 * 로그인 화면 배치 (hero-spec.md 4.2 표의 네 크기 — 위 28·아래 24, 933×704 는 위 24·아래 16)와 그림 기하(5장), 오류 문구.
 * 한 칸 그림 높이는 명세 0.42 가 아니라 0.40 (360×752 폰에서 '서버 설정'·고지 문구까지 한 화면에 들어오게 — tokens authLayout.heroRatio)
 */
describe("로그인 배치 (hero-spec 4.2)", () => {
  it("360×752 한 칸: 그림 308(안전 영역 포함), 입력 x 24 · 폭 312, 로고 30", () => {
    const l = heroLayout(360, 752, { top: 28, bottom: 24 });
    expect(l).toMatchObject({ mode: "one", gutter: 24, formW: 312, formX: 24, heroW: 360, heroH: 308, logoSize: 30, logoX: 24, logoY: 44 });
    expect(l.plot).toEqual({ x0: 24, y0: 40, w: 312, h: 256 });
  });
  it("475×751 한 칸 (접은 폴드8): 입력 27.5 · 420, 그림 칸도 같은 폭 (로고·차트·입력 칸 왼쪽 끝이 한 줄)", () => {
    const l = heroLayout(475, 751, { top: 28, bottom: 24 });
    expect(l).toMatchObject({ mode: "one", formW: 420, formX: 27.5, heroH: 308, logoSize: 30, logoX: 27.5 });
    expect(l.plot).toEqual({ x0: 27.5, y0: 40, w: 420, h: 256 });
  });
  it("933×704 두 칸 (펼친 폴드8 가로): 왼쪽 그림 513 · 오른쪽 입력 545 · 356, 로고 34", () => {
    const l = heroLayout(933, 704, { top: 24, bottom: 16 });
    expect(l).toMatchObject({ mode: "two", formW: 356, formX: 545, heroW: 513, heroH: 704, logoSize: 34, logoX: 40, logoY: 143.5 });
    expect(l.plot).toEqual({ x0: 40, y0: 139.5, w: 433, h: 433 });
  });
  it("704×933 한 칸 (펼친 폴드8 세로): 가운데 420, 그림 380 — 그림 칸도 입력 칸과 같은 142 · 420 (왼쪽 선이 둘로 보이지 않게)", () => {
    const l = heroLayout(704, 933, { top: 28, bottom: 24 });
    expect(l).toMatchObject({ mode: "one", gutter: 32, formW: 420, formX: 142, heroH: 380, logoSize: 34, logoX: 142 });
    expect(l.plot).toEqual({ x0: 142, y0: 40, w: 420, h: 328 });
  });
  it("한 칸이면 어느 크기에서나 그림 칸 = 입력 칸 (왼쪽 끝·폭), 로고도 같은 왼쪽 끝", () => {
    for (const W of [320, 360, 393, 412, 475, 600, 704, 768])
      for (const H of [640, 752, 933, 1024]) {
        const l = heroLayout(W, H, { top: 28, bottom: 24 });
        if (l.mode !== "one") continue;
        expect([l.plot.x0, l.plot.w, l.logoX], `${W}×${H}`).toEqual([l.formX, l.formW, l.formX]);
      }
  });
});

describe("그림 기하 (hero-spec 5장)", () => {
  it("360×752: 봉 26개, 몸통 7 · 꼬리 1.5, 한 계단 17.6, 첫 상한가 시가 261.2, 마지막 종가 86.1 (그림 칸 위에서 0.18 — 불기둥이 상태 표시줄 밑으로 올라가지 않게)", () => {
    const g = heroCandles(heroLayout(360, 752, { top: 28, bottom: 24 }).plot);
    expect(g.candles).toHaveLength(26);
    expect(g.candles.filter((c) => c.kind === "limit")).toHaveLength(LIMIT_COUNT);
    expect(g.bw).toBeCloseTo(7, 0);
    expect(g.wickW).toBe(1.5);
    const limits = g.candles.filter((c) => c.kind === "limit");
    expect(limits[0]!.bottom).toBeCloseTo(261.15, 1);
    expect(limits[9]!.top).toBeCloseTo(86.08, 1);
    expect(limits[0]!.bottom - limits[1]!.bottom).toBeCloseTo(17.61, 1);
    // 상한가 봉은 윗꼬리가 없다 (고가 = 종가)
    for (const c of limits) expect(c.high).toBe(c.top);
    // 늘 같은 그림
    expect(heroCandles(heroLayout(360, 752, { top: 28, bottom: 24 }).plot)).toEqual(g);
  });
  it("네 크기에서 상한가 봉이 로고 묶음(글자·선·부제, +8dp)과 겹치지 않는다", () => {
    for (const [W, H, top, bottom] of [
      [360, 752, 28, 24],
      [475, 751, 28, 24],
      [933, 704, 24, 16],
      [704, 933, 28, 24],
    ] as const) {
      const l = heroLayout(W, H, { top, bottom });
      const g = heroCandles(l.plot);
      // 로고 묶음: '가즈아 불기둥' 글자 폭 ≈ 글자 크기 × 6.3 (웹 실측 5.6), 높이 = 글자 칸 + 선 + 부제
      const lb = logoBox(l);
      expect(lb.w).toBe(Math.round(l.logoSize * 6.3));
      const box = { x1: lb.x + lb.w + 8, y1: lb.y + lb.h + 8 };
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
