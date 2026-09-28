import { describe, expect, it } from "vitest";
import type { CandlePeriod, CandleSeries } from "../src/domain/types.js";
import { CandleCache } from "../src/services/candleCache.js";

const series = (code: string, period: CandlePeriod, n: number, tag = 0): CandleSeries => ({
  code,
  period,
  source: "fake",
  candles: Array.from({ length: n }, (_, i) => ({ date: `2026-${String(1 + (i % 12)).padStart(2, "0")}-01`, open: i, high: i + tag, low: i, close: i + tag, volume: 1 })),
});

describe("차트 봉 캐시 (3-18)", () => {
  it("두 번째 요청은 서버에 다시 묻지 않고, 적게 달라면 받아 둔 것을 잘라 준다", async () => {
    let calls = 0;
    let t = 0;
    const c = new CandleCache(async (code, p, n) => (calls++, series(code, p, n)), () => t);
    expect((await c.get("005930", "D", 800)).candles).toHaveLength(800);
    expect((await c.get("005930", "D", 800)).candles).toHaveLength(800);
    expect((await c.get("005930", "D", 90)).candles).toHaveLength(90);
    expect(calls).toBe(1);
    expect(c.stats).toMatchObject({ hits: 2, misses: 1 });
  });

  it("오래되면 받아 둔 값을 바로 주고 뒤에서 새로 받는다, 너무 오래되면 기다려 새로 받는다", async () => {
    let calls = 0;
    let t = 0;
    const c = new CandleCache(async (code, p, n) => (calls++, series(code, p, n, calls)), () => t);
    await c.get("005930", "D", 10);
    t += 61_000;
    const stale = await c.get("005930", "D", 10);
    expect(stale.candles[0]!.close).toBe(0 + 1); // 옛 값(첫 번째로 받은 것)
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2); // 뒤에서 새로
    expect((await c.get("005930", "D", 10)).candles[0]!.close).toBe(2);
    t += 13 * 3_600_000;
    expect((await c.get("005930", "D", 10)).candles[0]!.close).toBe(3); // 12시간 넘으면 기다려서 새 값
  });

  it("더 많이 달라면 새로 받고, 상장 기간이 짧아 원래 적으면 다시 묻지 않는다", async () => {
    let calls = 0;
    const c = new CandleCache(async (code, p, n) => (calls++, series(code, p, Math.min(n, 50))), () => 0);
    await c.get("NEW", "M", 10);
    await c.get("NEW", "M", 120); // 10개만 받아 둠 → 새로 (50개뿐)
    await c.get("NEW", "M", 120); // 50 < 120 이지만 원래 50개뿐 → 캐시 (새 값일 때만)
    expect(calls).toBe(2);
  });

  it("받은 개수가 모자란 봉은 새 값 시간(60초)이 지나면 더 많이 달라는 요청에 다시 받는다", async () => {
    let calls = 0;
    let t = 0;
    const c = new CandleCache(async (code, p, n) => (calls++, series(code, p, Math.min(n, 50))), () => t);
    await c.get("NEW", "M", 120);
    t += 61_000;
    await c.get("NEW", "M", 120);
    expect(calls).toBe(2);
  });

  it("받은 뒤 장 구간이 바뀌면(개장 등) 옛 봉을 주지 않고 기다려 새로 받는다", async () => {
    let calls = 0;
    let t = 0;
    let session = { key: "closed", regular: false };
    const c = new CandleCache(async (code, p, n) => (calls++, series(code, p, n, calls)), () => t, () => session);
    await c.get("005930", "D", 10);
    t += 30 * 60_000;
    expect((await c.get("005930", "D", 10)).candles[0]!.close).toBe(1); // 같은 구간: 옛 값 바로
    await new Promise((r) => setTimeout(r, 0));
    session = { key: "regular", regular: true };
    t += 1_000;
    expect((await c.get("005930", "D", 10)).candles[0]!.close).toBe(3); // 구간이 바뀜 → 기다려 새 값
    t += 11 * 60_000; // 정규장 중 일봉은 10분 넘으면 기다린다
    expect((await c.get("005930", "D", 10)).candles[0]!.close).toBe(4);
    expect(c.stats).toMatchObject({ misses: 3, stale: 1 });
  });

  it("받는 중인 것보다 많이 달라면 끝난 뒤 이어서 한 번 더 받는다", async () => {
    const asked: number[] = [];
    const c = new CandleCache(async (code, p, n) => {
      asked.push(n);
      await new Promise((r) => setTimeout(r, 5));
      return series(code, p, n);
    }, () => 0);
    const [a, b, d] = await Promise.all([c.get("A", "D", 90), c.get("A", "D", 800), c.get("A", "D", 300)]);
    expect(a.candles).toHaveLength(90);
    expect(b.candles).toHaveLength(800);
    expect(d.candles).toHaveLength(300);
    expect(asked).toEqual([90, 800]);
  });

  it("같은 요청이 겹치면 한 번만, 새로 받기가 실패하면 받아 둔 값을 쓴다", async () => {
    let calls = 0;
    let fail = false;
    let t = 0;
    const c = new CandleCache(async (code, p, n) => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      if (fail) throw new Error("down");
      return series(code, p, n);
    }, () => t);
    await Promise.all([c.get("A", "5m", 100), c.get("A", "5m", 100), c.get("A", "5m", 100)]);
    expect(calls).toBe(1);
    fail = true;
    t += 6 * 60_000; // 분봉 5분 넘음 → 기다려 새로 받는데 실패 → 옛 값
    expect((await c.get("A", "5m", 100)).candles).toHaveLength(100);
    await expect(c.get("B", "5m", 100)).rejects.toThrow("down");
  });

  it("maxAgeMs (지표 점수 장 마감 뒤 계산): 같은 장 구간이라도 그보다 오래 받아 둔 봉은 기다려 새로 받고, 실패하면 옛 봉 대신 오류", async () => {
    let calls = 0;
    let fail = false;
    let t = 0;
    // 미국 16:00~20:00 ET 는 한 장 구간 — 마감 직후(16:01) 받아 둔 봉이 17:30 에도 12시간 한도 안이라 그냥 나오던 것
    const c = new CandleCache(async (code, p, n) => {
      calls++;
      if (fail) throw new Error("down");
      return series(code, p, n, calls);
    }, () => t, () => ({ key: "US|extended", regular: false }));
    await c.get("NVDA", "D", 310);
    t += 89 * 60_000;
    expect((await c.get("NVDA", "D", 310)).candles[0]!.close).toBe(1); // 차트: 옛 값 바로 (뒤에서 새로)
    await new Promise((r) => setTimeout(r, 0));
    t += 2 * 60_000;
    const before = calls;
    expect((await c.get("NVDA", "D", 310, { maxAgeMs: 60_000 })).candles[0]!.close).toBe(before + 1); // 기다려 새 값
    expect(calls).toBe(before + 1);
    expect((await c.get("NVDA", "D", 310, { maxAgeMs: 60_000 })).candles[0]!.close).toBe(before + 1); // 1분 안이면 받아 둔 것
    fail = true;
    t += 2 * 60_000;
    await expect(c.get("NVDA", "D", 310, { maxAgeMs: 60_000 })).rejects.toThrow("봉을 새로 받지 못함");
    expect((await c.get("NVDA", "D", 310)).candles[0]!.close).toBe(before + 1); // 차트는 예전처럼 받아 둔 값
  });

  it("shared (계정 A단계 검증 7차 — 주인 아닌 계정): 새 값 시간 안의 봉만 캐시에서, 지나면 기다려 새로 받고 실패하면 처음 보는 종목과 같은 오류. 받아 둔 개수는 줄이지 않는다", async () => {
    const asked: number[] = [];
    let fail = false;
    let t = 0;
    const c = new CandleCache(async (code, p, n) => {
      asked.push(n);
      if (fail) throw new Error(`down ${code}`);
      return series(code, p, n, asked.length);
    }, () => t);
    await c.get("A", "D", 800); // 주인 차트 (서버가 켤 때 미리 받기와 같은 개수)
    t += 30_000;
    expect((await c.get("A", "D", 120, { shared: true })).candles).toHaveLength(120); // 60초 안: 받아 둔 것
    expect(asked).toEqual([800]);
    t += 60_000; // 90초 — 주인에게는 옛 값을 바로 주는 나이(정규장 10분·장 밖 12시간 안)
    const seen = await c.get("A", "D", 120, { shared: true });
    expect(seen.candles.at(-1)!.close).toBe(799 + 2); // 기다려 새 값
    expect(asked).toEqual([800, 800]); // 800개를 그대로 다시 받음 (주인 차트가 다시 받지 않게)
    expect((await c.get("A", "D", 800)).candles).toHaveLength(800);
    expect(asked).toHaveLength(2);
    // 새로 받기 실패: 받아 둔 봉이 있어도 처음 보는 종목(B)과 같은 오류
    fail = true;
    t += 120_000;
    await expect(c.get("A", "D", 120, { shared: true })).rejects.toThrow("down A");
    await expect(c.get("B", "D", 120, { shared: true })).rejects.toThrow("down B");
    // 주인 차트는 예전처럼 받아 둔 값
    expect((await c.get("A", "D", 120)).candles.at(-1)!.close).toBe(799 + 2);
  });
});
