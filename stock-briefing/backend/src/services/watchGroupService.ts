import type { Db } from "../db/index.js";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import { AppError } from "../lib/errors.js";
import { Mutex } from "../lib/mutex.js";
import { seoulIso } from "../lib/time.js";
import type { FeatureService } from "./featureService.js";

/**
 * 관심 종목 그룹·순서 (3-34, 플래그 watchGroups).
 *  - 그룹 이름과 칩 순서는 표 watch_groups, 종목의 그룹과 그 그룹 안 자리는 registered_stocks 의 두 칸(watch_group_id · watch_position).
 *    등록 표의 칸이라 종목을 지우면(관심 해제·동기화 제외) 함께 사라지고, 샀다가 다 팔아도 행이 남아 그룹을 기억한다.
 *  - 토스 동기화·종목 마스터 갱신·앱의 수정(PATCH)은 정해 둔 칸만 쓰므로 이 두 칸을 덮어쓰지 않는다 (test/watchGroupsSync.test.ts).
 *  - 순서 규칙은 앱 lib/watchGroups 와 같다 (공용 픽스처 shared/fixtures/watchOrder.json · watchGroupNames.json 으로 두 쪽을 확인).
 *  - 쓰기는 이 서비스의 잠금 하나로 한 번에 하나씩 (토스 동기화의 holdingsWriteLock 과는 다른 잠금 — 동기화가 도는 몇 초 동안
 *    순서 저장이 기다리지 않게. 서로 다른 칸만 쓰므로 겹쳐도 덮어쓰지 않는다). updated_at(보유 정보를 고친 시각)은 건드리지 않는다.
 *  - 나중에 사용자별(계정 B단계)로 바꿀 때: watch_groups 에 user_id 칸 하나 + scope() 에 조건 한 줄. registered_stocks 두 칸은 행을 따라간다
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
  /** null = 그룹 없음 (없는 그룹을 가리키면 null 로 준다) */
  groupId: number | null;
  /** 그 그룹 안 자리. null = 아직 정하지 않음 (정한 종목들 뒤에 등록순) */
  position: number | null;
}

/** 앱에 주는 배치 전체. 모든 응답이 이 모양이라 앱은 받은 값으로 캐시를 통째로 바꾼다 */
export interface WatchLayout {
  /** false = 기능 꺼짐 → 앱은 지금 화면 그대로 */
  on: boolean;
  /** 그룹 순서대로 */
  groups: WatchGroup[];
  /** 그룹이나 자리가 정해진 등록 종목만 (보유 포함), 코드 순 */
  items: WatchItem[];
  /** POST 만: 방금 만든 그룹 ('새 그룹 만들고 옮기기') */
  created?: { id: number; name: string };
}

export const WATCH_OFF: WatchLayout = Object.freeze({ on: false, groups: [], items: [] }) as WatchLayout;

// ── 순서 규칙 (순수 함수 — 앱 lib/watchGroups 와 같은 규칙) ──

/** 순서 계산에 쓰는 종목 한 줄 */
export interface OrderStock {
  code: string;
  quantity: number | null;
  createdAt: string;
  groupId: number | null;
  position: number | null;
}

export type WatchOp = { kind: "move"; code: string; groupId: number | null; index: number } | { kind: "delete"; groupId: number } | { kind: "order"; ids: number[] };

/** 관심 = 수량이 없거나 0 이하 */
export const isWatch = (s: Pick<OrderStock, "quantity">) => !(s.quantity !== null && s.quantity > 0);

/** 그룹 순서: 자리 → 번호 */
export function sortGroups<G extends WatchGroup>(groups: readonly G[]): G[] {
  return [...groups].sort((a, b) => a.position - b.position || a.id - b.id);
}

/** 없는 그룹을 가리키면 그룹 없음 */
const groupOf = (s: OrderStock, ids: ReadonlySet<number>) => (s.groupId !== null && ids.has(s.groupId) ? s.groupId : null);

/** 그룹 안 순서: 자리(null 은 맨 뒤) → 등록 시각 → 코드 */
export function compareInGroup(a: OrderStock, b: OrderStock): number {
  if (a.position !== b.position) {
    if (a.position === null) return 1;
    if (b.position === null) return -1;
    return a.position - b.position;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/** 한 그룹의 관심 종목 (순서대로). groupId null = 그룹 없음 */
function members(groups: readonly WatchGroup[], stocks: readonly OrderStock[], groupId: number | null, watchOnly = true): OrderStock[] {
  const ids = new Set(groups.map((g) => g.id));
  return stocks.filter((s) => groupOf(s, ids) === groupId && (!watchOnly || isWatch(s))).sort(compareInGroup);
}

/** 관심 종목 순서: 그룹 순서대로(빈 그룹 포함) + 그룹 없음(늘 맨 끝) */
export function watchOrder(groups: readonly WatchGroup[], stocks: readonly OrderStock[]): { groupId: number | null; codes: string[] }[] {
  return [...sortGroups(groups).map((g) => g.id), null].map((groupId) => ({ groupId, codes: members(groups, stocks, groupId).map((s) => s.code) }));
}

/**
 * 종목 하나를 그 그룹의 index 자리로 (범위를 넘으면 맨 앞/맨 끝). 그 그룹의 관심 종목(옮기는 종목 뺌)을 순서대로 늘어놓고 끼운 뒤 0,1,2… 로 번호를 다시 매긴다.
 * 보유 중인 종목을 옮기면 저장만 하고(관심이 되면 그 자리로), 같은 그룹의 보유 종목 번호는 그대로 둔다 → 다 팔면 대략 원래 자리
 */
export function applyMove(groups: readonly WatchGroup[], stocks: readonly OrderStock[], op: { code: string; groupId: number | null; index: number }): OrderStock[] {
  const moving = stocks.find((s) => s.code === op.code);
  if (!moving) return [...stocks];
  const list = members(groups, stocks, op.groupId).filter((s) => s.code !== op.code);
  const at = Math.max(0, Math.min(Math.floor(op.index), list.length));
  list.splice(at, 0, moving);
  const next = new Map(list.map((s, i) => [s.code, { groupId: op.groupId, position: i }]));
  return stocks.map((s) => (next.has(s.code) ? { ...s, ...next.get(s.code)! } : s));
}

/**
 * 그룹 지우기: 그 그룹 종목(보유 포함)은 그룹 없음으로. 관심 종목은 그룹 없음 맨 끝에 원래 순서대로 붙이고 그룹 없음 전체에 0,1,2… 번호를 매긴다
 * (번호 없는 종목이 번호 있는 종목 뒤로 가는 규칙 때문에 붙인 종목이 앞으로 튀지 않게). 보유 종목은 번호를 그대로 둔다
 */
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

/** 그룹 순서 바꾸기: ids 가 지금 그룹과 정확히 같은 번호들일 때만 (아니면 null — 목록이 바뀜) */
export function applyOrder(groups: readonly WatchGroup[], ids: readonly number[]): WatchGroup[] | null {
  if (ids.length !== groups.length || new Set(ids).size !== ids.length || ids.some((id) => !groups.some((g) => g.id === id))) return null;
  return ids.map((id, i) => ({ ...groups.find((g) => g.id === id)!, position: i }));
}

/** 픽스처·앱의 낙관적 반영과 같은 모양: 조작 하나를 적용한 새 상태 */
export function applyOp(groups: readonly WatchGroup[], stocks: readonly OrderStock[], op: WatchOp): { groups: WatchGroup[]; stocks: OrderStock[] } {
  if (op.kind === "move") return { groups: [...groups], stocks: applyMove(groups, stocks, op) };
  if (op.kind === "delete") return applyDelete(groups, stocks, op.groupId);
  return { groups: applyOrder(groups, op.ids) ?? [...groups], stocks: [...stocks] };
}

// ── 그룹 이름 규칙 (앱 lib/watchGroups groupNameCheck 와 같다) ──

export type NameError = "empty" | "tooLong" | "reserved" | "duplicate" | "limit";

export const NAME_ERROR_TEXT: Record<NameError, string> = {
  empty: "이름을 넣어 주세요",
  tooLong: "이름은 10자까지입니다",
  reserved: "‘전체’·‘그룹 없음’은 그룹 이름으로 쓸 수 없습니다",
  duplicate: "같은 이름의 그룹이 이미 있습니다",
  limit: "그룹은 12개까지 만들 수 있습니다",
};

/**
 * 이름 정리: 유니코드 NFC, 탭·줄바꿈과 빈칸처럼 보이는 글자(한글 채움 문자 U+3164·U+115F·U+1160·U+FFA0, 점자 빈칸 U+2800 — 3-34 검토:
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

/** 보이는 글자만 (낱말 안에 남은 U+200D 도 뺀다) — 빈 이름·예약어·겹침 검사용 ('전‍체' 가 '전체' 검사를 피해 가지 않게) */
const visible = (name: string) => name.replace(/‍/g, "");
/** 겹침 비교용 (대소문자·빈칸·보이지 않는 글자 무시) */
const nameKey = (n: string) => visible(cleanGroupName(n)).toLowerCase();
const RESERVED = new Set(["전체", "그룹없음"]);

/**
 * 이름 검사. 글자 수는 코드 포인트 수. except 가 있으면 그 그룹의 이름 바꾸기(자기 이름과는 겹쳐도 되고 개수 한도는 보지 않음),
 * 없으면 새로 만들기(12개 한도). 차례: 빔 → 10자 → 예약어 → 같은 이름 → 한도
 */
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

function nameFail(error: NameError): AppError {
  const status = error === "duplicate" || error === "limit" ? 409 : 400;
  const code = error === "duplicate" ? "DUPLICATE" : error === "limit" ? "LIMIT" : "VALIDATION";
  return new AppError(status, code, NAME_ERROR_TEXT[error]);
}

const groupMissing = () => new AppError(404, "NOT_FOUND", "그룹을 찾을 수 없습니다. 목록을 새로 불러옵니다");

// ── 서비스 ──

export class WatchGroupService {
  private readonly db: Db;
  private readonly features: Pick<FeatureService, "enabled">;
  private readonly now: () => Date;
  /** 쓰기를 한 번에 하나씩 (읽고-계산하고-쓰기가 겹치지 않게). 서버는 한 프로세스라 이 줄로 충분하다 */
  private readonly lock = new Mutex();

  constructor(deps: { db: Db; features: Pick<FeatureService, "enabled">; now?: () => Date }) {
    this.db = deps.db;
    this.features = deps.features;
    this.now = deps.now ?? (() => new Date());
  }

  enabled(): Promise<boolean> {
    return this.features.enabled("watchGroups");
  }

  /** 모든 watch_groups 조회가 거치는 곳 (나중에 사용자별이 되면 여기에 user_id 조건 한 줄) */
  private scope<Q>(qb: Q): Q {
    return qb;
  }

  private async readGroups(db: Db = this.db): Promise<WatchGroup[]> {
    const rows = await this.scope(db.selectFrom("watch_groups").select(["id", "name", "position"])).execute();
    return sortGroups(rows.map((r) => ({ id: Number(r.id), name: r.name, position: Number(r.position) })));
  }

  private async readStocks(db: Db = this.db): Promise<OrderStock[]> {
    const rows = await db.selectFrom("registered_stocks").select(["code", "quantity", "created_at", "watch_group_id", "watch_position"]).execute();
    return rows.map((r) => ({
      code: r.code,
      quantity: r.quantity === null ? null : Number(r.quantity),
      createdAt: r.created_at,
      groupId: r.watch_group_id === null ? null : Number(r.watch_group_id),
      position: r.watch_position === null ? null : Number(r.watch_position),
    }));
  }

  /** 지금 배치 (그룹이나 자리가 정해진 종목만, 없는 그룹은 null 로) */
  async layout(): Promise<WatchLayout> {
    const groups = await this.readGroups();
    const ids = new Set(groups.map((g) => g.id));
    const items = (await this.readStocks())
      .map((s) => ({ code: s.code, groupId: groupOf(s, ids), position: s.position }))
      .filter((s) => s.groupId !== null || s.position !== null)
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return { on: true, groups, items };
  }

  /** 바뀐 종목 칸만 쓴다 (updated_at 은 그대로) */
  private async writeStocks(trx: Db, before: readonly OrderStock[], after: readonly OrderStock[]): Promise<void> {
    const old = new Map(before.map((s) => [s.code, s]));
    for (const s of after) {
      const o = old.get(s.code);
      if (o && o.groupId === s.groupId && o.position === s.position) continue;
      await trx.updateTable("registered_stocks").set({ watch_group_id: s.groupId, watch_position: s.position }).where("code", "=", s.code).execute();
    }
  }

  private async writeGroupPositions(trx: Db, before: readonly WatchGroup[], after: readonly WatchGroup[]): Promise<void> {
    const ts = seoulIso(this.now());
    for (const g of after) {
      const o = before.find((x) => x.id === g.id);
      if (o && o.position === g.position) continue;
      await this.scope(trx.updateTable("watch_groups").set({ position: g.position, updated_at: ts }).where("id", "=", g.id)).execute();
    }
  }

  /** 새 그룹을 맨 끝에 */
  create(rawName: string): Promise<WatchLayout> {
    return this.lock.run(async () => {
      const groups = await this.readGroups();
      const check = groupNameCheck(rawName, groups);
      if (!check.ok) throw nameFail(check.error);
      const ts = seoulIso(this.now());
      const inserted = await this.db
        .insertInto("watch_groups")
        .values({ name: check.name, position: groups.length, created_at: ts, updated_at: ts })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { ...(await this.layout()), created: { id: Number(inserted.id), name: check.name } };
    });
  }

  rename(id: number, rawName: string): Promise<WatchLayout> {
    return this.lock.run(async () => {
      const groups = await this.readGroups();
      if (!groups.some((g) => g.id === id)) throw groupMissing();
      const check = groupNameCheck(rawName, groups, id);
      if (!check.ok) throw nameFail(check.error);
      await this.scope(this.db.updateTable("watch_groups").set({ name: check.name, updated_at: seoulIso(this.now()) }).where("id", "=", id)).execute();
      return this.layout();
    });
  }

  /** 그룹 지우기: 종목은 관심으로 남고 그룹 없음 맨 끝으로 (applyDelete) */
  remove(id: number): Promise<WatchLayout> {
    return this.lock.run(async () => {
      await this.db.transaction().execute(async (trx) => {
        const groups = await this.readGroups(trx);
        if (!groups.some((g) => g.id === id)) throw groupMissing();
        const stocks = await this.readStocks(trx);
        const next = applyDelete(groups, stocks, id);
        await this.writeStocks(trx, stocks, next.stocks);
        await this.scope(trx.deleteFrom("watch_groups").where("id", "=", id)).execute();
        await this.writeGroupPositions(trx, groups, next.groups);
      });
      return this.layout();
    });
  }

  /** 그룹 순서: ids 가 지금 그룹과 정확히 같은 번호들이어야 한다 (아니면 409 STALE) */
  order(ids: readonly number[]): Promise<WatchLayout> {
    return this.lock.run(async () => {
      await this.db.transaction().execute(async (trx) => {
        const groups = await this.readGroups(trx);
        const next = applyOrder(groups, ids);
        if (!next) throw new AppError(409, "STALE", "그룹 목록이 바뀌었습니다. 새로 불러온 뒤 다시 해 주세요");
        await this.writeGroupPositions(trx, groups, next);
      });
      return this.layout();
    });
  }

  /** 종목 하나를 그 그룹의 index 자리로 (끌기·↑↓·맨 위/아래·그룹 옮기기가 모두 이것 하나) */
  move(rawCode: string, groupId: number | null, index: number): Promise<WatchLayout> {
    const code = normalizeCode(rawCode);
    return this.lock.run(async () => {
      await this.db.transaction().execute(async (trx) => {
        const groups = await this.readGroups(trx);
        if (groupId !== null && !groups.some((g) => g.id === groupId)) throw groupMissing();
        const stocks = await this.readStocks(trx);
        if (!CODE_RE.test(code) || !stocks.some((s) => s.code === code)) throw new AppError(404, "NOT_FOUND", `등록되지 않은 종목입니다: ${code}`);
        await this.writeStocks(trx, stocks, applyMove(groups, stocks, { code, groupId, index }));
      });
      return this.layout();
    });
  }
}
