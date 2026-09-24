import { describe, expect, it } from "vitest";
import { fxOf, summarize, totals } from "@/lib/portfolio";
import { excludedCount, widgetOrder as order } from "@/widgets/model";
import { holding, quote } from "./helpers";

const widgetOrder = (list: Parameters<typeof order>[0]) => order(list, fxOf);

const FX = 1360;
const samsung = holding("005930", quote("005930", 72_000, { change: 1000 }), 10, 70_000, undefined, "삼성전자");
const hynix = holding("000660", quote("000660", 230_000, { change: -2000 }), 3, 250_000, undefined, "SK하이닉스");
const apple = holding("AAPL", quote("AAPL", 200, { currency: "USD", change: 1.5, fxRate: FX }), 4, 180, { costBasisKrw: 950_000, krwCostSource: "exact" }, "애플");
const watchOnly = holding("035720", quote("035720", 41_000), null, null, undefined, "카카오");
const noFx = holding("TSLA", quote("TSLA", 250, { currency: "USD", change: -3 }), 2, 240, undefined, "테슬라");

describe("fxOf", () => {
  it("시세의 환율을 쓴다", () => expect(fxOf(apple)).toBe(FX));
  it("환율 필드가 없으면 원화 환산가 ÷ 가격", () => expect(fxOf(holding("X", quote("X", 100, { currency: "USD", priceKrw: 135_000 }), 1, 1))).toBe(1350));
  it("둘 다 없으면 null", () => expect(fxOf(noFx)).toBeNull());
});

describe("summarize (잔고 화면 계좌 평가)", () => {
  it("원화만: 합계와 당일 손익", () => {
    const s = summarize([samsung, hynix, watchOnly], false);
    expect(s.held).toBe(2);
    expect(s.watch).toBe(1);
    expect(s.byCur.KRW.value).toBe(720_000 + 690_000);
    expect(s.byCur.KRW.cost).toBe(700_000 + 750_000);
    expect(s.byCur.KRW.day).toBe(10 * 1000 + 3 * -2000);
    expect(s.krw!.value).toBe(s.byCur.KRW.value);
  });

  it("달러 섞임: 원화 합계는 매수 당시 원화 매입금액 기준", () => {
    const s = summarize([samsung, apple], false);
    expect(s.byCur.USD.value).toBe(800);
    expect(s.usdInKrw.value).toBe(800 * FX);
    expect(s.usdInKrw.cost).toBe(950_000);
    expect(s.usdInKrw.day).toBe(4 * 1.5 * FX);
    expect(s.krw!.value).toBe(720_000 + 800 * FX);
    expect(s.krw!.cost).toBe(700_000 + 950_000);
    expect(s.fx).toBe(FX);
    expect(s.estimated).toBe(false);
  });

  it("환율 모르는 달러 종목이 있으면 원화 합계 없음", () => {
    const s = summarize([samsung, noFx], false);
    expect(s.krw).toBeNull();
    expect(s.byCur.USD.count).toBe(1);
  });

  it("장부 없는 달러 종목은 추정·현재 환율 기준으로 센다", () => {
    const a = holding("AAPL", quote("AAPL", 200, { currency: "USD", fxRate: FX }), 4, 180);
    const s = summarize([a], false);
    expect(s.estimated).toBe(true);
    expect(s.currentBasis).toBe(1);
  });

  it("보유가 없으면 원화 합계 null", () => {
    const s = summarize([watchOnly], true);
    expect(s.held).toBe(0);
    expect(s.krw).toBeNull();
  });

  it("비용 차감 설정을 따른다", () => {
    const withCost = holding("005930", quote("005930", 72_000), 10, 70_000, { costRate: 0.002, afterCost: { marketValue: 718_560, profit: 18_560, profitRate: 2.65 } });
    expect(summarize([withCost], true).krw!.value).toBe(718_560);
    expect(summarize([withCost], false).krw!.value).toBe(720_000);
  });
});

describe("위젯 합계 totals", () => {
  it("보유 없으면 null", () => expect(totals([watchOnly], false)).toBeNull());
  it("빈 목록이면 null", () => expect(totals([], true)).toBeNull());

  it("원화만: 원화 합계", () => {
    const t = totals([samsung, hynix], false)!;
    expect(t).toEqual({ value: 1_410_000, day: 4000, profit: 1_410_000 - 1_450_000, currency: "KRW", mixed: false });
  });

  it("달러만 + 원화 표시 꺼짐: 달러 그대로", () => {
    const t = totals([apple], false)!;
    expect(t.currency).toBe("USD");
    expect(t.value).toBe(800);
    expect(t.day).toBe(6);
    expect(t.profit).toBe(80);
  });

  it("달러만 + 원화 표시 켜짐: 원화로, 손익은 매수 당시 원화 기준", () => {
    const t = totals([apple], true)!;
    expect(t.currency).toBe("KRW");
    expect(t.value).toBe(800 * FX);
    expect(t.profit).toBe(800 * FX - 950_000);
    expect(t.day).toBe(6 * FX);
  });

  it("통화 섞임: 원화 표시와 무관하게 원화 합계", () => {
    expect(totals([samsung, apple], false)!.currency).toBe("KRW");
    expect(totals([samsung, apple], true)!.value).toBe(720_000 + 800 * FX);
  });

  it("환율 모르는 달러 종목은 빼고 mixed 표시", () => {
    const t = totals([samsung, noFx], true)!;
    expect(t.mixed).toBe(true);
    expect(t.value).toBe(720_000);
  });

  it("위젯 합계 = 잔고 화면 원화 합계 (통화 섞임)", () => {
    const list = [samsung, hynix, apple, watchOnly];
    for (const afterCost of [true, false]) {
      const t = totals(list, true, afterCost)!;
      const s = summarize(list, afterCost);
      expect(t.value).toBe(s.krw!.value);
      expect(t.day).toBe(s.krw!.day);
      expect(t.profit).toBe(s.krw!.value - s.krw!.cost);
    }
  });

  it("위젯 합계 = 잔고 화면 원화 합계 (원화만)", () => {
    const t = totals([samsung, hynix], false)!;
    const s = summarize([samsung, hynix], false);
    expect(t.value).toBe(s.krw!.value);
    expect(t.profit).toBe(s.krw!.value - s.krw!.cost);
  });

  it("시세 없는 보유 종목은 제외", () => {
    const noQuote = { ...samsung, quote: null };
    expect(totals([noQuote, hynix], false)!.value).toBe(690_000);
  });
});

describe("위젯 목록 순서", () => {
  it("보유는 원화 환산 평가금액 큰 순, 관심은 이름 순으로 뒤에", () => {
    const watch2 = holding("005380", quote("005380", 250_000), null, null, undefined, "현대차");
    const order = widgetOrder([watch2, hynix, watchOnly, samsung, apple]).map((s) => s.code);
    // 애플 800 × 1360 = 1,088,000 > 삼성 720,000 > 하이닉스 690,000
    expect(order).toEqual(["AAPL", "005930", "000660", "035720", "005380"]);
  });
  it("환율 모르는 달러 종목은 1배로 친다", () => {
    expect(widgetOrder([noFx, samsung]).map((s) => s.code)).toEqual(["005930", "TSLA"]);
  });
});

/** 3-1에서 "수정 전 실패"로 넣어 둔 위젯 버그 재현 테스트 — 3-4에서 고쳐 일반 테스트로 */
describe("위젯-3: 시세 없는 보유 종목", () => {
  // 수량 있음, 시세·평가 없음 (서버가 그 종목 시세를 못 받은 경우)
  const noQuoteHeld = { ...samsung, quote: null, evaluation: null };

  it("보유 쪽에 남는다 (관심으로 내려가지 않음)", () => {
    const watchFirstByName = { ...watchOnly, name: "가나다" }; // 이름순으로 관심 맨 앞에 오는 종목
    const list = widgetOrder([watchFirstByName, noQuoteHeld, hynix]).map((s) => s.code);
    expect(list.indexOf("005930")).toBeLessThan(list.indexOf("035720"));
    expect(list).toEqual(["000660", "005930", "035720"]); // 시세 없는 보유는 보유 맨 뒤
  });

  it("합계에서 빠진 수를 센다", () => {
    expect(excludedCount([noQuoteHeld, hynix, watchOnly])).toBe(1);
    expect(totals([noQuoteHeld, hynix], false)!.value).toBe(690_000);
  });
});
