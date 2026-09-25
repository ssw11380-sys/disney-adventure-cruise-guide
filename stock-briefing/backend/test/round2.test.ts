import { describe, expect, it } from "vitest";
import { EdgarProvider } from "../src/providers/dart/edgar.js";
import { fallbackState, MarketCalendar, stateFromSession } from "../src/providers/market/calendar.js";
import { ProviderError } from "../src/lib/errors.js";
import { NaverFundamentals } from "../src/providers/market/fundamentals.js";
import { NewsProviderChain } from "../src/providers/news/chain.js";
import { NaverStockNewsProvider } from "../src/providers/news/naverStock.js";
import type { NewsProvider } from "../src/providers/news/types.js";
import { FakeNewsProvider } from "./helpers.js";

describe("MarketCalendar", () => {
  it("추석 연휴: tradingEnd 가 오늘(9/23)이면 거래일, 다음 시작이 9/28 이면 9/24~25 는 휴장", () => {
    const end = "2026-09-23T11:00:00Z"; // 9/23 20:00 KST
    const next = "2026-09-27T23:00:00Z"; // 9/28 08:00 KST
    const inSession = stateFromSession("KR", new Date("2026-09-23T01:00:00Z"), end, next); // 9/23 10:00 KST
    expect(inSession).toMatchObject({ isTradingDay: true, isOpen: true, closesAt: "2026-09-23T11:00:00.000Z" });
    const afterClose = stateFromSession("KR", new Date("2026-09-23T13:00:00Z"), end, next);
    expect(afterClose).toMatchObject({ isTradingDay: true, isOpen: false });
    const holiday = stateFromSession("KR", new Date("2026-09-24T01:00:00Z"), end, next); // 9/24 10:00 KST
    expect(holiday).toMatchObject({ isTradingDay: false, isOpen: false, opensAt: "2026-09-27T23:00:00.000Z" });
    const monday = stateFromSession("KR", new Date("2026-09-27T22:00:00Z"), end, next); // 9/28 07:00 KST (개장 전)
    expect(monday).toMatchObject({ isTradingDay: true, isOpen: false });
  });

  it("미국은 뉴욕 날짜 기준", () => {
    const s = stateFromSession("US", new Date("2026-09-23T14:00:00Z"), "2026-09-23T20:00:00Z", "2026-09-24T13:30:00Z");
    expect(s).toMatchObject({ isTradingDay: true, isOpen: true });
  });

  it("API 실패 시 요일 기반 대체", async () => {
    const cal = new MarketCalendar(async () => new Response("x", { status: 500 }), () => new Date("2026-09-26T03:00:00Z")); // 토요일
    const s = await cal.status();
    expect(s.KR).toMatchObject({ isTradingDay: false, source: "fallback" });
    expect(fallbackState("KR", new Date("2026-09-23T01:00:00Z"))).toMatchObject({ isTradingDay: true, isOpen: true });
  });

  it("토스 응답으로 종목별 거래일을 판단하고 5분 캐시", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          result: [
            { productCode: "A005930", tradingEnd: "2026-09-23T11:00:00Z", nextTradingStart: "2026-09-27T23:00:00Z" },
            { productCode: "US19801212001", tradingEnd: "2026-09-23T20:00:00Z", nextTradingStart: "2026-09-24T13:30:00Z" },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const cal = new MarketCalendar(fetchFn, () => new Date("2026-09-24T01:00:00Z")); // 9/24 10:00 KST (추석)
    expect(await cal.isTradingDay("005930")).toBe(false);
    expect(await cal.isTradingDay("AAPL")).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("EdgarProvider", () => {
  const TICKERS = { "0": { cik_str: 1318605, ticker: "TSLA", title: "Tesla, Inc." }, "1": { cik_str: 1809279, ticker: "IONQ", title: "IonQ, Inc." } };
  const FACTS = {
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: [
          { fy: 2024, fp: "FY", form: "10-K", start: "2024-01-01", end: "2024-12-31", val: 97690000000 },
          { fy: 2024, fp: "Q4", form: "10-K", start: "2024-10-01", end: "2024-12-31", val: 25707000000 },
          { fy: 2025, fp: "FY", form: "10-K", start: "2025-01-01", end: "2025-12-31", val: 100000000000 },
        ] } },
        NetIncomeLoss: { units: { USD: [
          { fy: 2024, fp: "FY", form: "10-K", start: "2024-01-01", end: "2024-12-31", val: 7091000000 },
          { fy: 2025, fp: "FY", form: "10-K", start: "2025-01-01", end: "2025-12-31", val: 5000000000 },
        ] } },
        Assets: { units: { USD: [
          { fy: 2024, fp: "FY", form: "10-K", end: "2024-12-31", val: 122070000000 },
          { fy: 2025, fp: "FY", form: "10-K", end: "2025-12-31", val: 130000000000 },
        ] } },
        StockholdersEquity: { units: { USD: [{ fy: 2025, fp: "FY", form: "10-K", end: "2025-12-31", val: 80000000000 }] } },
      },
    },
  };
  const SUBS = {
    name: "Tesla, Inc.",
    sicDescription: "Motor Vehicles & Passenger Car Bodies",
    fiscalYearEnd: "1231",
    website: "https://www.tesla.com",
    addresses: { business: { street1: "1 Tesla Road", city: "Austin", stateOrCountry: "TX" } },
    filings: { recent: {
      form: ["8-K", "4", "10-Q", "S-8"],
      filingDate: ["2026-09-20", "2026-09-18", "2026-07-25", "2026-06-01"],
      accessionNumber: ["0001318605-26-000100", "0001318605-26-000099", "0001318605-26-000080", "0001318605-26-000070"],
      primaryDocument: ["tsla-8k.htm", "xslF345X05/wk-form4.xml", "tsla-10q.htm", "s8.htm"],
      primaryDocDescription: ["8-K", "FORM 4", "10-Q", "S-8"],
    } },
  };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.includes("company_tickers")) return ok(TICKERS);
    if (url.includes("companyfacts/CIK0001318605")) return ok(FACTS);
    if (url.includes("submissions/CIK0001318605")) return ok(SUBS);
    return new Response("rate", { status: 403 });
  }) as typeof fetch;
  const now = () => new Date("2026-09-23T00:00:00Z");

  it("티커 → CIK, 10-K 연간 값만 골라 재무제표를 만든다", async () => {
    const e = new EdgarProvider(fetchFn, now);
    const fin = await e.getAnnualFinancials("tsla", 5);
    expect(fin).toEqual([
      { year: 2024, basis: "CFS", revenue: 97690000000, operatingIncome: null, netIncome: 7091000000, totalAssets: 122070000000, totalLiabilities: null, totalEquity: null },
      { year: 2025, basis: "CFS", revenue: 100000000000, operatingIncome: null, netIncome: 5000000000, totalAssets: 130000000000, totalLiabilities: 50000000000, totalEquity: 80000000000 },
    ]);
  });

  it("최근 공시는 주요 서식만, 기간 안의 것만, 한글 라벨과 링크", async () => {
    const e = new EdgarProvider(fetchFn, now);
    const d = await e.getDisclosures("TSLA", 30, 10);
    expect(d.map((x) => x.title)).toEqual(["수시 공시 (8-K)", "내부자 거래 (Form 4)"]);
    expect(d[0]!.url).toBe("https://www.sec.gov/Archives/edgar/data/1318605/000131860526000100/tsla-8k.htm");
    expect(d[0]!.filer).toBe("Tesla, Inc.");
    const c = await e.getCompany("TSLA");
    expect(c).toMatchObject({ name: "Tesla, Inc.", industryCode: "Motor Vehicles & Passenger Car Bodies", fiscalMonth: "12", homepage: "https://www.tesla.com" });
    await expect(e.getCompany("ZZZZ")).rejects.toThrow(/SEC/);
    await expect(e.getCompany("005930")).rejects.toThrow(/미국/);
  });
});

describe("NaverStockNewsProvider + chain", () => {
  const KR = [{ total: 2, items: [
    { officeId: "055", articleId: "0001390541", officeName: "SBS", datetime: "202609230834", title: "대기업 33% 5년 이상 흑자행진", body: "본문..." },
    { officeId: "011", articleId: "0004664795", officeName: "서울경제", datetime: "202609230700", title: "네이버서 日 맛집 예약 클릭 482%↑", body: "본문2" },
  ] }];
  const US = [{ total: 1, items: [{ officeId: "031", articleId: "0001059386", officeName: "아이뉴스24", datetime: "202609171531", title: "양자컴 관련주 급등" }] }];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/news/stock/035420")) return new Response(JSON.stringify(KR), { status: 200 });
    if (url.includes("/news/stock/IONQ.K")) return new Response(JSON.stringify(US), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  it("한국은 6자리 코드, 미국은 로이터 코드로 종목 뉴스를 받는다", async () => {
    const p = new NaverStockNewsProvider(fetchFn, { resolveReuters: async (c) => (c === "IONQ" ? "IONQ.K" : null) });
    const kr = await p.forStock({ code: "035420", name: "NAVER" }, 5);
    expect(kr[0]).toMatchObject({ title: "대기업 33% 5년 이상 흑자행진", source: "SBS", publishedAt: "2026-09-23T08:34:00+09:00", url: "https://n.news.naver.com/mnews/article/055/0001390541" });
    const us = await p.forStock({ code: "IONQ", name: "아이온큐" }, 5);
    expect(us).toHaveLength(1);
  });

  it("체인: 종목 뉴스에서 관련 기사만 남기고, 절반도 안 차면 최근 30일 이름 검색으로 채운다 (3-12)", async () => {
    const p = new NaverStockNewsProvider(fetchFn, { resolveReuters: async () => null });
    const fallback = new FakeNewsProvider();
    const chain = new NewsProviderChain([p, fallback], undefined, () => Date.parse("2026-09-24T00:00:00+09:00"));
    const items = await chain.forStock({ code: "035420", name: "NAVER" }, 8);
    // "대기업 33% 흑자행진"(네이버 언급 없음)은 빠지고 "네이버서 …" 1건 + 이름 검색 3건
    expect(items.map((x) => x.title)).toContain("네이버서 日 맛집 예약 클릭 482%↑");
    expect(items.map((x) => x.title)).not.toContain("대기업 33% 5년 이상 흑자행진");
    expect(fallback.queries).toEqual(["NAVER"]); // 검색 문법을 모르는 소스에는 이름만
    const none = await chain.forStock({ code: "ZZZZ", name: "가나다라" }, 8); // 네이버 실패 → 이름 검색
    expect(none.length).toBe(3);
    expect(fallback.queries.at(-1)).toBe("가나다라");
  });

  it("체인: 검색 문법을 아는 소스(구글)가 있으면 그걸로 최근 30일 질의, 종목별 10분 캐시 (리뷰 M3)", async () => {
    const google = Object.assign(new FakeNewsProvider(), { advancedQuery: true });
    const naverSearch = new FakeNewsProvider();
    const chain = new NewsProviderChain([naverSearch, google], undefined, () => Date.parse("2026-09-24T00:00:00+09:00"));
    await chain.forStock({ code: "RGTI", name: "리게티 컴퓨팅" }, 8);
    await chain.forStock({ code: "RGTI", name: "리게티 컴퓨팅" }, 15); // 브리핑(8건) 뒤 뉴스 탭(15건)도 같은 캐시
    expect(google.queries).toEqual(['"리게티" when:30d']);
    await chain.forStock({ code: "RGTI", name: "RGTI" }, 8); // 이름이 다르면 질의가 달라 캐시도 따로
    expect(google.queries).toHaveLength(2);
    expect(naverSearch.queries).toEqual([]);
  });

  it("미국 종목 뉴스: 클래스 주식·NYSE 종목은 시장에 맞는 로이터 코드로 찾고, 추측한 코드의 0건은 성공으로 보지 않는다 (BH-33)", async () => {
    const urls: string[] = [];
    const article = [{ total: 1, items: [{ officeId: "001", articleId: "1", officeName: "연합뉴스", datetime: "202609240900", title: "버크셔 해서웨이, 현금 보유 사상 최대", body: "버크셔 해서웨이는 …" }] }];
    let acDown = false;
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("ac.stock.naver.com")) {
        if (acDown) return new Response("busy", { status: 503 });
        return json(url.includes("q=BRKB&") ? { items: [{ code: "BRK B", reutersCode: "BRKb", nationCode: "USA" }] } : { items: [] });
      }
      if (url.includes("/news/stock/BRKb?") || url.includes("/news/stock/KO?")) return json(article);
      return json([]); // 네이버는 없는 코드에도 200 + 빈 목록을 준다
    }) as typeof fetch;
    const p = new NaverStockNewsProvider(fetchFn, new NaverFundamentals(fetchFn));
    expect(await p.forStock({ code: "BRK.B", name: "버크셔 해서웨이 B", market: "NYSE" }, 5)).toHaveLength(1);
    expect(urls.some((u) => u.includes("/news/stock/BRK.B.O"))).toBe(false);
    // 자동완성이 한 번 실패해도 NYSE 종목은 접미사 없는 코드(KO)로
    acDown = true;
    expect(await p.forStock({ code: "KO", name: "코카콜라", market: "NYSE" }, 5)).toHaveLength(1);
    // 추측한 코드가 모두 0건이면 "뉴스 없음"으로 확정하지 않고 실패로 (체인이 다음 방법을 쓰게)
    await expect(p.forStock({ code: "ZZZZ", name: "없는회사", market: "NYSE" }, 5)).rejects.toThrow(ProviderError);
  });

  it("체인: 구글 이름 검색이 두 번 실패하면 네이버 검색(키 있을 때)으로 이름만 한 번 더 (BH-74)", async () => {
    const naverStock: NewsProvider = { name: "naver-stock", search: async () => [], forStock: async () => [] };
    const naverSearch = new FakeNewsProvider();
    const google = Object.assign(new FakeNewsProvider({ fail: true }), { advancedQuery: true });
    const chain = new NewsProviderChain([naverStock, naverSearch, google], undefined, () => Date.parse("2026-09-24T00:00:00+09:00"), 0);
    const items = await chain.forStock({ code: "SOFI", name: "소파이 테크놀로지스", market: "NASDAQ" }, 8);
    expect(google.queries).toHaveLength(2);
    expect(naverSearch.queries).toEqual(["소파이"]);
    expect(items.map((x) => x.title)).toContain("소파이 뉴스 1");
    // 종목 뉴스까지 실패해도 네이버 검색 결과로 (브리핑 '뉴스'가 빠지지 않게)
    const failing: NewsProvider = { name: "naver-stock", search: async () => [], forStock: async () => { throw new ProviderError("naver-stock", "HTTP 500"); } };
    const chain2 = new NewsProviderChain([failing, naverSearch, google], undefined, () => Date.parse("2026-09-24T00:00:00+09:00"), 0);
    expect((await chain2.forStock({ code: "SOFI", name: "소파이 테크놀로지스", market: "NASDAQ" }, 8)).length).toBeGreaterThan(0);
    // 구글이 제한 시간에 끊겼으면 다시 부르지 않고 바로 네이버 검색으로 (멈춘 출처를 두 번 기다리지 않게)
    const slow = Object.assign(new FakeNewsProvider(), { advancedQuery: true });
    slow.search = async (q: string) => {
      slow.queries.push(q);
      throw new ProviderError("google-news-rss", "시간 초과", new DOMException("시간 초과 10000ms", "TimeoutError"));
    };
    const chain3 = new NewsProviderChain([naverStock, naverSearch, slow], undefined, () => Date.parse("2026-09-24T00:00:00+09:00"), 0);
    expect((await chain3.forStock({ code: "SOFI", name: "소파이 테크놀로지스", market: "NASDAQ" }, 8)).length).toBeGreaterThan(0);
    expect(slow.queries).toHaveLength(1);
  });
});
