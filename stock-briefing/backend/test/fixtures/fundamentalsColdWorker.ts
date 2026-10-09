/** 재무 캐시의 실제 새 프로세스 복원 검사. 외부 HTTP는 사용하지 않는다. */
import { createDb } from "../../src/db/index.js";
import { NaverFundamentals } from "../../src/providers/market/fundamentals.js";
import { createFundamentalsCacheStore } from "../../src/providers/market/fundamentalsCacheStore.js";

const [database, clock] = process.argv.slice(2);
if (!database || !clock) throw new Error("검사 DB와 시각 필요");
const db = createDb(database).db;
let fetches = 0;
globalThis.fetch = async () => { throw new Error("검사 중 외부 HTTP 금지"); };
const provider = new NaverFundamentals(async () => { fetches++; return new Response("", { status: 503 }); }, () => new Date(Number(clock)));
provider.setCacheStore(createFundamentalsCacheStore(db));
try {
  const result = await provider.getWithStatus("005930");
  process.stdout.write(JSON.stringify({ result, fetches }));
} finally { await provider.flushCache(); await db.destroy(); }
