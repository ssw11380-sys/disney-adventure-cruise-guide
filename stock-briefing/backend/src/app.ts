import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { AppError, ProviderError } from "./lib/errors.js";
import { seoulIso } from "./lib/time.js";
import { GenerationError } from "./llm/generator.js";
import { PromptStore } from "./llm/prompts.js";
import { defaultsFromCron, NotificationSettingsStore, timeToCron } from "./notifications/settings.js";
import { describeProviders, metaStore, type Providers } from "./providers/index.js";
import { adminRoutes, tossStatus, type AdminDeps } from "./routes/admin.js";
import { HoldingsAutoSync, TossSyncService } from "./services/tossSyncService.js";
import { analysisRoutes } from "./routes/analysis.js";
import { briefingRoutes } from "./routes/briefings.js";
import { deviceRoutes, notificationRoutes } from "./routes/notifications.js";
import { marketRoutes } from "./routes/market.js";
import { discoverRoutes } from "./routes/discover.js";
import { NaverDiscover } from "./providers/market/naverDiscover.js";
import { DiscoverService } from "./services/discoverService.js";
import { UsThemeBook } from "./services/usThemes.js";
import cron from "node-cron";
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
  const logger = opts.logger === false ? false : { level: opts.config.LOG_LEVEL, ...(typeof opts.logger === "object" ? opts.logger : {}), serializers: { req: logReq, path: logPath } };
  const app = Fastify({ logger });
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
    // 원화 장부 보정에는 토스가 원화 평가에 쓰는 표시 환율이 필요하다 (fundamentals.usdKrw 는 토스 웹 표시 환율을 먼저 쓴다)
    const fundamentals = opts.providers.fundamentals;
    const sync = new TossSyncService(opts.db, opts.providers.tossOpenApi, now, fundamentals ? () => fundamentals.usdKrw() : null, log);
    // 토스 앱에서 사고팔면 늦어도 TOSS_SYNC_MINUTES 안에 반영. 바뀐 게 있으면 실시간 구독 종목도 갱신
    const autoSync = new HoldingsAutoSync({
      sync,
      calendar: opts.providers.calendar,
      // 바뀐 게 있으면 실시간 구독 종목을 맞추고, 접속한 앱에 "잔고 변경"을 바로 알린다
      afterSync: async () => {
        await stockService.syncLive();
        priceStream.notify("holdings");
      },
      intervalMin: opts.config.TOSS_SYNC_MINUTES,
      log,
      now,
    });
    if (opts.enableScheduler !== false) {
      autoSync.start();
      app.addHook("onClose", async () => autoSync.stop());
      // 토스 앱에서 체결되면(personal:order FILL/PARTIAL_FILL) 3초 뒤 바로 잔고를 다시 맞춘다 (여러 건이 연달아 와도 한 번).
      // 자동 동기화를 끈 경우(TOSS_SYNC_MINUTES=0)엔 체결로도 자동 반영하지 않는다
      if (live && autoSync.enabled) {
        sync.onAccounts = (seqs) => live.setAccounts(seqs);
        let orderTimer: NodeJS.Timeout | null = null;
        const soon = () => {
          if (orderTimer) clearTimeout(orderTimer);
          orderTimer = setTimeout(() => {
            orderTimer = null;
            void autoSync.run("order").catch(() => null);
          }, 3000);
        };
        live.on("order", (data: { event?: string }) => {
          if (data?.event === "FILL" || data?.event === "PARTIAL_FILL") soon();
        });
        // 끊겨 있던 동안의 체결은 다시 오지 않는다 → 재연결되면 한 번 맞춘다 (첫 연결은 시작 동기화가 한다)
        let opened = false;
        live.on("open", () => {
          if (opened) soon();
          opened = true;
        });
        app.addHook("onClose", async () => {
          if (orderTimer) clearTimeout(orderTimer);
        });
      }
    }
    tossDeps = { provider: opts.providers.tossOpenApi, sync, autoSync, live, outboundIp };
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
    quickPrices: opts.providers.quickPrices,
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
      // 브리핑 직전에 토스 계좌를 한 번 더 읽어 수량·평단이 최신이 되게 한다
      ...(tossDeps ? { beforeRun: async () => void (await tossDeps!.autoSync.run("briefing")) } : {}),
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
    const token = opts.config.API_TOKEN;
    app.addHook("onRequest", async (req, reply) => {
      // 원본 URL 문자열이 아니라 라우터가 고른 경로로 판단한다 — "/%61pi/stocks" 처럼 퍼센트 인코딩해 검사를 피하지 못하게.
      // 맞는 라우트가 없으면(404) 디코딩한 경로로 본다
      const path = req.routeOptions.url ?? decodedPath(req.url);
      if (!path.startsWith("/api/") && path !== "/api") return;
      // 웹소켓(/api/stream)은 헤더를 못 붙이는 클라이언트를 위해 ?token= 도 받는다
      const q = req.query as { token?: unknown } | undefined;
      if (path === "/api/stream" && typeof q?.token === "string" && sameSecret(q.token, token)) return;
      const auth = req.headers.authorization;
      if (typeof auth !== "string" || !auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), token)) {
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

  // 토큰이 설정돼 있으면 상세(구독 종목·서버 IP·출처 구성 등)는 토큰을 보낸 요청에만 준다 — 앱은 늘 토큰을 보낸다
  app.get("/health", async (req) => {
    const token = opts.config.API_TOKEN;
    const auth = req.headers.authorization;
    const trusted = !token || (typeof auth === "string" && auth.startsWith("Bearer ") && sameSecret(auth.slice(7), token));
    // 옛 앱이 sources·schedule 을 바로 읽으므로 빈 값을 함께 준다 (limited = 토큰이 없거나 틀려 상세를 뺀 응답)
    if (!trusted) return { ok: true, time: seoulIso(now()), authRequired: true, limited: true, sources: {}, schedule: null, disclaimer: DISCLAIMER };
    return healthDetail();
  });
  const healthDetail = async () => ({
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
  });

  // 없는 경로도 앱 표준 오류 형식으로
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "NOT_FOUND", message: `없는 주소입니다: ${req.method} ${req.url.split("?")[0]}` }));

  await app.register(marketRoutes, { prefix: "/api/market", calendar: opts.providers.calendar });
  // 발견 탭: 순위·테마·업종 (네이버 공개 JSON). 미국 테마는 토스 테마 분류 + 네이버 정규장 시세. 미국 원화 환산은 토스 표시 환율
  const discoverNaver = opts.providers.discover ?? new NaverDiscover();
  const tics = opts.providers.tics ?? null;
  const usThemes = tics ? new UsThemeBook({ tics, naver: discoverNaver, store: metaStore(opts.db), now, log }) : null;
  const discoverService = new DiscoverService({
    naver: discoverNaver,
    calendar: opts.providers.calendar,
    usdKrw: opts.providers.fundamentals ? () => opts.providers.fundamentals!.usdKrw() : null,
    now,
    usThemes,
    tics,
    store: metaStore(opts.db),
  });
  // 미국 테마북은 만드는 데 1분쯤 걸려 서버를 켤 때 미리 만들고, 매일 21:00(한국, 미국 정규장 전)에 새로 만든다
  // → 새 테마·새로 편입된 종목이 화면을 열지 않아도 하루 안에 반영된다
  if (usThemes && opts.enableScheduler !== false) {
    usThemes.warm();
    const task = cron.schedule("0 21 * * *", () => void usThemes.refresh(), { timezone: opts.config.timezone, name: "us-themes-daily" });
    // 1주·1개월 테마 등락률은 정규장 끝나기 직전 값을 남겨 둔다 (장 밖에는 토스 값에 주간·프리·애프터 가격이 섞이므로)
    // 12:50 에도 받는다 — 조기 폐장일(13:00 마감)에는 15:50 이 정규장이 아니어서 건너뛰므로 (보통 날은 15:50 값이 덮는다)
    const periods = cron.schedule(
      "50 12,15 * * 1-5",
      () => void discoverService.captureUsPeriods().catch((e) => app.log.warn({ err: String(e) }, "미국 테마 기간 등락률 저장 실패")),
      { timezone: "America/New_York", name: "us-theme-periods" },
    );
    app.addHook("onClose", async () => {
      void task.stop();
      void periods.stop();
    });
  }
  await app.register(discoverRoutes, { prefix: "/api/discover", service: discoverService });

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

/** 요청 경로(쿼리 제외)를 퍼센트 디코딩한다. 깨진 인코딩이면 원문 그대로 (그러면 /api/ 로 시작하지 않아 라우터도 못 찾는다) */
function decodedPath(url: string): string {
  const raw = url.split("?")[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** @fastify/websocket 은 웹소켓 핸들러가 없는 경로로 온 접속을 { path: 주소 } 로 남긴다 — 여기서도 token 을 가린다 */
function logPath(p: unknown): unknown {
  return typeof p === "string" ? redactToken(p) : p;
}

/** 요청 로그: Fastify 기본 항목과 같되, 주소의 token 쿼리(웹소켓 인증)는 가린다 (서버 로그에 API 토큰이 남지 않게) */
function logReq(req: FastifyRequest): { method: string; url: string; host: string; remoteAddress: string; version?: string; remotePort?: number } {
  const version = req.headers?.["accept-version"];
  const port = req.socket?.remotePort;
  return {
    method: req.method,
    url: redactToken(req.url),
    host: req.host,
    remoteAddress: req.ip,
    ...(typeof version === "string" ? { version } : {}),
    ...(port !== undefined ? { remotePort: port } : {}),
  };
}

/**
 * 주소에서 이름이 token 인 쿼리 값(퍼센트 인코딩한 이름 포함)을 [redacted] 로 바꾼다.
 * 라우터는 '?' 와 '#' 중 앞선 곳부터 쿼리로 읽으므로 '?', '#', ';', '&' 뒤의 이름=값을 모두 본다
 */
export function redactToken(url: string): string {
  const start = url.search(/[?#;]/);
  if (start < 0) return url;
  const rest = url.slice(start).replace(/([?#;&])([^?#;&=]*)=([^?#;&]*)/g, (m, sep: string, key: string) => (isTokenName(key) ? `${sep}${key}=[redacted]` : m));
  return url.slice(0, start) + rest;
}

function isTokenName(key: string): boolean {
  let name = key;
  try {
    name = decodeURIComponent(key.replace(/\+/g, " "));
  } catch {
    // 깨진 인코딩: 원문 이름으로 비교
  }
  return name.trim().toLowerCase() === "token";
}

/** 비밀값 비교 (길이가 같을 때 시간 일정 비교) */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
