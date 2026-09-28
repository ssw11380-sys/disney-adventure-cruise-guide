import type { RegisteredWithQuote } from "@/api/types";
import { isHolding } from "@/lib/portfolio";
import type { WatchFold, WatchSelected, WatchView } from "@/lib/watchView";

export { parseWatchView, selectChip, serializeWatchView, toggleFold, VIEW_DEFAULT, type WatchFold, type WatchSelected, type WatchView } from "@/lib/watchView";

/**
 * 관심 종목 그룹·순서 (3-34, 기능 플래그 watchGroups) — 순수 함수 (React Native 를 쓰지 않아 테스트한다).
 *  - 서버 /api/watch-groups 가 주는 배치(WatchLayout): 그룹(이름·칩 순서) + 그룹·자리가 정해진 종목. 순서 규칙은 서버 services/watchGroupService 와 같고
 *    공용 픽스처(shared/fixtures/watchOrder.json · watchGroupNames.json)로 두 쪽이 같은 답인지 확인한다 → 앱이 먼저 화면을 바꾸고(낙관적) 서버 응답으로 맞춰도 줄이 튀지 않는다
 *  - 고른 칩·접은 그룹(WatchView)은 이 기기에만 (설정 settings.watchView — 정렬 설정과 같은 곳)
 *  - 관심 = 보유가 아닌 등록 종목 (lib/portfolio isHolding). 그룹에 넣지 않은 종목은 '그룹 없음'이고 늘 맨 끝
 *  - 정렬이 '등록순'이면 관심 칸은 '내 순서'(그룹 안 자리), 다른 정렬이면 그룹 경계는 지키고 그룹 안에서만 그 정렬
 */

export const WATCH_GROUP_LIMIT = 12;
export const WATCH_GROUP_NAME_MAX = 10;

export interface WatchGroup {
  id: number;
  name: string;
  position: number;
}

export interface WatchItem {
  code: string;
  groupId: number | null;
  position: number | null;
}

export interface WatchLayout {
  /** false = 기능 꺼짐(또는 이 계정은 쓸 수 없음) → 지금 화면 그대로 */
  on: boolean;
  groups: WatchGroup[];
  items: WatchItem[];
  /** 만들기 응답만: 방금 만든 그룹 */
  created?: { id: number; name: string };
}

export const WATCH_OFF: WatchLayout = Object.freeze({ on: false, groups: [], items: [] }) as WatchLayout;

/**
 * 서버에 없는 그룹(지워짐)을 고른 칩은 '전체'로, 접은 목록에서도 뺀다.
 * 그룹이 하나도 없으면 '그룹 없음'을 고른 칩도 '전체'로 (그룹을 다 지운 뒤 — 그때 칩 줄은 '전체' 하나뿐, 설계 E4)
 */
export function normalizeView(view: WatchView, layout: WatchLayout | null): WatchView {
  if (!layout) return view;
  const ids = new Set(layout.groups.map((g) => g.id));
  const gone = typeof view.selected === "number" ? !ids.has(view.selected) : view.selected === "none" && ids.size === 0;
  const selected = gone ? "all" : view.selected;
  const collapsed = view.collapsed.filter((c) => c === "none" || ids.has(c));
  return selected === view.selected && collapsed.length === view.collapsed.length ? view : { selected, collapsed };
}

// ── 순서 규칙 (서버 watchGroupService 와 같다) ──

export interface OrderStock {
  code: string;
  quantity: number | null;
  createdAt: string;
  groupId: number | null;
  position: number | null;
}

export type WatchOp = { kind: "move"; code: string; groupId: number | null; index: number } | { kind: "delete"; groupId: number } | { kind: "order"; ids: number[] };

export const isWatch = (s: Pick<OrderStock, "quantity">) => !(s.quantity !== null && s.quantity > 0);

export function sortGroups<G extends WatchGroup>(groups: readonly G[]): G[] {
  return [...groups].sort((a, b) => a.position - b.position || a.id - b.id);
}

const groupOf = (s: OrderStock, ids: ReadonlySet<number>) => (s.groupId !== null && ids.has(s.groupId) ? s.groupId : null);

export function compareInGroup(a: OrderStock, b: OrderStock): number {
  if (a.position !== b.position) {
    if (a.position === null) return 1;
    if (b.position === null) return -1;
    return a.position - b.position;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

function members(groups: readonly WatchGroup[], stocks: readonly OrderStock[], groupId: number | null): OrderStock[] {
  const ids = new Set(groups.map((g) => g.id));
  return stocks.filter((s) => groupOf(s, ids) === groupId && isWatch(s)).sort(compareInGroup);
}

export function watchOrder(groups: readonly WatchGroup[], stocks: readonly OrderStock[]): { groupId: number | null; codes: string[] }[] {
  return [...sortGroups(groups).map((g) => g.id), null].map((groupId) => ({ groupId, codes: members(groups, stocks, groupId).map((s) => s.code) }));
}

export function applyMove(groups: readonly WatchGroup[], stocks: readonly OrderStock[], op: { code: string; groupId: number | null; index: number }): OrderStock[] {
  const moving = stocks.find((s) => s.code === op.code);
  if (!moving) return [...stocks];
  const list = members(groups, stocks, op.groupId).filter((s) => s.code !== op.code);
  const at = Math.max(0, Math.min(Math.floor(op.index), list.length));
  list.splice(at, 0, moving);
  const next = new Map(list.map((s, i) => [s.code, { groupId: op.groupId, position: i }]));
  return stocks.map((s) => (next.has(s.code) ? { ...s, ...next.get(s.code)! } : s));
}

export function applyDelete(groups: readonly WatchGroup[], stocks: readonly OrderStock[], groupId: number): { groups: WatchGroup[]; stocks: OrderStock[] } {
  const rest = sortGroups(groups.filter((g) => g.id !== groupId)).map((g, i) => ({ ...g, position: i }));
  const tail = [...members(groups, stocks, null), ...members(groups, stocks, groupId)];
  const next = new Map(tail.map((s, i) => [s.code, i]));
  const ids = new Set(groups.map((g) => g.id));
  const out = stocks.map((s) => {
    if (next.has(s.code)) return { ...s, groupId: null, position: next.get(s.code)! };
    if (groupOf(s, ids) === groupId) return { ...s, groupId: null };
    return s;
  });
  return { groups: rest, stocks: out };
}

export function applyOrder(groups: readonly WatchGroup[], ids: readonly number[]): WatchGroup[] | null {
  if (ids.length !== groups.length || new Set(ids).size !== ids.length || ids.some((id) => !groups.some((g) => g.id === id))) return null;
  return ids.map((id, i) => ({ ...groups.find((g) => g.id === id)!, position: i }));
}

export function applyOp(groups: readonly WatchGroup[], stocks: readonly OrderStock[], op: WatchOp): { groups: WatchGroup[]; stocks: OrderStock[] } {
  if (op.kind === "move") return { groups: [...groups], stocks: applyMove(groups, stocks, op) };
  if (op.kind === "delete") return applyDelete(groups, stocks, op.groupId);
  return { groups: applyOrder(groups, op.ids) ?? [...groups], stocks: [...stocks] };
}

/** 잔고 목록 + 배치 → 순서 계산용 줄. 배치에만 있는 코드(목록이 아직 옛것)는 보유처럼 두어 값만 지킨다 */
export function orderStocks(list: readonly RegisteredWithQuote[], layout: WatchLayout): OrderStock[] {
  const items = new Map(layout.items.map((i) => [i.code, i]));
  const out: OrderStock[] = list.map((s) => ({
    code: s.code,
    quantity: isHolding(s) ? Math.max(s.quantity ?? 0, 1) : null,
    createdAt: s.createdAt,
    groupId: items.get(s.code)?.groupId ?? null,
    position: items.get(s.code)?.position ?? null,
  }));
  const seen = new Set(list.map((s) => s.code));
  for (const i of layout.items) if (!seen.has(i.code)) out.push({ code: i.code, quantity: 1, createdAt: "", groupId: i.groupId, position: i.position });
  return out;
}

/** 순서 계산 결과 → 배치 (그룹·자리가 정해진 종목만, 코드 순 — 서버 응답과 같은 모양) */
export function layoutFrom(groups: readonly WatchGroup[], stocks: readonly OrderStock[]): WatchLayout {
  const ids = new Set(groups.map((g) => g.id));
  const items = stocks
    .map((s) => ({ code: s.code, groupId: groupOf(s, ids), position: s.position }))
    .filter((s) => s.groupId !== null || s.position !== null)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { on: true, groups: sortGroups(groups), items };
}

/**
 * 잔고 목록의 행 표시: 종목마다 '코드 + 등록 시각' (정렬해 한 글로). 관심 해제 뒤 다시 추가한 종목은 같은 코드라도 서버에 새 행이라 등록 시각이 새것이다.
 * 시세만 바뀐 목록은 같은 글이라, 제공자가 이 값으로 잔고 목록을 지켜봐도 체결마다 다시 그리지 않는다
 */
export function rowStamps(list: readonly { code: string; createdAt: string }[]): string {
  return list
    .map((s) => `${s.code}\t${s.createdAt}`)
    .sort()
    .join("\n");
}

const parseStamps = (stamps: string) => new Map(stamps ? stamps.split("\n").map((r) => r.split("\t") as [string, string]) : []);

/**
 * 잔고 목록의 종목이 바뀐 뒤 (3-34 검토: 관심 해제 → 다시 추가하면 서버는 새 행 = '그룹 없음' 맨 끝인데, 캐시 배치는 예전 그룹·자리를 들고 있어
 * 화면이 예전 그룹에 두었고, 그 그룹 안 ↑↓ 번호가 서버와 어긋나 옮기기가 조용히 안 먹었다).
 * drop = 캐시 배치에서 바로 뺄 종목 (목록에서 사라짐 · 등록 시각이 바뀜 = 지웠다 다시 등록 — 서버에서 그 행의 그룹·자리는 이미 없다),
 * refetch = 서버 배치를 다시 받을지 (종목이 하나라도 사라지거나 새로 생겼으면)
 */
export function stockSetChange(prev: string, next: string): { drop: string[]; refetch: boolean } {
  if (prev === next) return { drop: [], refetch: false };
  const a = parseStamps(prev);
  const b = parseStamps(next);
  const drop = [...a].filter(([code, at]) => b.get(code) !== at).map(([code]) => code);
  return { drop, refetch: drop.length > 0 || [...b.keys()].some((code) => !a.has(code)) };
}

/** 캐시 배치에서 종목을 뺀다 (뺄 것이 없으면 같은 값) */
export function dropItems(layout: WatchLayout, codes: readonly string[]): WatchLayout {
  const gone = new Set(codes);
  return layout.items.some((i) => gone.has(i.code)) ? { ...layout, items: layout.items.filter((i) => !gone.has(i.code)) } : layout;
}

/** 낙관적 반영: 잔고 목록과 지금 배치에 조작 하나를 적용한 새 배치 */
export function applyToLayout(layout: WatchLayout, list: readonly RegisteredWithQuote[], op: WatchOp): WatchLayout {
  const next = applyOp(layout.groups, orderStocks(list, layout), op);
  return layoutFrom(next.groups, next.stocks);
}

// ── 그룹 이름 규칙 (서버와 같다) ──

export type NameError = "empty" | "tooLong" | "reserved" | "duplicate" | "limit";

export const NAME_ERROR_TEXT: Record<NameError, string> = {
  empty: "이름을 넣어 주세요",
  tooLong: "이름은 10자까지입니다",
  reserved: "‘전체’·‘그룹 없음’은 그룹 이름으로 쓸 수 없습니다",
  duplicate: "같은 이름의 그룹이 이미 있습니다",
  limit: "그룹은 12개까지 만들 수 있습니다",
};

/**
 * 이름 정리 (서버와 같다): 유니코드 NFC, 탭·줄바꿈과 빈칸처럼 보이는 글자(한글 채움 문자 U+3164·U+115F·U+1160·U+FFA0, 점자 빈칸 U+2800 — 3-34 검토:
 * 빈 칩·빈 머리가 생겼다)는 빈칸으로, 제어 문자(Cc)와 보이지 않는 서식 글자(Cf — 폭 없는 빈칸 U+200B 등)는 지우고,
 * 안쪽 연속 빈칸은 하나로, 앞뒤 빈칸 없앰. 이모지를 잇는 U+200D(가족 이모지 등)만 남기되, 낱말 앞뒤에 붙은 것은 지운다
 */
export function cleanGroupName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[\t\n\v\f\rᅟᅠㅤﾠ⠀]/g, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/(?!‍)\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .split(" ")
    .map((w) => w.replace(/^‍+|‍+$/g, ""))
    .filter(Boolean)
    .join(" ");
}

/** 이름 글자 수 (코드 포인트 — 입력칸의 '3/10' 도 이 값) */
export const nameLength = (raw: string) => Array.from(cleanGroupName(raw)).length;

/** 보이는 글자만 (낱말 안에 남은 U+200D 도 뺀다) — 빈 이름·예약어·겹침 검사용 ('전‍체' 가 '전체' 검사를 피해 가지 않게) */
const visible = (name: string) => name.replace(/‍/g, "");
const nameKey = (n: string) => visible(cleanGroupName(n)).toLowerCase();
const RESERVED = new Set(["전체", "그룹없음"]);

export function groupNameCheck(raw: string, existing: readonly { id: number; name: string }[], exceptId?: number): { ok: true; name: string } | { ok: false; error: NameError } {
  const name = cleanGroupName(raw);
  if (!visible(name)) return { ok: false, error: "empty" };
  if (Array.from(name).length > WATCH_GROUP_NAME_MAX) return { ok: false, error: "tooLong" };
  if (RESERVED.has(visible(name).replace(/\s/gu, ""))) return { ok: false, error: "reserved" };
  const key = nameKey(name);
  if (existing.some((g) => g.id !== exceptId && nameKey(g.name) === key)) return { ok: false, error: "duplicate" };
  if (exceptId === undefined && existing.length >= WATCH_GROUP_LIMIT) return { ok: false, error: "limit" };
  return { ok: true, name };
}

// ── 잔고 관심 칸 그리기 ──

export const NONE_NAME = "그룹 없음";

/** 관심 칸 한 줄: 그룹 머리 · 종목 줄 · 빈 그룹 칸 */
export type WatchEntry =
  | { kind: "groupHead"; key: string; groupId: number | null; name: string; count: number; collapsed: boolean }
  | { kind: "row"; stock: RegisteredWithQuote; groupId: number | null; index: number; count: number }
  | { kind: "empty"; groupId: number | null; name: string };

/** 종목의 그룹·자리 (↑↓·메뉴 '지금' 줄·알림 문장) — 늘 '내 순서' 기준 */
export interface WatchPos {
  groupId: number | null;
  groupName: string;
  index: number;
  count: number;
}

export interface WatchModel {
  /** 그룹 순서대로 + 그룹 없음 (보기 순서: 내 순서면 자리, 아니면 받은 정렬) */
  buckets: { groupId: number | null; name: string; stocks: RegisteredWithQuote[] }[];
  /** 내 순서 기준 자리 */
  pos: Map<string, WatchPos>;
  /** 정리한 보기 상태 */
  view: WatchView;
  hasGroups: boolean;
}

const toOrder = (s: RegisteredWithQuote, item: WatchItem | undefined): OrderStock => ({
  code: s.code,
  quantity: null,
  createdAt: s.createdAt,
  groupId: item?.groupId ?? null,
  position: item?.position ?? null,
});

/**
 * 관심 종목(보유가 아닌 것 — 받은 정렬 순서 그대로)을 그룹별로 나눈다. mine(정렬 '등록순')이면 그룹 안은 내 순서(자리 → 등록 시각 → 코드),
 * 아니면 받은 정렬 순서. 자리(pos)는 늘 내 순서 기준 (위로·아래로 옮기기는 내 순서에서만 쓴다)
 */
export function watchModel(watch: readonly RegisteredWithQuote[], layout: WatchLayout, view: WatchView, mine: boolean): WatchModel {
  const groups = sortGroups(layout.groups);
  const ids = new Set(groups.map((g) => g.id));
  const items = new Map(layout.items.map((i) => [i.code, i]));
  const gid = (s: RegisteredWithQuote) => {
    const g = items.get(s.code)?.groupId ?? null;
    return g !== null && ids.has(g) ? g : null;
  };
  const buckets = [...groups.map((g) => ({ groupId: g.id as number | null, name: g.name, stocks: [] as RegisteredWithQuote[] })), { groupId: null, name: NONE_NAME, stocks: [] as RegisteredWithQuote[] }];
  const byId = new Map(buckets.map((b) => [b.groupId, b]));
  for (const s of watch) byId.get(gid(s))!.stocks.push(s);
  const pos = new Map<string, WatchPos>();
  for (const b of buckets) {
    const ordered = [...b.stocks].sort((x, y) => compareInGroup(toOrder(x, items.get(x.code)), toOrder(y, items.get(y.code))));
    ordered.forEach((s, i) => pos.set(s.code, { groupId: b.groupId, groupName: b.name, index: i, count: ordered.length }));
    if (mine) b.stocks = ordered;
  }
  return { buckets, pos, view: normalizeView(view, layout), hasGroups: groups.length > 0 };
}

/** 잔고 관심 칸 줄들 (고른 칩 · 접은 그룹 반영). 그룹이 없으면 머리 없이 지금처럼 줄만 */
export function watchEntries(model: WatchModel): WatchEntry[] {
  const { buckets, view, hasGroups } = model;
  const rows = (b: WatchModel["buckets"][number]): WatchEntry[] => b.stocks.map((stock, index) => ({ kind: "row", stock, groupId: b.groupId, index, count: b.stocks.length }));
  if (view.selected !== "all") {
    const b = buckets.find((x) => (view.selected === "none" ? x.groupId === null : x.groupId === view.selected));
    if (!b) return [];
    return b.stocks.length ? rows(b) : [{ kind: "empty", groupId: b.groupId, name: b.name }];
  }
  if (!hasGroups) return rows(buckets[buckets.length - 1]!);
  const out: WatchEntry[] = [];
  for (const b of buckets) {
    // '전체'에서 빈 그룹은 머리도 숨긴다
    if (!b.stocks.length) continue;
    const fold: WatchFold = b.groupId ?? "none";
    const collapsed = view.collapsed.includes(fold);
    out.push({ kind: "groupHead", key: `g-${b.groupId ?? "none"}`, groupId: b.groupId, name: b.name, count: b.stocks.length, collapsed });
    if (!collapsed) out.push(...rows(b));
  }
  return out;
}

/** 칩 하나 */
export interface WatchChip {
  key: WatchSelected;
  label: string;
  count: number;
  /** 화면 읽기 이름 */
  speech: string;
  selected: boolean;
}

/**
 * 칩 줄: 전체 → 그룹들(그룹 순서) → 그룹 없음(종목이 있거나 지금 고른 칩일 때만). 만든 그룹은 0종목이어도 보인다.
 * 그룹이 하나도 없으면 '전체' 하나뿐 (설계 1.1 ②·E4 — 그때 '그룹 없음 9' 는 '전체 9' 와 같은 목록이라 두지 않는다)
 */
export function watchChips(model: WatchModel): WatchChip[] {
  const { buckets, view, hasGroups } = model;
  const total = buckets.reduce((a, b) => a + b.stocks.length, 0);
  const out: WatchChip[] = [{ key: "all", label: "전체", count: total, speech: `관심 전체, ${total}종목`, selected: view.selected === "all" }];
  for (const b of buckets) {
    if (b.groupId === null) {
      if (hasGroups && (b.stocks.length || view.selected === "none")) out.push({ key: "none", label: NONE_NAME, count: b.stocks.length, speech: `${NONE_NAME}, ${b.stocks.length}종목`, selected: view.selected === "none" });
    } else out.push({ key: b.groupId, label: b.name, count: b.stocks.length, speech: `${b.name} 그룹, ${b.stocks.length}종목`, selected: view.selected === b.groupId });
  }
  return out;
}

/**
 * 칩 줄을 그릴 때 고른 칩이 보이게 넘길 위치 (3-34 리뷰: 기기에 저장한 칩이 칩 줄 오른쪽 밖이면 앱을 다시 열었을 때 무엇으로 걸렀는지 안 보였다).
 * chip = 칩의 x·폭(칩 띠 안), view = 칩 띠 폭, fade = 끝 흐림 폭, offset = 칩 띠를 지금 넘겨 둔 만큼.
 * 칩이 지금 보이는 곳(왼쪽 흐림 뒤 ~ 오른쪽 흐림 앞)에 다 들어 있으면 null(넘기지 않음) — 넘겨 둔 칩 줄에서 보이는 칩을 눌렀을 때 줄이 튀지 않게 (3-34 검토).
 * 왼쪽으로 가려졌으면 칩 왼쪽 끝이 왼쪽 흐림 뒤에 오게, 오른쪽으로 가려졌으면 칩 오른쪽 끝이 흐림 앞에 오게 넘기되 칩 왼쪽 끝이 왼쪽 흐림 밑으로 들어가지 않게
 * (칩이 띠보다 넓으면 왼쪽 맞춤)
 */
export function chipRevealX(chip: { x: number; w: number }, view: number, fade: number, offset = 0): number | null {
  if (view <= 0) return null;
  // 왼쪽 흐림은 넘겨 두었을 때만 칠해진다 (ChipStrip)
  const left = offset > 0 ? offset + fade : 0;
  if (chip.x >= left && chip.x + chip.w <= offset + view - fade) return null;
  if (chip.x < left) return Math.max(0, chip.x - fade);
  return Math.max(0, Math.min(chip.x - fade, chip.x + chip.w + fade - view));
}

/** 화면에 보이는 관심 종목 순서 (고른 칩 · 접은 그룹 반영) — 종목 상세 ‹ › · 이어 보기 */
export function visibleWatch(model: WatchModel): RegisteredWithQuote[] {
  return watchEntries(model).flatMap((e) => (e.kind === "row" ? [e.stock] : []));
}

// ── 글 ──

const MARKET_NAME: Record<string, string> = { KOSPI: "코스피", KOSDAQ: "코스닥", NASDAQ: "나스닥", NYSE: "뉴욕", AMEX: "아멕스", US: "미국" };
/** 편집 화면 종목 줄의 보조 글: '005930 · 코스피' · 'NVDA · 나스닥' (시장을 모르면 코드만) */
export function stockSub(s: { code: string; market: string }): string {
  const m = MARKET_NAME[s.market];
  return m ? `${s.code} · ${m}` : s.code;
}

/** 받침이 있으면 '을', 없으면 '를'. 한글로 끝나지 않으면(영문 티커 등) '을(를)' */
export function objectParticle(word: string): string {
  const last = word.trim().slice(-1);
  const c = last.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0 ? "를" : "을";
  return "을(를)";
}

/**
 * 알림 문장의 '무엇을': 한글로 끝나면 '삼성전자를'·'애플을', 아니면(AMD·TSMC·KODEX 200 등) 'AMD 종목을'
 * — '을(를)'을 붙이면 화면 읽기가 괄호째 읽어 어색하다
 */
function objectOf(name: string): string {
  const particle = objectParticle(name);
  return particle === "을(를)" ? `${name.trim()} 종목을` : `${name}${particle}`;
}

/** 그룹 머리 화면 읽기 이름표: '반도체 그룹, 4종목' — 펼쳐짐·접힘은 값(accessibilityValue.text)으로 뒤에 붙는다 (components/WatchChips WatchGroupHead) */
export function groupHeadSpeech(name: string, groupId: number | null, count: number): string {
  return `${groupId === null ? name : `${name} 그룹`}, ${count}종목`;
}

/**
 * 관심 줄 메뉴의 '지금' 줄: '지금: 반도체 · 2번째 (4종목 중)'. 자리는 늘 내 순서 기준이라, 정렬이 '등록순'이 아니면(mine = false) 화면에 보이는 자리와
 * 다를 수 있어 자리는 빼고 '지금: 반도체 (4종목)' 만 (3-34 검토 — 등락률 정렬에서 4번째 줄인데 '3번째'라고 나왔다)
 */
export function posLine(p: WatchPos, mine = true): string {
  return mine ? `지금: ${p.groupName} · ${p.index + 1}번째 (${p.count}종목 중)` : `지금: ${p.groupName} (${p.count}종목)`;
}

/** 순서를 옮긴 뒤 알림: '삼성전자를 반도체 1번째로 옮겼습니다' (그룹이 하나도 없으면 '관심 1번째', 영문 이름은 'AMD 종목을 …') */
export function movedSpeech(name: string, groupName: string, index: number, hasGroups: boolean): string {
  return `${objectOf(name)} ${hasGroups ? groupName : "관심"} ${index + 1}번째로 옮겼습니다`;
}

/** 그룹을 옮긴 뒤 알림: '삼성전자를 배당 그룹 맨 끝으로 옮겼습니다' / '… 그룹 없음 맨 끝으로 …' */
export function movedToGroupSpeech(name: string, groupName: string, groupId: number | null): string {
  return `${objectOf(name)} ${groupId === null ? groupName : `${groupName} 그룹`} 맨 끝으로 옮겼습니다`;
}

/** 고른 그룹이 비었을 때 칸 제목: '‘반도체’ 그룹에 종목이 없습니다' / '‘그룹 없음’에 종목이 없습니다' (무엇을 골라 두었는지 말한다) */
export function emptyGroupTitle(name: string, groupId: number | null): string {
  return groupId === null ? `‘${name}’에 종목이 없습니다` : `‘${name}’ 그룹에 종목이 없습니다`;
}

/** 지우기 확인 창 본문 */
export function deleteGroupMessage(count: number): string {
  return count > 0 ? `그룹만 지워집니다. 안의 ${count}종목은 관심 종목으로 남고 ‘그룹 없음’ 맨 끝으로 옮겨집니다.` : "빈 그룹을 지웁니다.";
}

/** 저장 실패 창 본문: 연결이 안 되면 정해 둔 글, 아니면 서버가 준 글 */
export function saveFailText(e: unknown): string {
  const status = typeof e === "object" && e !== null ? (e as { status?: unknown }).status : undefined;
  if (status === 0) return "서버에 연결되지 않았습니다. 연결되면 다시 해 주세요.";
  return e instanceof Error && e.message ? e.message : "저장하지 못했습니다";
}
