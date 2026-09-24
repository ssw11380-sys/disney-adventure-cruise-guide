import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { FastifyPluginAsync } from "fastify";
import type { MarketCalendar } from "../providers/market/calendar.js";
import type { MarketIndices } from "../providers/market/indices.js";
import type { BriefingService } from "../services/briefingService.js";
import type { FeatureService } from "../services/featureService.js";
import type { StockService } from "../services/stockService.js";
import { buildWidgetPayload, type WidgetFeatures } from "../services/widgetPayload.js";

/**
 * GET /api/widget — 홈 화면 위젯 3종이 같이 쓰는 한 번의 응답 (3-16).
 * ETag 가 같으면 304(본문 없음), gzip 을 받으면 압축해서 보낸다 (휴장일 위젯 트래픽을 줄이려고).
 * ETag 는 본문으로 만들므로 지수·플래그가 바뀌면 달라지고, 값이 같으면(휴장 중 지수) 그대로 304 다.
 *  - features: 위젯이 쓰는 플래그 (widgetPnlToggle·widgetIndexLine)
 *  - indices: widgetIndexLine 이 켜져 있고 앱이 ?indices=1 로 물을 때만 지수 띠와 같은 목록(같은 인스턴스·30초 캐시·stale 규칙)에서
 *    코스피·나스닥·원/달러. 지수 줄을 그리지 않는 예전 앱(쿼리 없음)에는 넣지도 부르지도 않는다 — 한국 종목만 가진 사용자가
 *    장이 닫힌 뒤에도 나스닥·환율이 바뀌어 304 대신 200 을 받지 않게. 끄면 지수를 부르지도 않는다. 지수를 못 받으면 빼고 보낸다(위젯은 줄을 감춘다)
 */
export const widgetRoutes: FastifyPluginAsync<{ stocks: StockService; briefings: BriefingService; calendar: MarketCalendar; features?: FeatureService; indices?: MarketIndices }> = async (app, deps) => {
  const flags = async (): Promise<WidgetFeatures | undefined> => {
    if (!deps.features) return undefined;
    const [widgetPnlToggle, widgetIndexLine] = await Promise.all([deps.features.enabled("widgetPnlToggle"), deps.features.enabled("widgetIndexLine")]);
    return { widgetPnlToggle, widgetIndexLine };
  };
  app.get("/", async (req, reply) => {
    const features = flags();
    const wantsIndices = (req.query as { indices?: unknown } | undefined)?.indices === "1";
    const indices = features.then((f) => (wantsIndices && f?.widgetIndexLine && deps.indices ? deps.indices.list({ stale: true }).catch(() => null) : null));
    const [list, latest, status, f, idx] = await Promise.all([deps.stocks.listWithQuotes(), deps.briefings.latestPerStock(), deps.calendar.status().catch(() => null), features, indices]);
    const body = JSON.stringify(buildWidgetPayload(list, latest, status, { features: f, indices: idx }));
    const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
    reply.header("etag", etag).header("cache-control", "no-cache").header("vary", "accept-encoding");
    // 프록시가 약한 ETag(W/"…")로 바꾸거나 여러 개를 보내도 맞춰 본다
    const inm = String(req.headers["if-none-match"] ?? "").split(",").map((t) => t.trim().replace(/^W\//, ""));
    if (inm.includes(etag)) return reply.code(304).send();
    reply.type("application/json; charset=utf-8");
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return reply.header("content-encoding", "gzip").send(gzipSync(body));
    return reply.send(body);
  });
};
