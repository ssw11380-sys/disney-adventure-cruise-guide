import React from "react";
import { describe, expect, it, vi } from "vitest";
import { holding, quote } from "./helpers";

/**
 * 합계가 1원·1센트 미만일 때 (BH-38 검증 지적): 잔고 화면 요약과 위젯이 "0원" 을 손실·이익 색으로 칠하지 않는다.
 * 합계(summarize·totals)를 표시 단위로 반올림해 돌려주므로 요약 패널·위젯의 색(changeColor·tone)이 보이는 글자와 맞는다
 */
vi.mock("react-native-android-widget", () => {
  const mk = (kind: string) => Object.assign((_: unknown) => null, { __widget: kind });
  return { FlexWidget: mk("Flex"), TextWidget: mk("Text"), ListWidget: mk("List") };
});
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: { apiUrl: "https://server.test" } } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, multiGet: async (keys: string[]) => keys.map((k) => [k, null]) },
}));

const { AssetWidget, HoldingsWidget } = await import("@/widgets/widgets");
const { WIDGET_COLORS } = await import("@/widgets/palette");
const { summarize, totals } = await import("@/lib/portfolio");
const { formatPct, formatPrice } = await import("@/lib/format");
const { changeColor, light } = await import("@/tokens");

interface Node {
  kind: string;
  props: Record<string, unknown>;
  children: Node[];
}
function render(el: React.ReactNode): Node[] {
  if (el === null || el === undefined || typeof el === "boolean") return [];
  if (Array.isArray(el)) return el.flatMap(render);
  if (!React.isValidElement(el)) return [];
  const type = el.type as { __widget?: string } & ((p: unknown) => React.ReactNode);
  const props = el.props as Record<string, unknown>;
  if (type.__widget) return [{ kind: type.__widget, props, children: render(props.children as React.ReactNode) }];
  if (typeof type === "function") return render(type(props));
  return render(props.children as React.ReactNode);
}
const all = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...all(n.children)]);
const texts = (nodes: Node[]) => all(nodes).filter((n) => n.kind === "Text").map((n) => ({ text: String(n.props.text), color: (n.props.style as { color?: string })?.color }));

const NOW = Date.parse("2026-09-24T15:40:00+09:00");
const AT = "2026-09-24T15:30:00+09:00";

// 소수점 0.4주: 오늘 -1원 × 0.4주 = -0.4원, 평가 400원 − 매입 399.7원 = +0.3원 (검증 지적의 assetLine(-0.4, 0.3) 과 같은 합계)
const tiny = () => [holding("005930", quote("005930", 1000, { change: -1, changeRate: -0.1, asOf: AT }), 0.4, 999.25, undefined, "삼성전자")];

describe("BH-38 검증 지적: 합계가 1원 미만", () => {
  it("합계는 표시 단위로 반올림: 당일 -0.4원 → 0, 손익 +0.3원 → 0", () => {
    const t = totals(tiny(), false, false)!;
    expect(t).toMatchObject({ value: 400, day: 0, profit: 0, currency: "KRW" });
    expect(Object.is(t.day, -0)).toBe(false);
    const s = summarize(tiny(), false);
    expect(s.krw).toMatchObject({ value: 400, cost: 400, day: 0 });
    expect(s.byCur.KRW).toMatchObject({ value: 400, cost: 400, day: 0 });
  });

  it("잔고 화면 요약 패널: '0원' 평가손익·당일손익은 기본 글자색 (요약 패널이 쓰는 값·함수 그대로)", () => {
    const s = summarize(tiny(), false);
    const main = s.krw!;
    const profit = main.value - main.cost;
    expect(formatPrice(profit, "KRW", { sign: true })).toBe("0원");
    expect(changeColor(light, profit)).toBe(light.ink);
    expect(formatPrice(main.day, "KRW", { sign: true })).toBe("0원");
    expect(changeColor(light, main.day)).toBe(light.ink);
    expect(formatPct(main.cost > 0 ? (profit / main.cost) * 100 : 0)).toBe("0.00%");
  });

  it("자산 위젯: '오늘 0원'·'총 0원' 을 파랑·빨강이 아니라 기본 글자색으로 (재현)", () => {
    const tx = texts(render(<AssetWidget stocks={tiny()} showKrw={false} afterCost={false} fetchedAt={NOW} error={null} now={NOW} />));
    const day = tx.find((x) => x.text.startsWith("오늘"))!;
    expect(day.text).toBe("오늘 0원");
    expect(day.color).toBe(WIDGET_COLORS.ink);
    const cum = tx.find((x) => /^총 [+-]?\d/.test(x.text))!;
    expect(cum.text).toBe("총 0원");
    expect(cum.color).toBe(WIDGET_COLORS.ink);
  });

  it("잔고 위젯 합계 옆 누적 손익도 '0원' 이면 기본 글자색", () => {
    const tx = texts(render(<HoldingsWidget stocks={tiny()} showKrw={false} afterCost={false} fetchedAt={NOW} error={null} now={NOW} />));
    const zero = tx.filter((x) => /^0원$|누적 0원/.test(x.text));
    expect(zero.length).toBeGreaterThan(0);
    for (const z of zero) expect(z.color).toBe(WIDGET_COLORS.ink);
  });

  it("달러 합계는 센트로: 1센트 미만 손익·당일은 0, 1센트부터는 그대로", () => {
    const qty = 0.052631;
    const us = holding("AAPL", quote("AAPL", 190, { currency: "USD", change: -0.004, fxRate: 1360, asOf: AT }), qty, 10 / qty, { costBasisKrw: 13_600 });
    const t = totals([us], false, false)!;
    expect(t).toMatchObject({ value: 10, day: 0, profit: 0, currency: "USD" });
    const s = summarize([us], false);
    expect(s.byCur.USD).toMatchObject({ value: 10, cost: 10, day: 0 });
    const big = holding("AAPL", quote("AAPL", 190, { currency: "USD", change: 1.23, fxRate: 1360, asOf: AT }), 3, 180);
    expect(totals([big], false, false)).toMatchObject({ value: 570, day: 3.69, profit: 30 });
  });

  it("보이는 합계는 예전처럼 부호 색 (0.6원 → 1원)", () => {
    const s = holding("005930", quote("005930", 1000, { change: -1, asOf: AT }), 0.6, 998, undefined, "삼성전자");
    const t = totals([s], false, false)!;
    expect(t.day).toBe(-1);
    expect(t.profit).toBe(1);
    const tx = texts(render(<AssetWidget stocks={[s]} showKrw={false} afterCost={false} fetchedAt={NOW} error={null} now={NOW} />));
    expect(tx.find((x) => x.text.startsWith("오늘"))).toEqual({ text: "오늘 -1원", color: WIDGET_COLORS.down });
  });
});
