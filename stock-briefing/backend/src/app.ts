import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
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
import { adminRoutes, tossStatus, type AdminDeps } from "./routes/admin.js";
import { TossSyncService } from "./services/tossSyncService.js";
import { analysisRoutes } from "./routes/analysis.js";
import { briefingRoutes } from "./routes/briefings.js";
import { deviceRoutes, notificationRoutes } from "./routes/notifications.js";
import { marketRoutes } from "./routes/market.js";
import { stockRoutes } from "./routes/stocks.js";
import { BriefingScheduler } from "./scheduler.js";
import { AnalysisService } from "./services/analysisService.js";
import { BriefingService } from "./services/briefingService.js";
import { DataCollector } from "./services/collector.js";
import { DeviceService } from "./services/deviceService.js";
import { NotificationService } from "./services/notificationService.js";
import { PriceStream } from "./services/priceStream.js";
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
  await app.register(websocket, { options: { maxPayload: 4096 } });
  const log = app.log;
  const now = opts.now ?? (() => new Date());

  const stockService = new StockService({ db: opts.db, ...opts.providers, now });

  // 토스증권 공식 Open API: 실시간 구독 시작 + 보유 종목 가져오기 서비스 + 서버 공인 IP(허용 IP 등록 안내용)
  // 서버 공인 IP (토스 Open API 허용 IP 등록용). 키가 없을 때도 /health 에 보여 준다.
  const skipIp = opts.enableScheduler === false; // 테스트에서는 외부 호출 안 함
  let ipCache: { at: number; ip: string | null } | null = null;
  const outboundIp = async (): Promise<string | null> => {
    if (skipIp) return null;
    if (ipCache && Date.now() - ipCache.at < 10 * 60_000) return ipCache.ip;
    let ip: string | null = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch("https://api.ipify.org?format=json", { signal: ctrl.signal });
      clearTimeout(timer);
      ip = ((await res.json()) as { ip?: string }).ip ?? null;
    } catch {
      ip = null;
    }
    ipCache = { at: Date.now(), ip };
    return ip;
  };
  let tossDeps: AdminDeps["toss"] = null;
  if (opts.providers.tossOpenApi) {
    const live = opts.providers.live;
    if (live && opts.enableScheduler !== false) {
      live.start();
      await stockService.syncLive();
      app.addHook("onClose", async () => live.stop());
    }
    tossDeps = { provider: opts.providers.tossOpenApi, sync: new TossSyncService(opts.db, opts.providers.tossOpenApi, now), live, outboundIp };
  }
  // 서버 → 앱 실시간 가격 스트림 (/api/stream). 토스 웹소켓 체결을 그대로 중계하고, 없으면 앱이 붙어 있는 동안만 3초 폴링
  const priceStream = new PriceStream({
    live: opts.providers.live,
    quickPrices: opts.providers.quickPrices,
    codes: async () => (await stockService.list()).map((s) => s.code),
    log,
  });
  app.addHook("onClose", async () => priceStream.stop());

  const collector = new DataCollector({
    quotes: opts.providers.quotes,
    news: opts.providers.news,
    financials: opts.providers.financials,
    financialsUs: opts.providers.financialsUs,
    investorFlow: opts.providers.investorFlow,
    fundamentals: opts.providers.fundamentals,
    log,
  });
  const prompts = opts.promptStore ?? new PromptStore();
  const briefingService = new BriefingService({ db: opts.db, collector, generator: opts.providers.generator, prompts, calendar: opts.providers.calendar, log, now });
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
  app.decorate("priceStream", priceStream);

  // 인터넷에 노출할 때의 최소 보호: API_TOKEN 이 설정되면 /api/* 는 Bearer 토큰이 있어야 한다. /health 는 열어 둔다.
  if (opts.config.API_TOKEN) {
    const expected = `Bearer ${opts.config.API_TOKEN}`;
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/api/")) return;
      // 웹소켓(/api/stream)은 헤더를 못 붙이는 클라이언트를 위해 ?token= 도 받는다
      const q = req.query as { token?: string } | undefined;
      if (req.url.startsWith("/api/stream") && q?.token === opts.config.API_TOKEN) return;
      if (req.headers.authorization !== expected) {
        return reply.code(401).send({ error: "UNAUTHORIZED", message: "API 토큰이 필요합니다 (앱 설정 > 서버 주소 아래 토큰 입력)" });
      }
    });
  }

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

  /** 브라우저로 주소만 열었을 때 보이는 안내 페이지 */
  app.get("/", async (_req, reply) => {
    const h = await deviceService.enabledTokens();
    const jobs = scheduler?.status().jobs ?? [];
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>주식 브리핑 서버</title>
<style>body{font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6;color:#1b221d;background:#f5f6f3}h1{font-size:1.4rem}code{background:#eef0eb;padding:2px 6px;border-radius:4px}.ok{color:#1f6f5c;font-weight:600}small{color:#5f6a63}</style></head>
<body><h1>주식 브리핑 서버 <span class="ok">정상 작동 중</span></h1>
<p>이 주소는 휴대폰 앱이 접속하는 서버입니다. 앱의 <b>설정 탭 → 서버 주소</b>에 이 주소를 입력하세요.</p>
<ul><li>서버 시각: ${seoulIso(now())}</li><li>브리핑 모델: ${describeProviders(opts.config).llm}</li><li>등록된 알림 기기: ${h.length}대</li>${jobs.map((j) => `<li>다음 ${j.session === "morning" ? "오전" : "오후"} 브리핑: ${j.nextRun ? new Date(j.nextRun).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "-"}</li>`).join("")}</ul>
<p><small>상태 확인: <a href="/health">/health</a> · API 는 토큰이 필요합니다.</small></p>
<p><small>투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.</small></p></body></html>`;
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/health", async () => ({
    ok: true,
    time: seoulIso(now()),
    sources: describeProviders(opts.config),
    schedule: scheduler?.status() ?? null,
    devices: (await deviceService.enabledTokens()).length,
    authRequired: Boolean(opts.config.API_TOKEN),
    tossOpenApi: tossStatus(tossDeps, await outboundIp()),
    lastBriefing: briefingService.lastRun,
    stream: priceStream.status(),
    llmConfigured: opts.providers.generator.model !== "disabled",
    disclaimer: DISCLAIMER,
  }));

  await app.register(marketRoutes, { prefix: "/api/market", calendar: opts.providers.calendar });

  /** GET /api/stream (웹소켓) — 등록 종목 체결가를 실시간으로 밀어 준다. 인증은 Authorization 헤더 또는 ?token= */
  app.get("/api/stream", { websocket: true }, (socket) => {
    priceStream.attach(socket);
  });

  await app.register(stockRoutes, { prefix: "/api/stocks", service: stockService });
  await app.register(analysisRoutes, {
    prefix: "/api/stocks",
    service: analysisService,
    stocks: stockService,
    news: opts.providers.news,
    financials: opts.providers.financials,
    financialsUs: opts.providers.financialsUs,
  });
  await app.register(briefingRoutes, { prefix: "/api/briefings", service: briefingService, scheduler });
  await app.register(adminRoutes, { prefix: "/api/admin", service: stockService, dart: opts.providers.dart, toss: tossDeps, outboundIp });
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
    priceStream: PriceStream;
  }
}
