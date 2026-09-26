/**
 * 테스트용 RGTX 모양 일봉 (2026-09-26 사용자 접은 화면 캡처와 같은 모양 — 검증 화면 캡처에 쓴 모의 서버와 같은 식).
 * 보이는 마지막 120봉: 5월 15~20달러 → 6월 급등(약 44달러) → 떨어져 9월 10달러대 (오늘이 52주 신저가 근처).
 * 그 앞은 훨씬 높은 값이라 120일선이 왼쪽 끝에서 약 80달러 (캡처의 보라 선). 값은 달러, fx 를 곱하면 원화 (캡처는 1달러 1,391.5원).
 * 봉 수(count)가 같아야 같은 모양이다 — 앱이 일봉을 받는 개수 CANDLE_COUNT.D(800)가 기본
 */
export const RGTX_FX = 1391.5;
/** 시세: 현재가·전일 종가·평단(보유 520주)·52주 최고·최저 (달러) */
export const RGTX_QUOTE = { price: 10.61, prevClose: 10.39, avg: 13.7, high52w: 501.8, low52w: 9.62 } as const;

const r2 = (v: number) => Math.round(v * 100) / 100;

export function rgtxDaily(count = 800, fx = 1): { date: string; open: number; high: number; low: number; close: number; volume: number }[] {
  const n = Math.max(1, Math.min(count, 800));
  let seed = 12345;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let u = 0;
    for (let i = 0; i < 6; i++) u += rnd();
    return (u - 3) / 1.2;
  };
  const KNOTS: [number, number][] = [
    [0, 15.5], [0.1, 18.5], [0.15, 20], [0.22, 16.5], [0.27, 30], [0.3, 44], [0.33, 40], [0.4, 25], [0.48, 17],
    [0.55, 12.5], [0.65, 10.1], [0.72, 11], [0.8, 11.9], [0.86, 11.2], [0.92, 10.3], [0.97, 10.8], [1, 10.61],
  ];
  const target = (j: number) => {
    if (j < 120) {
      const t = (119 - j) / 119;
      for (let k = 1; k < KNOTS.length; k++) {
        const [t0, v0] = KNOTS[k - 1]!, [t1, v1] = KNOTS[k]!;
        if (t <= t1) return v0 + ((t - t0) / (t1 - t0)) * (v1 - v0);
      }
      return 10.61;
    }
    return Math.min(300, 15.5 * Math.exp(0.023 * (j - 120)));
  };
  const dates: string[] = [];
  const d = new Date("2026-09-24T00:00:00Z");
  while (dates.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  dates.reverse();
  const closes = Array.from({ length: n }, (_, i) => {
    const j = n - 1 - i;
    return j === 0 ? 10.61 : j === 1 ? 10.39 : r2(target(j) * (1 + 0.035 * gauss()));
  });
  return closes.map((close, i) => {
    const open = i === 0 ? close : r2(closes[i - 1]! * (1 + 0.02 * gauss()));
    const high = r2(Math.max(open, close) * (1 + Math.abs(0.025 * gauss())));
    const low = r2(Math.min(open, close) * (1 - Math.abs(0.025 * gauss())));
    const j = n - 1 - i;
    const spike = j < 120 && j > 80 && j < 95 ? 5 : 1;
    const volume = Math.round(2_000_000 * (0.5 + rnd()) * spike);
    return { date: dates[i]!, open: open * fx, high: high * fx, low: low * fx, close: close * fx, volume };
  });
}
