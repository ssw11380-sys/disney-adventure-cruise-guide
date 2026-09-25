import { describe, expect, it } from "vitest";
import { applyTick, streamUrl, type StreamTick } from "@/lib/liveTick";
import { quote } from "./helpers";

const tick = (code: string, price: number, timestamp = "2026-09-23T10:00:05+09:00"): StreamTick => ({ code, price, volume: null, timestamp, source: "test" });

describe("applyTick (실시간 체결 덮어쓰기)", () => {
  const q = quote("005930", 71_000, { prevClose: 70_000, change: 1000, changeRate: 1.43, high: 71_500, low: 70_200 });

  it("시세가 없으면 null 그대로", () => expect(applyTick(null, tick("005930", 1))).toBeNull());
  it("다른 종목 체결은 무시 (참조 유지)", () => expect(applyTick(q, tick("000660", 1))).toBe(q));
  it("시세보다 오래된 체결은 무시", () => expect(applyTick(q, tick("005930", 72_000, "2026-09-23T09:59:00+09:00"))).toBe(q));
  it("가격이 같으면 무시", () => expect(applyTick(q, tick("005930", 71_000))).toBe(q));
  it("시각을 못 읽으면 무시", () => expect(applyTick(q, tick("005930", 72_000, "bad"))).toBe(q));

  it("전일 종가 기준으로 등락을 다시 계산", () => {
    const n = applyTick(q, tick("005930", 72_100))!;
    expect(n.price).toBe(72_100);
    expect(n.change).toBe(2100);
    expect(n.changeRate).toBe(3);
    expect(n.live).toBe(true);
    expect(n.asOf).toBe("2026-09-23T10:00:05+09:00");
  });

  it("고가·저가를 넓힌다", () => {
    expect(applyTick(q, tick("005930", 71_800))!.high).toBe(71_800);
    expect(applyTick(q, tick("005930", 70_100))!.low).toBe(70_100);
  });

  it("전일 종가가 없으면 가격 - 등락으로 추정", () => {
    const n = applyTick({ ...q, prevClose: null }, tick("005930", 70_500))!;
    expect(n.change).toBe(500);
  });

  it("미국 종목은 환율로 원화 환산가도 갱신", () => {
    const us = quote("AAPL", 200, { currency: "USD", prevClose: 198, change: 2, changeRate: 1.01, fxRate: 1360, priceKrw: 272_000 });
    const n = applyTick(us, tick("AAPL", 201.37))!;
    expect(n.priceKrw).toBe(Math.round(201.37 * 1360));
    expect(n.change).toBe(3.37);
  });

  it("환율 필드가 없으면 원화 환산가 ÷ 가격으로 환율 추정", () => {
    const us = quote("AAPL", 200, { currency: "USD", prevClose: 198, priceKrw: 272_000 });
    expect(applyTick(us, tick("AAPL", 210))!.priceKrw).toBe(285_600);
  });

  // 버그 점검 BH-29 · BH-35 · BH-54: 등락을 센트로 반올림한 뒤 등락률을 내면 1달러 미만 종목이 틀린다
  it("1달러 미만 미국 종목: 등락률은 반올림 전 차이로, 등락은 소수 4자리까지", () => {
    const penny = quote("DCX", 0.4321, { currency: "USD", prevClose: 0.4321, fxRate: 1390 });
    const up = applyTick(penny, tick("DCX", 0.4381))!;
    expect(up.change).toBe(0.006);
    expect(up.changeRate).toBe(1.39); // 예전: 0.01 → 2.31%
    const flat = applyTick(penny, tick("DCX", 0.434))!;
    expect(flat.change).toBe(0.0019);
    expect(flat.changeRate).toBe(0.44); // 예전: 0 → 0.00% (보합 색)
    const down = applyTick(penny, tick("DCX", 0.4299))!;
    expect(down.changeRate).toBe(-0.51);
    const tiny = applyTick(quote("GCDT", 0.05, { currency: "USD", prevClose: 0.05 }), tick("GCDT", 0.0537))!;
    expect(tiny.change).toBe(0.0037);
    expect(tiny.changeRate).toBe(7.4);
    // 당일 손익(등락 × 수량)도 1만 주면 +$60 (예전 +$100)
    expect(up.change * 10_000).toBeCloseTo(60, 6);
  });

  it("1달러 이상 종목은 예전과 같은 값", () => {
    const us = quote("AAPL", 201.37, { currency: "USD", prevClose: 201.37 });
    expect(applyTick(us, tick("AAPL", 203.12))).toMatchObject({ change: 1.75, changeRate: 0.87 });
  });
});

describe("streamUrl", () => {
  it("https → wss, 끝 슬래시 제거, 토큰 인코딩", () => {
    expect(streamUrl("https://example.com/", "a b&c")).toBe("wss://example.com/api/stream?token=a%20b%26c");
  });
  it("토큰이 없으면 쿼리 없음", () => expect(streamUrl("http://127.0.0.1:3000", "")).toBe("ws://127.0.0.1:3000/api/stream"));
});

describe("체결 묶음 적용 (3-17)", () => {
  it("같은 종목은 가장 늦은 체결 하나만", async () => {
    const { latestPerCode } = await import("@/lib/liveTick");
    const t = (code: string, price: number, ts: string): StreamTick => ({ code, price, volume: 1, timestamp: ts, source: "x" });
    const m = latestPerCode([t("A", 1, "2026-09-24T10:00:01+09:00"), t("A", 2, "2026-09-24T10:00:03+09:00"), t("A", 3, "2026-09-24T10:00:02+09:00"), t("B", 9, "2026-09-24T10:00:00+09:00")]);
    expect(m.get("A")!.price).toBe(2);
    expect(m.size).toBe(2);
  });

  it("바뀐 종목만 새 객체(그 줄만 다시 그림), 나머지·목록은 참조 유지", async () => {
    const { applyTicksToList, latestPerCode } = await import("@/lib/liveTick");
    const { holding } = await import("./helpers");
    const list = [
      holding("005930", quote("005930", 70_000, { asOf: "2026-09-24T10:00:00+09:00" }), 10, 60_000),
      holding("000660", quote("000660", 200_000, { asOf: "2026-09-24T10:00:00+09:00" }), 1, 150_000),
    ];
    const tick = (code: string, price: number): StreamTick => ({ code, price, volume: 1, timestamp: "2026-09-24T10:00:05+09:00", source: "x" });
    const next = applyTicksToList(list, latestPerCode([tick("005930", 70_500)]));
    expect(next).not.toBe(list);
    expect(next[0]).not.toBe(list[0]);
    expect(next[0]!.quote!.price).toBe(70_500);
    expect(next[0]!.evaluation!.marketValue).toBe(705_000);
    expect(next[1]).toBe(list[1]);
    // 같은 가격이면 목록도 그대로 (화면 커밋 없음)
    expect(applyTicksToList(list, latestPerCode([tick("005930", 70_000)]))).toBe(list);
  });
});
