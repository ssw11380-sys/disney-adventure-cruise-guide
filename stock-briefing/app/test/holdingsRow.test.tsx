import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ColumnPlan } from "@/lib/holdingsColumns";
import { holding, quote } from "./helpers";
import { render } from "./miniRender";

/**
 * 넓은 잔고 표의 한 줄 (3-42 웨이브 B): StockRow 에 columns 를 주면 한 줄 표(components/HoldingsTable TableLine).
 * 휴대폰 줄과 같은 표기 함수·같은 부호 규칙(BH-38)·같은 화면 읽기 문장 + 당일손익·평가금액·비중.
 * 미국 종목 금액은 설정 '원화로 보기'를 따른다 (기본 달러 — 사용자 결정).
 */
vi.mock("react-native", () => ({ StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 }, Platform: { OS: "android" } }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light, useFontScale: () => 1 };
});
vi.mock("@/components/HoldingsTable", () => ({ TableLine: "TableLine" }));
vi.mock("@/components/StockLine", async () => {
  const R = await import("react");
  const StockLine = (p: Record<string, unknown>) => R.createElement("StockLine", p);
  return { LINE_COL: {}, LineMark: "LineMark", LineValue: "LineValue", StockLine };
});

const { StockRow, sameRow } = await import("@/components/StockRow");
const { light } = await import("@/tokens");
const { pickCols, pickWatchCols } = await import("@/lib/holdingsColumns");

const PLAN = pickCols(853);
const WATCH = pickWatchCols(853, 1, PLAN.nameW);
type Line = { cells: Record<string, { text: string; color: string; strong?: boolean; note?: boolean }>; price: { text: string; color: string; live: boolean } | null; weight: { pct: number | null; rel: number; color: string } | null; accessibilityLabel: string; zebra: boolean; plan: ColumnPlan };
const draw = (stock: ReturnType<typeof holding>, o: { showKrw?: boolean; plan?: ColumnPlan; weight?: number | null; weightMax?: number; zebra?: boolean; live?: boolean } = {}) => {
  const r = render(
    <StockRow stock={stock} onPress={() => undefined} showKrw={o.showKrw ?? false} afterCost={false} live={o.live ?? false} columns={o.plan ?? PLAN} zebra={o.zebra ?? false} weight={o.weight ?? null} weightMax={o.weightMax ?? 0} />,
  );
  const line = r.all().find((n) => n.type === "TableLine");
  expect(line).toBeTruthy();
  expect(r.all().some((n) => n.type === "StockLine")).toBe(false);
  return line!.props as unknown as Line;
};

const FX = 1400;
const samsung = holding("005930", quote("005930", 84_300, { change: 1_200, changeRate: 1.44 }), 120, 71_000, undefined, "삼성전자");
const apple = holding("AAPL", quote("AAPL", 254.4, { currency: "USD", change: -4.1, changeRate: -1.59, fxRate: FX }), 30, 180, { costBasisKrw: 7_000_000, krwCostSource: "exact" }, "애플");

describe("보유 줄", () => {
  it("국내: 원 단위 없이 숫자, 굵은 16 은 현재가·평가손익만, 평가금액·평단·수량은 색 없음", () => {
    const l = draw(samsung, { weight: 14.1, weightMax: 14.8 });
    expect(l.price).toEqual({ value: 84_300, text: "84,300", color: light.up, live: false } as never);
    expect(l.cells.rate).toEqual({ text: "+1.44%", color: light.up });
    expect(l.cells.profit).toEqual({ text: "+1,596,000", color: light.up, strong: true });
    expect(l.cells.profitRate).toEqual({ text: "+18.73%", color: light.up });
    expect(l.cells.day).toEqual({ text: "+144,000", color: light.up });
    expect(l.cells.value).toEqual({ text: "10,116,000", color: light.ink });
    expect(l.cells.avg).toEqual({ text: "71,000", color: light.sub });
    expect(l.cells.qty).toEqual({ text: "120", color: light.sub });
    // 비중: 막대는 가장 큰 비중 대비 길이, 국내는 비중 보기의 국내 조각 색
    expect(l.weight).toEqual({ pct: 14.1, rel: 14.1 / 14.8, color: light.chart.pie[0] });
  });

  it("화면 읽기: 휴대폰 줄 문장 + 당일손익·평가금액·비중 (한 줄 한 문장)", () => {
    expect(draw(samsung, { weight: 14.1, weightMax: 14.8 }).accessibilityLabel).toBe(
      "삼성전자, 국내, 120주 보유, 평단 71,000원, 현재가 84,300원, 1.44% 상승, 평가손익 1,596,000원 이익, 수익률 18.73% 상승, 당일손익 144,000원 이익, 평가금액 10,116,000원, 비중 14.1%",
    );
  });

  it("미국: 기본은 달러 그대로 ($ 표시, 금액·평단 모두) · 해외 비중 막대 색", () => {
    const l = draw(apple, { weight: 14.8, weightMax: 14.8, live: true });
    expect(l.price).toMatchObject({ text: "$254.40", color: light.down, live: true });
    expect(l.cells.profit).toMatchObject({ text: "+$2,232.00", color: light.up });
    expect(l.cells.day).toEqual({ text: "-$123.00", color: light.down });
    expect(l.cells.value.text).toBe("$7,632.00");
    expect(l.cells.avg.text).toBe("$180.00");
    expect(l.weight).toEqual({ pct: 14.8, rel: 1, color: light.chart.pie[1] });
    expect(l.accessibilityLabel).toContain("실시간");
    expect(l.accessibilityLabel).toContain("당일손익 123.00달러 손실, 평가금액 7,632.00달러, 비중 14.8%");
  });

  it("설정 '원화로 보기'면 미국 종목도 원화 (평단·손익은 매수 당시 환율 기준 — 휴대폰 줄과 같음)", () => {
    const l = draw(apple, { showKrw: true });
    expect(l.price!.text).toBe("356,160");
    expect(l.cells.value.text).toBe("10,684,800");
    expect(l.cells.profit.text).toBe("+3,684,800");
    expect(l.cells.day).toEqual({ text: "-172,200", color: light.down });
    expect(l.cells.avg.text).toBe("233,333");
  });

  it("BH-38: 0 으로 보이는 당일손익·손익은 부호·색 없이", () => {
    const flat = holding("005930", quote("005930", 1833, { change: 0, changeRate: 0 }), 1, 1833.33, undefined, "삼성전자");
    const l = draw(flat);
    expect(l.cells.day).toEqual({ text: "0", color: light.ink });
    expect(l.cells.profit).toMatchObject({ text: "0", color: light.ink });
    expect(l.cells.rate).toEqual({ text: "0.00%", color: light.ink });
    expect(l.accessibilityLabel).toContain("당일손익 손익 없음");
  });

  it("평단이 없어 합계에서 뺀 보유 종목: 손익 칸은 '-'·'합계 제외', 당일손익·평가금액·비중 없음", () => {
    const l = draw(holding("000660", quote("000660", 351_000), 18, null, undefined, "SK하이닉스"), { weight: null });
    expect(l.cells.profit).toEqual({ text: "-", color: light.muted });
    expect(l.cells.profitRate).toEqual({ text: "합계 제외", color: light.muted, note: true });
    expect(l.cells.day).toBeUndefined();
    expect(l.cells.value).toBeUndefined();
    expect(l.cells.avg.text).toBe("없음");
    expect(l.weight).toBeNull();
    expect(l.accessibilityLabel.endsWith("합계 제외")).toBe(true);
  });
});

describe("관심 줄", () => {
  it("현재가·등락률 ‖ 전일대비·거래량 (보유 칸 없음)", () => {
    const w = holding("AVGO", quote("AVGO", 345.2, { currency: "USD", change: 5.9, changeRate: 1.74, volume: 22_300_000 }), null, null, undefined, "브로드컴");
    const l = draw(w, { plan: WATCH });
    expect(l.cells.move).toEqual({ text: "▲5.90", color: light.up });
    expect(l.cells.volume).toEqual({ text: "2,230만주", color: light.sub });
    expect(l.cells.profit).toBeUndefined();
    expect(l.weight).toBeNull();
    expect(l.accessibilityLabel).toBe("브로드컴, 미국, 관심, 현재가 345.20달러, 1.74% 상승, 전일 대비 5.90달러 상승, 거래량 2,230만주");
  });
});

describe("다시 그리기 조건 (3-17): 한 줄 표도 체결이 온 줄만", () => {
  const base = { stock: samsung, onPress: () => undefined, showKrw: false, afterCost: true, live: false, columns: PLAN, zebra: false, weight: 14.1, weightMax: 14.8 };
  it("같은 열 계획·줄무늬·비중이면 그대로, 하나라도 바뀌면 다시", () => {
    expect(sameRow(base, { ...base })).toBe(true);
    expect(sameRow(base, { ...base, columns: pickCols(853) })).toBe(false);
    expect(sameRow(base, { ...base, zebra: true })).toBe(false);
    expect(sameRow(base, { ...base, weight: 14.2 })).toBe(false);
    expect(sameRow(base, { ...base, weightMax: 15 })).toBe(false);
    expect(sameRow(base, { ...base, onLayoutRow: () => undefined })).toBe(false);
  });
});

describe("휴대폰 줄(columns 없음)은 지금 그대로", () => {
  it("StockLine 으로 그리고, 위치 재기(onLayoutRow)를 주지 않으면 onLayout 도 없다", () => {
    const r = render(<StockRow stock={samsung} onPress={() => undefined} showKrw={false} />);
    const line = r.all().find((n) => n.type === "StockLine")!;
    expect(r.all().some((n) => n.type === "TableLine")).toBe(false);
    expect(line.props.onLayout).toBeUndefined();
    expect(line.props.sub).toBe("120주 · 71,000");
    // 휴대폰 줄 문장에는 당일손익·평가금액·비중을 더하지 않는다
    expect(String(line.props.accessibilityLabel)).not.toContain("당일손익");
  });

  it("위치 재기를 주면 줄 위치(y·높이)를 종목과 함께 알린다", () => {
    const got = vi.fn();
    const r = render(<StockRow stock={samsung} onPress={() => undefined} showKrw={false} onLayoutRow={got} />);
    const line = r.all().find((n) => n.type === "StockLine")!;
    (line.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 580, width: 400, height: 58 } } });
    expect(got).toHaveBeenCalledWith(samsung, 580, 58);
  });
});
