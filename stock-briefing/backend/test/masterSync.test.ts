import { describe, expect, it } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { ListedStock } from "../src/domain/types.js";
import { ProviderError } from "../src/lib/errors.js";
import type { MasterProvider } from "../src/providers/market/types.js";
import { MasterSync } from "../src/services/masterSync.js";
import { StockService } from "../src/services/stockService.js";
import { FakeQuoteProvider, FakeSearchProvider, SAMPLE_MASTER } from "./helpers.js";

/** 받을 목록·실패를 바꿀 수 있는 마스터 (fetchAll 호출 수를 센다) */
class SwitchableMaster implements MasterProvider {
  readonly name = "switchable-master";
  rows: ListedStock[] = SAMPLE_MASTER;
  fail: Error | null = null;
  calls = 0;
  gate: Promise<void> | null = null;
  async fetchAll(): Promise<ListedStock[]> {
    this.calls++;
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    return this.rows;
  }
}

const AAPL: ListedStock = { code: "AAPL", name: "애플", market: "NASDAQ", isinCode: null, groupCode: null };
const NEW_LISTING: ListedStock = { code: "0088M0", name: "신규상장", market: "KOSDAQ", isinCode: null, groupCode: "ST" };
const log = { info: () => undefined, warn: () => undefined };

async function setup() {
  const db = await createMigratedDb(":memory:");
  const master = new SwitchableMaster();
  const stocks = new StockService({ db, quotes: new FakeQuoteProvider("kis"), search: new FakeSearchProvider(), master });
  const sync = (source: string) => new MasterSync({ db, stocks, source, log });
  return { db, master, stocks, sync };
}

const savedSource = async (db: Db) => (await db.selectFrom("meta").select("value").where("key", "=", "master_source").executeTakeFirst())?.value ?? null;
const listedCodes = async (db: Db) => (await db.selectFrom("listed_stocks").select("code").orderBy("code").execute()).map((r) => r.code);

describe("기동 시 종목 마스터 받기 (BH-47)", () => {
  it("토스 마스터로 바꾸는 첫 받기가 실패하면 출처를 저장하지 않아, 다음 기동 때 다시 받는다", async () => {
    const { db, master, sync } = await setup();
    // 1) 토스 키 없이 기동 → KIS 마스터(한국만)
    expect(await sync("kis-master").boot()).toBe("refreshed");
    expect(await savedSource(db)).toBe("kis-master");

    // 2) 토스 키를 넣고 재배포했는데 서버 IP 가 아직 허용 목록에 없어 403
    master.fail = new ProviderError("toss-openapi", "HTTP 403 (IP not allowed)");
    expect(await sync("toss-openapi").boot()).toBe("failed");
    expect(await savedSource(db)).toBe("kis-master");
    expect(await listedCodes(db)).not.toContain("AAPL");

    // 3) IP 를 등록하고 재시작 → 이번엔 다시 받아 미국 종목까지 들어간다
    master.fail = null;
    master.rows = [...SAMPLE_MASTER, AAPL];
    expect(await sync("toss-openapi").boot()).toBe("refreshed");
    expect(await savedSource(db)).toBe("toss-openapi");
    expect(await listedCodes(db)).toContain("AAPL");

    // 4) 그다음 기동은 출처가 같고 목록이 있으니 건너뛴다
    const before = master.calls;
    expect(await sync("toss-openapi").boot()).toBe("kept");
    expect(master.calls).toBe(before);
  });
});

describe("종목 마스터 매일 갱신 (BH-25)", () => {
  it("매일 다시 받아 새로 상장한 종목을 넣는다", async () => {
    const { db, master, sync } = await setup();
    const s = sync("kis-master");
    await s.boot();
    master.rows = [...SAMPLE_MASTER, NEW_LISTING];
    expect(await s.daily()).toBe("refreshed");
    expect(await listedCodes(db)).toContain("0088M0");
  });

  it("받은 목록이 비었거나 크게 줄었거나 받기가 실패하면 기존 목록을 그대로 둔다", async () => {
    const { db, master, sync } = await setup();
    const s = sync("kis-master");
    await s.boot();
    const kept = await listedCodes(db);
    for (const rows of [[], SAMPLE_MASTER.slice(0, 2)]) {
      master.rows = rows;
      expect(await s.daily(), `${rows.length}건`).toBe("failed");
      expect(await listedCodes(db)).toEqual(kept);
    }
    master.rows = SAMPLE_MASTER;
    master.fail = new ProviderError("switchable-master", "일시 장애");
    expect(await s.daily()).toBe("failed");
    expect(await listedCodes(db)).toEqual(kept);
  });

  it("출처를 바꾸던 기동 받기가 실패했으면 다음 매일 갱신이 목록이 줄어도 새 출처로 바꾸고 출처를 저장한다", async () => {
    const { db, master, sync } = await setup();
    master.rows = [...SAMPLE_MASTER, AAPL];
    await sync("toss-openapi").boot();
    // 토스 키를 뺐는데 KIS 받기가 실패
    master.fail = new ProviderError("kis-master", "일시 장애");
    const s = sync("kis-master");
    expect(await s.boot()).toBe("failed");
    expect(await savedSource(db)).toBe("toss-openapi");
    // 다음 날 KIS 는 한국 종목만 준다 (크게 줄었지만 출처 전환이라 바꾼다)
    master.fail = null;
    master.rows = SAMPLE_MASTER.slice(0, 2);
    expect(await s.daily()).toBe("refreshed");
    expect(await savedSource(db)).toBe("kis-master");
    expect(await listedCodes(db)).toEqual(["000660", "005930"]);
  });

  it("받는 중에 또 부르면 한 번만 받는다 (기동 받기와 매일 갱신이 겹칠 때)", async () => {
    const { master, sync } = await setup();
    const s = sync("kis-master");
    let open!: () => void;
    master.gate = new Promise((r) => (open = r));
    const a = s.boot();
    const b = s.daily();
    open();
    expect(await a).toBe("refreshed");
    expect(await b).toBe("refreshed");
    expect(master.calls).toBe(1);
  });
});
