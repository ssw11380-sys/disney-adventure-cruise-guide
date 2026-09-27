import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { diffJson, jsonHash, type Json } from "./jsonDelta.js";

/**
 * 끊겼을 때 데이터 절약 (플래그 pollSaver, 3-25 성능-16). 앱의 웹소켓이 막히면 잔고·상세를 3초마다 다시 받는데(시간당 수 MB),
 * 자주 묻는 GET 응답을 가볍게 한다. 끄면(플래그) 응답이 바이트까지 예전과 같다.
 *  - ETag: 보낼 본문 그대로의 해시 → 화면에 보이는 값·기준 시각(asOf)·어떤 칸이든 한 글자라도 바뀌면 ETag 도 바뀐다 (옛 값이 남지 않게)
 *  - If-None-Match 가 지금 ETag 와 같으면 304 (본문 없음)
 *  - 바뀐 부분만 (RFC 3229 식): 앱이 A-IM: json-delta 와 옛 ETag 를 보내고, 서버가 그 옛 본문을 기억하면 226 + 차이만
 *    (본문 { $im, base, etag, h, p } — h 는 새 본문의 확인용 해시, 앱이 다시 만든 값이 다르면 전체를 다시 받는다).
 *    차이가 전체의 70% 보다 크면 그냥 전체(200)
 *  - gzip 을 받는 요청이면 256바이트 넘는 본문을 압축
 * 예전 앱(If-None-Match·A-IM 을 보내지 않음)은 늘 전체(200)를 받는다 — 켜져 있으면 ETag 헤더와 gzip(안드로이드 OkHttp 가 알아서 풂)만 더해진다.
 */
export const POLL_SAVER_ROUTES: ReadonlySet<string> = new Set(["/health", "/api/stocks", "/api/stocks/:code", "/api/market/indices", "/api/market/status", "/api/features"]);
export const DELTA_IM = "json-delta";
/** 기억해 두는 옛 본문 수·시간 (3초 폴링이면 2분 넘게, 상세 여러 종목도) */
const RING_MAX = 48;
const RING_AGE_MS = 5 * 60_000;
const GZIP_MIN = 256;
/** 차이가 전체 본문의 이 비율보다 크면 전체를 보낸다 */
const DELTA_MAX_RATIO = 0.7;

/** 본문 ETag (강한 ETag, 16자) */
export function etagOf(body: string): string {
  return `"${createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`;
}

/** If-None-Match 의 ETag 들 (프록시가 약한 ETag W/"…" 로 바꾸거나 여러 개를 보내도) */
export function inmTags(h: unknown): string[] {
  return String(h ?? "")
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .filter((t) => t.length > 0);
}

/** 최근 본문 (ETag → 본문). 오래되거나 넘치면 먼저 들어온 것부터 버린다 */
export class BodyRing {
  private readonly map = new Map<string, { body: string; at: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  put(etag: string, body: string): void {
    this.map.delete(etag);
    this.map.set(etag, { body, at: this.now() });
    while (this.map.size > RING_MAX) this.map.delete(this.map.keys().next().value!);
  }
  get(etag: string): string | null {
    const e = this.map.get(etag);
    if (!e) return null;
    if (this.now() - e.at > RING_AGE_MS) {
      this.map.delete(etag);
      return null;
    }
    return e.body;
  }
  get size(): number {
    return this.map.size;
  }
}

/** 처리 횟수 (/health 에서 확인, 측정용) */
export interface PollSaverStats {
  full: number;
  notModified: number;
  delta: number;
  gzip: number;
}

function addVary(reply: FastifyReply, v: string): void {
  const had = reply.getHeader("vary");
  const list = String(had ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!list.some((x) => x.toLowerCase() === v)) list.push(v);
  reply.header("vary", list.join(", "));
}

function gzipIfAccepted(req: FastifyRequest, reply: FastifyReply, body: string, stats: PollSaverStats): string | Buffer {
  if (Buffer.byteLength(body) < GZIP_MIN || !/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return body;
  const z = gzipSync(body);
  if (z.length >= Buffer.byteLength(body)) return body;
  stats.gzip++;
  reply.header("content-encoding", "gzip");
  return z;
}

/** 옛 본문 → 지금 본문의 차이 본문. 못 만들거나 크면 null */
export function deltaBody(baseEtag: string, baseBody: string, etag: string, body: string): string | null {
  let a: Json, b: Json;
  try {
    a = JSON.parse(baseBody) as Json;
    b = JSON.parse(body) as Json;
  } catch {
    return null;
  }
  const p = diffJson(a, b);
  if (p === undefined) return null; // 내용이 같은데 ETag 가 다를 수는 없다 (글자가 같으면 ETag 도 같음) — 전체로
  const out = JSON.stringify({ $im: DELTA_IM, base: baseEtag, etag, h: jsonHash(b), p });
  return out.length <= body.length * DELTA_MAX_RATIO ? out : null;
}

/**
 * 자주 묻는 GET 라우트(routes)의 성공 응답(200)에 ETag·304·차이·gzip 을 붙인다. enabled() 가 false 면 아무것도 하지 않는다.
 * 라우트를 등록하기 전에 불러야 한다 (onSend 훅)
 */
export function registerPollSaver(
  app: FastifyInstance,
  o: { enabled: () => Promise<boolean>; now?: () => number; routes?: ReadonlySet<string> },
): { ring: BodyRing; stats: PollSaverStats } {
  const ring = new BodyRing(o.now);
  const stats: PollSaverStats = { full: 0, notModified: 0, delta: 0, gzip: 0 };
  const routes = o.routes ?? POLL_SAVER_ROUTES;
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET" || reply.statusCode !== 200 || typeof payload !== "string") return payload;
    const route = req.routeOptions?.url;
    if (!route || !routes.has(route)) return payload;
    if (!(await o.enabled().catch(() => false))) return payload;
    const etag = etagOf(payload);
    reply.header("etag", etag).header("cache-control", "no-cache");
    addVary(reply, "accept-encoding");
    // 브라우저(웹 미리보기)가 다른 출처의 ETag 를 읽을 수 있게
    if (req.headers.origin) reply.header("access-control-expose-headers", "etag");
    // 304 로 답해도 기억해 둔다 — 서버를 다시 켠 뒤에도 다음 변화부터 차이만 보낼 수 있게
    ring.put(etag, payload);
    const inm = inmTags(req.headers["if-none-match"]);
    if (inm.includes(etag)) {
      stats.notModified++;
      reply.code(304).removeHeader("content-type");
      return null;
    }
    const wantsDelta = String(req.headers["a-im"] ?? "")
      .split(",")
      .some((x) => x.trim().toLowerCase() === DELTA_IM);
    if (wantsDelta) {
      for (const base of inm) {
        const baseBody = ring.get(base);
        const d = baseBody ? deltaBody(base, baseBody, etag, payload) : null;
        if (!d) continue;
        stats.delta++;
        // 차이 본문은 저장하지 않게 (중간 캐시가 이것을 전체 본문으로 다시 쓰지 않도록)
        reply.code(226).header("im", DELTA_IM).header("delta-base", base).header("cache-control", "no-store");
        return gzipIfAccepted(req, reply, d, stats);
      }
    }
    stats.full++;
    return gzipIfAccepted(req, reply, payload, stats);
  });
  return { ring, stats };
}
