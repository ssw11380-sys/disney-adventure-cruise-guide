import React from "react";
import { describe, expect, it, vi } from "vitest";
import { holding, quote } from "./helpers";
import { render } from "./miniRender";

/**
 * 잔고 줄의 3-24 한 손 조작 부분 (components/StockRow, 기능 플래그 oneHand — 잔고 화면이 속성으로 켠다).
 *  - wrapRow: 휴대폰 줄을 스와이프 틀로 감싼다. 줄 자리(onLayoutRow)는 틀이 알리고 줄(StockLine)은 알리지 않는다. 줄의 memo 비교에 들어간다
 *    → 체결이 온 줄만 틀까지 다시 그린다 (목록 전체가 체결마다 틀을 다시 그리지 않게, 3-17)
 *  - onRowAction: 화면 읽기 동작 수정 · 지우기(토스 종목은 동기화 제외, 관심은 관심 해제) · 메뉴 열기
 *  - 둘 다 주지 않으면 지금 그대로 ('수정·삭제' 길게 누르기 하나)
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
const { pickCols } = await import("@/lib/holdingsColumns");

const samsung = { ...holding("005930", quote("005930", 84_300, { change: 1_200, changeRate: 1.44 }), 120, 71_000, undefined, "삼성전자"), tossSynced: true };
const avgo = holding("AVGO", quote("AVGO", 345.2, { currency: "USD", change: 5.9, changeRate: 1.74, fxRate: 1400 }), null, null, undefined, "브로드컴");

describe("스와이프 틀 (wrapRow)", () => {
  it("휴대폰 줄을 감싸고, 줄 자리는 틀이 알린다", () => {
    const calls: unknown[][] = [];
    const wrap = (s: unknown, row: React.ReactElement, onLayout?: unknown) => {
      calls.push([s, row, onLayout]);
      return React.createElement("Wrap", { onLayout }, row);
    };
    const onLayoutRow = vi.fn();
    const r = render(<StockRow stock={samsung} onPress={() => undefined} showKrw={false} wrapRow={wrap} onLayoutRow={onLayoutRow} />);
    const wrapNode = r.all().find((n) => n.type === "Wrap")!;
    const line = r.all().find((n) => n.type === "StockLine")!;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(samsung);
    expect(line.props.onLayout).toBeUndefined();
    (wrapNode.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 320, width: 475, height: 58 } } });
    expect(onLayoutRow).toHaveBeenCalledWith(samsung, 320, 58);
  });

  it("주지 않으면 지금 그대로 (줄이 자리를 알린다)", () => {
    const onLayoutRow = vi.fn();
    const r = render(<StockRow stock={samsung} onPress={() => undefined} showKrw={false} onLayoutRow={onLayoutRow} />);
    expect(r.all().some((n) => n.type === "Wrap")).toBe(false);
    expect(typeof r.all().find((n) => n.type === "StockLine")!.props.onLayout).toBe("function");
  });

  it("넓은 표 줄에는 쓰지 않는다", () => {
    const wrap = vi.fn((_s: unknown, row: React.ReactElement) => row);
    render(<StockRow stock={samsung} onPress={() => undefined} showKrw={false} wrapRow={wrap} columns={pickCols(853)} />);
    expect(wrap).not.toHaveBeenCalled();
  });

  it("memo 비교: 틀 함수가 같으면 다시 그리지 않고, 바뀌면 다시 그린다", () => {
    const wrap = (_s: unknown, row: React.ReactElement) => row;
    const base = { stock: samsung, onPress: () => undefined, showKrw: false, wrapRow: wrap };
    expect(sameRow(base, { ...base })).toBe(true);
    expect(sameRow(base, { ...base, wrapRow: (_s: unknown, row: React.ReactElement) => row })).toBe(false);
  });
});

describe("화면 읽기 동작 (onRowAction)", () => {
  it("수정 · 동기화 제외 · 메뉴 열기 — 고르면 같은 일", () => {
    const act = vi.fn();
    const long = vi.fn();
    const r = render(<StockRow stock={samsung} onPress={() => undefined} onLongPress={long} showKrw={false} onRowAction={act} />);
    const line = r.all().find((n) => n.type === "StockLine")!;
    expect(line.props.accessibilityActions).toEqual([
      { name: "edit", label: "수정" },
      { name: "remove", label: "동기화 제외" },
      { name: "longpress", label: "메뉴 열기" },
    ]);
    const on = line.props.onAccessibilityAction as (name: string) => void;
    on("edit");
    on("remove");
    on("longpress");
    expect(act.mock.calls).toEqual([
      [samsung, "edit"],
      [samsung, "remove"],
    ]);
    expect(long).toHaveBeenCalledWith(samsung);
  });

  it("관심 종목은 '관심 해제', 주지 않으면 예전 '수정·삭제' 하나", () => {
    const a = render(<StockRow stock={avgo} onPress={() => undefined} onLongPress={() => undefined} showKrw={false} onRowAction={() => undefined} />);
    expect((a.all().find((n) => n.type === "StockLine")!.props.accessibilityActions as { label: string }[]).map((x) => x.label)).toEqual(["수정", "관심 해제", "메뉴 열기"]);
    const b = render(<StockRow stock={avgo} onPress={() => undefined} onLongPress={() => undefined} showKrw={false} />);
    expect(b.all().find((n) => n.type === "StockLine")!.props.accessibilityActions).toEqual([{ name: "longpress", label: "수정·삭제" }]);
  });
});
