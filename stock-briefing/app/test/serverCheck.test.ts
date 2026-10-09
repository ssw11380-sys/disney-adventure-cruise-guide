import { describe, expect, it, vi } from "vitest";
import type { Health } from "@/api/types";
import { checkSaved } from "@/lib/serverCheck";

/**
 * 로그인 전 '서버 설정'에서 맞는 API 토큰으로 고쳐 저장했을 때 (계정 A단계 검증 지적):
 * 예전에는 화면의 health.refetch() 가 옛 토큰의 요청 함수로 돌아 '토큰 필요'가 남고 로그인 화면으로 돌아가지 않았다.
 * 이제는 저장한 주소·토큰으로 직접 묻고, 결과를 새 주소의 캐시에 넣는다
 */
const health = (limited: boolean): Health => ({ ok: true, limited, authRequired: true, time: "t", sources: {}, schedule: null, disclaimer: "d" }) as unknown as Health;

describe("서버 설정 저장 뒤 연결 확인 (checkSaved)", () => {
  it("저장한 값(끝 / 와 공백을 뺀 주소, 토큰)으로 묻고, 토큰이 맞으면 true + 새 주소 캐시에 넣는다", async () => {
    const api = vi.fn((_u: string, _t: string) => ({ health: async () => health(false) }));
    const put = vi.fn();
    expect(await checkSaved(" https://prod.test/ ", " right-token ", put, api)).toBe(true);
    expect(api).toHaveBeenCalledWith("https://prod.test", "right-token");
    expect(put).toHaveBeenCalledWith("https://prod.test", health(false));
  });
  it("토큰이 아직 틀리면(limited) false — 로그인 화면으로 돌아가지 않고 '토큰 필요'를 보인다", async () => {
    const put = vi.fn();
    expect(await checkSaved("https://prod.test", "wrong", put, () => ({ health: async () => health(true) }))).toBe(false);
    expect(put).toHaveBeenCalledWith("https://prod.test", health(true));
  });
  it("연결 오류는 false (캐시는 건드리지 않는다 — 화면의 확인이 오류를 보인다)", async () => {
    const put = vi.fn();
    expect(await checkSaved("https://down.test", "x", put, () => ({ health: async () => Promise.reject(new TypeError("Network request failed")) }))).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});
