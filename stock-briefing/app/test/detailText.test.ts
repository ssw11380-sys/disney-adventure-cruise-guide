import { describe, expect, it } from "vitest";
import { displayName, holdingLine, realText } from "@/lib/detailText";
import type { EvalView } from "@/lib/liveTick";

/**
 * 종목 상세 머리 글자 (2026-09-26 RGTX 접은 화면 캡처).
 *  - 업종 자리표시('-')를 그대로 적어 'RGTX · NASDAQ · -' 로 보였다 → 뺀다 (버그 수정)
 *  - 이름이 티커뿐('RGTX')이면 시세가 준 사람이 읽는 이름으로 (버그 수정, 새 서버만 — 없으면 지어내지 않고 티커 그대로)
 *  - 보유 한 줄 '보유 160주 · 평가손익 -2,342,254원 (-26.25%)' (기능 플래그 detailPolish)
 */
const ev = (o: Partial<EvalView>): EvalView => ({ marketValue: 0, costBasis: 0, profit: 0, profitRate: 0, currency: "KRW", estimated: false, krwBasis: null, ...o });

describe("자리표시 글자", () => {
  it("'-' · '—' · 'N/A' · 공백 · 빈 글자는 없음, 나머지는 앞뒤 공백만 뺀다", () => {
    for (const v of ["-", "—", "–", "N/A", "n/a", " ", "", "  -  ", null, undefined]) expect(realText(v), String(v)).toBeNull();
    expect(realText(" 반도체 ")).toBe("반도체");
    expect(realText("전화 및 소형 장치")).toBe("전화 및 소형 장치");
  });
});

describe("화면에 쓸 이름", () => {
  const FULL = "Defiance Daily Target 2X Long RGTI ETF";
  it("등록 이름이 티커뿐이면 시세의 이름(fullName)", () => {
    expect(displayName("RGTX", "RGTX", FULL)).toBe(FULL);
    expect(displayName("rgtx", "RGTX", FULL)).toBe(FULL);
    expect(displayName("BRK.B", "BRK-B", "버크셔 해서웨이 B")).toBe("버크셔 해서웨이 B");
    expect(displayName("", "RGTX", FULL)).toBe(FULL);
    expect(displayName(null, "RGTX", FULL)).toBe(FULL);
  });

  it("사람이 읽는 이름이 이미 있으면 그대로", () => {
    expect(displayName("삼성전자", "005930", "Samsung Electronics")).toBe("삼성전자");
    expect(displayName("애플", "AAPL", "Apple Inc.")).toBe("애플");
  });

  it("시세 이름이 없거나 자리표시이거나 그것도 티커면 지어내지 않고 등록 이름(없으면 코드)", () => {
    expect(displayName("RGTX", "RGTX", null)).toBe("RGTX");
    expect(displayName("RGTX", "RGTX", undefined)).toBe("RGTX");
    expect(displayName("RGTX", "RGTX", "-")).toBe("RGTX");
    expect(displayName("RGTX", "RGTX", "RGTX")).toBe("RGTX");
    expect(displayName(null, "RGTX", null)).toBe("RGTX");
  });
});

describe("보유 한 줄", () => {
  it("RGTX 캡처 값: 원화로 보기 · 손실", () => {
    const line = holdingLine(160, ev({ profit: -2_342_254.4, profitRate: -26.2512 }));
    expect(line).toEqual({
      quantity: "160",
      profit: "-2,342,254원",
      rate: "-26.25%",
      profitSign: -1,
      rateSign: -1,
      text: "보유 160주 · 평가손익 -2,342,254원 (-26.25%)",
      a11y: "보유 160주, 평가손익 2,342,254원 손실, 수익률 26.25% 하락",
    });
  });

  it("달러 · 이익 · 소수 주", () => {
    const line = holdingLine(2.5, ev({ profit: 123.456, profitRate: 4.2, currency: "USD" }));
    expect(line?.text).toMatch(/^보유 2\.5주 · 평가손익 \+\$123\.46 \(\+4\.20%\)$/);
    expect(line?.a11y).toBe("보유 2.5주, 평가손익 123.46달러 이익, 수익률 4.20% 상승");
    expect(line?.profitSign).toBe(1);
  });

  it("'0원' · '0.00%' 로 보이는 값은 색을 칠하지 않는다 (BH-38)", () => {
    const line = holdingLine(10, ev({ profit: 0.3, profitRate: 0.001 }));
    expect(line?.profitSign).toBe(0);
    expect(line?.rateSign).toBe(0);
    expect(line?.a11y).toBe("보유 10주, 평가손익 손익 없음, 수익률 보합");
  });

  it("보유 수량이나 평가가 없으면 줄이 없다 (관심 종목 · 평단 없음 · 시세 없음)", () => {
    expect(holdingLine(null, ev({}))).toBeNull();
    expect(holdingLine(0, ev({}))).toBeNull();
    expect(holdingLine(10, null)).toBeNull();
  });
});
