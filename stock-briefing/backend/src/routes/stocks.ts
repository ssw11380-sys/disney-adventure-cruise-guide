import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { CODE_RE, normalizeCode } from "../lib/codes.js";
import { evaluate, type StockService } from "../services/stockService.js";

const codeParam = z.object({ code: z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE, "종목 코드는 6자리 숫자(한국) 또는 티커(미국)")) });
const money = z.number().nonnegative().nullable().optional();

const registerBody = z.object({
  code: z.string().transform(normalizeCode).pipe(z.string().regex(CODE_RE, "종목 코드는 6자리 숫자(한국) 또는 티커(미국)")),
  quantity: money,
  avgPrice: money,
  memo: z.string().max(500).nullable().optional(),
});
const updateBody = registerBody.omit({ code: true });
const searchQuery = z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(50).default(20) });
const quoteQuery = z.object({ fresh: z.coerce.boolean().default(false) });
const candlesQuery = z.object({
  period: z.enum(["1m", "5m", "30m", "D", "W", "M"]).default("D"),
  count: z.coerce.number().int().min(5).max(1000).default(120),
});

export const stockRoutes: FastifyPluginAsync<{ service: StockService }> = async (app, { service }) => {
  app.get("/search", async (req) => {
    const { q, limit } = searchQuery.parse(req.query);
    return service.search(q, limit);
  });

  app.get("/", async (req) => {
    const withQuotes = (req.query as { quotes?: string }).quotes === "1";
    return withQuotes ? service.listWithQuotes() : service.list();
  });

  app.post("/", async (req, reply) => {
    const body = registerBody.parse(req.body);
    const created = await service.register(body);
    return reply.code(201).send(created);
  });

  app.get("/:code", async (req, reply) => {
    const { code } = codeParam.parse(req.params);
    const stock = await service.get(code);
    if (!stock) return reply.code(404).send({ error: "NOT_FOUND", message: `등록되지 않은 종목입니다: ${code}` });
    let quote = null;
    let quoteError: string | null = null;
    try {
      quote = await service.getQuote(code);
    } catch (e) {
      quoteError = e instanceof Error ? e.message : String(e);
    }
    const [detail, krw] = await Promise.all([service.tossDetail(), service.krwCosts()]);
    return { ...stock, quote, quoteError, evaluation: evaluate(stock, quote, detail.get(code), krw.get(code)) };
  });

  app.patch("/:code", async (req) => {
    const { code } = codeParam.parse(req.params);
    return service.update(code, updateBody.parse(req.body));
  });

  app.delete("/:code", async (req, reply) => {
    const { code } = codeParam.parse(req.params);
    await service.remove(code);
    return reply.code(204).send();
  });

  app.get("/:code/quote", async (req) => {
    const { code } = codeParam.parse(req.params);
    const { fresh } = quoteQuery.parse(req.query);
    return service.getQuote(code, { fresh });
  });

  app.get("/:code/candles", async (req) => {
    const { code } = codeParam.parse(req.params);
    const { period, count } = candlesQuery.parse(req.query);
    return service.getCandles(code, period, count);
  });
};
