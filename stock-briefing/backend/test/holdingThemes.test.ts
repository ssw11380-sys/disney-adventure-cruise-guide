import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productKindOf } from "../src/analysis/leveraged.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { TextGenerator } from "../src/llm/generator.js";
import type { PromptStore } from "../src/llm/prompts.js";
import type { MarketCalendar, MarketState } from "../src/providers/market/calendar.js";
import type { DiscoverStock, KrQuote, NaverDiscover, ThemeKind, ThemePeriod, ThemeSummary, UsQuote } from "../src/providers/market/naverDiscover.js";
import type { TossTics } from "../src/providers/market/tossTics.js";
import { holdingThemeAdminRoutes, holdingThemeRoutes } from "../src/routes/holdingThemes.js";
import { AccountBriefingService } from "../src/services/accountBriefingService.js";
import type { AccountHolding } from "../src/services/accountNumbers.js";
import { DiscoverService } from "../src/services/discoverService.js";
import { FEATURES } from "../src/services/featureService.js";
import { HoldingThemeMaps, MAPS_KEY, type MapSources } from "../src/services/holdingThemeMaps.js";
import { themeWordingProblems, underlyingOfKind } from "../src/services/holdingThemesCalc.js";
import { HoldingThemesService, nyDate, toSnapshot, type HeldPosition, type HoldingThemesResponse } from "../src/services/holdingThemesService.js";
import { KR_INDEX_KEY, KrThemeIndex } from "../src/services/krThemeIndex.js";
import { ThemeTvHistory, tvKey } from "../src/services/themeTvHistory.js";
import type { UsThemeBook, UsThemeBookData } from "../src/services/usThemes.js";
import { fakeProviders } from "./helpers.js";

/**
 * 3-35 내 보유 종목 × 테마 강도 — 서비스·경로·예약 작업·계좌 브리핑 저장본.
 * 발견 탭 서비스(DiscoverService)는 진짜를 쓰고 출처(네이버·토스)만 가짜로 바꿔, 이 기능이 보이는 등락률·오른/내린 수가 발견 탭과 같은지 본다.
 * 시계 고정: 2026-09-29(화) 11:00 KST — 한국 정규장, 미국은 9/28(월) 정규장 마감 뒤
 */
const NOW = "2026-09-29T11:00:00+09:00";
const US_CLOSE = "2026-09-28T20:00:00.000Z"; // 9/28 16:00 EDT
const state = (market: "KR" | "US", isOpen: boolean, lastClose: string | null = null): MarketState => ({ market, isOpen, isTradingDay: true, opensAt: null, closesAt: null, lastClose, source: "toss" });
const calendarOf = (kr: MarketState, us: MarketState) => ({ status: async () => ({ now: "", KR: kr, US: us }) }) as unknown as MarketCalendar;
const memStore = () => {
  const m = new Map<string, string>();
  return { m, store: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v) } };
};
const theme = (id: string, name: string, changeRate: number, up: number, flat: number, down: number): ThemeSummary => ({ id, name, changeRate, up, flat, down, leaders: [] });

// ── 가짜 출처 ─────────────────────────────────────────────

/** 미국 테마북: 깊이 1 이상 테마, 테마마다 미국 3종목 이상 (로이터 코드) */
const US_THEMES: Array<{ id: string; name: string; members: string[] }> = [
  { id: "179", name: "반도체팹리스", members: ["NVDA", "AVGO", "AMD", "QCOM"] },
  { id: "823", name: "인공지능", members: ["NVDA", "MSFT", "GOOGL", "META"] },
  { id: "209", name: "컴퓨터와 주변기기", members: ["AAPL", "NVDA", "DELL"] },
  { id: "956", name: "양자컴퓨터", members: ["IONQ", "RGTI", "QBTS", "QUBT"] },
  { id: "89", name: "IT솔루션구축", members: ["ACN", "IBM", "RGTI"] },
  { id: "389", name: "소프트웨어", members: ["MSFT", "PLTR", "ORCL", "IONQ", "AVGO"] },
  { id: "203", name: "스마트폰제조", members: ["AAPL", "SSNLF", "XIACF"] },
  { id: "475", name: "클라우드", members: ["MSFT", "AMZN", "GOOGL"] },
  { id: "359", name: "인터넷", members: ["META", "GOOGL", "AMZN", "MSFT"] },
  { id: "295", name: "전기차", members: ["TSLA", "RIVN", "LCID"] },
  { id: "291", name: "자동차브랜드", members: ["TSLA", "GM", "F"] },
];
const rc = (sym: string) => `${sym}.O`;
const BOOK: UsThemeBookData = {
  version: 1,
  builtAt: Date.parse("2026-09-28T21:00:00+09:00"),
  themes: US_THEMES.map((t) => ({ id: t.id, name: t.name, root: "IT", depth: 1, total: t.members.length, members: t.members.map((s) => ({ productCode: `US${s}`, symbol: s, reuters: rc(s) })) })),
};
/** 미국 정규장 종가 등락률 (9/28) */
const US_RATE: Record<string, number> = { NVDA: 1.2, AVGO: -0.3, AMD: 2, QCOM: 0.5, MSFT: 0.8, GOOGL: -1.1, META: 0.4, AAPL: -0.2, DELL: 1.5, IONQ: 6, RGTI: 6.2, QBTS: 7, QUBT: 5, ACN: 0.1, IBM: -0.4, PLTR: 2.2, ORCL: 1, SSNLF: 0, XIACF: -2, AMZN: 0.3, TSLA: -1.5, RIVN: -3, LCID: -2.5, GM: 0.2, F: 0, SOFI: 1.1, QQQ: 0.6, SOXL: 3.3, RGTX: 12.4 };
const usQuote = (sym: string): UsQuote => ({ code: sym, name: sym, market: "NASDAQ", currency: "USD", price: 100, change: 1, changeRate: US_RATE[sym] ?? 0, volume: 1000, tradingValue: 2_000_000, marketCap: 1e9, tradedAt: "2026-09-28T16:00:00-04:00", status: "CLOSE" });

/** 한국 테마 (id → 이름·구성) — 거꾸로 찾는 표의 원본 */
const KR_THEMES: Array<{ id: string; name: string; members: string[]; s: [number, number, number, number] }> = [
  { id: "543", name: "HBM(고대역폭메모리)", members: ["005930", "000660", "042700"], s: [-4.12, 1, 0, 2] },
  { id: "12", name: "반도체 대표주", members: ["005930", "000660"], s: [-3.5, 0, 0, 2] },
  { id: "700", name: "2차전지", members: ["373220", "247540"], s: [0.85, 2, 0, 0] },
];
const KR_SECTORS: ThemeSummary[] = [theme("278", "반도체와반도체장비", -5.47, 10, 2, 40), theme("299", "기계", 1.2, 20, 5, 10)];
const US_SECTORS: ThemeSummary[] = [theme("57101010", "반도체", 2.3, 30, 1, 10), theme("55101030", "소비자 대출", -0.8, 3, 0, 5)];
const KR_WEEK: Record<string, [number, number, number, number]> = { "543": [5.1, 3, 0, 0], "12": [4, 2, 0, 0], "700": [-1, 0, 0, 2], "278": [3.3, 30, 2, 20], "299": [-0.5, 10, 5, 20] };
const KR_RATE: Record<string, number> = { "005930": -5, "000660": -4.2, "042700": -3.1, "373220": 1, "247540": 0.7, "123456": 2.5 };
const krQuote = (code: string, day = "2026-09-29"): KrQuote => ({ code, name: code, exchange: "KS", price: 1000, changeRate: KR_RATE[code] ?? 0, tradedAt: `${day}T11:00:00+09:00`, status: "OPEN", tradingValue: 1e10 });
const stock = (code: string, rate: number, tv: number): DiscoverStock => ({ code, name: code, market: "KOSPI", currency: "KRW", price: 1000, change: 10, changeRate: rate, volume: 100, tradingValue: tv, marketCap: 1e12 });

function fakeNaver(o: { krDay?: string } = {}) {
  const calls: Record<string, number> = {};
  const count = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
  const naver = {
    marketStatus: async () => {
      count("marketStatus");
      throw new Error("장 상태는 달력(가짜)으로");
    },
    newlyListedToday: async () => new Set<string>(),
    sectors: async (market: "KR" | "US", kind: ThemeKind, period: ThemePeriod) => {
      count(`sectors:${market}:${kind}:${period}`);
      if (market === "US") return US_SECTORS.map((t) => (period === "day" ? t : { ...t, changeRate: t.changeRate * 2 }));
      if (kind === "sector") return KR_SECTORS.map((t) => (period === "day" ? t : { ...t, changeRate: KR_WEEK[t.id]![0], up: KR_WEEK[t.id]![1], flat: KR_WEEK[t.id]![2], down: KR_WEEK[t.id]![3] }));
      return KR_THEMES.map((t) => (period === "day" ? theme(t.id, t.name, ...t.s) : theme(t.id, t.name, ...KR_WEEK[t.id]!)));
    },
    sectorDetail: async (market: "KR" | "US", kind: ThemeKind, id: string) => {
      count(`sectorDetail:${market}:${kind}`);
      if (market === "KR" && kind === "theme") {
        const t = KR_THEMES.find((x) => x.id === id);
        return t ? { theme: theme(t.id, t.name, ...t.s), description: null, items: t.members.map((c) => stock(c, KR_RATE[c] ?? 0, 1e10)) } : null;
      }
      const list = market === "KR" ? KR_SECTORS : US_SECTORS;
      const t = list.find((x) => x.id === id);
      return t ? { theme: t, description: null, items: [stock("A", 1, 3e9), stock("B", -1, 2e9)] } : null;
    },
    usQuotes: async (codes: string[]) => {
      count("usQuotes");
      const out = new Map<string, UsQuote>();
      for (const c of codes) {
        const sym = c.replace(/\.[A-Z]$/, "");
        if (US_RATE[sym] !== undefined) out.set(c, usQuote(sym));
      }
      return out;
    },
    krQuotes: async (codes: string[]) => {
      count("krQuotes");
      return new Map(codes.filter((c) => /^\d{6}$/.test(c)).map((c) => [c, krQuote(c, o.krDay)]));
    },
  };
  return { naver: naver as unknown as NaverDiscover, calls };
}

const fakeTics = {
  ranking: async (_n: string, duration: string) =>
    duration === "1w" ? US_THEMES.map((t, i) => ({ id: t.id, name: t.name, rate: i - 3, stockCount: t.members.length, leader: null })) : [],
  periodRate: async () => null,
} as unknown as TossTics;
const fakeBook = (building = false) => ({ get: async () => (building ? Promise.reject(new (await import("../src/services/usThemes.js")).UsThemesBuildingError()) : BOOK), summary: async () => null }) as unknown as UsThemeBook;

const TICS: Record<string, Array<{ id: string; title: string }>> = {
  NVDA: [{ id: "179", title: "반도체팹리스" }, { id: "823", title: "인공지능" }, { id: "209", title: "컴퓨터와 주변기기" }],
  RGTI: [{ id: "956", title: "양자컴퓨터" }, { id: "89", title: "IT솔루션구축" }],
  IONQ: [{ id: "956", title: "양자컴퓨터" }, { id: "389", title: "소프트웨어" }],
  AAPL: [{ id: "203", title: "스마트폰제조" }, { id: "209", title: "컴퓨터와 주변기기" }],
  MSFT: [{ id: "475", title: "클라우드" }, { id: "389", title: "소프트웨어" }, { id: "359", title: "인터넷" }, { id: "823", title: "인공지능" }],
  META: [{ id: "359", title: "인터넷" }],
  AVGO: [{ id: "179", title: "반도체팹리스" }, { id: "389", title: "소프트웨어" }],
  PLTR: [{ id: "389", title: "소프트웨어" }],
  TSLA: [{ id: "295", title: "전기차" }, { id: "291", title: "자동차브랜드" }],
  AMZN: [{ id: "359", title: "인터넷" }, { id: "475", title: "클라우드" }],
  SOFI: [{ id: "97", title: "금융" }],
  QQQ: [{ id: "87", title: "IT" }],
  SOXL: [{ id: "169", title: "반도체" }],
  RGTX: [{ id: "87", title: "IT" }],
};
const US_IND: Record<string, string | null> = { SOFI: "55101030", NVDA: "57101010", AVGO: "57101010", RGTI: "57101010" };
const KR_IND: Record<string, string> = { "005930": "278", "000660": "278", "123456": "299" };

function fakeSources(o: { fail?: boolean } = {}) {
  const calls = { usTics: 0, usIndustry: 0, krIndustry: 0 };
  const sources: MapSources = {
    usTics: async (code) => {
      calls.usTics++;
      if (o.fail) throw new Error("토스 실패");
      return TICS[code] ?? [];
    },
    usIndustry: async (code) => {
      calls.usIndustry++;
      if (o.fail) throw new Error("네이버 실패");
      return { reuters: rc(code), industry: US_IND[code] ?? null };
    },
    krIndustry: async (code) => {
      calls.krIndustry++;
      if (o.fail) throw new Error("네이버 실패");
      return KR_IND[code] ?? null;
    },
  };
  return { sources, calls };
}

/** 예시 17종목 (미국 14 + 한국 3) — 원화 평가금액 */
const HELD: HeldPosition[] = [
  ...["SOXL", "RGTX", "NVDA", "AAPL", "MSFT", "META", "AVGO", "TSLA", "PLTR", "IONQ", "SOFI", "QQQ", "RGTI", "AMZN"].map((code, i) => ({ code, name: code, value: 10_000_000 - i * 100_000 })),
  { code: "005930", name: "삼성전자", value: 5_000_000 },
  { code: "000660", name: "SK하이닉스", value: 4_000_000 },
  { code: "123456", name: "작은회사", value: 100_000 },
];

async function world(o: { flag?: boolean; bookBuilding?: boolean; noIndex?: boolean; krDay?: string; now?: string; tvDays?: number; fail?: boolean; held?: HeldPosition[] } = {}) {
  const flags = { holdingThemes: o.flag ?? true };
  const features = { enabled: vi.fn(async (k: string) => (flags as Record<string, boolean>)[k] ?? false) };
  const { naver, calls } = fakeNaver({ ...(o.krDay ? { krDay: o.krDay } : {}) });
  const { store, m } = memStore();
  const now = () => new Date(o.now ?? NOW);
  const discover = new DiscoverService({
    naver,
    calendar: calendarOf(state("KR", true), state("US", false, US_CLOSE)),
    now,
    usThemes: fakeBook(o.bookBuilding),
    tics: fakeTics,
    store,
    bookWaitMs: 50,
    staleWaitMs: 50,
  });
  // 한국 테마 표 (이미 만든 것)
  if (!o.noIndex) {
    const members: Record<string, string[]> = {};
    for (const t of KR_THEMES) for (const c of t.members) (members[c] ??= []).push(t.id);
    m.set(KR_INDEX_KEY, JSON.stringify({ v: 1, builtAt: Date.parse("2026-09-27T05:40:00+09:00"), themes: Object.fromEntries(KR_THEMES.map((t) => [t.id, t.name])), members }));
  }
  // 거래대금 기록 (한국 테마 543: 하루 1e10 × 3종목의 절반 → 오늘은 평소의 200%)
  const n = o.tvDays ?? 6;
  if (n) {
    const days = Array.from({ length: n }, (_, i) => ({ day: `2026-09-${String(15 + i).padStart(2, "0")}`, tv: { "theme:543": 1.5e10, "sector:278": 2.5e9 } }));
    m.set(tvKey("KR"), JSON.stringify({ v: 1, days }));
    m.set(tvKey("US"), JSON.stringify({ v: 1, days: days.map((d) => ({ day: d.day, tv: { "theme:956": 4e6 } })) }));
  }
  const src = fakeSources({ ...(o.fail ? { fail: true } : {}) });
  const underlying = vi.fn(async (code: string, name: string) => underlyingOfKind(productKindOf(code, name, null, null)));
  const holdings = vi.fn(async () => o.held ?? HELD);
  const krIndex = new KrThemeIndex({ naver, store, now, pauseMs: 0, sleep: async () => undefined });
  const svc = new HoldingThemesService({
    features,
    discover,
    naver,
    krIndex,
    maps: new HoldingThemeMaps({ sources: src.sources, store, now }),
    tv: new ThemeTvHistory({ store }),
    holdings,
    underlying,
    disclaimer: "투자 판단의 책임은 본인에게 있으며, 본 서비스는 투자 권유가 아닙니다.",
    now,
    mapWaitMs: 1_000,
    listWaitMs: 2_000,
    staleWaitMs: 50,
  });
  return { svc, discover, naver, calls, store, m, flags, features, src, holdings, underlying, krIndex };
}

describe("플래그", () => {
  it("서버 기본 켬 (FEATURES) — 앱 fallback 은 꺼짐", () => {
    expect(FEATURES.holdingThemes.default).toBe(true);
    expect(themeWordingProblems(FEATURES.holdingThemes.description)).toEqual([]);
  });
});

describe("내 종목 테마 응답 (서비스)", () => {
  it("예시 17종목: 16종목 연결(QQQ 는 지수 전체 상품), 까닭과 함께 연결 못 한 종목", async () => {
    const { svc } = await world();
    const r = await svc.forHoldings(HELD);
    expect(r.coverage.held).toBe(17);
    expect(r.coverage.mapped).toBe(16);
    expect(r.coverage.mapped / r.coverage.held).toBeGreaterThanOrEqual(0.8);
    expect(r.coverage.unmapped).toEqual([{ code: "QQQ", name: "QQQ", market: "US", reason: "index", text: "QQQ · 나스닥100 지수 전체를 따르는 상품이라 테마로 묶지 않았습니다" }]);
  });

  it("발견 탭과 등락률·오른/내린/보합 수가 100% 같다 (오늘·1주, 한·미, 테마·업종)", async () => {
    const { svc, discover } = await world();
    const r = await svc.forHoldings(HELD);
    expect(r.groups.length).toBeGreaterThan(10);
    for (const g of r.groups) {
      const day = (await discover.themes(g.market, g.kind, "day")).themes.find((t) => t.id === g.id)!;
      expect(g.inDiscoverList, g.key).toBe(true);
      expect(g.day, g.key).toEqual({ changeRate: day.changeRate, up: day.up, flat: day.flat, down: day.down });
      const week = (await discover.themes(g.market, g.kind, "week")).themes.find((t) => t.id === g.id)!;
      expect(g.week!.changeRate, g.key).toBe(week.changeRate);
      // 미국 테마 1주는 오른·내린 수가 없다 (발견 탭과 같음)
      if (g.market === "US" && g.kind === "theme") expect(g.week).toMatchObject({ up: null, flat: null, down: null });
      else expect(g.week).toMatchObject({ up: week.up, flat: week.flat, down: week.down });
    }
  });

  it("묶음마다 든 내 종목과 정규장 등락률, 레버리지는 기초 종목 테마에 표시와 함께 (RGTI · RGTX 둘 다)", async () => {
    const { svc } = await world();
    const r = await svc.forHoldings(HELD);
    const q = r.groups.find((g) => g.key === "US:theme:956")!;
    expect(q.name).toBe("양자컴퓨터");
    expect(q.holdings.map((h) => [h.code, h.changeRate, h.inCalc])).toEqual([
      ["RGTX", 12.4, true],
      ["IONQ", 6, true],
      ["RGTI", 6.2, true],
    ]);
    expect(q.holdings[0]!.via).toEqual({ code: "RGTI", name: "리게티 컴퓨팅", L: 2, inverse: false, index: null });
    const semi = r.groups.find((g) => g.key === "US:sector:57101010")!;
    expect(semi.holdings.map((h) => h.code)).toEqual(["SOXL"]);
    expect(semi.holdings[0]!.via).toMatchObject({ name: "반도체 지수", L: 3 });
    const kr = r.groups.find((g) => g.key === "KR:theme:543")!;
    expect(kr.holdings.map((h) => [h.code, h.changeRate])).toEqual([
      ["005930", -5],
      ["000660", -4.2],
    ]);
    expect(kr.holdings[0]!.inCalc).toBeNull();
  });

  it("많이 속한 테마: 종목 수 → 평가금액 순 최대 3개", async () => {
    const { svc } = await world();
    const r = await svc.forHoldings(HELD);
    expect(r.mostHeld.map((x) => [x.name, x.count])).toEqual([
      ["소프트웨어", 4], // MSFT·AVGO·PLTR·IONQ
      ["양자컴퓨터", 3], // RGTX·IONQ·RGTI (평가금액 합이 인터넷과 같아 이름순)
      ["인터넷", 3], // MSFT·META·AMZN
    ]);
    expect(r.byHolding[0]).toMatchObject({ code: "SOXL", keys: ["US:sector:57101010"] });
  });

  it("거래대금 평소: 한국 장중은 '지금까지' (partial), 미국은 마감 뒤 그날(뉴욕 날짜) 확정(final)·다음 날이면 날짜를 붙인 직전 거래일(lastDay), 기록 5일 미만은 모으는 중", async () => {
    const { svc } = await world();
    const r = await svc.forHoldings(HELD);
    const hbm = r.groups.find((g) => g.key === "KR:theme:543")!;
    expect(hbm.tradingValue).toMatchObject({ today: 3e10, avg: 1.5e10, days: 6, ratioPct: 200, state: "partial", day: "2026-09-29", currency: "KRW" });
    const q = r.groups.find((g) => g.key === "US:theme:956")!;
    // 계산 30종목(여기서는 4종목) 거래대금 합 = 4 × 200만 달러, 평소 400만 → 200%
    expect(q.tradingValue).toMatchObject({ today: 8e6, days: 6, ratioPct: 200, day: "2026-09-28", currency: "USD" });
    expect(nyDate(new Date(NOW))).toBe("2026-09-28"); // 뉴욕은 아직 9/28 22:00 — 그날 값이 확정
    expect(q.tradingValue.state).toBe("final");
    const sw = r.groups.find((g) => g.key === "US:theme:389")!;
    expect(sw.tradingValue.state).toBe("collecting"); // 소프트웨어는 기록이 없음
    expect(sw.tradingValue.ratioPct).toBeNull();
    // 한국 15:00 = 뉴욕 9/29 02:00 → 미국 값은 9/28 거래일 값 (날짜를 붙임)
    const later = await (await world({ now: "2026-09-29T15:00:00+09:00" })).svc.forHoldings(HELD);
    expect(later.groups.find((g) => g.key === "US:theme:956")!.tradingValue).toMatchObject({ state: "lastDay", day: "2026-09-28", ratioPct: 200 });
    // 한국 장 시작 전(08:30): 출처가 값을 비우므로 마지막으로 적은 거래일 값과 그 전 평소
    const pre = await (await world({ now: "2026-09-29T08:30:00+09:00" })).svc.forHoldings(HELD);
    expect(pre.markets.KR!.session).toBe("pre");
    expect(pre.groups.find((g) => g.key === "KR:theme:543")!.tradingValue).toMatchObject({ state: "lastDay", day: "2026-09-20", today: 1.5e10, days: 5, ratioPct: 100 });
    const few = await (await world({ tvDays: 3 })).svc.forHoldings(HELD);
    expect(few.groups.find((g) => g.key === "KR:theme:543")!.tradingValue).toMatchObject({ state: "collecting", days: 3, ratioPct: null });
  });

  it("시장 정보: 한국 정규장 · 미국 마감, 기준 줄·한국 테마 구성 시각, 고지 문구", async () => {
    const { svc } = await world();
    const r = await svc.forHoldings(HELD);
    expect(r.markets.KR).toMatchObject({ session: "regular", marketOpen: true, preparing: false, tvDay: "2026-09-29" });
    expect(r.markets.US).toMatchObject({ session: "closed", marketOpen: false, preparing: false, tvDay: "2026-09-28" });
    expect(r.markets.US!.weekNote).toContain("1주는 상승·하락 종목 수 없이 등락률만");
    expect(r.krIndexAt).toBe("9월 27일 (일) 05:40");
    expect(r.basis.at(-1)).toContain("9월 27일 (일) 05:40");
    expect(r.disclaimer).toContain("투자 권유가 아닙니다");
    for (const t of [...r.basis, ...r.coverage.unmapped.map((u) => u.text), r.markets.KR!.note ?? "", r.markets.US!.note ?? ""]) expect(themeWordingProblems(t), t).toEqual([]);
  });

  it("미국 테마북을 처음 만드는 중: 토스 분류가 있는 미국 종목은 '준비 중'(테마북에 들지 알 수 없음), 지수 상품 표 묶음(SOXL)은 그대로", async () => {
    const { svc } = await world({ bookBuilding: true });
    const r = await svc.forHoldings(HELD);
    expect(r.markets.US!.preparing).toBe(true);
    expect(r.groups.filter((g) => g.market === "US").map((g) => g.key)).toEqual(["US:sector:57101010"]);
    expect(r.coverage.unmapped.filter((u) => u.reason === "preparing").map((u) => u.code)).toEqual(expect.arrayContaining(["NVDA", "SOFI"]));
    expect(r.markets.US!.note).toContain("처음 준비하는 중");
  });

  it("한국 테마 표가 없으면: 한국 종목은 '준비 중', 표를 뒤에서 만든다 (요청 사이 쉼)", async () => {
    const { svc, krIndex, calls } = await world({ noIndex: true });
    const r = await svc.forHoldings(HELD);
    expect(r.markets.KR!.preparing).toBe(true);
    expect(r.coverage.unmapped.find((u) => u.code === "005930")).toMatchObject({ reason: "preparing", text: "삼성전자 · 한국 테마 목록을 처음 준비하는 중입니다 (약 2분)" });
    await vi.waitFor(() => expect(krIndex.status().themes).toBe(3));
    expect(calls["sectorDetail:KR:theme"]).toBe(3);
  });

  it("분류 출처가 모두 실패하면 '받지 못함' (옛 값 없음), 다음 요청은 5분 동안 다시 부르지 않는다", async () => {
    const { svc, src } = await world({ fail: true });
    const r = await svc.forHoldings(HELD);
    expect(r.coverage.unmapped.find((u) => u.code === "NVDA")).toMatchObject({ reason: "failed" });
    const before = src.calls.usTics;
    await svc.forHoldings(HELD.slice(0, 3));
    expect(src.calls.usTics).toBe(before);
  });

  it("분류는 7일 캐시 (meta 한 키) — 두 번째 서비스는 출처를 부르지 않는다", async () => {
    const a = await world();
    await a.svc.forHoldings(HELD);
    const saved = JSON.parse(a.m.get(MAPS_KEY)!) as { items: Record<string, { tics: unknown }> };
    expect(Object.keys(saved.items)).toEqual(expect.arrayContaining(["NVDA", "RGTI", "005930"]));
    const maps = new HoldingThemeMaps({ sources: fakeSources().sources, store: a.store, now: () => new Date(NOW) });
    const src2 = fakeSources();
    const maps2 = new HoldingThemeMaps({ sources: src2.sources, store: a.store, now: () => new Date(NOW) });
    const got = await maps2.lookup(["NVDA", "005930"]);
    expect(got.get("NVDA")!.item!.tics!.map((t) => t.id)).toEqual(["179", "823", "209"]);
    expect(src2.calls.usTics + src2.calls.krIndustry).toBe(0);
    expect(maps).toBeTruthy();
  });

  it("보유 0 이면 빈 응답 (묶음 없음)", async () => {
    const { svc } = await world();
    const r = await svc.forHoldings([]);
    expect(r).toMatchObject({ coverage: { held: 0, mapped: 0, unmapped: [] }, groups: [], mostHeld: [] });
  });
});

describe("계좌 브리핑 저장본", () => {
  it("시장마다 등락률 높은·낮은 3개(나누지 않으면 높은 순 5개 + 나머지 수), 많이 속한 테마 이름·수", async () => {
    const { svc } = await world();
    const snap = toSnapshot(await svc.forHoldings(HELD));
    expect(snap.coverage).toEqual({ held: 17, mapped: 16 });
    expect(snap.mostHeld[0]).toEqual({ name: "소프트웨어", count: 4 });
    expect(snap.markets.US!.split).toBe(true);
    expect(snap.markets.US!.top.map((x) => x.changeRate)).toEqual([...snap.markets.US!.top.map((x) => x.changeRate)].sort((a, b) => b - a));
    expect(snap.markets.US!.basisDay).toBe("2026-09-28");
    // 한국은 묶음 3개(HBM·반도체 대표주·작은회사의 업종 기계) → 나누지 않음. 삼성전자·SK하이닉스는 테마가 있어 업종으로 묶지 않는다
    expect(snap.markets.KR).toMatchObject({ split: false, bottom: [], more: 0 });
    expect(snap.markets.KR!.top.map((x) => x.name)).toEqual(["기계", "반도체 대표주", "HBM(고대역폭메모리)"]);
  });

  it("제한 시간(8초)을 넘으면 null (칸 없이)", async () => {
    const { svc } = await world();
    (svc as unknown as { build: () => Promise<never> }).build = () => new Promise(() => undefined);
    expect(await svc.snapshot(HELD, 30)).toBeNull();
  });
});

describe("계좌 브리핑 서비스와 연결", () => {
  let db: Db;
  afterEach(async () => {
    await db?.destroy();
  });
  const noModel: TextGenerator = { model: "disabled", generate: async () => Promise.reject(new Error("부르면 안 됨")) };
  const holding = (code: string, name: string, price: number, qty: number): AccountHolding => ({
    code,
    name,
    quantity: qty,
    avgPrice: price,
    quote: { currency: "KRW", price, change: 0, changeRate: 0 },
    evaluation: { marketValue: price * qty, costBasis: price * qty, profit: 0, profitRate: 0, costRate: null, afterCost: null, costBasisKrw: null, krwCostSource: null },
  });
  const setup = async (on: boolean) => {
    db = await createMigratedDb(":memory:");
    const snapshot = vi.fn(async (held: Array<{ code: string; name: string; value: number | null }>) => ({ asOf: NOW, coverage: { held: held.length, mapped: 1 }, mostHeld: [{ name: "HBM(고대역폭메모리)", count: 2 }], markets: {} }));
    const svc = new AccountBriefingService({
      db,
      stocks: { listWithFreshQuotes: async () => [holding("005930", "삼성전자", 80_000, 10), holding("000660", "SK하이닉스", 200_000, 5)] },
      indices: null,
      calendar: null,
      generator: noModel,
      prompts: {} as PromptStore,
      features: { enabled: async (k: string) => ({ accountBriefing: true, holdingThemes: on })[k] ?? false },
      holdingThemes: { snapshot },
      now: () => new Date("2026-09-29T08:38:00+09:00"),
    });
    return { svc, snapshot };
  };

  it("켜져 있으면 만들 때 data.holdingThemes 저장 (보유 종목·원화 평가를 넘김)", async () => {
    const { svc, snapshot } = await setup(true);
    const b = await svc.generate("morning", { date: "2026-09-29" });
    const full = await svc.get(b!.id);
    expect(full.data!.holdingThemes).toMatchObject({ coverage: { held: 2, mapped: 1 }, mostHeld: [{ name: "HBM(고대역폭메모리)", count: 2 }] });
    expect(snapshot).toHaveBeenCalledWith([
      { code: "005930", name: "삼성전자", value: 800_000 },
      { code: "000660", name: "SK하이닉스", value: 1_000_000 },
    ]);
  });

  it("꺼져 있으면 부르지도 저장하지도 않는다", async () => {
    const { svc, snapshot } = await setup(false);
    const b = await svc.generate("morning", { date: "2026-09-29" });
    expect((await svc.get(b!.id)).data).not.toHaveProperty("holdingThemes");
    expect(snapshot).not.toHaveBeenCalled();
  });
});

describe("예약 작업: 거래대금 기록 · 한국 테마 표", () => {
  it("한국 20:10: 그날이 거래일이면 테마마다 KRX 거래대금 합 + 보유 종목이 든 업종", async () => {
    const { svc, m } = await world({ now: "2026-09-29T20:10:00+09:00" });
    const r = await svc.recordTv("KR");
    expect(r).toMatchObject({ day: "2026-09-29", skipped: null });
    const saved = JSON.parse(m.get(tvKey("KR"))!) as { days: Array<{ day: string; tv: Record<string, number> }> };
    const today = saved.days.find((d) => d.day === "2026-09-29")!;
    expect(today.tv).toMatchObject({ "theme:543": 3e10, "theme:12": 2e10, "theme:700": 2e10, "sector:299": 5e9 });
  });

  it("한국 휴장(추석 9/24): 시세 날짜가 오늘이 아니면 적지 않는다 (0 을 넣지 않음)", async () => {
    const { svc, m } = await world({ now: "2026-09-24T20:10:00+09:00", krDay: "2026-09-23" });
    const before = m.get(tvKey("KR"));
    expect(await svc.recordTv("KR")).toMatchObject({ recorded: 0, skipped: "오늘 거래일 아님" });
    expect(m.get(tvKey("KR"))).toBe(before);
  });

  it("미국 16:15 뉴욕: 그날 정규장 값이면 테마마다 합 (서머타임 전후 모두 뉴욕 날짜로)", async () => {
    // 9/28(월) 16:15 EDT = 9/29 05:15 KST
    const { svc, m } = await world({ now: "2026-09-29T05:15:00+09:00" });
    const r = await svc.recordTv("US");
    expect(r).toMatchObject({ day: "2026-09-28", skipped: null });
    const saved = JSON.parse(m.get(tvKey("US"))!) as { days: Array<{ day: string; tv: Record<string, number> }> };
    expect(saved.days.find((d) => d.day === "2026-09-28")!.tv["theme:956"]).toBe(8e6);
    expect(nyDate(new Date("2026-11-02T21:15:00Z"))).toBe("2026-11-02"); // 서머타임 끝난 뒤 16:15 EST
    expect(nyDate(new Date("2026-10-30T20:15:00Z"))).toBe("2026-10-30");
  });

  it("한국 테마 표: 테마 수가 이전의 80% 미만이면 옛 표 유지, 두 번 이어 비슷하면 받아들임, 구성 실패 10% 넘으면 유지", async () => {
    const { store } = memStore();
    let n = 20;
    let failFrom = 99;
    const sleep = vi.fn(async () => undefined);
    const naver = {
      sectors: async () => Array.from({ length: n }, (_, i) => theme(String(i), `테마${i}`, 0, 0, 0, 0)),
      sectorDetail: async (_m: string, _k: string, id: string) => {
        if (Number(id) >= failFrom) throw new Error("실패");
        return { theme: theme(id, id, 0, 0, 0, 0), description: null, items: [stock(`00000${Number(id) % 10}`, 0, 1)] };
      },
    } as unknown as NaverDiscover;
    const idx = new KrThemeIndex({ naver, store, now: () => new Date(NOW), pauseMs: 250, sleep });
    expect((await idx.build()).themes).toHaveProperty("19");
    expect(sleep).toHaveBeenCalledTimes(20);
    expect(sleep).toHaveBeenCalledWith(250);
    n = 10;
    await expect(idx.build()).rejects.toThrow("너무 작습니다");
    expect(Object.keys((await idx.get())!.themes)).toHaveLength(20);
    await expect(idx.build()).resolves.toMatchObject({ v: 1 }); // 두 번 이어 10개 → 받아들임
    expect(Object.keys((await idx.get())!.themes)).toHaveLength(10);
    n = 10;
    failFrom = 8; // 10개 중 2개 실패 (20%)
    await expect(idx.build()).rejects.toThrow("실패가 많습니다");
    expect(Object.keys((await idx.get())!.themes)).toHaveLength(10);
  });
});

describe("새 출처 (가짜 fetch)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("토스 회사 테마: 상품 코드 → 회사 코드 → 주요 사업·그 외 사업 (로그인·쿠키 없는 요청)", async () => {
    const { TossCompanyTics } = await import("../src/providers/market/tossCompanyTics.js");
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const f = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      if (url.endsWith("/v2/stock-infos/US20100629001")) return json({ result: { code: "US20100629001", symbol: "TSLA", companyCode: "NAS006XY7-E0" } });
      if (url.endsWith("/v2/companies/NAS006XY7-E0/tics")) return json({ result: { majorList: [{ id: 295, title: "전기차" }], minorList: [{ id: 383, title: "ESS" }] } });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const r = await new TossCompanyTics(f, 0).forProduct("US20100629001");
    expect(r).toEqual({ companyCode: "NAS006XY7-E0", major: [{ id: "295", title: "전기차" }], minor: [{ id: "383", title: "ESS" }] });
    expect(seen.every((s) => !("cookie" in s.headers) && !("authorization" in s.headers))).toBe(true);
    expect(await new TossCompanyTics(f, 0).forProduct("US0000")).toEqual({ companyCode: null, major: [], minor: [] });
  });

  it("네이버 업종 번호: 미국 basic industryCodeType.code (자동완성 로이터 코드 먼저), 한국 integration industryCode", async () => {
    const { NaverIndustry } = await import("../src/providers/market/naverIndustry.js");
    const f = (async (url: string) => {
      if (url.includes("/stock/SOFI.O/basic")) return json({ stockName: "소파이 테크놀로지스", reutersCode: "SOFI.O", industryCodeType: { code: "55101030", name: "INDUSTRY55101030" } });
      if (url.includes("/stock/SOXL.K/basic")) return json({ stockName: "SOXL", reutersCode: "SOXL.K", industryCodeType: null });
      if (url.includes("/api/stock/005930/integration")) return json({ stockName: "삼성전자", industryCode: "278", totalInfos: [] });
      return json({}, 409);
    }) as unknown as typeof fetch;
    const ind = new NaverIndustry(f, async (c) => (c === "SOXL" ? "SOXL.K" : null));
    expect(await ind.us("SOFI")).toEqual({ reuters: "SOFI.O", industry: "55101030" });
    expect(await ind.us("SOXL")).toEqual({ reuters: "SOXL.K", industry: null });
    expect(await ind.us("NONE")).toBeNull();
    expect(await ind.kr("005930")).toBe("278");
    expect(await ind.kr("999999")).toBeNull();
  });

  it("네이버 한국 시세 폴링의 KRX 거래대금 (accumulatedTradingValueRaw)", async () => {
    const { NaverDiscover: ND } = await import("../src/providers/market/naverDiscover.js");
    const f = (async () =>
      json({ datas: [{ itemCode: "096770", stockName: "SK이노베이션", closePriceRaw: "100000", fluctuationsRatioRaw: "1.2", compareToPreviousClosePriceRaw: "1200", localTradedAt: "2026-09-28T20:00:00+09:00", marketStatus: "CLOSE", accumulatedTradingValueRaw: "180507000000", stockExchangeType: { code: "KS" } }] })) as unknown as typeof fetch;
    expect((await new ND(f).krQuotes(["096770"])).get("096770")).toMatchObject({ tradingValue: 180_507_000_000, changeRate: 1.2 });
  });
});

describe("플래그 끔: 요청·계산·저장 0건", () => {
  it("경로 404 · 예약 작업이 돌아도 출처 호출 0 · 저장 0", async () => {
    const { svc, calls, src, m, holdings } = await world({ flag: false });
    const app = Fastify();
    await app.register(holdingThemeRoutes, { prefix: "/api/holdings", service: svc });
    await app.register(holdingThemeAdminRoutes, { prefix: "/api/admin/holding-themes", service: svc });
    const res = await app.inject({ method: "GET", url: "/api/holdings/themes" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "DISABLED", message: "내 종목 테마 기능이 꺼져 있습니다" });
    expect((await app.inject({ method: "POST", url: "/api/admin/holding-themes/rebuild" })).statusCode).toBe(404);
    const before = new Map(m);
    expect(await svc.recordTv("KR")).toMatchObject({ recorded: 0, skipped: "꺼짐" });
    expect(await svc.recordTv("US")).toMatchObject({ recorded: 0, skipped: "꺼짐" });
    expect(await svc.rebuildKrIndex()).toBeNull();
    await svc.warm();
    expect(Object.keys(calls)).toEqual([]);
    expect(src.calls).toEqual({ usTics: 0, usIndustry: 0, krIndustry: 0 });
    expect(holdings).not.toHaveBeenCalled();
    expect([...m]).toEqual([...before]);
    await app.close();
  });

  it("켜면 경로 200 (보유 목록은 서비스가 받는다)", async () => {
    const { svc } = await world();
    const app = Fastify();
    await app.register(holdingThemeRoutes, { prefix: "/api/holdings", service: svc });
    const res = await app.inject({ method: "GET", url: "/api/holdings/themes" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HoldingThemesResponse;
    expect(body.enabled).toBe(true);
    expect(body.coverage.held).toBe(17);
    await app.close();
  });

  it("/health: 출처가 있고 켜져 있을 때만 holdingThemes 칸, 끄면 예전과 같다", async () => {
    const db = await createMigratedDb(":memory:");
    const { naver } = fakeNaver();
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ discover: naver, holdingThemes: fakeSources().sources }), logger: false, enableScheduler: false });
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ holdingThemes: { krIndexAt: null, krThemes: 0 } });
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { holdingThemes: false } });
      expect((await app.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty("holdingThemes");
      expect((await app.inject({ method: "GET", url: "/api/holdings/themes" })).statusCode).toBe(404);
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  it("출처가 없으면(테스트 기본 fakeProviders) 경로가 없고 /health 도 예전과 같다", async () => {
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(), logger: false, enableScheduler: false });
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty("holdingThemes");
      expect((await app.inject({ method: "GET", url: "/api/holdings/themes" })).json()).toMatchObject({ error: "NOT_FOUND" });
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});
