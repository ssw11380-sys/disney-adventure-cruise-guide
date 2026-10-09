import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { sql, type KyselyPlugin } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, createMigratedDb, migrate, sameTimeOrder, type Db } from "../src/db/index.js";
import { BACKUP_TABLES, BackupService, decodeBackup, encryptJsonBackup, restoreBackup } from "../src/services/backupService.js";
import { applyOp, groupNameCheck, watchOrder, WATCH_GROUP_LIMIT, type OrderStock, type WatchGroup, type WatchLayout, type WatchOp } from "../src/services/watchGroupService.js";
import { fakeProviders } from "./helpers.js";

/**
 * 관심 종목 그룹·순서 서버 (3-34, 플래그 watchGroups): 마이그레이션(표 하나 + registered_stocks 두 칸, 두 번 돌아도 안전),
 * 만들기·이름·지우기·그룹 순서·옮기기와 한국어 오류 글, 꺼짐(GET 빈 값 · DB 읽기 0 · 쓰기 409), 공용 픽스처(앱과 같은 규칙),
 * 예전 앱 안전(/api/stocks 칸 그대로), 등록·수정·삭제·마스터 갱신이 두 칸을 건드리지 않음, 백업.
 * 시계는 2026-09-28 21:00 (서울) 고정, 네트워크 없음
 */
const NOW = () => new Date("2026-09-28T21:00:00+09:00");

let apps: FastifyInstance[] = [];
let dbs: Db[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const d of dbs) await d.destroy();
  apps = [];
  dbs = [];
});

/** watch_groups · registered_stocks 를 건드린 쿼리 수 (꺼짐에서 DB 를 읽지 않는지) */
function counting(db: Db): { db: Db; hits: () => number; reset: () => void } {
  let n = 0;
  const plugin: KyselyPlugin = {
    transformQuery: (args) => {
      const text = JSON.stringify(args.node);
      if (text.includes("watch_groups") || text.includes("watch_group_id") || text.includes("registered_stocks")) n++;
      return args.node;
    },
    transformResult: async (args) => args.result,
  };
  return { db: db.withPlugin(plugin), hits: () => n, reset: () => void (n = 0) };
}

async function setup(o: { db?: Db } = {}) {
  const base = o.db ?? (await createMigratedDb(":memory:"));
  if (!o.db) dbs.push(base);
  const c = counting(base);
  const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db: c.db, providers: fakeProviders(), logger: false, enableScheduler: false, now: NOW });
  apps.push(app);
  return { app, db: base, hits: c.hits, reset: c.reset };
}

/** 등록 종목 (관심은 수량 null). 등록 시각은 넣은 차례대로 1분씩 */
async function register(db: Db, ...rows: (string | { code: string; quantity?: number | null })[]) {
  const existing = Number((await db.selectFrom("registered_stocks").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst())?.n ?? 0);
  await db
    .insertInto("registered_stocks")
    .values(
      rows.map((r, i) => {
        const code = typeof r === "string" ? r : r.code;
        const quantity = typeof r === "string" ? null : (r.quantity ?? null);
        const at = `2026-09-01T09:${String(existing + i).padStart(2, "0")}:00+09:00`;
        return { code, name: code, market: /^\d/.test(code) ? "KOSPI" : "NASDAQ", quantity, avg_price: quantity ? 100 : null, memo: null, created_at: at, updated_at: at };
      }),
    )
    .execute();
}

const get = async (app: FastifyInstance) => (await app.inject({ method: "GET", url: "/api/watch-groups" })).json() as WatchLayout;
const create = (app: FastifyInstance, name: unknown) => app.inject({ method: "POST", url: "/api/watch-groups", payload: { name } });
const move = (app: FastifyInstance, code: string, groupId: number | null, index: number) => app.inject({ method: "POST", url: "/api/watch-groups/move", payload: { code, groupId, index } });
/** 지금 서버 배치로 본 관심 순서 (앱과 같은 규칙) */
async function order(app: FastifyInstance, db: Db) {
  const layout = await get(app);
  // 서버가 읽는 등록순 (등록 시각 → 같은 시각이면 넣은 차례) = 앱이 받는 /api/stocks 차례
  const rows = await db.selectFrom("registered_stocks").select(["code", "quantity", "created_at"]).orderBy("created_at").orderBy(sameTimeOrder(db)).execute();
  const items = new Map(layout.items.map((i) => [i.code, i]));
  const stocks: OrderStock[] = rows.map((r, seq) => ({ code: r.code, quantity: r.quantity, createdAt: r.created_at, groupId: items.get(r.code)?.groupId ?? null, position: items.get(r.code)?.position ?? null, seq }));
  return watchOrder(layout.groups, stocks).map((g) => [g.groupId === null ? "그룹 없음" : layout.groups.find((x) => x.id === g.groupId)!.name, ...g.codes]);
}

describe("공용 픽스처 (앱 lib/watchGroups 와 같은 규칙)", () => {
  const orderFx = JSON.parse(readFileSync(new URL("../../shared/fixtures/watchOrder.json", import.meta.url), "utf8")) as {
    cases: { name: string; groups: WatchGroup[]; stocks: Omit<OrderStock, "seq">[]; op: WatchOp | null; order: { groupId: number | null; codes: string[] }[] }[];
  };
  const nameFx = JSON.parse(readFileSync(new URL("../../shared/fixtures/watchGroupNames.json", import.meta.url), "utf8")) as {
    limit: number;
    maxLength: number;
    cases: { name: string; existing: string[]; except?: number; ok?: string; error?: string }[];
  };

  it("경우가 충분히 있다", () => {
    expect(orderFx.cases.length).toBeGreaterThanOrEqual(15);
    expect(nameFx.cases.length).toBeGreaterThanOrEqual(20);
    expect(nameFx.limit).toBe(WATCH_GROUP_LIMIT);
  });

  it.each(orderFx.cases.map((c) => [c.name, c] as const))("순서: %s", (_n, c) => {
    // 픽스처 stocks 의 차례 = 서버가 등록순으로 읽은 차례 (seq)
    const stocks = c.stocks.map((s, seq) => ({ ...s, seq }));
    const state = c.op ? applyOp(c.groups, stocks, c.op) : { groups: c.groups, stocks };
    expect(watchOrder(state.groups, state.stocks)).toEqual(c.order);
  });

  it.each(nameFx.cases.map((c, i) => [`${i} ${JSON.stringify(c.name)}`, c] as const))("이름: %s", (_n, c) => {
    const existing = c.existing.map((name, i) => ({ id: i + 1, name }));
    const r = groupNameCheck(c.name, existing, c.except === undefined ? undefined : c.except + 1);
    expect(r).toEqual(c.ok !== undefined ? { ok: true, name: c.ok } : { ok: false, error: c.error });
  });
});

describe("마이그레이션", () => {
  it("새 표 watch_groups 와 registered_stocks 의 두 칸(비어 있음)이 생기고, 두 번 돌아도·칸 하나만 있던 DB 도 깨끗이 올라간다", async () => {
    const { db, dialect } = createDb(":memory:");
    dbs.push(db);
    await migrate(db, dialect);
    const versions = (await sql<{ version: number }>`select version from schema_version order by version`.execute(db)).rows.map((r) => Number(r.version));
    expect(versions.at(-1)).toBe(17); // 처음 12 → main 의 12~16 다음으로 다시 매김
    const cols = async (t: string) => (await sql<{ name: string; type: string }>`select name, type from pragma_table_info(${t})`.execute(db)).rows.map((r) => `${r.name}:${r.type.toUpperCase()}`);
    expect(await cols("watch_groups")).toEqual(["id:INTEGER", "name:TEXT", "position:INTEGER", "created_at:TEXT", "updated_at:TEXT"]);
    expect(await cols("registered_stocks")).toEqual(expect.arrayContaining(["watch_group_id:INTEGER", "watch_position:INTEGER"]));
    await register(db, "005930");
    expect(await db.selectFrom("registered_stocks").select(["watch_group_id", "watch_position"]).execute()).toEqual([{ watch_group_id: null, watch_position: null }]);

    // 한 칸을 더한 뒤 멈춘 DB 흉내: 버전 17 기록만 지우고 칸 하나를 뺀다 → 다시 돌면 남은 칸만 더한다
    await sql`delete from schema_version where version = 17`.execute(db);
    await sql`alter table registered_stocks drop column watch_position`.execute(db);
    await migrate(db, dialect);
    await migrate(db, dialect);
    expect(await cols("registered_stocks")).toEqual(expect.arrayContaining(["watch_group_id:INTEGER", "watch_position:INTEGER"]));
    expect((await sql<{ version: number }>`select version from schema_version where version = 17`.execute(db)).rows).toHaveLength(1);
  });
});

describe("꺼짐 (watchGroups false)", () => {
  it("GET 은 DB 를 읽지 않고 빈 값, 쓰기 5가지는 모두 409 DISABLED (모양 검사보다 먼저), 저장값 그대로 · 다시 켜면 보인다", async () => {
    const { app, db, hits, reset } = await setup();
    await register(db, "005930", "AAPL");
    const g = (await create(app, "반도체")).json() as WatchLayout;
    await move(app, "AAPL", g.created!.id, 0);
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { watchGroups: false } });
    reset();
    expect(await get(app)).toEqual({ on: false, groups: [], items: [] });
    expect(hits()).toBe(0);
    const off = { error: "DISABLED", message: "관심 그룹 기능이 꺼져 있습니다" };
    const writes = [
      create(app, "배당"),
      app.inject({ method: "POST", url: "/api/watch-groups", payload: {} }),
      app.inject({ method: "PATCH", url: `/api/watch-groups/${g.created!.id}`, payload: { name: "다른" } }),
      app.inject({ method: "DELETE", url: `/api/watch-groups/${g.created!.id}` }),
      app.inject({ method: "PUT", url: "/api/watch-groups/order", payload: { ids: "x" } }),
      move(app, "005930", null, -1),
    ];
    for (const r of await Promise.all(writes)) expect([r.statusCode, r.json()]).toEqual([409, off]);
    expect(hits()).toBe(0);
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { watchGroups: true } });
    expect(await get(app)).toEqual({ on: true, groups: [{ id: g.created!.id, name: "반도체", position: 0 }], items: [{ code: "AAPL", groupId: g.created!.id, position: 0 }] });
  });
});

describe("그룹 만들기 · 이름 바꾸기 · 지우기 · 순서", () => {
  it("만들기는 201 + 배치 + created, 맨 끝에 붙는다. 이름은 정리해서 저장", async () => {
    const { app } = await setup();
    const a = await create(app, "  반도체  ");
    expect(a.statusCode).toBe(201);
    expect(a.json()).toEqual({ on: true, groups: [{ id: 1, name: "반도체", position: 0 }], items: [], created: { id: 1, name: "반도체" } });
    const b = (await create(app, "고 배당   주")).json() as WatchLayout;
    expect(b.created).toEqual({ id: 2, name: "고 배당 주" });
    expect(b.groups.map((x) => [x.id, x.name, x.position])).toEqual([
      [1, "반도체", 0],
      [2, "고 배당 주", 1],
    ]);
  });

  it("한국어 오류 글: 빔·10자·예약어는 400, 같은 이름·13번째는 409", async () => {
    const { app } = await setup();
    const err = async (p: Promise<{ statusCode: number; json: () => unknown }>) => {
      const r = await p;
      return [r.statusCode, r.json()];
    };
    expect(await err(create(app, "   "))).toEqual([400, { error: "VALIDATION", message: "이름을 넣어 주세요" }]);
    expect(await err(create(app, 3))).toEqual([400, { error: "VALIDATION", message: "이름을 넣어 주세요" }]);
    expect(await err(app.inject({ method: "POST", url: "/api/watch-groups" }))).toEqual([400, { error: "VALIDATION", message: "이름을 넣어 주세요" }]);
    expect(await err(create(app, "가나다라마바사아자차카"))).toEqual([400, { error: "VALIDATION", message: "이름은 10자까지입니다" }]);
    expect(await err(create(app, "x".repeat(5000)))).toEqual([400, { error: "VALIDATION", message: "이름은 10자까지입니다" }]);
    expect(await err(create(app, " 그룹 없음 "))).toEqual([400, { error: "VALIDATION", message: "‘전체’·‘그룹 없음’은 그룹 이름으로 쓸 수 없습니다" }]);
    expect(await err(create(app, "전체"))).toEqual([400, { error: "VALIDATION", message: "‘전체’·‘그룹 없음’은 그룹 이름으로 쓸 수 없습니다" }]);
    // 보이지 않는 글자(폭 없는 빈칸 U+200B · U+2060 · 이음 U+200D)로 빈 이름·예약어·겹침을 피해 가지 못한다 (예전 앱이 보내도 서버가 막음)
    expect(await err(create(app, "​"))).toEqual([400, { error: "VALIDATION", message: "이름을 넣어 주세요" }]);
    expect(await err(create(app, "전체​"))).toEqual([400, { error: "VALIDATION", message: "‘전체’·‘그룹 없음’은 그룹 이름으로 쓸 수 없습니다" }]);
    expect(await err(create(app, "전‍체"))).toEqual([400, { error: "VALIDATION", message: "‘전체’·‘그룹 없음’은 그룹 이름으로 쓸 수 없습니다" }]);
    expect((await create(app, "ETF")).statusCode).toBe(201);
    expect(await err(create(app, "etf"))).toEqual([409, { error: "DUPLICATE", message: "같은 이름의 그룹이 이미 있습니다" }]);
    expect(await err(create(app, "⁠ETF​"))).toEqual([409, { error: "DUPLICATE", message: "같은 이름의 그룹이 이미 있습니다" }]);
    // 코드 포인트 10자 (이모지 하나 = 1자, 가족 이모지는 7자)
    expect((await create(app, "🚀반도체")).statusCode).toBe(201);
    for (let i = 3; i <= WATCH_GROUP_LIMIT; i++) expect((await create(app, `그룹${i}`)).statusCode).toBe(201);
    expect(await err(create(app, "하나 더"))).toEqual([409, { error: "LIMIT", message: "그룹은 12개까지 만들 수 있습니다" }]);
    expect((await get(app)).groups).toHaveLength(12);
  });

  it("이름 바꾸기: 자기 이름과는 겹쳐도 되고(대소문자만 바꿈) 다른 그룹과는 409, 없는 그룹 404, 번호가 이상하면 400", async () => {
    const { app } = await setup();
    await create(app, "ETF");
    await create(app, "배당");
    const patch = (id: string | number, name: unknown) => app.inject({ method: "PATCH", url: `/api/watch-groups/${id}`, payload: { name } });
    expect(((await patch(1, "etf")).json() as WatchLayout).groups[0]).toEqual({ id: 1, name: "etf", position: 0 });
    expect((await patch(1, "배당")).json()).toEqual({ error: "DUPLICATE", message: "같은 이름의 그룹이 이미 있습니다" });
    const missing = await patch(9, "새 이름");
    expect([missing.statusCode, missing.json()]).toEqual([404, { error: "NOT_FOUND", message: "그룹을 찾을 수 없습니다. 목록을 새로 불러옵니다" }]);
    for (const id of ["0", "-1", "abc", "1.5"]) expect((await patch(id, "x")).json()).toEqual({ error: "VALIDATION", message: "그룹 번호가 올바르지 않습니다" });
    // 12개일 때도 이름 바꾸기는 된다 (한도는 만들기에만)
    for (let i = 3; i <= 12; i++) await create(app, `g${i}`);
    expect((await patch(12, "바꾼 이름")).statusCode).toBe(200);
  });

  it("지우기: 안의 관심 종목은 관심으로 남고 그룹 없음 맨 끝에 원래 순서대로, 보유 종목도 그룹 없음(번호는 그대로), 나머지 그룹 자리는 빈틈 없이", async () => {
    const { app, db } = await setup();
    await register(db, "A", "B", "C", "D", { code: "H", quantity: 3 }, "E");
    const semi = ((await create(app, "반도체")).json() as WatchLayout).created!.id;
    const div = ((await create(app, "배당")).json() as WatchLayout).created!.id;
    const etf = ((await create(app, "ETF")).json() as WatchLayout).created!.id;
    await move(app, "A", semi, 0);
    await move(app, "B", semi, 0); // 반도체: B, A
    await move(app, "H", semi, 1); // 보유 종목도 저장
    await move(app, "E", etf, 0);
    expect(await order(app, db)).toEqual([["반도체", "B", "A"], ["배당"], ["ETF", "E"], ["그룹 없음", "C", "D"]]);
    const before = await db.selectFrom("registered_stocks").select(["code", "updated_at"]).orderBy("code").execute();
    const r = await app.inject({ method: "DELETE", url: `/api/watch-groups/${semi}` });
    expect(r.statusCode).toBe(200);
    expect((r.json() as WatchLayout).groups).toEqual([
      { id: div, name: "배당", position: 0 },
      { id: etf, name: "ETF", position: 1 },
    ]);
    expect(await order(app, db)).toEqual([["배당"], ["ETF", "E"], ["그룹 없음", "C", "D", "B", "A"]]);
    expect(await db.selectFrom("registered_stocks").select(["code", "watch_group_id", "watch_position"]).where("code", "=", "H").executeTakeFirst()).toEqual({ code: "H", watch_group_id: null, watch_position: 1 });
    // 관심 해제가 아니다 · 보유 정보 수정 시각은 그대로
    expect(await db.selectFrom("registered_stocks").select(["code", "updated_at"]).orderBy("code").execute()).toEqual(before);
    expect((await app.inject({ method: "DELETE", url: `/api/watch-groups/${semi}` })).statusCode).toBe(404);
  });

  it("그룹 순서: 지금과 정확히 같은 번호들만 (빠짐·겹침·모르는 번호는 409 STALE), 모양이 틀리면 400", async () => {
    const { app } = await setup();
    for (const n of ["가", "나", "다"]) await create(app, n);
    const put = (ids: unknown) => app.inject({ method: "PUT", url: "/api/watch-groups/order", payload: { ids } });
    expect(((await put([3, 1, 2])).json() as WatchLayout).groups.map((g) => [g.name, g.position])).toEqual([
      ["다", 0],
      ["가", 1],
      ["나", 2],
    ]);
    const stale = { error: "STALE", message: "그룹 목록이 바뀌었습니다. 새로 불러온 뒤 다시 해 주세요" };
    for (const ids of [[3, 1], [3, 1, 1], [3, 1, 2, 4]]) {
      const r = await put(ids);
      expect([r.statusCode, r.json()]).toEqual([409, stale]);
    }
    for (const ids of ["3,1,2", [1, "x", 2], [1, 0, 2], null]) expect((await put(ids)).json()).toEqual({ error: "VALIDATION", message: "그룹 번호가 올바르지 않습니다" });
    expect((await get(app)).groups.map((g) => g.name)).toEqual(["다", "가", "나"]);
  });
});

describe("옮기기", () => {
  it("같은 그룹 안·다른 그룹·그룹 없음, 범위 밖 자리는 맨 끝, 바뀐 줄만 쓰고 updated_at 은 그대로", async () => {
    const { app, db } = await setup();
    await register(db, "A", "B", "C", "D");
    const semi = ((await create(app, "반도체")).json() as WatchLayout).created!.id;
    expect(await order(app, db)).toEqual([["반도체"], ["그룹 없음", "A", "B", "C", "D"]]);
    await move(app, "C", semi, 0);
    await move(app, "A", semi, 99);
    expect(await order(app, db)).toEqual([["반도체", "C", "A"], ["그룹 없음", "B", "D"]]);
    await move(app, "A", semi, 0);
    expect(await order(app, db)).toEqual([["반도체", "A", "C"], ["그룹 없음", "B", "D"]]);
    const r = await move(app, "c", null, 1); // 코드는 대문자로
    expect(r.statusCode).toBe(200);
    expect((r.json() as WatchLayout).items).toEqual([
      { code: "A", groupId: semi, position: 0 },
      { code: "B", groupId: null, position: 0 },
      { code: "C", groupId: null, position: 1 },
      { code: "D", groupId: null, position: 2 },
    ]);
    expect(await order(app, db)).toEqual([["반도체", "A"], ["그룹 없음", "B", "C", "D"]]);
    expect((await db.selectFrom("registered_stocks").select("updated_at").distinct().execute()).length).toBe(4); // 등록 때 그대로 (넷 다 다른 시각)
    expect(await db.selectFrom("registered_stocks").select("updated_at").where("code", "=", "A").executeTakeFirst()).toEqual({ updated_at: "2026-09-01T09:00:00+09:00" });
  });

  it("보유 종목도 받아 저장하고 같은 그룹의 보유 종목 번호는 그대로 — 다 팔면 대략 원래 자리", async () => {
    const { app, db } = await setup();
    await register(db, "A", { code: "H", quantity: 5 }, "B");
    const semi = ((await create(app, "반도체")).json() as WatchLayout).created!.id;
    await move(app, "A", semi, 0);
    await move(app, "H", semi, 1);
    await move(app, "B", semi, 2);
    expect(await order(app, db)).toEqual([["반도체", "A", "B"], ["그룹 없음"]]);
    await move(app, "B", semi, 0); // B, A — H 는 1 그대로
    expect(await db.selectFrom("registered_stocks").select(["code", "watch_position"]).orderBy("code").execute()).toEqual([
      { code: "A", watch_position: 1 },
      { code: "B", watch_position: 0 },
      { code: "H", watch_position: 1 },
    ]);
    await db.updateTable("registered_stocks").set({ quantity: null, avg_price: null }).where("code", "=", "H").execute(); // 다 팔았다
    expect(await order(app, db)).toEqual([["반도체", "B", "A", "H"], ["그룹 없음"]]); // 번호가 겹치면 등록 시각 (A 가 H 보다 먼저 등록)
  });

  it("오류: 없는 종목·없는 그룹 404, 자리·그룹 번호·코드 모양이 틀리면 400 (한국어)", async () => {
    const { app, db } = await setup();
    await register(db, "A");
    const e = async (code: unknown, groupId: unknown, index: unknown) => {
      const r = await app.inject({ method: "POST", url: "/api/watch-groups/move", payload: { code, groupId, index } as object });
      return [r.statusCode, r.json()];
    };
    expect(await e("ZZZ", null, 0)).toEqual([404, { error: "NOT_FOUND", message: "등록되지 않은 종목입니다: ZZZ" }]);
    expect(await e("A", 5, 0)).toEqual([404, { error: "NOT_FOUND", message: "그룹을 찾을 수 없습니다. 목록을 새로 불러옵니다" }]);
    expect(await e("A", null, -1)).toEqual([400, { error: "VALIDATION", message: "자리 번호가 올바르지 않습니다" }]);
    expect(await e("A", null, 1.5)).toEqual([400, { error: "VALIDATION", message: "자리 번호가 올바르지 않습니다" }]);
    expect(await e("A", null, "0")).toEqual([400, { error: "VALIDATION", message: "자리 번호가 올바르지 않습니다" }]);
    expect(await e("A", 0, 0)).toEqual([400, { error: "VALIDATION", message: "그룹 번호가 올바르지 않습니다" }]);
    expect(await e("A", undefined, 0)).toEqual([400, { error: "VALIDATION", message: "그룹 번호가 올바르지 않습니다" }]);
    expect(await e("", null, 0)).toEqual([400, { error: "VALIDATION", message: "종목 코드를 넣어 주세요" }]);
    expect(await e("a/b", null, 0)).toEqual([404, { error: "NOT_FOUND", message: "등록되지 않은 종목입니다: A/B" }]);
  });

  it("빠르게 여러 번(↑↑↑): 차례로 보내면 마지막 결과, 동시에 와도 한 번에 하나씩 계산해 자리가 겹치거나 빠지지 않는다", async () => {
    const { app, db } = await setup();
    await register(db, "A", "B", "C", "D");
    for (const i of [2, 1, 0]) await move(app, "D", null, i);
    expect(await order(app, db)).toEqual([["그룹 없음", "D", "A", "B", "C"]]);
    await Promise.all([move(app, "C", null, 0), move(app, "B", null, 0), move(app, "A", null, 3), move(app, "D", null, 1)]);
    const rows = await db.selectFrom("registered_stocks").select(["code", "watch_position"]).execute();
    expect(rows.map((r) => r.watch_position).sort()).toEqual([0, 1, 2, 3]);
  });

  it("없는 그룹을 가리키는 칸(복구 등)은 그룹 없음으로 보고 응답에서도 null", async () => {
    const { app, db } = await setup();
    await register(db, "A", "B");
    await db.updateTable("registered_stocks").set({ watch_group_id: 77, watch_position: 0 }).where("code", "=", "B").execute();
    const layout = await get(app);
    expect(layout.items).toEqual([{ code: "B", groupId: null, position: 0 }]);
    expect(await order(app, db)).toEqual([["그룹 없음", "B", "A"]]);
  });
});

describe("같은 등록 시각 — 토스 가져오기 한 번에 들어온 종목 (3-34 3차 검토)", () => {
  /** 같은 등록 시각으로 넣은 차례대로 (토스 동기화가 한 번에 넣는 모양) */
  async function batch(db: Db, codes: string[]) {
    const at = "2026-09-10T21:00:00+09:00";
    for (const code of codes) await db.insertInto("registered_stocks").values({ code, name: code, market: /^\d/.test(code) ? "KOSPI" : "NASDAQ", quantity: null, avg_price: null, memo: null, created_at: at, updated_at: at }).execute();
  }
  const listCodes = async (app: FastifyInstance) => ((await app.inject({ method: "GET", url: "/api/stocks" })).json() as { code: string }[]).map((s) => s.code);

  it("/api/stocks(플래그를 끈 잔고 순서)는 넣은 차례 그대로 — 행을 고친 뒤에도, 관심 순서 규칙(자리를 정하지 않음)도 같은 차례 (코드 순이 아님)", async () => {
    const { app, db } = await setup();
    await register(db, "FIRST");
    await batch(db, ["ZZZ", "005930", "AAPL", "MSFT"]);
    expect(await listCodes(app)).toEqual(["FIRST", "ZZZ", "005930", "AAPL", "MSFT"]);
    // 수량·메모를 고쳐도 차례는 그대로 (SQLite 는 행 번호가 바뀌지 않는다)
    await db.updateTable("registered_stocks").set({ memo: "메모", updated_at: "2026-09-28T21:00:00+09:00" }).where("code", "=", "ZZZ").execute();
    expect(await listCodes(app)).toEqual(["FIRST", "ZZZ", "005930", "AAPL", "MSFT"]);
    await create(app, "반도체");
    expect(await order(app, db)).toEqual([["반도체"], ["그룹 없음", "FIRST", "ZZZ", "005930", "AAPL", "MSFT"]]);
  });

  it("같은 시각 종목 사이 옮기기: 번호를 매길 때도 넣은 차례 (앱 낙관적 반영 · 공용 픽스처와 같은 답)", async () => {
    const { app, db } = await setup();
    await batch(db, ["ZZZ", "005930", "AAPL", "MSFT"]);
    const r = await move(app, "MSFT", null, 0);
    expect((r.json() as WatchLayout).items).toEqual([
      { code: "005930", groupId: null, position: 2 },
      { code: "AAPL", groupId: null, position: 3 },
      { code: "MSFT", groupId: null, position: 0 },
      { code: "ZZZ", groupId: null, position: 1 },
    ]);
    expect(await order(app, db)).toEqual([["그룹 없음", "MSFT", "ZZZ", "005930", "AAPL"]]);
    // 그룹 지우기도: 자리 없이 그룹에 든 같은 시각 종목(복구한 칸 등)을 넣은 차례로 붙인다
    const semi = ((await create(app, "반도체")).json() as WatchLayout).created!.id;
    await batch(db, ["TSLA", "KO"]);
    await db.updateTable("registered_stocks").set({ watch_group_id: semi, watch_position: null }).where("code", "in", ["TSLA", "KO"]).execute();
    expect(await order(app, db)).toEqual([["반도체", "TSLA", "KO"], ["그룹 없음", "MSFT", "ZZZ", "005930", "AAPL"]]);
    await app.inject({ method: "DELETE", url: `/api/watch-groups/${semi}` });
    expect(await order(app, db)).toEqual([["그룹 없음", "MSFT", "ZZZ", "005930", "AAPL", "TSLA", "KO"]]);
    expect(await db.selectFrom("registered_stocks").select(["code", "watch_position"]).where("code", "in", ["TSLA", "KO"]).orderBy("code").execute()).toEqual([
      { code: "KO", watch_position: 5 },
      { code: "TSLA", watch_position: 4 },
    ]);
  });
});

describe("예전 앱 안전 · 다른 쓰기와 칸", () => {
  it("/api/stocks 응답 칸은 3-34 전과 같고(watch_* 없음), PATCH 에 그룹 칸을 보내도 무시, 메모 수정·마스터 갱신은 두 칸을 유지", async () => {
    const { app, db } = await setup();
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    expect((await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930" } })).statusCode).toBe(201);
    const semi = ((await create(app, "반도체")).json() as WatchLayout).created!.id;
    await move(app, "005930", semi, 0);
    const list = (await app.inject({ method: "GET", url: "/api/stocks?quotes=1" })).json() as Record<string, unknown>[];
    expect(Object.keys(list[0]!).filter((k) => /watch/i.test(k))).toEqual([]);
    expect(Object.keys((await app.inject({ method: "GET", url: "/api/stocks/005930" })).json() as object).filter((k) => /watch/i.test(k))).toEqual([]);
    const p = await app.inject({ method: "PATCH", url: "/api/stocks/005930", payload: { memo: "메모", watchGroupId: null, watch_group_id: null, watchPosition: 5 } });
    expect(p.statusCode).toBe(200);
    expect(Object.keys(p.json() as object).filter((k) => /watch/i.test(k))).toEqual([]);
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    expect(await db.selectFrom("registered_stocks").select(["memo", "watch_group_id", "watch_position"]).executeTakeFirst()).toEqual({ memo: "메모", watch_group_id: semi, watch_position: 0 });
  });

  it("새로 등록하면 그룹 없음(칸 비어 있음), 관심 해제 뒤 다시 등록해도 그룹 없음 맨 끝", async () => {
    const { app, db } = await setup();
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    for (const code of ["005930", "000660", "247540"]) await app.inject({ method: "POST", url: "/api/stocks", payload: { code } });
    const semi = ((await create(app, "반도체")).json() as WatchLayout).created!.id;
    await move(app, "005930", semi, 0);
    await move(app, "247540", null, 0);
    expect((await app.inject({ method: "DELETE", url: "/api/stocks/005930" })).statusCode).toBe(204);
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930" } });
    expect(await db.selectFrom("registered_stocks").select(["watch_group_id", "watch_position"]).where("code", "=", "005930").executeTakeFirst()).toEqual({ watch_group_id: null, watch_position: null });
    expect(await order(app, db)).toEqual([["반도체"], ["그룹 없음", "247540", "000660", "005930"]]);
  });
});

describe("재시작·재배포 뒤 유지 (로드맵 완료 기준)", () => {
  it("파일 DB: 그룹·순서를 바꾸고 서버를 닫았다가 다시 열면(마이그레이션이 다시 돎) 배치가 그대로", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wg-db-"));
    const file = join(dir, "app.sqlite");
    const first = await createMigratedDb(file);
    await register(first, "A", "B", "C", "D");
    const app1 = await buildApp({ config: loadConfig({ DATABASE_URL: file }), db: first, providers: fakeProviders(), logger: false, enableScheduler: false, now: NOW });
    const semi = ((await create(app1, "반도체")).json() as WatchLayout).created!.id;
    await create(app1, "배당");
    await move(app1, "C", semi, 0);
    await move(app1, "A", semi, 1);
    await move(app1, "D", null, 0);
    await app1.inject({ method: "PUT", url: "/api/watch-groups/order", payload: { ids: [semi + 1, semi] } });
    const before = await get(app1);
    const orderBefore = await order(app1, first);
    await app1.close();
    await first.destroy();
    const second = await createMigratedDb(file);
    dbs.push(second);
    const app2 = await buildApp({ config: loadConfig({ DATABASE_URL: file }), db: second, providers: fakeProviders(), logger: false, enableScheduler: false, now: NOW });
    apps.push(app2);
    expect(await get(app2)).toEqual(before);
    expect(await order(app2, second)).toEqual(orderBefore);
    expect(orderBefore).toEqual([["배당"], ["반도체", "C", "A"], ["그룹 없음", "D", "B"]]);
  });
});

describe("백업 (3-7)", () => {
  const KEY = "test-key-not-a-secret";

  it("watch_groups 는 백업 표 목록 끝에 있고, JSON 백업의 그룹·종목 칸을 빈 DB 에 되살린다. 칸이 없는 예전 백업은 그룹 없음(null)", async () => {
    expect(BACKUP_TABLES.at(-1)).toBe("watch_groups");
    const dir = await mkdtemp(join(tmpdir(), "wg-bk-"));
    const file = join(dir, "j.sbk");
    const group = { id: 4, name: "반도체", position: 0, created_at: "2026-09-28T20:00:00+09:00", updated_at: "2026-09-28T20:00:00+09:00" };
    const stock = { code: "005930", name: "삼성전자", market: "KOSPI", quantity: null, avg_price: null, memo: null, created_at: "t", updated_at: "t" };
    await encryptJsonBackup({ version: 1, createdAt: "t", tables: { watch_groups: [group], registered_stocks: [{ ...stock, watch_group_id: 4, watch_position: 2 }, { ...stock, code: "000660" }] } }, file, KEY);
    const decoded = await decodeBackup(await readFile(file), KEY);
    if (decoded.kind !== "json") throw new Error("json 이어야 함");
    const fresh = createDb(":memory:");
    dbs.push(fresh.db);
    await migrate(fresh.db, fresh.dialect);
    const counts = await restoreBackup(fresh.db, fresh.dialect, decoded.payload);
    expect([counts["watch_groups"], counts["registered_stocks"]]).toEqual([1, 2]);
    expect(await fresh.db.selectFrom("watch_groups").selectAll().execute()).toEqual([group]);
    expect(await fresh.db.selectFrom("registered_stocks").select(["code", "watch_group_id", "watch_position"]).orderBy("code").execute()).toEqual([
      { code: "000660", watch_group_id: null, watch_position: null },
      { code: "005930", watch_group_id: 4, watch_position: 2 },
    ]);
    // 되살린 뒤 새 그룹 번호가 겹치지 않는다
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db: fresh.db, providers: fakeProviders(), logger: false, enableScheduler: false, now: NOW });
    apps.push(app);
    expect(((await create(app, "배당")).json() as WatchLayout).created!.id).toBe(5);
  });

  it("SQLite 백업 뒤 줄 수에 watch_groups 가 들어간다", async () => {
    const { app, db } = await setup();
    await create(app, "반도체");
    await create(app, "배당");
    const dir = await mkdtemp(join(tmpdir(), "wg-bk-"));
    const st = await new BackupService({ db, dialect: "sqlite", dir, key: KEY, now: NOW }).run();
    expect(st.lastCounts?.["watch_groups"]).toBe(2);
  });
});
