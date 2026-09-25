import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 공용 등락 글자(ChangeText)·등락률 상자(RateBox)의 색 (BH-38 검증 지적): 색은 보이는 글자의 부호로 정한다.
 * 브리핑 상세 '보유 손익'·전체 화면 차트 머리·브리핑 목록 등락률이 모두 이 부품을 쓴다
 */
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Switch: "Switch",
  ActivityIndicator: "ActivityIndicator",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});

const { ChangeText, RateBox } = await import("@/components/ui");
const { formatPct, formatPrice } = await import("@/lib/format");
const { light } = await import("@/tokens");

const colorOf = (value: number | null, text: string) => {
  const node = render(<ChangeText value={value} text={text} />).all().find((n) => n.type === "Text")!;
  return (node.props.style as Record<string, unknown>[]).find((s) => s && "color" in s)!.color;
};
const boxOf = (value: number | null, text: string) => {
  const r = render(<RateBox value={value} text={text} />);
  const box = r.all().find((n) => n.type === "View")!;
  const label = r.all().find((n) => n.type === "Text")!;
  const bg = (box.props.style as Record<string, unknown>[]).find((s) => s && "backgroundColor" in s)!.backgroundColor;
  const fg = (label.props.style as Record<string, unknown>[]).find((s) => s && "color" in s)!.color;
  return { bg, fg };
};
/** 브리핑 상세 '보유 손익'·차트 머리가 만드는 글자: "+$1.23 (+0.45%)" */
const moveText = (amount: number, rate: number, cur: "KRW" | "USD") => `${formatPrice(amount, cur, { sign: true })} (${formatPct(rate)})`;

describe("BH-38: ChangeText — 0 으로 보이는 등락·손익은 기본 글자색", () => {
  it("브리핑 상세 '보유 손익' $0.00 (0.00%) — 토스 소수점 0.052631주 $10 매수, 가격 190 (재현: 파랑)", () => {
    const profit = 190 * 0.052631 - 10; // -0.00011
    const text = moveText(profit, (profit / 10) * 100, "USD");
    expect(text).toBe("$0.00 (0.00%)");
    expect(colorOf(profit, text)).toBe(light.ink);
  });

  it("원화 0원 (0.00%) 도 기본 글자색", () => {
    const text = moveText(-0.4, -0.00002, "KRW");
    expect(text).toBe("0원 (0.00%)");
    expect(colorOf(-0.4, text)).toBe(light.ink);
  });

  it("차트 머리: 230달러 종목 -$0.004 은 기본 글자색, 1센트 하락은 하락 색", () => {
    expect(colorOf(-0.004, moveText(-0.004, -0.0017, "USD"))).toBe(light.ink);
    expect(colorOf(-0.01, moveText(-0.01, -0.0043, "USD"))).toBe(light.down);
  });

  it("동전주: 금액은 $0.00 이어도 '-7.41%' 가 보이면 하락 색", () => {
    expect(colorOf(-0.004, moveText(-0.004, -7.41, "USD"))).toBe(light.down);
  });

  it("보이는 등락은 예전처럼, 값 없음은 회색", () => {
    expect(colorOf(1.5, formatPct(1.5))).toBe(light.up);
    expect(colorOf(-1.5, formatPct(-1.5))).toBe(light.down);
    expect(colorOf(0, formatPct(0))).toBe(light.ink);
    expect(colorOf(null, formatPct(null))).toBe(light.muted);
  });

  it("가격을 보여 주는 글자(애프터마켓 가격)는 전일 대비 방향 색 그대로", () => {
    expect(colorOf(-0.004, `${formatPrice(229.99, "USD")} (${formatPct(-0.0017)})`)).toBe(light.down);
  });
});

describe("BH-38: RateBox — '0.00%' 는 보합 칸", () => {
  it("반올림하면 0 인 등락률은 칠하지 않는다", () => {
    expect(boxOf(-0.004, formatPct(-0.004))).toEqual({ bg: light.surfaceAlt, fg: light.muted });
    expect(boxOf(0.004, formatPct(0.004))).toEqual({ bg: light.surfaceAlt, fg: light.muted });
  });

  it("보이는 등락은 예전처럼 칠한다", () => {
    expect(boxOf(1.2, formatPct(1.2))).toEqual({ bg: light.upFill, fg: light.onFill });
    expect(boxOf(-1.2, formatPct(-1.2))).toEqual({ bg: light.downFill, fg: light.onFill });
  });
});
