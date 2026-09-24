import type { Db } from "../db/index.js";
import { seoulIso } from "../lib/time.js";

/**
 * 기능 켜고 끄기 (3-15). 플래그 목록은 여기 한 곳에만 둔다.
 *  - 기본값은 코드에, 바꾼 값만 meta(features)에 저장 → 관리 API 로 바꾸면 재배포 없이 반영 (앱은 60초마다 /api/features 를 받는다)
 *  - 기능 하나에 플래그 하나. 완전히 켠 뒤 한 달이 지나면 플래그를 지우고 코드에 합친다
 *  - 새 기능(3-19·3-24 의 새 동작, P2 전부)은 플래그 뒤에 둔다
 */
export const FEATURES = {
  tossReconcile: { default: true, description: "토스 계좌 자동 대조: 동기화마다 기록·경고, 설정 화면 '토스 대조' 줄 (3-13)" },
  briefingSources: { default: true, description: "브리핑 상세의 근거(뉴스·공시 출처) 카드 (3-12)" },
} as const satisfies Record<string, { default: boolean; description: string }>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];
export const FEATURES_META_KEY = "features";

interface Stored {
  overrides: Partial<Record<FeatureKey, boolean>>;
  updatedAt: string | null;
}

export class FeatureService {
  private cache: Stored | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<Stored> {
    if (this.cache) return this.cache;
    const row = await this.db.selectFrom("meta").select("value").where("key", "=", FEATURES_META_KEY).executeTakeFirst();
    let stored: Stored = { overrides: {}, updatedAt: null };
    if (row) {
      try {
        const v = JSON.parse(row.value) as Partial<Stored>;
        const overrides: Stored["overrides"] = {};
        // 지운 플래그의 옛 값은 버린다
        for (const k of FEATURE_KEYS) if (typeof v.overrides?.[k] === "boolean") overrides[k] = v.overrides[k];
        stored = { overrides, updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null };
      } catch {
        /* 깨진 값은 기본값으로 */
      }
    }
    this.cache = stored;
    return stored;
  }

  /** 앱에 주는 값: 모든 플래그의 현재 상태 */
  async all(): Promise<{ features: Record<FeatureKey, boolean>; updatedAt: string | null }> {
    const s = await this.load();
    const features = {} as Record<FeatureKey, boolean>;
    for (const k of FEATURE_KEYS) features[k] = s.overrides[k] ?? FEATURES[k].default;
    return { features, updatedAt: s.updatedAt };
  }

  async enabled(key: FeatureKey): Promise<boolean> {
    const s = await this.load().catch(() => null);
    return s?.overrides[key] ?? FEATURES[key].default;
  }

  /** 관리 화면용: 기본값·설명·바꾼 값까지 */
  async detail(): Promise<Array<{ key: FeatureKey; enabled: boolean; default: boolean; overridden: boolean; description: string }>> {
    const s = await this.load();
    return FEATURE_KEYS.map((k) => ({ key: k, enabled: s.overrides[k] ?? FEATURES[k].default, default: FEATURES[k].default, overridden: k in s.overrides, description: FEATURES[k].description }));
  }

  /** true/false 로 바꾸고, null 이면 기본값으로 되돌린다. 모르는 키는 거절 */
  async set(patch: Record<string, boolean | null>): Promise<{ features: Record<FeatureKey, boolean>; updatedAt: string | null }> {
    const unknown = Object.keys(patch).filter((k) => !(FEATURE_KEYS as string[]).includes(k));
    if (unknown.length) throw new UnknownFeatureError(unknown);
    const s = await this.load();
    const overrides = { ...s.overrides };
    for (const [k, v] of Object.entries(patch) as Array<[FeatureKey, boolean | null]>) {
      if (v === null) delete overrides[k];
      else overrides[k] = v;
    }
    const next: Stored = { overrides, updatedAt: seoulIso(this.now()) };
    const value = JSON.stringify(next);
    await this.db.insertInto("meta").values({ key: FEATURES_META_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    this.cache = next;
    return this.all();
  }
}

export class UnknownFeatureError extends Error {
  constructor(public readonly keys: string[]) {
    super(`모르는 기능 플래그: ${keys.join(", ")}`);
    this.name = "UnknownFeatureError";
  }
}
