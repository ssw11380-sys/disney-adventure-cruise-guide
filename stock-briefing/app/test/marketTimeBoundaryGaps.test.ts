import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Candle } from "@/api/types";
import { candleRefresh } from "@/lib/freshness";
import { inTradingHours, tradingNow } from "@/lib/marketTime";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
const { applyTickToCandles } = await import("@/lib/chartPrefs");

describe("미국 조기 폐장일의 실제 거래 시간 경계", () => {
  it.each(["2026-11-27", "2026-12-24", "2027-11-26"])("%s 애프터마켓 끝 17시부터 차트 반복 조회도 멈춘다", (date) => {
    expect(inTradingHours(`${date}T16:59:59-05:00`, "AAPL")).toBe(true);
    expect(inTradingHours(`${date}T17:00:00-05:00`, "AAPL")).toBe(false);
    expect(inTradingHours(`${date}T19:59:59-05:00`, "AAPL")).toBe(false);
    expect(tradingNow("AAPL", undefined, Date.parse(`${date}T17:00:00-05:00`))).toBe(false);
  });

  it("평소 애프터마켓과 휴장 뒤 주간거래 시작은 유지한다", () => {
    expect(inTradingHours("2026-11-25T19:59:59-05:00", "AAPL")).toBe(true);
    expect(inTradingHours("2026-11-25T20:00:00-05:00", "AAPL")).toBe(false);
    expect(inTradingHours("2026-11-26T20:00:00-05:00", "AAPL")).toBe(true);
  });

  it("종료 뒤 받은 값 그대로의 체결로 새 분봉을 열지 않고 차트 조회 주기를 끈다", () => {
    const candles: Candle[] = [{ date: "2026-11-27", time: "2026-11-27T16:59:00-05:00", open: 100, high: 100, low: 100, close: 100, volume: 5 }];
    expect(applyTickToCandles(candles, "1m", 100, "2026-11-27T17:01:00-05:00", "AAPL")).toBe(candles);
    expect(candleRefresh("1m", tradingNow("AAPL", undefined, Date.parse("2026-11-27T17:01:00-05:00"))).refetchInterval).toBe(false);
    expect(candleRefresh("1m", tradingNow("AAPL", undefined, Date.parse("2026-11-27T16:59:00-05:00"))).refetchInterval).toBe(30_000);
  });

  it("서버와 앱의 조기 폐장일 목록이 같아 다음 해 추가도 함께 반영한다", () => {
    const dates = (path: string) => {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      const body = source.match(/const US_EARLY_CLOSES = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
      return [...body.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
    };
    const app = dates("src/lib/marketTime.ts");
    expect(app.length).toBeGreaterThan(0);
    expect(app).toEqual(dates("../backend/src/services/marketContext.ts"));
  });
});
