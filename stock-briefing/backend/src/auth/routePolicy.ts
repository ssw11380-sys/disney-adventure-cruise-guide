import type { FastifyRequest } from "fastify";
import { normalizeCode } from "../lib/codes.js";
import type { SessionContext } from "./authService.js";

/**
 * 경로 정책 (계정 A단계, 플래그 accounts). 새 계정(주인 아님)이 주인의 개인 데이터를 보거나 바꾸지 못하게 **서버가** 막는다.
 *  - 공유 경로(SHARED_ROUTES, 시장·종목 정보)만 로그인한 누구나. 여기 없는 /api 경로는 모두 '개인 = 주인만' (기본 거절)
 *    → 새 경로를 만들면 test/routePolicy.test.ts 가 실패해 공유인지 개인인지 정하게 된다 (정하지 않아도 기본은 막힘)
 *  - 주인 아닌 계정: 공유는 그대로(가림 경로는 보유 정보를 뺀 모습), EMPTY_READS 는 빈 값 200, 관리(/api/admin)는 403 owner_only, 나머지 403 personal_data_not_ready
 *  - 세션 없는 요청: 세션 없이 여는 경로(NO_SESSION_ROUTES)만. 나머지 403 session_required
 *    (401 이 아닌 까닭: 예전 앱은 401 을 'API 토큰 확인'으로 보여 준다 — 앱을 업데이트하면 로그인 화면이 나온다)
 *  - 플래그가 꺼져 있으면 모두 지금처럼 (API 토큰 = 주인)
 */
export const SHARED_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/features",
  "GET /api/market/status",
  "GET /api/market/indices",
  "GET /api/market/indices/:code/candles",
  "GET /api/discover/:market/rank/:category",
  "GET /api/discover/:market/themes",
  "GET /api/discover/:market/themes/:id",
  "GET /api/stocks/search",
  "GET /api/stocks/:code", // 가림: 등록 여부와 상관없이 미리 보기 모양
  "GET /api/stocks/:code/quote", // 가림: 캐시의 받은 시각·ttl 지난 스냅샷·주인 앱의 3초 갱신 가격을 쓰지 않음 (검증 7차)
  "GET /api/stocks/:code/candles", // 가림: 새 값 시간(분봉 20초·일봉 60초) 안의 봉만 캐시에서 (검증 7차)
  "GET /api/stocks/:code/analysis/:kind", // refresh 무시 + 사용자별 하루 한도, 글은 공개 이름으로 만든 것만 (검증 8차)
  "GET /api/stocks/:code/news", // 가림: 등록 표를 보지 않음
  "GET /api/scores/:code", // 가림: 계산 시각·재무 받은 시각을 요청 시각 값으로 + 하루 한도, 계산은 공개 이름·시장으로 (검증 8차)
  "GET /api/market-summaries", // 가림: 내 종목 비교를 뺌
  "GET /api/market-summaries/latest",
  "GET /api/market-summaries/:id",
  "POST /api/app-errors", // 운영 진단 — 주인 아닌 계정은 주인과 다른 분당 몫 (검증 8차)
]);

/**
 * 주인 아닌 계정에게 보유 정보를 빼거나, 공유 캐시의 시각·상태(주인이 먼저 열었는지·주인 등록 종목이라 미리 받아 뒀는지)를 요청 시각 값으로 바꾼 모습을 주는
 * 공유 경로 (경로 안에서 ownerView 로 나눈다 — 검증 4~7차 M2)
 */
export const SANITIZED_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/stocks/:code",
  "GET /api/stocks/:code/quote",
  "GET /api/stocks/:code/candles",
  "GET /api/stocks/:code/news",
  "GET /api/stocks/:code/analysis/:kind",
  "GET /api/scores/:code",
  "GET /api/market-summaries",
  "GET /api/market-summaries/latest",
  "GET /api/market-summaries/:id",
]);

/** 인증 경로 (각 경로가 스스로 세션을 확인한다) */
export const AUTH_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/auth/login",
  "POST /api/auth/signup",
  "GET /api/auth/me",
  "POST /api/auth/logout",
  "POST /api/auth/logout-all",
  "POST /api/auth/password",
  "PUT /api/auth/email",
]);

/**
 * /api 밖의 경로 — 관문(onRequest)을 지나지 않으므로 경로가 스스로 보는 사람을 가린다 (app.ts healthViewer: 상세는 주인 세션에만,
 * 플래그가 꺼져 있으면 지금처럼 API 토큰만으로). 새 /api 밖 경로를 만들면 test/routePolicy.test.ts 가 실패해 여기에 넣고 주인 데이터가 새지 않는지 정하게 된다
 */
export const OUTSIDE_API_ROUTES: ReadonlySet<string> = new Set([
  "GET /",
  "GET /health",
  "OPTIONS *", // CORS 사전 요청(@fastify/cors) — 본문 없음
]);

/** 주인 아닌 계정·로그인 전의 /health 칸 (이것 말고는 없다 — 주인 토스 계좌·보유·매매 기록·알림 기기·브리핑 상태 등은 주인 세션에만) */
export const SHARED_HEALTH_KEYS: readonly string[] = ["ok", "time", "sources", "schedule", "authRequired", "llmConfigured", "viewer", "disclaimer"];

/** 세션 없이 여는 경로 (세션 헤더를 읽지도 않는다) */
export const NO_SESSION_ROUTES: ReadonlySet<string> = new Set(["GET /api/features", "POST /api/auth/login", "POST /api/auth/signup"]);

/** 주인 아닌 계정이 읽으면 빈 값을 주는 개인 경로 (그 밖의 개인 경로는 403) */
export const EMPTY_READS: Readonly<Record<string, (req: FastifyRequest) => unknown>> = {
  "GET /api/stocks": () => [],
  "GET /api/briefings/latest": () => [],
  "GET /api/briefings": () => [],
  "GET /api/account-briefings": () => [],
  "GET /api/price-alerts": () => ({ rules: [] }),
  "GET /api/price-alerts/volume": () => ({ items: [] }),
  "GET /api/devices": () => [],
  "GET /api/snapshots": () => ({ enabled: false, items: [] }),
  "GET /api/trades": () => ({ enabled: false, items: [], estimated: [] }),
  "GET /api/trade-records": () => ({ enabled: false }),
  // 기록이 있는지로 주인 등록 종목이 드러나지 않게
  "GET /api/scores/:code/history": (req) => ({ code: normalizeCode(String((req.params as { code?: unknown } | undefined)?.code ?? "")), items: [] }),
};

/** 라우터가 고른 경로 → 정책 키 ("GET /api/stocks/:code"). HEAD 는 GET 으로, 끝 슬래시는 뺀다 (접두사 + "/" 로 등록한 경로의 두 모양) */
export function routeKey(method: string, url: string): string {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return `${m} ${url.length > 1 ? url.replace(/\/+$/, "") : url}`;
}

/** 요청의 인증 상태 (onRequest 훅이 채운다) */
export type AuthState = { kind: "off" } | { kind: "anonymous" } | ({ kind: "user" } & SessionContext);

export type Decision =
  | { action: "allow" }
  | { action: "empty"; body: (req: FastifyRequest) => unknown }
  | { action: "deny"; status: number; body: { error: string; code: string; message: string } };

export const SESSION_INVALID = { error: "SESSION_INVALID", code: "session_invalid", message: "다시 로그인해 주세요" } as const;
export const SESSION_REQUIRED = { error: "SESSION_REQUIRED", code: "session_required", message: "로그인이 필요해요. 앱을 완전히 닫았다가 다시 열어 최신 버전으로 업데이트해 주세요." } as const;
export const PERSONAL_NOT_READY = { error: "PERSONAL_DATA_NOT_READY", code: "personal_data_not_ready", message: "개인 종목 기능은 준비 중이에요" } as const;
export const OWNER_ONLY = { error: "OWNER_ONLY", code: "owner_only", message: "주인 계정만 쓸 수 있어요" } as const;
export const AUTH_UNAVAILABLE = { error: "AUTH_UNAVAILABLE", code: "auth_unavailable", message: "로그인 확인을 잠시 할 수 없어요. 잠시 뒤 다시 해 주세요" } as const;
/** 주인 아닌 계정의 공유 경로 요청 수 (사람마다 1분) — 보통 쓰는 앱은 1분에 수십 번이라 여유가 크다 */
export const MEMBER_SHARED_PER_MINUTE = 240;
export const MEMBER_TOO_MANY = { error: "TOO_MANY_REQUESTS", code: "too_many_requests", message: "요청이 너무 잦아요. 잠시 뒤에 다시 해 주세요" } as const;
/**
 * 주인 아닌 계정의 하루 한도 (검증 4차 — 캐시에 있든 없든 서로 다른 것 수로 센다: 새로 만드는 것만 세면 한도를 다 쓴 뒤 캐시 여부로 주인 종목이 드러난다).
 * AI 분석은 종목·종류마다(모델 비용), 지표 점수는 종목마다(주인 키로 받는 일봉·재무). 오늘 이미 본 것은 다시 봐도 세지 않는다
 */
export const MEMBER_AI_DAILY = 10;
export const MEMBER_SCORE_DAILY = 30;
export const AI_DAILY_LIMIT = { error: "AI_DAILY_LIMIT", code: "ai_daily_limit", message: "오늘 볼 수 있는 AI 분석 수를 다 썼어요. 내일 다시 볼 수 있어요" } as const;
export const SCORE_DAILY_LIMIT = { error: "SCORE_DAILY_LIMIT", code: "score_daily_limit", message: "오늘 볼 수 있는 지표 점수 수를 다 썼어요. 내일 다시 볼 수 있어요" } as const;

/** 경로 하나에 대한 결정 (순수 함수) */
export function decide(key: string, auth: AuthState): Decision {
  if (auth.kind === "off") return { action: "allow" };
  if (NO_SESSION_ROUTES.has(key) || AUTH_ROUTES.has(key)) return { action: "allow" };
  if (auth.kind === "anonymous") return { action: "deny", status: 403, body: SESSION_REQUIRED };
  if (auth.user.isOwner) return { action: "allow" };
  if (SHARED_ROUTES.has(key)) return { action: "allow" };
  const empty = EMPTY_READS[key];
  if (empty) return { action: "empty", body: empty };
  if (key.split(" ")[1]?.startsWith("/api/admin")) return { action: "deny", status: 403, body: OWNER_ONLY };
  return { action: "deny", status: 403, body: PERSONAL_NOT_READY };
}

/** 이 요청이 주인의 모습(보유 정보 포함)을 봐도 되는지 — 플래그 꺼짐(지금처럼)이거나 주인 세션 */
export function ownerView(req: FastifyRequest): boolean {
  const a = req.auth;
  return !a || a.kind === "off" || (a.kind === "user" && a.user.isOwner);
}

/**
 * 주인 아닌 계정에게 주는 응답에서 공유 캐시의 시각·상태를 요청 시각 값으로 (검증 4차 M2 — 캐시에 이미 있었는지·언제 만들었는지로
 * 주인이 연 종목·주인 등록 종목(장 마감 뒤 미리 계산)이 드러나지 않게). 주인 보기면 그대로
 */
export function memberAnalysisView<T extends { id: number; createdAt: string; cached: boolean }>(a: T, nowIso: string): T {
  return { ...a, id: 0, createdAt: nowIso, cached: false };
}

/** 주인 아닌 계정에게 주는 '지난 값' 안내 (재무를 받은 날짜 없이 — 날짜는 주인 등록 종목만 매일 다시 받으므로 캐시 상태가 드러난다, 검증 5차) */
export const MEMBER_CARRIED_TEXT = "재무 숫자는 예전에 받은 값입니다 (그 뒤 새로 받지 못함).";
export const MEMBER_CARRIED_BADGE = "지난 값";

type ScoreValueLike = { asOf?: { fetchedAt: string | null } | null; flags?: Array<{ key: string; text: string }> | null; badges?: string[] | null };
type ScoreNameLike = { name?: string; trend?: { basis?: { kind: string; code: string; name: string } | null } | null };

/**
 * 주인 아닌 계정의 지표 점수 (한국·미국 모두). publicName: 종목 마스터·검색의 이름 (종목 상세 미리 보기와 같은 이름) — 주면 이름·'이 종목 기준' 이름을 그것으로
 * (#95 합친 뒤 카나리아: 계산 결과는 주인과 같은 캐시를 쓰는데 등록 표 이름으로 계산했었다. 검증 8차부터 계산 자체가 공개 이름·시장으로 하고 —
 *  기초자산 참고 줄·'기초자산 기준' 이름 포함, indicatorScoreService defaultScoreSources — 여기서는 한 번 더 이 종목 이름을 맞춘다)
 */
export function memberScoreView<T extends { computedAt: string; value?: ScoreValueLike | null } & ScoreNameLike>(r: T, nowIso: string, publicName?: string): T {
  if (publicName !== undefined) {
    const basis = r.trend?.basis;
    r = { ...r, ...(r.name !== undefined ? { name: publicName } : {}), ...(r.trend && basis?.kind === "self" ? { trend: { ...r.trend, basis: { ...basis, name: publicName } } } : {}) };
  }
  const v = r.value;
  if (!v) return { ...r, computedAt: nowIso };
  // 재무 받은 시각·'지난 값 M/D'(받은 날짜) 을 뺀다 — 한국·미국 가치 모두 (검증 5차: #94 한국 간이 가치 합친 뒤)
  const value: ScoreValueLike = {
    ...v,
    ...(v.asOf ? { asOf: { ...v.asOf, fetchedAt: null } } : {}),
    ...(v.flags ? { flags: v.flags.map((f) => (f.key === "carriedForward" ? { ...f, text: MEMBER_CARRIED_TEXT } : f)) } : {}),
    ...(v.badges ? { badges: v.badges.map((b) => (b.startsWith(MEMBER_CARRIED_BADGE) ? MEMBER_CARRIED_BADGE : b)) } : {}),
  };
  return { ...r, computedAt: nowIso, value };
}

/** 로그인한 사용자 (없으면 null) */
export function sessionOf(req: FastifyRequest): SessionContext | null {
  const a = req.auth;
  return a && a.kind === "user" ? { user: a.user, session: a.session } : null;
}

/** 끊겼을 때 데이터 절약(pollSaver)의 옛 본문 기억을 보는 사람마다 나눈다 (남의 옛 본문이 차이 계산에 섞이지 않게) */
export function viewerKey(req: FastifyRequest): string {
  const a = req.auth;
  if (!a || a.kind === "off") return "";
  if (a.kind === "user") return a.user.isOwner ? "o" : `u${a.user.id}`;
  return "a";
}

declare module "fastify" {
  interface FastifyRequest {
    /** 계정 A단계: 요청의 인증 상태 (플래그가 꺼져 있으면 off) */
    auth: AuthState | null;
  }
}
