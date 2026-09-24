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
  // 등록 종목 현재가를 미리 받아 둔다 → 배포 직후 첫 잔고 요청이 기다리지 않는다 (실패해도 요청 때 다시)
  void app.stockService
    .warmQuotes()
    .then(() => app.log.info(app.stockService.quoteStatus(), "현재가 미리 받기 완료"))
    // 그다음 등록 종목의 기본 차트(일봉 800개)를 한 종목씩 받아 둔다 → 처음 여는 차트도 기다리지 않는다 (3-18)
    .catch((e) => app.log.warn({ err: e }, "현재가 미리 받기 실패"))
    .then(() => app.stockService.warmCandles())
    .then(() => app.log.info(app.stockService.candleStatus(), "차트 미리 받기 완료"))
    .catch((e) => app.log.warn({ err: e }, "차트 미리 받기 실패"));
  app.log.info(describeProviders(config), "데이터 소스");
  app.log.info(app.scheduler?.status() ?? {}, "브리핑 스케줄");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
