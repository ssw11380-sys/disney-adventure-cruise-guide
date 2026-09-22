import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createMigratedDb } from "./db/index.js";
import { buildProviders, describeProviders } from "./providers/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createMigratedDb(config.DATABASE_URL);
  const app = await buildApp({
    config,
    db,
    providers: buildProviders(config, db, { warn: (o, m) => console.warn(m, o) }),
  });

  // 종목 마스터가 비어 있으면 기동 시 한 번 받아 둔다 (실패해도 서버는 뜬다).
  // 토스 Open API 키를 새로 넣은 경우에는 미국 종목까지 들어간 토스 마스터로 한 번 갈아탄다.
  const status = await app.stockService.masterStatus();
  const masterSource = (await db.selectFrom("meta").select("value").where("key", "=", "master_source").executeTakeFirst())?.value ?? null;
  const wantSource = config.tossOpenApiEnabled ? "toss-openapi" : "kis-master";
  if (status.count === 0 || masterSource !== wantSource) {
    app.log.info(`종목 마스터를 ${wantSource} 로 내려받습니다...`);
    void db.insertInto("meta").values({ key: "master_source", value: wantSource }).onConflict((oc) => oc.column("key").doUpdateSet({ value: wantSource })).execute();
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
  app.log.info(describeProviders(config), "데이터 소스");
  app.log.info(app.scheduler?.status() ?? {}, "브리핑 스케줄");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
