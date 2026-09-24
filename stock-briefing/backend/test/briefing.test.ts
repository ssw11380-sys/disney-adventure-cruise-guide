import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import { QuoteProviderChain } from "../src/providers/market/chain.js";
import { BriefingScheduler } from "../src/scheduler.js";
import { normalizeSummary } from "../src/services/briefingService.js";
import { FakeGenerator, FakeInvestorFlow, FakeNewsProvider, FakeQuoteProvider, fakeProviders } from "./helpers.js";

describe("briefing pipeline", () => {
  let app: FastifyInstance;
  let db: Db;
  let gen: FakeGenerator;
  let news: FakeNewsProvider;
  let kis: FakeQuoteProvider;
  let clock: Date;

  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    gen = new FakeGenerator();
    news = new FakeNewsProvider();
    kis = new FakeQuoteProvider("kis", { price: 180_000 });
    clock = new Date("2026-09-22T00:00:00+09:00");
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({
        quotes: new QuoteProviderChain([kis, new FakeQuoteProvider("yahoo", { price: 179_000 })]),
        news,
        generator: gen,
        investorFlow: new FakeInvestorFlow(),
      }),
      logger: false,
      enableScheduler: false,
      now: () => clock,
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660", quantity: 10, avgPrice: 150_000 } });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930" } });
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it("오전 브리핑을 종목별로 생성하고 상세/요약 두 번 호출한다", async () => {
    const res = await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.date).toBe("2026-09-22");
    expect(body.results.map((r: { code: string; status: string }) => [r.code, r.status])).toEqual([["000660", "ok"], ["005930", "ok"]]);
    expect(gen.requests.map((r) => r.label)).toEqual([
      "briefing_detail:000660",
      "briefing_summary:000660",
      "briefing_detail:005930",
      "briefing_summary:005930",
    ]);
    // 상세 프롬프트에 데이터와 보유 정보가 들어간다
    const detailReq = gen.requests[0]!;
    expect(detailReq.system).toContain("리서치 애널리스트");
    expect(detailReq.user).toContain("SK하이닉스 (000660)");
    expect(detailReq.user).toContain("150,000원");
    expect(detailReq.user).toContain('"price": 180000');
    expect(detailReq.user).toContain('"maAlignment"');
    expect(detailReq.user).toContain("뉴스 1");
    // DART 키가 없는 건 실패가 아니라 "제공되지 않는 항목" (3-11)
    expect(detailReq.user).toContain("데이터 미확인 항목(받으려다 실패): 없음");
    expect(detailReq.user).toContain("제공되지 않는 항목(실패 아님): 공시: DART 키가 없어 받지 않음");
    expect(detailReq.user).toMatch(/장 상태: 한국 /);
    // 요약 프롬프트에는 상세 결과가 들어간다
    expect(gen.requests[1]!.user).toContain("briefing_detail:000660 결과입니다");
    expect(news.queries).toEqual(["SK하이닉스", "삼성전자"]);
  });

  it("요약은 마크다운 기호를 걷어내고 3줄로 자른다", async () => {
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } });
    const list = (await app.inject({ method: "GET", url: "/api/briefings?code=000660" })).json();
    expect(list).toHaveLength(1);
    expect(list[0].summary).toBe("주가 100,000원 (+1.01%)\n뉴스 요약 한 줄\n내일 체크포인트");
    expect(list[0].name).toBe("SK하이닉스");
    expect(list[0].missing).toEqual([]);
    expect(normalizeSummary("• a\n\n* b\n1) c\nd")).toBe("a\nb\nc");
    // 숫자로 시작하는 본문은 잘리면 안 된다
    expect(normalizeSummary("184만원 마감, 1.50% 하락\n2. 189만원 저항 확인\n3: 거래량 확인")).toBe("184만원 마감, 1.50% 하락\n189만원 저항 확인\n거래량 확인");
  });

  it("같은 날 같은 세션은 force 없이는 건너뛰고, force 면 덮어쓴다", async () => {
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } });
    expect(gen.requests).toHaveLength(4);
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } });
    expect(gen.requests).toHaveLength(4);
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", codes: ["000660"], force: true } });
    expect(gen.requests).toHaveLength(6);
    const list = (await app.inject({ method: "GET", url: "/api/briefings?code=000660&date=2026-09-22" })).json();
    expect(list).toHaveLength(1); // 덮어쓰기 (unique index)

    // 오후는 별도 레코드
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", codes: ["000660"] } });
    const all = (await app.inject({ method: "GET", url: "/api/briefings?code=000660" })).json();
    expect(all.map((b: { session: string }) => b.session).sort()).toEqual(["afternoon", "morning"]);
  });

  it("외부 데이터가 실패해도 브리핑은 생성되고 미확인 항목에 기록된다", async () => {
    news.opts.fail = true;
    kis.opts.failCandles = true;
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", codes: ["005930"] } });
    const [b] = (await app.inject({ method: "GET", url: "/api/briefings?code=005930" })).json();
    expect(b.status).toBe("ok");
    expect(b.missing).toEqual(["뉴스"]);
    expect(b.missing).not.toContain("일봉/기술적 지표"); // 폴백 소스(yahoo)가 봉을 줌
    const detail = (await app.inject({ method: "GET", url: `/api/briefings/${b.id}` })).json();
    expect(detail.data.news).toBeNull();
    expect(detail.data.quote.source).toBe("kis");
    expect(detail.data.technical).not.toBeNull();
    expect(detail.data.holding).toBeNull();
    expect(gen.requests[0]!.user).toContain("데이터 미확인 항목(받으려다 실패): 뉴스");
  });

  it("모델 호출이 실패하면 failed 로 저장되고 목록에 사유가 남는다", async () => {
    gen.opts.failKind = "refusal";
    const res = await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", codes: ["000660"] } });
    expect(res.json().results[0]).toMatchObject({ code: "000660", status: "failed" });
    expect(res.json().results[0].error).toContain("refusal");
    const [b] = (await app.inject({ method: "GET", url: "/api/briefings" })).json();
    expect(b.status).toBe("failed");
    expect(b.summary).toContain("브리핑 생성 실패");

    // 실패한 건은 force 없이도 다시 시도한다
    gen.opts.failKind = undefined;
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", codes: ["000660"] } });
    const [again] = (await app.inject({ method: "GET", url: "/api/briefings?code=000660" })).json();
    expect(again.status).toBe("ok");
  });

  it("latest 는 등록 종목별 최근 브리핑을 준다 (없으면 null)", async () => {
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", codes: ["000660"] } });
    const latest = (await app.inject({ method: "GET", url: "/api/briefings/latest" })).json();
    expect(latest).toHaveLength(2);
    expect(latest[0]).toMatchObject({ code: "000660", name: "SK하이닉스" });
    expect(latest[0].latest.session).toBe("morning");
    expect(latest[1].latest).toBeNull();
  });

  it("브리핑 리스너가 성공 건에 대해서만 호출된다 (푸시 연동 지점)", async () => {
    const seen: string[] = [];
    app.briefingService.onBriefing((b) => {
      seen.push(`${b.code}:${b.session}`);
    });
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon" } });
    expect(seen).toEqual(["000660:afternoon", "005930:afternoon"]);
  });

  it("잘못된 세션/코드는 400, 없는 브리핑은 404", async () => {
    expect((await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "night" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/briefings/999" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/briefings?date=2026/09/22" })).statusCode).toBe(400);
  });
});

describe("analysis endpoints", () => {
  let app: FastifyInstance;
  let db: Db;
  let gen: FakeGenerator;
  let clock: Date;

  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    gen = new FakeGenerator();
    clock = new Date("2026-09-22T10:00:00+09:00");
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({ generator: gen }),
      logger: false,
      enableScheduler: false,
      now: () => clock,
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  it("세 가지 분석을 각각의 프롬프트로 생성하고 캐시한다", async () => {
    for (const kind of ["company", "value", "technical"] as const) {
      const res = await app.inject({ method: "GET", url: `/api/stocks/000660/analysis/${kind}` });
      expect(res.statusCode, kind).toBe(200);
      expect(res.json().cached).toBe(false);
      expect(res.json().content).toContain(`:000660 결과입니다`);
    }
    expect(gen.requests.map((r) => r.label)).toEqual(["company_overview:000660", "value_analysis:000660", "technical_analysis:000660"]);
    expect(gen.requests[1]!.user).toContain("재무제표(DART 키 없음)");
    expect(gen.requests[1]!.user).toContain("PER/PBR(현재 시세 소스가 제공하지 않음)");
    expect(gen.requests[2]!.user).toContain('"weeklyCandles"');

    const cached = await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/company" });
    expect(cached.json().cached).toBe(true);
    expect(gen.requests).toHaveLength(3);

    // 기술적 분석은 하루 지나면 재생성, 회사 소개는 그대로
    clock = new Date("2026-09-24T10:00:00+09:00");
    await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/technical" });
    await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/company" });
    expect(gen.requests.map((r) => r.label).slice(3)).toEqual(["technical_analysis:000660"]);

    const forced = await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/company?refresh=1" });
    expect(forced.json().cached).toBe(false);
  });

  it("등록하지 않은 마스터 종목도 분석 가능, 모르는 코드는 404, 잘못된 kind 는 400", async () => {
    expect((await app.inject({ method: "GET", url: "/api/stocks/005930/analysis/technical" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/stocks/999999/analysis/technical" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/foo" })).statusCode).toBe(400);
  });

  it("API 키가 없으면 503 LLM_CONFIG 로 응답한다", async () => {
    gen.opts.failKind = "config";
    const res = await app.inject({ method: "GET", url: "/api/stocks/000660/analysis/company" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("LLM_CONFIG");
  });
});

describe("scheduler", () => {
  it("cron 표현식을 검증하고 상태를 보고한다", async () => {
    expect(BriefingScheduler.validate("30 8 * * 1-5")).toBe(true);
    expect(BriefingScheduler.validate("not a cron")).toBe(false);

    const db = await createMigratedDb(":memory:");
    const app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:", BRIEFING_MORNING_CRON: "30 8 * * 1-5", BRIEFING_AFTERNOON_CRON: "0 16 * * 1-5" }),
      db,
      providers: fakeProviders(),
      logger: false,
    });
    const health = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(health.schedule.timezone).toBe("Asia/Seoul");
    expect(health.schedule.jobs.map((j: { session: string; cron: string }) => [j.session, j.cron])).toEqual([
      ["morning", "30 8 * * 1-5"],
      ["afternoon", "0 16 * * 1-5"],
    ]);
    expect(health.schedule.jobs[0].nextRun).toMatch(/T(23|00):30:00/); // 08:30 KST = 23:30 UTC 전날
    expect(health.sources.llm).toContain("없음");
    await app.close();
    await db.destroy();
  });
});
