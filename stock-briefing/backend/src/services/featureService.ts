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
  briefingDigest: { default: true, description: "브리핑 알림을 세션당 1건으로 묶고 조용한 시간·끈 종목을 지킴 (3-19). 끄면 종목마다 1건(예전)" },
  briefingTabMovers: { default: true, description: "브리핑 탭 기본 정렬 '변동 큰 순'과 상위 3종목 먼저 (3-19). 끄면 등록순(예전)" },
  briefingManualRun: { default: true, description: "브리핑 수동 생성 전 확인 창, 상세의 '이 종목 다시 만들기' (3-19). 끄면 확인 없이 바로(예전)" },
  widgetPnlToggle: { default: true, description: "잔고 위젯 합계 옆 손익을 눌러 누적·당일 전환 (위젯 요청). 끄면 누적만, 누르면 앱(예전)" },
  widgetIndexLine: { default: true, description: "잔고 위젯 합계 아래 코스피·나스닥·환율 한 줄 (위젯 요청). 끄면 줄이 사라지고 /api/widget 응답에 지수를 넣지 않음" },
  widgetMarket: {
    default: true,
    description: "지수·환율 위젯 (APK 1.4.0): 코스피·코스닥·나스닥·S&P500·다우·필라반도체와 원/달러·원/100엔·원/위안. 끄면 위젯에 짧은 안내만 보이고 /api/widget 응답에 지수 판을 넣지 않음",
  },
  widgetPolish: {
    default: true,
    description:
      "잔고 위젯 다듬기: 두 시장 세션 칩(미국 주간거래 · 한국 휴장), 지수 줄 계좌 비중 순서·환율 등락률·지난 값 흐리게+날짜, 종목 줄 '수익'·'오늘' 표시와 원화 손익, 손익 전환 ⇅ 표시, '보유 17 · 관심 1', 줄 간격 줄이기. 끄면 예전 모습 그대로이고 /api/widget 에 칩 시장별 문구·지수 두 개(코스닥·S&P500)를 넣지 않음",
  },
  widgetExtended: {
    default: true,
    description:
      "위젯 연장 거래 시간 갱신 (위젯 리뷰 1): 미국 프리·애프터·주간거래 등 달력으로는 닫혀 있어도 보유 종목이 거래되는 세션이면 /api/widget 칩에 시장별 ext 를 넣고, 새 앱 위젯이 장중처럼 15분마다 갱신하고 그 시장 시세가 30분 넘게 묵으면 '지연'. 끄면 칩에 ext 를 넣지 않아 예전처럼 휴장 규칙(최대 2시간 재사용, 지연 없음)",
  },
  widgetRefreshLog: {
    default: true,
    description:
      "설정 화면 위젯 자동 갱신 기록 (위젯 리뷰 2, 앱만): '마지막 자동 갱신 10:47 · 오늘 평균 간격 18분', 장중 1시간 넘게 자동 갱신 작업이 돌지 않거나 실패만 하면 경고(사유별 안내), '이 앱 설정 열기' 버튼(앱 정보 → 배터리 → 제한 없음). 끄면 설정 화면에 보이지 않음(기기 안 기록은 계속 적음, 서버 작업 없음)",
  },
  allocationView: {
    default: true,
    description: "비중 보기: 잔고 탭 계좌 평가의 '비중' 버튼과 국내·해외/통화/업종/종목별 원 차트 화면 (앱만, 서버 작업 없음). 끄면 버튼이 사라지고 화면을 열어도 잔고 계산을 하지 않음",
  },
  accountBriefing: {
    default: true,
    description: "계좌 한 장 브리핑 (3-31): 세션마다 계좌 요약 1건(기여도 상위·지수·환율 영향·오늘 일정)을 만들고 세션 알림 앞머리에 씀, 브리핑 탭 '내 계좌 브리핑' 카드. 끄면 만들지 않고(모델 호출 0) 알림·화면이 예전 그대로",
  },
  accountBriefingLlm: {
    default: false,
    description:
      "계좌 브리핑의 설명 문단을 모델이 쓰기 (3-31, 실험). 모델 설명은 숫자·부호·권유 표현 검사를 거치지만 자유 문장을 완전히 막을 수 없어 기본 꺼짐. 끄면 숫자로 만든 기본 설명만 쓰고 계좌 브리핑의 모델 호출 0",
  },
  foldLayout: {
    default: true,
    description:
      "접는 폰·넓은 창 화면 (3-42, 앱만, 서버 작업 없음): 창 폭 등급(좁음·중간·넓음)과 높이가 짧은 창에 맞춘 배치 — 넓고 낮은 창(펼친 폴드8 가로)은 탭을 왼쪽 세로 막대로, 넓은 창에서는 탭 머리 대신 맨 위 띠 · 잔고 44dp 넓은 표 · 종목 상세 좌우 배치 · 브리핑 목록+본문 2단 · 발견 한 줄 표 · 설정 카드 두 칸 · 비중 2×2 (가운데로 모으는 읽기 폭은 쓰지 않음). 끄면 창 크기와 상관없이 휴대폰 화면 그대로(탭은 아래)",
  },
} as const satisfies Record<string, { default: boolean; description: string }>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];
export const FEATURES_META_KEY = "features";

interface Stored {
  overrides: Partial<Record<FeatureKey, boolean>>;
  updatedAt: string | null;
}

/** 서버 캐시 유지 시간: 여러 인스턴스·DB 직접 수정도 앱 반영 기준(60초) 안에 따라가게 */
const CACHE_MS = 30_000;

export class FeatureService {
  private cache: { at: number; stored: Stored } | null = null;
  /** 바꾸기는 한 줄로 (읽고-고쳐-쓰기 사이에 다른 변경이 사라지지 않게) */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<Stored> {
    if (this.cache && this.now().getTime() - this.cache.at < CACHE_MS) return this.cache.stored;
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
    this.cache = { at: this.now().getTime(), stored };
    return stored;
  }

  /** 앱에 주는 값: 모든 플래그의 현재 상태 */
  async all(): Promise<{ features: Record<FeatureKey, boolean>; updatedAt: string | null }> {
    const s = await this.load();
    const features = {} as Record<FeatureKey, boolean>;
    for (const k of FEATURE_KEYS) features[k] = s.overrides[k] ?? FEATURES[k].default;
    return { features, updatedAt: s.updatedAt };
  }

  /** DB 를 못 읽으면 마지막 값, 그것도 없으면 꺼짐 (끄기 스위치가 오류로 다시 켜지지 않게, 앱과 같은 쪽으로) */
  async enabled(key: FeatureKey): Promise<boolean> {
    const s = await this.load().catch(() => this.cache?.stored ?? null);
    if (!s) return false;
    return s.overrides[key] ?? FEATURES[key].default;
  }

  /** 관리 화면용: 기본값·설명·바꾼 값까지 */
  async detail(): Promise<Array<{ key: FeatureKey; enabled: boolean; default: boolean; overridden: boolean; description: string }>> {
    const s = await this.load();
    return FEATURE_KEYS.map((k) => ({ key: k, enabled: s.overrides[k] ?? FEATURES[k].default, default: FEATURES[k].default, overridden: k in s.overrides, description: FEATURES[k].description }));
  }

  /** true/false 로 바꾸고, null 이면 기본값으로 되돌린다. 모르는 키는 거절 */
  set(patch: Record<string, boolean | null>): Promise<{ features: Record<FeatureKey, boolean>; updatedAt: string | null }> {
    const unknown = Object.keys(patch).filter((k) => !(FEATURE_KEYS as string[]).includes(k));
    if (unknown.length) return Promise.reject(new UnknownFeatureError(unknown));
    const run = this.queue.then(() => this.setNow(patch));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async setNow(patch: Record<string, boolean | null>): Promise<{ features: Record<FeatureKey, boolean>; updatedAt: string | null }> {
    this.cache = null; // 다른 인스턴스가 바꾼 값 위에 쓴다
    const s = await this.load();
    const overrides = { ...s.overrides };
    for (const [k, v] of Object.entries(patch) as Array<[FeatureKey, boolean | null]>) {
      if (v === null) delete overrides[k];
      else overrides[k] = v;
    }
    const next: Stored = { overrides, updatedAt: seoulIso(this.now()) };
    const value = JSON.stringify(next);
    await this.db.insertInto("meta").values({ key: FEATURES_META_KEY, value }).onConflict((oc) => oc.column("key").doUpdateSet({ value })).execute();
    this.cache = { at: this.now().getTime(), stored: next };
    return this.all();
  }
}

export class UnknownFeatureError extends Error {
  constructor(public readonly keys: string[]) {
    super(`모르는 기능 플래그: ${keys.join(", ")}`);
    this.name = "UnknownFeatureError";
  }
}
