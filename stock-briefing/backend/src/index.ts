import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createMigratedDb } from "./db/index.js";
import { buildProviders } from "./providers/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createMigratedDb(config.DATABASE_URL);
  const app = await buildApp({
    config,
    db,
    providers: buildProviders(config, db, { warn: (o, m) => console.warn(m, o) }),
  });

  // 종목 마스터가 비어 있으면 기동 시 한 번 받아 둔다 (실패해도 서버는 뜬다)
  const status = await app.stockService.masterStatus();
  if (status.count === 0) {
    app.log.info("종목 마스터가 비어 있어 KIS 마스터 파일을 내려받습니다...");
    app.stockService
      .refreshMaster()
      .then((r) => app.log.info(r, "종목 마스터 갱신 완료"))
      .catch((e) => app.log.warn({ err: e }, "종목 마스터 갱신 실패 (검색은 외부 소스로 대체)"));
  } else {
    app.log.info(status, "종목 마스터 로드됨");
  }

  const close = async () => {
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`시세 소스: ${config.kisEnabled ? "KIS → Yahoo 폴백" : "Yahoo (KIS 키 미설정)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
