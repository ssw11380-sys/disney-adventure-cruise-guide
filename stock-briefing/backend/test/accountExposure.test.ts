import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyProduct, levInvOf, productKindOf, type LevInv, type ProductFacts } from "../src/analysis/leveraged.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { TextGenerator } from "../src/llm/generator.js";
import type { PromptStore } from "../src/llm/prompts.js";
import { AccountBriefingService } from "../src/services/accountBriefingService.js";
import { computeAccount, exposureOf, positionsOf, type AccountData, type AccountExposure, type AccountHolding, type AccountPosition } from "../src/services/accountNumbers.js";
import { FEATURES } from "../src/services/featureService.js";

/**
 * 브리핑 3차 4 — 비중 한 줄 (플래그 accountExposure).
 *  - 계좌 브리핑을 만들 때 가장 큰 종목·상위 3종목·레버리지·인버스·미국 상장 비중을 계산해 data.exposure 로 저장한다 (그때 기준 그대로)
 *  - 레버리지·인버스 가리기는 지표 점수 1단계와 같다: 토스 웹 상품 정보 → 종목 마스터 분류(listed_stocks.group_code) → 정적 표 → 이름 규칙
 *  - 끄면 칸이 없고 상품 정보를 부르지 않는다
 * 시계는 고정 (월 9/28 08:38, 오후 16:05)
 */
type Kind = { kind: "leveraged" | "inverse" | null; L: number | null; guessed: boolean };
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountExposure.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; asOf: string; positions: AccountPosition[]; kinds: Record<string, Kind>; expected: AccountExposure | null }>;
};
const kindsOf = (k: Record<string, Kind>) => new Map(Object.entries(k).map(([code, v]) => [code, v as LevInv]));

describe("비중 계산 (exposureOf, 순수 — 공용 픽스처)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(exposureOf(c.positions, kindsOf(c.kinds), c.asOf)).toEqual(c.expected);
    });
  }

  const P = (code: string, value: number | null, currency: "KRW" | "USD" = "KRW", name = code): AccountPosition => ({ code, name, currency, quantity: 1, value, cost: value });

  it("상위 3종목은 원 값을 더한 뒤 반올림 (조각 반올림의 합이 아님): 33.3 + 33.3 + 33.3 = 99.9 가 아니라 100.0", () => {
    const e = exposureOf([P("A", 3334), P("B", 3333), P("C", 3333), P("D", 1)], new Map(), "2026-09-28T08:38:00+09:00")!;
    expect(e.top1).toEqual({ code: "A", name: "A", weight: 33.3 });
    expect(e.top3).toEqual({ weight: 100 });
  });

  it("레버리지·인버스 합도 원 값을 더한 뒤 반올림 · 줄은 값이 큰 순(같으면 먼저 등록한 종목)", () => {
    const kinds = new Map<string, LevInv>([
      ["L1", { kind: "leveraged", L: 2, guessed: false }],
      ["L2", { kind: "inverse", L: 1, guessed: false }],
      ["L3", { kind: "leveraged", L: 3, guessed: false }],
    ]);
    const e = exposureOf([P("N", 9_000), P("L1", 333), P("L2", 334), P("L3", 333)], kinds, "2026-09-28T08:38:00+09:00")!;
    expect(e.levInv.weight).toBe(10);
    expect(e.levInv.items.map((x) => [x.code, x.weight])).toEqual([
      ["L2", 3.3],
      ["L1", 3.3],
      ["L3", 3.3],
    ]);
  });

  it("합계에서 뺀 종목(값 null)은 분모·순위·레버리지에서 빠지고 excluded 로 센다 · 상품 종류를 몰라도 된다", () => {
    const kinds = new Map<string, LevInv>([["SOXL", { kind: "leveraged", L: 3, guessed: true }]]);
    const e = exposureOf([P("005930", 1_000_000), P("SOXL", null, "USD"), P("NVDA", 1_000_000, "USD")], kinds, "2026-09-28T08:38:00+09:00")!;
    expect(e).toMatchObject({ count: 2, excluded: 1, guessedByName: 0, levInv: { weight: 0, items: [] }, us: { weight: 50, count: 1 }, top3: null });
  });

  it("값이 있는 종목이 없거나 합이 0 이면 null (줄 없음)", () => {
    expect(exposureOf([], new Map(), "2026-09-28T08:38:00+09:00")).toBeNull();
    expect(exposureOf([P("TSLA", null, "USD")], new Map(), "2026-09-28T08:38:00+09:00")).toBeNull();
    expect(exposureOf([P("A", 0)], new Map(), "2026-09-28T08:38:00+09:00")).toBeNull();
  });

  it("비중은 지난 브리핑과 비교(accountSinceLast)의 비중과 같은 반올림 — 값 ÷ 합 × 100 을 소수 한 자리로", () => {
    const e = exposureOf([P("A", 2_125), P("B", 7_875)], new Map(), "2026-09-28T08:38:00+09:00")!;
    expect(e.top1.weight).toBe(Math.round((7_875 / 10_000) * 100 * 10) / 10);
  });
});

describe("레버리지·인버스 가리기 (levInvOf — 지표 점수 1단계와 같은 규칙)", () => {
  const F = (f: Partial<ProductFacts>): ProductFacts => ({ name: null, englishName: null, detailName: null, group: null, exchange: null, leverageFactor: null, singleStockEtp: null, derivativeEtf: null, ...f });
  it.each<[string, string, string, ProductFacts | null, string | null, LevInv]>([
    ["SOXL: 정적 표 3배 (상품 정보가 없어도 표로 — 이름 짐작 아님)", "SOXL", "디렉시온 반도체 불 3X", null, null, { kind: "leveraged", L: 3, guessed: false }],
    ["RGTX: 상품 정보 배수 2 · 단일 종목형", "RGTX", "RGTX", F({ group: "EF", leverageFactor: 2, singleStockEtp: true }), null, { kind: "leveraged", L: 2, guessed: false }],
    ["TQQQ: 상품 정보 배수 3", "TQQQ", "ProShares UltraPro QQQ", F({ group: "EF", leverageFactor: 3 }), null, { kind: "leveraged", L: 3, guessed: false }],
    ["SQQQ: 음수 배수 → 인버스 3", "SQQQ", "ProShares UltraPro Short QQQ", F({ group: "EF", leverageFactor: -3 }), null, { kind: "inverse", L: 3, guessed: false }],
    ["KODEX 인버스: 음수 배수 −1 → 인버스 1", "114800", "KODEX 인버스", F({ group: "EF", leverageFactor: -1 }), "EF", { kind: "inverse", L: 1, guessed: false }],
    ["122630 KODEX 레버리지: 국내 정적 표 2배", "122630", "KODEX 레버리지", null, "EF", { kind: "leveraged", L: 2, guessed: false }],
    ["252670: 상품 정보 없음 → 이름의 인버스·2X (이름으로 구분)", "252670", "KODEX 200선물인버스2X", null, "EF", { kind: "inverse", L: 2, guessed: true }],
    ["Build-A-Bear: 토스 상품 정보가 보통 주식(ST) → 인버스 아님", "BBW", "Build-A-Bear Workshop", F({ group: "ST", leverageFactor: 0 }), null, { kind: null, L: null, guessed: false }],
    ["Build-A-Bear: 상품 정보가 없어도 종목 마스터가 보통 주식(ST) → 인버스 아님 · 이름 짐작 아님", "BBW", "Build-A-Bear Workshop", null, "ST", { kind: null, L: null, guessed: false }],
    ["애플: 상품 정보·마스터 분류가 모두 없음 → 이름 규칙으로 보통 (이름으로 구분)", "AAPL", "애플", null, null, { kind: null, L: null, guessed: true }],
    ["애플: 상품 정보 받음 → 보통", "AAPL", "애플", F({ group: "ST", leverageFactor: 0 }), null, { kind: null, L: null, guessed: false }],
    ["배수를 모르는 레버리지(이름에 Bull 만)", "XBUL", "Example Bull ETF", null, null, { kind: "leveraged", L: null, guessed: true }],
    ["배수를 모르는 인버스(이름에 Short 만)", "XSHT", "Example Short ETF", null, null, { kind: "inverse", L: null, guessed: true }],
    ["채권 ETF 는 레버리지·인버스 아님 (짧은 만기 'Short-Term')", "SHY", "iShares 1-3 Year Treasury Bond ETF Short-Term", F({ group: "EF", leverageFactor: 0 }), null, { kind: null, L: null, guessed: false }],
  ])("%s", (_n, code, name, facts, group, want) => {
    expect(levInvOf(code, name, facts, group)).toEqual(want);
  });

  it("productKindOf = 지표 점수가 쓰던 입력 그대로 (상품 정보가 없거나 분류 칸이 비면 종목 마스터 분류를 group 으로)", () => {
    const cases: Array<[string, string, ProductFacts | null, string | null]> = [
      ["BBW", "Build-A-Bear Workshop", null, "ST"],
      ["BBW", "Build-A-Bear Workshop", null, null],
      ["RGTX", "RGTX", F({ leverageFactor: 2, singleStockEtp: true }), "EF"],
      ["114800", "KODEX 인버스", F({ group: null }), "EF"],
      ["SOXL", "SOXL", null, null],
    ];
    for (const [code, name, facts, group] of cases) {
      const hint: ProductFacts | null = facts || group ? { ...facts, group: facts?.group ?? group ?? null } : null;
      expect(productKindOf(code, name, facts, group)).toEqual(classifyProduct(code, name, hint));
    }
  });
});

// ── 서비스 ─────────────────────────────────────────────

const noModel: TextGenerator = { model: "disabled", generate: async () => Promise.reject(new Error("부르면 안 됨")) };

function holding(code: string, name: string, price: number, qty: number, opts: { currency?: "KRW" | "USD"; quote?: boolean } = {}): AccountHolding {
  const currency = opts.currency ?? "KRW";
  return {
    code,
    name,
    quantity: qty,
    avgPrice: price,
    quote: opts.quote === false ? null : { currency, price, change: 0, changeRate: 0, fxRate: currency === "USD" ? 1400 : null },
    evaluation:
      opts.quote === false
        ? null
        : { marketValue: price * qty, costBasis: price * qty, profit: 0, profitRate: 0, costRate: null, afterCost: null, costBasisKrw: null, krwCostSource: null },
  };
}

describe("계좌 브리핑 저장: exposure (서비스)", () => {
  let db: Db;
  afterEach(async () => {
    await db?.destroy();
  });

  const LIST = () => [
    holding("005930", "삼성전자", 80_000, 50), // 4,000,000
    holding("122630", "KODEX 레버리지", 20_000, 50), // 1,000,000 (표 2배)
    holding("TSLA", "테슬라", 400, 5, { currency: "USD", quote: false }), // 시세 없음
    holding("NVDA", "엔비디아", 200, 10, { currency: "USD" }), // 2,800,000
    holding("RGTX", "RGTX", 50, 30, { currency: "USD" }), // 2,100,000 (상품 정보 2배)
    holding("BBW", "Build-A-Bear Workshop", 50, 1, { currency: "USD" }), // 70,000 (ST)
  ];
  const FACTS: Record<string, ProductFacts | null> = {
    "005930": { group: "ST", leverageFactor: 0 },
    NVDA: { group: "ST", leverageFactor: 0 },
    RGTX: { group: "EF", leverageFactor: 2, singleStockEtp: true },
    BBW: { group: "ST", leverageFactor: 0 },
    // 122630: 상품 정보를 받지 못함(null) → 종목 마스터 EF + 정적 표 2배
    "122630": null,
  };

  const setup = async (o: { exposure?: boolean; since?: boolean; facts?: (code: string) => Promise<ProductFacts | null>; productWaitMs?: number; noProduct?: boolean } = {}) => {
    db = await createMigratedDb(":memory:");
    await db.insertInto("listed_stocks").values([
      { code: "122630", name: "KODEX 레버리지", market: "KOSPI", isin_code: null, group_code: "EF", updated_at: "2026-09-28T00:00:00+09:00" },
      { code: "005930", name: "삼성전자", market: "KOSPI", isin_code: null, group_code: "ST", updated_at: "2026-09-28T00:00:00+09:00" },
    ]).execute();
    const st = { list: LIST(), at: "2026-09-28T08:38:00+09:00" };
    const flags: Record<string, boolean> = { accountBriefing: true, accountBriefingLlm: false, accountSinceLast: o.since ?? false, accountExposure: o.exposure ?? true };
    const productFacts = vi.fn(o.facts ?? (async (code: string) => FACTS[code] ?? null));
    const svc = new AccountBriefingService({
      db,
      stocks: { listWithFreshQuotes: async () => st.list },
      indices: null,
      calendar: null,
      generator: noModel,
      prompts: {} as PromptStore,
      features: { enabled: async (k: string) => flags[k] ?? false },
      productInfo: o.noProduct ? null : { productFacts },
      ...(o.productWaitMs !== undefined ? { productWaitMs: o.productWaitMs } : {}),
      now: () => new Date(st.at),
    });
    return { svc, st, flags, productFacts };
  };
  const make = async (svc: AccountBriefingService, session: "morning" | "afternoon" = "morning", date = "2026-09-28") => (await svc.generate(session, { date }))!;

  it("플래그는 기본 켬 (서버 FEATURES) — 앱 fallback 은 꺼짐", () => {
    expect(FEATURES.accountExposure.default).toBe(true);
  });

  it("켬: 가장 큰 종목·상위 3·레버리지(표·상품 정보)·미국 상장·시세 없는 종목 수를 저장 · 기준 시각 = asOf · 목록 headline 은 그대로", async () => {
    const { svc, productFacts } = await setup();
    const b = await make(svc);
    const d = (await svc.get(b.id)).data!;
    expect(d.totalValue).toBe(9_970_000);
    expect(d.exposure).toEqual({
      asOf: "2026-09-28T08:38:00+09:00",
      count: 5,
      top1: { code: "005930", name: "삼성전자", weight: 40.1 },
      top3: { weight: 89.3 },
      levInv: {
        weight: 31.1,
        items: [
          { code: "RGTX", name: "RGTX", kind: "leveraged", L: 2, weight: 21.1 },
          { code: "122630", name: "KODEX 레버리지", kind: "leveraged", L: 2, weight: 10 },
        ],
      },
      us: { weight: 49.8, count: 3 },
      excluded: 1,
      guessedByName: 0,
    });
    // 상품 정보는 합계에 넣은 종목만 (시세 없는 테슬라는 부르지 않음)
    expect(productFacts.mock.calls.map((c) => c[0]).sort()).toEqual(["005930", "122630", "BBW", "NVDA", "RGTX"]);
    expect(b.headline).not.toHaveProperty("exposure");
    // 지난 브리핑과 비교가 꺼져 있으면 종목별 값(positions)은 저장하지 않는다 (비중에만 씀)
    expect(d).not.toHaveProperty("positions");
    expect(d).not.toHaveProperty("sinceLast");
  });

  it("값은 positionsOf 와 같은 원화 평가로: 비중의 분자 합 = 총 평가금액", async () => {
    const { svc } = await setup({ since: true });
    const d = (await svc.get((await make(svc)).id)).data!;
    const want = exposureOf(positionsOf(LIST(), { afterCost: true }), new Map<string, LevInv>([["RGTX", { kind: "leveraged", L: 2, guessed: false }], ["122630", { kind: "leveraged", L: 2, guessed: false }]]), d.asOf);
    expect(d.exposure).toEqual(want);
    expect(d.positions!.reduce((a, p) => a + (p.value ?? 0), 0)).toBe(computeAccount(LIST()).totalValue);
  });

  it("상품 정보를 받지 못한 종목: 종목 마스터가 보통 주식이면 그대로, 모르면 정적 표·이름 규칙으로 가리고 guessedByName 으로 센다", async () => {
    const { svc } = await setup({ facts: async (code) => (code === "RGTX" ? FACTS["RGTX"]! : null) });
    const e = (await svc.get((await make(svc)).id)).data!.exposure!;
    // 삼성전자(마스터 ST)·122630(표)는 짐작 아님, 엔비디아·BBW(마스터 없음)는 이름 규칙 — BBW 는 이름의 'Bear' 로 인버스가 되어 버림 → 그래서 안내가 붙는다
    expect(e.guessedByName).toBe(2);
    expect(e.levInv.items.map((x) => [x.code, x.kind])).toEqual([
      ["RGTX", "leveraged"],
      ["122630", "leveraged"],
      ["BBW", "inverse"],
    ]);
  });

  it("상품 정보가 늦으면 기다리지 않는다(종목마다 제한 시간) — 표·이름 규칙으로 저장하고 계좌 브리핑은 그대로 만든다", async () => {
    const { svc } = await setup({ facts: (code) => (code === "NVDA" ? new Promise<ProductFacts | null>(() => undefined) : Promise.resolve(FACTS[code] ?? null)), productWaitMs: 30 });
    const b = await make(svc);
    expect(b.status).toBe("ok");
    const e = (await svc.get(b.id)).data!.exposure!;
    // 엔비디아: 상품 정보를 기다리지 않고 종목 마스터(없음) → 이름 규칙으로 보통 → 이름으로 구분한 1종목. 나머지는 그대로
    expect(e.levInv.items.map((x) => x.code)).toEqual(["RGTX", "122630"]);
    expect(e.guessedByName).toBe(1);
  });

  it("상품 정보 출처가 없거나(설정 없음) 오류를 내도 저장한다", async () => {
    const a = await setup({ noProduct: true });
    // 상품 정보 없이: RGTX·122630 은 정적 표, 엔비디아는 이름 규칙(보통), BBW 는 종목 마스터가 없어 이름의 'Bear' 로 인버스 → 이름으로 구분한 2종목
    const ea = (await a.svc.get((await make(a.svc)).id)).data!.exposure!;
    expect(ea.levInv.items.map((x) => x.code)).toEqual(["RGTX", "122630", "BBW"]);
    expect(ea.guessedByName).toBe(2);
    await db.destroy();
    const b = await setup({ facts: async () => Promise.reject(new Error("토스 오류")) });
    const e = (await b.svc.get((await make(b.svc)).id)).data!.exposure!;
    expect(e.count).toBe(5);
    expect(e.levInv.items.map((x) => x.code)).toContain("122630");
    await db.destroy();
    // 부르는 순간 던지는(동기 오류) 출처여도 계좌 브리핑은 성공으로 만들고 비중도 저장
    const c = await setup({
      facts: () => {
        throw new Error("동기 오류");
      },
    });
    const bc = await make(c.svc);
    expect(bc.status).toBe("ok");
    expect((await c.svc.get(bc.id)).data!.exposure!.guessedByName).toBe(2);
  });

  it("꺼짐: exposure 칸이 없고(예전 모양 그대로) 상품 정보를 부르지 않는다", async () => {
    const { svc, productFacts, flags } = await setup({ exposure: false, since: true });
    const d = (await svc.get((await make(svc)).id)).data! as AccountData & Record<string, unknown>;
    expect(d).not.toHaveProperty("exposure");
    expect(productFacts).not.toHaveBeenCalled();
    // 켜면 부른다
    flags.accountExposure = true;
    await svc.generate("morning", { date: "2026-09-28", force: true });
    expect(productFacts).toHaveBeenCalled();
  });

  it("시세를 하나도 받지 못해 실패로 저장한 브리핑에는 없다 (상품 정보도 부르지 않음)", async () => {
    const { svc, st, productFacts } = await setup();
    st.list = [holding("TSLA", "테슬라", 400, 5, { currency: "USD", quote: false })];
    const b = await make(svc);
    expect(b.status).toBe("failed");
    expect((await svc.get(b.id)).data).not.toHaveProperty("exposure");
    expect(productFacts).not.toHaveBeenCalled();
  });

  it("오후 브리핑: 기준 시각은 그 브리핑의 asOf (16:05)", async () => {
    const { svc, st } = await setup();
    st.at = "2026-09-28T16:05:00+09:00";
    const d = (await svc.get((await make(svc, "afternoon")).id)).data!;
    expect(d.exposure!.asOf).toBe("2026-09-28T16:05:00+09:00");
    expect(d.exposure!.asOf).toBe(d.asOf);
  });
});
