import type { FastifyPluginAsync } from "fastify";
import type { DartProvider } from "../providers/dart/dart.js";
import type { TossOpenApiProvider } from "../providers/market/tossOpenApi.js";
import type { TossRealtime } from "../providers/market/tossRealtime.js";
import type { StockService } from "../services/stockService.js";
import type { HoldingsAutoSync, TossSyncService } from "../services/tossSyncService.js";

export interface AdminDeps {
  service: StockService;
  dart: DartProvider | null;
  toss?: { provider: TossOpenApiProvider; sync: TossSyncService; autoSync: HoldingsAutoSync; live: TossRealtime | null; outboundIp: () => Promise<string | null> } | null;
  /** 서버 공인 IP 조회 (키가 없을 때도 앱 카드에 허용 IP 등록용으로 보여 준다) */
  outboundIp?: () => Promise<string | null>;
}

/** 토스 Open API 연동 상태 (앱 설정 화면용). 키가 없어도 200 으로 configured:false 를 준다 */
export function tossStatus(deps: AdminDeps["toss"], ip: string | null) {
  if (!deps) return { configured: false, outboundIp: ip, client: null, realtime: null, sync: null };
  return { configured: true, outboundIp: ip, client: deps.provider.client.status, realtime: deps.live?.status() ?? null, sync: deps.autoSync.status() };
}

/** 운영용 엔드포인트. API_TOKEN 이 있으면 /api/* 전체에 적용된다. */
export const adminRoutes: FastifyPluginAsync<AdminDeps> = async (app, { service, dart, toss, outboundIp }) => {
  app.get("/master", async () => service.masterStatus());
  app.post("/master/refresh", async () => service.refreshMaster());

  /** 토스증권 Open API 상태: 키 설정 여부, 토큰/마지막 오류, 허용 IP 에 등록할 서버 공인 IP, 실시간 구독 */
  app.get("/toss/status", async () => tossStatus(toss, outboundIp ? await outboundIp() : toss ? await toss.outboundIp() : null));

  /** 토스증권 계좌의 보유 종목을 등록 종목으로 가져온다 (수량·평단 동기화) */
  app.post("/toss/import-holdings", async (_req, reply) => {
    if (!toss) return reply.code(503).send({ error: "TOSS_DISABLED", message: "TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았습니다" });
    // 수동 실행. 자동 동기화와 같은 경로라 실시간 구독 갱신·상태 기록까지 같이 된다
    return toss.autoSync.run("manual");
  });

  /** DART 고유번호 매핑 갱신 (DART 키 필요) */
  app.post("/dart/refresh", async (_req, reply) => {
    if (!dart) return reply.code(503).send({ error: "DART_DISABLED", message: "DART_API_KEY 가 설정되지 않았습니다" });
    const count = await dart.refreshCorpCodes();
    return { count };
  });
};
