import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ownerView } from "../auth/routePolicy.js";
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
    // local=1: 종목 마스터만 (외부 검색을 기다리지 않아 바로) — 앱이 먼저 보여 주고 전체 결과가 오면 바꾼다 (3-18)
    if ((req.query as { local?: string }).local === "1") return service.searchMaster(q, limit);
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
    // 등록하지 않은 종목(발견 탭에서 누른 종목 등)도 종목 마스터에 있으면 미리 보기로 보여 준다 (registered: false).
    // 계정 A단계: 주인 아닌 계정은 등록 표를 보지 않는다 — 주인이 등록한 종목도 등록하지 않은 종목과 같은 미리 보기 (수량·평단·메모·토스 표시 없음)
    const owner = ownerView(req);
    const registered = owner ? await service.get(code) : null;
    const stock = registered ?? (await service.preview(code));
    if (!stock) return reply.code(404).send({ error: "NOT_FOUND", message: `종목을 찾을 수 없습니다: ${code}` });
    let quote = null;
    let quoteError: string | null = null;
    try {
      quote = await service.getQuote(code);
    } catch (e) {
      quoteError = e instanceof Error ? e.message : String(e);
    }
    const { detail, krw, synced, inSnapshot } = owner ? await service.holdingMeta() : { detail: new Map(), krw: new Map(), synced: new Set<string>(), inSnapshot: new Set<string>() };
    return {
      ...stock,
      registered: !!registered,
      tossSynced: !!registered && synced.has(code),
      // 지우면 토스 동기화에서도 빠지는지 (잠금이 풀려도 — 앱의 지우기 버튼·확인 창 문구, 3-24)
      inTossSnapshot: !!registered && inSnapshot.has(code),
      quote,
      quoteError,
      evaluation: evaluate(stock, quote, detail.get(code), krw.get(code)),
    };
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
    // 계정 A단계: 주인 아닌 계정은 캐시를 건너뛰지 못한다 (서버 env 에 있는 주인의 시세 키로 외부 호출을 강제로 일으켜 주인 몫의 호출 한도를 쓰지 않게)
    return service.getQuote(code, { fresh: fresh && ownerView(req) });
  });

  app.get("/:code/candles", async (req) => {
    const { code } = codeParam.parse(req.params);
    const { period, count } = candlesQuery.parse(req.query);
    return service.getCandles(code, period, count);
  });
};
