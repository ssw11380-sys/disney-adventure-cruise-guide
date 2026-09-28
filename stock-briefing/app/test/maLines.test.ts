import { describe, expect, it } from "vitest";
import { defaultMaLines, draftOf, drawnMa, linesOfDraft, maColorName, maLinesOf, parsePeriod, periodErrors, resetDraft, withOn, type MaLine } from "@/lib/maLines";

/**
 * 이동평균선 선 6개 순수 함수 (3-39 PR 2, 기능 플래그 maCustom — lib/maLines).
 *  - 처음 선 = 지금 칩(5·10·20·60·120·200 · 색 0~5 · 지금 켠 기간)
 *  - 저장값 검사는 통째로 (하나라도 틀리면 처음 선)
 *  - 새 화면의 초안: 기간은 입력칸 글자가 원본 — 오류·저장할 기간을 늘 지금 글자로 계산 (겹친 두 칸 모두 오류, 맞바꾸기 가능)
 */
const RANGE = "2~240 사이의 정수를 적어 주세요";
const taken = (n: number) => `이미 선 ${n}의 기간입니다`;
const START = ["5", "10", "20", "60", "120", "200"];
const line = (period: number, color: number, on: boolean): MaLine => ({ period, color, on });

describe("처음 선 (defaultMaLines)", () => {
  it("지금 처음 값 maPeriods [5, 20, 60, 120] → 기간 5·10·20·60·120·200, 색 0~5, 켜짐 = 그 기간이 있는지", () => {
    const l = defaultMaLines([5, 20, 60, 120]);
    expect(l.map((x) => x.period)).toEqual([5, 10, 20, 60, 120, 200]);
    expect(l.map((x) => x.color)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(l.map((x) => x.on)).toEqual([true, false, true, true, true, false]);
  });

  it("칩을 다 끈 maPeriods [] 면 모두 꺼짐, 여섯 모두면 모두 켜짐", () => {
    expect(defaultMaLines([]).every((x) => !x.on)).toBe(true);
    expect(defaultMaLines([5, 10, 20, 60, 120, 200]).every((x) => x.on)).toBe(true);
  });
});

describe("저장값 검사 (maLinesOf)", () => {
  const good = [line(7, 6, true), line(10, 1, true), line(20, 2, false), line(60, 3, true), line(120, 4, false), line(240, 7, false)];

  it("맞는 값 → 같은 값", () => {
    expect(maLinesOf(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("틀린 값은 통째로 null (부분 고치기 없음)", () => {
    const bad = (i: number, patch: Record<string, unknown>) => good.map((l, j) => (j === i ? { ...l, ...patch } : l));
    const cases: unknown[] = [
      null,
      undefined,
      "x",
      { length: 6 },
      good.slice(0, 5),
      [...good, line(30, 0, true)],
      bad(0, { period: 1 }),
      bad(0, { period: 241 }),
      bad(0, { period: 7.5 }),
      bad(0, { period: "7" }),
      bad(2, { color: 8 }),
      bad(2, { color: -1 }),
      bad(2, { color: 1.5 }),
      bad(3, { on: 1 }),
      bad(3, { on: undefined }),
      bad(1, { period: 7 }), // 같은 기간 두 칸 (선 1 · 선 2 모두 7)
      [null, ...good.slice(1)],
    ];
    for (const c of cases) expect(maLinesOf(c), JSON.stringify(c)).toBeNull();
  });
});

describe("기간 글자 읽기 (parsePeriod)", () => {
  it("앞뒤 공백을 지운 1~3자리 숫자이고 2~240 이면 그 수", () => {
    expect(parsePeriod("7")).toBe(7);
    expect(parsePeriod(" 7 ")).toBe(7);
    expect(parsePeriod("240")).toBe(240);
    expect(parsePeriod("2")).toBe(2);
    expect(parsePeriod("007")).toBe(7);
  });

  it("그 밖은 null", () => {
    for (const s of ["", " ", "1", "241", "7.5", "-3", "abc", "1000", "1e2", "0", "+7", "7일"]) expect(parsePeriod(s), s).toBeNull();
  });
});

describe("칸마다 오류 (periodErrors) — 늘 지금 글자 6개로만", () => {
  it("처음 글자 → 모두 null", () => {
    expect(periodErrors(START)).toEqual([null, null, null, null, null, null]);
  });

  it("선 2 에 20 → 선 2·3 모두 오류 (서로를 가리킴)", () => {
    expect(periodErrors(["5", "20", "20", "60", "120", "200"])).toEqual([null, taken(3), taken(2), null, null, null]);
  });

  it("맞바꾸기 (선 1 = 10 · 선 2 = 5) → 오류 없음", () => {
    expect(periodErrors(["10", "5", "20", "60", "120", "200"])).toEqual([null, null, null, null, null, null]);
  });

  it("오류 글의 '선 N' 은 지금 글자 기준 (선 2 20 뒤 선 3 60 → 선 3·4 겹침, 선 2 는 오류 없음)", () => {
    const e = periodErrors(["5", "20", "60", "60", "120", "200"]);
    expect(e[1]).toBeNull();
    expect(e[2]).toBe(taken(4));
    expect(e[3]).toBe(taken(3));
  });

  it("셋이 겹치면 첫 칸 기준 (선 1 → 선 2, 선 2·3 → 선 1)", () => {
    expect(periodErrors(["20", "20", "20", "60", "120", "200"])).toEqual([taken(2), taken(1), taken(1), null, null, null]);
  });

  it("읽지 못한 칸은 범위 오류이고 겹침 비교에서 뺀다", () => {
    expect(periodErrors(["5", "", "20", "60", "120", "200"])).toEqual([null, RANGE, null, null, null, null]);
    for (const bad of ["1", "241", "7.5"]) expect(periodErrors(["5", bad, "20", "60", "120", "200"]), bad).toEqual([null, RANGE, null, null, null, null]);
    // 두 칸 모두 읽지 못하면 둘 다 범위 오류 (서로 겹침으로 보지 않음)
    expect(periodErrors(["", "", "20", "60", "120", "200"])).toEqual([RANGE, RANGE, null, null, null, null]);
  });
});

describe("초안 (draftOf · linesOfDraft · resetDraft)", () => {
  const saved = [line(7, 6, true), line(10, 1, true), line(20, 2, false), line(60, 3, true), line(120, 4, false), line(240, 7, false)];

  it("draftOf → texts 가 String(기간), 색·보이기 그대로", () => {
    expect(draftOf(saved)).toEqual({ texts: ["7", "10", "20", "60", "120", "240"], colors: [6, 1, 2, 3, 4, 7], ons: [true, true, false, true, false, false] });
  });

  it("linesOfDraft: 오류가 있으면 null, 없으면 기간 = 글자 값(' 7 ' → 7), 색·보이기 = 초안", () => {
    const d = draftOf(saved);
    expect(linesOfDraft({ ...d, texts: ["7", "7", "20", "60", "120", "240"] })).toBeNull();
    expect(linesOfDraft({ ...d, texts: ["", "10", "20", "60", "120", "240"] })).toBeNull();
    expect(linesOfDraft({ ...d, texts: [" 7 ", "10", "20", "60", "120", "240"] })).toEqual(saved);
    // 맞바꾸기
    expect(linesOfDraft({ ...draftOf(defaultMaLines([5])), texts: ["10", "5", "20", "60", "120", "200"] })!.map((l) => l.period)).toEqual([10, 5, 20, 60, 120, 200]);
  });

  it("resetDraft: 글자 처음 기간, 색 0~5, 보이기는 그대로 — 받은 초안은 바꾸지 않는다", () => {
    const d = draftOf(saved);
    const before = JSON.stringify(d);
    const r = resetDraft(d);
    expect(r).toEqual({ texts: START, colors: [0, 1, 2, 3, 4, 5], ons: [true, true, false, true, false, false] });
    expect(periodErrors(r.texts).every((e) => e === null)).toBe(true);
    expect(JSON.stringify(d)).toBe(before);
    expect(r.ons).not.toBe(d.ons);
  });
});

describe("칩 켜고 끄기 (withOn)", () => {
  it("그 칸의 on 만 바꾼 새 배열 — 받은 배열은 그대로", () => {
    const l = defaultMaLines([5, 20, 60, 120]);
    const before = JSON.stringify(l);
    const n = withOn(l, 2, false);
    expect(n.map((x) => x.on)).toEqual([true, false, false, true, true, false]);
    expect(n).not.toBe(l);
    expect(JSON.stringify(l)).toBe(before);
    // 바꾸지 않은 칸은 같은 값
    expect(n[0]).toBe(l[0]);
  });
});

describe("차트에 그릴 것 (drawnMa)", () => {
  const P = ["#p0", "#p1", "#p2", "#p3", "#p4", "#p5", "#p6", "#p7"];

  it("켠 선만, 기간 작은 순 (선 차례와 달라도), colors 는 켠 선의 기간만 키로", () => {
    const l = [line(60, 6, true), line(10, 1, false), line(7, 7, true), line(20, 2, true), line(120, 4, false), line(3, 0, true)];
    const d = drawnMa(l, P);
    expect(d.periods).toEqual([3, 7, 20, 60]);
    expect(d.colors).toEqual({ 3: "#p0", 7: "#p7", 20: "#p2", 60: "#p6" });
  });

  it("처음 선 · maPeriods [5, 20, 60, 120] → 키는 정확히 5·20·60·120 (끈 10·200 없음)", () => {
    const d = drawnMa(defaultMaLines([5, 20, 60, 120]), P);
    expect(d.periods).toEqual([5, 20, 60, 120]);
    expect(d.colors).toEqual({ 5: "#p0", 20: "#p2", 60: "#p3", 120: "#p4" });
  });

  it("모두 끄면 빈 목록", () => {
    expect(drawnMa(defaultMaLines([]), P)).toEqual({ periods: [], colors: {} });
  });
});

describe("색 이름 (maColorName)", () => {
  it("다크 · 라이트 각각 0~7", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((k) => maColorName(true, k))).toEqual(["초록", "하늘", "주황", "자홍", "보라", "회색", "갈색", "분홍"]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((k) => maColorName(false, k))).toEqual(["초록", "청록", "올리브", "자주", "보라", "회색", "갈색", "분홍"]);
  });
});
