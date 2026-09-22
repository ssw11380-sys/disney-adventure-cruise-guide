import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { AppError, ProviderError } from "./lib/errors.js";
import { seoulIso } from "./lib/time.js";
import { GenerationError } from "./llm/generator.js";
import { PromptStore } from "./llm/prompts.js";
import { defaultsFromCron, NotificationSettingsStore, timeToCron } from "./notifications/settings.js";
import { describeProviders, type Providers } from "./providers/index.js";
import { adminRoutes } from "./routes/admin.js";
import { analysisRoutes } from "./routes/analysis.js";
import { briefingRoutes } from "./routes/briefings.js";
import { deviceRoutes, notificationRoutes } from "./routes/notifications.js";
import { stockRoutes } from "./routes/stocks.js";
import { BriefingScheduler } from "./scheduler.js";
import { AnalysisService } from "./services/analysisService.js";
import { BriefingService } from "./services/briefingService.js";
import { DataCollector } from "./services/collector.js";
import { DeviceService } from "./services/deviceService.js";
import { NotificationService } from "./services/notificationService.js";
import { StockService } from "./services/stockService.js";

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  providers: Providers;
  logger?: boolean | object;
  /** 테스트에서는 프롬프트 폴더를 바꿀 수 있다 */
  promptStore?: PromptStore;
  /** false 면 cron 을 등록하지 않는다 (테스트/일회성 스크립트) */
  enableScheduler?: boolean;
  now?: () => Date;
  /** 푸시 영수증 확인 대기 시간 (테스트용) */
  receiptDelayMs?: number;
}

export const DISCLAIMER = "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.";

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? { level: opts.config.LOG_LEVEL } });
  await app.register(cors, { origin: true });
  const log = app.log;
  const now = opts.now ?? (() => new Date());

  const stockService = new StockService({ db: opts.db, ...opts.providers, now });
  const collector = new DataCollector({
    quotes: opts.providers.quotes,
    news: opts.providers.news,
    financials: opts.providers.financials,
    investorFlow: opts.providers.investorFlow,
    log,
  });
  const prompts = opts.promptStore ?? new PromptStore();
  const briefingService = new BriefingService({ db: opts.db, collector, generator: opts.providers.generator, prompts, log, now });
  const analysisService = new AnalysisService({ db: opts.db, collector, generator: opts.providers.generator, prompts, now });

  // 알림/시간 설정: DB 에 저장된 값이 .env 기본값을 덮어쓴다
  const settingsStore = new NotificationSettingsStore(
    opts.db,
    defaultsFromCron(opts.config.BRIEFING_MORNING_CRON, opts.config.BRIEFING_AFTERNOON_CRON),
  );
  const settings = await settingsStore.get();

  let scheduler: BriefingScheduler | null = null;
  if (opts.enableScheduler !== false) {
    scheduler = new BriefingScheduler(briefingService, {
      morningCron: settings.morningEnabled ? timeToCron(settings.morningTime, settings.weekdaysOnly) : null,
      afternoonCron: settings.afternoonEnabled ? timeToCron(settings.afternoonTime, settings.weekdaysOnly) : null,
      timezone: opts.config.timezone,
      log,
    });
    scheduler.start();
    app.addHook("onClose", async () => scheduler?.stop());
  }

  const deviceService = new DeviceService(opts.db, opts.providers.push, now);
  const notificationService = new NotificationService({
    push: opts.providers.push,
    devices: deviceService,
    settings: settingsStore,
    log,
    ...(opts.receiptDelayMs !== undefined ? { receiptDelayMs: opts.receiptDelayMs } : {}),
  });
  briefingService.onBriefing(notificationService.onBriefing);
  app.addHook("onClose", async () => notificationService.stop());

  app.decorate("stockService", stockService);
  app.decorate("briefingService", briefingService);
  app.decorate("analysisService", analysisService);
  app.decorate("scheduler", scheduler);
  app.decorate("deviceService", deviceService);
  app.decorate("notificationService", notificationService);
  app.decorate("settingsStore", settingsStore);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "VALIDATION",
        message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof ProviderError) return reply.code(502).send({ error: "UPSTREAM", message: err.message });
    if (err instanceof GenerationError) {
      const status = err.kind === "config" ? 503 : 502;
      return reply.code(status).send({ error: `LLM_${err.kind.toUpperCase()}`, message: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "INTERNAL", message: "서버 오류" });
  });

  app.get("/health", async () => ({
    ok: true,
    time: seoulIso(now()),
    sources: describeProviders(opts.config),
    schedule: scheduler?.status() ?? null,
    devices: (await deviceService.enabledTokens()).length,
    disclaimer: DISCLAIMER,
  }));

  await app.register(stockRoutes, { prefix: "/api/stocks", service: stockService });
  await app.register(analysisRoutes, {
    prefix: "/api/stocks",
    service: analysisService,
    stocks: stockService,
    news: opts.providers.news,
    financials: opts.providers.financials,
  });
  await app.register(briefingRoutes, { prefix: "/api/briefings", service: briefingService, scheduler });
  await app.register(adminRoutes, { prefix: "/api/admin", service: stockService, dart: opts.providers.dart });
  const notifDeps = { devices: deviceService, notifications: notificationService, settings: settingsStore, scheduler };
  await app.register(deviceRoutes, { prefix: "/api/devices", ...notifDeps });
  await app.register(notificationRoutes, { prefix: "/api/notifications", ...notifDeps });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    stockService: StockService;
    briefingService: BriefingService;
    analysisService: AnalysisService;
    scheduler: BriefingScheduler | null;
    deviceService: DeviceService;
    notificationService: NotificationService;
    settingsStore: NotificationSettingsStore;
  }
}
