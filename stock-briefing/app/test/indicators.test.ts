import { describe, expect, it } from "vitest";
import { rsi } from "@/lib/indicators";

/**
 * 차트 RSI 는 서버(backend/src/analysis/indicators.ts)와 같은 정의 (BH-56).
 * 오른 폭·내린 폭이 모두 0 인 구간(거래정지 등으로 종가가 그대로)은 50(중립) — 100(과매수)이 아니다
 */
describe("BH-56: RSI 변동 없는 구간", () => {
  it("종가가 30개 모두 같으면 50 (서버와 같음, 재현: 앱은 100)", () => {
    const out = rsi(Array(30).fill(10000), 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(out.slice(14)).toEqual(Array(16).fill(50));
  });

  it("평평한 구간 뒤 첫 상승은 100, 이후는 Wilder 평활 — 서버 값과 같다", () => {
    const out = rsi([...Array(20).fill(100), 101, 99, 100], 14);
    // 서버 rsi 로 같은 입력을 계산한 값
    const server = [...Array(14).fill(null), 50, 50, 50, 50, 50, 50, 100, 31.707317073170728, 50.06858710562414];
    expect(out).toHaveLength(server.length);
    out.forEach((v, i) => (server[i] === null ? expect(v).toBeNull() : expect(v).toBeCloseTo(server[i] as number, 10)));
  });

  it("내림 없이 오르기만 하면 100, 오름 없이 내리기만 하면 0", () => {
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 + i), 14).at(-1)).toBe(100);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14).at(-1)).toBe(0);
  });
});
