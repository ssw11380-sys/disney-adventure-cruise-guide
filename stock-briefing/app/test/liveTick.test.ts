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
});

describe("streamUrl", () => {
  it("https → wss, 끝 슬래시 제거, 토큰 인코딩", () => {
    expect(streamUrl("https://example.com/", "a b&c")).toBe("wss://example.com/api/stream?token=a%20b%26c");
  });
  it("토큰이 없으면 쿼리 없음", () => expect(streamUrl("http://127.0.0.1:3000", "")).toBe("ws://127.0.0.1:3000/api/stream"));
});
