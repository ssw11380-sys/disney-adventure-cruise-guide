import { isKrCode } from "../lib/codes.js";
import type { CompanyTic } from "../providers/market/tossCompanyTics.js";
import type { UsIndustry } from "../providers/market/naverIndustry.js";
import type { CodeStore } from "../providers/market/toss.js";

/**
 * 보유 종목별 분류 캐시 (3-35 내 종목 테마): 미국은 토스 회사 '주요 사업' 테마 + 네이버 업종 번호·로이터 코드, 한국은 네이버 업종 번호.
 *  - 종목마다 7일 캐시 (meta 한 키 — 보유 종목과 기초 종목만, 30일 넘게 묻지 않은 종목은 지움)
 *  - 예약 작업 없이 화면·브리핑이 부를 때 7일 지난 것만 새로 받는다. 첫 요청은 waitMs(기본 3초)까지만 기다리고 나머지는 '준비 중'
 *  - 받기 실패: 옛 값이 있으면 그대로 쓰고, 없으면 'failed' (5분 동안 다시 묻지 않음)
 *  - 미국 두 출처 중 한쪽만 받은 때(부분 실패): 받은 쪽만 바꾸고 받지 못한 쪽은 옛 값(없으면 null) 그대로, 받은 시각(at)은 새로 하지 않는다
 *    (partialAt 에 적고 5분 뒤 다시 받는다 — 한 번의 시간 초과가 7일 동안 굳지 않게)
 */

export interface MapItem {
  /** 모든 출처를 받은 시각 (7일 캐시 기준). 한쪽만 받았으면 옛 값의 시각 그대로(없으면 0) */
  at: number;
  /** 토스 주요 사업 테마 (미국만, 받지 못했으면 null) */
  tics: CompanyTic[] | null;
  /** 네이버 업종 번호 (없으면 null) */
  industry: string | null;
  /** 네이버 로이터 코드 (미국만) */
  reuters?: string | null;
  /** 마지막으로 물은 시각 (오래 안 물은 종목 지우기) */
  askedAt?: number;
  /** 한쪽 출처만 받은 시각 (그 뒤 5분이 지나면 다시 받는다). 모두 받았으면 없음 */
  partialAt?: number;
  /** 받지 못한 출처 (partialAt 과 같이) — 'tics' 토스 회사 테마 · 'industry' 네이버 업종·로이터 코드 */
  missing?: Array<"tics" | "industry">;
}

export interface MapSources {
  /** 미국 티커 → 토스 주요 사업 테마 (상품 코드 → 회사 코드 → 회사 테마) */
  usTics?: ((code: string) => Promise<CompanyTic[]>) | null;
  usIndustry?: ((code: string) => Promise<UsIndustry | null>) | null;
  krIndustry?: ((code: string) => Promise<string | null>) | null;
}

export interface MapLookup {
  item: MapItem | null;
  /** 아직 받는 중 (옛 값도 없음) */
  pending: boolean;
  /** 받지 못함 (옛 값도 없음) */
  failed: boolean;
}

export const MAPS_KEY = "holding-themes:maps:v1";
const FRESH_MS = 7 * 24 * 3_600_000;
const FORGET_MS = 30 * 24 * 3_600_000;
const FAIL_BACKOFF_MS = 5 * 60_000;
const CONCURRENCY = 4;

type Log = { warn?: (o: unknown, m?: string) => void };

export class HoldingThemeMaps {
  private readonly items = new Map<string, MapItem>();
  private loadP: Promise<void> | null = null;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly failedAt = new Map<string, number>();
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  private lastSavedAt: number | null = null;

  constructor(private readonly deps: { sources: MapSources; store?: CodeStore | null; now?: () => Date; log?: Log }) {}

  private get t(): number {
    return (this.deps.now ?? (() => new Date()))().getTime();
  }

  private load(): Promise<void> {
    this.loadP ??= (async () => {
      try {
        const raw = await this.deps.store?.get(MAPS_KEY);
        const v = raw ? (JSON.parse(raw) as { v?: number; items?: Record<string, MapItem> }) : null;
        if (v?.v === 1 && v.items) for (const [code, it] of Object.entries(v.items)) if (it && typeof it.at === "number" && !this.items.has(code)) this.items.set(code, it);
      } catch {
        /* 깨진 저장본은 없는 것으로 */
      }
    })();
    return this.loadP;
  }

  /** 가장 최근에 받은 시각 (health) */
  get updatedAt(): number | null {
    return this.lastSavedAt;
  }

  /**
   * 종목들의 분류. 7일 지난 것·없는 것은 받기 시작하고 waitMs 까지만 기다린다 (그 뒤에도 뒤에서 계속 받는다)
   */
  async lookup(codes: readonly string[], waitMs = 3_000): Promise<Map<string, MapLookup>> {
    await this.load();
    const t = this.t;
    const started: Promise<void>[] = [];
    for (const code of new Set(codes)) {
      const it = this.items.get(code);
      if (it) it.askedAt = t;
      if (it && it.partialAt === undefined && t - it.at < FRESH_MS) continue;
      // 한쪽만 받은 종목은 5분 뒤 다시 (그 사이에는 받은 쪽 값으로)
      if (it?.partialAt !== undefined && t - it.partialAt < FAIL_BACKOFF_MS) continue;
      const f = this.failedAt.get(code);
      if (f !== undefined && t - f < FAIL_BACKOFF_MS) continue;
      started.push(this.refresh(code));
    }
    if (started.length) await waitAtMost(Promise.allSettled(started), waitMs);
    const out = new Map<string, MapLookup>();
    for (const code of new Set(codes)) {
      const item = this.items.get(code) ?? null;
      out.set(code, { item, pending: !item && this.inflight.has(code), failed: !item && !this.inflight.has(code) && this.failedAt.has(code) });
    }
    return out;
  }

  private refresh(code: string): Promise<void> {
    const running = this.inflight.get(code);
    if (running) return running;
    const p = new Promise<void>((resolve) => {
      this.queue.push(async () => {
        try {
          await this.fetchOne(code);
        } finally {
          resolve();
        }
      });
      this.pump();
    }).finally(() => this.inflight.delete(code));
    this.inflight.set(code, p);
    return p;
  }

  private pump(): void {
    while (this.running < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void job().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async fetchOne(code: string): Promise<void> {
    const s = this.deps.sources;
    const old = this.items.get(code) ?? null;
    let ok = false;
    let tics: CompanyTic[] | null = old?.tics ?? null;
    let industry: string | null = old?.industry ?? null;
    let reuters: string | null = old?.reuters ?? null;
    const missing: Array<"tics" | "industry"> = [];
    if (isKrCode(code)) {
      if (s.krIndustry) {
        try {
          industry = await s.krIndustry(code);
          ok = true;
        } catch {
          /* 옛 값 */
        }
      }
    } else {
      // 두지 않은 출처는 받을 것이 없다 (받지 못한 것으로 세지 않음)
      const [a, b] = await Promise.allSettled([s.usTics ? s.usTics(code) : Promise.resolve(undefined), s.usIndustry ? s.usIndustry(code) : Promise.resolve(undefined)]);
      if (a.status === "fulfilled") {
        if (a.value !== undefined) {
          tics = a.value;
          ok = true;
        }
      } else missing.push("tics");
      if (b.status === "fulfilled") {
        if (b.value !== undefined) {
          industry = b.value?.industry ?? null;
          reuters = b.value?.reuters ?? null;
          ok = true;
        }
      } else missing.push("industry");
      // 토스를 받지 못했는데 옛 값도 없으면 tics 는 null (받지 못함) — 업종으로 묶고 까닭을 남긴다 (5분 뒤 다시 받는다)
    }
    const t = this.t;
    if (!ok) {
      this.failedAt.set(code, t);
      return;
    }
    this.failedAt.delete(code);
    const base = { tics, industry, ...(isKrCode(code) ? {} : { reuters }), askedAt: t };
    // 한쪽만 받았으면 받은 시각을 새로 하지 않는다 (7일 동안 굳지 않게) — 5분 뒤 다시
    this.items.set(code, missing.length ? { at: old?.at ?? 0, ...base, partialAt: t, missing } : { at: t, ...base });
    await this.save();
  }

  private async save(): Promise<void> {
    const t = this.t;
    for (const [code, it] of this.items) if (t - (it.askedAt ?? it.at) > FORGET_MS) this.items.delete(code);
    try {
      await this.deps.store?.set(MAPS_KEY, JSON.stringify({ v: 1, items: Object.fromEntries(this.items) }));
      this.lastSavedAt = t;
    } catch (e) {
      this.deps.log?.warn?.({ err: String(e) }, "내 종목 테마 분류 저장 실패");
    }
  }
}

async function waitAtMost<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((res) => (timer = setTimeout(() => res(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
