import { TossOpenApiClient } from "../src/providers/market/tossOpenApi.js";

/** 토스 Open API 가짜 서버 (여러 테스트가 같이 쓴다) */
export const NOW = () => new Date("2026-09-22T14:00:00+09:00"); // 장중

export function daily(n: number, base = 200000): unknown[] {
  // 최신순 n개 일봉 (2026-09-22 부터 거슬러, 주말 포함 단순화)
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 8, 22) - i * 86_400_000).toISOString().slice(0, 10);
    const c = base + (n - i) * 100;
    out.push({ timestamp: `${d}T00:00:00+09:00`, openPrice: String(c - 500), highPrice: String(c + 1000), lowPrice: String(c - 1200), closePrice: String(c), volume: "1000", currency: "KRW" });
  }
  return out;
}

export interface Call { method: string; url: string; headers: Record<string, string>; body: string | null }

export function fakeFetch(opts: { calls?: Call[]; tokenStatus?: number; priceStatus?: number; first429?: boolean; candlePages?: number } = {}): typeof fetch {
  const calls = opts.calls ?? [];
  let tokenCount = 0;
  let served429 = false;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method: init?.method ?? "GET", url, headers, body: typeof init?.body === "string" ? init.body : null });
    const ok = (body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...extra } });
    const err = (status: number, code: string, message = "") => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/oauth2/token")) {
      tokenCount++;
      if (opts.tokenStatus && opts.tokenStatus !== 200) return new Response(JSON.stringify({ error: "invalid_client", error_description: "Client authentication failed: client_secret" }), { status: opts.tokenStatus });
      return ok({ access_token: `tok-${tokenCount}`, token_type: "Bearer", expires_in: 86400 });
    }
    if (!headers["authorization"]?.startsWith("Bearer tok-")) return err(401, "edge-blocked");
    if (opts.first429 && !served429 && url.includes("/api/v1/prices")) {
      served429 = true;
      return new Response(JSON.stringify({ error: { code: "rate-limit-exceeded" } }), { status: 429, headers: { "retry-after": "1" } });
    }
    if (url.includes("/api/v1/prices")) {
      if (opts.priceStatus === 403) return err(403, "edge-blocked", "허용되지 않은 요청입니다.");
      if (opts.priceStatus === 401) {
        // 첫 토큰은 만료 취급, 두 번째 토큰부터 정상
        if (headers["authorization"] === "Bearer tok-1") return err(401, "expired-token");
      }
      const symbols = new URL(url).searchParams.get("symbols")!.split(",");
      return ok({
        result: symbols.map((s) =>
          s === "TSLA"
            ? { symbol: "TSLA", timestamp: "2026-09-22T13:59:00.000+09:00", lastPrice: "377.5", currency: "USD" }
            : { symbol: s, timestamp: "2026-09-22T13:59:30.123+09:00", lastPrice: "201500", currency: "KRW" },
        ),
      });
    }
    if (url.includes("/api/v1/candles")) {
      const u = new URL(url);
      const symbol = u.searchParams.get("symbol")!;
      const count = Number(u.searchParams.get("count") ?? 100);
      const before = u.searchParams.get("before");
      if (symbol === "0010S0") {
        // 상장 첫날: 오늘 봉 하나뿐
        return ok({ result: { candles: [{ timestamp: "2026-09-22T00:00:00+09:00", openPrice: "30000", highPrice: "46000", lowPrice: "29000", closePrice: "45700", volume: "100", currency: "KRW" }], nextBefore: null } });
      }
      if (symbol === "TSLA") {
        // 미국: 뉴욕 자정, 오늘(9/22 뉴욕) 봉은 아직 없고 9/21 이 마지막
        return ok({
          result: {
            candles: [
              { timestamp: "2026-09-21T00:00:00-04:00", openPrice: "371.63", highPrice: "378.36", lowPrice: "371.07", closePrice: "375.3", volume: "36599609", currency: "USD" },
              { timestamp: "2026-09-18T00:00:00-04:00", openPrice: "369", highPrice: "370.9", lowPrice: "360.75", closePrice: "364.27", volume: "51922256", currency: "USD" },
            ],
            nextBefore: null,
          },
        });
      }
      const pages = opts.candlePages ?? 1;
      const all = daily(200 * pages);
      const start = before ? all.findIndex((c) => (c as { timestamp: string }).timestamp.startsWith(before.slice(0, 10))) : 0;
      const slice = all.slice(Math.max(start, 0), Math.max(start, 0) + count);
      const last = slice.at(-1) as { timestamp: string } | undefined;
      const hasMore = start + count < all.length;
      return ok({ result: { candles: slice, nextBefore: hasMore && last ? last.timestamp : null } });
    }
    if (url.includes("/api/v1/stocks/all")) {
      const market = new URL(url).searchParams.get("market");
      const rows: Record<string, unknown[]> = {
        KOSPI: [
          { symbol: "005930", name: "삼성전자", securityType: "STOCK", isCommonShare: true, isinCode: "KR7005930003" },
          { symbol: "0162Z0", name: "RISE 삼성전자SK하이닉스채권혼합50", securityType: "ETF", isCommonShare: true, isinCode: "KR70162Z0000" },
        ],
        KOSDAQ: [{ symbol: "247540", name: "에코프로비엠", securityType: "STOCK", isCommonShare: true, isinCode: "KR7247540008" }],
        NYSE: [{ symbol: "KO", name: "코카콜라", securityType: "FOREIGN_STOCK", isCommonShare: true, isinCode: "US1912161007" }],
        NASDAQ: [
          { symbol: "TSLA", name: "테슬라", securityType: "FOREIGN_STOCK", isCommonShare: true, isinCode: "US88160R1014" },
          { symbol: "QQQ", name: "QQQ", securityType: "FOREIGN_ETF", isCommonShare: true, isinCode: "US46090E1038" },
        ],
        AMEX: [],
      };
      return ok({ result: rows[market ?? ""] ?? [] });
    }
    if (url.includes("/api/v1/stocks?")) {
      const symbols = new URL(url).searchParams.get("symbols")!.split(",");
      return ok({
        result: symbols.map((s) =>
          s === "TSLA"
            ? { symbol: "TSLA", name: "테슬라", market: "NASDAQ", securityType: "FOREIGN_STOCK", status: "ACTIVE", currency: "USD", sharesOutstanding: "3949547394" }
            : { symbol: s, name: "NAVER", market: "KOSPI", securityType: "STOCK", status: "ACTIVE", currency: "KRW", sharesOutstanding: "152094369" },
        ),
      });
    }
    if (url.includes("/investor-trading")) {
      return ok({
        result: {
          nextUntil: "2026-09-18",
          records: [
            { date: "2026-09-22", updatedAt: "x", individual: null, foreigner: { netBuyVolume: "119900" }, institution: { netBuyVolume: "-113200" }, otherCorporation: null },
            { date: "2026-09-21", updatedAt: "x", individual: { netBuyVolume: "291850" }, foreigner: { netBuyVolume: "-319700" }, institution: { netBuyVolume: "37900" }, otherCorporation: {} },
          ],
        },
      });
    }
    if (url.includes("/api/v1/exchange-rate")) return ok({ result: { baseCurrency: "USD", quoteCurrency: "KRW", rate: "1390.5", midRate: "1384.3" } });
    if (url.includes("/api/v1/accounts")) return ok({ result: [{ accountNo: "123", accountSeq: 3, accountType: "BROKERAGE" }, { accountNo: "456", accountSeq: 7, accountType: "BROKERAGE" }] });
    if (url.includes("/api/v1/holdings")) {
      const seq = headers["x-tossinvest-account"];
      return ok({
        result: {
          items:
            seq === "3"
              ? [
                  { symbol: "035420", name: "NAVER", marketCountry: "KR", currency: "KRW", quantity: "9", lastPrice: "201500", averagePurchasePrice: "232555" },
                  { symbol: "TSLA", name: "테슬라", marketCountry: "US", currency: "USD", quantity: "2", lastPrice: "377.5", averagePurchasePrice: "300" },
                ]
              : [{ symbol: "TSLA", name: "테슬라", marketCountry: "US", currency: "USD", quantity: "2", lastPrice: "377.5", averagePurchasePrice: "340" }],
        },
      });
    }
    return err(404, "edge-blocked", "요청한 API 경로를 지원하지 않습니다.");
  }) as typeof fetch;
}

export function client(opts: Parameters<typeof fakeFetch>[0] = {}, calls: Call[] = []) {
  return new TossOpenApiClient({ clientId: "c_1", clientSecret: "s_1", fetchFn: fakeFetch({ ...opts, calls }), now: NOW, maxRetryWaitMs: 0 });
}
