import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { FastifyPluginAsync } from "fastify";
import type { MarketCalendar } from "../providers/market/calendar.js";
import type { BriefingService } from "../services/briefingService.js";
import type { StockService } from "../services/stockService.js";
import { buildWidgetPayload } from "../services/widgetPayload.js";

/**
 * GET /api/widget — 홈 화면 위젯 3종이 같이 쓰는 한 번의 응답 (3-16).
 * ETag 가 같으면 304(본문 없음), gzip 을 받으면 압축해서 보낸다 (휴장일 위젯 트래픽을 줄이려고).
 */
export const widgetRoutes: FastifyPluginAsync<{ stocks: StockService; briefings: BriefingService; calendar: MarketCalendar }> = async (app, deps) => {
  app.get("/", async (req, reply) => {
    const [list, latest, status] = await Promise.all([deps.stocks.listWithQuotes(), deps.briefings.latestPerStock(), deps.calendar.status().catch(() => null)]);
    const body = JSON.stringify(buildWidgetPayload(list, latest, status));
    const etag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
    reply.header("etag", etag).header("cache-control", "no-cache").header("vary", "accept-encoding");
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.type("application/json; charset=utf-8");
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return reply.header("content-encoding", "gzip").send(gzipSync(body));
    return reply.send(body);
  });
};
