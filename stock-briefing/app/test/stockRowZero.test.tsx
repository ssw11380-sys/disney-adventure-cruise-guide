import React from "react";
import { describe, expect, it, vi } from "vitest";
import { holding, quote } from "./helpers";
import { render } from "./miniRender";

/**
 * 잔고 한 줄의 평가손익 칸 (BH-38): 화면에 0 으로 보이는 손익을 "-0"·파랑(손실 색)으로 그리지 않는다.
 * 토스 소수점 주식을 평단 근처에서 산 직후처럼 손익이 1원·1센트 미만일 때
 */
vi.mock("react-native", () => ({ StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 }, Platform: { OS: "android" } }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/components/StockLine", async () => {
  const R = await import("react");
  const StockLine = ({ right, accessibilityLabel, price }: { right: React.ReactNode; accessibilityLabel: string; price: unknown }) => R.createElement("StockLine", { accessibilityLabel, price }, right);
  return { LINE_COL: {}, LineMark: "LineMark", LineValue: "LineValue", StockLine };
});

const { StockRow } = await import("@/components/StockRow");
const { light } = await import("@/tokens");

const draw = (stock: ReturnType<typeof holding>, showKrw = false) => {
  const r = render(<StockRow stock={stock} onPress={() => undefined} showKrw={showKrw} afterCost={false} />);
  const v = r.all().find((n) => n.type === "LineValue")!;
  const line = r.all().find((n) => n.type === "StockLine")!;
  const price = line.props.price as { text: string; color: string; rate: string; rateColor: string };
  return { main: v.props.main, mainColor: v.props.mainColor, sub: v.props.sub, subColor: v.props.subColor, label: String(line.props.accessibilityLabel), price };
};

describe("BH-38: 반올림하면 0 인 평가손익", () => {
  it("미국 소수점 보유: -$0.00·-0.00% 파랑 대신 $0.00·0.00% 기본 글자색 (재현)", () => {
    const qty = 0.052631;
    const row = draw(holding("AAPL", quote("AAPL", 190, { currency: "USD" }), qty, 10 / qty)); // 매입 $10.00, 평가 $9.99989
    expect(row.main).toBe("$0.00");
    expect(row.sub).toBe("0.00%");
    expect(row.mainColor).toBe(light.ink);
    expect(row.subColor).toBe(light.ink);
    expect(row.label).toContain("손익 없음");
  });

  it("국내 1주 평단 1,833.33원·현재가 1,833원: 손익 칸은 '-0' 이 아니라 '0' (기본 글자색)", () => {
    const row = draw(holding("005930", quote("005930", 1833), 1, 1833.33));
    expect(row.main).toBe("0");
    expect(row.mainColor).toBe(light.ink);
    expect(row.sub).toBe("-0.02%"); // 수익률은 보이는 대로 손실
    expect(row.subColor).toBe(light.down);
    expect(row.label).toContain("손익 없음");
  });

  it("보이는 손실·이익은 예전처럼 부호와 색", () => {
    const down = draw(holding("005930", quote("005930", 1800), 2, 1833));
    expect(down.main).toBe("-66");
    expect(down.mainColor).toBe(light.down);
    const up = draw(holding("005930", quote("005930", 1900), 1, 1833));
    expect(up.main).toBe("+67");
    expect(up.mainColor).toBe(light.up);
    expect(up.subColor).toBe(light.up);
  });
});

describe("BH-38 검증 지적: 1센트 미만으로 움직인 동전주 (전역 반올림 기준 회귀)", () => {
  // 0.05달러 종목이 0.004달러(-7.41%) 내림: 등락률·원화 화살표는 뚜렷한 하락이다 → 하락 색 (위젯의 tone(change) 와 같게)
  const penny = holding("SNDL", quote("SNDL", 0.05, { currency: "USD", change: -0.004, changeRate: -7.41, fxRate: 1360 }), null, null);

  it("달러 보기: 현재가·'-7.41%' 는 하락 색, 0 으로 보이는 화살표만 기본 글자색", () => {
    const row = draw(penny);
    expect(row.price.rate).toBe("-7.41%");
    expect(row.price.rateColor).toBe(light.down);
    expect(row.price.color).toBe(light.down);
    expect(row.main).toBe("0");
    expect(row.mainColor).toBe(light.ink);
    expect(row.label).toContain("7.41% 하락");
  });

  it("원화 보기: '▼5' 는 하락 색", () => {
    const row = draw(penny, true);
    expect(row.main).toBe("▼5");
    expect(row.mainColor).toBe(light.down);
    expect(row.price.rateColor).toBe(light.down);
    expect(row.label).toContain("5원 하락");
  });

  it("230달러 종목 1센트 하락(-0.0043%): 화살표는 하락 색, '0.00%' 는 기본 글자색·보합으로 읽음", () => {
    const row = draw(holding("AAPL", quote("AAPL", 229.99, { currency: "USD", change: -0.01, changeRate: -0.0043 }), null, null));
    expect(row.main).toBe("▼0.01");
    expect(row.mainColor).toBe(light.down);
    expect(row.price.rate).toBe("0.00%");
    expect(row.price.rateColor).toBe(light.ink);
    expect(row.label).toContain("보합");
  });
});
