import type { ProductKind } from "../analysis/leveraged.js";
import { scoreWordingProblems } from "../analysis/scoreWording.js";
import { KR_ETF_BRAND_RE } from "./marketSummaryCalc.js";

/**
 * 내 보유 종목 × 테마 강도 (3-35, 플래그 holdingThemes) — 순수 함수만.
 *  - 종목 → 묶음(테마·업종) 고르기: 레버리지 단일 종목 상품은 기초 종목으로, 지수 상품은 작은 고정 표로, 미국은 토스 '주요 사업' 테마 중
 *    발견 탭 미국 테마북에 있는 것 → 없으면 네이버 업종, 한국은 네이버 테마(거꾸로 찾는 표) → 없으면 네이버 업종. 모두 없으면 '미분류'
 *  - 많이 속한 테마(2종목 이상, 최대 3개) · 등락률 높은 3개/낮은 3개 · 거래대금 평소 대비
 *  - 모든 문구는 사실만 (판단·권유 없음) — THEME_BANNED_RE + 지표 점수 금지어 검사를 테스트가 모든 조합에 돌린다
 * 등락률·오른/내린 수는 여기서 계산하지 않는다 — 발견 탭(DiscoverService)이 준 값을 그대로 옮긴다
 */

export type HtMarket = "KR" | "US";
export type HtKind = "theme" | "sector";
export type UnmappedReason = "index" | "none" | "failed" | "preparing";

export interface GroupRef {
  market: HtMarket;
  kind: HtKind;
  id: string;
  /** 분류 출처가 준 이름 (목록 이름이 있으면 그것을 쓴다) */
  name?: string;
}

/** 레버리지·인버스·지수 상품의 표시 (앱: 'SOXL(반도체 지수 3배)') */
export interface Via {
  code: string;
  name: string;
  /** 배수 (인버스도 크기만, 모르면 null) */
  L: number | null;
  inverse: boolean;
  /** 지수 전체 상품이면 따르는 지수 이름 */
  index: string | null;
}

export function groupKey(g: Pick<GroupRef, "market" | "kind" | "id">): string {
  return `${g.market}:${g.kind}:${g.id}`;
}

/** 미국 업종 '반도체' (네이버 TRBC 57101010 = 발견 탭 미국 업종 id) */
const US_SEMI = { market: "US" as const, kind: "sector" as const, id: "57101010", name: "반도체" };

/**
 * 지수 상품 표 (설계 3.1 다): 반도체 지수 상품은 미국 업종 '반도체'로 묶고, 지수 전체 상품(나스닥100·S&P500·다우·러셀·기술 섹터)은 묶지 않는다.
 * L 은 부호 있는 배수 (인버스는 음수). 이 표에 없는 ETF 는 토스 분류(깊이 1 이상)가 있으면 그것, 없으면 미분류
 */
export const INDEX_PRODUCTS: Readonly<Record<string, { group: GroupRef | null; tracks: string; L: number }>> = {
  SOXX: { group: US_SEMI, tracks: "반도체 지수", L: 1 },
  SMH: { group: US_SEMI, tracks: "반도체 지수", L: 1 },
  SOXQ: { group: US_SEMI, tracks: "반도체 지수", L: 1 },
  SOXL: { group: US_SEMI, tracks: "반도체 지수", L: 3 },
  USD: { group: US_SEMI, tracks: "반도체 지수", L: 2 },
  SOXS: { group: US_SEMI, tracks: "반도체 지수", L: -3 },
  QQQ: { group: null, tracks: "나스닥100 지수", L: 1 },
  QQQM: { group: null, tracks: "나스닥100 지수", L: 1 },
  TQQQ: { group: null, tracks: "나스닥100 지수", L: 3 },
  QLD: { group: null, tracks: "나스닥100 지수", L: 2 },
  SQQQ: { group: null, tracks: "나스닥100 지수", L: -3 },
  SPY: { group: null, tracks: "S&P500 지수", L: 1 },
  VOO: { group: null, tracks: "S&P500 지수", L: 1 },
  IVV: { group: null, tracks: "S&P500 지수", L: 1 },
  UPRO: { group: null, tracks: "S&P500 지수", L: 3 },
  SPXL: { group: null, tracks: "S&P500 지수", L: 3 },
  SSO: { group: null, tracks: "S&P500 지수", L: 2 },
  DIA: { group: null, tracks: "다우 지수", L: 1 },
  IWM: { group: null, tracks: "러셀2000 지수", L: 1 },
  XLK: { group: null, tracks: "미국 기술 섹터", L: 1 },
  TECL: { group: null, tracks: "미국 기술 섹터", L: 3 },
};

/** 한국 지수 ETF 이름 → 따르는 지수 (운용사 상표가 앞에 있을 때만) */
const KR_INDEX_NAMES: Array<[RegExp, string]> = [
  [/코스닥\s?150/, "코스닥150 지수"],
  [/KRX\s?300/i, "KRX300 지수"],
  [/(?:^|\s)200(?:\s|$|TR|선물|레버리지|인버스)|코스피\s?200|KOSPI\s?200/i, "코스피200 지수"],
  [/코스피(?!\s?200)|KOSPI(?!\s?200)/i, "코스피 지수"],
  [/TOP\s?10/i, "시가총액 상위 10종목 지수"],
];

/** 한국 지수 전체 ETF 인지와 따르는 지수 (운용사 상표 + 지수 낱말). 아니면 null */
export function krIndexEtf(name: string): string | null {
  if (!KR_ETF_BRAND_RE.test(name)) return null;
  for (const [re, idx] of KR_INDEX_NAMES) if (re.test(name)) return idx;
  return null;
}

/**
 * 레버리지 단일 종목·지수 레버리지 상품의 기초 (지표 점수·비중 한 줄과 같은 가리기 — analysis/leveraged productKindOf).
 * 레버리지(정방향)이고 기초를 알 때만 (RGTX → RGTI 2배, KODEX 레버리지 → 069500 코스피200 지수). 인버스·기초를 모르는 상품은 null
 */
export function underlyingOfKind(kind: ProductKind): Underlying | null {
  if (kind.kind === "leveraged" && kind.underlying) return { code: kind.underlying, L: kind.L, inverse: false, tracks: kind.tracks };
  return null;
}

/** 레버리지 단일 종목 상품의 기초 종목 (analysis/leveraged 가 알려 준 것) */
export interface Underlying {
  code: string;
  /** 배수 크기 */
  L: number;
  inverse: boolean;
  /** 따르는 것 ('리게티 컴퓨팅 주가') — 표시 이름에 쓴다 */
  tracks: string | null;
}

export interface ClassifyInput {
  code: string;
  name: string;
  market: HtMarket;
  underlying: Underlying | null;
  /** 토스 '주요 사업' 테마 (미국, 기초 종목이 있으면 기초 종목의 것). undefined = 아직 모름, null = 받지 못함 */
  usTics?: Array<{ id: string; title: string }> | null | undefined;
  /** 발견 탭 미국 테마북의 테마 id (깊이 1 이상 · 미국 3종목 이상). null = 테마북을 처음 만드는 중(또는 bookFailed) */
  bookIds: ReadonlySet<string> | null;
  /** 미국 테마북 시세를 받지 못함 (만드는 중이 아닌 실패 — 출처 오류·초기화 시간). 테마가 있는지 알 수 없어 업종으로 묶지 않는다 */
  bookFailed?: boolean;
  /** 네이버 미국 업종 번호. undefined = 아직 모름/받지 못함, null = 받았는데 없음 */
  usIndustry?: string | null | undefined;
  /** 한국 테마(거꾸로 찾는 표). null = 표를 처음 만드는 중 */
  krThemes?: string[] | null | undefined;
  /** 네이버 한국 업종 번호. undefined = 모름, null = 없음 */
  krIndustry?: string | null | undefined;
  /** 분류를 받는 중 (첫 요청 3초 안에 못 받음) */
  pending?: boolean;
  /** 분류 받기 실패 (옛 값도 없음) */
  failed?: boolean;
}

export interface ClassifyResult {
  groups: GroupRef[];
  reason: UnmappedReason | null;
  /** 지수 전체 상품이면 따르는 지수 (reason index) */
  index: string | null;
  via: Via | null;
  /**
   * 까닭의 자세한 사정 (문구만 바꾼다): classify = 종목 분류를 아직 받는 중(preparing — 목록 준비가 아님),
   * book = 미국 테마 시세를 받지 못함(failed — 분류 받기 실패가 아님). 없으면 기본 문구
   */
  why?: "classify" | "book";
}

/** '리게티 컴퓨팅 주가' → '리게티 컴퓨팅' */
function trackName(tracks: string | null, fallback: string): string {
  if (!tracks) return fallback;
  return tracks.replace(/\s*주가$/, "").trim() || fallback;
}

/**
 * 종목 하나의 묶음 (설계 3.1 순서: 가 레버리지 → 다 지수 상품 표 → 나 미국 토스 테마 → 라 업종 / 마 한국 테마 → 업종).
 * 앞에서 찾으면 멈춘다. 테마가 있으면 업종은 넣지 않는다
 */
export function classifyHolding(x: ClassifyInput): ClassifyResult {
  const u = x.underlying;
  const table = INDEX_PRODUCTS[x.code] ?? (u ? INDEX_PRODUCTS[u.code] : undefined);
  if (x.market === "US" && table) {
    const L = INDEX_PRODUCTS[x.code] ? table.L : u ? (u.inverse ? -u.L : u.L) : table.L;
    const via: Via | null = L === 1 ? null : { code: u?.code ?? x.code, name: table.tracks, L: Math.abs(L), inverse: L < 0, index: table.group ? null : table.tracks };
    if (table.group) return { groups: [table.group], reason: null, index: null, via };
    return { groups: [], reason: "index", index: table.tracks, via };
  }
  if (x.market === "KR") {
    const idx = krIndexEtf(x.name);
    if (idx) return { groups: [], reason: "index", index: idx, via: null };
    // 한국 지수 레버리지·인버스 (KODEX 레버리지 → 코스피200 지수): 이름에 지수 낱말이 없어도 표가 따르는 지수를 안다
    if (u?.tracks && /지수$/.test(u.tracks)) return { groups: [], reason: "index", index: u.tracks, via: { code: u.code, name: u.tracks, L: u.L, inverse: u.inverse, index: u.tracks } };
  }
  const via: Via | null = u ? { code: u.code, name: trackName(u.tracks, u.code), L: u.L, inverse: u.inverse, index: null } : null;
  const done = (groups: GroupRef[]): ClassifyResult => ({ groups, reason: null, index: null, via });
  const miss = (reason: UnmappedReason): ClassifyResult => ({ groups: [], reason, index: null, via });
  if (x.market === "US") {
    const tics = x.usTics;
    if (tics && tics.length && x.bookIds) {
      const themes = tics.filter((t) => x.bookIds!.has(t.id));
      if (themes.length) return done(dedupe(themes.map((t) => ({ market: "US", kind: "theme", id: t.id, name: t.title }))));
    }
    // 테마북을 처음 만드는 중인데 토스 분류는 받았으면 테마가 있을지 아직 모른다 → 준비 중 (업종으로 먼저 묶지 않는다 — 같은 종목이 나중에 다른 묶음으로 옮겨 가지 않게)
    // 테마북 시세를 받지 못했을 때도 같다: 데이터 실패를 '테마 없음'으로 보고 업종으로 옮기지 않는다 → 받지 못함 (잠시 뒤 다시)
    if (tics && tics.length && x.bookIds === null) return x.bookFailed ? { ...miss("failed"), why: "book" } : miss("preparing");
    if (x.usIndustry) return done([{ market: "US", kind: "sector", id: x.usIndustry }]);
    if (x.pending) return { ...miss("preparing"), why: "classify" };
    if (x.failed || tics === null) return miss("failed");
    return miss("none");
  }
  if (x.krThemes === null) return miss("preparing");
  if (x.krThemes && x.krThemes.length) return done(dedupe(x.krThemes.map((id) => ({ market: "KR", kind: "theme", id }))));
  if (x.krIndustry) return done([{ market: "KR", kind: "sector", id: x.krIndustry }]);
  if (x.pending) return { ...miss("preparing"), why: "classify" };
  if (x.failed) return miss("failed");
  return miss("none");
}

function dedupe(gs: GroupRef[]): GroupRef[] {
  const seen = new Set<string>();
  return gs.filter((g) => {
    const k = groupKey(g);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 연결하지 못한 종목 한 줄 (설계 2.2 ⑥). 미국은 티커, 한국은 이름으로 시작한다 */
export function unmappedText(reason: UnmappedReason, v: { code: string; name: string; market: HtMarket; index?: string | null; why?: "classify" | "book" | null }): string {
  const who = v.market === "US" ? v.code : v.name;
  switch (reason) {
    case "index":
      return `${who} · ${v.index ? `${v.index} 전체를` : "지수 전체를"} 따르는 상품이라 테마로 묶지 않았습니다`;
    case "none":
      return `${who} · 미분류 · 테마·업종 정보가 없습니다`;
    case "failed":
      // 분류는 받았지만 미국 테마 시세를 받지 못함 (테마가 있는지 알 수 없어 업종으로 옮기지 않음)
      if (v.why === "book") return `${who} · 미국 테마 시세를 받지 못했습니다 (잠시 뒤 다시 시도)`;
      return `${who} · 분류를 받지 못했습니다 (잠시 뒤 다시 시도)`;
    case "preparing":
      // 종목 분류를 아직 받는 중 (첫 요청은 3초까지만 기다린다) — 테마 목록 준비와는 다른 사정
      if (v.why === "classify") return `${who} · 테마 분류를 받는 중입니다 (잠시 뒤 다시 보여 드립니다)`;
      return `${who} · ${v.market === "KR" ? "한국" : "미국"} 테마 목록을 처음 준비하는 중입니다 (약 2분)`;
  }
}

/** 많이 속한 테마 한 줄 (설계 2.2 ①) */
export interface MostHeld {
  key: string;
  name: string;
  count: number;
  codes: string[];
}

/**
 * 내 종목이 많이 속한 테마: 2종목 이상 든 묶음만, 든 종목 수 많은 순 → 원화 평가금액 합 큰 순 → 이름순, 최대 3개.
 * 없으면 평가금액이 가장 큰 종목의 첫 묶음 하나(1종목 — '많이'를 지어내지 않음). 평가금액을 모르는 종목은 0 으로 센다
 */
export function mostHeld(groups: ReadonlyArray<{ key: string; name: string; codes: readonly string[] }>, valueOf: (code: string) => number | null, max = 3): MostHeld[] {
  const sum = (codes: readonly string[]) => codes.reduce((s, c) => s + (valueOf(c) ?? 0), 0);
  const rows = groups.map((g) => ({ key: g.key, name: g.name, codes: [...new Set(g.codes)] }));
  const many = rows
    .filter((g) => g.codes.length >= 2)
    .sort((a, b) => b.codes.length - a.codes.length || sum(b.codes) - sum(a.codes) || a.name.localeCompare(b.name, "ko"))
    .slice(0, max)
    .map((g) => ({ key: g.key, name: g.name, count: g.codes.length, codes: g.codes }));
  if (many.length) return many;
  const codes = [...new Set(rows.flatMap((g) => g.codes))];
  if (!codes.length) return [];
  const top = [...codes].sort((a, b) => (valueOf(b) ?? 0) - (valueOf(a) ?? 0) || a.localeCompare(b))[0]!;
  const g = rows.find((r) => r.codes.includes(top))!;
  return [{ key: g.key, name: g.name, count: 1, codes: [top] }];
}

/**
 * 등락률 높은 순 (같으면 이름순, 값 없는 묶음은 맨 뒤). 값 있는 묶음이 6개 이상이면 높은 3개·낮은 3개(낮은 것부터)로 나눈다 — 겹치지 않음
 */
export function topBottom<T extends { name: string; rate: number | null }>(rows: readonly T[]): { split: boolean; top: T[]; bottom: T[]; all: T[] } {
  const all = [...rows].sort((a, b) => {
    if (a.rate === null && b.rate === null) return a.name.localeCompare(b.name, "ko");
    if (a.rate === null) return 1;
    if (b.rate === null) return -1;
    return b.rate - a.rate || a.name.localeCompare(b.name, "ko");
  });
  const ranked = all.filter((r) => r.rate !== null);
  if (ranked.length < 6) return { split: false, top: [], bottom: [], all };
  return { split: true, top: ranked.slice(0, 3), bottom: ranked.slice(-3).reverse(), all };
}

// ── 거래대금 평소 대비 ──────────────────────────────────────────

/** 하루 기록: 묶음 키("theme:543" · "sector:278") → 구성 종목 거래대금 합 */
export interface TvDay {
  day: string;
  tv: Record<string, number>;
}

/** 평소(그날을 뺀 가장 최근 기록 max 개의 평균)에 쓸 최소 기록 수 */
export const TV_MIN_DAYS = 5;
export const TV_AVG_DAYS = 20;
/** 시장마다 남기는 기록 수 */
export const TV_KEEP_DAYS = 25;

/** 평소 = excludeDay 를 뺀 가장 최근 기록 max 개(그 묶음 값이 있는 날만)의 평균. 기록 수(days)도 준다 */
export function tvBaseline(days: readonly TvDay[], key: string, excludeDay: string | null, max = TV_AVG_DAYS): { avg: number | null; days: number } {
  const vals = [...days]
    .filter((d) => d.day !== excludeDay && typeof d.tv[key] === "number" && Number.isFinite(d.tv[key]))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, max)
    .map((d) => d.tv[key]!);
  if (!vals.length) return { avg: null, days: 0 };
  return { avg: vals.reduce((s, v) => s + v, 0) / vals.length, days: vals.length };
}

/** 오늘 ÷ 평소 × 100 (정수 반올림). 기록이 TV_MIN_DAYS 보다 적거나 평소가 0 이면 null */
export function tvRatio(today: number | null, avg: number | null, days: number): number | null {
  if (today === null || avg === null || !(avg > 0) || days < TV_MIN_DAYS) return null;
  return Math.round((today / avg) * 100);
}

/** 기록 한 벌 넣기: 같은 날은 바꾸고, 날짜 순으로 최근 keep 개만 남긴다 */
export function pushTvDay(days: readonly TvDay[], add: TvDay, keep = TV_KEEP_DAYS): TvDay[] {
  const rest = days.filter((d) => d.day !== add.day);
  return [...rest, add].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-keep);
}

// ── 문구 ───────────────────────────────────────────────────

/** 이 기능이 더 막는 낱말 (지표 점수 금지어에 더해) — 좋다·나쁘다로 읽히는 말 */
export const THEME_BANNED_RE = /(강세|약세|강한|약한|뜨는|핫한|주도|수혜|대장|몰린|쏠림|과열|급변|위험|주의|유의|추세 전환|모멘텀)/;

/** 문장에서 걸리는 낱말들 (없으면 빈 배열) */
export function themeWordingProblems(text: string): string[] {
  const out = scoreWordingProblems(text);
  const m = text.match(new RegExp(THEME_BANNED_RE.source, "g"));
  if (m) out.push(...m);
  return out;
}

/** 화면 맨 아래 기준 줄 (설계 2.2 ⑧). krIndexAt = 한국 테마 구성을 받은 시각 표시('9월 27일 (일) 05:40') */
export function basisLines(krIndexAt: string | null): string[] {
  return [
    "기준: 등락률과 오른·내린 종목 수는 발견 탭과 같은 값입니다.",
    "미국 테마: 토스증권 테마 분류 · 네이버 증권 정규장 시세 · 테마별 시가총액 상위 30종목의 시가총액 가중 평균",
    "미국 업종: 네이버 증권 산업 분류 · 미국 1주: 토스증권 1주 등락률",
    "한국 테마: 네이버 증권 · 구성 종목 단순 평균 / 업종: 네이버 증권",
    "1주: 7일 전 날의 직전 종가부터 지금까지 (휴장이 끼면 거래일이 5일보다 적습니다)",
    "거래대금 평소: 구성 종목 거래대금 합 ÷ 최근 20거래일 하루 평균 (이 앱이 매일 기록한 값, 한국은 한국거래소 기준 · 넥스트레이드 제외)",
    "한 종목이 여러 테마에 들어 테마별 종목 수의 합은 보유 종목 수보다 클 때가 있습니다.",
    ...(krIndexAt ? [`한국 테마 구성은 주 1회 받은 목록입니다 (마지막: ${krIndexAt}).`] : []),
  ];
}

/** 이 기능 서버가 만드는 모든 문구 (문구 검사 테스트용 — 까닭 4종 × 시장 2 · 기준 줄) */
export function allServerTexts(): string[] {
  const out: string[] = [];
  for (const reason of ["index", "none", "failed", "preparing"] as const)
    for (const market of ["KR", "US"] as const)
      for (const index of [null, "나스닥100 지수", "코스피200 지수"])
        for (const why of [null, "classify", "book"] as const) out.push(unmappedText(reason, { code: "ABCD", name: "가나다", market, index, why }));
  out.push(...basisLines("9월 27일 (일) 05:40"));
  out.push(PREPARING_NOTE, MARKET_NOTE_US_BOOK, MARKET_NOTE_KR_INDEX, MARKET_NOTE_US_BOOK_FAILED, ticsMissingNote(1), ticsMissingNote(3));
  return out;
}

/** 첫 준비 알림 줄 (설계 2.4) */
export const PREPARING_NOTE = "테마 목록을 처음 준비하는 중입니다 (약 2분). 준비된 시장부터 보여 드립니다.";
export const MARKET_NOTE_US_BOOK = "미국 테마를 처음 준비하는 중이라 업종으로 묶은 종목만 보여 드립니다";
/** 한국 표가 없으면 한국 종목은 업종으로도 묶지 않고 모두 '준비 중'이다 (classifyHolding — 표가 생기면 테마로 옮겨 가지 않게) */
export const MARKET_NOTE_KR_INDEX = "한국 테마 목록을 처음 준비하는 중이라 한국 종목은 준비가 끝나면 보여 드립니다";
/** 미국 테마북 시세를 받지 못함 (만드는 중이 아닌 실패) */
export const MARKET_NOTE_US_BOOK_FAILED = "미국 테마 시세를 받지 못해 테마로 묶지 못한 종목이 있습니다 (잠시 뒤 다시 시도)";
/** 토스 회사 테마를 받지 못해(옛 값도 없음) 네이버 업종으로 묶은 미국 종목 수 (설계 3.1 — 5분 뒤 다시 받는다) */
export function ticsMissingNote(n: number): string {
  return `토스 테마 분류를 받지 못한 ${n}종목은 업종으로 묶었습니다 (잠시 뒤 다시 받습니다)`;
}

/** 서울 시각 ISO → '9월 27일 (일) 05:40' */
export function koDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = new Date(t + 9 * 3_600_000);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][s.getUTCDay()]!;
  return `${s.getUTCMonth() + 1}월 ${s.getUTCDate()}일 (${wd}) ${String(s.getUTCHours()).padStart(2, "0")}:${String(s.getUTCMinutes()).padStart(2, "0")}`;
}
