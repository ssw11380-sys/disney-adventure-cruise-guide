import type { CodeStore } from "../providers/market/toss.js";
import { pushTvDay, type HtMarket, type TvDay } from "./holdingThemesCalc.js";

/**
 * 테마·업종 거래대금 기록 (3-35 내 종목 테마의 '거래대금 평소 대비'). 출처가 테마 거래대금의 과거를 주지 않아 이 앱이 거래일마다 장 마감 뒤 한 번 적는다.
 *  - 시장마다 meta 한 키 (holding-themes:tv:KR:v1 · …:US:v1), 최근 25거래일만 (이동 창 — 행이 쌓이지 않음, 마이그레이션 없음)
 *  - 휴장일은 적지 않는다(0 을 넣지 않음), 놓친 날은 빈칸 (값을 지어내지 않음) — 부르는 쪽이 그날이 거래일인지 확인하고 부른다
 */

export function tvKey(market: HtMarket): string {
  return `holding-themes:tv:${market}:v1`;
}

export class ThemeTvHistory {
  private readonly cache = new Map<HtMarket, TvDay[]>();
  /** 마지막으로 적은 거래일 (health) */
  readonly lastRecorded: Partial<Record<HtMarket, string>> = {};

  constructor(private readonly deps: { store?: CodeStore | null }) {}

  async days(market: HtMarket): Promise<TvDay[]> {
    const hit = this.cache.get(market);
    if (hit) return hit;
    let days: TvDay[] = [];
    try {
      const raw = await this.deps.store?.get(tvKey(market));
      const v = raw ? (JSON.parse(raw) as { v?: number; days?: TvDay[] }) : null;
      if (v?.v === 1 && Array.isArray(v.days)) days = v.days.filter((d) => d && typeof d.day === "string" && d.tv && typeof d.tv === "object");
    } catch {
      /* 깨진 기록은 없는 것으로 (새로 모은다) */
    }
    this.cache.set(market, days);
    return days;
  }

  /** 하루 기록 넣기 (같은 날은 바꿈). 빈 기록은 넣지 않는다 */
  async record(market: HtMarket, day: string, tv: Record<string, number>): Promise<number> {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(tv)) if (Number.isFinite(v) && v >= 0) clean[k] = Math.round(v);
    if (!Object.keys(clean).length) return 0;
    const next = pushTvDay(await this.days(market), { day, tv: clean });
    await this.deps.store?.set(tvKey(market), JSON.stringify({ v: 1, days: next }));
    this.cache.set(market, next);
    this.lastRecorded[market] = day;
    return Object.keys(clean).length;
  }
}
