import type { FastifyPluginAsync } from "fastify";
import type { DartProvider } from "../providers/dart/dart.js";
import type { TossOpenApiProvider } from "../providers/market/tossOpenApi.js";
import type { TossRealtime } from "../providers/market/tossRealtime.js";
import type { BackupService } from "../services/backupService.js";
import type { ReconcileService } from "../services/reconcileService.js";
import type { StockService } from "../services/stockService.js";
import type { HoldingsAutoSync, TossSyncService } from "../services/tossSyncService.js";

export interface AdminDeps {
  service: StockService;
  dart: DartProvider | null;
  toss?: { provider: TossOpenApiProvider; sync: TossSyncService; autoSync: HoldingsAutoSync; live: TossRealtime | null; outboundIp: () => Promise<string | null>; reconcile: ReconcileService } | null;
  /** 서버 공인 IP 조회 (키가 없을 때도 앱 카드에 허용 IP 등록용으로 보여 준다) */
  outboundIp?: () => Promise<string | null>;
  backups?: BackupService;
}

/** 토스 Open API 연동 상태 (앱 설정 화면용). 키가 없어도 200 으로 configured:false 를 준다 */
export function tossStatus(deps: AdminDeps["toss"], ip: string | null) {
  if (!deps) return { configured: false, outboundIp: ip, client: null, realtime: null, sync: null };
  return { configured: true, outboundIp: ip, client: deps.provider.client.status, realtime: deps.live?.status() ?? null, sync: deps.autoSync.status() };
}

/** 운영용 엔드포인트. API_TOKEN 이 있으면 /api/* 전체에 적용된다. */
export const adminRoutes: FastifyPluginAsync<AdminDeps> = async (app, { service, dart, toss, outboundIp, backups }) => {
  /** DB 백업: 상태·목록, 지금 백업, 암호화된 파일 내려받기 (복구 리허설·외부 보관용) */
  app.get("/backups", async () => ({ status: await backups?.status(), files: (await backups?.list()) ?? [] }));
  app.post("/backups/run", async () => backups?.run() ?? { enabled: false });
  app.get("/backups/:name", async (req, reply) => {
    const buf = await backups?.read((req.params as { name: string }).name);
    if (!buf) return reply.code(404).send({ error: "NOT_FOUND", message: "백업 파일이 없습니다" });
    return reply.type("application/octet-stream").send(buf);
  });

  app.get("/master", async () => service.masterStatus());
  app.post("/master/refresh", async () => service.refreshMaster());

  /** 토스증권 Open API 상태: 키 설정 여부, 토큰/마지막 오류, 허용 IP 에 등록할 서버 공인 IP, 실시간 구독 */
  app.get("/toss/status", async () => ({
    ...tossStatus(toss, outboundIp ? await outboundIp() : toss ? await toss.outboundIp() : null),
    reconcile: toss ? await toss.reconcile.status().catch(() => null) : null,
  }));
  /** 토스 대조 기록 (최근 순) */
  app.get("/toss/reconcile", async (_req, reply) => {
    if (!toss) return reply.code(503).send({ error: "TOSS_DISABLED", message: "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았습니다" });
    return { status: await toss.reconcile.status(), history: (await toss.reconcile.history()).slice(-50).reverse() };
  });

  /** 토스증권 계좌의 보유 종목을 등록 종목으로 가져온다 (수량·평단 동기화) */
  app.post("/toss/import-holdings", async (_req, reply) => {
    if (!toss) return reply.code(503).send({ error: "TOSS_DISABLED", message: "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았습니다" });
    // 수동 실행. 자동 동기화와 같은 경로라 실시간 구독 갱신·상태 기록까지 같이 된다
    return toss.autoSync.run("manual");
  });

  /** 해외 종목 원화 매입금액 장부 보기 (종목별 원화 매입금액, exact/estimated, 계좌 보정 구간·비율) */
  app.get("/toss/krw-cost", async (_req, reply) => {
    if (!toss) return reply.code(503).send({ error: "TOSS_DISABLED", message: "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았습니다" });
    const state = await toss.sync.costBook.load();
    return {
      factor: state.factor,
      calib: state.calib,
      items: Object.fromEntries([...(await service.krwCosts())]),
      entries: Object.values(state.items).map(({ applied: _applied, ...e }) => e),
    };
  });

  /**
   * 토스 앱에서 본 해외 종목 원화 매입금액을 정확한 값으로 넣는다 (토스 앱 원화 보기의 평가금액 − 평가손익).
   * body: { items: { "SOXL": 24557187, ... } }. 현재 보유 수량·달러 매입금액과 함께 저장되고, 이후 매도만 있으면 비율대로 유지된다.
   */
  app.put("/toss/krw-cost", async (req, reply) => {
    if (!toss) return reply.code(503).send({ error: "TOSS_DISABLED", message: "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았습니다" });
    const body = req.body as { items?: Record<string, unknown> } | undefined;
    const values: Record<string, number> = {};
    for (const [code, v] of Object.entries(body?.items ?? {})) {
      const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) values[code.toUpperCase()] = n;
    }
    // skipped: [{ code, reason: not_held | orders_failed | unexplained | changed, retryAfter? }]
    const r = await toss.sync.setExactKrw(values);
    return { ...r, items: Object.fromEntries([...(await service.krwCosts())]) };
  });

  /** 진단용: 토스 계좌·보유 종목 원본 응답 (필드 구성 확인) */
  app.get("/toss/holdings-raw", async (_req, reply) => {
    if (!toss) return reply.code(503).send({ error: "TOSS_DISABLED", message: "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았습니다" });
    const accounts = await toss.provider.accounts();
    return { accounts, holdings: await Promise.all(accounts.map((a) => toss.provider.holdingsRaw(a.accountSeq))) };
  });

  /**
   * 진단용 읽기 전용 프록시: 토스 Open API 의 GET /api/v1/* 경로를 그대로 호출해 원본 응답을 돌려준다.
   * 주문 같은 쓰기 요청은 할 수 없다(GET 만, 경로 형식 제한). account=<accountSeq> 를 주면 계좌 헤더를 붙인다.
   *   GET /api/admin/toss/probe?path=/api/v1/holdings&account=1&q=currency%3DKRW
   */
  app.get("/toss/probe", async (req, reply) => {
    if (!toss) return reply.code(503).send({ error: "TOSS_DISABLED", message: "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았습니다" });
    const q = req.query as { path?: string; account?: string; q?: string };
    const path = String(q.path ?? "");
    if (!/^\/api\/v1\/[a-z0-9\-/]+$/i.test(path)) return reply.code(400).send({ error: "BAD_PATH", message: "path 는 /api/v1/... 형식이어야 합니다" });
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(q.q ?? "")) params[k] = v;
    const headers: Record<string, string> = q.account ? { "X-Tossinvest-Account": String(q.account) } : {};
    try {
      return { ok: true, result: await toss.provider.client.get<unknown>(path, params, headers) };
    } catch (e) {
      return reply.code(200).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** DART 고유번호 매핑 갱신 (DART 키 필요) */
  app.post("/dart/refresh", async (_req, reply) => {
    if (!dart) return reply.code(503).send({ error: "DART_DISABLED", message: "DART_API_KEY 가 설정되지 않았습니다" });
    const count = await dart.refreshCorpCodes();
    return { count };
  });
};
