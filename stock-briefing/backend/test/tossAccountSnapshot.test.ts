import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, createMigratedDb, type Db } from "../src/db/index.js";
import { TossOpenApiProvider } from "../src/providers/market/tossOpenApi.js";
import { TossAccountSnapshotStore, TOSS_ACCOUNT_SNAPSHOT_KEY, parseTossAccountTotals, sumTossAccountTotals, type TossAccountSnapshot } from "../src/services/tossAccountSnapshot.js";
import { EXCLUDED_KEY, HoldingsAutoSync, TossSyncService } from "../src/services/tossSyncService.js";
import { fakeProviders } from "./helpers.js";

const START = "2026-10-04T10:00:00+09:00";
const pgUrl = process.env["TEST_PG_URL"];
const now = () => new Date(START);
const item = (symbol = "005930", currency = "KRW") => ({ symbol, name: symbol, quantity: "1", currency, averagePurchasePrice: "10", marketValue: { amount: "15", amountAfterCost: "14", purchaseAmount: "10" } });
const raw = (items: unknown[] = [item()], krw: unknown = "15.125", usd: unknown = "0", netKrw: unknown = "14.115", netUsd: unknown = "0") => ({
  items, totalPurchaseAmount: { krw: "10", usd: "0" }, marketValue: { amount: { krw, usd }, amountAfterCost: { krw: netKrw, usd: netUsd } }, profitLoss: { rateAfterCost: "0" },
});

describe("토스 원본 계좌 평가 엄격 해석", () => {
  it("한 응답의 원액을 반올림·현재가 재계산 없이 보존한다", () => {
    expect(parseTossAccountTotals(raw([item()], "0.125", "1.234567", "0.115", "1.224567"))).toEqual({ gross: { krw: 0.125, usd: 1.234567 }, net: { krw: 0.115, usd: 1.224567 } });
  });
  it.each([undefined, null, "", " ", false, true, "NaN", "Infinity", -1, "-1", {}, [], "1,000"])("유효하지 않은 KRW 원액 %j 는 0으로 바꾸지 않는다", (value) => {
    const body = raw();
    body.marketValue.amount.krw = value;
    expect(parseTossAccountTotals(body)).toBeNull();
  });
  it("해외 보유 없음이 확인된 명시적 USD null만 0달러로 읽는다", () => {
    expect(parseTossAccountTotals(raw([item()], "15", null, "14", null))).toEqual({ gross: { krw: 15, usd: 0 }, net: { krw: 14, usd: 0 } });
    expect(parseTossAccountTotals(raw([item("TSLA", "USD")], "15", null, "14", null))).toBeNull();
    const missing = raw();
    delete (missing.marketValue.amount as { usd?: unknown }).usd;
    expect(parseTossAccountTotals(missing)).toBeNull();
    const invalid = raw([{ currency: "KRW", quantity: "x", symbol: "A" }], "15", null, "14", null);
    expect(parseTossAccountTotals(invalid)).toBeNull();
  });
  it("통화 요약 누락·비용후 금액이 비용전보다 큼·불완전 종목 목록은 거절한다", () => {
    expect(parseTossAccountTotals({ items: [] })).toBeNull();
    expect(parseTossAccountTotals(raw([], "1", "0", "2", "0"))).toBeNull();
    expect(parseTossAccountTotals(raw([null]))).toBeNull();
  });
  it("다계좌 합산은 원액 소수 정밀도를 보존하고 일부 누락을 합계로 발표하지 않는다", () => {
    const a = parseTossAccountTotals(raw([], "0.1", "0.01", "0.09", "0.001"))!;
    const b = parseTossAccountTotals(raw([], "0.2", "0.02", "0.19", "0.002"))!;
    expect(sumTossAccountTotals([a, b])).toEqual({ gross: { krw: 0.3, usd: 0.03 }, net: { krw: 0.28, usd: 0.003 } });
    expect(sumTossAccountTotals([a, null])).toBeNull();
    expect(sumTossAccountTotals([])).toBeNull();
  });
});

async function fixture() {
  const db = await createMigratedDb(":memory:");
  let time = now().getTime();
  let enabled = true;
  const bodies = new Map<number, ReturnType<typeof raw>>([[1, raw()]]);
  let accounts = [1];
  const calls: string[] = [];
  const client = { get: vi.fn(async (path: string, _query: unknown, headers: Record<string, string> = {}) => {
    calls.push(path);
    if (path === "/api/v1/accounts") return accounts.map((accountSeq) => ({ accountSeq, accountNo: `private-${accountSeq}`, accountType: "BROKERAGE" }));
    if (path === "/api/v1/holdings") { time += 1_000; return bodies.get(Number(headers["X-Tossinvest-Account"])); }
    throw new Error("추가 외부 호출은 허용하지 않습니다");
  }) };
  const provider = new TossOpenApiProvider(client as never, { now: () => new Date(time) });
  vi.spyOn(provider, "stockInfos").mockImplementation(async (codes) => new Map(codes.map((code) => [code, { name: code, market: /^\d/.test(code) ? "KOSPI" : "NASDAQ" }])) as never);
  const fx = vi.fn(async () => 1398.765);
  const sync = new TossSyncService(db, provider, () => new Date(time), fx, undefined, async () => enabled);
  vi.spyOn(sync.costBook, "update").mockResolvedValue(undefined);
  return { db, bodies, provider, calls, sync, fx, setAccounts: (values: number[]) => { accounts = values; }, setEnabled: (value: boolean) => { enabled = value; }, advance: () => { time += 60_000; } };
}

describe("토스 원본 계좌 평가 보존·실패·조회", () => {
  it("화면용 추가 동기화도 같은 입력의 원액·비용·환산 기준과 누락 상태를 보존하고 수신 시각만 갱신한다", async () => {
    const f = await fixture();
    const onResult = vi.fn(async () => undefined);
    const auto = new HoldingsAutoSync({ sync: f.sync, intervalMin: 10, now, onResult });
    try {
      await auto.run("schedule");
      const before = await f.sync.accountSnapshots.load();
      const beforeHoldings = await f.db.selectFrom("registered_stocks").selectAll().orderBy("code").execute();
      await auto.run("view");
      // 가짜 출처는 조회할 때마다 시계를 1초 전진시킨다. 수신 시각은 새 조회를 정확히 가리켜야 한다.
      expect(before.snapshot?.receivedAt).toBe("2026-10-04T10:00:01+09:00");
      expect(await f.sync.accountSnapshots.load()).toEqual({ ...before, snapshot: { ...before.snapshot,
        receivedFrom: "2026-10-04T10:00:02+09:00", receivedAt: "2026-10-04T10:00:02+09:00",
        displayFx: { ...before.snapshot?.displayFx, receivedAt: "2026-10-04T10:00:02+09:00" },
      } });
      expect(await f.db.selectFrom("registered_stocks").selectAll().orderBy("code").execute()).toEqual(beforeHoldings);
      expect(f.calls).toEqual(["/api/v1/accounts", "/api/v1/holdings", "/api/v1/accounts", "/api/v1/holdings"]);
      expect(onResult).toHaveBeenCalledTimes(1);
    } finally { await f.db.destroy(); }
  });
  it("저장된 금액이 문자열로 바뀌어도 조회 응답은 검증한 숫자만 반환한다", async () => {
    const f = await fixture();
    try {
      await f.sync.importHoldings();
      const original = (await f.sync.accountSnapshots.load()).snapshot!;
      const stored = { ...original, gross: { krw: "15.125", usd: "1.125" }, net: { krw: "14.115", usd: "1.015" } };
      await f.db.updateTable("meta").set({ value: JSON.stringify(stored) }).where("key", "=", TOSS_ACCOUNT_SNAPSHOT_KEY).execute();
      const loaded = (await f.sync.accountSnapshots.load()).snapshot!;
      expect(loaded.gross).toEqual({ krw: 15.125, usd: 1.125 });
      expect(loaded.net).toEqual({ krw: 14.115, usd: 1.015 });
      expect(loaded.gross.krw + loaded.gross.usd * 1_400).toBe(1_590.125);
    } finally { await f.db.destroy(); }
  });
  it.runIf(pgUrl)("격리 PostgreSQL 두 저장소의 역전 쓰기를 막고 실제 트리거 실패 때 시각·금액을 함께 롤백한다", async () => {
    const url = new URL(pgUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("로컬 격리 DB만 허용합니다");
    const admin = createDb(pgUrl!).db;
    const name = `toss_snapshot_${randomUUID().replaceAll("-", "")}`;
    let created = false;
    let firstDb: Db | undefined;
    let secondDb: Db | undefined;
    try {
      await sql`create database ${sql.id(name)}`.execute(admin);
      created = true;
      url.pathname = `/${name}`;
      firstDb = await createMigratedDb(url.toString());
      secondDb = createDb(url.toString()).db;
      const first = new TossAccountSnapshotStore(firstDb), second = new TossAccountSnapshotStore(secondDb);
      const old: TossAccountSnapshot = { source: "toss-openapi", scope: "all-toss-stock-holdings", excludesCash: true, includesExcludedHoldings: true,
        receivedFrom: START, receivedAt: START, accountCount: 1, holdingCount: 1, excludedHoldingCount: 0,
        gross: { krw: 15.125, usd: 1.125 }, net: { krw: 14.115, usd: 1.015 }, displayFx: null };
      const newer = { ...old, receivedFrom: "2026-10-04T10:01:00+09:00", receivedAt: "2026-10-04T10:01:00+09:00", gross: { krw: 25.125, usd: 2.125 } };
      await first.save(old);
      await second.save(newer);
      await first.save(old);
      expect((await first.load()).snapshot).toEqual(newer);
      expect((await second.load()).snapshot).toEqual(newer);
      await sql.raw(`CREATE FUNCTION fail_toss_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = '${TOSS_ACCOUNT_SNAPSHOT_KEY}' THEN RAISE EXCEPTION 'test snapshot save failure'; END IF; RETURN NEW; END $$`).execute(firstDb);
      await sql.raw("CREATE TRIGGER fail_toss_snapshot BEFORE INSERT OR UPDATE ON meta FOR EACH ROW EXECUTE FUNCTION fail_toss_snapshot()").execute(firstDb);
      const failed = { ...newer, receivedFrom: "2026-10-04T10:03:00+09:00", receivedAt: "2026-10-04T10:03:00+09:00", gross: { krw: 999, usd: 999 } };
      await expect(first.save(failed)).rejects.toThrow("test snapshot save failure");
      expect((await second.load()).snapshot).toEqual(newer);
      expect((await secondDb.selectFrom("meta").select("value").where("key", "=", "toss_account_snapshot_received_at").executeTakeFirstOrThrow()).value).toBe(newer.receivedAt);
      await sql.raw("DROP TRIGGER fail_toss_snapshot ON meta").execute(firstDb);
      await sql.raw("DROP FUNCTION fail_toss_snapshot()").execute(firstDb);
      // 실패한 10:03의 시각까지 롤백돼야 10:02 응답을 새 값으로 받을 수 있다.
      const recovered = { ...newer, receivedFrom: "2026-10-04T10:02:00+09:00", receivedAt: "2026-10-04T10:02:00+09:00", gross: { krw: 35.125, usd: 3.125 } };
      await second.save(recovered);
      expect((await first.load()).snapshot).toEqual(recovered);
    } finally {
      await secondDb?.destroy();
      await firstDb?.destroy();
      if (created) await sql`drop database ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    }
  });
  it("동기화 제외 종목도 전체 평가에 포함하되 앱에 다시 등록하지 않고 기존 외부 조회 수를 유지한다", async () => {
    const f = await fixture();
    try {
      f.bodies.set(1, raw([item(), item("APH", "USD")], "15.125", "31.002", "14.115", "30.002"));
      await f.db.insertInto("meta").values({ key: EXCLUDED_KEY, value: JSON.stringify(["APH"]) }).execute();
      await f.sync.importHoldings();
      const stored = await f.sync.accountSnapshots.load();
      expect(stored.lastError).toBeNull();
      expect(stored.snapshot).toMatchObject({ gross: { krw: 15.125, usd: 31.002 }, net: { krw: 14.115, usd: 30.002 }, holdingCount: 2, excludedHoldingCount: 1, accountCount: 1, excludesCash: true, includesExcludedHoldings: true, displayFx: { usdKrw: 1398.765, kind: "reference", source: "app-display-fx" } });
      expect(await f.db.selectFrom("registered_stocks").select("code").execute()).toEqual([{ code: "005930" }]);
      expect(f.calls).toEqual(["/api/v1/accounts", "/api/v1/holdings"]);
      expect(f.fx).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(stored)).not.toContain("private-");
      expect(await new TossAccountSnapshotStore(f.db).load()).toEqual(stored);
    } finally { await f.db.destroy(); }
  });
  it("다계좌 원액 합계와 중복 제외한 종목수, 순차 응답 수신 구간을 보존한다", async () => {
    const f = await fixture();
    try {
      f.setAccounts([1, 2]);
      f.bodies.set(2, raw([item()], "0.2", "0.2", "0.19", "0.19"));
      await f.sync.importHoldings();
      const snapshot = (await f.sync.accountSnapshots.load()).snapshot!;
      expect(snapshot).toMatchObject({ accountCount: 2, holdingCount: 1, gross: { krw: 15.325, usd: 0.2 }, net: { krw: 14.305, usd: 0.19 } });
      expect(Date.parse(snapshot.receivedAt) - Date.parse(snapshot.receivedFrom)).toBe(1_000);
      expect(f.calls).toEqual(["/api/v1/accounts", "/api/v1/holdings", "/api/v1/holdings"]);
    } finally { await f.db.destroy(); }
  });
  it("정상 빈 계좌의 0원·명시적 null USD는 유효한 빈 평가이며 계좌 목록 없음과 구분한다", async () => {
    const f = await fixture();
    try {
      const empty = raw([], "0", null, "0", null);
      empty.totalPurchaseAmount = { krw: "0", usd: "0" };
      f.bodies.set(1, empty);
      await f.sync.importHoldings();
      const before = (await f.sync.accountSnapshots.load()).snapshot;
      expect(before).toMatchObject({ holdingCount: 0, gross: { krw: 0, usd: 0 }, net: { krw: 0, usd: 0 } });
      f.setAccounts([]);
      await expect(f.sync.importHoldings()).rejects.toThrow("계좌 목록이 비었습니다");
      expect(await f.sync.accountSnapshots.load()).toEqual({ snapshot: before, lastError: expect.stringContaining("실패") });
    } finally { await f.db.destroy(); }
  });
  it.each(["필드 누락", "해외 null", "요약과 다른 빈 목록", "목록에서 계좌 누락"])("%s 때 새 정상 시각을 만들지 않고 이전 평가와 실패 표시를 유지한다", async (kind) => {
    const f = await fixture();
    try {
      f.setAccounts([1, 2]);
      f.bodies.set(2, raw([item("TSLA", "USD")], "0", "3", "0", "2"));
      await f.sync.importHoldings();
      const before = (await f.sync.accountSnapshots.load()).snapshot;
      f.advance();
      if (kind === "필드 누락") delete (f.bodies.get(1)!.marketValue.amountAfterCost as { usd?: unknown }).usd;
      if (kind === "해외 null") f.bodies.get(2)!.marketValue.amount.usd = null;
      if (kind === "요약과 다른 빈 목록") f.bodies.get(2)!.items = [];
      if (kind === "목록에서 계좌 누락") f.setAccounts([1]);
      await f.sync.importHoldings();
      expect(await f.sync.accountSnapshots.load()).toEqual({ snapshot: before, lastError: expect.stringContaining("불완전") });
      expect(await new TossAccountSnapshotStore(f.db).load()).toEqual(await f.sync.accountSnapshots.load());
    } finally { await f.db.destroy(); }
  });
  it("실제 DB 저장 실패는 기존 값·시각을 유지하고 성공 재시도에서 오류를 지운다", async () => {
    const f = await fixture();
    try {
      await f.sync.importHoldings();
      const before = (await f.sync.accountSnapshots.load()).snapshot;
      await sql.raw(`CREATE TRIGGER fail_account_snapshot BEFORE UPDATE ON meta WHEN NEW.key = '${TOSS_ACCOUNT_SNAPSHOT_KEY}' BEGIN SELECT RAISE(ABORT, 'test disk error'); END`).execute(f.db);
      f.advance();
      f.bodies.set(1, raw([item()], "999", "0", "998", "0"));
      await f.sync.importHoldings();
      expect(await f.sync.accountSnapshots.load()).toEqual({ snapshot: before, lastError: expect.stringContaining("저장하지 못해") });
      await sql.raw("DROP TRIGGER fail_account_snapshot").execute(f.db);
      await f.sync.importHoldings();
      expect(await f.sync.accountSnapshots.load()).toMatchObject({ snapshot: { gross: { krw: 999 } }, lastError: null });
    } finally { await f.db.destroy(); }
  });
  it("늦게 완료된 이전 스냅샷은 새 수신 값과 시각을 덮어쓰지 않는다", async () => {
    const f = await fixture();
    try {
      await f.sync.importHoldings();
      const old = (await f.sync.accountSnapshots.load()).snapshot!;
      f.advance();
      await f.sync.importHoldings();
      const current = (await f.sync.accountSnapshots.load()).snapshot;
      await new TossAccountSnapshotStore(f.db).save({ ...old, gross: { krw: 999, usd: 999 } });
      expect((await f.sync.accountSnapshots.load()).snapshot).toEqual(current);
    } finally { await f.db.destroy(); }
  });
  it("플래그 끔은 저장 0건이며 보유·원화 장부 경로와 외부 호출 수를 유지한다", async () => {
    const f = await fixture();
    try {
      f.setEnabled(false);
      await f.sync.importHoldings();
      expect(await f.sync.accountSnapshots.load()).toEqual({ snapshot: null, lastError: null });
      expect(f.calls).toEqual(["/api/v1/accounts", "/api/v1/holdings"]);
      expect(f.fx).toHaveBeenCalledTimes(1);
      expect(f.sync.costBook.update).toHaveBeenCalledTimes(1);
    } finally { await f.db.destroy(); }
  });
  it("조회는 기존 인증을 따르고 외부 요청·동기화를 만들지 않으며 끄면 숨긴다", async () => {
    const f = await fixture();
    await f.sync.importHoldings();
    const app = await buildApp({ db: f.db, config: loadConfig({ DATABASE_URL: ":memory:", API_TOKEN: "test-only-value" }), providers: fakeProviders({ tossOpenApi: f.provider }), now, logger: false, enableScheduler: false });
    try {
      f.calls.length = 0;
      const url = "/api/admin/toss/account-snapshot";
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { authorization: "Bearer incorrect" } })).statusCode).toBe(401);
      const headers = { authorization: "Bearer test-only-value" };
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ on: true, snapshot: { source: "toss-openapi", gross: { krw: 15.125 } }, sync: { lastError: null } });
      const widget = await app.inject({ url: "/api/widget?account=1", headers });
      expect(widget.statusCode).toBe(200);
      expect(widget.json().tossAccount).toEqual(response.json());
      expect(widget.json().features.tossAccountSnapshot).toBe(true);
      expect(f.calls).toEqual([]);
      await app.inject({ method: "PUT", url: "/api/admin/features", headers, payload: { tossAccountSnapshot: false } });
      expect((await app.inject({ url, headers })).json()).toEqual({ on: false, snapshot: null, sync: null });
      const widgetOff = (await app.inject({ url: "/api/widget?account=1", headers })).json();
      expect(widgetOff.tossAccount).toEqual({ on: false, snapshot: null, sync: null });
      expect(widgetOff.features.tossAccountSnapshot).toBe(false);
      expect(f.calls).toEqual([]);
    } finally { await app.close(); await f.db.destroy(); }
  });
  it("토스 미설정과 손상된 영구 기록은 정상 0원 평가가 아니다", async () => {
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({ db, config: loadConfig({ DATABASE_URL: ":memory:" }), providers: fakeProviders(), now, logger: false, enableScheduler: false });
    try {
      expect((await app.inject({ url: "/api/admin/toss/account-snapshot" })).json()).toEqual({ on: false, snapshot: null, sync: null });
      await db.insertInto("meta").values({ key: TOSS_ACCOUNT_SNAPSHOT_KEY, value: JSON.stringify({ gross: { krw: 1 } } as TossAccountSnapshot) }).execute();
      expect(await new TossAccountSnapshotStore(db).load()).toEqual({ snapshot: null, lastError: expect.stringContaining("확인할 수 없습니다") });
    } finally { await app.close(); await db.destroy(); }
  });
});
