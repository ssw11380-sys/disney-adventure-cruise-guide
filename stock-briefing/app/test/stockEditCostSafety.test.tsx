import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Evaluation, RegisteredStock } from "@/api/types";
import { render, type HostNode } from "./miniRender";

type Held = RegisteredStock & { evaluation?: Evaluation | null };
const h = vi.hoisted(() => ({ stock: null as Held | null, update: vi.fn(), setKrwCost: vi.fn(), alert: vi.fn() }));

vi.mock("react-native", () => ({
  View: "View", Text: "Text", TextInput: "TextInput",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Alert: { alert: h.alert },
}));
vi.mock("expo-router", () => ({ router: { back: vi.fn(), dismissTo: vi.fn() }, useLocalSearchParams: () => ({ code: "AAPL" }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: async () => undefined }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "https://server.test" }) }));
vi.mock("@/lib/settingsLink", () => ({ useSettingsGuide: () => null }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", ErrorView: "ErrorView", Loading: "Loading", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented" }));
vi.mock("@/api/hooks", () => ({
  useApi: () => ({ setKrwCost: h.setKrwCost }),
  useStock: () => ({ data: h.stock, isError: false }),
  useStockMutations: () => ({ update: { mutate: h.update, isPending: false }, remove: { mutate: vi.fn(), isPending: false } }),
}));

const { default: EditStockScreen } = await import("@/app/stocks/[code]/edit");
type Screen = ReturnType<typeof render>;
const typeIn = (r: Screen, label: string, value: string) => r.act(() => (r.byLabel(label).props.onChangeText as (v: string) => void)(value));
const button = (r: Screen, title: string): HostNode => {
  const hits = r.all().filter((n) => n.type === "Button" && n.props.title === title);
  expect(hits).toHaveLength(1);
  return hits[0];
};
const saveTrade = (r: Screen) => r.act(() => (button(r, "반영해 저장").props.onPress as () => void)());
const buy = (r: Screen) => {
  typeIn(r, "매수 수량", "1");
  typeIn(r, "매수 체결가", "100");
};

beforeEach(() => {
  h.stock = {
    code: "AAPL", name: "애플", market: "NASDAQ", quantity: 10, avgPrice: null, memo: null,
    createdAt: "2026-10-02T01:00:00.000Z", updatedAt: "2026-10-02T01:00:00.000Z", tossSynced: false,
    evaluation: { marketValue: 1000, costBasis: 900, profit: 100, profitRate: 100 / 9, costBasisKrw: null, krwCostSource: null },
  };
  h.update.mockReset();
  h.alert.mockReset();
  h.setKrwCost.mockReset().mockResolvedValue({ applied: ["AAPL"], skipped: [] });
});

describe("보유 수정 — 모르는 기존 매입원가를 새 체결가로 채우지 않는다", () => {
  it("평단 없이 보유한 10주에 1주를 사면 기존 평단 입력을 안내하고 저장을 막는다", () => {
    const r = render(<EditStockScreen />);
    buy(r);
    expect(button(r, "반영해 저장").props.disabled).toBe(true);
    expect(r.text()).toContain("기존 보유 종목의 평균 단가를 먼저 입력하세요");
    // 눌림 콜백이 이미 전달된 경우에도 저장 요청을 보내지 않는다.
    saveTrade(r);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("기존 평단을 입력하면 그 값과 새 체결가의 가중 평균으로 저장한다", () => {
    const r = render(<EditStockScreen />);
    buy(r);
    typeIn(r, "평균 단가", "80");
    expect(button(r, "반영해 저장").props.disabled).toBe(false);
    saveTrade(r);
    expect(h.update.mock.calls[0]?.[0]).toEqual({ code: "AAPL", quantity: 11, avgPrice: 81.8181818182, memo: null });
  });

  it("보유 수량이 없는 첫 매수는 새 체결가를 평단으로 저장한다", () => {
    h.stock!.quantity = null;
    const r = render(<EditStockScreen />);
    buy(r);
    saveTrade(r);
    expect(h.update.mock.calls[0]?.[0]).toEqual({ code: "AAPL", quantity: 1, avgPrice: 100, memo: null });
  });

  it("평단이 없는 기존 보유분의 일부 매도는 수량만 줄이고 평단은 미입력으로 둔다", () => {
    const r = render(<EditStockScreen />);
    const segmented = r.all().find((n) => n.type === "Segmented")!;
    r.act(() => (segmented.props.onChange as (v: string) => void)("sell"));
    typeIn(r, "매도 수량", "1");
    typeIn(r, "매도 체결가", "100");
    saveTrade(r);
    expect(h.update.mock.calls[0]?.[0]).toEqual({ code: "AAPL", quantity: 9, memo: null });
  });
});

describe("원화 매입금액 — 입력한 부호와 숫자를 바꾸지 않는다", () => {
  it.each(["-1000", "-1,000", "1000원", "Infinity", "1.2.3", "0", ""])("잘못된 금액 %s는 저장 요청 없이 안내한다", async (input) => {
    const r = render(<EditStockScreen />);
    typeIn(r, "원화 매입금액", input);
    r.act(() => (r.byLabel("원화 매입금액 저장").props.onPress as () => void)());
    await Promise.resolve();
    expect(h.setKrwCost).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledWith("입력 확인", expect.any(String));
  });

  it("쉼표가 있는 양수는 그 금액 그대로 저장한다", async () => {
    const r = render(<EditStockScreen />);
    typeIn(r, "원화 매입금액", "1,300,000");
    r.act(() => (r.byLabel("원화 매입금액 저장").props.onPress as () => void)());
    await Promise.resolve();
    expect(h.setKrwCost).toHaveBeenCalledWith({ AAPL: 1_300_000 });
  });
});
