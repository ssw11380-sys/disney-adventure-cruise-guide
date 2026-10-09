import { afterEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { Quote, RegisteredStock } from "../src/domain/types.js";
import { PromptStore } from "../src/llm/prompts.js";
import { AccountBriefingService } from "../src/services/accountBriefingService.js";
import { factsText, type AccountHolding } from "../src/services/accountNumbers.js";
import { evaluate } from "../src/services/stockService.js";
import { FakeGenerator, fakeIndices, makeQuote } from "./helpers.js";

const AT = new Date("2026-12-28T08:45:00+09:00");
const DATE = "2026-12-28";
const resources: Db[] = [];

function holding(code: string, missing?: "quote" | "fx"): AccountHolding {
  const us = !/^\d/.test(code);
  const stock: RegisteredStock = {
    code, name: code === "TSLA" ? "테슬라" : code === "NVDA" ? "엔비디아" : "삼성전자", market: us ? "NASDAQ" : "KOSPI",
    quantity: 10, avgPrice: us ? 90 : 90_000, memo: "", createdAt: AT.toISOString(), updatedAt: AT.toISOString(),
  };
  const quote: Quote | null = missing === "quote" ? null : us
    ? { ...makeQuote(code, "가짜시세", 100), currency: "USD", change: 1, changeRate: 1.01, fxRate: missing === "fx" ? null : 1400 }
    : makeQuote(code, "가짜시세");
  return { ...stock, quote, evaluation: evaluate(stock, quote) };
}

async function setup(initial: AccountHolding[], llm = false, withIndices = false) {
  const db = await createMigratedDb(":memory:");
  resources.push(db);
  let holdings = initial;
  const generator = new FakeGenerator();
  const prompts = new PromptStore();
  const service = new AccountBriefingService({
    db, stocks: { listWithFreshQuotes: async () => holdings }, indices: withIndices ? fakeIndices() : null, calendar: null, generator, prompts,
    features: { enabled: async (key) => key === "accountBriefing" || (llm && key === "accountBriefingLlm") }, now: () => AT,
  });
  return { db, service, generator, prompts, setHoldings: (next: AccountHolding[]) => { holdings = next; } };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(resources.splice(0).map((db) => db.destroy()));
});

describe("남은 계좌 보고서 경계 — 실제 서비스와 가짜 자료", () => {
  it.each(["quote", "fx"] as const)("미국 보유 종목의 %s 자료만 빠져도 미국 종목이 없다고 저장하거나 모델 사실로 전달하지 않는다", async (missing) => {
    const h = await setup([holding("005930"), holding("TSLA", missing)]);
    const result = await h.service.generate("morning", { date: DATE });
    expect(result?.status).toBe("ok");
    const saved = await h.service.get(result!.id);
    expect(saved.data!.holdings).toBe(1);
    expect(saved.data!.excluded).toEqual([{ code: "TSLA", name: "테슬라", reason: missing === "quote" ? "시세를 받지 못해 합계에서 뺐습니다" : "환율을 받지 못해 원화 합계에서 뺐습니다" }]);
    expect.soft(saved.data!.fx).toMatchObject({ status: "unavailable", fxEffect: null });
    expect.soft(saved.data!.fx.reason).not.toContain("미국 종목이 없어");
    expect(factsText(saved.data!)).not.toContain("미국 종목이 없어");
    expect(h.generator.requests).toHaveLength(0);
  });

  it("실제로 국내 종목만 보유하면 환율 효과 해당 없음은 그대로 유지한다", async () => {
    const h = await setup([holding("005930")]);
    const result = await h.service.generate("morning", { date: DATE });
    const saved = await h.service.get(result!.id);
    expect(saved.data!.fx).toMatchObject({ status: "none", reason: "미국 종목이 없어 환율 효과가 없습니다", fxEffect: null });
    expect(h.generator.requests).toHaveLength(0);
  });

  it.each([
    { quantity: 0, avgPrice: 90 },
    { quantity: null, avgPrice: 90 },
    { quantity: 10, avgPrice: null },
  ])("미국 관심 종목·보유값 미입력 $quantity/$avgPrice 는 실제 보유로 세지 않는다", async (values) => {
    const h = await setup([holding("005930"), { ...holding("TSLA", "quote"), ...values }]);
    const result = await h.service.generate("morning", { date: DATE });
    const saved = await h.service.get(result!.id);
    expect(saved.data!.fx).toMatchObject({ status: "none", reason: "미국 종목이 없어 환율 효과가 없습니다" });
    expect(saved.data!.excluded).toEqual([]);
    expect(saved.data!.holdings).toBe(1);
  });

  it.each(["quote", "fx"] as const)("일부 미국 종목만 %s 자료가 빠져도 나머지의 효과를 미국 전체 효과로 저장하지 않는다", async (missing) => {
    const h = await setup([holding("005930"), holding("TSLA", missing), holding("NVDA")], false, true);
    const result = await h.service.generate("morning", { date: DATE });
    const saved = await h.service.get(result!.id);
    expect(saved.data!.holdings).toBe(2);
    expect(saved.data!.excluded.map((row) => row.code)).toEqual(["TSLA"]);
    expect(saved.data!.fx).toMatchObject({ status: "unavailable", priceEffect: null, fxEffect: null, usdHoldingsKrwChange: null, appliedRate: 1400 });
    expect(saved.data!.fx.usdKrw).not.toBeNull();
    expect(factsText(saved.data!)).not.toContain("미국 종목이 없어");
    expect(saved.summary).not.toContain("환율 효과");
    expect(h.generator.requests).toHaveLength(0);
  });

  it.each([false, true])("국내 시세 누락 %s와 무관하게 미국 자료가 완전하면 기존 환율 계산과 총합을 유지한다", async (missingKr) => {
    const h = await setup([holding("005930", missingKr ? "quote" : undefined), holding("TSLA")], false, true);
    const result = await h.service.generate("morning", { date: DATE });
    const saved = await h.service.get(result!.id);
    expect(saved.data!.holdings).toBe(missingKr ? 1 : 2);
    expect(saved.data!.fx).toMatchObject({ status: "computed", reason: null, appliedRate: 1400, priceEffect: 14_000, fxEffect: -2079, usdHoldingsKrwChange: 11_921 });
    expect(saved.data!.totalValue).toBe(missingKr ? 1_400_000 : 2_400_000);
    expect(h.generator.requests).toHaveLength(0);
  });

  it("모델 설명을 켜도 누락 사실을 정확히 전달하고 기존 생성 설정과 한 번 호출을 유지한다", async () => {
    const h = await setup([holding("005930"), holding("TSLA", "quote"), holding("NVDA")], true, true);
    const text = "삼성전자: +10,000원 (등락률 +1.01%)\n미국 보유 종목의 시세 또는 환율이 빠져 전체 환율 효과를 계산하지 못했습니다";
    const generate = h.generator.generate.bind(h.generator);
    vi.spyOn(h.generator, "generate").mockImplementation(async (request) => ({ ...await generate(request), text }));
    const result = await h.service.generate("morning", { date: DATE });
    const saved = await h.service.get(result!.id);
    expect(h.generator.requests).toHaveLength(1);
    const request = h.generator.requests[0]!;
    expect(request).toMatchObject({ maxTokens: 1024, effort: "low", label: "account_briefing" });
    expect(request.user).toContain(factsText(saved.data!));
    expect(request.user).toContain("미국 보유 종목의 시세 또는 환율이 빠져 전체 환율 효과를 계산하지 못했습니다");
    expect(request.user).toContain("삼성전자: +10,000원");
    expect(request.user).not.toContain("미국 종목이 없어");
    expect(saved).toMatchObject({ detail: text, model: "fake-model", data: { narrative: { source: "llm", reason: null } } });
    expect(saved.data!.contributions.map((row) => row.code)).toEqual(["NVDA", "005930"]);
    expect(saved.data!.excluded.map((row) => row.code)).toEqual(["TSLA"]);
  });

  it("보유 종목이 전부 사라진 뒤 강제 생성은 새 성공으로 보고하지 않고 기존 시점의 성공본을 보존한다", async () => {
    const h = await setup([holding("005930")]);
    const first = await h.service.generate("morning", { date: DATE });
    const before = await h.service.get(first!.id);
    h.setHoldings([]);
    expect(await h.service.generate("morning", { date: DATE, force: true })).toBeNull();
    expect(await h.service.get(first!.id)).toEqual(before);
    expect(h.generator.requests).toHaveLength(0);
  });

  it("계좌 모델이 90초를 넘기면 기본 본문으로 완료하고 늦은 모델 결과가 저장된 본문을 덮지 않는다", async () => {
    const h = await setup([holding("005930")], true);
    const prompt = await h.prompts.load("account_briefing");
    vi.spyOn(h.prompts, "load").mockResolvedValue(prompt);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.spyOn(h.generator, "generate").mockImplementation(async () => {
      await wait;
      return { text: "늦게 도착한 가짜 모델 본문", model: "fake-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "end_turn" };
    });
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const pending = h.service.generate("morning", { date: DATE });
    await vi.advanceTimersByTimeAsync(100);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 1024, effort: "low", label: "account_briefing" }));
    await vi.advanceTimersByTimeAsync(90_000);
    const first = await pending;
    const before = await h.service.get(first!.id);
    expect(before).toMatchObject({ status: "ok", model: "template", data: { narrative: { source: "template", reason: "모델 응답 시간 초과(90초)" } } });
    expect(before.detail.length).toBeGreaterThan(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.service.get(first!.id)).toEqual(before);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
