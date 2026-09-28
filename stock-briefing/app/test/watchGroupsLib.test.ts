import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RegisteredWithQuote } from "@/api/types";
import { sortHoldings, splitHoldings } from "@/lib/portfolio";
import { dragShift, dragTarget } from "@/lib/watchDrag";
import {
  applyOp,
  applyToLayout,
  deleteGroupMessage,
  groupHeadSpeech,
  groupNameCheck,
  movedSpeech,
  movedToGroupSpeech,
  nameLength,
  normalizeView,
  objectParticle,
  parseWatchView,
  posLine,
  saveFailText,
  selectChip,
  serializeWatchView,
  toggleFold,
  VIEW_DEFAULT,
  visibleWatch,
  watchChips,
  watchEntries,
  watchModel,
  watchOrder,
  WATCH_GROUP_LIMIT,
  type OrderStock,
  type WatchGroup,
  type WatchLayout,
  type WatchOp,
} from "@/lib/watchGroups";
import { holding, quote } from "./helpers";

/**
 * 관심 종목 그룹·순서 순수 함수 (3-34, 플래그 watchGroups): 서버와 같은 순서·이름 규칙(공용 픽스처), 잔고 관심 칸 줄(전체·그룹·그룹 없음·접힘·빈 그룹·
 * 그룹 0개 = 지금 순서), 칩(그룹 없음 0 숨김), 정렬과의 관계(등록순 = 내 순서, 등락률 = 그룹 안에서), 기기 저장값, 끌기 목표 칸, 글
 */
const orderFx = JSON.parse(readFileSync(new URL("../../shared/fixtures/watchOrder.json", import.meta.url), "utf8")) as {
  cases: { name: string; groups: WatchGroup[]; stocks: OrderStock[]; op: WatchOp | null; order: { groupId: number | null; codes: string[] }[] }[];
};
const nameFx = JSON.parse(readFileSync(new URL("../../shared/fixtures/watchGroupNames.json", import.meta.url), "utf8")) as {
  limit: number;
  maxLength: number;
  cases: { name: string; existing: string[]; except?: number; ok?: string; error?: string }[];
};

describe("공용 픽스처 (서버 services/watchGroupService 와 같은 답)", () => {
  it("경우가 충분히 있다", () => {
    expect(orderFx.cases.length).toBeGreaterThanOrEqual(15);
    expect(nameFx.cases.length).toBeGreaterThanOrEqual(20);
    expect(nameFx.limit).toBe(WATCH_GROUP_LIMIT);
  });

  it.each(orderFx.cases.map((c) => [c.name, c] as const))("순서: %s", (_n, c) => {
    const state = c.op ? applyOp(c.groups, c.stocks, c.op) : { groups: c.groups, stocks: c.stocks };
    expect(watchOrder(state.groups, state.stocks)).toEqual(c.order);
  });

  it.each(nameFx.cases.map((c, i) => [`${i} ${JSON.stringify(c.name)}`, c] as const))("이름: %s", (_n, c) => {
    const existing = c.existing.map((name, i) => ({ id: i + 1, name }));
    expect(groupNameCheck(c.name, existing, c.except === undefined ? undefined : c.except + 1)).toEqual(c.ok !== undefined ? { ok: true, name: c.ok } : { ok: false, error: c.error });
  });

  it("입력칸 글자 수는 정리한 이름의 코드 포인트", () => {
    expect(nameLength("  반도체  ")).toBe(3);
    expect(nameLength("👨‍👩‍👧‍👦")).toBe(7);
    expect(nameLength("🚀")).toBe(1);
  });
});

// 잔고 목록 (서버가 등록순으로 준다). 관심 9 · 보유 1
const at = (m: number) => `2026-09-01T09:${String(m).padStart(2, "0")}:00+09:00`;
const w = (code: string, name: string, m: number, rate = 0): RegisteredWithQuote => ({ ...holding(code, quote(code, 100, { changeRate: rate }), null, null, undefined, name), createdAt: at(m) });
const LIST: RegisteredWithQuote[] = [
  { ...holding("HELD", quote("HELD", 100), 3, 90, undefined, "보유종목"), createdAt: at(0) },
  w("005930", "삼성전자", 1, 1.2),
  w("000660", "SK하이닉스", 2, -0.4),
  w("042700", "한미반도체", 3, 3.1),
  w("NVDA", "엔비디아", 4, 2.2),
  w("005380", "현대차", 5, 0.5),
  w("KO", "코카콜라", 6, -1.1),
  w("O", "리얼티인컴", 7, 0.1),
  w("TSLA", "테슬라", 8, -2.5),
  w("AAPL", "애플", 9, 0.9),
];
const LAYOUT: WatchLayout = {
  on: true,
  groups: [
    { id: 7, name: "반도체", position: 0 },
    { id: 3, name: "배당", position: 1 },
    { id: 9, name: "빈 그룹", position: 2 },
  ],
  items: [
    { code: "000660", groupId: 7, position: 0 },
    { code: "005930", groupId: 7, position: 1 },
    { code: "042700", groupId: 7, position: 2 },
    { code: "NVDA", groupId: 7, position: null },
    { code: "005380", groupId: 3, position: 1 },
    { code: "KO", groupId: 3, position: 0 },
    { code: "O", groupId: 3, position: 2 },
    { code: "AAPL", groupId: null, position: 0 },
  ],
};
const watchOf = (sort: "created" | "changeRate") => splitHoldings(sortHoldings(LIST, sort, false)).watch;
const codes = (list: RegisteredWithQuote[]) => list.map((s) => s.code);
const shape = (entries: ReturnType<typeof watchEntries>) =>
  entries.map((e) => (e.kind === "groupHead" ? `▾${e.collapsed ? "접힘" : ""} ${e.name} ${e.count}` : e.kind === "empty" ? "(빈 그룹)" : `${e.stock.code}#${e.index + 1}/${e.count}`));

describe("잔고 관심 칸 줄 (watchEntries)", () => {
  it("'전체' · 내 순서(등록순): 그룹 순서대로 머리 + 줄, 빈 그룹은 머리도 숨김, 그룹 없음은 맨 끝", () => {
    const m = watchModel(watchOf("created"), LAYOUT, VIEW_DEFAULT, true);
    expect(shape(watchEntries(m))).toEqual([
      "▾ 반도체 4",
      "000660#1/4",
      "005930#2/4",
      "042700#3/4",
      "NVDA#4/4",
      "▾ 배당 3",
      "KO#1/3",
      "005380#2/3",
      "O#3/3",
      "▾ 그룹 없음 2",
      "AAPL#1/2",
      "TSLA#2/2",
    ]);
    // 보유 종목은 관심 칸에 없다
    expect(codes(visibleWatch(m))).not.toContain("HELD");
  });

  it("접은 그룹은 머리만, 그룹 칩을 고르면 머리 없이 그 그룹만(접힘과 상관없이), 빈 그룹은 빈 칸", () => {
    const folded = watchModel(watchOf("created"), LAYOUT, { selected: "all", collapsed: [3, "none"] }, true);
    expect(shape(watchEntries(folded))).toEqual(["▾ 반도체 4", "000660#1/4", "005930#2/4", "042700#3/4", "NVDA#4/4", "▾접힘 배당 3", "▾접힘 그룹 없음 2"]);
    expect(codes(visibleWatch(folded))).toEqual(["000660", "005930", "042700", "NVDA"]);
    expect(shape(watchEntries(watchModel(watchOf("created"), LAYOUT, { selected: 3, collapsed: [3] }, true)))).toEqual(["KO#1/3", "005380#2/3", "O#3/3"]);
    expect(shape(watchEntries(watchModel(watchOf("created"), LAYOUT, { selected: "none", collapsed: [] }, true)))).toEqual(["AAPL#1/2", "TSLA#2/2"]);
    expect(shape(watchEntries(watchModel(watchOf("created"), LAYOUT, { selected: 9, collapsed: [] }, true)))).toEqual(["(빈 그룹)"]);
  });

  it("그룹이 하나도 없으면 머리 없이 지금 순서 그대로 (= 등록순)", () => {
    const m = watchModel(watchOf("created"), { on: true, groups: [], items: [] }, VIEW_DEFAULT, true);
    expect(shape(watchEntries(m))).toEqual(["005930#1/9", "000660#2/9", "042700#3/9", "NVDA#4/9", "005380#5/9", "KO#6/9", "O#7/9", "TSLA#8/9", "AAPL#9/9"]);
    expect(codes(visibleWatch(m))).toEqual(codes(watchOf("created")));
  });

  it("정렬이 등록순이 아니면 그룹 경계는 지키고 그룹 안에서만 그 정렬 — 자리(↑↓·메뉴)는 늘 내 순서 기준", () => {
    const m = watchModel(watchOf("changeRate"), LAYOUT, VIEW_DEFAULT, false);
    expect(shape(watchEntries(m))).toEqual([
      "▾ 반도체 4",
      "042700#1/4",
      "NVDA#2/4",
      "005930#3/4",
      "000660#4/4",
      "▾ 배당 3",
      "005380#1/3",
      "O#2/3",
      "KO#3/3",
      "▾ 그룹 없음 2",
      "AAPL#1/2",
      "TSLA#2/2",
    ]);
    expect(m.pos.get("042700")).toEqual({ groupId: 7, groupName: "반도체", index: 2, count: 4 });
    expect(posLine(m.pos.get("042700")!)).toBe("지금: 반도체 · 3번째 (4종목 중)");
    expect(posLine(m.pos.get("TSLA")!)).toBe("지금: 그룹 없음 · 2번째 (2종목 중)");
  });

  it("서버에 없는 그룹을 고른 칩은 '전체', 접은 목록에서도 뺀다 · 없는 그룹을 가리키는 종목은 그룹 없음", () => {
    const view = { selected: 42, collapsed: [42, 7, "none"] as (number | "none")[] };
    expect(normalizeView(view, LAYOUT)).toEqual({ selected: "all", collapsed: [7, "none"] });
    expect(normalizeView(VIEW_DEFAULT, LAYOUT)).toBe(VIEW_DEFAULT);
    const odd: WatchLayout = { ...LAYOUT, items: [...LAYOUT.items.filter((i) => i.code !== "AAPL"), { code: "AAPL", groupId: 99, position: 0 }] };
    expect(watchModel(watchOf("created"), odd, VIEW_DEFAULT, true).pos.get("AAPL")?.groupName).toBe("그룹 없음");
  });
});

describe("칩 (watchChips)", () => {
  it("전체 → 그룹(0종목이어도) → 그룹 없음, 화면 읽기 이름과 선택", () => {
    const chips = watchChips(watchModel(watchOf("created"), LAYOUT, { selected: 7, collapsed: [] }, true));
    expect(chips.map((c) => [c.label, c.count, c.speech, c.selected])).toEqual([
      ["전체", 9, "관심 전체, 9종목", false],
      ["반도체", 4, "반도체 그룹, 4종목", true],
      ["배당", 3, "배당 그룹, 3종목", false],
      ["빈 그룹", 0, "빈 그룹 그룹, 0종목", false],
      ["그룹 없음", 2, "그룹 없음, 2종목", false],
    ]);
  });

  it("모든 종목을 그룹에 넣었으면 '그룹 없음 0' 은 숨긴다 (지금 고른 칩이면 보인다) · 그룹이 없으면 '전체' 하나", () => {
    const all: WatchLayout = { on: true, groups: [{ id: 1, name: "모두", position: 0 }], items: watchOf("created").map((s, i) => ({ code: s.code, groupId: 1, position: i })) };
    expect(watchChips(watchModel(watchOf("created"), all, VIEW_DEFAULT, true)).map((c) => c.label)).toEqual(["전체", "모두"]);
    expect(watchChips(watchModel(watchOf("created"), all, { selected: "none", collapsed: [] }, true)).map((c) => `${c.label} ${c.count}`)).toEqual(["전체 9", "모두 9", "그룹 없음 0"]);
    expect(watchChips(watchModel(watchOf("created"), { on: true, groups: [], items: [] }, VIEW_DEFAULT, true)).map((c) => `${c.label} ${c.count}`)).toEqual(["전체 9", "그룹 없음 9"]);
  });
});

describe("낙관적 반영 (applyToLayout)", () => {
  it("↑ 한 번: 서버 응답과 같은 배치 모양 (코드 순, 그룹·자리가 정해진 종목만)", () => {
    const next = applyToLayout(LAYOUT, LIST, { kind: "move", code: "005930", groupId: 7, index: 0 });
    expect(next.items.filter((i) => i.groupId === 7)).toEqual([
      { code: "000660", groupId: 7, position: 1 },
      { code: "005930", groupId: 7, position: 0 },
      { code: "042700", groupId: 7, position: 2 },
      { code: "NVDA", groupId: 7, position: 3 },
    ]);
    expect(next.items.map((i) => i.code)).toEqual([...next.items.map((i) => i.code)].sort());
  });

  it("그룹 지우기·그룹 순서 · 목록에 아직 없는 코드의 칸은 그대로 둔다", () => {
    const withGhost: WatchLayout = { ...LAYOUT, items: [...LAYOUT.items, { code: "ZZZ", groupId: 3, position: 5 }] };
    const del = applyToLayout(withGhost, LIST, { kind: "delete", groupId: 7 });
    expect(del.groups.map((g) => [g.id, g.position])).toEqual([
      [3, 0],
      [9, 1],
    ]);
    const m = watchModel(watchOf("created"), del, VIEW_DEFAULT, true);
    expect(m.buckets.at(-1)!.stocks.map((s) => s.code)).toEqual(["AAPL", "TSLA", "000660", "005930", "042700", "NVDA"]);
    expect(del.items.find((i) => i.code === "ZZZ")).toEqual({ code: "ZZZ", groupId: 3, position: 5 });
    expect(applyToLayout(LAYOUT, LIST, { kind: "order", ids: [9, 7, 3] }).groups.map((g) => g.name)).toEqual(["빈 그룹", "반도체", "배당"]);
  });
});

describe("기기 저장값 (settings.watchView)", () => {
  it("저장 ↔ 읽기, 망가진 값·모르는 모양은 '전체 · 모두 펼침'", () => {
    const v = toggleFold(selectChip(VIEW_DEFAULT, 7), "none");
    expect(v).toEqual({ selected: 7, collapsed: ["none"] });
    expect(parseWatchView(serializeWatchView(v))).toEqual(v);
    expect(toggleFold(v, "none")).toEqual({ selected: 7, collapsed: [] });
    for (const raw of [null, "", "{", "[]", '{"v":2,"selected":7}', '{"selected":7}', "null"]) expect(parseWatchView(raw)).toEqual(VIEW_DEFAULT);
    expect(parseWatchView('{"v":1,"selected":-3,"collapsed":["none","x",4,4,0,1.5]}')).toEqual({ selected: "all", collapsed: ["none", 4] });
  });
});

describe("끌기 목표 칸 (lib/watchDrag)", () => {
  const H = [56, 56, 80, 56];
  it("끄는 줄의 가운데가 다른 줄 가운데를 지날 때마다 한 칸", () => {
    expect(dragTarget(H, 1, 0)).toBe(1);
    expect(dragTarget(H, 1, 27)).toBe(1);
    expect(dragTarget(H, 1, 69)).toBe(2); // 56+28 → 112+40 = 152 가운데를 지남
    expect(dragTarget(H, 1, 500)).toBe(3);
    expect(dragTarget(H, 1, -55)).toBe(1); // 가운데 84 → 29, 윗줄 가운데 28 을 아직 못 지남
    expect(dragTarget(H, 1, -57)).toBe(0);
    expect(dragTarget(H, 3, -1000)).toBe(0);
    expect(dragTarget(H, 9, 10)).toBe(9);
  });
  it("다른 줄은 끄는 줄 높이만큼 비켜 보인다", () => {
    expect([0, 1, 2, 3].map((j) => dragShift(H, 0, 2, j))).toEqual([0, -56, -56, 0]);
    expect([0, 1, 2, 3].map((j) => dragShift(H, 2, 0, j))).toEqual([80, 80, 0, 0]);
    expect([0, 1, 2, 3].map((j) => dragShift(H, 1, 1, j))).toEqual([0, 0, 0, 0]);
  });
});

describe("글 (화면 읽기·창)", () => {
  it("받침에 맞는 조사와 옮긴 뒤 알림", () => {
    expect(objectParticle("삼성전자")).toBe("를");
    expect(objectParticle("애플")).toBe("을");
    expect(objectParticle("NVDA")).toBe("을(를)");
    expect(movedSpeech("삼성전자", "반도체", 0, true)).toBe("삼성전자를 반도체 1번째로 옮겼습니다");
    expect(movedSpeech("삼성전자", "그룹 없음", 2, false)).toBe("삼성전자를 관심 3번째로 옮겼습니다");
    expect(movedToGroupSpeech("삼성전자", "배당", 3)).toBe("삼성전자를 배당 그룹 맨 끝으로 옮겼습니다");
    expect(movedToGroupSpeech("애플", "그룹 없음", null)).toBe("애플을 그룹 없음 맨 끝으로 옮겼습니다");
    expect(groupHeadSpeech("반도체", 7, 4, false)).toBe("반도체 그룹, 4종목, 펼쳐짐");
    expect(groupHeadSpeech("그룹 없음", null, 2, true)).toBe("그룹 없음, 2종목, 접힘");
  });
  it("지우기 확인·저장 실패 글", () => {
    expect(deleteGroupMessage(4)).toBe("그룹만 지워집니다. 안의 4종목은 관심 종목으로 남고 ‘그룹 없음’ 맨 끝으로 옮겨집니다.");
    expect(deleteGroupMessage(0)).toBe("빈 그룹을 지웁니다.");
    expect(saveFailText(Object.assign(new Error("서버에 연결할 수 없습니다: x"), { status: 0 }))).toBe("서버에 연결되지 않았습니다. 연결되면 다시 해 주세요.");
    expect(saveFailText(Object.assign(new Error("같은 이름의 그룹이 이미 있습니다"), { status: 409 }))).toBe("같은 이름의 그룹이 이미 있습니다");
  });
});
