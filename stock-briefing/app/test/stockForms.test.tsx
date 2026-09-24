import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Evaluation, ListedStock, RegisteredStock } from "@/api/types";
import type { RecentStock } from "@/lib/recentSearch";
import { render, type HostNode } from "./miniRender";

/**
 * 종목 등록·보유 수정 화면의 입력 초안 (PF-06·07).
 * 실제 화면 컴포넌트를 최소 렌더러로 그리고, RN 부품은 문자열 요소로·API 훅은 가짜로 바꿔 끼운다
 */
type Held = RegisteredStock & { evaluation?: Evaluation | null };
const h = vi.hoisted(() => ({
  params: {} as { code?: string },
  stock: null as unknown,
  catalog: [] as unknown[],
  recent: [] as unknown[],
  register: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setKrwCost: vi.fn(),
  back: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("react-native", async () => {
  const R = await import("react");
  interface ListProps {
    data: unknown[];
    renderItem: (x: { item: unknown; index: number }) => React.ReactNode;
    keyExtractor: (item: unknown) => string;
    ListHeaderComponent?: React.ReactNode;
    ListEmptyComponent?: React.ReactNode;
    ListFooterComponent?: React.ReactNode;
  }
  const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: ListProps) =>
    R.createElement(
      "FlatList",
      null,
      ListHeaderComponent ?? null,
      data.length ? data.map((item, index) => R.createElement(R.Fragment, { key: keyExtractor(item) }, renderItem({ item, index }))) : (ListEmptyComponent ?? null),
      ListFooterComponent ?? null,
    );
  return {
    View: "View",
    Text: "Text",
    TextInput: "TextInput",
    Pressable: "Pressable",
    FlatList,
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
    Alert: { alert: h.alert },
    Platform: { OS: "android" },
    ToastAndroid: { show: vi.fn(), SHORT: 0 },
  };
});
vi.mock("@expo/vector-icons", () => ({ Ionicons: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: vi.fn(), back: h.back, dismissTo: vi.fn() }, useLocalSearchParams: () => h.params }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: async () => {} }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.light };
});
vi.mock("@/lib/settings", () => ({ useSettings: () => ({ apiUrl: "https://server.test" }) }));
vi.mock("@/lib/recentSearch", () => ({ useRecentSearches: () => ({ items: h.recent, add: vi.fn(), clear: vi.fn() }) }));
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", ErrorView: "ErrorView", Loading: "Loading", Muted: "Muted", Row: "Row", SectionTitle: "SectionTitle", Segmented: "Segmented" }));
vi.mock("@/components/StockLine", async () => {
  const R = await import("react");
  // 줄 오른쪽(등록 버튼)만 그린다
  const StockLine = ({ name, right }: { name: string; right: React.ReactNode }) => R.createElement("StockLine", { name }, right);
  return { LineHead: "LineHead", LineMark: "LineMark", StockLine };
});
vi.mock("@/api/hooks", () => ({
  useApi: () => ({ setKrwCost: h.setKrwCost }),
  useStock: () => ({ data: h.stock, isError: false, error: null, refetch: vi.fn() }),
  useStockMutations: () => ({
    register: { mutate: h.register, isPending: false },
    update: { mutate: h.update, isPending: false },
    remove: { mutate: h.remove, isPending: false },
  }),
  useRegisteredCodes: () => ({ codes: new Set<string>(), refresh: vi.fn() }),
  useSearch: (q: string) => {
    const query = q.trim().toUpperCase();
    const results = (h.catalog as ListedStock[]).filter((s) => s.name.includes(q.trim()) || s.code.includes(query));
    return { data: query ? { results } : undefined, pending: false, previous: false, isError: false, error: null };
  },
}));

const { default: AddStockScreen } = await import("@/app/stocks/add");
const { default: EditStockScreen } = await import("@/app/stocks/[code]/edit");
const { ApiRequestError } = await import("@/api/client");

type Screen = ReturnType<typeof render>;
const typeIn = (r: Screen, label: string, v: string) => r.act(() => (r.byLabel(label).props.onChangeText as (v: string) => void)(v));
const press = (r: Screen, label: string) => r.act(() => (r.byLabel(label).props.onPress as () => void)());
const value = (r: Screen, label: string) => r.byLabel(label).props.value;
/** 제목으로 버튼 하나 (이름표 없는 "저장") */
function button(r: Screen, title: string): HostNode {
  const hits = r.all().filter((n) => n.type === "Button" && n.props.title === title);
  expect(hits).toHaveLength(1);
  return hits[0];
}

const SAMSUNG: ListedStock = { code: "005930", name: "삼성전자", market: "KOSPI", isinCode: null, groupCode: null };
const APPLE: ListedStock = { code: "AAPL", name: "애플", market: "NASDAQ", isinCode: null, groupCode: null, currency: "USD" };
const TESLA: RecentStock = { code: "TSLA", name: "테슬라", market: "NASDAQ" };

beforeEach(() => {
  vi.useFakeTimers();
  h.catalog = [SAMSUNG, APPLE];
  h.recent = [TESLA];
  for (const f of [h.register, h.update, h.remove, h.setKrwCost, h.back, h.alert]) f.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("PF-06: 종목 등록 양식 — 다른 종목을 고르면 수량·평단을 비운다", () => {
  const open = () => render(<AddStockScreen />);
  /** 검색창에 치고 150ms 입력 멈춤을 기다린다 */
  const search = (r: Screen, q: string) => {
    typeIn(r, "종목 검색", q);
    r.act(() => vi.advanceTimersByTime(150));
  };
  const fill = (r: Screen, qty: string, avg: string) => {
    typeIn(r, "보유 수량", qty);
    typeIn(r, "평균 단가", avg);
  };

  it("국내 → 미국: 삼성전자에 넣던 10주·70,000원이 애플 양식에 남지 않는다 (재현)", () => {
    const r = open();
    search(r, "삼성");
    press(r, "삼성전자 등록");
    fill(r, "10", "70000");
    press(r, "선택 취소");
    search(r, "AAPL");
    press(r, "애플 등록");
    expect(r.byLabel("평균 단가").props.placeholder).toBe("평균 단가 ($)");
    expect(value(r, "보유 수량")).toBe("");
    expect(value(r, "평균 단가")).toBe("");
    // 그대로 등록하면 관심 종목으로 (원화 평단이 달러 종목에 가지 않음)
    press(r, "애플 등록");
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(h.register.mock.calls[0][0]).toEqual({ code: "AAPL", quantity: null, avgPrice: null });
  });

  it("미국 → 국내: 애플에 넣던 값이 삼성전자 양식에 남지 않는다", () => {
    const r = open();
    search(r, "AAPL");
    press(r, "애플 등록");
    fill(r, "3", "150.25");
    press(r, "선택 취소");
    search(r, "삼성");
    press(r, "삼성전자 등록");
    expect(r.byLabel("평균 단가").props.placeholder).toBe("평균 단가 (원)");
    expect(value(r, "보유 수량")).toBe("");
    expect(value(r, "평균 단가")).toBe("");
  });

  it("검색창에 입력해 선택이 풀려도 비운다", () => {
    const r = open();
    search(r, "삼성");
    press(r, "삼성전자 등록");
    fill(r, "10", "70000");
    search(r, "AAPL");
    expect(r.has("보유 수량")).toBe(false);
    press(r, "애플 등록");
    expect(value(r, "보유 수량")).toBe("");
    expect(value(r, "평균 단가")).toBe("");
  });

  it("최근 검색에서 등록해도 비운다", () => {
    const r = open();
    search(r, "삼성");
    press(r, "삼성전자 등록");
    fill(r, "10", "70000");
    press(r, "선택 취소");
    press(r, "검색어 지우기");
    r.act(() => vi.advanceTimersByTime(150));
    press(r, "테슬라 등록");
    expect(r.byLabel("평균 단가").props.placeholder).toBe("평균 단가 ($)");
    expect(value(r, "보유 수량")).toBe("");
    expect(value(r, "평균 단가")).toBe("");
  });

  it("이미 등록된 종목(409)으로 양식이 닫힌 뒤 다른 종목을 골라도 비운다", () => {
    const r = open();
    search(r, "삼성");
    press(r, "삼성전자 등록");
    fill(r, "10", "70000");
    press(r, "삼성전자 등록");
    const opts = h.register.mock.calls[0][1] as { onError: (e: unknown) => void };
    r.act(() => opts.onError(new ApiRequestError(409, "CONFLICT", "이미 등록됨")));
    expect(r.has("보유 수량")).toBe(false);
    search(r, "AAPL");
    press(r, "애플 등록");
    expect(value(r, "보유 수량")).toBe("");
    expect(value(r, "평균 단가")).toBe("");
  });

  it("같은 종목 양식에서 넣은 값은 그대로 등록된다", () => {
    const r = open();
    search(r, "삼성");
    press(r, "삼성전자 등록");
    fill(r, "10", "70,000");
    press(r, "삼성전자 등록");
    expect(h.register.mock.calls[0][0]).toEqual({ code: "005930", quantity: 10, avgPrice: 70000 });
  });
});

describe("PF-07: 보유 수정 — 같은 종목의 서버 값이 바뀌어도 입력 중인 초안을 지킨다", () => {
  const AT_1400 = "2026-09-24T05:00:00.000Z";
  const AT_1401 = "2026-09-24T05:01:00.000Z";
  const DRAFT = "작성 중 아직 저장하지 않은 메모";
  const STALE = "입력하는 사이 저장된 값이 바뀌었습니다";
  const held = (extra: Partial<Held> = {}): Held => ({
    code: "005930",
    name: "삼성전자",
    market: "KOSPI",
    quantity: 10,
    avgPrice: 70000,
    memo: "저장된 메모",
    createdAt: AT_1400,
    updatedAt: AT_1400,
    tossSynced: true,
    evaluation: null,
    ...extra,
  });
  const usHeld = (extra: Partial<Held> = {}): Held =>
    held({ code: "TSLA", name: "테슬라", market: "NASDAQ", quantity: 5, avgPrice: 200, memo: null, evaluation: { marketValue: 1250, costBasis: 1000, profit: 250, profitRate: 25, costBasisKrw: 1_300_000, krwCostSource: "exact" }, ...extra });
  /** 서버에서 새 값을 받은 것처럼 다시 그린다 (상세 재조회·토스 체결 동기화) */
  const serve = (r: Screen | null, stock: Held) => {
    h.params = { code: stock.code };
    h.stock = stock;
    r?.rerender();
  };
  const open = (stock: Held) => {
    serve(null, stock);
    return render(<EditStockScreen />);
  };

  it("토스 체결로 수량·updatedAt 이 바뀌어도 쓰던 메모가 남는다 (재현)", () => {
    const r = open(held());
    expect(value(r, "메모")).toBe("저장된 메모");
    typeIn(r, "메모", DRAFT);
    serve(r, held()); // 같은 updatedAt 재수신
    expect(value(r, "메모")).toBe(DRAFT);
    serve(r, held({ quantity: 11, updatedAt: AT_1401 }));
    expect(value(r, "메모")).toBe(DRAFT);
    // 손대지 않은 서버 소유 칸은 새 값을 따른다. 서버 메모는 그대로라 충돌 안내 없음
    expect(value(r, "보유 수량")).toBe("11");
    expect(r.text()).not.toContain(STALE);
    // 저장하면 메모만 보낸다 (토스 종목은 수량·평단 잠김)
    r.act(() => (button(r, "저장").props.onPress as () => void)());
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toEqual({ code: "005930", memo: DRAFT });
  });

  it("메모 저장이 끝나면 이전 화면으로 가고, 저장된 메모를 다시 받아도 그대로다", () => {
    const r = open(held());
    typeIn(r, "메모", DRAFT);
    r.act(() => (button(r, "저장").props.onPress as () => void)());
    const opts = h.update.mock.calls[0][1] as { onSuccess: () => void };
    r.act(() => opts.onSuccess());
    expect(h.back).toHaveBeenCalledTimes(1);
    serve(r, held({ memo: DRAFT, updatedAt: AT_1401 }));
    expect(value(r, "메모")).toBe(DRAFT);
    expect(r.text()).not.toContain(STALE);
  });

  it("종목이 바뀌면 폼을 새로 만든다", () => {
    const r = open(held());
    typeIn(r, "메모", DRAFT);
    typeIn(r, "보유 수량", "12");
    serve(r, held({ code: "000660", name: "SK하이닉스", quantity: 3, avgPrice: 180000, memo: "하이닉스 메모", tossSynced: false }));
    expect(value(r, "메모")).toBe("하이닉스 메모");
    expect(value(r, "보유 수량")).toBe("3");
    expect(value(r, "평균 단가")).toBe("180000");
  });

  it("원화 매입금액 입력 중 동기화: 입력값은 남고 서버 값이 바뀐 것을 알린다", () => {
    const r = open(usHeld());
    expect(value(r, "원화 매입금액")).toBe("1300000");
    typeIn(r, "원화 매입금액", "1350000");
    serve(r, usHeld({ quantity: 6, updatedAt: AT_1401, evaluation: { marketValue: 1500, costBasis: 1200, profit: 300, profitRate: 25, costBasisKrw: 1_560_000, krwCostSource: "exact" } }));
    expect(value(r, "원화 매입금액")).toBe("1350000");
    expect(value(r, "보유 수량")).toBe("6");
    expect(r.text()).toContain(STALE);
  });

  it("원화 매입금액을 쉼표로 넣고 저장한 뒤 같은 값을 다시 받으면 안내하지 않는다", () => {
    const r = open(usHeld());
    typeIn(r, "원화 매입금액", "1,350,000");
    serve(r, usHeld({ updatedAt: AT_1401, evaluation: { marketValue: 1250, costBasis: 1000, profit: 250, profitRate: 25, costBasisKrw: 1_350_000, krwCostSource: "exact" } }));
    expect(value(r, "원화 매입금액")).toBe("1350000");
    expect(r.text()).not.toContain(STALE);
  });

  it("손대지 않은 원화 매입금액은 새 서버 값을 따른다", () => {
    const r = open(usHeld());
    serve(r, usHeld({ quantity: 6, updatedAt: AT_1401, evaluation: { marketValue: 1500, costBasis: 1200, profit: 300, profitRate: 25, costBasisKrw: 1_560_000, krwCostSource: "exact" } }));
    expect(value(r, "원화 매입금액")).toBe("1560000");
    expect(r.text()).not.toContain(STALE);
  });

  it("직접 입력 종목: 고치던 수량은 남기고 안내, 손대지 않은 평단은 새 값, 저장은 고친 칸만", () => {
    const r = open(held({ tossSynced: false }));
    typeIn(r, "보유 수량", "12");
    serve(r, held({ tossSynced: false, quantity: 11, avgPrice: 71000, updatedAt: AT_1401 }));
    expect(value(r, "보유 수량")).toBe("12");
    expect(value(r, "평균 단가")).toBe("71000");
    expect(r.text()).toContain(STALE);
    r.act(() => (button(r, "저장").props.onPress as () => void)());
    expect(h.update.mock.calls[0][0]).toEqual({ code: "005930", quantity: 12, memo: "저장된 메모" });
  });

  describe("원화 매입금액 저장 안내 — 서버가 지금 원화 손익에 쓰는지에 맞춘다 (PF-05 뒤)", () => {
    // 잠금 밖에서 평단을 직접 고친 해외 종목: 서버가 토스 기준을 지워 원화 장부를 쓰지 않는다 (costBasisKrw 없음)
    const manualUs = () => usHeld({ tossSynced: false, quantity: 10, avgPrice: 101, evaluation: { marketValue: 1500, costBasis: 1010, profit: 490, profitRate: 48.51, costBasisKrw: null, krwCostSource: null } });
    const saveKrw = async (stock: Held, reply: unknown) => {
      h.setKrwCost.mockResolvedValue(reply);
      const r = open(stock);
      typeIn(r, "원화 매입금액", "1,310,000");
      press(r, "원화 매입금액 저장");
      await vi.waitFor(() => expect(h.alert).toHaveBeenCalledTimes(1));
      expect(h.setKrwCost).toHaveBeenCalledWith({ TSLA: 1_310_000 });
      return h.alert.mock.calls[0] as [string, string];
    };

    it("직접 고친 종목(manual)은 '토스 앱과 같은 기준으로 계산됩니다'라고 하지 않고 다음 동기화 뒤에 쓰인다고 알린다 (재현)", async () => {
      const [title, body] = await saveKrw(manualUs(), { applied: [], skipped: [{ code: "TSLA", reason: "manual" }] });
      expect(title).toBe("저장됨 (동기화 뒤 적용)");
      expect(body).toContain("직접 고친 수량·평단으로 평가 중이라, 원화 매입금액은 다음 토스 동기화 뒤에 쓰입니다");
      expect(body).not.toContain("계산됩니다");
    });

    it("토스 기준으로 평가 중이면(applied) 지금처럼 저장됨", async () => {
      const [title, body] = await saveKrw(usHeld({ tossSynced: false }), { applied: ["TSLA"], skipped: [] });
      expect(title).toBe("저장됨");
      expect(body).toBe("원화 손익이 토스 앱과 같은 기준으로 계산됩니다.");
    });

    it("다른 이유로 못 했으면 지금처럼 저장 실패와 이유", async () => {
      const [title, body] = await saveKrw(usHeld(), { applied: [], skipped: [{ code: "TSLA", reason: "changed" }] });
      expect(title).toBe("저장 실패");
      expect(body).toBe("저장하는 사이 체결이 있었습니다. 토스 앱의 최신 값으로 다시 저장해 주세요.");
    });
  });

  it("고치던 중 토스 연동으로 잠기면 수량·평단은 서버 값을 보이고 메모만 저장한다", () => {
    const r = open(held({ tossSynced: false }));
    typeIn(r, "보유 수량", "12");
    typeIn(r, "메모", DRAFT);
    serve(r, held({ tossSynced: true, quantity: 11, updatedAt: AT_1401 }));
    expect(value(r, "보유 수량")).toBe("11");
    expect(value(r, "메모")).toBe(DRAFT);
    expect(r.text()).not.toContain(STALE);
    r.act(() => (button(r, "저장").props.onPress as () => void)());
    expect(h.update.mock.calls[0][0]).toEqual({ code: "005930", memo: DRAFT });
  });
});
