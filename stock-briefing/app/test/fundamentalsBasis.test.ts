import { describe, expect, it } from "vitest";
import { fundamentalsBasisText } from "@/lib/fundamentalsBasis";
import type { Quote } from "@/api/types";

const basis: NonNullable<Quote["fundamentalsBasis"]> = { receivedAt: "2026-12-28T09:30:00+09:00", refreshFailed: false, source: "naver", fields: ["pbr", "dividendYieldPct"] };
describe("상세 재무 숫자의 수신 시각과 실패 안내", () => {
  it("정상 자료는 실제 보강 항목과 출처·원 수신 시각을 표시하고 공시 기준과 구분한다", () => {
    const text = fundamentalsBasisText(basis)!;
    expect(text.title).toBe("재무 자료 기준"); expect(text.warning).toBe(false);
    expect(text.detail).toContain("PBR·배당수익률 · 네이버");
    expect(text.detail).toContain("2026"); expect(text.detail).toContain("09:30");
    expect(text.detail).toContain("수신"); expect(text.detail).toContain("공시·결산 기준일과는 다릅니다");
    expect(text.detail).not.toContain("PER");
  });
  it("실제 갱신 실패는 이전 자료임을 알리고 같은 원 시각을 유지한다", () => {
    const text = fundamentalsBasisText({ ...basis, refreshFailed: true })!;
    expect(text.title).toBe("재무 갱신 실패 · 이전 자료");
    expect(text.warning).toBe(true); expect(text.detail).toContain("09:30");
  });
  it("빈 날짜·틀린 날짜를 현재 날짜로 대신하거나 Invalid Date로 출력하지 않는다", () => {
    for (const receivedAt of [null, "", " ", "not-a-date"]) {
      const text = fundamentalsBasisText({ ...basis, receivedAt })!;
      expect(text.detail).toContain("수신 시각 미확인"); expect(text.detail).not.toMatch(/NaN|Invalid Date/);
    }
  });
  it("구버전 응답·정상 보강 없음은 배지를 만들지 않으며 최초 실패는 이전 자료가 있다고 꾸미지 않는다", () => {
    expect(fundamentalsBasisText(undefined)).toBeNull();
    expect(fundamentalsBasisText({ ...basis, fields: [] })).toBeNull();
    const text = fundamentalsBasisText({ ...basis, fields: [], receivedAt: null, refreshFailed: true })!;
    expect(text.title).toBe("재무 보강 갱신 실패"); expect(text.detail).not.toContain("이전 자료");
  });
});
