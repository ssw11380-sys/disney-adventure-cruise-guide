import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import type { ListedStock } from "../src/domain/types.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { ProviderError } from "../src/lib/errors.js";
import type { StockSearchProvider } from "../src/providers/market/types.js";
import { StockService } from "../src/services/stockService.js";
import { FakeMasterProvider, FakeQuoteProvider, FakeSearchProvider } from "./helpers.js";

/**
 * DISC-05: NAVER·KT·LG 처럼 영문 대문자 종목명은 티커 모양이라 로컬 검색이 코드만 찾고 이름 검색을 건너뛰었다.
 * 정확한 코드 일치를 먼저, 그 다음 이름 일치/접두/포함을 함께 찾고, 외부 검색이 실패해도 로컬 이름 결과를 돌려준다.
 */

const st = (code: string, name: string, groupCode = "ST"): ListedStock => ({ code, name, market: "KOSPI", isinCode: null, groupCode });

const MASTER: ListedStock[] = [
  st("035420", "NAVER"),
  st("030200", "KT"),
  st("033780", "KT&G"),
  st("003550", "LG"),
  st("066570", "LG전자"),
  st("051910", "LG화학"),
  st("005930", "삼성전자"),
  st("069500", "KODEX 200", "EF"),
  st("122630", "KODEX 레버리지", "EF"),
  st("0162Z0", "RISE 미국AI테크액티브", "EF"),
  // 이름에 다른 종목 코드가 들어간 가상의 ETF (정확한 코드 일치가 먼저인지 보려고)
  st("480000", "PLUS 005930채권혼합", "EF"),
];

class FailingSearch implements StockSearchProvider {
  readonly name = "fake-search";
  calls = 0;
  async search(): Promise<ListedStock[]> {
    this.calls++;
    throw new ProviderError(this.name, "고의 실패");
  }
}

const codes = (r: { results: ListedStock[] }) => r.results.map((s) => s.code);

describe("로컬 종목 검색: 티커 모양의 영문 종목명 (DISC-05)", () => {
  let db: Db | null = null;
  afterEach(async () => {
    await db?.destroy();
    db = null;
  });

  async function setup(opts: { search?: StockSearchProvider; remoteFirst?: boolean; master?: ListedStock[]; caseSensitiveLike?: boolean } = {}) {
    db = await createMigratedDb(":memory:");
    // 운영 Postgres 의 LIKE 는 대소문자를 가린다. SQLite 에서도 같은 조건으로 확인한다
    if (opts.caseSensitiveLike) await sql`PRAGMA case_sensitive_like = ON`.execute(db);
    const service = new StockService({
      db,
      quotes: new FakeQuoteProvider("kis"),
      search: opts.search ?? new FakeSearchProvider(),
      master: new FakeMasterProvider(opts.master ?? MASTER),
      ...(opts.remoteFirst ? { searchRemoteFirst: true } : {}),
    });
    await service.refreshMaster();
    return service;
  }

  it("NAVER 는 코드가 아니어도 이름으로 찾는다 (코드 검색도 그대로)", async () => {
    const service = await setup();
    expect(codes(await service.searchMaster("NAVER"))).toEqual(["035420"]);
    expect(codes(await service.searchMaster("035420"))).toEqual(["035420"]);
    expect((await service.searchMaster("NAVER")).source).toBe("master");
  });

  it("외부 검색이 실패해도 로컬 이름 결과를 돌려준다 (외부 우선·로컬 우선 모두)", async () => {
    const remoteFirst = await setup({ search: new FailingSearch(), remoteFirst: true });
    expect(await remoteFirst.search("NAVER")).toMatchObject({ results: [{ code: "035420", name: "NAVER" }], source: "master" });
    await db!.destroy();
    const failing = new FailingSearch();
    const localFirst = await setup({ search: failing });
    expect(await localFirst.search("NAVER")).toMatchObject({ results: [{ code: "035420", name: "NAVER" }], source: "master" });
    expect(failing.calls).toBe(1); // 티커 모양이라 외부 검색도 시도했다
  });

  it("KT·LG: 이름이 정확히 같은 종목이 먼저, 그 다음 이름이 그걸로 시작하는 종목", async () => {
    const service = await setup({ search: new FailingSearch(), remoteFirst: true });
    expect(codes(await service.search("KT"))).toEqual(["030200", "033780"]);
    const lg = codes(await service.search("LG"));
    expect(lg[0]).toBe("003550");
    expect(new Set(lg)).toEqual(new Set(["003550", "066570", "051910"]));
  });

  it("영문 브랜드 ETF 이름(KODEX)과 띄어 쓴 이름(KODEX 200)도 찾는다", async () => {
    const service = await setup();
    expect(new Set(codes(await service.searchMaster("KODEX")))).toEqual(new Set(["069500", "122630"]));
    expect(codes(await service.searchMaster("KODEX 200"))).toEqual(["069500"]);
    expect(codes(await service.searchMaster("kodex레버리지"))).toEqual(["122630"]);
  });

  it("정확한 코드 일치가 먼저, 이름에 그 코드가 들어간 종목은 뒤에", async () => {
    const service = await setup();
    expect(codes(await service.searchMaster("005930"))).toEqual(["005930", "480000"]);
    expect(codes(await service.searchMaster("0162z0"))).toEqual(["0162Z0"]); // 소문자로 친 영숫자 코드
  });

  it("Postgres 처럼 LIKE 가 대소문자를 가려도 소문자·대문자 모두 찾는다", async () => {
    const service = await setup({ caseSensitiveLike: true });
    expect(codes(await service.searchMaster("naver"))).toEqual(["035420"]);
    expect(codes(await service.searchMaster("Naver"))).toEqual(["035420"]);
    expect(codes(await service.searchMaster("NAVER"))).toEqual(["035420"]);
    expect(codes(await service.searchMaster("kt"))).toEqual(["030200", "033780"]);
    expect(codes(await service.searchMaster("0162z0"))).toEqual(["0162Z0"]);
    expect(codes(await service.searchMaster("삼성"))).toEqual(["005930"]);
  });

  it("이름 포함 결과가 많아도 정확히 같은 이름은 개수 제한에 잘리지 않는다", async () => {
    // 정확히 "SK" 인 종목을 맨 뒤에 넣어 저장 순서로는 잘리게 만든다
    const many = Array.from({ length: 80 }, (_, i) => st(String(400000 + i), `TIGER SK그룹${i}`, "EF"));
    const service = await setup({ master: [...many, st("034730", "SK")] });
    const r = codes(await service.searchMaster("SK", 5));
    expect(r).toHaveLength(5);
    expect(r[0]).toBe("034730");
  });

  it("실제 미국 티커와 한국 종목명이 겹치면(KT) 로컬 결과와 외부 결과를 모두 보여 준다", async () => {
    const us: ListedStock = { code: "KT", name: "KT Corporation", market: "NYSE", isinCode: null, groupCode: "ST" };
    const local = await setup({ search: new FakeSearchProvider([us]) });
    // 로컬 빠른 응답 → 외부 병합
    expect(codes(await local.searchMaster("KT"))).toEqual(["030200", "033780"]);
    expect(await local.search("KT")).toMatchObject({ source: "master+fake-search" });
    expect(codes(await local.search("KT"))).toEqual(["030200", "033780", "KT"]);
    await db!.destroy();
    const remote = await setup({ search: new FakeSearchProvider([us]), remoteFirst: true });
    expect(await remote.search("KT")).toMatchObject({ source: "fake-search+master" });
    expect(codes(await remote.search("KT"))).toEqual(["KT", "030200", "033780"]);
  });

  it("마스터에 미국 종목도 있으면(토스 마스터) 코드가 정확히 같은 종목이 먼저, 그 다음 이름", async () => {
    const usRow = (code: string, name: string): ListedStock => ({ code, name, market: "NYSE", isinCode: null, groupCode: "ST" });
    const service = await setup({ search: new FailingSearch(), remoteFirst: true, master: [...MASTER, usRow("KT", "KT ADR"), usRow("TSLA", "테슬라")] });
    expect(codes(await service.search("KT"))).toEqual(["KT", "030200", "033780"]);
    expect(codes(await service.searchMaster("tsla"))).toEqual(["TSLA"]);
    expect(codes(await service.searchMaster("테슬라"))).toEqual(["TSLA"]);
  });
});
