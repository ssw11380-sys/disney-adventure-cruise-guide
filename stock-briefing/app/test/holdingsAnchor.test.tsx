import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { anchorOffset, forgetHoldingsAnchor, holdingsAnchorMemory, holdingsLayoutKey, topAnchor, useHoldingsAnchor, type HoldingsAnchor, type RowPos } from "@/lib/holdingsAnchor";
import { render } from "./miniRender";

/**
 * 접고 펼 때 잔고 스크롤 이어 보기 (3-42 웨이브 B, lib/holdingsAnchor).
 * 휴대폰 줄(58)과 넓은 표 줄(44)은 높이가 달라 스크롤 위치로는 같은 자리를 찾을 수 없다 → 맨 위 종목 코드로 다시 맞춘다
 */
const rows = (h: number, start: number, codes: string[], section = "held"): RowPos[] => codes.map((code, i) => ({ code, section, y: start + i * h, h }));
const CODES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

beforeEach(() => forgetHoldingsAnchor());

describe("맨 위 종목 고르기 (topAnchor)", () => {
  // 휴대폰: 계좌 칸 등 머리 400 아래에 구역 머리 66, 줄 58
  const list = rows(58, 466, CODES);
  const heads = { held: { y: 400, h: 66 } };

  it("고정 머리 바로 아래에 반 이상 보이는 첫 줄", () => {
    // 5번째 줄(E, y=698)이 머리(66) 바로 아래에 오도록 내린 위치
    expect(topAnchor(list, heads, 698 - 66)).toBe("E");
    // 반보다 덜 가려졌으면 그 줄, 더 가려졌으면 다음 줄
    expect(topAnchor(list, heads, 698 - 66 + 28)).toBe("E");
    expect(topAnchor(list, heads, 698 - 66 + 30)).toBe("F");
  });

  it("아직 표를 내리지 않았으면(첫 줄이 보임) 맨 위 그대로 → null", () => {
    expect(topAnchor(list, heads, 0)).toBeNull();
    expect(topAnchor(list, heads, 400)).toBeNull();
    expect(topAnchor([], heads, 500)).toBeNull();
  });

  it("끝까지 내렸으면 마지막 줄 · 줄 순서가 뒤섞여 들어와도 위치 순으로", () => {
    expect(topAnchor(list, heads, 99_999)).toBe("J");
    expect(topAnchor([...list].reverse(), heads, 698 - 66)).toBe("E");
  });

  it("다시 맞출 위치: 그 줄이 구역 머리 바로 아래", () => {
    expect(anchorOffset({ code: "E", section: "held", y: 400, h: 44 }, { y: 100, h: 40 })).toBe(360);
    expect(anchorOffset({ code: "A", section: "held", y: 20, h: 44 }, { y: 0, h: 40 })).toBe(0);
    expect(anchorOffset({ code: "A", section: "held", y: 20, h: 44 }, undefined)).toBe(20);
  });
});

describe("이어 보기 훅 (useHoldingsAnchor)", () => {
  const out: { a: HoldingsAnchor | null } = { a: null };
  function Probe({ mode }: { mode: string | null }) {
    out.a = useHoldingsAnchor(mode);
    return null;
  }
  const layout = (y: number, height: number) => ({ nativeEvent: { layout: { x: 0, y, width: 400, height } } }) as never;
  const scroll = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } }) as never;

  it("접힌 화면에서 E 가 맨 위 → 펼치면(표) E 가 머리 바로 아래로 · 다시 접으면 다시 E", () => {
    const r = render(<Probe mode="list" />);
    const scrollTo = vi.fn();
    out.a!.ref.current = { scrollTo } as never;
    out.a!.head("held", layout(400, 66));
    rows(58, 466, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    out.a!.onScroll(scroll(698 - 66));
    expect(holdingsAnchorMemory()).toEqual({ mode: "list", code: "E" });

    // 펼침: 넓은 표는 계좌 띠 52 + 머리 40, 줄 44
    r.rerender(<Probe mode="table-1" />);
    expect(scrollTo).not.toHaveBeenCalled(); // 새 배치의 줄 위치를 아직 모른다
    out.a!.head("held", layout(52, 40));
    rows(44, 92, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 92 + 4 * 44 - 40, animated: false });
    // 맞춘 뒤 스크롤 이벤트가 와도 같은 종목
    out.a!.onScroll(scroll(92 + 4 * 44 - 40));
    expect(holdingsAnchorMemory()).toEqual({ mode: "table-1", code: "E" });

    // 다시 접음
    r.rerender(<Probe mode="list" />);
    out.a!.head("held", layout(400, 66));
    rows(58, 466, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 698 - 66, animated: false });
  });

  it("목록 끝 근처라 넓은 표에서 그 줄을 맨 위로 못 올려도(스크롤이 끝에서 멈춤) 기억은 처음 종목 그대로 → 다시 접으면 그 종목. 사용자가 끌면 다시 기억한다", () => {
    const r = render(<Probe mode="list" />);
    const scrollTo = vi.fn();
    out.a!.ref.current = { scrollTo } as never;
    out.a!.head("held", layout(400, 66));
    rows(58, 466, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    // 휴대폰에서 H 가 맨 위
    out.a!.onScroll(scroll(466 + 7 * 58 - 66));
    expect(holdingsAnchorMemory().code).toBe("H");
    // 펼침: H 로 맞추려 했지만 목록이 짧아 스크롤이 더 앞(E 가 맨 위)에서 멈추고, 그 위치의 스크롤 이벤트가 온다
    r.rerender(<Probe mode="table-2" />);
    out.a!.head("held", layout(96, 44));
    rows(44, 140, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 140 + 7 * 44 - 44, animated: false });
    out.a!.onScroll(scroll(140 + 4 * 44 - 44));
    expect(holdingsAnchorMemory().code).toBe("H");
    // 다시 접으면 H 로
    r.rerender(<Probe mode="list" />);
    out.a!.head("held", layout(400, 66));
    rows(58, 466, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 466 + 7 * 58 - 66, animated: false });
    // 사용자가 직접 끌어 내리면 그때부터 다시 맨 위 종목을 기억한다
    out.a!.onScrollBeginDrag();
    out.a!.onScroll(scroll(466 + 2 * 58 - 66));
    expect(holdingsAnchorMemory().code).toBe("C");
  });

  it("되맞춘 뒤 끌기가 아닌 스크롤(화면 읽기 자동 스크롤·휠·키보드)로도 줄 반 개 넘게 옮기면 다시 기억한다", () => {
    const r = render(<Probe mode="list" />);
    const scrollTo = vi.fn();
    out.a!.ref.current = { scrollTo } as never;
    out.a!.head("held", layout(400, 66));
    rows(58, 466, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    out.a!.onScroll(scroll(466 + 7 * 58 - 66));
    r.rerender(<Probe mode="table-2" />);
    out.a!.head("held", layout(96, 44));
    rows(44, 140, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    // 목록 끝이라 E 가 맨 위인 자리에서 멈춤 → 기억은 H 그대로
    const stop = 140 + 4 * 44 - 44;
    out.a!.onScroll(scroll(stop));
    expect(holdingsAnchorMemory().code).toBe("H");
    // 조금(줄 반 개 이하) 움직인 것은 되맞춘 자리 그대로로 본다
    out.a!.onScroll(scroll(stop - 20));
    expect(holdingsAnchorMemory().code).toBe("H");
    // 끌기(onScrollBeginDrag) 없이 위로 두 줄 옮기면(휠·화면 읽기) C 가 맨 위 → 기억을 바꾼다
    out.a!.onScroll(scroll(140 + 2 * 44 - 44));
    expect(holdingsAnchorMemory()).toEqual({ mode: "table-2", code: "C" });
  });

  it("목록에서 빠진 종목(삭제)의 줄 위치는 버린다 (keep) — 맨 위 종목으로 사라진 종목을 고르지 않는다", () => {
    render(<Probe mode="table-1" />);
    out.a!.head("held", layout(52, 40));
    rows(44, 92, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    // E 를 지웠고, 뒤 줄은 아직 자리를 다시 알리지 않았다 (F 가 E 자리로 올라오는 중)
    out.a!.keep(new Set(CODES.filter((c) => c !== "E")));
    out.a!.row("F", "held", 92 + 4 * 44, 44);
    out.a!.onScroll(scroll(92 + 4 * 44 - 40));
    expect(holdingsAnchorMemory().code).toBe("F");
  });

  it("맨 위였으면(표를 안 내렸으면) 배치가 바뀌어도 맨 위로", () => {
    const r = render(<Probe mode="list" />);
    const scrollTo = vi.fn();
    out.a!.ref.current = { scrollTo } as never;
    out.a!.head("held", layout(400, 66));
    rows(58, 466, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    out.a!.onScroll(scroll(120));
    r.rerender(<Probe mode="table-2" />);
    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: false });
  });

  it("같은 배치 안에서는(창 폭만 바뀜) 맞추지 않는다 · 사용자가 끌면 기다리던 복원을 버린다", () => {
    const r = render(<Probe mode="table-1" />);
    const scrollTo = vi.fn();
    out.a!.ref.current = { scrollTo } as never;
    out.a!.head("held", layout(52, 40));
    rows(44, 92, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    out.a!.onScroll(scroll(300));
    r.rerender(<Probe mode="table-1" />);
    expect(scrollTo).not.toHaveBeenCalled();
    // 배치가 바뀌었는데 그 종목 줄이 오기 전에 사용자가 끌기 시작하면 복원하지 않는다
    r.rerender(<Probe mode="list" />);
    out.a!.onScrollBeginDrag();
    out.a!.head("held", layout(400, 66));
    rows(58, 466, CODES).forEach((p) => out.a!.row(p.code, p.section, p.y, p.h));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("기능이 꺼져 있으면(null) 아무것도 기억하지 않는다 · 돌려주는 함수는 늘 같은 함수 (줄 memo 비교를 깨지 않게)", () => {
    const r = render(<Probe mode={null} />);
    const first = out.a!;
    out.a!.row("A", "held", 0, 58);
    out.a!.onScroll(scroll(500));
    expect(holdingsAnchorMemory()).toEqual({ mode: null, code: null });
    r.rerender(<Probe mode={null} />);
    expect(out.a).toBe(first);
    r.rerender(<Probe mode="list" />);
    expect(out.a!.row).toBe(first.row);
    expect(out.a!.onScroll).toBe(first.onScroll);
  });
});

describe("배치 이름 (holdingsLayoutKey): 줄 위치가 달라질 수 있는 것은 모두 이름에", () => {
  it("휴대폰 목록은 list, 넓은 표는 계좌 띠 줄 수 · 탭 막대 위치 · 열 수", () => {
    expect(holdingsLayoutKey({ wide: false, oneLineBand: false, rail: false, cols: 0 })).toBe("list");
    expect(holdingsLayoutKey({ wide: true, oneLineBand: true, rail: true, cols: 8 })).toBe("table-1-rail-8");
    expect(holdingsLayoutKey({ wide: true, oneLineBand: false, rail: false, cols: 6 })).toBe("table-2-bar-6");
  });

  it("큰 글씨로 펼친 폴드8 을 돌리면(세로 아래 탭 ↔ 가로 세로 막대) 띠가 둘 다 두 줄이어도 이름이 달라 맨 위 종목으로 다시 맞춘다", () => {
    const portrait = holdingsLayoutKey({ wide: true, oneLineBand: false, rail: false, cols: 4 });
    const landscape = holdingsLayoutKey({ wide: true, oneLineBand: false, rail: true, cols: 4 });
    expect(portrait).not.toBe(landscape);
    // 열 수만 달라도 다른 이름
    expect(holdingsLayoutKey({ wide: true, oneLineBand: true, rail: false, cols: 8 })).not.toBe(holdingsLayoutKey({ wide: true, oneLineBand: true, rail: false, cols: 9 }));
  });
});
