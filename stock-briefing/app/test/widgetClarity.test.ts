import { describe, expect, it } from "vitest";
import { fxOf, totals } from "@/lib/portfolio";
import { widgetClarity, widgetTimeVariants, WIDGET_CHANGE_LABEL } from "@/widgets/clarity";
import { assetLine, asOfMs, excludedCount, polishedRowSpeech, widgetOrder } from "@/widgets/model";
import { fromPayload, isDelayed, NO_FEATURES, openMarketAsOf, widgetFeatures, type WidgetMarket } from "@/widgets/payload";
import { holding, quote } from "./helpers";

const now = Date.parse("2026-10-05T10:00:00+09:00");
const open: WidgetMarket = { label: "한국 장중", open: true, kr: true, us: false, nextChangeAt: null };
const closed: WidgetMarket = { label: "휴장", open: false, kr: false, us: false, nextChangeAt: null };
const stock = (code: string, age = 0, usd = false, stale = false) => holding(code, quote(code, 100, {
  currency: usd ? "USD" : "KRW", change: 1, changeRate: 1,
  asOf: new Date(now - age).toISOString(), fxRate: null, priceKrw: null, stale,
}), 1, 10);

describe("위젯 정보 기준: 같은 모의 입력에서 기존 경고 누락과 보완 결과", () => {
  it("원화·달러 혼합인데 환율이 없으면 실제 합계의 제외 사유를 표시한다", () => {
    const stocks = [stock("005930"), stock("AAPL", 0, true)];
    const total = totals(stocks, true, true);
    expect(total).toMatchObject({ value: 100, currency: "KRW", excluded: { noFx: 1 } });
    expect(excludedCount(stocks)).toBe(0); // 변경 전 모의 재현: 금액은 빠졌지만 경고 수 0
    expect(widgetClarity(stocks, total, open, now)).toMatchObject({ partial: true, excludedCount: 1, exclusionNote: "환율 없음 1종목 제외" });
    expect(total).toEqual(totals(stocks, true, true)); // 숫자·비용 설정은 건드리지 않는다
  });

  it("달러 종목만 있어 원액 합계를 보이면 환율 없음으로 잘못 제외하지 않는다", () => {
    const stocks = [stock("AAPL", 0, true)];
    const total = totals(stocks, true, true);
    expect(total?.currency).toBe("USD");
    expect(widgetClarity(stocks, total, open, now)).toMatchObject({ partial: false, excludedCount: 0, exclusionNote: null });
  });

  it("시세 없는 보유와 평단 없는 보유가 모두 합계에서 빠지면 null 합계에서도 사유를 남긴다", () => {
    const stocks = [holding("005930", null, 1, 10), holding("000660", quote("000660", 100), 1, null)];
    expect(totals(stocks, true)).toBeNull();
    expect(widgetClarity(stocks, null, closed, now)).toMatchObject({ partial: true, excludedCount: 2, exclusionNote: "시세 없음 1종목 · 평단 없음 1종목 제외" });
  });

  it("한 시간 지난 보유 시세가 최신 보유 시세 때문에 정상으로 가려지지 않는다", () => {
    const stocks = [stock("005930", 3_600_000, false, true), stock("000660")];
    expect(asOfMs(stocks, now)).toBe(now);
    expect(isDelayed({ openAsOf: openMarketAsOf(stocks, open), fetchedAt: now, error: null, now })).toBe(false); // 변경 전 모의 재현
    expect(widgetClarity(stocks, totals(stocks, true), open, now)).toMatchObject({ staleCount: 1, staleCodes: ["005930"], earliestQuoteAt: now - 3_600_000, latestQuoteAt: now });
  });

  it("서버 stale 표기가 없어도 열린 시장에서 30분을 초과한 보유 시세를 표시한다", () => {
    const stocks = [stock("005930", 1_800_001), stock("000660", 1_800_000)];
    expect(widgetClarity(stocks, totals(stocks, true), open, now).staleCodes).toEqual(["005930"]);
  });

  it("휴장 중 정상 종가는 나이만으로 장애로 보지 않고 명시된 stale·이전값 사용은 남긴다", () => {
    const stocks = [stock("005930", 86_400_000), stock("000660", 86_400_000, false, true), stock("035420", 86_400_000)];
    const state = widgetClarity(stocks, totals(stocks, true), closed, now, ["000660", "035420"]);
    expect(state.staleCodes).toEqual(["000660", "035420"]);
    expect(state.staleCount).toBe(2);
  });

  it("연장 시장에서만 열린 미국 시세도 살피고 관심 종목은 보유 경고에 더하지 않는다", () => {
    const stocks = [stock("AAPL", 3_600_000, true), holding("MSFT", quote("MSFT", 100, { stale: true, currency: "USD" }), null, null)];
    expect(widgetClarity(stocks, totals(stocks, true), { ...closed, ext: { kr: false, us: true } }, now).staleCodes).toEqual(["AAPL"]);
    expect(widgetClarity(stocks, totals(stocks, true), closed, now).staleCodes).toEqual([]);
  });

  it("장 경계가 지난 캐시만으로 장중이라 단정하지 않고 잘못된 시각은 확인 필요로 남긴다", () => {
    const stocks = [stock("005930", 3_600_000)];
    expect(widgetClarity(stocks, totals(stocks, true), { ...open, nextChangeAt: new Date(now - 1).toISOString() }, now).staleCount).toBe(0);
    stocks[0].quote!.asOf = "";
    expect(widgetClarity(stocks, totals(stocks, true), closed, now)).toMatchObject({ staleCount: 1, earliestQuoteAt: null, latestQuoteAt: null });
  });

  it("같은 미국 시장이 열려도 주간거래 미지원·거래정지·끝난 세션은 시간만으로 지연이라고 하지 않는다", () => {
    const stocks = [stock("AAPL", 3_600_000, true), stock("MSFT", 3_600_000, true), stock("NVDA", 3_600_000, true), stock("TSLA", 3_600_000, true)];
    stocks.forEach((s) => { s.quote!.session = { market: "US", phase: "overnight", label: "미국 주간거래", open: true, eligible: true, until: new Date(now + 3_600_000).toISOString() }; });
    stocks[1].quote!.session!.eligible = false;
    stocks[2].quote!.session!.halted = true;
    stocks[3].quote!.session!.until = new Date(now - 1).toISOString();
    const market = { ...closed, ext: { kr: false, us: true } };
    expect(widgetClarity(stocks, totals(stocks, true), market, now).staleCodes).toEqual(["AAPL"]);
    stocks[1].quote!.stale = true;
    expect(widgetClarity(stocks, totals(stocks, true), market, now).staleCodes).toEqual(["AAPL", "MSFT"]);
    const decoded = fromPayload({ v: 1, market, briefings: [], stocks: stocks.map((s) => ({
      c: s.code, n: s.name, qty: s.quantity, avg: s.avgPrice,
      q: [s.quote!.price, s.quote!.change, s.quote!.changeRate, "USD", s.quote!.asOf, null, s.quote!.stale ? 1 : 0],
      e: null, ss: s.quote!.session!,
    })) });
    expect(widgetClarity(decoded.stocks, null, market, now).staleCodes).toEqual(["AAPL", "MSFT"]);
  });

  it("빈 목록·관심 목록은 일부 합계 또는 0종목 경고를 만들지 않는다", () => {
    expect(widgetClarity([], null, null, now)).toMatchObject({ partial: false, exclusionNote: null, staleNote: null });
    expect(widgetClarity([holding("AAPL", null, null, null)], null, null, now).excludedCount).toBe(0);
  });
});

describe("위젯 시각·전일 대비·정렬 계약과 플래그 꺼짐 보존", () => {
  it("조회 시각과 시세 시각을 구별하고 지난 날짜를 짧은 후보에서도 지우지 않는다", () => {
    const previous = Date.parse("2026-10-03T08:59:00+09:00");
    expect(widgetTimeVariants(previous, now, "quote")).toEqual(["시세 10/3 08:59"]);
    expect(widgetTimeVariants(now, now, "received")).toEqual(["조회 10:00"]);
    expect(widgetTimeVariants(NaN, now, "quote")).toEqual(["시세 시각 미확인"]);
  });

  it("시각·화면 읽기에 전일 대비를 명시하되 인자 없는 기존 호출은 오늘 그대로다", () => {
    expect(assetLine(1, 2, String).day.text).toBe("오늘 1");
    expect(assetLine(1, 2, String, WIDGET_CHANGE_LABEL).day.text).toBe("전일 대비 1");
    expect(polishedRowSpeech("삼성전자", "100원", 1, 2)).toContain("오늘 1.00% 상승");
    expect(polishedRowSpeech("삼성전자", "100원", 1, 2, WIDGET_CHANGE_LABEL)).toContain("전일 대비 1.00% 상승");
  });

  it("미지원·꺼짐 플래그는 기존 기능 객체와 같고 켰을 때만 clarity 칸이 생긴다", () => {
    expect(widgetFeatures(undefined)).toEqual(NO_FEATURES);
    expect(widgetFeatures({ widgetClarity: false })).toEqual(NO_FEATURES);
    expect(widgetFeatures({ widgetClarity: true })).toEqual({ ...NO_FEATURES, clarity: true });
  });

  it("고정 순서와 이름순은 목록에만 적용하고 없는 고정 종목·중복 키는 무시한다", () => {
    const stocks = [stock("005930"), stock("000660"), stock("035420")];
    stocks[0].name = "다"; stocks[1].name = "가"; stocks[2].name = "나";
    const before = JSON.stringify(stocks);
    expect(widgetOrder(stocks, fxOf).map((s) => s.code)).toEqual(["005930", "000660", "035420"]);
    expect(widgetOrder(stocks, fxOf, { sort: "name", pinnedCodes: ["035420", "035420", "없는종목"] }).map((s) => s.code)).toEqual(["035420", "000660", "005930"]);
    expect(widgetOrder(stocks, fxOf, { sort: "value", pinnedCodes: ["000660", "005930"] }).map((s) => s.code)).toEqual(["000660", "005930", "035420"]);
    expect(JSON.stringify(stocks)).toBe(before);
    expect(totals(stocks, true)?.value).toBe(300);
  });
});
