import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { GenerateRequest, GenerateResult } from "../src/llm/generator.js";
import { QuoteProviderChain } from "../src/providers/market/chain.js";
import { codeSummaryLine } from "../src/services/briefingWording.js";
import { FakeGenerator, FakeInvestorFlow, FakeNewsProvider, FakeQuoteProvider, fakeProviders } from "./helpers.js";

/**
 * 브리핑 2차 6 — 종목 브리핑 AI 글 안전하게 (플래그 briefingSafeWording, 서버 기본 켬).
 * briefing.test.ts 의 준비 코드를 본떠 buildApp + FakeGenerator. 끈 상태의 증거는 briefing.test.ts·notifications.test.ts (기대값 그대로)
 */

/** 3.6 의 목록: 새 프롬프트 시스템 글에 없어야 하는 말 */
const OLD_WORDS = ["애널리스트", "(긍정/부정/중립)", "지지/저항", "체크포인트", "그 의미", "영향 방향", "주가 영향", "보유자 관점", "다음 세션"];

/** 상세 응답을 바꿔 끼울 수 있는 가짜 (요약은 FakeGenerator 그대로) */
class DetailGenerator extends FakeGenerator {
  detail: string | null = null;
  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    const r = await super.generate(req);
    return this.detail !== null && req.label?.startsWith("briefing_detail") ? { ...r, text: this.detail } : r;
  }
}

describe("종목 브리핑 AI 글 안전하게 (켬 — 서버 기본)", () => {
  let app: FastifyInstance;
  let db: Db;
  let gen: DetailGenerator;
  const lines: string[] = [];
  /** 로그 줄 (pino JSON) */
  const logs = () => lines.map((l) => JSON.parse(l) as Record<string, unknown> & { msg: string });

  beforeEach(async () => {
    db = await createMigratedDb(":memory:");
    gen = new DetailGenerator();
    lines.length = 0;
    app = await buildApp({
      config: loadConfig({ DATABASE_URL: ":memory:" }),
      db,
      providers: fakeProviders({
        quotes: new QuoteProviderChain([new FakeQuoteProvider("kis", { price: 180_000 }), new FakeQuoteProvider("yahoo", { price: 179_000 })]),
        news: new FakeNewsProvider(),
        generator: gen,
        investorFlow: new FakeInvestorFlow(),
      }),
      // 로그 한 줄(종목 브리핑 문장 검사)을 본다
      logger: { level: "info", stream: { write: (line: string) => void lines.push(line) } },
      enableScheduler: false,
      now: () => new Date("2026-09-22T00:00:00+09:00"),
    });
    await app.inject({ method: "POST", url: "/api/admin/master/refresh" });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "000660", quantity: 10, avgPrice: 150_000 } });
    await app.inject({ method: "POST", url: "/api/stocks", payload: { code: "005930" } });
    // 이 검사는 기존 순차 호출의 위치까지 확인한다. 동시 실행의 문장 동등성은 별도 회귀로 확인한다.
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingParallel: false } });
  });

  afterEach(async () => {
    await app.close();
    await db.destroy();
  });

  const run = () => app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning" } });

  it("새 프롬프트: 상세 시스템 글에 '편집자'가 있고 예전 말(애널리스트·(긍정/부정/중립)·지지/저항·체크포인트…)이 없다", async () => {
    await run();
    const detail = gen.requests[0]!;
    expect(detail.system).toContain("편집자");
    for (const w of OLD_WORDS) expect(detail.system, w).not.toContain(w);
    expect(gen.requests[1]!.system).not.toContain("다음 세션");
    // 사용자 글(데이터·보유 정보)은 예전과 같은 틀
    expect(detail.user).toContain("SK하이닉스 (000660)");
    expect(detail.user).toContain("150,000원");
    expect(detail.user).toContain('"price": 180000');
  });

  it("데이터 JSON 에 지지·저항 후보·RSI 구간 이름·MACD 교차 이름이 없고 maAlignment 는 있다", async () => {
    await run();
    const user = gen.requests[0]!.user;
    const json = JSON.parse(user.slice(user.indexOf("```json") + "```json".length, user.lastIndexOf("```"))) as { technical: Record<string, unknown> | null };
    expect(json.technical).not.toBeNull();
    for (const k of ["supportResistance", "rsiZone", "macdCross"]) expect(user, k).not.toContain(`"${k}"`);
    expect(json.technical).toHaveProperty("maAlignment");
    expect(json.technical).toHaveProperty("rsi14");
  });

  it("모델 호출 label·횟수는 끈 상태와 같다 (종목당 2번)", async () => {
    await run();
    expect(gen.requests.map((r) => r.label)).toEqual(["briefing_detail:000660", "briefing_summary:000660", "briefing_detail:005930", "briefing_summary:005930"]);
  });

  it("저장된 요약 = 시세로 만든 가격 줄 + 둘째 줄(가격 숫자 줄·체크포인트 줄은 건너뜀), 두 줄", async () => {
    await run();
    const [b] = (await app.inject({ method: "GET", url: "/api/briefings?code=000660" })).json();
    const saved = (await app.inject({ method: "GET", url: `/api/briefings/${b.id}` })).json();
    expect(b.summary).toBe(`${codeSummaryLine(saved.data.quote)}\n뉴스 요약 한 줄`);
    expect(b.summary).toBe("180,000원 · 전일 대비 +1.01%\n뉴스 요약 한 줄");
    expect(b.summary.split("\n")).toHaveLength(2);
    expect(b.summary.split("\n")[1]).not.toMatch(/\d[\d,]*(?:\.\d+)?\s*(?:원|%|달러)|\$\s*\d/);
    // 걸린 것이 없는 상세는 글자 하나 바꾸지 않고 저장
    expect(b.detail).toBe("## 한 줄 요약\nbriefing_detail:000660 결과입니다.\n\n## 본문\n데이터 길이 " + gen.requests[0]!.user.length);
    // 로그 한 줄: 뺀 줄 0, 둘째 줄은 모델 것
    const checks = logs().filter((l) => l.msg === "종목 브리핑 문장 검사");
    expect(checks).toHaveLength(2);
    expect(checks[0]!).toMatchObject({ code: "000660", dropped: 0, secondLine: "model" });
    expect(checks[0]!.unknownNumbers).toMatchObject({ count: expect.any(Number), sample: expect.any(Array) });
  });

  it("상세의 걸린 줄은 빼고 저장하고, 요약 모델에는 정리한 상세를 넘긴다 (숫자 대조는 로그만)", async () => {
    gen.detail = "## 한 줄 요약\n실적 발표가 있었습니다.\n\n## 뉴스와 공시\n- 신규 공시 (긍정)\n- 신규 공시 요약 (공시)\n\n## 다음 세션 체크포인트\n1. 185,000원\n2. 거래량\n\n## 주가 흐름\n종가 180,000원 (+1.01%), 52주 최고 999,999원";
    await run();
    const [b] = (await app.inject({ method: "GET", url: "/api/briefings?code=000660" })).json();
    const cleaned = "## 한 줄 요약\n실적 발표가 있었습니다.\n\n## 뉴스와 공시\n- 신규 공시 요약 (공시)\n\n## 주가 흐름\n종가 180,000원 (+1.01%), 52주 최고 999,999원\n\n(문장 검사에서 3줄을 뺐습니다)";
    expect(b.detail).toBe(cleaned);
    expect(gen.requests[1]!.user).toContain(cleaned);
    expect(gen.requests[1]!.user).not.toContain("체크포인트");
    const check = logs().find((l) => l.msg === "종목 브리핑 문장 검사")!;
    expect(check).toMatchObject({ code: "000660", dropped: 3 });
    // 데이터에 없는 999,999원은 모름으로 센다 (거절하지 않음)
    expect((check.unknownNumbers as { sample: string[] }).sample.some((x) => x.includes("999,999"))).toBe(true);
    expect(b.status).toBe("ok");
  });

  it("직전 브리핑의 걸린 줄은 다음 입력에서 뺀다 (날짜 머리는 둠)", async () => {
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingSafeWording: false } });
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "morning", codes: ["000660"] } });
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingSafeWording: true } });
    await app.inject({ method: "POST", url: "/api/briefings/run", payload: { session: "afternoon", codes: ["000660"] } });
    // 예전 3줄 요약('주가 100,000원 (+1.01%)' · '뉴스 요약 한 줄' · '내일 체크포인트') 가운데 체크포인트 줄만 빠진다
    expect(gen.requests[0]!.user).toContain("직전 브리핑 요약: 없음 (첫 브리핑)");
    expect(gen.requests[2]!.user).toMatch(/직전 브리핑 요약: 2026-09-22 오전: 주가 100,000원 \(\+1\.01%\)\n뉴스 요약 한 줄\r?\n\r?\n데이터\(JSON\)/);
    expect(gen.requests[2]!.user).not.toContain("체크포인트");
  });

  it("끄면 예전 프롬프트(리서치 애널리스트)·3줄 요약 그대로", async () => {
    await app.inject({ method: "PUT", url: "/api/admin/features", payload: { briefingSafeWording: false } });
    await run();
    expect(gen.requests[0]!.system).toContain("리서치 애널리스트");
    expect(gen.requests[0]!.user).toContain('"supportResistance"');
    const [b] = (await app.inject({ method: "GET", url: "/api/briefings?code=000660" })).json();
    expect(b.summary).toBe("주가 100,000원 (+1.01%)\n뉴스 요약 한 줄\n내일 체크포인트");
    expect(logs().some((l) => l.msg === "종목 브리핑 문장 검사")).toBe(false);
  });
});
