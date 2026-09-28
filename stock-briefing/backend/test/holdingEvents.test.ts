import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreWordingProblems } from "../src/analysis/scoreWording.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createMigratedDb, type Db } from "../src/db/index.js";
import type { TextGenerator } from "../src/llm/generator.js";
import type { PromptStore } from "../src/llm/prompts.js";
import { NaverFundamentals, naverDate } from "../src/providers/market/fundamentals.js";
import { parseCalendarEarnings, parseDividendSummary, TossProvider, type TossCalendarEarning, type TossDividend } from "../src/providers/market/toss.js";
import { AccountBriefingService } from "../src/services/accountBriefingService.js";
import type { AccountEventItem, AccountHolding } from "../src/services/accountNumbers.js";
import { FEATURES } from "../src/services/featureService.js";
import {
  addDays,
  dividendItems,
  earningsItems,
  EVENTS_DAYS,
  HoldingEventsService,
  mondayOf,
  monthsBetween,
  sortEvents,
  sundayOf,
  weekItems,
  type HoldingEventSources,
} from "../src/services/holdingEvents.js";
import { fakeProviders } from "./helpers.js";

/**
 * 브리핑 3차 5 — 다가오는 일정 (플래그 holdingEvents, 실적 발표일은 holdingEarnings — 기본 꺼짐).
 *  - 출처: 토스 웹 배당 요약(앞날 배당락일) · 네이버 basic 배당락일(미국 맞춰 보기) · 토스 공개 캘린더(큰 종목 실적 발표) — 모두 로그인 없음
 *  - 녹화한 응답(2026-09-28 이 PC 에서 받은 원본을 줄인 것, test/fixtures/holdingEvents/)과 고정 시계로 본다
 *    (월 9/28 08:38 · 월 10/26 08:38 · 월 11/2 서머타임 끝난 뒤 · 월 12/28)
 */
const FX = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/holdingEvents/${name}`, import.meta.url), "utf8")) as { result: unknown } & Record<string, unknown>;
const DIV = {
  MSFT: parseDividendSummary(FX("toss_div_MSFT_US19860313001.json").result),
  O: parseDividendSummary(FX("toss_div_O_US19941018001.json").result),
  NVDA: parseDividendSummary(FX("toss_div_NVDA_US19990122001.json").result),
  "005930": parseDividendSummary(FX("toss_div_005930_A005930.json").result),
  TSLA: parseDividendSummary(FX("toss_div_TSLA_US20100629001.json").result),
} as Record<string, TossDividend[]>;
const CAL: Record<string, TossCalendarEarning[]> = {
  "2026-07": parseCalendarEarnings(FX("toss_cal_2026-07.json").result),
  "2026-10": parseCalendarEarnings(FX("toss_cal_2026-10.json").result),
  "2026-11": parseCalendarEarnings(FX("toss_cal_2026-11.json").result),
};
/** 토스 상품 코드 (녹화한 캘린더·검색 응답의 값) */
const PRODUCT: Record<string, string> = {
  MSFT: "US19860313001",
  META: "US20120518001",
  AAPL: "US19801212001",
  NVDA: "US19990122001",
  TSLA: "US20100629001",
  O: "US19941018001",
  PLTR: "US20200930014",
  MU: "US19890516001",
};
/** 네이버 basic 의 배당락일 (녹화: MSFT 2026.11.19. · O 2026.09.30. · NVDA 2026.09.10.) */
const NAVER: Record<string, string | null> = {
  MSFT: naverDate((FX("naver_basic_MSFT.O.json")["stockItemTotalInfos"] as Array<{ code: string; value: string }>).find((x) => x.code === "exDividendAt")!.value),
  O: naverDate((FX("naver_basic_O.json")["stockItemTotalInfos"] as Array<{ code: string; value: string }>).find((x) => x.code === "exDividendAt")!.value),
  NVDA: naverDate((FX("naver_basic_NVDA.O.json")["stockItemTotalInfos"] as Array<{ code: string; value: string }>).find((x) => x.code === "exDividendAt")!.value),
};

const H = (code: string, name: string) => ({ code, name });

describe("출처 파서 (녹화한 응답)", () => {
  it("토스 배당 요약: 날짜·지급일·주당 금액·통화 — 회사가 발표한 앞날 배당락일도 (MSFT 2026-11-19 $0.98 · O 2026-09-30 $0.2715)", () => {
    expect(DIV["MSFT"]!.at(-1)).toEqual({ exDate: "2026-11-19", paymentDate: "2026-12-10", cash: 0.98, currency: "USD" });
    expect(DIV["O"]!.at(-1)).toEqual({ exDate: "2026-09-30", paymentDate: "2026-10-15", cash: 0.2715, currency: "USD" });
    expect(DIV["005930"]!.at(-1)).toEqual({ exDate: "2026-06-29", paymentDate: "2026-08-28", cash: 374, currency: "KRW" });
    // 배당 기록이 없는 종목(테슬라)은 빈 배열 — 실패가 아님
    expect(DIV["TSLA"]).toEqual([]);
  });

  it("배당 요약 모양이 바뀌면 던진다 (그 종목만 '받지 못함') · 날짜가 틀린 줄은 뺀다 · 금액 0 은 금액 없음", () => {
    expect(() => parseDividendSummary({ items: [] })).toThrow(/모양/);
    expect(parseDividendSummary([{ exDate: "2026-13" }, { exDate: "2026-10-01", cash: 0, currency: "KRW" }, null].filter((x) => x !== null))).toEqual([{ exDate: "2026-10-01", paymentDate: null, cash: null, currency: "KRW" }]);
  });

  it("토스 캘린더: 실적 발표만(경제 지표·휴장일 빼고) · 상품 코드 · 한국 시각 · 시각 글", () => {
    const oct = CAL["2026-10"]!;
    expect(oct).toHaveLength(15);
    expect(oct.find((e) => e.productCode === PRODUCT["MSFT"])).toEqual({ productCode: "US19860313001", name: "마이크로소프트", date: "2026-10-29", announceAt: "2026-10-29T05:00:00", timeText: "오전 5시 이후", country: "us" });
    // 한국 큰 종목: 시각을 주지 않음(00:00) · '발표 후'
    expect(CAL["2026-07"]!.find((e) => e.productCode === "A005930")).toEqual({ productCode: "A005930", name: "삼성전자", date: "2026-07-30", announceAt: "2026-07-30T00:00:00", timeText: "발표 후", country: "kr" });
    // 서머타임 끝난 뒤(11/1~): 토스가 준 시각 그대로 06:00
    expect(CAL["2026-11"]!.find((e) => e.productCode === PRODUCT["PLTR"])).toMatchObject({ date: "2026-11-03", announceAt: "2026-11-03T06:00:00", timeText: "오전 6시 이후" });
  });

  it("캘린더 모양이 바뀌면 던진다 · 상품 코드가 없는 실적 줄은 뺀다", () => {
    expect(() => parseCalendarEarnings({ list: [] })).toThrow(/모양/);
    expect(parseCalendarEarnings({ events: [{ id: { group: "USD_EARNINGS_ANNOUNCEMENT" }, view: { title: "X 실적발표", landingOption: null }, date: "2026-10-01" }] })).toEqual([]);
  });

  it("네이버 날짜 글 → YYYY-MM-DD", () => {
    expect(NAVER).toEqual({ MSFT: "2026-11-19", O: "2026-09-30", NVDA: "2026-09-10" });
    expect(naverDate("2026.08.10")).toBe("2026-08-10");
    expect(naverDate("N/A")).toBeNull();
    expect(naverDate(null)).toBeNull();
  });

  it("TossProvider: 배당 요약은 시세 호스트 GET, 캘린더는 공개 캘린더 호스트 POST(빈 본문) — 상품 코드는 저장소 캐시", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ?? null });
      if (u.includes("/dividend/")) return new Response(JSON.stringify(FX("toss_div_MSFT_US19860313001.json")), { status: 200 });
      if (u.includes("/calendar/monthly/")) return new Response(JSON.stringify(FX("toss_cal_2026-10.json")), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const store = { get: async (k: string) => (k === "toss:product:MSFT" ? "US19860313001" : null), set: async () => undefined };
    const toss = new TossProvider(fetchFn as unknown as typeof fetch, store);
    expect((await toss.dividendSummary("MSFT")).at(-1)!.exDate).toBe("2026-11-19");
    expect((await toss.calendarMonth("2026-10")).length).toBe(15);
    expect(calls).toEqual([
      { url: "https://wts-info-api.tossinvest.com/api/v1/stock-infos/dividend/US19860313001/summary", method: "GET", body: null },
      { url: "https://wts-cert-api.tossinvest.com/api/v4/calendar/monthly/2026-10", method: "POST", body: null },
    ]);
    await expect(toss.calendarMonth("2026-1")).rejects.toThrow();
  });

  it("NaverFundamentals.exDividendAt: 미국은 basic 의 배당락일, 칸이 없으면 null, 받지 못하면 undefined(모름), 한국은 부르지 않음", async () => {
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const noEx = FX("naver_basic_NVDA.O.json");
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("ac.stock.naver.com")) return ok({ items: [] });
      if (u.includes("/stock/MSFT.O/basic")) return ok(FX("naver_basic_MSFT.O.json"));
      if (u.includes("/stock/KO.O/basic")) return ok({ ...noEx, stockItemTotalInfos: (noEx["stockItemTotalInfos"] as Array<{ code: string }>).filter((x) => x.code !== "exDividendAt") });
      return new Response("err", { status: 503 });
    });
    const f = new NaverFundamentals(fetchFn as unknown as typeof fetch);
    expect(await f.exDividendAt("MSFT")).toBe("2026-11-19");
    expect(await f.exDividendAt("KO")).toBeNull();
    expect(await f.exDividendAt("BRK-B")).toBeUndefined();
    const before = fetchFn.mock.calls.length;
    expect(await f.exDividendAt("005930")).toBeUndefined();
    expect(fetchFn.mock.calls.length).toBe(before);
    // 받은 값의 다른 칸은 그대로 (배당락일 칸만 더함)
    expect((await f.get("MSFT"))!.name).toBe("마이크로소프트");
  });
});

describe("날짜 (순수)", () => {
  it("주·달", () => {
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
    expect(sundayOf("2026-10-26")).toBe("2026-11-01");
    expect(mondayOf("2026-09-29")).toBe("2026-09-28");
    expect(sundayOf("2026-12-28")).toBe("2027-01-03");
    expect(mondayOf("2026-10-04")).toBe("2026-09-28"); // 일요일
    expect(addDays("2026-09-28", EVENTS_DAYS)).toBe("2026-10-28");
    expect(monthsBetween("2026-09-28", "2026-10-28")).toEqual(["2026-09", "2026-10"]);
    expect(monthsBetween("2026-12-28", "2027-01-27")).toEqual(["2026-12", "2027-01"]);
    expect(monthsBetween("2027-01-31", "2027-03-02")).toEqual(["2027-01", "2027-02", "2027-03"]);
  });
});

describe("배당락일 고르기·토스↔네이버 맞추기 (dividendItems)", () => {
  const MS = H("MSFT", "마이크로소프트");
  const O = H("O", "리얼티인컴");

  it("9/28: 30일 창(~10/28) 안의 앞날 배당락일만 — 리얼티인컴 9/30(두 출처 같음), 마이크로소프트 11/19 는 창 밖", () => {
    expect(dividendItems(O, DIV["O"]!, NAVER["O"], "2026-09-28", "2026-10-28")).toEqual({
      items: [{ code: "O", name: "리얼티인컴", kind: "exDividend", date: "2026-09-30", amount: 0.2715, currency: "USD", usDate: true, source: "toss+naver" }],
      failed: false,
      conflict: false,
    });
    expect(dividendItems(MS, DIV["MSFT"]!, NAVER["MSFT"], "2026-09-28", "2026-10-28")).toEqual({ items: [], failed: false, conflict: false });
  });

  it("10/26: 마이크로소프트 11/19 $0.98 (창 ~11/25)", () => {
    expect(dividendItems(MS, DIV["MSFT"]!, NAVER["MSFT"], "2026-10-26", "2026-11-25").items).toEqual([
      { code: "MSFT", name: "마이크로소프트", kind: "exDividend", date: "2026-11-19", amount: 0.98, currency: "USD", usDate: true, source: "toss+naver" },
    ]);
  });

  it("배당락일이 오늘(미국 날짜)이면 보임 — 한국 아침엔 그 미국 거래일이 아직 열리지 않음 · 어제는 빠짐", () => {
    expect(dividendItems(O, DIV["O"]!, NAVER["O"], "2026-09-30", "2026-10-30").items.map((i) => i.date)).toEqual(["2026-09-30"]);
    expect(dividendItems(O, DIV["O"]!, NAVER["O"], "2026-10-01", "2026-10-31").items).toEqual([]);
  });

  it("두 출처가 다르면(네이버의 다가오는 날짜가 토스 목록에 없음) 그 종목 줄을 빼고 conflict", () => {
    expect(dividendItems(MS, DIV["MSFT"]!, "2026-11-20", "2026-10-26", "2026-11-25")).toEqual({ items: [], failed: false, conflict: true });
  });

  it("네이버 날짜가 지난 날(엔비디아 9/10)이거나 모르면 토스만 (source toss)", () => {
    const future: TossDividend[] = [...DIV["NVDA"]!, { exDate: "2026-12-04", paymentDate: null, cash: 0.25, currency: "USD" }];
    expect(dividendItems(H("NVDA", "엔비디아"), future, NAVER["NVDA"], "2026-11-10", "2026-12-10").items).toEqual([
      { code: "NVDA", name: "엔비디아", kind: "exDividend", date: "2026-12-04", amount: 0.25, currency: "USD", usDate: true, source: "toss" },
    ]);
    expect(dividendItems(MS, DIV["MSFT"]!, undefined, "2026-10-26", "2026-11-25").items[0]!.source).toBe("toss");
  });

  it("토스를 받지 못함: 미국은 네이버 날짜만(금액 없이 source naver), 네이버도 모르면 failed · 한국은 failed", () => {
    expect(dividendItems(MS, null, "2026-11-19", "2026-10-26", "2026-11-25")).toEqual({
      items: [{ code: "MSFT", name: "마이크로소프트", kind: "exDividend", date: "2026-11-19", usDate: true, source: "naver" }],
      failed: false,
      conflict: false,
    });
    expect(dividendItems(MS, null, null, "2026-10-26", "2026-11-25")).toEqual({ items: [], failed: false, conflict: false });
    expect(dividendItems(MS, null, undefined, "2026-10-26", "2026-11-25")).toEqual({ items: [], failed: true, conflict: false });
    expect(dividendItems(H("005930", "삼성전자"), null, undefined, "2026-10-26", "2026-11-25")).toEqual({ items: [], failed: true, conflict: false });
  });

  it("한국: 토스에 앞날 날짜가 있을 때만 (보통 없음 — 삼성전자 마지막 6/29) · 한국 날짜 · 원화 금액", () => {
    expect(dividendItems(H("005930", "삼성전자"), DIV["005930"]!, undefined, "2026-09-28", "2026-10-28").items).toEqual([]);
    const declared: TossDividend[] = [...DIV["005930"]!, { exDate: "2026-12-29", paymentDate: null, cash: 370, currency: "KRW" }];
    expect(dividendItems(H("005930", "삼성전자"), declared, undefined, "2026-12-01", "2026-12-31").items).toEqual([
      { code: "005930", name: "삼성전자", kind: "exDividend", date: "2026-12-29", amount: 370, currency: "KRW", usDate: false, source: "toss" },
    ]);
  });
});

describe("실적 발표 맞추기 (earningsItems — 토스 캘린더)", () => {
  const HOLD = [
    { ...H("MSFT", "마이크로소프트"), productCode: PRODUCT["MSFT"]! },
    { ...H("META", "메타"), productCode: PRODUCT["META"]! },
    { ...H("AAPL", "애플"), productCode: PRODUCT["AAPL"]! },
    { ...H("NVDA", "엔비디아"), productCode: PRODUCT["NVDA"]! },
    { ...H("TSLA", "테슬라"), productCode: PRODUCT["TSLA"]! },
    { ...H("RGTX", "RGTX"), productCode: "NAS0250401005" },
    { ...H("IONQ", "아이온큐"), productCode: null },
  ];
  const cal = [...CAL["2026-10"]!, ...CAL["2026-11"]!];

  it("10/26 08:38: 창(~11/25) 안 보유 종목만 — 테슬라 10/22 은 지남, 큰 종목에 없는 보유 종목(RGTX)·상품 코드 모름(아이온큐)은 조용히 없음", () => {
    const items = earningsItems(HOLD, cal, "2026-10-26", "2026-11-25", "2026-10-26T08:38:00+09:00");
    expect(items).toEqual([
      { code: "MSFT", name: "마이크로소프트", kind: "earnings", date: "2026-10-29", kstTime: "05:00", timeText: "오전 5시 이후", usDate: false, source: "toss" },
      { code: "META", name: "메타", kind: "earnings", date: "2026-10-29", kstTime: "05:00", timeText: "오전 5시 이후", usDate: false, source: "toss" },
      { code: "AAPL", name: "애플", kind: "earnings", date: "2026-10-30", kstTime: "05:00", timeText: "오전 5시 이후", usDate: false, source: "toss" },
      { code: "NVDA", name: "엔비디아", kind: "earnings", date: "2026-11-19", kstTime: "06:00", timeText: "오전 6시 이후", usDate: false, source: "toss" },
    ]);
  });

  it("발표 시각이 지난 것은 뺀다 (10/29 08:38 에 그날 05:00 발표)", () => {
    const items = earningsItems(HOLD, cal, "2026-10-29", "2026-11-28", "2026-10-29T08:38:00+09:00");
    expect(items.map((i) => i.code)).toEqual(["AAPL", "NVDA"]);
  });

  it("11/2(서머타임 끝난 뒤): 토스가 준 시각 06:00 그대로 (우리가 계산하지 않음)", () => {
    const items = earningsItems([{ ...H("PLTR", "팔란티어"), productCode: PRODUCT["PLTR"]! }], CAL["2026-11"]!, "2026-11-02", "2026-12-02", "2026-11-02T08:38:00+09:00");
    expect(items).toEqual([{ code: "PLTR", name: "팔란티어", kind: "earnings", date: "2026-11-03", kstTime: "06:00", timeText: "오전 6시 이후", usDate: false, source: "toss" }]);
  });

  it("한국 큰 종목: 'A'+코드로 맞추고 시각 없이 날짜만 · 그날 오후에도 보임(시각 모름)", () => {
    const kr = [{ ...H("005930", "삼성전자"), productCode: "A005930" }, { ...H("000660", "SK하이닉스"), productCode: "A000660" }];
    expect(earningsItems(kr, CAL["2026-07"]!, "2026-07-27", "2026-08-26", "2026-07-27T08:38:00+09:00")).toEqual([
      { code: "000660", name: "SK하이닉스", kind: "earnings", date: "2026-07-29", usDate: false, source: "toss" },
      { code: "005930", name: "삼성전자", kind: "earnings", date: "2026-07-30", usDate: false, source: "toss" },
    ]);
    expect(earningsItems(kr, CAL["2026-07"]!, "2026-07-30", "2026-08-29", "2026-07-30T16:05:00+09:00").map((i) => i.code)).toEqual(["005930"]);
  });
});

describe("정렬·이번 주", () => {
  const item = (code: string, kind: AccountEventItem["kind"], date: string, kstTime?: string): AccountEventItem => ({ code, name: code, kind, date, ...(kstTime ? { kstTime } : {}), usDate: kind === "exDividend", source: "toss" });

  it("날짜 → 시각 → 배당락일 → 실적 → 등록 순", () => {
    const hold = [H("B", "B"), H("A", "A")];
    const sorted = sortEvents([item("A", "earnings", "2026-10-29", "05:00"), item("A", "exDividend", "2026-10-29"), item("B", "earnings", "2026-10-29", "05:00"), item("B", "exDividend", "2026-10-01")], hold);
    expect(sorted.map((i) => `${i.date}|${i.kind}|${i.code}`)).toEqual(["2026-10-01|exDividend|B", "2026-10-29|exDividend|A", "2026-10-29|earnings|B", "2026-10-29|earnings|A"]);
  });

  it("이번 주 = 브리핑 날짜 ~ 그 주 일요일 (10/26 → 11/1, 화요일 → 그 주 일요일)", () => {
    const items = [item("MSFT", "earnings", "2026-10-29"), item("AAPL", "earnings", "2026-11-01"), item("NVDA", "earnings", "2026-11-02"), item("X", "exDividend", "2026-10-25")];
    expect(weekItems(items, "2026-10-26").map((i) => i.code)).toEqual(["MSFT", "AAPL"]);
    expect(weekItems(items, "2026-10-27").map((i) => i.code)).toEqual(["MSFT", "AAPL"]);
  });
});

// ── 모으기 (캐시·시간 제한) ──────────────────────────────────────────

/** 녹화한 응답으로 만든 가짜 출처 (부른 기록을 남김) */
function fakeSources(over: Partial<{ dividends: (code: string) => Promise<TossDividend[]>; calendar: (ym: string) => Promise<TossCalendarEarning[]>; naver: ((code: string) => Promise<string | null | undefined>) | null }> = {}) {
  const calls = { dividends: [] as string[], calendar: [] as string[], naver: [] as string[], productCode: [] as string[] };
  const sources: HoldingEventSources = {
    dividends: async (code) => {
      calls.dividends.push(code);
      return over.dividends ? over.dividends(code) : (DIV[code] ?? []);
    },
    calendar: async (ym) => {
      calls.calendar.push(ym);
      return over.calendar ? over.calendar(ym) : (CAL[ym] ?? []);
    },
    productCode: async (code) => {
      calls.productCode.push(code);
      const pc = PRODUCT[code];
      if (!pc) throw new Error("모르는 티커");
      return pc;
    },
    naverExDividend:
      over.naver === null
        ? null
        : async (code) => {
            calls.naver.push(code);
            return over.naver ? over.naver(code) : (NAVER[code] ?? null);
          },
  };
  return { sources, calls };
}

describe("HoldingEventsService.collect", () => {
  const HOLD9 = [H("005930", "삼성전자"), H("MSFT", "마이크로소프트"), H("O", "리얼티인컴"), H("NVDA", "엔비디아"), H("TSLA", "테슬라")];
  const at = (iso: string) => ({ now: () => new Date(iso) });

  it("9/28 08:38 · 실적 꺼짐: 리얼티인컴 9/30 하나 · 캘린더 호출 0 · 네이버는 토스 창 안에 날짜가 있는 미국 종목만 · 시장별 수", async () => {
    const { sources, calls } = fakeSources();
    const svc = new HoldingEventsService({ sources, ...at("2026-09-28T08:38:00+09:00") });
    const e = await svc.collect({ holdings: HOLD9, today: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", earnings: false });
    expect(e).toEqual({
      asOf: "2026-09-28T08:38:00+09:00",
      days: 30,
      items: [{ code: "O", name: "리얼티인컴", kind: "exDividend", date: "2026-09-30", amount: 0.2715, currency: "USD", usDate: true, source: "toss+naver" }],
      earnings: false,
      failed: [],
      earningsFailed: false,
      conflicts: [],
      kr: 1,
      us: 4,
    });
    expect(calls.calendar).toEqual([]);
    expect(calls.productCode).toEqual([]);
    expect(calls.naver).toEqual(["O"]);
    expect(calls.dividends.sort()).toEqual(["005930", "MSFT", "NVDA", "O", "TSLA"]);
    expect(svc.health()).toEqual({ lastOk: "2026-09-28T08:38:00+09:00", warning: null });
  });

  it("10/26 08:38 · 실적 켬: 마이크로소프트·메타 실적 10/29, 애플 10/30, 엔비디아 11/19, 마이크로소프트 배당락일 11/19 — 날짜 순 · 창이 걸친 두 달만 부름", async () => {
    const { sources, calls } = fakeSources();
    const svc = new HoldingEventsService({ sources, ...at("2026-10-26T08:38:00+09:00") });
    const e = await svc.collect({ holdings: [H("MSFT", "마이크로소프트"), H("META", "메타"), H("AAPL", "애플"), H("NVDA", "엔비디아"), H("TSLA", "테슬라"), H("005930", "삼성전자")], today: "2026-10-26", asOf: "2026-10-26T08:38:00+09:00", earnings: true });
    expect(e.items.map((i) => `${i.date} ${i.kind} ${i.code}`)).toEqual([
      "2026-10-29 earnings MSFT",
      "2026-10-29 earnings META",
      "2026-10-30 earnings AAPL",
      "2026-11-19 exDividend MSFT",
      "2026-11-19 earnings NVDA",
    ]);
    expect(e.earnings).toBe(true);
    expect(e.earningsFailed).toBe(false);
    expect(calls.calendar.sort()).toEqual(["2026-10", "2026-11"]);
  });

  it("캐시: 12시간 안에는 다시 부르지 않고, 지나면 다시 · 받지 못하면 24시간 안 옛 값, 그 뒤에는 failed(다음 브리핑 때 다시)", async () => {
    let t = Date.parse("2026-09-28T08:38:00+09:00");
    let down = false;
    // 네이버 없이 (토스를 받지 못한 미국 종목이 네이버 날짜로 채워지지 않게 — 캐시만 본다)
    const { sources, calls } = fakeSources({ dividends: async (code) => (down ? Promise.reject(new Error("HTTP 503")) : (DIV[code] ?? [])), naver: null });
    const svc = new HoldingEventsService({ sources, now: () => new Date(t) });
    const run = () => svc.collect({ holdings: [H("O", "리얼티인컴")], today: "2026-09-28", asOf: new Date(t).toISOString(), earnings: false });
    await run();
    t += 11 * 3_600_000;
    await run();
    expect(calls.dividends).toEqual(["O"]);
    t += 2 * 3_600_000; // 13시간
    down = true;
    const stale = await run();
    expect(calls.dividends).toEqual(["O", "O"]);
    expect(stale.failed).toEqual([]);
    expect(stale.items.map((i) => i.date)).toEqual(["2026-09-30"]);
    t += 12 * 3_600_000; // 25시간
    const gone = await run();
    expect(gone.failed).toEqual([{ code: "O", name: "리얼티인컴" }]);
    expect(gone.items).toEqual([]);
    expect(svc.health().warning).toBe("배당 일정을 받지 못한 종목 1개 (HTTP 503)");
  });

  it("토스를 받지 못한 미국 종목은 네이버 날짜만 (금액 없음 · source naver) — 네이버도 받지 못하면 failed", async () => {
    const { sources } = fakeSources({ dividends: async () => Promise.reject(new Error("HTTP 500")) });
    const svc = new HoldingEventsService({ sources, ...at("2026-09-28T08:38:00+09:00") });
    const e = await svc.collect({ holdings: [H("O", "리얼티인컴"), H("005930", "삼성전자")], today: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", earnings: false });
    expect(e.items).toEqual([{ code: "O", name: "리얼티인컴", kind: "exDividend", date: "2026-09-30", usDate: true, source: "naver" }]);
    expect(e.failed).toEqual([{ code: "005930", name: "삼성전자" }]);
    const b = fakeSources({ dividends: async () => Promise.reject(new Error("HTTP 500")), naver: async () => undefined });
    const e2 = await new HoldingEventsService({ sources: b.sources, ...at("2026-09-28T08:38:00+09:00") }).collect({ holdings: [H("O", "리얼티인컴")], today: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", earnings: false });
    expect(e2.items).toEqual([]);
    expect(e2.failed).toEqual([{ code: "O", name: "리얼티인컴" }]);
  });

  it("두 출처 날짜가 다르면 그 종목 배당락일을 빼고 conflicts · 로그 · /health 경고", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const { sources } = fakeSources({ naver: async (code) => (code === "MSFT" ? "2026-11-20" : (NAVER[code] ?? null)) });
    const svc = new HoldingEventsService({ sources, log, ...at("2026-10-26T08:38:00+09:00") });
    const e = await svc.collect({ holdings: [H("MSFT", "마이크로소프트")], today: "2026-10-26", asOf: "2026-10-26T08:38:00+09:00", earnings: false });
    expect(e.items).toEqual([]);
    expect(e.conflicts).toEqual([{ code: "MSFT", name: "마이크로소프트" }]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ code: "MSFT", naver: "2026-11-20", toss: ["2026-11-19"] }), expect.stringMatching(/달라/));
    expect(svc.health().warning).toBe("토스·네이버 배당락일이 달라 뺀 종목 1개");
    // 두 출처가 다른 것은 받지 못한 것이 아니다 — 마지막으로 모두 받은 시각은 남긴다
    expect(svc.health().lastOk).toBe("2026-10-26T08:38:00+09:00");
  });

  it("캘린더를 받지 못하거나 모양이 바뀌면 실적 줄을 모두 빼고 earningsFailed · 한 달만 받지 못해도 모두 뺀다 · 배당락일은 그대로", async () => {
    const bad = fakeSources({ calendar: async (ym) => (ym === "2026-11" ? parseCalendarEarnings({ changed: true }) : (CAL[ym] ?? [])) });
    const svc = new HoldingEventsService({ sources: bad.sources, ...at("2026-10-26T08:38:00+09:00") });
    const e = await svc.collect({ holdings: [H("MSFT", "마이크로소프트")], today: "2026-10-26", asOf: "2026-10-26T08:38:00+09:00", earnings: true });
    expect(e.earningsFailed).toBe(true);
    expect(e.items.map((i) => i.kind)).toEqual(["exDividend"]);
    expect(svc.health()).toEqual({ lastOk: null, warning: "실적 발표일(토스 캘린더)을 받지 못함 ([toss] 캘린더 응답 모양이 바뀌었습니다)" });
  });

  it("시간 제한: 출처가 멈춰도 budget 안에 돌아오고(받지 못한 것은 failed), 나가 있는 요청은 뒤에서 끝나면 다음 번에 캐시로 쓴다", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((res) => (release = res));
    const { sources, calls } = fakeSources({
      dividends: async (code) => {
        await gate;
        return DIV[code] ?? [];
      },
      calendar: () => new Promise<TossCalendarEarning[]>(() => undefined),
    });
    const svc = new HoldingEventsService({ sources, ...at("2026-09-28T08:38:00+09:00") });
    const t0 = Date.now();
    const e = await svc.collect({ holdings: [H("O", "리얼티인컴"), H("005930", "삼성전자"), H("MSFT", "마이크로소프트")], today: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", earnings: true, budgetMs: 60 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    // 동시에 2개만 불렀고, 시간이 다 돼 세 번째(마이크로소프트)는 부르지 않음. 네이버도 시간이 없어 부르지 않음 → 셋 다 받지 못함
    expect(calls.dividends).toEqual(["O", "005930"]);
    expect(calls.naver).toEqual([]);
    expect(e.earningsFailed).toBe(true);
    expect(e.items).toEqual([]);
    expect(e.failed.map((f) => f.code)).toEqual(["O", "005930", "MSFT"]);
    release!();
    await new Promise((r) => setTimeout(r, 10));
    const again = await svc.collect({ holdings: [H("O", "리얼티인컴"), H("005930", "삼성전자"), H("MSFT", "마이크로소프트")], today: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", earnings: false, budgetMs: 200 });
    expect(again.failed).toEqual([]);
    expect(again.items.map((i) => `${i.code} ${i.date} ${i.source}`)).toEqual(["O 2026-09-30 toss+naver"]);
  });

  it("같은 종목이 두 번 오면 한 번만 · 보유 종목이 없으면 부르지 않음", async () => {
    const { sources, calls } = fakeSources();
    const svc = new HoldingEventsService({ sources, ...at("2026-09-28T08:38:00+09:00") });
    const e = await svc.collect({ holdings: [H("O", "리얼티인컴"), H("O", "리얼티인컴")], today: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", earnings: false });
    expect(e.items).toHaveLength(1);
    expect(calls.dividends).toEqual(["O"]);
    const none = await svc.collect({ holdings: [], today: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", earnings: false });
    expect(none).toMatchObject({ items: [], failed: [], kr: 0, us: 0 });
  });

  it("/health 경고 문구도 사실만 (문구 검사)", async () => {
    const { sources } = fakeSources({ dividends: async () => Promise.reject(new Error("HTTP 503")), naver: async () => undefined, calendar: async () => Promise.reject(new Error("HTTP 503")) });
    const svc = new HoldingEventsService({ sources, ...at("2026-09-28T08:38:00+09:00") });
    await svc.collect({ holdings: [H("O", "리얼티인컴")], today: "2026-09-28", asOf: "2026-09-28T08:38:00+09:00", earnings: true });
    const w = svc.health().warning!;
    expect(w).toMatch(/배당 일정을 받지 못한 종목 1개/);
    expect(w).toMatch(/실적 발표일/);
    expect(scoreWordingProblems(w)).toEqual([]);
  });
});

describe("공용 픽스처 (shared/fixtures/holdingEvents.json — 앱이 같은 값으로 카드 글을 본다)", () => {
  const shared = JSON.parse(readFileSync(new URL("../../shared/fixtures/holdingEvents.json", import.meta.url), "utf8")) as {
    cases: Array<{ name: string; input?: { today: string; asOf: string; earnings: boolean; firstMorning: boolean; holdings: Array<{ code: string; name: string }> }; events: Record<string, unknown> }>;
  };
  for (const c of shared.cases.filter((x) => x.input)) {
    it(`${c.name}: 녹화한 응답으로 모은 값 = 픽스처 events`, async () => {
      const { sources } = fakeSources();
      const svc = new HoldingEventsService({ sources, now: () => new Date(c.input!.asOf) });
      const got = await svc.collect({ holdings: c.input!.holdings, today: c.input!.today, asOf: c.input!.asOf, earnings: c.input!.earnings });
      expect({ ...got, week: c.input!.firstMorning ? weekItems(got.items, c.input!.today) : null }).toEqual(c.events);
    });
  }
});

// ── 계좌 브리핑 저장 ──────────────────────────────────────────────

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

describe("계좌 브리핑 저장: events (서비스)", () => {
  let db: Db;
  afterEach(async () => {
    await db?.destroy();
  });

  const LIST = () => [
    holding("005930", "삼성전자", 80_000, 50),
    holding("MSFT", "마이크로소프트", 500, 10, { currency: "USD" }),
    holding("META", "메타", 700, 5, { currency: "USD" }),
    holding("AAPL", "애플", 250, 10, { currency: "USD" }),
    holding("TSLA", "테슬라", 400, 5, { currency: "USD" }),
  ];

  const setup = async (o: { events?: boolean; earnings?: boolean; at?: string; noSource?: boolean; collect?: HoldingEventsService["collect"]; eventsBudgetMs?: number } = {}) => {
    db = await createMigratedDb(":memory:");
    const st = { list: LIST(), at: o.at ?? "2026-10-26T08:38:00+09:00" };
    const flags: Record<string, boolean> = { accountBriefing: true, accountBriefingLlm: false, accountSinceLast: false, accountExposure: false, holdingEvents: o.events ?? true, holdingEarnings: o.earnings ?? false };
    const { sources, calls } = fakeSources();
    const real = new HoldingEventsService({ sources, now: () => new Date(st.at) });
    const collect = vi.fn(o.collect ?? ((input: Parameters<HoldingEventsService["collect"]>[0]) => real.collect(input)));
    const svc = new AccountBriefingService({
      db,
      stocks: { listWithFreshQuotes: async () => st.list },
      indices: null,
      calendar: null,
      generator: noModel,
      prompts: {} as PromptStore,
      features: { enabled: async (k: string) => flags[k] ?? false },
      holdingEvents: o.noSource ? null : { collect },
      ...(o.eventsBudgetMs !== undefined ? { eventsBudgetMs: o.eventsBudgetMs } : {}),
      now: () => new Date(st.at),
    });
    return { svc, st, flags, calls, collect };
  };
  const make = async (svc: AccountBriefingService, session: "morning" | "afternoon" = "morning", date = "2026-10-26") => (await svc.generate(session, { date }))!;

  it("플래그: holdingEvents 기본 켬, holdingEarnings 기본 꺼짐 (사용자 승인 뒤 켬)", () => {
    expect(FEATURES.holdingEvents.default).toBe(true);
    expect(FEATURES.holdingEarnings.default).toBe(false);
  });

  it("월 10/26 첫 오전 · 실적 켬: events 저장(그때 기준) · 이번 주 = 마이크로소프트·메타 10/29, 애플 10/30 · 목록 headline.week", async () => {
    const { svc } = await setup({ earnings: true });
    const b = await make(svc);
    const d = (await svc.get(b.id)).data!;
    expect(d.events!.asOf).toBe("2026-10-26T08:38:00+09:00");
    expect(d.events!.asOf).toBe(d.asOf);
    expect(d.events!.earnings).toBe(true);
    expect(d.events!.items.map((i) => `${i.date} ${i.kind} ${i.code}`)).toEqual(["2026-10-29 earnings MSFT", "2026-10-29 earnings META", "2026-10-30 earnings AAPL", "2026-11-19 exDividend MSFT"]);
    expect(d.events!.week!.map((i) => i.code)).toEqual(["MSFT", "META", "AAPL"]);
    expect(b.headline!.week).toEqual([
      { code: "MSFT", name: "마이크로소프트", kind: "earnings", date: "2026-10-29" },
      { code: "META", name: "메타", kind: "earnings", date: "2026-10-29" },
      { code: "AAPL", name: "애플", kind: "earnings", date: "2026-10-30" },
    ]);
  });

  it("실적 꺼짐(기본): 캘린더를 부르지 않고 배당락일만 · 이번 주 일정이 없으면 week [] 이고 headline 칸 없음", async () => {
    const { svc, calls } = await setup();
    const b = await make(svc);
    const d = (await svc.get(b.id)).data!;
    expect(calls.calendar).toEqual([]);
    expect(d.events!.earnings).toBe(false);
    expect(d.events!.items.map((i) => `${i.date} ${i.kind} ${i.code}`)).toEqual(["2026-11-19 exDividend MSFT"]);
    expect(d.events!.week).toEqual([]);
    expect(b.headline).not.toHaveProperty("week");
  });

  it("월 9/28: 이번 주(~10/4) 일정 없음 → 줄 없음", async () => {
    const { svc } = await setup({ earnings: true, at: "2026-09-28T08:38:00+09:00" });
    const b = await make(svc, "morning", "2026-09-28");
    expect((await svc.get(b.id)).data!.events!.week).toEqual([]);
    expect(b.headline).not.toHaveProperty("week");
  });

  it("그 주 첫 오전 브리핑만: 화요일은 월요일 오전 브리핑이 있으면 null, 월요일이 두 시장 모두 휴장이라 계좌 브리핑이 없었으면 화요일이 이번 주", async () => {
    const a = await setup({ earnings: true });
    await make(a.svc, "morning", "2026-10-26");
    a.st.at = "2026-10-27T08:38:00+09:00";
    const tue = await make(a.svc, "morning", "2026-10-27");
    expect((await a.svc.get(tue.id)).data!.events!.week).toBeNull();
    expect(tue.headline).not.toHaveProperty("week");
    await db.destroy();
    const b = await setup({ earnings: true, at: "2026-10-27T08:38:00+09:00" });
    const first = await make(b.svc, "morning", "2026-10-27");
    expect((await b.svc.get(first.id)).data!.events!.week!.map((i) => i.code)).toEqual(["MSFT", "META", "AAPL"]);
    // 같은 월요일을 수동으로 다시 만들어도 그날이 첫 오전 브리핑 그대로
    await db.destroy();
    const c = await setup({ earnings: true });
    await make(c.svc);
    const again = await c.svc.generate("morning", { date: "2026-10-26", force: true });
    expect((await c.svc.get(again!.id)).data!.events!.week!.length).toBe(3);
  });

  it("오후 브리핑은 이번 주 없음 (week null)", async () => {
    const { svc, st } = await setup({ earnings: true });
    st.at = "2026-10-26T16:05:00+09:00";
    const b = await make(svc, "afternoon");
    const d = (await svc.get(b.id)).data!;
    expect(d.events!.week).toBeNull();
    expect(d.events!.asOf).toBe("2026-10-26T16:05:00+09:00");
  });

  it("월 12/28: 창이 걸친 12월·1월 캘린더 · 1월 기록이 없어도(빈 달) 실패가 아님", async () => {
    const { svc, calls } = await setup({ earnings: true, at: "2026-12-28T08:38:00+09:00" });
    const b = await make(svc, "morning", "2026-12-28");
    const d = (await svc.get(b.id)).data!;
    expect(calls.calendar.sort()).toEqual(["2026-12", "2027-01"]);
    expect(d.events!.earningsFailed).toBe(false);
    expect(d.events!.week).toEqual([]);
  });

  it("꺼짐: events 칸이 없고 출처를 부르지 않는다 (배당·캘린더·네이버 0) · 출처가 없어도(테스트 기본) 칸 없음", async () => {
    const off = await setup({ events: false, earnings: true });
    const d = (await off.svc.get((await make(off.svc)).id)).data! as Record<string, unknown>;
    expect(d).not.toHaveProperty("events");
    expect(off.collect).not.toHaveBeenCalled();
    expect(off.calls).toEqual({ dividends: [], calendar: [], naver: [], productCode: [] });
    await db.destroy();
    const none = await setup({ noSource: true });
    expect((await none.svc.get((await make(none.svc)).id)).data).not.toHaveProperty("events");
  });

  it("일정 모으기가 던져도 계좌 브리핑은 그대로 (칸 없이) · 멈춰도 제한 시간 뒤 칸 없이 저장", async () => {
    const a = await setup({ collect: async () => Promise.reject(new Error("뜻밖의 오류")) });
    const b = await make(a.svc);
    expect(b.status).toBe("ok");
    expect((await a.svc.get(b.id)).data).not.toHaveProperty("events");
    await db.destroy();
    const h = await setup({ collect: () => new Promise(() => undefined), eventsBudgetMs: 30 });
    const t0 = Date.now();
    const b2 = await make(h.svc);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(b2.status).toBe("ok");
    expect((await h.svc.get(b2.id)).data).not.toHaveProperty("events");
  });

  it("시세를 하나도 받지 못해 실패로 저장한 브리핑에는 없다", async () => {
    const { svc, st } = await setup();
    st.list = [holding("TSLA", "테슬라", 400, 5, { currency: "USD", quote: false })];
    const b = await make(svc);
    expect(b.status).toBe("failed");
    expect((await svc.get(b.id)).data).not.toHaveProperty("events");
  });

  it("모으기에 넘기는 값: 보유 종목(수량 > 0) 이름·코드, 브리핑 날짜, asOf, 실적 플래그", async () => {
    const { svc, collect, st } = await setup({ earnings: true });
    st.list = [...LIST(), { ...holding("NVDA", "엔비디아", 180, 0, { currency: "USD" }) }];
    await make(svc);
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ today: "2026-10-26", asOf: "2026-10-26T08:38:00+09:00", earnings: true, holdings: LIST().map((h) => ({ code: h.code, name: h.name })) }));
  });
});

describe("/health", () => {
  it("켜져 있고 출처가 있으면 holdingEvents(마지막으로 모두 받은 시각·경고), 끄면 칸 없음", async () => {
    const db = await createMigratedDb(":memory:");
    const { sources } = fakeSources();
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders({ holdingEvents: sources }), logger: false, enableScheduler: false });
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ holdingEvents: { lastOk: null, warning: null } });
      await app.inject({ method: "PUT", url: "/api/admin/features", payload: { holdingEvents: false } });
      expect((await app.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty("holdingEvents");
    } finally {
      await app.close();
      await db.destroy();
    }
  });

  it("출처가 없으면(테스트 기본 fakeProviders) 켜져 있어도 칸 없음 — 응답이 예전과 같게", async () => {
    const db = await createMigratedDb(":memory:");
    const app = await buildApp({ config: loadConfig({ DATABASE_URL: ":memory:" }), db, providers: fakeProviders(), logger: false, enableScheduler: false });
    try {
      expect((await app.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty("holdingEvents");
    } finally {
      await app.close();
      await db.destroy();
    }
  });
});
