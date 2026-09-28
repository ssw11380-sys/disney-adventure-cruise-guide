import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNode } from "./miniRender";

/**
 * 새 화면 '이동평균선' (/chart-lines — 3-39 PR 2, 기능 플래그 maCustom).
 *  - 꺼져 있으면 안내 하나만 ('설정 열기' 가지 없음)
 *  - 선 6개마다 기간 입력칸 · 보이기 스위치 · 색 단추 8개(44×44, 4개씩 두 줄). [처음 값으로] [저장]
 *  - 기간은 입력칸 글자가 원본: 오류는 늘 지금 글자로(겹친 두 칸 모두), 겹침이 풀리면 함께 사라지고, 저장값 = 보이는 값, 맞바꾸기 가능
 *  - [저장]을 눌러야 기기(chartPrefs.maLines.v1)에 적고 돌아간다. 저장하지 않고 나가면 아무것도 적지 않는다
 *  - 저장값이 늦게 읽히면 손대기 전일 때만 입력칸을 저장값으로 채운다
 */
const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  const waiting: (() => void)[] = [];
  return {
    flags: {} as Record<string, boolean | undefined>,
    dark: false,
    /** 글자 배율 (useFontScale) */
    scale: 1,
    /** 가짜 기기 저장소 — 모듈을 새로 불러도 남는다 */
    store,
    sets: [] as [string, string][],
    hold: false,
    waiting,
    release() {
      for (const f of waiting.splice(0)) f();
    },
    canGoBack: true,
    back: vi.fn(),
    dismissTo: vi.fn(),
    push: vi.fn(),
  };
});

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: 475, height: 751, fontScale: h.scale }),
}));
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("expo-router", () => ({ router: { push: h.push, back: h.back, canGoBack: () => h.canGoBack, dismissTo: h.dismissTo } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => {
      const v = h.store.get(k) ?? null;
      if (!h.hold) return Promise.resolve(v);
      return new Promise<string | null>((res) => h.waiting.push(() => res(v)));
    },
    setItem: async (k: string, v: string) => {
      h.sets.push([k, v]);
      h.store.set(k, v);
    },
    removeItem: async (k: string) => void h.store.delete(k),
  },
}));
vi.mock("@/api/hooks", () => ({ useFeature: (key: string, fallback = false) => h.flags[key] ?? fallback }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => (h.dark ? tokens.dark : tokens.light), useFontScale: (cap = Infinity) => Math.min(Math.max(h.scale, 1), cap) };
});
vi.mock("@/components/Screen", () => ({ Screen: "Screen" }));
vi.mock("@/components/RouteError", () => ({ RouteErrorBoundary: "RouteErrorBoundary" }));
vi.mock("@/components/ui", () => ({ Button: "Button", Card: "Card", Empty: "Empty", Muted: "Muted", Toggle: "Toggle" }));

const { fontCap, foldScreens, space, touch } = await import("@/tokens");

const KEY = "chartPrefs.maLines.v1";
const RANGE = "2~240 사이의 정수를 적어 주세요";
const taken = (n: number) => `이미 선 ${n}의 기간입니다`;
const SAVED = [
  { period: 7, color: 6, on: true },
  { period: 10, color: 1, on: true },
  { period: 20, color: 2, on: true },
  { period: 60, color: 3, on: true },
  { period: 120, color: 4, on: false },
  { period: 240, color: 7, on: false },
];
const LIGHT_NAMES = ["초록", "청록", "올리브", "자주", "보라", "회색", "갈색", "분홍"];

/** 화면을 연다: 모듈을 새로 불러(차트 설정 캐시 비움 — 저장소는 그대로) 새 렌더러로 그리고 저장소 읽기가 끝나기를 기다린다 */
async function open() {
  vi.resetModules();
  const R = await import("react");
  const mr = await import("./miniRender");
  const { default: ChartLinesScreen } = await import("@/app/chart-lines");
  const r = mr.render(R.createElement(ChartLinesScreen));
  await settle(r);
  return r;
}
type Opened = Awaited<ReturnType<typeof open>>;
async function settle(r: { rerender: () => void }) {
  await new Promise((res) => setTimeout(res, 0));
  await new Promise((res) => setTimeout(res, 0));
  r.rerender();
}
const flat = (n: HostNode): Record<string, unknown> => Object.assign({}, ...[n.props.style].flat(Infinity).filter(Boolean));
const type = (r: Opened, slot: number, text: string) => r.act(() => (r.byLabel(`선 ${slot} 기간`).props.onChangeText as (v: string) => void)(text));
const texts = (r: Opened) => [1, 2, 3, 4, 5, 6].map((i) => r.byLabel(`선 ${i} 기간`).props.value);
const ons = (r: Opened) => [1, 2, 3, 4, 5, 6].map((i) => r.byLabel(`선 ${i} 보이기`).props.value);
/** 선마다 고른 색 번호 (checked 인 색 단추) */
const picked = (r: Opened, names = LIGHT_NAMES) =>
  [1, 2, 3, 4, 5, 6].map((i) => names.findIndex((c) => (r.byLabel(`선 ${i} 색 ${c}`).props.accessibilityState as { checked: boolean }).checked));
/** 선 칸 6개 (위 구분선이 있는 View) */
const slots = (r: Opened) => r.all().filter((n) => n.type === "View" && flat(n).borderTopWidth !== undefined);
/** 칸마다 오류 글 (없으면 null) */
const errorsOf = (r: Opened) =>
  slots(r).map((s) => {
    const e = r.all(s.children).filter((n) => n.type === "Text" && n.props.accessibilityRole === "alert");
    return e.length ? e.map((n) => n.children.join("")).join(" / ") : null;
  });
const button = (r: Opened, title: string) => r.all().find((n) => n.type === "Button" && n.props.title === title)!;
const tap = (r: Opened, title: string) => r.act(() => (button(r, title).props.onPress as () => void)());
const saved = () => JSON.parse(h.store.get(KEY) ?? "null") as typeof SAVED | null;

beforeEach(() => {
  h.flags = { maCustom: true };
  h.dark = false;
  h.scale = 1;
  h.store.clear();
  h.sets.length = 0;
  h.hold = false;
  h.waiting.length = 0;
  h.canGoBack = true;
  h.back.mockClear();
  h.dismissTo.mockClear();
  h.push.mockClear();
});

describe("끔", () => {
  it("플래그 없음·꺼짐: '지금은 이동평균선 설정을 쓸 수 없습니다' 안내 하나, '설정 열기' 없음, 입력칸 없음", async () => {
    for (const flags of [{}, { maCustom: false }]) {
      h.flags = flags;
      const r = await open();
      const empty = r.all().filter((n) => n.type === "Empty");
      expect(empty).toHaveLength(1);
      expect(empty[0]!.props).toMatchObject({ title: "지금은 이동평균선 설정을 쓸 수 없습니다", hint: "차트 아래 이동평균 칩(5·10·20·60·120·200)으로 켜고 끌 수 있습니다." });
      expect(empty[0]!.props.action).toBeUndefined();
      expect(r.all().some((n) => n.type === "Button")).toBe(false);
      expect(r.all().some((n) => n.type === "TextInput")).toBe(false);
    }
  });
});

describe("켬 — 처음 모습", () => {
  it("입력칸 6개(5…200) · 스위치 6개(켜짐 = 지금 켠 기간) · 색 단추 48개(라이트 이름), 선마다 처음 색이 checked", async () => {
    const r = await open();
    expect(r.all().filter((n) => n.type === "TextInput")).toHaveLength(6);
    expect(texts(r)).toEqual(["5", "10", "20", "60", "120", "200"]);
    expect(r.all().filter((n) => n.type === "Toggle")).toHaveLength(6);
    expect(ons(r)).toEqual([true, false, true, true, true, false]);
    const radios = r.all().filter((n) => n.type === "Pressable" && n.props.accessibilityRole === "radio");
    expect(radios).toHaveLength(48);
    expect(radios.slice(0, 8).map((n) => n.props.accessibilityLabel)).toEqual(LIGHT_NAMES.map((c) => `선 1 색 ${c}`));
    expect(picked(r)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(errorsOf(r)).toEqual([null, null, null, null, null, null]);
    expect(button(r, "저장").props.disabled).toBe(false);
    expect(r.text()).toContain("선 6개의 기간과 색을 정합니다. 기간은 2~240 — 일봉은 일, 주봉은 주, 월봉은 달, 분봉은 봉 수입니다. 저장하면 종목·지수 상세와 전체 화면 차트에 같이 쓰이고 이 기기에 남습니다.");
    expect(r.text()).toContain("처음 값으로는 기간·색만 되돌립니다(켜고 끈 것은 그대로). 저장하지 않고 나가면 바꾼 것은 버립니다.");
    expect(button(r, "처음 값으로").props.variant).toBe("secondary");
  });

  it("저장된 선이 있으면 그 값", async () => {
    h.store.set(KEY, JSON.stringify(SAVED));
    const r = await open();
    expect(texts(r)).toEqual(["7", "10", "20", "60", "120", "240"]);
    expect(ons(r)).toEqual([true, true, true, true, false, false]);
    expect(picked(r)).toEqual([6, 1, 2, 3, 4, 7]);
  });

  it("다크 테마: 색 단추 이름이 다크 이름 (선 2 의 처음 색 '하늘')", async () => {
    h.dark = true;
    const r = await open();
    const names = ["초록", "하늘", "주황", "자홍", "보라", "회색", "갈색", "분홍"];
    expect((r.byLabel("선 2 색 하늘").props.accessibilityState as { checked: boolean }).checked).toBe(true);
    expect(r.has("선 1 색 하늘")).toBe(true);
    expect(r.has("선 1 색 청록")).toBe(false);
    expect(picked(r, names)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("입력 · 오류 (기간은 입력칸 글자가 원본)", () => {
  it("선 1 에 7 → 오류 없음. 빈칸 · 1 · 241 · 7.5 → 범위 오류", async () => {
    const r = await open();
    type(r, 1, "7");
    expect(errorsOf(r)).toEqual([null, null, null, null, null, null]);
    for (const bad of ["", "1", "241", "7.5"]) {
      type(r, 1, bad);
      expect(errorsOf(r), bad).toEqual([RANGE, null, null, null, null, null]);
      expect(button(r, "저장").props.disabled, bad).toBe(true);
    }
  });

  it("겹침 → 풀림 → 저장: 선 2 에 20 이면 선 2·3 모두 오류·저장 막힘, 선 3 을 30 으로 고치면 오류 0 · 저장값 = 보이는 값", async () => {
    const r = await open();
    type(r, 2, "20");
    expect(errorsOf(r)).toEqual([null, taken(3), taken(2), null, null, null]);
    expect(button(r, "저장").props.disabled).toBe(true);
    // 막힌 채 눌러도 적지 않는다
    tap(r, "저장");
    expect(h.sets).toEqual([]);
    type(r, 3, "30");
    expect(errorsOf(r)).toEqual([null, null, null, null, null, null]);
    expect(r.all().filter((n) => n.type === "Text" && n.props.accessibilityRole === "alert")).toHaveLength(0);
    expect(button(r, "저장").props.disabled).toBe(false);
    tap(r, "저장");
    expect(saved()!.map((l) => l.period)).toEqual([5, 20, 30, 60, 120, 200]);
    expect(saved()!.map((l) => String(l.period))).toEqual(texts(r));
  });

  it("맞바꾸기: 선 1 = 10 이면 선 1·2 오류, 이어서 선 2 = 5 면 오류 0, 저장 → [10, 5, 20, 60, 120, 200]", async () => {
    const r = await open();
    type(r, 1, "10");
    expect(errorsOf(r)).toEqual([taken(2), taken(1), null, null, null, null]);
    type(r, 2, "5");
    expect(errorsOf(r)).toEqual([null, null, null, null, null, null]);
    tap(r, "저장");
    expect(saved()!.map((l) => l.period)).toEqual([10, 5, 20, 60, 120, 200]);
  });

  it("오류 글이 지금 글자를 가리킨다: 선 2 = 20 뒤 선 3 = 60 → 선 2 오류 없음, 선 3·4 서로", async () => {
    const r = await open();
    type(r, 2, "20");
    type(r, 3, "60");
    expect(errorsOf(r)).toEqual([null, null, taken(4), taken(3), null, null]);
  });

  it("오류 화면 읽기: 오류 글은 alert · polite, 그 칸 입력칸 힌트 = 오류 글, 오류 없는 칸은 힌트 없음, 이름표는 늘 '선 N 기간'", async () => {
    const r = await open();
    type(r, 2, "20");
    const alerts = r.all().filter((n) => n.type === "Text" && n.props.accessibilityRole === "alert");
    expect(alerts).toHaveLength(2);
    for (const a of alerts) expect(a.props.accessibilityLiveRegion).toBe("polite");
    expect(r.byLabel("선 2 기간").props.accessibilityHint).toBe(taken(3));
    expect(r.byLabel("선 3 기간").props.accessibilityHint).toBe(taken(2));
    for (const i of [1, 4, 5, 6]) expect("accessibilityHint" in r.byLabel(`선 ${i} 기간`).props, String(i)).toBe(false);
    // 오류 칸 테두리는 오류색
    const { light } = await import("@/tokens");
    expect(flat(r.byLabel("선 2 기간")).borderColor).toBe(light.danger);
    expect(flat(r.byLabel("선 1 기간")).borderColor).toBe(light.line);
  });
});

describe("색 · 스위치 · 처음 값으로", () => {
  it("색·스위치·기간을 바꾸고 '처음 값으로' → 기간·색은 처음 값, 스위치는 바꾼 그대로, 오류 없음", async () => {
    const r = await open();
    r.act(() => (r.byLabel("선 1 색 갈색").props.onPress as () => void)());
    r.act(() => (r.byLabel("선 6 색 분홍").props.onPress as () => void)());
    expect(picked(r)).toEqual([6, 1, 2, 3, 4, 7]);
    r.act(() => (r.byLabel("선 2 보이기").props.onValueChange as (v: boolean) => void)(true));
    r.act(() => (r.byLabel("선 1 보이기").props.onValueChange as (v: boolean) => void)(false));
    type(r, 2, "20");
    expect(errorsOf(r)).toEqual([null, taken(3), taken(2), null, null, null]);
    tap(r, "처음 값으로");
    expect(texts(r)).toEqual(["5", "10", "20", "60", "120", "200"]);
    expect(picked(r)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ons(r)).toEqual([false, true, true, true, true, false]);
    expect(errorsOf(r)).toEqual([null, null, null, null, null, null]);
    // 처음 값으로는 저장하지 않는다
    expect(h.sets).toEqual([]);
  });
});

describe("저장 · 나가기", () => {
  it("저장 → 저장소에 초안과 같은 JSON, 뒤로 (canGoBack 거짓이면 dismissTo('/'))", async () => {
    const r = await open();
    type(r, 1, "7");
    r.act(() => (r.byLabel("선 1 색 갈색").props.onPress as () => void)());
    type(r, 6, "240");
    r.act(() => (r.byLabel("선 6 색 분홍").props.onPress as () => void)());
    r.act(() => (r.byLabel("선 6 보이기").props.onValueChange as (v: boolean) => void)(true));
    tap(r, "저장");
    expect(saved()).toEqual([
      { period: 7, color: 6, on: true },
      { period: 10, color: 1, on: false },
      { period: 20, color: 2, on: true },
      { period: 60, color: 3, on: true },
      { period: 120, color: 4, on: true },
      { period: 240, color: 7, on: true },
    ]);
    expect(h.sets.map(([k]) => k)).toEqual([KEY]);
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(h.dismissTo).not.toHaveBeenCalled();

    h.canGoBack = false;
    const again = await open();
    // 다시 열면(모듈 새로) 저장한 값
    expect(texts(again)).toEqual(["7", "10", "20", "60", "120", "240"]);
    tap(again, "저장");
    expect(h.dismissTo).toHaveBeenCalledWith("/");
  });

  it("저장하지 않고 화면을 내리면 저장소 쓰기 0번", async () => {
    const r = await open();
    type(r, 1, "7");
    r.act(() => (r.byLabel("선 3 색 분홍").props.onPress as () => void)());
    r.unmount();
    expect(h.sets).toEqual([]);
    expect(h.store.has(KEY)).toBe(false);
  });
});

describe("저장소가 늦게 답할 때", () => {
  it("손대기 전에 답하면 입력칸이 저장값으로 바뀐다", async () => {
    h.store.set(KEY, JSON.stringify(SAVED));
    h.hold = true;
    const r = await open();
    expect(texts(r)).toEqual(["5", "10", "20", "60", "120", "200"]);
    h.release();
    await settle(r);
    expect(texts(r)).toEqual(["7", "10", "20", "60", "120", "240"]);
    expect(picked(r)).toEqual([6, 1, 2, 3, 4, 7]);
  });

  it("손댄 뒤에 답하면 손댄 값 그대로", async () => {
    h.store.set(KEY, JSON.stringify(SAVED));
    h.hold = true;
    const r = await open();
    type(r, 3, "30");
    h.release();
    await settle(r);
    expect(texts(r)).toEqual(["5", "10", "30", "60", "120", "200"]);
    expect(picked(r)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("크기 (누르는 크기 · 큰 글씨 · 펼친 화면)", () => {
  it("입력칸 폭 = 64 × 글자 배율(140% 까지): 100% 64 · 130% 83 · 200% 90, 글자 확대 상한 fontCap.row", async () => {
    for (const [scale, w] of [[1, 64], [1.3, 83], [2, 90]] as const) {
      h.scale = scale;
      const r = await open();
      for (let i = 1; i <= 6; i++) {
        const input = r.byLabel(`선 ${i} 기간`);
        expect(flat(input).width, `${scale}`).toBe(w);
        expect(flat(input).minHeight).toBe(touch.min);
        expect(input.props.maxFontSizeMultiplier).toBe(fontCap.row);
        expect(input.props).toMatchObject({ keyboardType: "number-pad", maxLength: 3 });
      }
    }
  });

  it("색 단추: 44×44 (width·minHeight = touch.min), hitSlop 없음, 선마다 줄 2개에 4개씩", async () => {
    const r = await open();
    const radios = r.all().filter((n) => n.type === "Pressable" && n.props.accessibilityRole === "radio");
    for (const b of radios) {
      expect(flat(b)).toMatchObject({ width: touch.min, minHeight: touch.min });
      expect(b.props.hitSlop).toBeUndefined();
    }
    for (const s of slots(r)) {
      const rows = r.all(s.children).filter((n) => n.type === "View" && n.children.some((c) => typeof c !== "string" && c.props.accessibilityRole === "radio"));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.children.filter((c) => typeof c !== "string" && c.type === "Pressable")).toHaveLength(4);
        expect(flat(row)).toMatchObject({ flexDirection: "row", gap: space.xs });
      }
    }
  });

  it("내용 틀: 최대 폭 400(settingsColMax) 가운데, 선 첫 줄은 줄바꿈 없이 최소 높이 44", async () => {
    const r = await open();
    const column = r.all().find((n) => n.type === "View" && flat(n).maxWidth !== undefined)!;
    expect(flat(column)).toMatchObject({ width: "100%", maxWidth: foldScreens.settingsColMax, alignSelf: "center" });
    expect(foldScreens.settingsColMax).toBe(400);
    for (let i = 1; i <= 6; i++) {
      const head = r.all().find((n) => n.type === "View" && n.children.some((c) => typeof c !== "string" && c.props.accessibilityLabel === `선 ${i} 기간`))!;
      expect(flat(head)).toMatchObject({ flexDirection: "row", alignItems: "center", minHeight: touch.min });
      expect(flat(head).flexWrap).toBeUndefined();
    }
  });
});
