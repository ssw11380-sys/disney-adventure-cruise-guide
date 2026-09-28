import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountData } from "@/components/AccountBand";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 잔고 촘촘 모드의 부품 (3-39 PR 1 — 잔고 화면이 dense 속성으로 켠다). 부품을 진짜로 그린다.
 *  - StockLine: dense 면 최소 높이 44 · 위아래 4 · 두 줄 사이 0 (높이 고정 아님 — 큰 글씨에서 늘어남). 고정 높이 목록이 이긴다
 *  - StockRow: 휴대폰 줄에만 dense 를 넘기고 화면 읽기 문장은 그대로. 한 줄 표(columns)는 dense 와 상관없다. memo 비교에 들어간다
 *  - AccountBand: 두 줄 띠는 첫 줄만 + 비중 버튼(같은 줄), 한 줄 띠는 그대로. 화면 읽기 문장은 그대로
 */
const h = vi.hoisted(() => ({ scale: 1 }));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 0.5, absoluteFill: {} },
  Platform: { OS: "android" },
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: (cap = Infinity) => Math.min(Math.max(h.scale, 1), cap) };
});
vi.mock("@/components/ui", () => ({ Button: "Button", TableHead: "TableHead" }));
vi.mock("@/components/FlashPrice", () => ({ FlashPrice: "FlashPrice" }));
vi.mock("@/components/HoldingsTable", () => ({ TableLine: "TableLine" }));

const { StockLine, LINE_H } = await import("@/components/StockLine");
const { StockRow, sameRow } = await import("@/components/StockRow");
const { AccountBand } = await import("@/components/AccountBand");
const { pickCols } = await import("@/lib/holdingsColumns");
const { lineH } = await import("@/lib/textScale");
const { dark, layout, space, touch } = await import("@/tokens");

beforeEach(() => {
  h.scale = 1;
});

type R = ReturnType<typeof render>;
/** 모양 한 벌 (배열·누름 함수는 { pressed: false } 로 불러 합친다) */
const flat = (v: unknown): Record<string, unknown> =>
  Object.assign({}, ...[typeof v === "function" ? (v as (s: { pressed: boolean }) => unknown)({ pressed: false }) : v].flat(Infinity).filter(Boolean));
const treeText = (tree: unknown) => JSON.stringify(tree, (k, v) => (typeof v === "function" ? undefined : v));
const all = (n: HostNode): HostNode[] => [n, ...n.children.flatMap((c) => (typeof c === "string" ? [] : all(c)))];
const textIn = (n: HostNode | string): string => (typeof n === "string" ? n : n.children.map(textIn).join(""));
const parentOf = (r: R, node: HostNode): HostNode => r.all().find((n) => n.children.includes(node))!;

const PRICE = { value: 84_300, text: "84,300", color: dark.up, rate: "+1.44%", rateColor: dark.up };
const line = (extra: Partial<React.ComponentProps<typeof StockLine>> = {}) => {
  const r = render(<StockLine name="삼성전자" sub="120주 · 71,000" price={PRICE} right={null} onPress={() => undefined} {...extra} />);
  const row = r.all().find((n) => n.type === "Pressable")!;
  // 줄 안: 이름 칸 · 현재가 칸 · 오른쪽 칸
  const [name, price, right] = row.children as HostNode[];
  return { r, row, style: flat(row.props.style), name: name!, price: price!, right: right! };
};

describe("StockLine", () => {
  it("dense 없음: 지금 그대로 (최소 58 · 위아래 6, 칸 사이 2)", () => {
    const l = line();
    expect(l.style).toMatchObject({ minHeight: LINE_H, paddingVertical: space.s });
    expect(l.style).not.toHaveProperty("height");
    for (const c of [l.name, l.price, l.right]) expect(flat(c.props.style).gap).toBe(space.xxs);
    // 기본 줄은 이름 칸 모양이 배열이 아닌 한 벌 그대로 (그리는 나무까지 지금과 같게)
    expect(Array.isArray(l.name.props.style)).toBe(false);
  });

  it("dense: 최소 44(touch.min) · 위아래 4, 높이 고정 없음, 이름 칸·숫자 칸 사이 0", () => {
    const l = line({ dense: true });
    expect(l.style).toMatchObject({ minHeight: touch.min, paddingVertical: space.xs });
    expect(l.style).not.toHaveProperty("height");
    for (const c of [l.name, l.price, l.right]) expect(flat(c.props.style).gap).toBe(0);
    // 글자·열·화면 읽기는 그대로
    expect(l.row.props.accessibilityLabel).toBe(line().row.props.accessibilityLabel);
    expect(flat(l.price.props.style).width).toBe(flat(line().price.props.style).width);
  });

  it("fixedHeight + dense: 고정 높이가 이긴다 (발견 목록 등 — 잔고는 넘기지 않음)", () => {
    const l = line({ dense: true, fixedHeight: true });
    expect(l.style).toMatchObject({ height: lineH(1) });
    expect(l.style).not.toHaveProperty("minHeight");
  });

  it.each([1.3, 2])("글자 %s배: dense 줄도 최소 높이만 (높이 고정 없음 — 글자가 커지면 줄이 늘어난다)", (s) => {
    h.scale = s;
    const l = line({ dense: true });
    expect(l.style).toMatchObject({ minHeight: touch.min });
    expect(l.style).not.toHaveProperty("height");
    // 큰 글씨 규칙(이름 두 줄)도 그대로
    const nameText = all(l.name).find((n) => n.type === "Text" && textIn(n) === "삼성전자")!;
    expect(nameText.props.numberOfLines).toBe(2);
  });
});

const samsung = holding("005930", quote("005930", 84_300, { change: 1_200, changeRate: 1.44 }), 120, 71_000, undefined, "삼성전자");
const apple = holding("AAPL", quote("AAPL", 254.4, { currency: "USD", change: -4.1, changeRate: -1.59, fxRate: 1400 }), 30, 180, { costBasisKrw: 7_000_000, krwCostSource: "exact" }, "애플");

describe("StockRow", () => {
  const onPress = () => undefined;

  it.each([samsung, apple])("휴대폰 줄: dense 를 주면 StockLine 에 넘어가고(최소 44), 화면 읽기 문장은 같다 — %s", (s) => {
    const base = render(<StockRow stock={s} onPress={onPress} showKrw={false} afterCost={false} />);
    const dense = render(<StockRow stock={s} onPress={onPress} showKrw={false} afterCost={false} dense />);
    const a = base.all().find((n) => n.type === "Pressable")!;
    const b = dense.all().find((n) => n.type === "Pressable")!;
    expect(flat(a.props.style)).toMatchObject({ minHeight: LINE_H });
    expect(flat(b.props.style)).toMatchObject({ minHeight: touch.min, paddingVertical: space.xs });
    expect(b.props.accessibilityLabel).toBe(a.props.accessibilityLabel);
    expect(textIn(b)).toBe(textIn(a));
  });

  it("dense 를 주지 않으면(false 포함) 줄 나무가 지금과 같다", () => {
    const base = render(<StockRow stock={samsung} onPress={onPress} showKrw={false} afterCost={false} />);
    const off = render(<StockRow stock={samsung} onPress={onPress} showKrw={false} afterCost={false} dense={false} />);
    expect(treeText(off.tree)).toBe(treeText(base.tree));
  });

  it("한 줄 표(columns): dense 와 상관없이 TableLine 속성이 같다", () => {
    const plan = pickCols(853);
    const a = render(<StockRow stock={samsung} onPress={onPress} showKrw={false} afterCost={false} columns={plan} />);
    const b = render(<StockRow stock={samsung} onPress={onPress} showKrw={false} afterCost={false} columns={plan} dense />);
    const ta = a.all().find((n) => n.type === "TableLine")!;
    const tb = b.all().find((n) => n.type === "TableLine")!;
    expect(ta).toBeTruthy();
    expect(tb.props).not.toHaveProperty("dense");
    expect(treeText(tb.props)).toBe(treeText(ta.props));
    expect(b.all().some((n) => n.type === "Pressable")).toBe(false);
  });

  it("sameRow: 다른 속성이 같고 dense 만 다르면 다시 그린다(false)", () => {
    const base = { stock: samsung, onPress, showKrw: false, afterCost: false };
    expect(sameRow(base, { ...base })).toBe(true);
    expect(sameRow(base, { ...base, dense: true })).toBe(false);
    expect(sameRow({ ...base, dense: true }, { ...base, dense: true })).toBe(true);
  });
});

const bucket = (value: number, cost: number, day: number, count: number) => ({ value, cost, day, count });
// 넓은 창 목업과 같은 예시 계좌 (국내 9 · 해외 8)
const DATA: AccountData = {
  total: bucket(71_445_876, 54_699_110, 423_789, 17),
  byCur: { KRW: bucket(31_451_551, 26_060_000, 300_000, 9), USD: bucket(28_741.88, 21_040, 90, 8) },
  usdInKrw: bucket(39_994_325, 28_639_110, 123_789, 8),
  estimated: false,
  currentBasis: 0,
  afterCost: true,
  showKrw: false,
  fx: 1391.5,
  excluded: null,
};

describe("AccountBand", () => {
  const onAllocation = () => undefined;
  const summary = (r: R) => {
    const hits = r.all().filter((n) => n.props.accessible === true && String(n.props.accessibilityLabel ?? "").startsWith("총 평가금액"));
    expect(hits).toHaveLength(1);
    return hits[0]!;
  };

  it("두 줄 띠 + dense: 첫 줄만(총 평가금액 · 평가손익·수익률 · 당일손익) + 비중 버튼 같은 줄, 국내·해외·매입금액 칸 없음", () => {
    const base = render(<AccountBand data={DATA} oneLine={false} pad={12} onAllocation={onAllocation} />);
    const r = render(<AccountBand data={DATA} oneLine={false} pad={12} onAllocation={onAllocation} dense />);
    const text = r.text();
    expect(text).toContain("총 평가금액 · 비용 차감");
    expect(text).toContain("평가손익 · 수익률");
    expect(text).toContain("당일손익");
    for (const s of ["매입금액", "국내", "해외"]) {
      expect(base.text()).toContain(s);
      expect(text).not.toContain(s);
    }
    // 칸 묶음과 비중 버튼이 같은 줄(line2 — 높이 48) 안: 버튼은 action 칸, 칸은 accessible 묶음 안 (바로 위 부모는 다르다)
    const cells = summary(r);
    const button = r.all().find((n) => n.type === "Button" && n.props.accessibilityLabel === "비중 보기")!;
    expect(button).toBeTruthy();
    const row = parentOf(r, cells);
    expect(all(row)).toContain(button);
    expect(parentOf(r, button)).not.toBe(row);
    expect(flat(parentOf(r, button).props.style)).toMatchObject({ paddingLeft: space.sm });
    expect(flat(row.props.style)).toMatchObject({ flexDirection: "row", minHeight: layout.bandRowH, paddingHorizontal: 12 });
    // 줄 하나만 (두 줄 띠의 윗줄 구분선 줄 없음)
    expect(r.all().filter((n) => flat(n.props.style).minHeight === layout.bandRowH)).toHaveLength(1);
    // 화면 읽기 문장은 dense 없을 때와 같다 (숨긴 국내·해외·매입금액도 문장에 남음)
    expect(cells.props.accessibilityLabel).toBe(summary(base).props.accessibilityLabel);
    expect(String(cells.props.accessibilityLabel)).toContain("매입금액");
  });

  it("두 줄 띠 + dense: 비중 보기가 꺼져 있으면(onAllocation 없음) 버튼 없음", () => {
    const r = render(<AccountBand data={DATA} oneLine={false} pad={12} dense />);
    expect(r.all().some((n) => n.type === "Button")).toBe(false);
  });

  it("한 줄 띠 + dense: dense 없을 때와 같은 나무 (국내·해외 칸 있음)", () => {
    const base = render(<AccountBand data={DATA} oneLine rates pad={12} onAllocation={onAllocation} />);
    const r = render(<AccountBand data={DATA} oneLine rates pad={12} onAllocation={onAllocation} dense />);
    expect(treeText(r.tree)).toBe(treeText(base.tree));
    expect(r.text()).toContain("해외 · 환율 1,391.5");
  });

  it("두 줄 띠 + dense 없음(false): 지금 두 줄 그대로", () => {
    const base = render(<AccountBand data={DATA} oneLine={false} pad={12} onAllocation={onAllocation} />);
    const off = render(<AccountBand data={DATA} oneLine={false} pad={12} onAllocation={onAllocation} dense={false} />);
    expect(treeText(off.tree)).toBe(treeText(base.tree));
    expect(base.all().filter((n) => flat(n.props.style).minHeight === layout.bandRowH)).toHaveLength(2);
  });
});
