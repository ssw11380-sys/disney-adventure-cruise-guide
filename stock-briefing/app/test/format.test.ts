import { describe, expect, it } from "vitest";
import { formatArrow, formatKrwCompact, formatPct, formatPrice, formatQuote, formatVolume, formatWon, isTradingHoursKst, toDisplay } from "@/lib/format";

describe("금액 표기", () => {
  it("원화: 반올림·부호", () => {
    expect(formatWon(1234.5)).toBe("1,235원");
    expect(formatWon(-500, { sign: true })).toBe("-500원");
    expect(formatWon(500, { sign: true })).toBe("+500원");
    expect(formatWon(0, { sign: true })).toBe("0원");
    expect(formatWon(null)).toBe("-");
    expect(formatWon(Number.NaN)).toBe("-");
  });
  it("달러: 소수 둘째 자리", () => {
    expect(formatPrice(1234.5, "USD")).toBe("$1,234.50");
    expect(formatPrice(-0.3, "USD", { sign: true })).toBe("-$0.30");
  });
  it("원화 보기: 달러 × 환율, 환율 없으면 달러", () => {
    expect(toDisplay(10, "USD", 1360, true)).toEqual({ value: 13_600, currency: "KRW" });
    expect(toDisplay(10, "USD", null, true)).toEqual({ value: 10, currency: "USD" });
    expect(toDisplay(10, "USD", 1360, false)).toEqual({ value: 10, currency: "USD" });
  });
});

describe("등락률·호가", () => {
  it("등락률 부호와 천 단위", () => {
    expect(formatPct(3.456)).toBe("+3.46%");
    expect(formatPct(-0.5)).toBe("-0.50%");
    expect(formatPct(0)).toBe("0.00%");
    expect(formatPct(280.83)).toBe("+280.83%");
    expect(formatPct(1234.5)).toBe("+1,234.50%");
  });
  it("호가와 화살표", () => {
    expect(formatQuote(71500.4, "KRW")).toBe("71,500");
    expect(formatQuote(44.5, "USD")).toBe("44.50");
    expect(formatArrow(2500, "KRW")).toBe("▲2,500");
    expect(formatArrow(-0.3, "USD")).toBe("▼0.30");
    expect(formatArrow(0, "KRW")).toBe("0");
  });
});

describe("큰 금액 단위 경계", () => {
  it("원화 억·조", () => {
    expect(formatKrwCompact(5_000)).toBe("5,000원");
    expect(formatKrwCompact(12_345)).toBe("1만원");
    expect(formatKrwCompact(9_999.4e4)).toBe("9,999만원");
    expect(formatKrwCompact(9_999.5e4)).toBe("1억원");
    expect(formatKrwCompact(9_999.4e8)).toBe("9,999억원");
    expect(formatKrwCompact(9_999.5e8)).toBe("1.0조원");
    expect(formatKrwCompact(12.3e12)).toBe("12조원");
    expect(formatKrwCompact(-3e8)).toBe("-3억원");
  });
  it("달러 K·M·B·T", () => {
    expect(formatKrwCompact(999, "USD")).toBe("$999");
    expect(formatKrwCompact(12_345, "USD")).toBe("$12K");
    expect(formatKrwCompact(999.5e3, "USD")).toBe("$1.0M");
    expect(formatKrwCompact(999.95e6, "USD")).toBe("$1.0B");
    expect(formatKrwCompact(999.94e9, "USD")).toBe("$999.9B");
    expect(formatKrwCompact(999.95e9, "USD")).toBe("$1.00T");
  });
  it("거래량", () => {
    expect(formatVolume(9_999)).toBe("9,999");
    expect(formatVolume(123_456)).toBe("12만");
    expect(formatVolume(9_999.5e4)).toBe("1.0억");
  });
});

describe("장 시간 (KST)", () => {
  const kst = (s: string) => new Date(`${s}+09:00`);
  it("평일 낮·밤은 열림, 새벽 7시~8시는 닫힘", () => {
    expect(isTradingHoursKst(kst("2026-09-23T10:00:00"))).toBe(true);
    expect(isTradingHoursKst(kst("2026-09-23T23:00:00"))).toBe(true);
    expect(isTradingHoursKst(kst("2026-09-23T07:30:00"))).toBe(false);
  });
  it("주말", () => {
    expect(isTradingHoursKst(kst("2026-09-26T06:00:00"))).toBe(true); // 토 새벽 = 미국 금요일 장
    expect(isTradingHoursKst(kst("2026-09-26T12:00:00"))).toBe(false);
    expect(isTradingHoursKst(kst("2026-09-27T12:00:00"))).toBe(false);
    expect(isTradingHoursKst(kst("2026-09-28T07:00:00"))).toBe(false); // 월 08시 전
  });
});
