import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { holding, quote } from "./helpers";

/**
 * 잔고 위젯 종목 줄의 손익·등락률 색 (BH-38 검증 지적): 화면에 0 으로 보이는 값("0.00% $0.00"·"0.00% 0원"·"0.00%")을
 * 손실·이익 색으로 칠하지 않는다 — 앱 잔고 줄(StockRow)과 같은 규칙. 보이는 손익·등락은 예전처럼 부호 색
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

const { HoldingsWidget } = await import("@/widgets/widgets");
const { WIDGET_COLORS } = await import("@/widgets/palette");

interface Node {
  kind: string;
  props: Record<string, unknown>;
  children: Node[];
}
/** 함수 컴포넌트를 펼쳐 위젯 트리로 (widgets.test.tsx 와 같은 방식) */
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
/** 잔고 목록(ListWidget) 안의 글자와 색만 — 합계 줄과 섞이지 않게 */
const rowTexts = (nodes: Node[]) =>
  all(all(nodes).filter((n) => n.kind === "List"))
    .filter((n) => n.kind === "Text")
    .map((n) => ({ text: String(n.props.text), color: (n.props.style as { color?: string })?.color }));

const NOW = Date.parse("2026-09-24T15:40:00+09:00");
const AT = "2026-09-24T15:30:00+09:00";
const { ink: INK, up: UP, down: DOWN } = WIDGET_COLORS;
const draw = (stocks: ReturnType<typeof holding>[], showKrw = false) =>
  rowTexts(render(<HoldingsWidget stocks={stocks} showKrw={showKrw} afterCost={false} fetchedAt={NOW} error={null} now={NOW} width={420} height={260} />));
const find = (tx: { text: string; color?: string }[], text: string) => {
  const hit = tx.find((t) => t.text === text);
  if (!hit) throw new Error(`"${text}" 글자가 없습니다: ${JSON.stringify(tx.map((t) => t.text))}`);
  return hit;
};

// 검증 노트의 실제 사례: 토스 소수점 0.052631주를 $10.00(원화 13,600원)에 삼, 가격 190·환율 1360 → 손익 -$0.00011 · -0.15원
const qty = 0.052631;
const toss = () =>
  holding("AAPL", quote("AAPL", 190, { currency: "USD", fxRate: 1360, priceKrw: 190 * 1360, asOf: AT }), qty, 10 / qty, { costBasis: 10, costBasisKrw: 13_600, krwCostSource: "exact" }, "애플");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("BH-38: 위젯 종목 줄 — 0 으로 보이는 손익은 기본 글자색", () => {
  it("달러 보기 '0.00% $0.00' 은 파랑이 아니라 기본 글자색 (재현)", () => {
    const tx = draw([toss()]);
    expect(find(tx, "0.00% $0.00").color).toBe(INK);
  });

  it("원화 보기 '0.00% 0원' 도 기본 글자색 (재현)", () => {
    const tx = draw([toss()], true);
    expect(find(tx, "0.00% 0원").color).toBe(INK);
  });

  it("보이는 손실·이익은 예전처럼 부호 색", () => {
    const loss = holding("005930", quote("005930", 1800, { asOf: AT }), 2, 1833, undefined, "삼성전자");
    const gain = holding("000660", quote("000660", 1900, { asOf: AT }), 1, 1833, undefined, "하이닉스");
    const tx = draw([loss, gain]);
    expect(find(tx, "-1.80% -66원").color).toBe(DOWN);
    expect(find(tx, "+3.66% +67원").color).toBe(UP);
  });

  it("국내 1주 평단 1,833.33원·현재가 1,833원: 금액은 0원이어도 수익률 '-0.02%' 가 보이면 하락 색", () => {
    const tx = draw([holding("005930", quote("005930", 1833, { asOf: AT }), 1, 1833.33, undefined, "삼성전자")]);
    expect(find(tx, "-0.02% 0원").color).toBe(DOWN);
  });
});

describe("BH-38: 위젯 종목 줄 — 등락률", () => {
  it("230달러 종목 1센트 하락(-0.0043%): 현재가는 하락 색, '0.00%' 는 기본 글자색 (앱 잔고 줄과 같게, 재현)", () => {
    const tx = draw([holding("AAPL", quote("AAPL", 229.99, { currency: "USD", change: -0.01, changeRate: -0.0043, asOf: AT }), null, null, undefined, "애플")]);
    expect(find(tx, "$229.99").color).toBe(DOWN);
    expect(find(tx, "0.00%").color).toBe(INK);
  });

  it("1센트 미만으로 움직인 동전주 '-7.41%' 는 하락 색 그대로", () => {
    const tx = draw([holding("SNDL", quote("SNDL", 0.05, { currency: "USD", change: -0.004, changeRate: -7.41, asOf: AT }), null, null, undefined, "동전주")]);
    expect(find(tx, "-7.41%").color).toBe(DOWN);
    expect(find(tx, "$0.05").color).toBe(DOWN);
  });
});
