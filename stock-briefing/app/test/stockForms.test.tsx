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
  /** useStock 에 넘어간 종목 코드 (서버에 물을 코드) */
  stockCodes: [] as string[],
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
  useStock: (code: string) => {
    h.stockCodes.push(code);
    return { data: code ? h.stock : undefined, isError: false, error: null, refetch: vi.fn() };
  },
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

  // 버그 점검 BH-26: 평단 없이 수량만 넣으면 평가손익을 못 내 합계에서 빠진다 → 등록 전에 알리고 고르게 한다
  it("수량만 넣고 평단을 비우면 합계에서 빠진다고 먼저 묻고, '그대로 등록'이면 등록한다", () => {
    const r = open();
    search(r, "삼성");
    press(r, "삼성전자 등록");
    fill(r, "10", "");
    press(r, "삼성전자 등록");
    expect(h.register).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledTimes(1);
    const [title, body, buttons] = h.alert.mock.calls[0] as [string, string, { text: string; style?: string; onPress?: () => void }[]];
    expect(title).toBe("평균 단가 없음");
    expect(body).toContain("합계에서 빠집니다");
    expect(buttons.map((b) => b.text)).toEqual(["취소", "그대로 등록"]);
    r.act(() => buttons[1]!.onPress!());
    expect(h.register.mock.calls[0][0]).toEqual({ code: "005930", quantity: 10, avgPrice: null });
  });

  it("평단만 넣고 수량을 비우면 관심 종목으로 (묻지 않음)", () => {
    const r = open();
    search(r, "삼성");
    press(r, "삼성전자 등록");
    fill(r, "", "70000");
    press(r, "삼성전자 등록");
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.register.mock.calls[0][0]).toEqual({ code: "005930", quantity: null, avgPrice: 70000 });
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

describe("BH-36: 보유 수정 딥링크 — 검증을 통과하지 못한 종목 코드는 서버에 묻지 않는다", () => {
  it("stocks/AAPL%2Fanalysis...%23/edit 는 요청 없이 안내만 하고 삭제 버튼도 없다 (재현)", () => {
    h.params = { code: "AAPL/analysis/company?refresh=1#" };
    h.stock = null;
    h.stockCodes.length = 0;
    const r = render(<EditStockScreen />);
    expect(h.stockCodes.every((c) => c === "")).toBe(true);
    const err = r.all().find((n) => n.type === "ErrorView");
    expect((err?.props.error as Error | undefined)?.message).toBe("종목 주소가 올바르지 않습니다");
    expect(r.all().some((n) => n.type === "Button" && n.props.title === "종목 삭제")).toBe(false);
  });
});

describe("BH-55·70: 체결 반영 (직접 입력 종목)", () => {
  const manual = (extra: Partial<Held>): Held => ({
    code: "SNDL",
    name: "소수점 종목",
    market: "NASDAQ",
    quantity: 1000,
    avgPrice: 0.0537,
    memo: null,
    createdAt: "2026-09-24T05:00:00.000Z",
    updatedAt: "2026-09-24T05:00:00.000Z",
    tossSynced: false,
    evaluation: null,
    ...extra,
  });
  const open = (stock: Held) => {
    h.params = { code: stock.code };
    h.stock = stock;
    return render(<EditStockScreen />);
  };
  const trade = (r: Screen, side: "buy" | "sell", qty: string, price: string) => {
    const seg = r.all().find((n) => n.type === "Segmented");
    r.act(() => (seg!.props.onChange as (v: string) => void)(side));
    const label = side === "buy" ? "매수" : "매도";
    typeIn(r, `${label} 수량`, qty);
    typeIn(r, `${label} 체결가`, price);
  };
  const row = (r: Screen, label: string) => r.all().find((n) => n.type === "Row" && n.props.label === label)?.props.value;
  const saveTrade = (r: Screen) => r.act(() => (button(r, "반영해 저장").props.onPress as () => void)());

  it("1달러 미만 미국 종목: 매수 뒤 평단을 센트로 반올림하지 않고 저장한다 (재현: 0.05745 → 0.06)", () => {
    const r = open(manual({}));
    trade(r, "buy", "1000", "0.0612");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toEqual({ code: "SNDL", quantity: 2000, avgPrice: 0.05745, memo: null });
  });

  it("반올림한 평단이 칸에 보이던 값과 같아도 새 평단을 보낸다 (0.04935 가 0.05 로 줄어 평단을 안 보내 예전 평단이 남던 경우)", () => {
    const r = open(manual({}));
    trade(r, "buy", "1000", "0.045");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toEqual({ code: "SNDL", quantity: 2000, avgPrice: 0.04935, memo: null });
  });

  it("처음 매수(보유 0)한 동전주 체결가는 자르지 않고 그대로 저장, 미리보기도 '$0.00' 이 아니라 그 값 (검증 지적: 0.0001234 → 0.000123)", () => {
    const r = open(manual({ quantity: null, avgPrice: null }));
    trade(r, "buy", "1000", "0.0001234");
    expect(row(r, "거래 후 평단")).toBe("$0.0001234");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toEqual({ code: "SNDL", quantity: 1000, avgPrice: 0.0001234, memo: null });
  });

  it("1센트 미만 평단끼리의 가중 평균도 자르지 않는다", () => {
    const r = open(manual({ quantity: 1000, avgPrice: 0.0001234 }));
    trade(r, "buy", "1000", "0.00013");
    expect(row(r, "거래 후 평단")).toBe("$0.0001267");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toMatchObject({ quantity: 2000, avgPrice: 0.0001267 });
  });

  it("미리보기 '거래 후 평단': 1달러 미만은 센트 아래 자리까지, 그 밖에는 평소 표기 (저장값은 부동소수 꼬리만 뺌)", () => {
    const r = open(manual({}));
    trade(r, "buy", "1000", "0.0612");
    expect(row(r, "거래 후 평단")).toBe("$0.05745");
    const r2 = open(manual({ quantity: 1, avgPrice: 0.4 }));
    trade(r2, "buy", "1", "0.6");
    expect(row(r2, "거래 후 평단")).toBe("$0.50");
    const r3 = open(manual({ code: "AAPL", name: "애플", quantity: 3, avgPrice: 183.4567 }));
    trade(r3, "buy", "7", "190.1234");
    expect(row(r3, "거래 후 평단")).toBe("$188.12");
    saveTrade(r3);
    expect(h.update.mock.calls.at(-1)![0]).toMatchObject({ quantity: 10, avgPrice: 188.12339 });
  });

  it("새 평단이 칸에 줄여 보이던 글자와 같아도 평단을 보낸다 (재현: $0.0537 칸 '0.05' + $0.0463 매수 → 평단 0.05 를 안 보내 매입금액 $107.40 이 남던 경우, 실제 $100)", () => {
    const r = open(manual({}));
    expect(value(r, "평균 단가")).toBe("0.05");
    trade(r, "buy", "1000", "0.0463");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toEqual({ code: "SNDL", quantity: 2000, avgPrice: 0.05, memo: null });
  });

  it("국내도 같다 (재현: 70,000.25원 4주 칸 '70000' + 69,999.75원 4주 → 평단 70,000 을 안 보내 수량만 저장되던 경우)", () => {
    const r = open(manual({ code: "005930", name: "삼성전자", market: "KOSPI", quantity: 4, avgPrice: 70000.25 }));
    expect(value(r, "평균 단가")).toBe("70000");
    trade(r, "buy", "4", "69999.75");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toEqual({ code: "005930", quantity: 8, avgPrice: 70000, memo: null });
  });

  it("매도는 평단이 그대로라 수량만, 전부 팔면 수량·평단을 비운다", () => {
    const r = open(manual({}));
    trade(r, "sell", "400", "0.07");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toEqual({ code: "SNDL", quantity: 600, memo: null });
    const r2 = open(manual({}));
    trade(r2, "sell", "1000", "0.07");
    saveTrade(r2);
    expect(h.update.mock.calls[1][0]).toEqual({ code: "SNDL", quantity: null, avgPrice: null, memo: null });
  });

  it("위 칸에서 고친 평단으로 계산한 체결은 그 평단으로 저장한다", () => {
    const r = open(manual({}));
    typeIn(r, "평균 단가", "0.06");
    trade(r, "sell", "500", "0.07");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toEqual({ code: "SNDL", quantity: 500, avgPrice: 0.06, memo: null });
  });

  it("위 칸의 수량이 숫자가 아니면 수량을 비우지 않고 입력 확인을 띄운다", () => {
    const r = open(manual({}));
    typeIn(r, "보유 수량", "abc");
    trade(r, "buy", "10", "0.05");
    saveTrade(r);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.alert.mock.calls[0][0]).toBe("입력 확인");
  });

  it("국내 종목 평단은 예전처럼 소수 둘째 자리까지", () => {
    const r = open(manual({ code: "005930", name: "삼성전자", market: "KOSPI", quantity: 3, avgPrice: 70000 }));
    trade(r, "buy", "1", "70001");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toEqual({ code: "005930", quantity: 4, avgPrice: 70000.25, memo: null });
  });

  it("소수 주식 미리보기 '거래 후 수량'에 부동소수 꼬리가 없고 저장값과 같다 (재현: 0.30000000000000004주)", () => {
    const r = open(manual({ quantity: 0.1, avgPrice: 100 }));
    trade(r, "buy", "0.2", "100");
    expect(row(r, "거래 후 수량")).toBe("0.3주");
    saveTrade(r);
    expect(h.update.mock.calls[0][0]).toMatchObject({ quantity: 0.3 });
    const r2 = open(manual({ quantity: 0.8, avgPrice: 100 }));
    trade(r2, "sell", "0.1", "100");
    expect(row(r2, "거래 후 수량")).toBe("0.7주");
    const r3 = open(manual({ quantity: 1.1, avgPrice: 100 }));
    trade(r3, "buy", "2.2", "100");
    expect(row(r3, "거래 후 수량")).toBe("3.3주");
  });

  it("큰 수량은 자리 구분", () => {
    const r = open(manual({ code: "005930", name: "삼성전자", market: "KOSPI", quantity: 1200, avgPrice: 70000 }));
    trade(r, "buy", "34", "70000");
    expect(row(r, "거래 후 수량")).toBe("1,234주");
  });
});
