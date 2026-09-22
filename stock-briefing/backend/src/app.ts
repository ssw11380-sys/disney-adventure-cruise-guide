import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { AppError, ProviderError } from "./lib/errors.js";
import { seoulIso } from "./lib/time.js";
import type { Providers } from "./providers/index.js";
import { adminRoutes } from "./routes/admin.js";
import { stockRoutes } from "./routes/stocks.js";
import { StockService } from "./services/stockService.js";

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  providers: Providers;
  logger?: boolean | object;
}

export const DISCLAIMER = "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.";

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? { level: opts.config.LOG_LEVEL } });
  await app.register(cors, { origin: true });

  const service = new StockService({ db: opts.db, ...opts.providers });
  app.decorate("stockService", service);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "VALIDATION",
        message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof ProviderError) return reply.code(502).send({ error: "UPSTREAM", message: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "INTERNAL", message: "서버 오류" });
  });

  app.get("/health", async () => ({
    ok: true,
    time: seoulIso(),
    quoteSource: opts.providers.quotes.name,
    disclaimer: DISCLAIMER,
  }));

  await app.register(stockRoutes, { prefix: "/api/stocks", service });
  await app.register(adminRoutes, { prefix: "/api/admin", service });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    stockService: StockService;
  }
}
