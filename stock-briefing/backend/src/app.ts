import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { detectDialect, type Db } from "./db/index.js";
import { AppError, ProviderError } from "./lib/errors.js";
import { seoulIso } from "./lib/time.js";
import { GenerationError } from "./llm/generator.js";
import { PromptStore } from "./llm/prompts.js";
import { defaultsFromCron, NotificationSettingsStore, timeToCron } from "./notifications/settings.js";
import { ReceiptStore } from "./notifications/receiptStore.js";
import { describeProviders, metaStore, type Providers } from "./providers/index.js";
import { adminRoutes, readTossAccountSnapshot, tossStatus, type AdminDeps } from "./routes/admin.js";
import { HoldingsAutoSync, TossSyncService } from "./services/tossSyncService.js";
import { AccountLiveRefresh } from "./services/accountLiveRefresh.js";
import { analysisRoutes } from "./routes/analysis.js";
import { appErrorAdminRoutes, appErrorRoutes } from "./routes/appErrors.js";
import { briefingRoutes } from "./routes/briefings.js";
import { accountBriefingRoutes } from "./routes/accountBriefings.js";
import { deviceRoutes, notificationRoutes } from "./routes/notifications.js";
import { marketRoutes } from "./routes/market.js";
import { MarketIndices } from "./providers/market/indices.js";
import { discoverRoutes } from "./routes/discover.js";
import { NaverDiscover } from "./providers/market/naverDiscover.js";
import { DiscoverService } from "./services/discoverService.js";
import { UsThemeBook } from "./services/usThemes.js";
import cron from "node-cron";
import { stockRoutes } from "./routes/stocks.js";
import { BriefingScheduler } from "./scheduler.js";
import { AnalysisService } from "./services/analysisService.js";
import { createFundamentalsCacheStore } from "./providers/market/fundamentalsCacheStore.js";
import { checkpointGenerator, GenerationJobs, type GenerationJobTiming } from "./services/generationJobs.js";
import { BriefingService } from "./services/briefingService.js";
import { AccountBriefingService } from "./services/accountBriefingService.js";
import { HoldingEventsService } from "./services/holdingEvents.js";
import { DataCollector } from "./services/collector.js";
import { DeviceService } from "./services/deviceService.js";
import { NotificationService } from "./services/notificationService.js";
import { PriceStream } from "./services/priceStream.js";
import { anySessionOpen } from "./services/liveSession.js";
import { AppErrorService } from "./services/appErrorService.js";
import { StockService } from "./services/stockService.js";
import { BackupService } from "./services/backupService.js";
import { ReconcileService } from "./services/reconcileService.js";
import { reconcileAfterSync } from "./services/reconcileAfterSync.js";
import { FeatureService } from "./services/featureService.js";
import { featureAdminRoutes, featureRoutes } from "./routes/features.js";
import { widgetRoutes } from "./routes/widget.js";
import { marketSummaryRoutes } from "./routes/marketSummaries.js";
import { defaultSummarySources, MarketSummaryService } from "./services/marketSummaryService.js";
import { SUMMARY_WAIT_MS } from "./services/marketSummaryCalc.js";
import { GoogleNewsRssProvider } from "./providers/news/googleRss.js";
import { registerPollSaver } from "./lib/pollSaver.js";
import { regularCloseLookup, TradeRecordService } from "./services/tradeRecordService.js";
import { tradeRecordAdminRoutes, tradeRecordRoutes } from "./routes/tradeRecords.js";
import { defaultScoreSources, IndicatorScoreService } from "./services/indicatorScoreService.js";
import { ValueScoreService } from "./services/valueScoreService.js";
import { KrValueService } from "./services/krValueService.js";
import { scoreRoutes } from "./routes/scores.js";
import { PriceAlertService } from "./services/priceAlertService.js";
import { BriefingStatusService } from "./services/briefingStatus.js";
import { priceAlertRoutes } from "./routes/priceAlerts.js";
import { WatchGroupService } from "./services/watchGroupService.js";
import { watchGroupRoutes } from "./routes/watchGroups.js";
import { watchlistRoutes } from "./routes/watchlist.js";
import { WatchlistService } from "./services/watchlistService.js";
import { InvestorFlowService } from "./services/investorFlowService.js";
import { investorFlowAdminRoutes, investorFlowRoutes } from "./routes/investorFlow.js";
import { HoldingThemesService } from "./services/holdingThemesService.js";
import { HoldingThemeMaps } from "./services/holdingThemeMaps.js";
import { KrThemeIndex } from "./services/krThemeIndex.js";
import { ThemeTvHistory } from "./services/themeTvHistory.js";
import { underlyingOfKind } from "./services/holdingThemesCalc.js";
import { holdingThemeAdminRoutes, holdingThemeRoutes } from "./routes/holdingThemes.js";
import { productKindOf } from "./analysis/leveraged.js";
import { positionsOf } from "./services/accountNumbers.js";
import { groupCodeOf } from "./services/indicatorScoreService.js";
import { within } from "./lib/errors.js";
import { FilingWatchService, inEdgarHours } from "./services/filingAlerts.js";
import { filingRoutes } from "./routes/filings.js";
import { isKrCode } from "./lib/codes.js";
import { journalAdminRoutes, journalRoutes } from "./routes/journal.js";
import { JournalService } from "./services/journalService.js";
import { SmbsStdRates } from "./providers/market/fxStd.js";

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
  generationJobTiming?: GenerationJobTiming;
}

export const DISCLAIMER = "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.";

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const logger = opts.logger === false ? false : { level: opts.config.LOG_LEVEL, ...(typeof opts.logger === "object" ? opts.logger : {}), serializers: { req: logReq, path: logPath } };
  const app = Fastify({ logger });
  await app.register(cors, { origin: true });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  const log = app.log;
  const now = opts.now ?? (() => new Date());
  const generationJobs = new GenerationJobs(opts.db, { ...opts.generationJobTiming, recordNow: now });
  const generator = checkpointGenerator(opts.providers.generator);
  opts.providers.fundamentals?.setCacheStore(createFundamentalsCacheStore(opts.db));
  // 기능 켜고 끄기 (3-15): 플래그 목록은 featureService.ts 한 곳
  const features = new FeatureService(opts.db, now);

  const stockService = new StockService({ db: opts.db, ...opts.providers, tossSyncMinutes: opts.config.TOSS_SYNC_MINUTES, now,
    extraLiveCodes: async () => (await features.enabled("watchlistSteps")) ? (await opts.db.selectFrom("watch_items").select("code").orderBy("created_at", "desc").orderBy("code").execute()).map(s => s.code) : [],
  });
  // 가격·등락률·거래량 알림 (3-29, 플래그 priceAlerts): 조건 저장·울림 기록, 거래량 급증은 차트와 같은 30분봉 캐시(450개)로 계산
  const priceAlerts = new PriceAlertService({ db: opts.db, features, candles: (code) => stockService.getCandles(code, "30m", 450).then((s) => s.candles), now });
  // 관심 종목 그룹·순서 (3-34, 플래그 watchGroups): 그룹 표 watch_groups + registered_stocks 두 칸
  const watchGroups = new WatchGroupService({ db: opts.db, features, now });
  const appErrors = new AppErrorService(opts.db, now);
  const backups = new BackupService({ db: opts.db, dialect: detectDialect(opts.config.DATABASE_URL), dir: opts.config.BACKUP_DIR, key: opts.config.BACKUP_KEY, now, log });
  if (opts.enableScheduler !== false) backups.start();
  app.addHook("onClose", async () => backups.stop()); // 진행 중인 백업이 끝난 뒤 DB 를 닫는다

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
    const sync = new TossSyncService(opts.db, opts.providers.tossOpenApi, now, fundamentals ? () => fundamentals.usdKrw() : null, log, () => features.enabled("tossAccountSnapshot"));
    // 토스 앱에서 사고팔면 늦어도 TOSS_SYNC_MINUTES 안에 반영. 바뀐 게 있으면 실시간 구독 종목도 갱신
    const reconcile = new ReconcileService({ db: opts.db, now, log });
    const autoSync = new HoldingsAutoSync({
      sync,
      // 동기화마다 앱 총평가와 토스 계좌 요약을 대조해 남긴다 (3-13)
      // 대조 기록 뒤 접속한 앱에 알린다 → '숫자 기준' 배지가 바로 바뀐다 (3-32, 플래그 numberBasis). priceStream 은 아래에서 만들고 동기화 때 부른다
      onResult: reconcileAfterSync({ features, reconcile, stocks: stockService, after: () => priceStream.notify("reconcile") }),
      onSettled: () => priceStream.notify("account"),
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
    tossDeps = { provider: opts.providers.tossOpenApi, sync, autoSync, live, outboundIp, reconcile };
  }
  // 매매 기록 기반 (3-36, 플래그 tradeRecords): 시장마다 장 마감 뒤 계좌 스냅샷 1줄 + 토스 주문 내역의 체결 저장. 토스 키가 있을 때만 예약이 돌고
  // (1분마다 확인, 서버를 켜면 1분 뒤 놓친 스냅샷 따라잡기), 키가 없으면 읽기만. 미국 원화 합계는 원화 장부와 같은 경로의 환율(토스 표시 환율 →
  // 네이버 → 전에 받아 둔 값)이고, 실제 출처와 받은 시각을 함께 적는다. 종목마다 그 거래일 일봉의 정규장 종가(regularClose)도 함께 적는다
  const regularCloseSources = opts.providers.regularCloseSources ?? null;
  const tradeRecords = new TradeRecordService({
    db: opts.db,
    toss: opts.providers.tossOpenApi,
    features,
    displayFx: opts.providers.fundamentals ? () => opts.providers.fundamentals!.usdKrwQuote() : null,
    isTradingDate: (market, date) => opts.providers.calendar.isTradingDate(market, date),
    regularCloses: regularCloseSources ? regularCloseLookup(regularCloseSources) : null,
    now,
    log,
  });
  if (opts.providers.tossOpenApi && opts.enableScheduler !== false) {
    tradeRecords.start();
    app.addHook("onClose", async () => tradeRecords.stop());
    // 토스 실시간 체결 알림으로 본 종목을 기억해, 하루 안에 사고팔아 보유에 남지 않은 종목의 주문 내역도 받는다 (자동 동기화가 켜져 있을 때만 알림이 옴)
    opts.providers.live?.on("order", (data: unknown) => {
      if ((data as { event?: string } | null)?.event === "FILL" || (data as { event?: string } | null)?.event === "PARTIAL_FILL") {
        void tradeRecords.noteOrderEvent(data).catch((e: unknown) => log.warn({ err: e instanceof Error ? e.message : String(e) }, "매매 기록: 체결 알림 기록 실패"));
      }
    });
  }

  // 서버 → 앱 실시간 가격 스트림 (/api/stream). 토스 웹소켓 체결을 250ms 씩 모아 중계하고, 웹소켓이 없는 종목만 앱이 붙어 있는 동안 3초 폴링
  const accountLiveRefresh = tossDeps && opts.enableScheduler !== false ? new AccountLiveRefresh({
    autoSync: tossDeps.autoSync,
    enabled: async () => await features.enabled("accountLiveRefresh") && await features.enabled("tossAccountSnapshot"),
    now: () => now().getTime(),
  }) : null;
  const priceStream = new PriceStream({
    onActiveChange: (active) => accountLiveRefresh?.setActive(active),
    live: opts.providers.live,
    quickPrices: opts.providers.quickPrices,
    codes: () => stockService.streamCodes(),
    // 등록 종목 시장의 거래 세션이 모두 닫혀 있으면 토스 웹 폴링을 30초로 늦춘다 (달력은 5분 캐시).
    // 토스 달력 isOpen 은 미국 정규장만이라 세션(프리·애프터·주간거래 포함)으로 본다 — 그래야 웹소켓이 없는 종목도 3초마다 바뀐다
    marketOpen: async (codes) => anySessionOpen(codes, await opts.providers.calendar.status(), now()),
    // 웹소켓이 이번 세션 체결을 주는 종목만 폴링에서 뺀다 (초록 점과 같은 기준 — 구독만으로 빼면 점은 켜졌는데 가격은 30초마다만 바뀐다)
    wsServed: (codes) => stockService.wsServed(codes),
    // 미국 공식 API 시세의 애프터마켓·주말엔 토스 웹 가격이 정규장 종가라 보내지 않는다 (앱이 시간외 가격을 덮어쓰지 않게)
    webOff: (codes) => stockService.webOff(codes),
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
    calendar: opts.providers.calendar,
    now,
    log,
  });
  const prompts = opts.promptStore ?? new PromptStore();
  const briefingService = new BriefingService({
    db: opts.db, collector, generator, prompts, calendar: opts.providers.calendar, log, now, jobs: generationJobs,
    // 브리핑 2차 6: 종목 브리핑 AI 글 안전하게 (새 프롬프트·가격 줄 요약·금지어 검사)
    safeWording: () => features.enabled("briefingSafeWording"),
    parallel: () => features.enabled("briefingParallel"),
  });
  const analysisService = new AnalysisService({ db: opts.db, collector, generator, prompts, lookup: (code) => stockService.preview(code), valueSafe: () => features.enabled("valueAiSafeWording"), now, log, jobs: generationJobs });

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
      // 브리핑 직전에 토스 계좌를 한 번 더 읽어 수량·평단이 최신이 되게 한다 (상한 30초).
      // 자동 동기화를 껐으면(TOSS_SYNC_MINUTES=0) 하지 않는다 — 잠금이 풀려 직접 고친 값을 덮어쓰지 않게
      ...(tossDeps?.autoSync.enabled ? { beforeRun: () => tossDeps!.autoSync.beforeBriefing() } : {}),
      log,
      now,
    });
    scheduler.start();
    // preClose에는 플러그인 기한이 있으므로 새 예약만 막고 바로 끝낸다. 회수는 아래 마지막 onClose에서 한다.
    app.addHook("preClose", async () => scheduler?.beginShutdown());
  }

  const deviceService = new DeviceService(opts.db, opts.providers.push, now);
  const notificationService = new NotificationService({
    receipts: new ReceiptStore(opts.db),
    push: opts.providers.push,
    devices: deviceService,
    settings: settingsStore,
    log,
    features,
    now,
    ...(opts.receiptDelayMs !== undefined ? { receiptDelayMs: opts.receiptDelayMs } : {}),
  });
  // 지수 띠와 잔고 위젯 지수 줄, 계좌 브리핑(3-31)이 같은 목록(30초 캐시·stale 규칙)을 쓰게 하나만 만든다
  const watchlist = new WatchlistService({ db: opts.db, stocks: stockService, features, notifications: notificationService, settings: settingsStore, now,
    onChange: async () => { await stockService.syncLive().catch(() => log.warn({}, "관심종목 실시간 구독 갱신 실패")); },
    warn: () => log.warn({}, "5% 구간 알림 확인 실패") });
  if (opts.enableScheduler !== false) watchlist.start();
  app.addHook("onClose", async () => watchlist.stop());
  const marketIndices = opts.providers.indices ?? new MarketIndices();
  // 지표 점수 (3-44, 플래그 indicatorScores): 종목 상세의 추세 지표 점수. 일봉은 차트와 같은 캐시, 비교 지수는 위 지수 목록과 같은 인스턴스.
  // 장 마감 뒤(한국 20:10 · 뉴욕 17:30, 평일·거래일만) 등록 종목을 미리 계산해 기록한다. 플래그가 꺼져 있으면 예약이 돌아도 아무것도 하지 않는다
  // 가치 지표 (3-44 2단계, 플래그 valueScore): SEC 재무·주간 비교 기준. 출처가 없으면(테스트 기본) 1단계 그대로
  // 한국 간이 가치 (3-44 3단계, 플래그 krValueScore): 네이버 재무 요약·업종 구성 종목. 출처가 없으면(테스트 기본) 한국 가치 줄은 '지금 계산하지 않음'
  const krValue = new KrValueService({ db: opts.db, features, sources: opts.providers.krValueSources ?? null, now, log });
  const valueScores = new ValueScoreService({ db: opts.db, features, sources: opts.providers.valueSources ?? null, kr: krValue, now, log });
  const indicatorScores = new IndicatorScoreService({
    db: opts.db,
    features,
    value: valueScores,
    sources: opts.providers.scoreSources ?? defaultScoreSources({ db: opts.db, stocks: stockService, indices: marketIndices, product: opts.providers.productInfo ?? null }),
    now,
    log,
  });
  if (opts.enableScheduler !== false) {
    indicatorScores.start();
    app.addHook("onClose", async () => indicatorScores.stop());
  }
  // 다가오는 일정 (브리핑 3차 5, 플래그 holdingEvents·holdingEarnings): 계좌 브리핑이 만들 때 부른다. 출처가 없으면(테스트 기본) 두지 않는다
  const holdingEvents = opts.providers.holdingEvents ? new HoldingEventsService({ sources: opts.providers.holdingEvents, now, log }) : null;
  // 내 종목 테마 (3-35, 플래그 holdingThemes): 아래 발견 탭 서비스를 만든 뒤 채운다 (계좌 브리핑은 부를 때 찾는다). 출처가 없으면(테스트 기본) 두지 않는다
  let holdingThemes: HoldingThemesService | null = null;
  // 새 공시 알림 (3-38, 플래그 filingAlerts): 보유 미국 종목의 SEC 새 공시를 5분마다(미국 동부 평일 06:00~22:59 — SEC 접수 시간) 확인해 표에 넣는다.
  // 표·확인 작업은 공용(SEC 공개 자료), 경로는 보유 종목으로 거른다. 출처가 없으면(테스트 기본) 두지 않는다 — 네트워크 없이
  const heldStocks = async () => (await stockService.list()).filter((s) => (s.quantity ?? 0) > 0);
  const filingHoldings = async () => {
    const held = await heldStocks();
    const us = held.filter((s) => !isKrCode(s.code)).map((s) => s.code);
    // ETF·ETN 가리기: 종목 마스터 분류(ST·EF·EN)가 있으면 그것 (네트워크 없음). 미국 종목은 보통 이 표에 없어 아래 토스 상품 정보로 본다
    const groups = us.length ? new Map((await opts.db.selectFrom("listed_stocks").select(["code", "group_code"]).where("code", "in", us).execute()).map((r) => [r.code, r.group_code])) : new Map<string, string | null>();
    return held.map((s) => ({ code: s.code, name: s.name, groupCode: groups.get(s.code) ?? null }));
  };
  // ETF·ETN 가리기: 미국 종목은 종목 마스터에 없어 토스 웹 상품 정보(group EF·EN — 지표 점수·계좌 비중과 같은 출처, 24시간 캐시)로 본다
  const productInfo = opts.providers.productInfo ?? null;
  const filingWatch = opts.providers.secFilings
    ? new FilingWatchService({ db: opts.db, features, source: opts.providers.secFilings, holdings: filingHoldings, now, log, product: productInfo ? (code) => productInfo.productFacts(code) : null })
    : null;
  if (filingWatch && opts.enableScheduler !== false) {
    const sweep = () => void filingWatch.sweep().catch((e: unknown) => log.warn({ err: e instanceof Error ? e.message : String(e) }, "SEC 공시 확인 실패"));
    const task = cron.schedule("*/5 6-22 * * 1-5", sweep, { timezone: "America/New_York", name: "sec-filings" });
    // 서버를 켤 때 SEC 접수 시간 안이면 바로 한 번 (자동 배포 뒤 5분을 기다리지 않게)
    if (inEdgarHours(now())) sweep();
    app.addHook("onClose", async () => void task.stop());
  }
  // 매매일지 (3-37, 플래그 tradeJournal): 3-36 원자료로 체결 목록·실현손익·기간 수익률·해외주식 양도세 추정. 요청은 저장한 환율만 쓰고,
  // 없는 환율(토스 과거 환율·결제일 매매기준율 — 서울외국환중개 공개 값, 못 받으면 하나은행 고시)은 배경 작업이 10분마다 받는다(플래그가 켜져 있을 때만).
  // 테스트(예약 없음)는 네트워크를 쓰지 않는다
  const journal = new JournalService({
    db: opts.db,
    features,
    fx:
      opts.enableScheduler === false
        ? null
        : {
            tossAt: opts.providers.tossOpenApi ? (iso) => opts.providers.tossOpenApi!.usdKrwAt(iso) : null,
            std: (from, to) => new SmbsStdRates().range(from, to),
            naver: async () => ((await marketIndices.candles("USDKRW", "D", 250))?.candles ?? []).map((c) => ({ date: c.date, rate: c.close })),
          },
    now,
    log,
  });
  if (opts.enableScheduler !== false) {
    journal.start();
    app.addHook("onClose", async () => journal.stop());
  }
  // 계좌 한 장 브리핑 (3-31, 플래그 accountBriefing): 종목별 브리핑 실행이 끝나면 계좌 요약 1건을 만든다
  const accountBriefings = new AccountBriefingService({
    db: opts.db,
    jobs: generationJobs,
    stocks: stockService,
    indices: marketIndices,
    calendar: opts.providers.calendar,
    generator,
    prompts,
    features,
    // 브리핑 3차 4 비중 한 줄 (플래그 accountExposure): 레버리지·인버스는 지표 점수와 같은 토스 웹 상품 정보(같은 인스턴스·24시간 캐시)로 가린다
    productInfo: opts.providers.productInfo ?? null,
    holdingEvents,
    // 3-35 내 종목 테마 카드 (플래그 holdingThemes): 만들 때 그때 값을 저장 (최대 8초 — 넘으면 칸 없이)
    holdingThemes: { snapshot: (held) => (holdingThemes ? holdingThemes.snapshot(held) : Promise.resolve(null)) },
    now,
    log,
  });
  await notificationService.resumeReceipts();
  briefingService.onBriefing(notificationService.onBriefing);
  briefingService.onSessionStart(notificationService.onSessionStart);
  // 시장 전체 요약 (플래그 marketSummary): 아래 발견 탭 서비스(한국 업종)를 만든 뒤 채운다
  let marketSummaries: MarketSummaryService | null = null;
  // 실행이 끝나면 계좌 브리핑을 먼저 만들고, 세션 알림 1건(3-19)의 앞머리에 쓴다. 새 종목 브리핑도 새 계좌 브리핑도 없으면 알림 없음(예전과 같음).
  // 시장 요약은 계좌 브리핑과 함께 만들고 알림 본문 첫 줄에 쓴다 — 20초 안에 못 만들면 첫 줄 없이 보낸다(요약은 이어서 만들어 카드에 보인다).
  // 시장 요약만으로는 알림을 만들지 않는다 (두 시장이 모두 쉰 날은 예전처럼 0건)
  briefingService.onRunDone(async (done) => {
    const market = marketSummaries ? marketSummaries.afterRun(done, { waitMs: SUMMARY_WAIT_MS }) : Promise.resolve(null);
    const account = await accountBriefings.afterRun(done);
    const summary = await market;
    if (done.created.length > 0 || account) await notificationService.onSession({ ...done, account, market: summary });
  });
  // 브리핑 3차 2 늦음·실패 안내 (플래그 briefingStatus): 실행이 끝날 때마다(알림을 보낸 뒤 — 위 리스너 다음) 실행 기록 한 줄. 꺼져 있으면 쓰지 않는다
  const briefingStatus = new BriefingStatusService({
    db: opts.db,
    features,
    settings: () => settingsStore.get(),
    calendar: opts.providers.calendar,
    progress: () => briefingService.currentProgress(),
    llmConfigured: () => opts.providers.generator.model !== "disabled",
    now,
    log,
  });
  briefingService.onRunDone(briefingStatus.onRunDone);
  app.addHook("onClose", async () => notificationService.stop());

  app.decorate("stockService", stockService);
  app.decorate("briefingService", briefingService);
  app.decorate("accountBriefings", accountBriefings);
  app.decorate("analysisService", analysisService);
  app.decorate("scheduler", scheduler);
  app.decorate("deviceService", deviceService);
  app.decorate("notificationService", notificationService);
  app.decorate("settingsStore", settingsStore);
  app.decorate("priceStream", priceStream);
  app.decorate("tradeRecords", tradeRecords);
  app.decorate("indicatorScores", indicatorScores);
  app.decorate("valueScores", valueScores);
  app.decorate("krValue", krValue);
  app.decorate("filingWatch", filingWatch);
  app.decorate("journal", journal);

  // 서버 처리 시간 (응답 헤더 Server-Timing: app;dur=ms) — 네트워크를 뺀 서버 몫을 앱·측정 스크립트가 볼 수 있게
  app.addHook("onRequest", async (req) => {
    (req as { startedAt?: bigint }).startedAt = process.hrtime.bigint();
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const started = (req as { startedAt?: bigint }).startedAt;
    if (started !== undefined) reply.header("server-timing", `app;dur=${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}`);
    return payload;
  });
  // 끊겼을 때 데이터 절약 (플래그 pollSaver, 3-25): 잔고·상세·지수 등 자주 묻는 GET 에 ETag·304·바뀐 부분만·gzip (라우트 등록 전에)
  const pollSaver = registerPollSaver(app, { enabled: () => features.enabled("pollSaver") });

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
    // 본문 크기 초과·JSON 형식 오류 등 Fastify 가 붙인 4xx 는 그대로 (본문 내용은 기록하지 않음)
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as { code?: string }).code ?? "BAD_REQUEST", message: status === 413 ? "요청 본문이 너무 큽니다" : "요청 형식이 올바르지 않습니다" });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "INTERNAL", message: "서버 오류" });
  });

  /** 브라우저로 주소만 열었을 때 보이는 안내 페이지. 모델·알림 기기 수·브리핑 시각은 /health 처럼 토큰을 설정하지 않았거나 맞는 토큰을 보낸 요청에만 */
  app.get("/", async (req, reply) => {
    const auth = req.headers.authorization;
    const detail = !opts.config.API_TOKEN || (typeof auth === "string" && auth.startsWith("Bearer ") && sameSecret(auth.slice(7), opts.config.API_TOKEN));
    const h = detail ? await deviceService.enabledTokens() : [];
    const jobs = detail ? (scheduler?.status().jobs ?? []) : [];
    const protectedApi = Boolean(opts.config.API_TOKEN);
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>주식 브리핑 서버</title>
<style>body{font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6;color:#1b221d;background:#f5f6f3}h1{font-size:1.4rem}code{background:#eef0eb;padding:2px 6px;border-radius:4px}.ok{color:#1f6f5c;font-weight:600}.warn{color:#b3261e;font-weight:600}small{color:#5f6a63}</style></head>
<body><h1>주식 브리핑 서버 <span class="ok">정상 작동 중</span></h1>
<p>이 주소는 휴대폰 앱이 접속하는 서버입니다. 앱의 <b>설정 탭 → 서버 주소</b>에 이 주소를 입력하세요.</p>
<ul><li>서버 시각: ${seoulIso(now())}</li>${detail ? `<li>브리핑 모델: ${describeProviders(opts.config).llm}</li><li>등록된 알림 기기: ${h.length}대</li>` : ""}${jobs.map((j) => `<li>다음 ${j.session === "morning" ? "오전" : "오후"} 브리핑: ${j.nextRun ? new Date(j.nextRun).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "-"}</li>`).join("")}</ul>
${protectedApi ? "" : `<p class="warn">주의: API 토큰(API_TOKEN)이 설정되지 않아 누구나 API 에 접근할 수 있습니다. 인터넷에 공개한 서버라면 서버 설정에 API_TOKEN 을 넣으세요.</p>\n`}<p><small>상태 확인: <a href="/health">/health</a>${protectedApi ? " · API 는 토큰이 필요합니다." : ""}</small></p>
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
    // 대조를 끄면(3-15) 옛 기록의 경고도 내보내지 않는다 (예전 앱 빌드에서도 줄이 사라지게)
    tossOpenApi: { ...tossStatus(tossDeps, await outboundIp()), reconcile: tossDeps && (await features.enabled("tossReconcile")) ? await tossDeps.reconcile.status().catch(() => null) : null },
    lastBriefing: briefingService.lastRun,
    // 시장 요약 일정 목록의 종류별 마지막 날짜 (지나면 그 일정은 빼고 요약한다 — 해마다 새로 넣기)
    marketSummary: marketSummaries ? { enabled: await features.enabled("marketSummary"), eventsCoverage: marketSummaries.eventsCoverage() } : null,
    stream: priceStream.status(),
    // 켜져 있을 때만 (끄면 응답이 예전과 같게): 전체·304·바뀐 부분만·gzip 횟수
    ...((await features.enabled("pollSaver")) ? { pollSaver: { ...pollSaver.stats, remembered: pollSaver.ring.size } } : {}),
    llmConfigured: opts.providers.generator.model !== "disabled",
    appErrors: await appErrors.counts(7).catch(() => null),
    quotes: stockService.quoteStatus(),
    candles: stockService.candleStatus(),
    fundamentalsCache: opts.providers.fundamentals?.cacheStats() ?? null,
    notificationDelivery: await notificationService.deliveryStatus().catch(() => null),
    backup: await backups.status().catch(() => null),
    // 매매 기록(3-36): 켜져 있을 때만 (끄면 응답이 예전과 같게). 최근 5·30거래일 스냅샷이 빠진 날이 있으면 warning — ok 는 그대로 true
    ...((await features.enabled("tradeRecords")) ? { tradeRecords: await tradeRecords.status().catch(() => null) } : {}),
    // 다가오는 일정(브리핑 3차 5): 켜져 있고 출처가 있을 때만 (끄면 응답이 예전과 같게). 마지막으로 모두 받은 시각 · 받지 못한 것·두 출처가 다른 것 경고
    ...(holdingEvents && (await features.enabled("holdingEvents")) ? { holdingEvents: holdingEvents.health() } : {}),
    // 내 종목 테마(3-35): 켜져 있고 서비스가 있을 때만 (끄면 응답이 예전과 같게). 한국 테마 표 시각·테마 수, 거래대금 마지막 기록일, 경고
    ...(holdingThemes && (await features.enabled("holdingThemes")) ? { holdingThemes: holdingThemes.health() } : {}),
    // 새 공시 알림(3-38): 켜져 있고 출처가 있을 때만 (끄면 응답이 예전과 같게). 마지막으로 모두 받은 시각 · 확인 종목 수 · 경고(stale·partial·shape·blocked)
    ...(filingWatch && (await features.enabled("filingAlerts")) ? { filingAlerts: await filingWatch.health().catch(() => null) } : {}),
    disclaimer: DISCLAIMER,
  });

  // 없는 경로도 앱 표준 오류 형식으로
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "NOT_FOUND", message: `없는 주소입니다: ${req.method} ${req.url.split("?")[0]}` }));

  await app.register(marketRoutes, { prefix: "/api/market", calendar: opts.providers.calendar, indices: marketIndices });
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

  // 내 보유 종목 × 테마 강도 (3-35, 플래그 holdingThemes): 발견 탭과 같은 인스턴스(목록·미국 테마북·시세 캐시)를 부르기만 한다.
  // 분류(토스 회사 테마·네이버 업종)·한국 테마 표·거래대금 기록은 meta 표에 (마이그레이션 없음). 예약 작업은 도는 순간 플래그를 확인한다 (꺼지면 요청 0건)
  if (opts.providers.holdingThemes) {
    const store = metaStore(opts.db);
    const productInfo = opts.providers.productInfo ?? null;
    const ht = new HoldingThemesService({
      features,
      discover: discoverService,
      naver: discoverNaver,
      krIndex: new KrThemeIndex({ naver: discoverNaver, store, now, log }),
      maps: new HoldingThemeMaps({ sources: opts.providers.holdingThemes, store, now, log }),
      tv: new ThemeTvHistory({ store }),
      // 잔고 탭 '보유'와 같은 판정 (수량 > 0 · 평단 있음), 평가금액은 계좌 브리핑과 같은 원화 환산
      holdings: async () => positionsOf(await stockService.listWithQuotes(), { afterCost: true }).map((p) => ({ code: p.code, name: p.name, value: p.value })),
      // 레버리지 단일 종목의 기초 (지표 점수·비중 한 줄과 같은 가리기 — 토스 웹 상품 정보 24시간 캐시 + 종목 마스터 분류)
      underlying: async (code, name) => {
        const [facts, group] = await Promise.all([productInfo ? within(productInfo.productFacts(code), 3_000, null) : Promise.resolve(null), groupCodeOf(opts.db, code).catch(() => null)]);
        return underlyingOfKind(productKindOf(code, name, facts, group));
      },
      disclaimer: DISCLAIMER,
      now,
      log,
    });
    holdingThemes = ht;
    await app.register(holdingThemeRoutes, { prefix: "/api/holdings", service: ht });
    await app.register(holdingThemeAdminRoutes, { prefix: "/api/admin/holding-themes", service: ht });
    if (opts.enableScheduler !== false) {
      const warm = setTimeout(() => void ht.warm().catch((e: unknown) => app.log.warn({ err: String(e) }, "한국 테마 표 준비 실패")), 60_000);
      const idxTask = cron.schedule("40 5 * * 0", () => void ht.rebuildKrIndex().catch((e: unknown) => app.log.warn({ err: String(e) }, "한국 테마 표 주간 갱신 실패")), { timezone: "Asia/Seoul", name: "holding-themes-kr-index" });
      const krTv = cron.schedule("10 20 * * 1-5", () => void ht.recordTv("KR").catch((e: unknown) => app.log.warn({ err: String(e) }, "한국 테마 거래대금 기록 실패")), { timezone: "Asia/Seoul", name: "holding-themes-kr-tv" });
      const usTv = cron.schedule("15 16 * * 1-5", () => void ht.recordTv("US").catch((e: unknown) => app.log.warn({ err: String(e) }, "미국 테마 거래대금 기록 실패")), { timezone: "America/New_York", name: "holding-themes-us-tv" });
      // 16:15 에 아직 장이 끝난 값이 아니어서(출처 상태 OPEN) 건너뛰었으면 한 번 더 (적었으면 요청 0건)
      const usTvRetry = cron.schedule("45 16 * * 1-5", () => void ht.recordTv("US", { onlyIfMissing: true }).catch((e: unknown) => app.log.warn({ err: String(e) }, "미국 테마 거래대금 기록 실패")), { timezone: "America/New_York", name: "holding-themes-us-tv-retry" });
      app.addHook("onClose", async () => {
        clearTimeout(warm);
        void idxTask.stop();
        void krTv.stop();
        void usTv.stop();
        void usTvRetry.stop();
      });
    }
  }

  // 시장 전체 요약: 지수·환율은 지수 띠와 같은 인스턴스, 한국 업종은 발견 탭과 같은 계산, 뉴스는 구글 뉴스 RSS(키 없음).
  // 테스트 기본 출처 묶음(fakeProviders)은 null → 서비스를 두지 않는다 (네트워크 없음)
  if (opts.providers.marketSummary !== null) {
    marketSummaries = new MarketSummaryService({
      db: opts.db,
      features,
      now,
      log,
      sources:
        opts.providers.marketSummary ??
        defaultSummarySources({
          db: opts.db,
          indices: marketIndices,
          naver: discoverNaver,
          calendar: opts.providers.calendar,
          krSectors: async () => {
            const l = await discoverService.themes("KR", "sector", "day");
            // asOf: 출처가 값을 비워 저장본을 줄 때 그 저장본이 기준 거래일 값인지 보려고 (krSectorsStale)
            return { themes: l.themes, note: l.note, asOf: l.asOf };
          },
          news: new GoogleNewsRssProvider(),
        }),
    });
  }
  const summaries = marketSummaries;
  // 장중·최종값 전 요약의 '확정 뒤 다시 만들기' 예약을 닫을 때 취소
  if (summaries) app.addHook("onClose", async () => summaries.stop());
  // 다시 켤 때(자동 배포 등) 사라진 '확정 뒤 다시 만들기' 예약을 되살린다 — 카드에 '장중 값'·'최종값 확정 전'이 다음 세션까지 남지 않게
  if (summaries && opts.enableScheduler !== false) void summaries.resumeRefinal().catch((e: unknown) => app.log.warn({ err: String(e) }, "시장 요약 다시 만들기 예약 복구 실패"));
  app.decorate("marketSummaries", summaries);
  if (summaries) await app.register(marketSummaryRoutes, { prefix: "/api/market-summaries", service: summaries });

  /** GET /api/stream (웹소켓) — 등록 종목 체결가를 실시간으로 밀어 준다. 인증은 Authorization 헤더 또는 ?token= */
  app.get("/api/stream", { websocket: true }, (socket) => {
    priceStream.attach(socket);
  });

  await app.register(stockRoutes, { prefix: "/api/stocks", service: stockService });
  await app.register(priceAlertRoutes, { prefix: "/api/price-alerts", service: priceAlerts });
  await app.register(watchlistRoutes, { prefix: "/api/watchlist", service: watchlist, features });
  await app.register(watchGroupRoutes, { prefix: "/api/watch-groups", service: watchGroups });
  await app.register(analysisRoutes, {
    prefix: "/api/stocks",
    service: analysisService,
    features,
    stocks: stockService,
    news: opts.providers.news,
    financials: opts.providers.financials,
    financialsUs: opts.providers.financialsUs,
  });
  await app.register(briefingRoutes, { prefix: "/api/briefings", service: briefingService, scheduler, status: briefingStatus });
  await app.register(accountBriefingRoutes, {
    prefix: "/api/account-briefings",
    service: accountBriefings,
    busy: async () => briefingService.isRunning || accountBriefings.isRunning || await generationJobs.anyRunning(["briefing:", "account:"]),
    now,
    // 관리용 실행은 그 세션의 브리핑 시각(알림 설정) 뒤에만 — 아직 오지 않은 세션을 미리 만들어 예약 실행이 건너뛰지 않게
    sessionTime: async (session) => {
      const s = await settingsStore.get();
      return session === "morning" ? s.morningTime : s.afternoonTime;
    },
  });
  await app.register(featureRoutes, { prefix: "/api/features", features });
  // accounts: 계좌 한 장 브리핑(3-31)이 켜져 있으면 최근 id 를 위젯 응답에 넣어 앱 백그라운드 알림이 새 계좌 브리핑도 알아보게
  // schedule: 브리핑 위젯 안내에 설정한 브리핑 시간을 쓴다 (BH-68 — 예전에는 늘 '평일 08:30·16:00')
  // 브리핑 위젯 첫 줄(시장 전체 요약): 새 앱이 &ms=1 로 물을 때만, 플래그가 켜져 있을 때만 가장 최근 요약을 읽는다
  await app.register(widgetRoutes, { prefix: "/api/widget", stocks: stockService, briefings: briefingService, calendar: opts.providers.calendar, features, indices: marketIndices, accounts: accountBriefings, schedule: () => settingsStore.get(), ...(summaries ? { summaries } : {}), tossAccount: () => readTossAccountSnapshot(tossDeps, features), filings: filingWatch });
  // 새 공시 알림·일정 화면 (3-38): GET /api/filings/alerts (filingAlerts) · GET /api/schedule (holdingSchedule) — 둘 다 개인 경로(보유 종목 기준)
  await app.register(filingRoutes, {
    prefix: "/api",
    features,
    filings: filingWatch,
    events: holdingEvents,
    holdings: async () => (await heldStocks()).map((s) => ({ code: s.code, name: s.name })),
    dartKey: Boolean(opts.config.DART_API_KEY),
    now,
  });
  await app.register(featureAdminRoutes, { prefix: "/api/admin/features", features, afterSet: async (patch) => { if ("watchlistSteps" in patch) await stockService.syncLive(); } });
  await app.register(adminRoutes, { prefix: "/api/admin", service: stockService, dart: opts.providers.dart, toss: tossDeps, outboundIp, backups, features });
  await app.register(tradeRecordRoutes, { prefix: "/api", service: tradeRecords, now });
  await app.register(tradeRecordAdminRoutes, { prefix: "/api/admin/trade-records", service: tradeRecords });
  await app.register(scoreRoutes, { prefix: "/api/scores", service: indicatorScores });
  // 수급 탭 (3-33, 플래그 flowTab): 공용 경로(시장 자료) + 관리 경로(토스 Open API 대조 원자료). 출처 묶음이 없으면(테스트 기본) 404
  const investorFlow = new InvestorFlowService({ features, sources: opts.providers.investorFlowSources ?? null, now, log });
  await app.register(investorFlowRoutes, { prefix: "/api/investor-flow", service: investorFlow });
  await app.register(investorFlowAdminRoutes, { prefix: "/api/admin/investor-flow", service: investorFlow });
  await app.register(journalRoutes, { prefix: "/api", service: journal, now });
  await app.register(journalAdminRoutes, { prefix: "/api/admin/journal", service: journal, now });
  await app.register(appErrorRoutes, { prefix: "/api/app-errors", service: appErrors });
  await app.register(appErrorAdminRoutes, { prefix: "/api/admin/app-errors", service: appErrors });
  // running: 종목 브리핑과 이어지는 계좌 브리핑·시장 요약을 만드는 동안 (앱 백그라운드 알림이 기다렸다가 한 번에 알리게)
  const notifDeps = { devices: deviceService, notifications: notificationService, settings: settingsStore, scheduler, features, isRunning: async () => briefingService.isRunning || accountBriefings.isRunning || (marketSummaries?.isRunning ?? false) || await generationJobs.anyRunning(["briefing:", "account:"]) };
  await app.register(deviceRoutes, { prefix: "/api/devices", ...notifDeps });
  await app.register(notificationRoutes, { prefix: "/api/notifications", ...notifDeps });

  // 연결이 끊긴 수동 요청도 생성·저장을 끝낸다. 예약 종료 훅 뒤, 다른 자원 정리 전에 회수한다.
  app.addHook("onClose", async () => {
    await Promise.all([analysisService.shutdown(), briefingService.shutdown()]);
    await accountBriefings.shutdown();
    await opts.providers.fundamentals?.flushCache();
  });
  // onClose는 역순이다. 예약 사전 작업이 새 브리핑을 시작할 수 있으므로 예약부터 회수한다.
  if (scheduler) app.addHook("onClose", async () => scheduler.shutdown());
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    stockService: StockService;
    briefingService: BriefingService;
    accountBriefings: AccountBriefingService;
    /** 시장 전체 요약 (출처 묶음이 null 인 테스트에서는 null) */
    marketSummaries: MarketSummaryService | null;
    analysisService: AnalysisService;
    scheduler: BriefingScheduler | null;
    deviceService: DeviceService;
    notificationService: NotificationService;
    settingsStore: NotificationSettingsStore;
    priceStream: PriceStream;
    /** 매매 기록 (3-36): 일별 스냅샷·체결 저장. 브리핑 '어제와 비교'는 previousSnapshot 을 쓴다 */
    tradeRecords: TradeRecordService;
    /** 지표 점수 (3-44): 종목 상세의 추세 지표 점수·장 마감 뒤 기록 */
    indicatorScores: IndicatorScoreService;
    valueScores: ValueScoreService;
    /** 한국 간이 가치 (3-44 3단계) */
    krValue: KrValueService;
    /** 새 공시 알림 (3-38): SEC 확인 작업 (출처가 없는 테스트 기본은 null) */
    filingWatch: FilingWatchService | null;
    /** 매매일지 (3-37): 체결 목록·실현손익·기간 수익률·양도세 추정 */
    journal: JournalService;
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

/** 요청 로그: Fastify 기본 항목과 같되, 주소의 token 쿼리(웹소켓 인증)와 경로의 푸시 토큰은 가린다 (서버 로그에 API 토큰·푸시 토큰이 남지 않게) */
function logReq(req: FastifyRequest): { method: string; url: string; host: string; remoteAddress: string; version?: string; remotePort?: number } {
  const version = req.headers?.["accept-version"];
  const port = req.socket?.remotePort;
  return {
    method: req.method,
    url: redactToken(redactPushToken(req.url, req.routeOptions?.url)),
    host: req.host,
    remoteAddress: req.ip,
    ...(typeof version === "string" ? { version } : {}),
    ...(port !== undefined ? { remotePort: port } : {}),
  };
}

/**
 * 경로에 실린 Expo 푸시 토큰을 가린다 (알림 끄기 DELETE /api/devices/:token — 토큰만 알면 그 기기로 알림을 보낼 수 있다).
 * 그 라우트로 온 요청은 경로를 라우트 모양으로 적고(UUID 모양 토큰·인코딩한 경로 포함), 다른 주소는 ExponentPushToken[…] 모양만 가린다
 */
function redactPushToken(url: string, route: string | undefined): string {
  if (route === "/api/devices/:token") {
    const q = url.search(/[?#;]/);
    return `/api/devices/[redacted]${q < 0 ? "" : url.slice(q)}`;
  }
  return url.replace(/(Expo(?:nent)?PushToken)(?:\[|%5B)[^/?#;&]*/gi, "$1[redacted]");
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
