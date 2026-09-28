import type { NaverDiscover } from "../providers/market/naverDiscover.js";
import type { CodeStore } from "../providers/market/toss.js";

/**
 * 한국 네이버 테마의 '종목 → 테마' 거꾸로 찾는 표 (3-35 내 종목 테마). 네이버는 종목 → 테마 주소가 없어(2026-09-29 확인) 테마 목록(약 264개) +
 * 테마마다 구성 종목(발견 탭과 같은 NaverDiscover.sectors·sectorDetail)을 받아 만든다. 주 1회(일요일 05:40 KST) + 표가 없거나 8일 넘었으면 서버를 켤 때.
 *  - 요청 사이 pauseMs(기본 0.3초) 쉼 — 테마북·krUpjong 과 같은 예의 (실측 약 300번 · 약 100초)
 *  - 줄어듦 방지: 옛 표가 있으면 구성 받기 실패가 10% 넘거나 테마 수가 옛 표의 80% 미만이면 옛 표를 그대로 둔다.
 *    80% 미만이 두 번 이어 비슷한 크기로 나오면 실제로 줄어든 것으로 보고 받아들인다 (미국 테마북과 같은 규칙)
 *  - meta 표 한 키 (이미 백업되는 표, 마이그레이션 없음)
 */

export interface KrThemeIndexData {
  v: 1;
  builtAt: number;
  /** 테마 id → 이름 */
  themes: Record<string, string>;
  /** 종목 코드 → 테마 id 목록 */
  members: Record<string, string[]>;
}

type Log = { info?: (o: unknown, m?: string) => void; warn?: (o: unknown, m?: string) => void };

export const KR_INDEX_KEY = "holding-themes:kr-index:v1";
/** 이보다 오래된 표는 서버를 켤 때 새로 만든다 */
export const KR_INDEX_STALE_MS = 8 * 24 * 3_600_000;
/**
 * 만들기가 실패한 뒤 저절로(ensure — 화면·브리핑 요청마다 부른다) 다시 만들기 전에 쉬는 시간.
 * 실패 뒤 곧바로 다시 하면 요청마다 전체 받기(약 265번)를 되풀이한다 (출처가 빈도 제한을 걸면 더 심해짐). 예약 작업·관리 경로(build)는 쉬지 않는다
 */
export const KR_INDEX_RETRY_MS = 30 * 60_000;

export class KrThemeIndex {
  private data: KrThemeIndexData | null = null;
  private loadP: Promise<void> | null = null;
  private building: Promise<KrThemeIndexData> | null = null;
  /** 너무 작다고 버린 직전 결과의 테마 수 */
  private shrunk: number | null = null;
  /** 마지막 만들기 결과 (health 경고용) */
  lastError: string | null = null;
  /** 마지막으로 만들기가 실패한 시각 (ensure 가 KR_INDEX_RETRY_MS 동안 다시 하지 않는다) */
  private failedAt: number | null = null;

  constructor(
    private readonly deps: {
      naver: Pick<NaverDiscover, "sectors" | "sectorDetail">;
      store?: CodeStore | null;
      now?: () => Date;
      log?: Log;
      pauseMs?: number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  private get t(): number {
    return (this.deps.now ?? (() => new Date()))().getTime();
  }

  private load(): Promise<void> {
    this.loadP ??= (async () => {
      try {
        const raw = await this.deps.store?.get(KR_INDEX_KEY);
        const v = raw ? (JSON.parse(raw) as KrThemeIndexData) : null;
        if (v?.v === 1 && v.themes && v.members && typeof v.builtAt === "number" && !this.data) this.data = v;
      } catch {
        /* 깨진 저장본은 없는 것으로 (새로 만든다) */
      }
    })();
    return this.loadP;
  }

  /** 지금 가진 표 (없으면 null — 처음 만드는 중이거나 아직 만들지 않음) */
  async get(): Promise<KrThemeIndexData | null> {
    await this.load();
    return this.data;
  }

  get isBuilding(): boolean {
    return this.building !== null;
  }

  /** 표가 없거나 maxAgeMs 보다 오래됐으면 뒤에서 만든다 (기다리지 않음). 직전 만들기가 실패했으면 KR_INDEX_RETRY_MS 동안 쉰다 */
  async ensure(maxAgeMs = KR_INDEX_STALE_MS): Promise<void> {
    await this.load();
    if (this.data && this.t - this.data.builtAt < maxAgeMs) return;
    if (this.failedAt !== null && this.t - this.failedAt < KR_INDEX_RETRY_MS) return;
    void this.build().catch(() => undefined);
  }

  /** 지금 새로 만든다 (같은 때 한 번만). 실패하면 옛 표를 그대로 두고 던진다 */
  build(): Promise<KrThemeIndexData> {
    this.building ??= this.buildNow()
      .then(async (d) => {
        this.data = d;
        this.lastError = null;
        this.failedAt = null;
        await this.deps.store?.set(KR_INDEX_KEY, JSON.stringify(d)).catch(() => undefined);
        this.deps.log?.info?.({ themes: Object.keys(d.themes).length, stocks: Object.keys(d.members).length }, "한국 테마 표 만듦");
        return d;
      })
      .catch((e: unknown) => {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.failedAt = this.t;
        this.deps.log?.warn?.({ err: this.lastError }, "한국 테마 표 만들기 실패 (옛 표 유지)");
        throw e;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  private async buildNow(): Promise<KrThemeIndexData> {
    await this.load();
    const prev = this.data;
    const pause = this.deps.pauseMs ?? 300;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const list = await this.deps.naver.sectors("KR", "theme", "day");
    if (!list.length) throw new Error("네이버 한국 테마 목록이 비어 있습니다");
    const themes: Record<string, string> = {};
    const members: Record<string, string[]> = {};
    let failures = 0;
    for (const th of list) {
      await sleep(pause);
      try {
        const d = await this.deps.naver.sectorDetail("KR", "theme", th.id);
        if (!d) continue;
        themes[th.id] = th.name;
        for (const it of d.items) (members[it.code] ??= []).push(th.id);
      } catch {
        failures++;
      }
    }
    const n = Object.keys(themes).length;
    if (!n) throw new Error("네이버 한국 테마 구성 종목을 받지 못했습니다");
    if (prev) {
      const prevN = Object.keys(prev.themes).length;
      if (failures / list.length > 0.1) throw new Error(`한국 테마 구성 받기 실패가 많습니다 (${failures}/${list.length})`);
      if (n < prevN * 0.8) {
        const again = this.shrunk !== null && Math.abs(n - this.shrunk) <= Math.max(3, this.shrunk * 0.05);
        this.shrunk = n;
        if (!again) throw new Error(`새 한국 테마 표가 너무 작습니다 (${n} < 이전 ${prevN}의 80%)`);
        this.deps.log?.warn?.({ themes: n, prev: prevN }, "한국 테마 수가 두 번 이어서 크게 줄어 받아들임");
      }
    }
    this.shrunk = null;
    return { v: 1, builtAt: this.t, themes, members };
  }

  status(): { builtAt: number | null; themes: number; stocks: number; building: boolean; error: string | null } {
    return { builtAt: this.data?.builtAt ?? null, themes: this.data ? Object.keys(this.data.themes).length : 0, stocks: this.data ? Object.keys(this.data.members).length : 0, building: this.isBuilding, error: this.lastError };
  }
}
