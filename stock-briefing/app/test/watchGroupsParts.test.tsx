import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 관심 그룹 부품 (3-34, 플래그 watchGroups): 잔고 줄의 화면 읽기 동작 더하기(StockRow moreActions — 없으면 지금 그대로),
 * 칩 줄·그룹 머리(이름표·선택·펼침 상태·44), 관심 줄 메뉴 시트(잔고: 그룹 옮기기 · 위로 · 아래로 · 수정 · 관심 해제, 다른 정렬이면 안내 한 줄)
 */
const h = vi.hoisted(() => ({ win: { width: 360, height: 752, scale: 3, fontScale: 1 } }));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Modal: "Modal",
  TextInput: "TextInput",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: "android" },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  useWindowDimensions: () => h.win,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 48, left: 0, right: 0 }) }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => 1 };
});
vi.mock("@/components/HoldingsTable", () => ({ TableLine: "TableLine" }));
vi.mock("@/components/StockLine", async () => {
  const R = await import("react");
  const StockLine = (p: Record<string, unknown>) => R.createElement("StockLine", p);
  return { LINE_COL: {}, LineMark: "LineMark", LineValue: "LineValue", StockLine };
});
vi.mock("@/components/ui", () => ({ Button: "Button" }));

const { StockRow, sameRow } = await import("@/components/StockRow");
const { watchRowA11yActions } = await import("@/lib/rowActions");
const { WatchChips, WatchGroupHead } = await import("@/components/WatchChips");
const { WatchMenuHost } = await import("@/components/WatchRowSheet");
const { WatchGroupsContext } = await import("@/lib/watchGroupsQuery");
const { watchChips, watchModel } = await import("@/lib/watchGroups");
const { touch } = await import("@/tokens");
type State = import("@/lib/watchGroupsQuery").WatchGroupsState;

const avgo = holding("AVGO", quote("AVGO", 345.2, { currency: "USD", change: 5.9, changeRate: 1.74, fxRate: 1400 }), null, null, undefined, "브로드컴");

describe("잔고 줄: 화면 읽기 동작 더하기 (StockRow moreActions)", () => {
  const line = (el: React.ReactElement) => render(el).all().find((n) => n.type === "StockLine")!;
  it("없으면 지금 그대로 — '수정·삭제' 길게 누르기 하나 / oneHand 세 동작", () => {
    expect(line(<StockRow stock={avgo} onPress={() => undefined} onLongPress={() => undefined} showKrw={false} />).props.accessibilityActions).toEqual([{ name: "longpress", label: "수정·삭제" }]);
    expect((line(<StockRow stock={avgo} onPress={() => undefined} onLongPress={() => undefined} onRowAction={() => undefined} showKrw={false} />).props.accessibilityActions as { label: string }[]).map((a) => a.label)).toEqual([
      "수정",
      "관심 해제",
      "메뉴 열기",
    ]);
  });

  it("관심 줄: 길게 누르기 이름은 '메뉴 열기' + 그룹 옮기기 · 위로 · 아래로, 고르면 onMoreAction", () => {
    const more = vi.fn();
    const long = vi.fn();
    const actions = watchRowA11yActions({ up: true, down: true });
    const plain = line(<StockRow stock={avgo} onPress={() => undefined} onLongPress={long} moreActions={actions} onMoreAction={more} showKrw={false} />);
    expect((plain.props.accessibilityActions as { label: string }[]).map((a) => a.label)).toEqual(["메뉴 열기", "그룹 옮기기", "위로 옮기기", "아래로 옮기기"]);
    const act = plain.props.onAccessibilityAction as (n: string) => void;
    act("watchUp");
    act("longpress");
    expect(more).toHaveBeenCalledWith(avgo, "watchUp");
    expect(long).toHaveBeenCalledWith(avgo);
    const edit = vi.fn();
    const oneHand = line(<StockRow stock={avgo} onPress={() => undefined} onLongPress={long} onRowAction={edit} moreActions={watchRowA11yActions({ up: false, down: true })} onMoreAction={more} showKrw={false} />);
    expect((oneHand.props.accessibilityActions as { label: string }[]).map((a) => a.label)).toEqual(["수정", "관심 해제", "메뉴 열기", "그룹 옮기기", "아래로 옮기기"]);
    (oneHand.props.onAccessibilityAction as (n: string) => void)("remove");
    expect(edit).toHaveBeenCalledWith(avgo, "remove");
  });

  it("같은 조합이면 같은 배열 (memo 비교가 깨지지 않게), 비교에 들어간다", () => {
    expect(watchRowA11yActions({ up: true, down: false })).toBe(watchRowA11yActions({ up: true, down: false }));
    expect(watchRowA11yActions({ up: false, down: false }).map((a) => a.name)).toEqual(["watchGroup"]);
    const base = { stock: avgo, onPress: () => undefined, showKrw: false };
    expect(sameRow({ ...base, moreActions: watchRowA11yActions({ up: true, down: true }) }, { ...base, moreActions: watchRowA11yActions({ up: true, down: true }) })).toBe(true);
    expect(sameRow({ ...base, moreActions: watchRowA11yActions({ up: true, down: true }) }, { ...base, moreActions: watchRowA11yActions({ up: false, down: true }) })).toBe(false);
  });
});

const at = (m: number) => `2026-09-01T09:${String(m).padStart(2, "0")}:00+09:00`;
const w = (code: string, name: string, m: number): RegisteredWithQuote => ({ ...holding(code, quote(code, 100), null, null, undefined, name), createdAt: at(m) });
const LIST = [w("A", "삼성전자", 1), w("B", "SK하이닉스", 2), w("C", "애플", 3)];
const LAYOUT = { on: true, groups: [{ id: 7, name: "미국배당성장ETF", position: 0 }], items: [{ code: "A", groupId: 7, position: 0 }, { code: "B", groupId: 7, position: 1 }] };

describe("칩 줄 · 그룹 머리", () => {
  it("칩: 이름표 '… 그룹, N종목' · 선택 상태 · 누르는 영역 44 (칩 32 + hitSlop), [그룹·순서] 44", () => {
    const pick = vi.fn();
    const edit = vi.fn();
    const model = watchModel(LIST, LAYOUT, { selected: 7, collapsed: [] }, true);
    const r = render(<WatchChips chips={watchChips(model)} onPick={pick} onEdit={edit} pad={14} backdrop="#000" />);
    const chips = r.all().filter((n) => n.type === "Pressable" && n.props.hitSlop);
    expect(chips.map((c) => [c.props.accessibilityLabel, (c.props.accessibilityState as { selected: boolean }).selected])).toEqual([
      ["관심 전체, 3종목", false],
      ["미국배당성장ETF 그룹, 2종목", true],
      ["그룹 없음, 1종목", false],
    ]);
    for (const c of chips) {
      const slop = c.props.hitSlop as { top: number; bottom: number };
      expect(32 + slop.top + slop.bottom).toBeGreaterThanOrEqual(touch.min);
    }
    (chips[2]!.props.onPress as () => void)();
    expect(pick).toHaveBeenCalledWith("none");
    const btn = r.byLabel("관심 그룹과 순서 편집");
    expect(JSON.stringify(btn.props.style)).toContain(`"minHeight":${touch.min}`);
    (btn.props.onPress as () => void)();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(r.text()).toContain("그룹·순서");
  });

  it("그룹 머리: '반도체 그룹, 4종목, 펼쳐짐' · 펼침 상태 · 힌트, 접히면 '접힘'·'펼칩니다', 높이 44", () => {
    const toggle = vi.fn();
    const open = render(<WatchGroupHead name="반도체" groupId={7} count={4} collapsed={false} onToggle={toggle} pad={14} />).all()[0]!;
    expect([open.props.accessibilityLabel, open.props.accessibilityState, open.props.accessibilityHint]).toEqual(["반도체 그룹, 4종목, 펼쳐짐", { expanded: true }, "두 번 탭하면 접습니다"]);
    const style = (open.props.style as (s: { pressed: boolean }) => unknown[])({ pressed: false });
    expect(JSON.stringify(style)).toContain(`"minHeight":${touch.min}`);
    const shut = render(<WatchGroupHead name="그룹 없음" groupId={null} count={2} collapsed onToggle={toggle} pad={14} />).all()[0]!;
    expect([shut.props.accessibilityLabel, shut.props.accessibilityHint]).toEqual(["그룹 없음, 2종목, 접힘", "두 번 탭하면 펼칩니다"]);
    (shut.props.onPress as () => void)();
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe("관심 줄 메뉴 시트 (잔고)", () => {
  const ops = { move: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn(), order: vi.fn() };
  const state: State = { on: true, layout: LAYOUT, view: { selected: "all", collapsed: [] }, setView: () => {}, ops, status: "ready", error: null, refetch: () => {} };
  beforeEach(() => Object.values(ops).forEach((f) => f.mockReset()));
  const host = (mine: boolean, onClose = vi.fn(), onRemove = vi.fn(), onEdit = vi.fn()) =>
    render(
      <WatchGroupsContext.Provider value={state}>
        <WatchMenuHost target={{ stock: LIST[1]!, step: "menu" }} model={watchModel(LIST, LAYOUT, state.view, mine)} mine={mine} variant="holdings" removeText="관심 해제" onEdit={onEdit} onRemove={onRemove} onClose={onClose} />
      </WatchGroupsContext.Provider>,
    );
  const items = (r: ReturnType<typeof render>) =>
    r
      .all()
      .filter((n) => n.type === "Pressable" && n.props.accessibilityRole === "button")
      .map((n) => n.props.accessibilityLabel as string);

  it("제목 · '지금: 미국배당성장ETF · 2번째 (2종목 중)' · 그룹 옮기기 · 위로 · 아래로(맨 아래라 사용 불가) · 수정 · 관심 해제(경고색) · 닫기", () => {
    const onClose = vi.fn();
    const onRemove = vi.fn();
    const r = host(true, onClose, onRemove);
    expect(r.text()).toContain("SK하이닉스");
    expect(r.text()).toContain("지금: 미국배당성장ETF · 2번째 (2종목 중)");
    expect(items(r)).toEqual(["메뉴 닫기", "그룹 옮기기", "위로 옮기기", "아래로 옮기기", "수정", "관심 해제", "닫기"]);
    expect(r.byLabel("아래로 옮기기").props.accessibilityState).toEqual({ disabled: true });
    r.act(() => (r.byLabel("위로 옮기기").props.onPress as () => void)());
    expect(ops.move).toHaveBeenCalledWith(LIST[1], 7, 0, "SK하이닉스를 미국배당성장ETF 1번째로 옮겼습니다");
    expect(onClose).toHaveBeenCalled();
    r.act(() => (r.byLabel("관심 해제").props.onPress as () => void)());
    expect(onRemove).toHaveBeenCalledWith(LIST[1]);
    // 항목 높이 44
    const style = (r.byLabel("수정").props.style as (s: { pressed: boolean }) => unknown[])({ pressed: false });
    expect(JSON.stringify(style)).toContain(`"minHeight":${touch.min}`);
  });

  it("정렬이 등록순이 아니면 위로·아래로 대신 안내 한 줄", () => {
    const r = host(false);
    expect(items(r)).toEqual(["메뉴 닫기", "그룹 옮기기", "수정", "관심 해제", "닫기"]);
    expect(r.text()).toContain("순서 옮기기는 정렬이 ‘등록순’일 때 쓸 수 있습니다");
  });

  it("그룹 고르기 → '＋ 새 그룹 만들고 옮기기' → 이름 창 → 만든 그룹으로 옮김", async () => {
    ops.create.mockResolvedValue({ ok: true, created: { id: 12, name: "반도체" } });
    const r = host(true);
    r.act(() => (r.byLabel("그룹 옮기기").props.onPress as () => void)());
    expect(r.text()).toContain("‘SK하이닉스’ 옮길 그룹");
    r.act(() => (r.byLabel("새 그룹 만들고 옮기기").props.onPress as () => void)());
    const input = r.byLabel("그룹 이름, 10자까지");
    r.act(() => (input.props.onChangeText as (v: string) => void)("반도체"));
    const make = r.all().find((n: HostNode) => n.type === "Button" && n.props.title === "만들기")!;
    r.act(() => (make.props.onPress as () => void)());
    await new Promise((res) => setTimeout(res, 0));
    expect(ops.create).toHaveBeenCalledWith("반도체");
    expect(ops.move).toHaveBeenCalledWith(LIST[1], 12, 0, "SK하이닉스를 반도체 그룹 맨 끝으로 옮겼습니다");
  });
});
