/**
 * 브리핑 수동 실행 스크립트 (서버 없이).
 *   npm run briefing -- morning            # 등록 종목 전체
 *   npm run briefing -- afternoon 000660   # 특정 종목
 */
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createMigratedDb } from "../db/index.js";
import { buildProviders } from "../providers/index.js";

const [sessionArg, ...codes] = process.argv.slice(2);
if (sessionArg !== "morning" && sessionArg !== "afternoon") {
  console.error("사용법: npm run briefing -- <morning|afternoon> [종목코드 ...]");
  process.exit(1);
}
const config = loadConfig();
const db = await createMigratedDb(config.DATABASE_URL);
const app = await buildApp({ config, db, providers: buildProviders(config, db, { warn: () => {} }), logger: { level: "warn" }, enableScheduler: false });
const result = await app.briefingService.runSession(sessionArg, codes.length ? { codes, force: true } : { force: true });
for (const r of result.results) {
  console.log(`\n=== ${r.name} (${r.code}) [${r.status}] ===`);
  console.log(r.status === "ok" ? r.summary : r.error);
}
await app.close();
await db.destroy();
