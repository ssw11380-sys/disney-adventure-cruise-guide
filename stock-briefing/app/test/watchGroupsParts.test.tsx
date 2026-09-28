import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { holding, quote } from "./helpers";
import { render, type HostNode } from "./miniRender";

/**
 * 관심 그룹 부품 (3-34, 플래그 watchGroups): 잔고 줄의 화면 읽기 동작 더하기(StockRow moreActions — 없으면 지금 그대로),
 * 칩 줄·그룹 머리(이름표·선택·펼침 상태·44), 고른 칩까지 넘기기, 빈 그룹 칸 제목, 넓은 표 머리 정렬 이름표, 관심 줄 메뉴 시트(잔고: 그룹 옮기기 · 위로 · 아래로 · 수정 · 관심 해제,
 * 다른 정렬이면 안내 한 줄), 이름 창(자판이 열리면 위로 · 닫은 뒤 늦게 온 응답은 버림)
 */
const h = vi.hoisted(() => ({
  win: { width: 360, height: 752, scale: 3, fontScale: 1 },
  kb: [] as { ev: string; fn: (e: { endCoordinates: { height: number } }) => void; removed: boolean }[],
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Modal: "Modal",
  TextInput: "TextInput",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: {} },
  Platform: { OS: "android" },
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  useWindowDimensions: () => h.win,
  Keyboard: {
    addListener: (ev: string, fn: (e: { endCoordinates: { height: number } }) => void) => {
      const sub = { ev, fn, removed: false };
      h.kb.push(sub);
      return { remove: () => void (sub.removed = true) };
    },
  },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 48, left: 0, right: 0 }) }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: "LinearGradient" }));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark, useFontScale: () => 1 };
});
vi.mock("@/components/HoldingsTable", () => ({ TableLine: "TableLine", ColDivider: "ColDivider" }));
vi.mock("@/components/StockLine", async () => {
  const R = await import("react");
  const StockLine = (p: Record<string, unknown>) => R.createElement("StockLine", p);
  return { LINE_COL: {}, LineMark: "LineMark", LineValue: "LineValue", StockLine };
});
vi.mock("@/components/ui", () => ({ Button: "Button" }));

const { StockRow, sameRow } = await import("@/components/StockRow");
const { watchRowA11yActions } = await import("@/lib/rowActions");
const { WatchChips, WatchEmptyGroup, WatchGroupHead } = await import("@/components/WatchChips");
const { WatchGroupNameSheet } = await import("@/components/WatchGroupNameSheet");
const { TableHeadRow } = await import("@/components/HoldingsTableHead");
const { pickCols } = await import("@/lib/holdingsColumns");
const { FADE_W } = await import("@/components/chart/ChipStrip");
const { WatchMenuHost } = await import("@/components/WatchRowSheet");
const { WatchGroupsContext } = await import("@/lib/watchGroupsQuery");
const { watchChips, watchModel } = await import("@/lib/watchGroups");
const { space, touch } = await import("@/tokens");
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

  it("그룹 머리: '반도체 그룹, 4종목' + 펼침 상태(TalkBack 이 '펼쳐짐/접힘'을 읽음 — 이름표에 또 넣지 않음) · 힌트, 높이 44", () => {
    const toggle = vi.fn();
    const open = render(<WatchGroupHead name="반도체" groupId={7} count={4} collapsed={false} onToggle={toggle} pad={14} />).all()[0]!;
    expect([open.props.accessibilityLabel, open.props.accessibilityState, open.props.accessibilityHint]).toEqual(["반도체 그룹, 4종목", { expanded: true }, "두 번 탭하면 접습니다"]);
    const style = (open.props.style as (s: { pressed: boolean }) => unknown[])({ pressed: false });
    expect(JSON.stringify(style)).toContain(`"minHeight":${touch.min}`);
    const shut = render(<WatchGroupHead name="그룹 없음" groupId={null} count={2} collapsed onToggle={toggle} pad={14} />).all()[0]!;
    expect([shut.props.accessibilityLabel, shut.props.accessibilityState, shut.props.accessibilityHint]).toEqual(["그룹 없음, 2종목", { expanded: false }, "두 번 탭하면 펼칩니다"]);
    (shut.props.onPress as () => void)();
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe("고른 칩까지 넘기기 · 빈 그룹 칸 · 넓은 표 머리", () => {
  /** 칩 띠(ScrollView)에 가짜 scrollTo 를 달고, 띠 폭·칩 자리를 알린다 */
  const strip = (r: ReturnType<typeof render>) => {
    const sv = r.all().find((n) => n.type === "ScrollView")!;
    const scrollTo = vi.fn();
    (sv.props.ref as { current: unknown }).current = { scrollTo };
    const chips = r.all().filter((n) => n.type === "Pressable" && n.props.hitSlop);
    const layout = (n: HostNode, x: number, width: number) => r.act(() => (n.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x, y: 0, width, height: 32 } } }));
    const view = (width: number) => r.act(() => (sv.props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width, height: 44 } } }));
    return { scrollTo, chips, layout, view };
  };
  const TWO = {
    on: true,
    groups: [
      { id: 7, name: "반도체", position: 0 },
      { id: 3, name: "배당", position: 1 },
    ],
    items: [
      { code: "A", groupId: 7, position: 0 },
      { code: "B", groupId: 3, position: 0 },
    ],
  };
  const chipsOf = (selected: "none" | number) => (
    <WatchChips chips={watchChips(watchModel(LIST, TWO, { selected, collapsed: [] }, true))} onPick={() => undefined} onEdit={() => undefined} pad={14} backdrop="#000" />
  );

  it("기기에 저장한 칩이 띠 오른쪽 밖(360 · 130% 캡처: '그룹 없음' x 225.8~318.5, 띠 250)이면 그릴 때 한 번 그 칩까지 넘긴다", () => {
    const r = render(chipsOf("none"));
    const { scrollTo, chips, layout, view } = strip(r);
    expect(chips.map((c) => c.props.accessibilityLabel)).toEqual(["관심 전체, 3종목", "반도체 그룹, 1종목", "배당 그룹, 1종목", "그룹 없음, 1종목"]);
    layout(chips[0]!, 0, 60);
    layout(chips[1]!, 66, 80);
    layout(chips[2]!, 152, 68);
    layout(chips[3]!, 225.8, 92.7);
    expect(scrollTo).not.toHaveBeenCalled(); // 띠 폭을 아직 모름
    view(250);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const arg = scrollTo.mock.calls[0]![0] as { x: number; animated: boolean };
    // 칩 오른쪽 끝(318.5)이 오른쪽 흐림(FADE_W) 앞에 오게
    expect(arg.x).toBeCloseTo(318.5 + FADE_W - 250, 5);
    expect(arg.animated).toBe(false);
    // 개수가 바뀌어 칩 자리를 다시 알려도 되돌려 넘기지 않는다 (사용자가 넘겨 둔 칩 줄을 지킴)
    layout(chips[3]!, 225.8, 100);
    view(250);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("고른 칩이 다 보이면 넘기지 않는다", () => {
    const r = render(chipsOf(7));
    const { scrollTo, chips, layout, view } = strip(r);
    layout(chips[1]!, 66, 80);
    view(250);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("빈 그룹 칸 제목은 고른 그룹 이름을 말한다", () => {
    expect(render(<WatchEmptyGroup name="반도체" groupId={7} onOpen={() => undefined} />).text()).toContain("‘반도체’ 그룹에 종목이 없습니다");
    expect(render(<WatchEmptyGroup name="그룹 없음" groupId={null} onOpen={() => undefined} />).text()).toContain("‘그룹 없음’에 종목이 없습니다");
  });

  it("넓은 표 머리: 정렬 버튼 이름표를 넘기면 그 문장('… 관심 종목은 내 순서'), 안 넘기면 지금 그대로", () => {
    const head = (extra: { sortA11y?: string }) => render(<TableHeadRow plan={pickCols(853)} title="관심 9" sort="created" sortLabel="내 순서" onSort={() => undefined} onOpenSort={() => undefined} {...extra} />);
    expect(head({ sortA11y: "정렬 바꾸기, 지금 등록순, 관심 종목은 내 순서" }).has("정렬 바꾸기, 지금 등록순, 관심 종목은 내 순서")).toBe(true);
    expect(head({}).has("정렬 바꾸기, 지금 내 순서")).toBe(true);
  });
});

describe("이름 창 (WatchGroupNameSheet)", () => {
  beforeEach(() => {
    h.kb = [];
    h.win = { width: 360, height: 752, scale: 3, fontScale: 1 };
  });
  const flat = (n: HostNode) => Object.assign({}, ...(n.props.style as object[]).filter(Boolean)) as Record<string, unknown>;
  const backdrop = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "Modal")!.children.find((c): c is HostNode => typeof c !== "string")!;
  const sheetBox = (r: ReturnType<typeof render>) => r.all().find((n) => n.props.testID === "watch-name-sheet")!;
  const button = (r: ReturnType<typeof render>, title: string) => r.all().find((n) => n.type === "Button" && n.props.title === title)!;
  const kbShow = (r: ReturnType<typeof render>, height: number) => r.act(() => h.kb.find((k) => k.ev === "keyboardDidShow" && !k.removed)!.fn({ endCoordinates: { height } }));

  it("자판이 열리면(360×752, 자판 300) 시트를 위쪽에 붙이고 높이를 자판 위까지 — 입력칸·[만들기]가 자판에 가리지 않는다, 닫히면 아래로, 창을 닫으면 구독을 뗀다", () => {
    const r = render(<WatchGroupNameSheet mode="create" groups={[]} onSubmit={async () => ({ ok: true })} onClose={() => undefined} />);
    expect(flat(backdrop(r))).toMatchObject({ justifyContent: "flex-end" });
    expect(flat(sheetBox(r)).maxHeight).toBeUndefined();
    kbShow(r, 300);
    expect(flat(backdrop(r))).toMatchObject({ justifyContent: "flex-start", paddingTop: space.md });
    // 위 여백(안전 영역 0 + 12) · 아래는 자판 위 12 까지: 752 − 300 − 0 − 24 = 428 (시트 높이는 글자 200% 에서도 이 안 — 넘치면 위쪽 글만 스크롤)
    expect(flat(sheetBox(r)).maxHeight).toBe(752 - 300 - space.md * 2);
    // 입력칸은 스크롤 칸 안, 버튼 줄은 스크롤 밖(늘 보임). 자판이 열린 채 [만들기]를 한 번에 누를 수 있게 handled
    const sv = sheetBox(r).children.find((c): c is HostNode => typeof c !== "string" && c.type === "ScrollView")!;
    expect(JSON.stringify(sv)).toContain("그룹 이름, 10자까지");
    expect(sv.props.keyboardShouldPersistTaps).toBe("handled");
    expect(JSON.stringify(sv)).not.toContain('"title":"만들기"');
    expect(button(r, "만들기")).toBeTruthy();
    r.act(() => h.kb.find((k) => k.ev === "keyboardDidHide")!.fn({ endCoordinates: { height: 0 } }));
    expect(flat(backdrop(r))).toMatchObject({ justifyContent: "flex-end" });
    r.unmount();
    expect(h.kb.length).toBeGreaterThan(0);
    expect(h.kb.every((k) => k.removed)).toBe(true);
  });

  it("넓은 창(933×704)도 자판이 열리면 위쪽 (가운데 두면 자판에 가린다)", () => {
    h.win = { width: 933, height: 704, scale: 2.625, fontScale: 1 };
    const r = render(<WatchGroupNameSheet mode="rename" initial="반도체" exceptId={7} groups={[{ id: 7, name: "반도체", position: 0 }]} onSubmit={async () => ({ ok: true })} onClose={() => undefined} />);
    expect(flat(backdrop(r))).toMatchObject({ justifyContent: "center" });
    kbShow(r, 280);
    expect(flat(backdrop(r))).toMatchObject({ justifyContent: "flex-start" });
    expect(flat(sheetBox(r)).maxHeight).toBe(704 - 280 - space.md * 2);
  });

  it("저장하는 동안 창을 닫으면(바깥 · 취소) 응답이 와도 onDone 을 부르지 않는다 — 닫힌 뒤 종목이 몰래 옮겨지지 않게", async () => {
    for (const how of ["이름 창 닫기", "취소"]) {
      type Made = { ok: true; created: { id: number; name: string } };
      let finish: (v: Made) => void = () => undefined;
      const onSubmit = vi.fn((_name: string) => new Promise<Made>((res) => (finish = res)));
      const onDone = vi.fn();
      const onClose = vi.fn();
      const r = render(<WatchGroupNameSheet mode="create" groups={[]} onSubmit={onSubmit} onDone={onDone} onClose={onClose} />);
      r.act(() => (r.byLabel("그룹 이름, 10자까지").props.onChangeText as (v: string) => void)("반도체"));
      r.act(() => (button(r, "만들기").props.onPress as () => void)());
      expect(onSubmit).toHaveBeenCalledWith("반도체");
      if (how === "취소") r.act(() => (button(r, "취소").props.onPress as () => void)());
      else r.act(() => (r.byLabel(how).props.onPress as () => void)());
      expect(onClose).toHaveBeenCalledTimes(1);
      finish({ ok: true, created: { id: 12, name: "반도체" } });
      await new Promise((res) => setTimeout(res, 0));
      expect(onDone).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  });

  it("닫지 않았으면 저장 뒤 onDone → 닫기 (지금 그대로)", async () => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    const r = render(<WatchGroupNameSheet mode="create" groups={[]} onSubmit={async () => ({ ok: true, created: { id: 12, name: "배당" } })} onDone={onDone} onClose={onClose} />);
    r.act(() => (r.byLabel("그룹 이름, 10자까지").props.onChangeText as (v: string) => void)("배당"));
    r.act(() => (button(r, "만들기").props.onPress as () => void)());
    await new Promise((res) => setTimeout(res, 0));
    expect(onDone).toHaveBeenCalledWith({ ok: true, created: { id: 12, name: "배당" } });
    expect(onClose).toHaveBeenCalledTimes(1);
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
