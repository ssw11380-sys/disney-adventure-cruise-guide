import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { TextGenerator } from "../src/llm/generator.js";
import type { PromptStore } from "../src/llm/prompts.js";
import { AccountBriefingService } from "../src/services/accountBriefingService.js";
import { computeAccount, positionsOf, type AccountData, type AccountHolding, type AccountPosition } from "../src/services/accountNumbers.js";
import { compareSinceLast, SINCE_LAST_DAYS, WEIGHT_MIN_PP, WEIGHT_TOP, type SinceLastInput } from "../src/services/accountSinceLast.js";
import { FEATURES } from "../src/services/featureService.js";

/**
 * 브리핑 3차 3 — 지난 브리핑과 비교 (플래그 accountSinceLast).
 *  - 계좌 브리핑을 만들 때 보유 종목별 수량·원화 평가(positions)를 더 저장한다: 합계에 넣은 종목의 값 합 = totalValue (원 단위로 나눔), 시세가 없어 뺀 종목은 value null
 *  - 같은 세션, 날짜가 앞선 성공한 계좌 브리핑 중 가장 최근(10일 안)과 비교해 저장한다 (나중에 옛 브리핑을 열어도 그때 기준 그대로)
 *  - 끄면 positions·sinceLast 칸이 없고 지난 브리핑을 찾지도 않는다
 * 시계는 고정 (월 9/28 08:38, 금 9/25 08:38, 오후 16:05, 10/26 월 등)
 */
const fixture = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountSinceLast.json", import.meta.url), "utf8")) as {
  cases: Array<{ name: string; prev: { id: number; data: SinceLastInput }; now: SinceLastInput; expected: unknown }>;
};
const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/accountBriefing.json", import.meta.url), "utf8")) as { holdings: AccountHolding[]; usdKrw: never };

const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function holding(code: string, name: string, price: number, qty: number, opts: { currency?: "KRW" | "USD"; fx?: number | null; quote?: boolean; avg?: number | null; afterCost?: number } = {}): AccountHolding {
  const currency = opts.currency ?? "KRW";
  const avg = opts.avg === undefined ? price : opts.avg;
  return {
    code,
    name,
    quantity: qty,
    avgPrice: avg,
    quote: opts.quote === false ? null : { currency, price, change: 0, changeRate: 0, fxRate: currency === "USD" ? (opts.fx === undefined ? 1391.5 : opts.fx) : null },
    evaluation:
      opts.quote === false || avg === null
        ? null
        : {
            marketValue: price * qty,
            costBasis: (avg ?? price) * qty,
            profit: 0,
            profitRate: 0,
            costRate: opts.afterCost ?? null,
            afterCost: opts.afterCost ? { marketValue: price * qty * (1 - opts.afterCost), profit: 0, profitRate: 0 } : null,
            costBasisKrw: null,
            krwCostSource: null,
          },
  };
}

describe("보유 종목별 값 (positionsOf, 순수)", () => {
  it("공용 픽스처: 합계에 넣은 종목 값의 합 = 총 평가금액, 매입 합 = 매입금액, 수가 같고 등록 순서 그대로 · 보유가 아닌 종목(관심)은 없음", () => {
    const totals = computeAccount(shared.holdings, { usdKrw: shared.usdKrw });
    const ps = positionsOf(shared.holdings, { afterCost: true });
    expect(ps.map((p) => p.code)).toEqual(shared.holdings.filter((h) => (h.quantity ?? 0) > 0 && h.avgPrice !== null).map((h) => h.code));
    expect(ps.filter((p) => p.value !== null)).toHaveLength(totals.holdings);
    expect(sumOf(ps.map((p) => p.value ?? 0))).toBe(totals.totalValue);
    expect(sumOf(ps.map((p) => p.cost ?? 0))).toBe(totals.totalCost);
    expect(ps.find((p) => p.code === "069500")).toMatchObject({ quantity: 1.5, currency: "KRW" });
    expect(ps.find((p) => p.code === "RGTX")).toMatchObject({ quantity: 120, currency: "USD" });
    for (const p of ps) expect(Number.isInteger(p.value)).toBe(true);
  });

  it("시세가 없거나 환율이 없는 미국 종목은 value·cost null 로 남긴다 (수량은 그대로 — '없어진 종목'으로 세지 않게) · 통화는 코드로", () => {
    const list = [holding("005930", "삼성전자", 70_000, 10), holding("TSLA", "테슬라", 420, 3, { currency: "USD", quote: false }), holding("NVDA", "엔비디아", 178, 5, { currency: "USD", fx: null })];
    const totals = computeAccount(list);
    const ps = positionsOf(list);
    expect(ps).toEqual([
      { code: "005930", name: "삼성전자", currency: "KRW", quantity: 10, value: 700_000, cost: 700_000 },
      { code: "TSLA", name: "테슬라", currency: "USD", quantity: 3, value: null, cost: null },
      { code: "NVDA", name: "엔비디아", currency: "USD", quantity: 5, value: null, cost: null },
    ]);
    expect(totals.excluded.map((e) => e.code)).toEqual(["TSLA", "NVDA"]);
    expect(totals.totalValue).toBe(700_000);
  });

  it("시세에 통화 칸이 없으면 computeAccount 와 같이 KRW 로 본다 (미국 코드여도) — 값의 합 = 총 평가금액이 깨지지 않게", () => {
    const us = holding("TSLA", "테슬라", 420, 3, { currency: "USD" });
    const noCur: AccountHolding = { ...us, quote: { price: 420, change: 0, changeRate: 0, fxRate: 1391.5 } };
    const list = [holding("005930", "삼성전자", 70_000, 10), noCur];
    const totals = computeAccount(list);
    const ps = positionsOf(list);
    expect(ps[1]).toMatchObject({ code: "TSLA", currency: "KRW", value: 1_260 });
    expect(sumOf(ps.map((p) => p.value ?? 0))).toBe(totals.totalValue);
    expect(sumOf(ps.map((p) => p.cost ?? 0))).toBe(totals.totalCost);
    // 시세가 없으면(값 null) 보이는 통화만 코드로 짐작
    expect(positionsOf([holding("TSLA", "테슬라", 420, 3, { currency: "USD", quote: false })])[0]).toMatchObject({ currency: "USD", value: null });
  });

  it("비용 차감(afterCost): 앱 잔고 기본값과 같은 값으로 나누고, 작은 조각이 많아도 합이 정확히 맞는다 (무작위 300회)", () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 0; n < 300; n++) {
      const list = Array.from({ length: 1 + (n % 19) }, (_, i) =>
        i % 4 === 3
          ? holding(`U${i}`, `미국${i}`, Math.round(rnd() * 50_000) / 100, Math.round(rnd() * 3000) / 100, { currency: "USD", fx: 1300 + rnd() * 100, afterCost: 0.001 })
          : holding(`00000${i % 10}`, `국내${i}`, 1_000 + Math.round(rnd() * 300_000), 1 + Math.floor(rnd() * 50), { afterCost: 0.00195, avg: 1_000 + Math.round(rnd() * 300_000) }),
      );
      const totals = computeAccount(list);
      const ps = positionsOf(list);
      expect(sumOf(ps.map((p) => p.value ?? 0))).toBe(totals.totalValue);
      expect(sumOf(ps.map((p) => p.cost ?? 0))).toBe(totals.totalCost);
    }
  });
});

describe("지난 브리핑과 비교 (compareSinceLast, 순수 — 공용 픽스처)", () => {
  for (const c of fixture.cases) {
    it(`${c.name}`, () => {
      expect(compareSinceLast(c.prev, c.now)).toEqual(c.expected);
    });
  }

  const P = (code: string, value: number | null, quantity = 1, name = code): AccountPosition => ({ code, name, currency: "KRW", quantity, value, cost: value });
  const input = (date: string, positions: AccountPosition[], over: Partial<SinceLastInput> = {}): SinceLastInput => ({
    session: "morning",
    date,
    asOf: `${date}T08:38:00+09:00`,
    totalValue: sumOf(positions.map((p) => p.value ?? 0)),
    totalProfit: 0,
    excluded: [],
    positions,
    ...over,
  });

  it(`비중 변화 문턱 ${WEIGHT_MIN_PP}%p: 반올림한 두 값의 차가 0.4 면 빼고 0.5 면 넣는다 · 보이는 두 값의 차와 늘 같다`, () => {
    // 전: A 50.0 · B 50.0 → 지금: A 50.4(504/1000) · B 49.6 → 0.4 → 없음
    expect(compareSinceLast({ id: 1, data: input("2026-09-25", [P("A", 500), P("B", 500)]) }, input("2026-09-28", [P("A", 504), P("B", 496)])).weights).toEqual([]);
    // A 50.5 · B 49.5 → 0.5 → 둘 다 (큰 순, 같으면 먼저 등록한 종목)
    const w = compareSinceLast({ id: 1, data: input("2026-09-25", [P("A", 500), P("B", 500)]) }, input("2026-09-28", [P("A", 505), P("B", 495)])).weights!;
    expect(w).toEqual([
      { code: "A", name: "A", from: 50, to: 50.5, change: 0.5 },
      { code: "B", name: "B", from: 50, to: 49.5, change: -0.5 },
    ]);
    // 반올림: 전 18.24→18.2 · 지금 18.76→18.8 → 차 0.6 (원 값의 차 0.52 가 아니라 보이는 두 값의 차)
    const r = compareSinceLast({ id: 1, data: input("2026-09-25", [P("A", 1824), P("B", 8176)]) }, input("2026-09-28", [P("A", 1876), P("B", 8124)])).weights!;
    expect(r[0]).toEqual({ code: "A", name: "A", from: 18.2, to: 18.8, change: 0.6 });
    for (const x of r) expect(x.change).toBe(Math.round((x.to - x.from) * 10) / 10);
  });

  it(`큰 순 ${WEIGHT_TOP}개까지, 크기가 같으면 지금 목록 순서(먼저 등록한 종목)`, () => {
    const prev = input("2026-09-25", [P("A", 100), P("B", 200), P("C", 300), P("D", 400)]);
    const now = input("2026-09-28", [P("A", 200), P("B", 100), P("C", 400), P("D", 300)]);
    const w = compareSinceLast({ id: 1, data: prev }, now).weights!;
    expect(w.map((x) => x.code)).toEqual(["A", "B", "C"]);
    expect(w.map((x) => x.change)).toEqual([10, -10, 10]);
  });

  it("수량: 소수 주식도 같으면 바뀌지 않은 것 (부동소수 오차), 0.5주 → 1.25주는 늘어남 · 이름은 지금 이름(없어진 종목은 전 이름)", () => {
    const prev = input("2026-09-25", [P("A", 100, 0.1 + 0.2, "에이"), P("B", 100, 0.5, "비"), P("C", 100, 2, "씨 옛이름")]);
    const now = input("2026-09-28", [P("A", 100, 0.3, "에이"), P("B", 100, 1.25, "비 새이름")]);
    expect(compareSinceLast({ id: 1, data: prev }, now).positions).toEqual({
      added: [],
      removed: [{ code: "C", name: "씨 옛이름", from: 2, to: 0 }],
      increased: [{ code: "B", name: "비 새이름", from: 0.5, to: 1.25 }],
      decreased: [],
    });
  });

  it("총 평가가 0 이던 브리핑(모두 시세 없음)과는 비율·비중을 내지 않는다 · 그 종목이 이번에 들어와도 한쪽 합계에만 있어 뺀다", () => {
    const prev = input("2026-09-25", [P("A", null)]);
    // 새로 담은 B 만 금액 변화 (A 는 두 번 다 시세 없음)
    const s = compareSinceLast({ id: 1, data: prev }, input("2026-09-28", [P("A", null), P("B", 1000)]));
    expect(s.value).toEqual({ from: 0, to: 1000, change: 1000, rate: null });
    expect(s.weights).toEqual([]);
    // A 가 이번에 시세를 받았어도 지난 합계에 없던 값이라 비교에서 뺀다 (예전: +1000 · 비율 없음)
    const a = compareSinceLast({ id: 1, data: prev }, input("2026-09-28", [P("A", 1000)]));
    expect(a.value).toEqual({ from: 0, to: 0, change: 0, rate: null });
    expect(a.oneSide).toEqual([{ code: "A", name: "A", side: "prev", why: "price" }]);
  });

  it("지난 브리핑의 합계에서 뺀 종목(excluded)은 excludedPrev 로 (예전 기록에도 있는 칸)", () => {
    const prev = input("2026-09-25", [P("A", 1000)], { excluded: [{ code: "T", name: "테슬라", reason: "시세를 받지 못해 합계에서 뺐습니다" }] });
    expect(compareSinceLast({ id: 1, data: prev }, input("2026-09-28", [P("A", 1000)])).excludedPrev).toEqual([{ code: "T", name: "테슬라" }]);
  });

  // ── 리뷰 고침: 한쪽 브리핑 합계에서만 빠진 종목이 가짜 변화를 만들지 않게 ──
  const T = (reason: string) => [{ code: "T", name: "테슬라", reason }];
  const NO_PRICE = "시세를 받지 못해 합계에서 뺐습니다";
  const NO_FX = "환율을 받지 못해 원화 합계에서 뺐습니다";

  it("이번에만 빠짐(리뷰 재현 — 금 삼성전자 + 테슬라 5.6M, 월 테슬라 시세 없음): 값이 그대로면 총 평가 0원·비중 변화 없음 (고치기 전: -5,600,000원 -41.18% · 58.8% → 100.0%)", () => {
    const prev = input("2026-09-25", [P("S", 8_000_000, 100, "삼성전자"), P("T", 5_600_000, 3, "테슬라")]);
    const now = input("2026-09-28", [P("S", 8_000_000, 100, "삼성전자"), P("T", null, 3, "테슬라")], { excluded: T(NO_PRICE) });
    const s = compareSinceLast({ id: 1, data: prev }, now);
    expect(s.value).toEqual({ from: 8_000_000, to: 8_000_000, change: 0, rate: 0 });
    expect(s.profit.change).toBe(0);
    expect(s.weights).toEqual([]);
    expect(s.positions).toEqual({ added: [], removed: [], increased: [], decreased: [] });
    expect(s.scope).toBe("common");
    expect(s.oneSide).toEqual([{ code: "T", name: "테슬라", side: "now", why: "price" }]);
  });

  it("지난번에만 빠짐(환율을 받지 못함): 값이 그대로면 0원 (고치기 전: +5,844,300원 +83.49% · 100.0% → 54.5%), 이유는 환율", () => {
    const prev = input("2026-09-25", [P("S", 7_000_000, 100, "삼성전자"), P("T", null, 3, "테슬라")], { excluded: T(NO_FX) });
    const now = input("2026-09-28", [P("S", 7_000_000, 100, "삼성전자"), P("T", 5_844_300, 3, "테슬라")]);
    const s = compareSinceLast({ id: 1, data: prev }, now);
    expect(s.value).toEqual({ from: 7_000_000, to: 7_000_000, change: 0, rate: 0 });
    expect(s.weights).toEqual([]);
    expect(s.oneSide).toEqual([{ code: "T", name: "테슬라", side: "prev", why: "fx" }]);
  });

  it("평가손익도 같은 범위로: 한쪽에만 들어 있는 종목의 (평가 − 매입)을 그 합계의 평가손익에서 뺀다", () => {
    const Q = (code: string, value: number | null, cost: number | null): AccountPosition => ({ code, name: code, currency: "KRW", quantity: 1, value, cost });
    const prev: SinceLastInput = { ...input("2026-09-25", [Q("A", 1_000, 800), Q("B", 500, 700)]), totalProfit: 200 - 200 };
    const now: SinceLastInput = { ...input("2026-09-28", [Q("A", 1_100, 800), Q("B", null, null)], { excluded: [{ code: "B", name: "B", reason: NO_PRICE }] }), totalProfit: 300 };
    const s = compareSinceLast({ id: 1, data: prev }, now);
    expect(s.value).toEqual({ from: 1_000, to: 1_100, change: 100, rate: 10 });
    expect(s.profit).toEqual({ from: 200, to: 300, change: 100 });
  });

  it("새 종목·없어진 종목의 값은 그대로 금액 변화에 들어 있다 (한쪽에만 보유 — 수량 변화로 말함) · 시세 없는 새 종목도 '한쪽 합계에서만 빠진 종목'이 아님", () => {
    const prev = input("2026-09-25", [P("A", 1_000), P("R", 500)]);
    const now = input("2026-09-28", [P("A", 1_000), P("N", 300), P("X", null)], { excluded: [{ code: "X", name: "X", reason: NO_PRICE }] });
    const s = compareSinceLast({ id: 1, data: prev }, now);
    expect(s.value).toMatchObject({ from: 1_500, to: 1_300, change: -200 });
    expect(s.scope).toBe("all");
    expect(s.oneSide).toEqual([]);
    expect(s.positions!.added.map((x) => x.code)).toEqual(["N", "X"]);
  });

  it("무작위 500회: 수량·값이 그대로면 어느 종목이 한쪽에서 빠져도 총 평가·평가손익 변화 0 · 비중 변화 없음 · 금액은 두 브리핑 모두 값이 있는 종목의 합", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 0; n < 500; n++) {
      const codes = Array.from({ length: 1 + (n % 9) }, (_, i) => `C${i}`);
      const vals = codes.map(() => 1 + Math.floor(rnd() * 5_000_000));
      const costs = vals.map((v) => Math.max(1, Math.round(v * (0.5 + rnd()))));
      const miss = () => codes.map(() => rnd() < 0.3);
      const mp = miss();
      const mn = miss();
      const side = (m: boolean[], date: string): SinceLastInput => {
        const positions: AccountPosition[] = codes.map((c, i) => ({ code: c, name: c, currency: "KRW", quantity: 1, value: m[i] ? null : vals[i]!, cost: m[i] ? null : costs[i]! }));
        const counted = positions.filter((p) => p.value !== null);
        return {
          session: "morning",
          date,
          asOf: `${date}T08:38:00+09:00`,
          totalValue: sumOf(counted.map((p) => p.value!)),
          totalProfit: sumOf(counted.map((p) => p.value! - p.cost!)),
          excluded: positions.filter((p) => p.value === null).map((p) => ({ code: p.code, name: p.name, reason: rnd() < 0.5 ? NO_PRICE : NO_FX })),
          positions,
        };
      };
      const s = compareSinceLast({ id: 1, data: side(mp, "2026-09-25") }, side(mn, "2026-09-28"));
      const common = sumOf(codes.map((_, i) => (mp[i] || mn[i] ? 0 : vals[i]!)));
      expect(s.value.from).toBe(common);
      expect(s.value.to).toBe(common);
      expect(s.value.change).toBe(0);
      expect(s.profit.change).toBe(0);
      expect(s.weights).toEqual([]);
      expect(s.oneSide.map((o) => o.code)).toEqual(codes.filter((_, i) => mp[i] !== mn[i]));
      expect(s.scope).toBe(codes.some((_, i) => mp[i] !== mn[i]) ? "common" : "all");
    }
  });

  it("종목별 값이 없는 지난 브리핑(배포 첫날): 합계에서 뺀 종목 목록이 다르면 mixed(뺄 수 없어 합계 그대로), 같으면 all", () => {
    const old = (excluded: SinceLastInput["excluded"]): { id: number; data: SinceLastInput } => ({
      id: 1,
      data: { session: "morning", date: "2026-09-25", asOf: "2026-09-25T08:38:00+09:00", totalValue: 1_000, totalProfit: 0, excluded },
    });
    const now = input("2026-09-28", [P("A", 900), P("T", null, 3, "테슬라")], { excluded: T(NO_PRICE) });
    expect(compareSinceLast(old([]), now)).toMatchObject({
      scope: "mixed",
      oneSide: [{ code: "T", name: "테슬라", side: "now", why: "price" }],
      value: { from: 1_000, to: 900, change: -100 },
      positions: null,
      weights: null,
    });
    expect(compareSinceLast(old(T(NO_FX)), now)).toMatchObject({ scope: "all", oneSide: [] });
    // 지난번에만 뺀 종목 → side prev · 이유는 지난 기록의 것
    expect(compareSinceLast(old(T(NO_FX)), input("2026-09-28", [P("A", 900)])).oneSide).toEqual([{ code: "T", name: "테슬라", side: "prev", why: "fx" }]);
  });
});

// ── 계좌 브리핑 서비스 (DB·고정 시계) ──────────────────────────────

/** 모델 없음 (계좌 브리핑은 기본 문장) */
const noModel: TextGenerator = { model: "disabled", generate: async () => Promise.reject(new Error("부르면 안 됨")) };

describe("계좌 브리핑 저장: positions·sinceLast (서비스)", () => {
  let db: Db;
  afterEach(async () => {
    await db?.destroy();
  });

  const setup = async (o: { on?: boolean } = {}) => {
    db = await createMigratedDb(":memory:");
    const st = { list: [holding("000660", "SK하이닉스", 330_000, 10), holding("NVDA", "엔비디아", 322.8, 5, { currency: "USD" })] as AccountHolding[], at: "2026-09-25T08:38:00+09:00" };
    const flags: Record<string, boolean> = { accountBriefing: true, accountBriefingLlm: false, accountSinceLast: o.on ?? true };
    const svc = new AccountBriefingService({
      db,
      stocks: { listWithFreshQuotes: async () => st.list },
      indices: null,
      calendar: null,
      generator: noModel,
      prompts: {} as PromptStore,
      features: { enabled: async (k: string) => flags[k] ?? false },
      now: () => new Date(st.at),
    });
    return { svc, st, flags };
  };
  const make = async (svc: AccountBriefingService, session: "morning" | "afternoon", date: string, force = false) => (await svc.generate(session, { date, force }))!;

  it("플래그는 기본 켬 (서버 FEATURES) — 앱 fallback 은 꺼짐", () => {
    expect(FEATURES.accountSinceLast.default).toBe(true);
  });

  it("처음: positions 저장, 비교할 지난 브리핑이 없으면 sinceLast null · 목록 headline 에 since 없음", async () => {
    const { svc } = await setup();
    const b = await make(svc, "morning", "2026-09-25");
    const d = (await svc.get(b.id)).data!;
    expect(d.positions).toEqual([
      { code: "000660", name: "SK하이닉스", currency: "KRW", quantity: 10, value: 3_300_000, cost: 3_300_000 },
      { code: "NVDA", name: "엔비디아", currency: "USD", quantity: 5, value: Math.round(322.8 * 5 * 1391.5), cost: Math.round(322.8 * 5 * 1391.5) },
    ]);
    expect(sumOf(d.positions!.map((p) => p.value ?? 0))).toBe(d.totalValue);
    expect(d.sinceLast).toBeNull();
    expect(b.headline).not.toHaveProperty("since");
  });

  it("월 9/28 08:38 오전 ↔ 금 9/25 08:38 오전: 수량·비중 변화를 저장하고 목록 headline.since 에 날짜·세션·변화·수량 바뀐 수", async () => {
    const { svc, st } = await setup();
    const fri = await make(svc, "morning", "2026-09-25");
    st.list = [holding("000660", "SK하이닉스", 345_000, 8), holding("005930", "삼성전자", 84_300, 10), holding("NVDA", "엔비디아", 322.8, 8, { currency: "USD" })];
    st.at = "2026-09-28T08:38:00+09:00";
    const mon = await make(svc, "morning", "2026-09-28");
    const d = (await svc.get(mon.id)).data!;
    const s = d.sinceLast!;
    expect(s.prev).toEqual({ id: fri.id, date: "2026-09-25", session: "morning", asOf: "2026-09-25T08:38:00+09:00" });
    const friTotal = 3_300_000 + Math.round(322.8 * 5 * 1391.5);
    expect(s.value).toMatchObject({ from: friTotal, to: d.totalValue, change: d.totalValue - friTotal });
    expect(s.positions).toEqual({
      added: [{ code: "005930", name: "삼성전자", from: 0, to: 10 }],
      removed: [],
      increased: [{ code: "NVDA", name: "엔비디아", from: 5, to: 8 }],
      decreased: [{ code: "000660", name: "SK하이닉스", from: 10, to: 8 }],
    });
    expect(s.weights!.length).toBeGreaterThan(0);
    const listed = (await svc.list())[0]!;
    expect(listed.id).toBe(mon.id);
    expect(listed.headline!.since).toEqual({ date: "2026-09-25", session: "morning", change: d.totalValue - friTotal, qtyChanged: 3 });
    // 저장한 값 그대로: 금요일 브리핑을 다시 열어도 그때 기준(비교 없음)
    expect((await svc.get(fri.id)).data!.sinceLast).toBeNull();
  });

  it("같은 세션끼리: 오후 브리핑은 앞선 오후와 비교하고 같은 날 오전과는 비교하지 않는다", async () => {
    const { svc, st } = await setup();
    st.at = "2026-09-25T16:07:00+09:00";
    const friPm = await make(svc, "afternoon", "2026-09-25");
    st.at = "2026-09-28T08:38:00+09:00";
    const monAm = await make(svc, "morning", "2026-09-28");
    st.at = "2026-09-28T16:05:00+09:00";
    const monPm = await make(svc, "afternoon", "2026-09-28");
    expect((await svc.get(monAm.id)).data!.sinceLast).toBeNull(); // 오전은 지난 오전이 없다
    expect((await svc.get(monPm.id)).data!.sinceLast!.prev).toMatchObject({ id: friPm.id, date: "2026-09-25", session: "afternoon", asOf: "2026-09-25T16:07:00+09:00" });
  });

  it("지난 브리핑이 실패였으면 그 앞 성공한 것과, 10일 넘게 지난 것(10/16 ↔ 9/28)과는 비교하지 않는다 · 10/26(월) ↔ 10/16(금)", async () => {
    const { svc, st } = await setup();
    const thu = await make(svc, "morning", "2026-09-24");
    // 금요일 오전은 시세를 하나도 받지 못해 실패로 저장됨
    const keep = st.list;
    st.list = [holding("000660", "SK하이닉스", 330_000, 10, { quote: false })];
    const fri = await make(svc, "morning", "2026-09-25");
    expect(fri.status).toBe("failed");
    st.list = keep;
    const mon = await make(svc, "morning", "2026-09-28");
    expect((await svc.get(mon.id)).data!.sinceLast!.prev.id).toBe(thu.id);
    // 10/26(월): 마지막 오전 브리핑이 9/28 → 28일 전이라 비교 없음. 10/16(금)은 10일 안 → 비교
    const oct16 = await make(svc, "morning", "2026-10-16");
    const oct26 = await make(svc, "morning", "2026-10-26");
    expect((await svc.get(oct16.id)).data!.sinceLast).toBeNull();
    expect((await svc.get(oct26.id)).data!.sinceLast!.prev.id).toBe(oct16.id);
  });

  it(`${SINCE_LAST_DAYS}일 경계: 10일 전은 비교하고 11일 전은 비교하지 않는다`, async () => {
    const { svc } = await setup();
    const am = await make(svc, "morning", "2026-10-15");
    const am10 = await make(svc, "morning", "2026-10-25"); // 10일 뒤
    expect((await svc.get(am10.id)).data!.sinceLast!.prev.id).toBe(am.id);
    await make(svc, "afternoon", "2026-10-15");
    const pm11 = await make(svc, "afternoon", "2026-10-26"); // 11일 뒤
    expect((await svc.get(pm11.id)).data!.sinceLast).toBeNull();
  });

  it("예전 기록(positions 없음)과 비교: 총 평가·평가손익만, 종목별 변화 null", async () => {
    const { svc, flags } = await setup();
    flags.accountSinceLast = false;
    await make(svc, "morning", "2026-09-25");
    flags.accountSinceLast = true;
    const mon = await make(svc, "morning", "2026-09-28");
    const s = (await svc.get(mon.id)).data!.sinceLast!;
    expect(s.positions).toBeNull();
    expect(s.weights).toBeNull();
    expect(s.value.change).toBe(0);
    expect((await svc.list())[0]!.headline!.since).toEqual({ date: "2026-09-25", session: "morning", change: 0, qtyChanged: null });
  });

  it("수동 전체 다시 만들기(force)는 다시 계산한다", async () => {
    const { svc, st } = await setup();
    await make(svc, "morning", "2026-09-25");
    st.at = "2026-09-28T08:38:00+09:00";
    const first = await make(svc, "morning", "2026-09-28");
    expect((await svc.get(first.id)).data!.sinceLast!.positions!.added).toEqual([]);
    st.list = [...st.list, holding("005930", "삼성전자", 84_300, 10)];
    const again = await make(svc, "morning", "2026-09-28", true);
    expect(again.id).toBe(first.id);
    expect((await svc.get(again.id)).data!.sinceLast!.positions!.added).toEqual([{ code: "005930", name: "삼성전자", from: 0, to: 10 }]);
  });

  it("월 오전에만 엔비디아 환율을 받지 못함: 금액·비중은 SK하이닉스끼리(엔비디아 뺌) · 목록 한 줄에 leftOut 1 · 이유 fx", async () => {
    const { svc, st } = await setup();
    const fri = await make(svc, "morning", "2026-09-25");
    st.list = [holding("000660", "SK하이닉스", 345_000, 10), holding("NVDA", "엔비디아", 322.8, 5, { currency: "USD", fx: null })];
    st.at = "2026-09-28T08:38:00+09:00";
    const mon = await make(svc, "morning", "2026-09-28");
    const d = (await svc.get(mon.id)).data!;
    expect(d.excluded.map((e) => e.code)).toEqual(["NVDA"]);
    const s = d.sinceLast!;
    expect(s.prev.id).toBe(fri.id);
    // 엔비디아 값이 금요일 합계에만 있어도 가짜 '줄어듦'이 나오지 않는다: 3,300,000 → 3,450,000
    expect(s.value).toEqual({ from: 3_300_000, to: 3_450_000, change: 150_000, rate: 4.55 });
    expect(s.weights).toEqual([]);
    expect(s.scope).toBe("common");
    expect(s.oneSide).toEqual([{ code: "NVDA", name: "엔비디아", side: "now", why: "fx" }]);
    expect((await svc.list())[0]!.headline!.since).toEqual({ date: "2026-09-25", session: "morning", change: 150_000, qtyChanged: 0, leftOut: 1 });
  });

  it("예전 기록(positions 없음)과 비교하는데 이번에만 시세가 없는 종목: 뺄 수 없어 합계 그대로(scope mixed) · 목록 한 줄은 싣지 않음", async () => {
    const { svc, st, flags } = await setup();
    flags.accountSinceLast = false;
    await make(svc, "morning", "2026-09-25");
    flags.accountSinceLast = true;
    st.list = [holding("000660", "SK하이닉스", 330_000, 10), holding("NVDA", "엔비디아", 322.8, 5, { currency: "USD", quote: false })];
    st.at = "2026-09-28T08:38:00+09:00";
    const mon = await make(svc, "morning", "2026-09-28");
    const s = (await svc.get(mon.id)).data!.sinceLast!;
    expect(s).toMatchObject({ scope: "mixed", oneSide: [{ code: "NVDA", name: "엔비디아", side: "now", why: "price" }], positions: null, weights: null });
    expect(s.value.change).toBe(-Math.round(322.8 * 5 * 1391.5));
    const listed = (await svc.list())[0]!;
    expect(listed.id).toBe(mon.id);
    expect(listed.headline).not.toHaveProperty("since");
  });

  it("꺼짐: positions·sinceLast 칸이 없고(예전 모양 그대로) 지난 브리핑을 찾지 않는다 · headline 에 since 없음", async () => {
    const { svc, flags, st } = await setup({ on: false });
    const spy = vi.spyOn(svc as unknown as { previousOk: () => unknown }, "previousOk");
    await make(svc, "morning", "2026-09-25");
    st.at = "2026-09-28T08:38:00+09:00";
    const mon = await make(svc, "morning", "2026-09-28");
    const d = (await svc.get(mon.id)).data! as AccountData & Record<string, unknown>;
    expect(d).not.toHaveProperty("positions");
    expect(d).not.toHaveProperty("sinceLast");
    expect((await svc.list())[0]!.headline).not.toHaveProperty("since");
    expect(spy).not.toHaveBeenCalled();
    // 켜면 찾는다
    flags.accountSinceLast = true;
    await make(svc, "morning", "2026-09-28", true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
