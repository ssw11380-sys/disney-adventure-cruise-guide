import { loadConfig } from "../config.js";
import { createMigratedDb } from "../db/index.js";
import { buildProviders } from "../providers/index.js";
import { StockService } from "../services/stockService.js";

const config = loadConfig();
const db = await createMigratedDb(config.DATABASE_URL);
const service = new StockService({ db, ...buildProviders(config, db, { warn: () => {} }) });
const r = await service.refreshMaster();
console.log(`종목 마스터 갱신 완료: ${r.count}건 (${r.refreshedAt})`);
await db.destroy();
