import { describe, expect, it } from "vitest";
import type { Candle } from "../src/domain/types.js";
import { volumeStatus, volumeWindow } from "../src/services/volumeBaseline.js";
import { aBars, bar, halfHours, tradingDaysBefore } from "./volumeBars.js";

/**
 * 거래량 급증 (3-29, 작업지시 7장 A~J): 오늘 정규장 누적 ÷ 지난 거래일(최대 20)의 '개장 뒤 같은 경과 시간' 누적 평균.
 * 봉 안은 고르게 나눠 세고, 정규장 밖 봉은 빼고, 450개로 잘린 맨 앞 날은 뺀다. 기대값은 작업지시 식을 그대로 옮겨 계산한 값
 */
const KR = "005930";
const US = "AAPL";
const at = (iso: string) => new Date(iso);

/** 뉴욕 현지 시각 글자 → 같은 순간의 서울 시각 글자 (토스가 미국 봉 시각을 서울 오프셋으로 줄 때 흉내) */
function seoulText(nyIso: string): string {
  const t = Date.parse(nyIso) + 9 * 3_600_000;
  return `${new Date(t).toISOString().slice(0, 19)}+09:00`;
}
/** 서울 오프셋으로 적은 미국 봉 (hhmm = 뉴욕 봉 시작, 시각은 끝나는 시각 · date = 시각 글자 앞 10자 — 뉴욕 10:00 뒤 봉은 다음 날이 된다) */
function usBarSeoul(date: string, hhmm: string, volume: number): Candle {
  const time = seoulText(new Date(Date.parse(`${date}T${hhmm}:00-05:00`) + 30 * 60_000).toISOString());
  return { date: time.slice(0, 10), time, open: 1, high: 1, low: 1, close: 1, volume };
}

describe("거래량 급증 기준 (volumeBaseline)", () => {
  it("A 기본: 지난 20거래일(수능일 11/19 포함 — 그날 개장 10:00 기준으로 맞춤)과 같은 경과 시간으로 견준다", () => {
    const candles = aBars();
    expect(candles).toHaveLength(328);
    expect(volumeStatus(KR, candles, at("2026-12-08T10:15:00+09:00"))).toMatchObject({ status: "ok", date: "2026-12-08", minutes: 75, days: 20, volume: 7500, expected: 2500, ratio: 3, reason: null, asOf: "2026-12-08T10:15:00+09:00" });
  });

  it("B 450개 잘림 + 정규장 밖 봉(NXT 프리·애프터) 제외: 잘린 맨 앞 날(11/11)은 평균에서 뺀다", () => {
    const all: Candle[] = [];
    for (const d of tradingDaysBefore("2026-12-08", 25)) {
      for (const t of halfHours("08:00", "19:30")) {
        const v = t < "09:00" ? 500 : t <= "15:00" ? 1000 : 200;
        all.push(bar(d, t, v));
      }
    }
    all.push(bar("2026-12-08", "08:00", 5000), bar("2026-12-08", "08:30", 5000), bar("2026-12-08", "09:00", 3000), bar("2026-12-08", "09:30", 3000), bar("2026-12-08", "10:00", 1500));
    expect(all).toHaveLength(605);
    const last = all.slice(-450);
    expect(last[0]!.time).toBe("2026-11-11T14:00:00+09:00"); // 13:30~14:00 봉 (시각은 끝나는 때)
    expect(volumeStatus(KR, last, at("2026-12-08T10:15:00+09:00"))).toMatchObject({ status: "ok", days: 18, volume: 7500, expected: 2500, ratio: 3 });
  });

  it("C 수능일 오늘: 10:00 개장으로 경과 시간을 잰다", () => {
    const candles: Candle[] = [];
    for (const d of tradingDaysBefore("2026-11-19", 25)) for (const t of halfHours("09:00", "15:00")) candles.push(bar(d, t, 1000));
    candles.push(bar("2026-11-19", "10:00", 2000), bar("2026-11-19", "10:30", 1000));
    expect(volumeStatus(KR, candles, at("2026-11-19T10:40:00+09:00"))).toMatchObject({ status: "ok", minutes: 40, days: 20, volume: 3000, expected: 1333, ratio: 2.25 });
  });

  it("D 개장 뒤 첫 30분은 확인하지 않는다 (early)", () => {
    const now = at("2026-12-08T09:20:00+09:00");
    expect(volumeWindow(KR, now)).toEqual({ state: "early", date: "2026-12-08", minutes: 20 });
    expect(volumeStatus(KR, aBars(), now)).toMatchObject({ status: "early", date: "2026-12-08", minutes: 20, volume: null, ratio: null, days: 0, reason: "개장 뒤 30분 전" });
  });

  it("E 정규장 밖·주말·휴장일은 closed (date null), 마감 1분 전은 open", () => {
    for (const iso of ["2026-12-08T15:30:00+09:00", "2026-12-05T10:00:00+09:00", "2026-10-09T10:00:00+09:00"]) {
      expect(volumeWindow(KR, at(iso))).toEqual({ state: "closed", date: null, minutes: null });
      expect(volumeStatus(KR, aBars(), at(iso))).toMatchObject({ status: "closed", date: null, minutes: null, reason: "정규장 시간이 아님" });
    }
    expect(volumeWindow(KR, at("2026-12-08T15:29:00+09:00"))).toEqual({ state: "open", date: "2026-12-08", minutes: 389 });
  });

  it("F 지난 거래일이 5일 미만이면 견주지 않는다 (short)", () => {
    const candles: Candle[] = [];
    for (const d of tradingDaysBefore("2026-12-08", 4)) for (const t of halfHours("09:00", "15:00")) candles.push(bar(d, t, 1000));
    candles.push(bar("2026-12-08", "09:00", 3000));
    expect(volumeStatus(KR, candles, at("2026-12-08T10:15:00+09:00"))).toMatchObject({ status: "short", days: 4, volume: null, ratio: null, reason: "지난 거래일 30분봉이 4일뿐이라 견줄 수 없음" });
  });

  it("지난 거래일 같은 시각 거래량이 모두 0 이면 short (0 으로 나누지 않음)", () => {
    const candles: Candle[] = [];
    for (const d of tradingDaysBefore("2026-12-08", 6)) for (const t of halfHours("09:00", "15:00")) candles.push(bar(d, t, 0));
    candles.push(bar("2026-12-08", "09:00", 3000));
    expect(volumeStatus(KR, candles, at("2026-12-08T10:15:00+09:00"))).toMatchObject({ status: "short", days: 6, reason: "지난 거래일 같은 시각 거래량이 0" });
  });

  it("G 미국: 뉴욕 현지 정규장(09:30~)으로, 추수감사절 휴장·다음 날 조기 폐장을 맞춘다", () => {
    const candles: Candle[] = [];
    for (const d of tradingDaysBefore("2026-12-08", 25, false)) {
      const times = d === "2026-11-27" ? halfHours("09:30", "12:30") : halfHours("09:30", "15:30");
      for (const t of times) candles.push(bar(d, t, 1000, "-05:00"));
    }
    expect(tradingDaysBefore("2026-12-08", 25, false)[0]).toBe("2026-11-02");
    candles.push(bar("2026-12-08", "09:30", 4000, "-05:00"), bar("2026-12-08", "10:00", 2000, "-05:00"));
    expect(volumeStatus(US, candles, at("2026-12-09T00:30:00+09:00"))).toMatchObject({ status: "ok", date: "2026-12-08", minutes: 60, days: 20, volume: 6000, expected: 2000, ratio: 3 });
  });

  it("H 서머타임이 끝난 주: 지난 날은 -04:00, 오늘은 -05:00 이어도 뉴욕 현지 시각끼리 견준다", () => {
    const days = tradingDaysBefore("2026-11-02", 25, false);
    expect(days[0]).toBe("2026-09-28");
    expect(days.at(-1)).toBe("2026-10-30");
    const candles: Candle[] = [];
    // 오프셋은 날짜로: 2026-11-01 까지 -04:00, 11/2 부터 -05:00
    for (const d of days) for (const t of halfHours("09:30", "15:30")) candles.push(bar(d, t, 1000, d <= "2026-11-01" ? "-04:00" : "-05:00"));
    candles.push(bar("2026-11-02", "09:30", 4000, "-05:00"), bar("2026-11-02", "10:00", 2000, "-05:00"));
    expect(volumeStatus(US, candles, at("2026-11-03T00:30:00+09:00"))).toMatchObject({ status: "ok", date: "2026-11-02", minutes: 60, days: 20, volume: 6000, expected: 2000, ratio: 3 });
  });

  it("I 뉴욕 20:00 뒤(주간거래 시각)는 closed, 개장 29분 뒤 early, 30분 뒤 open", () => {
    expect(volumeWindow(US, at("2026-12-08T11:00:00+09:00")).state).toBe("closed");
    expect(volumeWindow(US, at("2026-12-08T23:59:00+09:00"))).toEqual({ state: "early", date: "2026-12-08", minutes: 29 });
    expect(volumeWindow(US, at("2026-12-09T00:00:00+09:00"))).toEqual({ state: "open", date: "2026-12-08", minutes: 30 });
  });

  it("J 미국 450개 잘림 (서울 오프셋으로 적힌 봉): 잘린 날은 date 칸이 아니라 봉 시각의 뉴욕 날짜(11/17)로 뺀다", () => {
    const all: Candle[] = [];
    const days = tradingDaysBefore("2026-12-08", 25, false);
    for (const d of days) {
      for (const t of halfHours("04:00", "09:00")) all.push(usBarSeoul(d, t, 200));
      const early = d === "2026-11-27";
      for (const t of halfHours("09:30", early ? "12:30" : "15:30")) all.push(usBarSeoul(d, t, 1000));
      for (const t of early ? halfHours("13:00", "16:30") : halfHours("16:00", "19:30")) all.push(usBarSeoul(d, t, 100));
    }
    // 12/7 20:00 ~ 12/8 03:30 주간거래 16개
    for (const t of halfHours("20:00", "23:30")) all.push(usBarSeoul("2026-12-07", t, 300));
    for (const t of halfHours("00:00", "03:30")) all.push(usBarSeoul("2026-12-08", t, 300));
    for (const t of halfHours("04:00", "09:00")) all.push(usBarSeoul("2026-12-08", t, 2000));
    all.push(usBarSeoul("2026-12-08", "09:30", 4000), usBarSeoul("2026-12-08", "10:00", 2000));
    expect(all).toHaveLength(823);
    const last = all.slice(-450);
    expect(last[0]!.time).toBe("2026-11-18T05:00:00+09:00"); // 뉴욕 11/17 14:30~15:00 봉
    expect(last[0]!.date).toBe("2026-11-18");
    expect(volumeStatus(US, last, at("2026-12-09T00:30:00+09:00"))).toMatchObject({ status: "ok", days: 13, volume: 6000, expected: 2000, ratio: 3 });
  });

  it("시각(time)이 없거나 읽을 수 없는 봉은 버린다", () => {
    const candles = [...aBars(), { date: "2026-12-08", open: 1, high: 1, low: 1, close: 1, volume: 99_999 }, { date: "2026-12-08", time: "?", open: 1, high: 1, low: 1, close: 1, volume: 99_999 }];
    expect(volumeStatus(KR, candles, at("2026-12-08T10:15:00+09:00"))).toMatchObject({ status: "ok", volume: 7500, ratio: 3 });
  });
});
