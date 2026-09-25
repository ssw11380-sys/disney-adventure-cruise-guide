import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { ListedStock } from "../src/domain/types.js";
import type { Providers } from "../src/providers/index.js";
import type { NewsItem, NewsProvider } from "../src/providers/news/types.js";
import { FakeGenerator, FakeSearchProvider, fakeProviders } from "./helpers.js";

/** 마스터를 받은 뒤 새로 상장해 외부 검색에만 있는 종목 */
const NEW_LISTING: ListedStock = { code: "0088M0", name: "신규상장", market: "KOSDAQ", isinCode: "KR70088M0001", groupCode: "ST" };

let app: FastifyInstance | null = null;
let db: Db | null = null;

async function setup(over: Partial<Providers>): Promise<FastifyInstance> {
  db = await createMigratedDb(":memory:");
  app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(over), logger: false, enableScheduler: false, now: () => new Date("2026-09-25T09:00:00+09:00") });
  await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
  return app;
}

afterEach(async () => {
  await app?.close();
  await db?.destroy();
  app = null;
  db = null;
});

describe("마스터에 없는 종목의 AI 분석 (BH-25)", () => {
  it("상세 화면·뉴스 탭처럼 외부 검색으로 이름·시장을 찾아 세 가지 분석을 모두 만든다", async () => {
    const gen = new FakeGenerator();
    const a = await setup({ search: new FakeSearchProvider([NEW_LISTING]), generator: gen });
    const detail = await a.inject({ method: "GET", url: "/api/stocks/0088M0" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().registered).toBe(false);
    for (const kind of ["company", "value", "technical"] as const) {
      const res = await a.inject({ method: "GET", url: `/api/stocks/0088M0/analysis/${kind}` });
      expect(res.statusCode, kind).toBe(200);
      expect(res.json().code).toBe("0088M0");
    }
    expect(gen.requests.map((r) => r.label)).toEqual(["company_overview:0088M0", "value_analysis:0088M0", "technical_analysis:0088M0"]);
    expect(gen.requests[0]!.user).toContain("신규상장");
  });

  it("외부 검색에도 코드가 정확히 같은 종목이 없으면 그대로 404 (이름이 비슷한 다른 종목으로 분석하지 않는다)", async () => {
    const gen = new FakeGenerator();
    const a = await setup({ search: new FakeSearchProvider([NEW_LISTING]), generator: gen });
    const res = await a.inject({ method: "GET", url: "/api/stocks/999999/analysis/technical" });
    expect(res.statusCode).toBe(404);
    expect(gen.requests).toHaveLength(0);
  });
});

/** 네이버 종목뉴스(+09:00)와 구글 RSS(toIso → Z) 가 섞여 오는 뉴스 */
class MixedNews implements NewsProvider {
  readonly name = "mixed-news";
  async search(): Promise<NewsItem[]> {
    return [
      // 한국 9/25 07:30 에 나온 구글 기사 (UTC 로는 9/24)
      { title: "구글 실적 기사", url: "https://example.com/g", source: "구글", publishedAt: "2026-09-24T22:30:00.000Z", summary: null },
      { title: "네이버 기사", url: "https://example.com/n", source: "네이버", publishedAt: "2026-09-25T07:00:00+09:00", summary: null },
      // 한국 9/24 23:10 (UTC 로도 9/24) — 하루 전 기사는 그대로 하루 전
      { title: "전날 밤 기사", url: "https://example.com/p", source: "구글", publishedAt: "2026-09-24T14:10:00.000Z", summary: null },
    ];
  }
}

describe("회사 소개 분석의 뉴스 날짜 (BH-59, BH-69)", () => {
  it("뉴스 날짜를 UTC 가 아니라 한국 날짜로 넣는다 (한국 00:00~08:59 기사가 전날로 들어가지 않게)", async () => {
    const gen = new FakeGenerator();
    const a = await setup({ news: new MixedNews(), generator: gen });
    const res = await a.inject({ method: "GET", url: "/api/stocks/000660/analysis/company" });
    expect(res.statusCode).toBe(200);
    const user = gen.requests[0]!.user;
    const dates = [...user.matchAll(/"publishedAt": "([^"]+)"/g)].map((m) => m[1]);
    expect(dates).toEqual(["2026-09-25", "2026-09-25", "2026-09-24"]);
  });
});
