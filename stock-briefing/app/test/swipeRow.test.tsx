import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, type HostNode } from "./miniRender";

/**
 * 잔고 줄 스와이프 부품 (3-24 oneHand, components/SwipeRow).
 *  - 제스처: 가로 14dp 에 시작, 그 전에 세로 10dp 면 포기(목록 스크롤), 한 손가락, JS 에서 (차트 드래그와 같은 방식 — 새 네이티브 모듈 없음)
 *  - 끄는 동안 줄이 손가락을 따라가고, 놓으면 40% 기준·튕김으로 열고 닫는다. 시작 조건 14dp 는 이동에 넣지 않는다
 *  - 열리면 버튼(화면 읽기에서는 숨김 — 줄의 동작 메뉴가 같은 일)과 '버튼 닫기' 덮개, 한 번에 한 줄만 열림, 열릴 때 햅틱 한 번
 */
type Call = [string, unknown[]];
type Rec = { kind: string; calls: Call[] };
const h = vi.hoisted(() => ({ values: [] as { v: number; set: number[] }[], timings: [] as { toValue: number }[] }));

vi.mock("react-native", () => {
  class Value {
    v: number;
    set: number[] = [];
    constructor(v: number) {
      this.v = v;
      h.values.push(this);
    }
    setValue(v: number) {
      this.v = v;
      this.set.push(v);
    }
  }
  return {
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, absoluteFill: { position: "absolute" } },
    Platform: { OS: "android" },
    useWindowDimensions: () => ({ width: 475, height: 751, fontScale: 1, scale: 2.625 }),
    Easing: { out: (f: unknown) => f, cubic: () => 0 },
    Animated: {
      Value,
      View: "AnimatedView",
      timing: (v: Value, cfg: { toValue: number }) => ({
        start: (cb?: (r: { finished: boolean }) => void) => {
          h.timings.push(cfg);
          v.v = cfg.toValue;
          cb?.({ finished: true });
        },
      }),
    },
  };
});
vi.mock("react-native-gesture-handler", () => {
  const builder = (kind: string) => {
    const rec: Rec = { kind, calls: [] };
    const proxy: unknown = new Proxy(rec, {
      get: (target, key) => {
        if (key in target) return target[key as keyof Rec];
        if (key === "then") return undefined;
        return (...args: unknown[]) => {
          target.calls.push([String(key), args]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  return { Gesture: { Pan: () => builder("Pan") }, GestureDetector: "GestureDetector" };
});
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});

const { closeOpenRow, SwipeRow } = await import("@/components/SwipeRow");
const { installHaptics, setHapticPolicy } = await import("@/lib/haptics");
const { dark } = await import("@/tokens");

const haptics: string[] = [];
beforeEach(() => {
  h.values.length = 0;
  h.timings.length = 0;
  haptics.length = 0;
  installHaptics({ selectionAsync: async () => void haptics.push("sel"), impactAsync: async () => undefined, notificationAsync: async () => undefined }, "ios");
  setHapticPolicy({ oneHand: true, user: true });
});

const edit = vi.fn();
const del = vi.fn();
const actions = () => [
  { key: "edit", label: "수정", icon: "create-outline" as const, onPress: edit },
  { key: "remove", label: "동기화 제외", icon: "remove-circle-outline" as const, danger: true, onPress: del },
];
const row = (label = "줄") => (
  <SwipeRow actions={actions()}>
    <View accessibilityLabel={label} />
  </SwipeRow>
);
const View = "View" as unknown as React.ComponentType<Record<string, unknown>>;
const pan = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "GestureDetector")!.props.gesture as Rec;
const handler = (g: Rec, name: string) => g.calls.find(([k]) => k === name)![1][0] as (e: { translationX: number; velocityX?: number }) => void;
const flush = () => new Promise((res) => setTimeout(res, 0));

describe("제스처 설정: 세로 스크롤과 다투지 않는다 (차트 드래그와 같은 기준)", () => {
  it("가로 14dp 에 시작 · 세로 10dp 면 포기 · 한 손가락 · JS 에서", () => {
    const r = render(row());
    const g = pan(r);
    expect(g.kind).toBe("Pan");
    const of = (name: string) => g.calls.filter(([k]) => k === name).map(([, a]) => a);
    // 닫힌 줄은 왼쪽으로 밀 때만 잡는다 (오른쪽으로 밀면 할 일이 없어 줄 누르기가 그대로)
    expect(of("activeOffsetX")).toEqual([[[-14, 100_000]]]);
    // 열린 줄은 양쪽 (오른쪽으로 밀어 닫는다)
    r.act(() => handler(g, "onStart")({ translationX: -14 }));
    r.act(() => handler(g, "onEnd")({ translationX: -120, velocityX: 0 }));
    const opened = pan(r);
    expect(opened.calls.filter(([k]) => k === "activeOffsetX").map(([, a]) => a)).toEqual([[[-14, 14]]]);
    expect(of("failOffsetY")).toEqual([[[-10, 10]]]);
    expect(of("maxPointers")).toEqual([[1]]);
    expect(of("runOnJS")).toEqual([[true]]);
    // 어느 쪽 움직임이든 시작시키는 minDistance·세로 시작 조건은 없다
    expect(of("minDistance")).toEqual([]);
    expect(of("activeOffsetY")).toEqual([]);
  });
});

describe("끌고 놓기", () => {
  it("줄이 손가락을 따라가고(시작 조건 14dp 는 빼고), 40% 넘게 밀고 놓으면 열림 → 버튼·닫기 덮개·햅틱 한 번", async () => {
    const r = render(row());
    const g = pan(r);
    const x = h.values[0]!;
    expect(r.has("수정")).toBe(false);
    r.act(() => handler(g, "onStart")({ translationX: -14 }));
    r.act(() => handler(g, "onUpdate")({ translationX: -64 }));
    expect(x.set.at(-1)).toBe(-50);
    r.act(() => handler(g, "onUpdate")({ translationX: -400 }));
    expect(x.set.at(-1)).toBe(-144);
    r.act(() => handler(g, "onEnd")({ translationX: -84, velocityX: 0 }));
    expect(h.timings.at(-1)).toMatchObject({ toValue: -144 });
    await flush();
    expect(haptics).toEqual(["sel"]);
    // 버튼: 청록 수정 · 경고색 동기화 제외, 화면 읽기에서는 숨김
    const panel = r.all().find((n) => n.type === "View" && n.props.accessibilityElementsHidden === true)!;
    expect(panel.props.importantForAccessibility).toBe("no-hide-descendants");
    const buttons = r.all().filter((n) => n.type === "Pressable" && (n.props.accessibilityLabel === "수정" || n.props.accessibilityLabel === "동기화 제외"));
    const bg = (n: HostNode) => (typeof n.props.style === "function" ? (n.props.style as (s: { pressed: boolean }) => unknown[])({ pressed: false }) : []).map((s) => (s as { backgroundColor?: string }).backgroundColor).filter(Boolean);
    expect(buttons.map(bg)).toEqual([[dark.accent], [dark.danger]]);
    expect(r.has("버튼 닫기")).toBe(true);
    // 버튼을 누르면 닫고 그 일을 한다
    r.act(() => (buttons[1]!.props.onPress as () => void)());
    expect(del).toHaveBeenCalledTimes(1);
    expect(h.timings.at(-1)).toMatchObject({ toValue: 0 });
    expect(r.has("버튼 닫기")).toBe(false);
  });

  it("조금만 밀고 놓으면 제자리 (햅틱 없음), 빠르게 튕기면 열림", async () => {
    const r = render(row());
    const g = pan(r);
    r.act(() => handler(g, "onStart")({ translationX: -14 }));
    r.act(() => handler(g, "onEnd")({ translationX: -60, velocityX: 0 }));
    expect(h.timings.at(-1)).toMatchObject({ toValue: 0 });
    r.act(() => handler(g, "onStart")({ translationX: -14 }));
    r.act(() => handler(g, "onEnd")({ translationX: -30, velocityX: -900 }));
    expect(h.timings.at(-1)).toMatchObject({ toValue: -144 });
    await flush();
    expect(haptics).toEqual(["sel"]);
  });

  it("열린 줄을 누르면 닫힌다 (상세를 열지 않음). 다른 줄을 열면 앞 줄은 닫힌다", () => {
    const a = render(row("가"));
    const b = render(row("나"));
    const ga = pan(a);
    const gb = pan(b);
    a.act(() => handler(ga, "onStart")({ translationX: -14 }));
    a.act(() => handler(ga, "onEnd")({ translationX: -120, velocityX: 0 }));
    expect(a.has("버튼 닫기")).toBe(true);
    b.act(() => handler(gb, "onStart")({ translationX: -14 }));
    b.act(() => handler(gb, "onEnd")({ translationX: -120, velocityX: 0 }));
    a.rerender();
    expect(a.has("버튼 닫기")).toBe(false);
    expect(b.has("버튼 닫기")).toBe(true);
    b.act(() => (b.byLabel("버튼 닫기").props.onPress as () => void)());
    expect(b.has("버튼 닫기")).toBe(false);
  });

  it("햅틱을 끄면(설정) 열려도 울리지 않는다", async () => {
    setHapticPolicy({ oneHand: true, user: false });
    const r = render(row());
    const g = pan(r);
    r.act(() => handler(g, "onStart")({ translationX: -14 }));
    r.act(() => handler(g, "onEnd")({ translationX: -120, velocityX: 0 }));
    await flush();
    expect(haptics).toEqual([]);
  });
});

describe("closeOpenRow: 잔고 화면이 목록 끌기·다른 줄 누르기·정렬·새로고침 때 부른다", () => {
  it("열린 줄이 없으면 false, 있으면 닫고 true", () => {
    // 앞 테스트에서 열어 둔 줄을 먼저 닫는다 (한 번에 한 줄 — 모듈이 기억한다)
    closeOpenRow();
    const r = render(row());
    expect(closeOpenRow()).toBe(false);
    const g = pan(r);
    r.act(() => handler(g, "onStart")({ translationX: -14 }));
    r.act(() => handler(g, "onEnd")({ translationX: -120, velocityX: 0 }));
    expect(r.has("버튼 닫기")).toBe(true);
    let closed = false;
    r.act(() => {
      closed = closeOpenRow();
    });
    expect(closed).toBe(true);
    expect(r.has("버튼 닫기")).toBe(false);
    expect(h.timings.at(-1)).toMatchObject({ toValue: 0 });
    expect(closeOpenRow()).toBe(false);
  });
});
