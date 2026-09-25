import type { Quote } from "@/api/types";
import type { Connection, LiveTone } from "./freshness";

/**
 * 초록 점(실시간)과 잔고 상태 줄의 세션 — 순수 함수 (test/liveDot.test.ts). 규칙은 docs/디자인-규칙.md "초록 점".
 * 점의 뜻: 이 종목 가격이 지금 열린 거래 시간에 실시간으로 갱신되고 있다 (체결이 아직 없어도).
 *  - 서버(services/liveSession)가 종목마다 세션(session)과 실시간 여부(realtime)를 준다: 세션이 열려 있고, 이 종목이 그 세션의 거래 대상
 *    (NXT·주간거래 지원, 거래정지 아님)이며, 서버가 값을 받고 있을 때(웹소켓 구독 또는 토스 웹 3초 갱신) true
 *  - 앱은 자기 연결 상태(feedHealthy)와 세션 경계(until)를 더한다: 앱이 값을 못 받거나 세션이 끝났으면 끈다
 *  - 예전 서버(realtime 없음)는 예전처럼 live(스냅샷과 다른 체결이 붙었는지)로 — 새 앱 + 예전 서버도 지금보다 나빠지지 않게
 * 가격이 바뀔 때의 반짝임(FlashPrice)은 이와 따로, 실제로 가격이 바뀐 체결에만 그대로 반짝인다.
 */

/** 세션 정보(새 서버)를 볼 수 있는 시세 목록 (잔고 목록 · 상세의 한 종목) */
type Quotes = readonly (Quote | null | undefined)[];

/** 줄의 초록 점. feedOk = 앱이 값을 제때 받고 있음 (feedHealthy) */
export function quoteLive(q: Quote | null | undefined, now: number, feedOk: boolean): boolean {
  if (!q) return false;
  if (q.realtime === undefined) return q.live === true;
  if (!q.realtime || !feedOk) return false;
  const until = q.session?.until ? Date.parse(q.session.until) : NaN;
  return !(Number.isFinite(until) && now >= until);
}

/**
 * 앱이 값을 제때 받고 있는지: 오프라인(요청 실패)이 아니고, 체결 스트림이 붙어 있거나(조용한 세션이어도 25초 ping 이 연결을 지킨다 —
 * 45초 넘게 아무것도 없으면 lib/liveStream 이 끊는다) 폴링 값이 늦지 않음(OPEN_MAX_AGE_MS 15초 안, conn.stale 아님)
 */
export function feedHealthy(streamConnected: boolean, conn: Pick<Connection, "offline" | "stale">): boolean {
  return !conn.offline && (streamConnected || !conn.stale);
}

export interface MarketSessionView {
  market: "KR" | "US";
  label: string;
  open: boolean;
}

/**
 * 목록에 있는 시장의 지금 세션 (잔고 상태 줄 앞머리). 열린 시장 먼저, 같으면 한국 → 미국.
 * 시장마다 경계가 아직 안 지난 종목의 세션을 쓴다 (모두 지났으면 그대로 — 경계 1초 뒤 다시 받는다). 세션 정보가 없으면(예전 서버) 빈 배열
 */
export function marketSessions(quotes: Quotes, now: number): MarketSessionView[] {
  const pick = new Map<"KR" | "US", MarketSessionView & { current: boolean }>();
  for (const q of quotes) {
    const s = q?.session;
    if (!s) continue;
    const until = s.until ? Date.parse(s.until) : NaN;
    const current = !(Number.isFinite(until) && now >= until);
    const had = pick.get(s.market);
    if (!had || (!had.current && current)) pick.set(s.market, { market: s.market, label: s.label, open: s.open, current });
  }
  const order = (m: "KR" | "US") => (m === "KR" ? 0 : 1);
  return [...pick.values()].sort((a, b) => Number(b.open) - Number(a.open) || order(a.market) - order(b.market)).map(({ market, label, open }) => ({ market, label, open }));
}

/** 점이 켜진 종목 수와, 지금 열린 세션의 거래 대상(또는 모름) 종목 수 */
export function liveCounts(quotes: Quotes, now: number, feedOk: boolean): { live: number; eligible: number } {
  let live = 0;
  let eligible = 0;
  for (const q of quotes) {
    if (quoteLive(q, now, feedOk)) live++;
    if (q?.session?.open && q.session.eligible !== false) eligible++;
  }
  return { live, eligible };
}

/**
 * 가격이 바뀔 수 있는 세션(열린 시장의 거래 대상 종목)이 있는지 — 폴링 주기용 (미국 프리·애프터·주간거래 포함).
 * 세션 정보가 없으면(예전 서버) null → 예전 규칙(useAnyMarketOpen)
 */
export function sessionOpen(quotes: Quotes): boolean | null {
  let known = false;
  for (const q of quotes) {
    const s = q?.session;
    if (!s) continue;
    known = true;
    if (s.open && s.eligible !== false) return true;
  }
  return known ? false : null;
}

/** 경계가 지난 지 이 안이면 받은 값이 아직 지난 세션 것일 수 있다 (서버 시계가 조금 늦은 경우) → 짧게 한 번 더 */
const BOUNDARY_GRACE_MS = 10_000;
const BOUNDARY_RETRY_MS = 3_000;

/** 가장 가까운 세션 경계(ms). 방금(10초 안) 지난 경계도 포함 — capToBoundary 가 짧게 다시 받게. 없으면 null */
export function nextBoundary(quotes: Quotes, now: number): number | null {
  let best: number | null = null;
  for (const q of quotes) {
    const until = q?.session?.until ? Date.parse(q.session.until) : NaN;
    if (Number.isFinite(until) && until > now - BOUNDARY_GRACE_MS && (best === null || until < best)) best = until;
  }
  return best;
}

/**
 * 폴링 간격을 세션 경계에 맞춘다: 경계 1초 뒤에 한 번 더 받아 점·상태 줄이 경계에서 바로 바뀌게.
 * 방금 지난 경계면(받은 값이 아직 지난 세션 것) 3초 뒤 한 번 더. 오래전에 지났으면(기기 시계가 서버보다 한참 빠른 경우 등)
 * 원래 간격 — 1초마다 두드리지 않는다
 */
export function capToBoundary(every: number, boundary: number | null, now: number): number {
  if (boundary === null) return every;
  if (boundary > now) return Math.min(every, boundary - now + 1_000);
  return now - boundary < BOUNDARY_GRACE_MS ? Math.min(every, BOUNDARY_RETRY_MS) : every;
}

/**
 * 줄의 점을 다시 따져야 할 때까지 남은 시간(ms). 화면은 이때만 시각을 새로 읽어 다시 그린다 (몇 초마다 화면 전체를 다시 그리지 않게).
 * 따질 때: 받은 값이 maxAgeMs 를 넘는 때(스트림이 없으면 지연) · 세션 경계(until).
 *  - 마지막으로 시각을 읽은 때(readAt) 뒤에 그런 때가 이미 지났으면 0 (바로)
 *  - 앞으로 오면 그때까지, 없으면 null
 */
export function recheckIn(readAt: number, now: number, dataUpdatedAt: number, quotes: Quotes, maxAgeMs: number): number | null {
  const moments: number[] = [];
  if (dataUpdatedAt > 0) moments.push(dataUpdatedAt + maxAgeMs + 1);
  for (const q of quotes) {
    const until = q?.session?.until ? Date.parse(q.session.until) : NaN;
    if (Number.isFinite(until)) moments.push(until);
  }
  let next: number | null = null;
  for (const m of moments) {
    if (m > readAt && m <= now) return 0;
    if (m > now && (next === null || m < next)) next = m;
  }
  return next === null ? null : next - now;
}

/** 목록·상세 응답 → 시세 목록 (react-query refetchInterval 이 받은 값으로 폴링 주기를 정할 때) */
export function quotesOf(data: unknown): Quotes {
  if (Array.isArray(data)) return data.map((s) => (s as { quote?: Quote | null } | null)?.quote ?? null);
  const q = (data as { quote?: Quote | null } | null | undefined)?.quote;
  return q ? [q] : [];
}

/**
 * 잔고 상태 줄: "미국 주간거래 · 한국 휴장 · 실시간 9종목" (뒤에 시각·보유 수는 부르는 쪽이 붙인다).
 *  - 끊김: "… · 연결 끊김"
 *  - 열린 시장이 없음: 세션만 ("한국 장 마감", "미국 휴장 · 한국 휴장")
 *  - 앱이 값을 제때 못 받음: "… · 지연"
 *  - 점이 켜진 종목이 있음: "… · 실시간 N종목" (초록)
 *  - 열린 세션의 거래 대상이 있는데 점이 하나도 없음(서버가 값을 못 받는 중): "… · 지연"
 *  - 열린 세션에 거래 대상 종목이 없음(예: NXT 비대상만 보유한 애프터마켓): "… · 실시간 종목 없음"
 */
export function sessionStatus(o: { sessions: readonly MarketSessionView[]; liveCount: number; eligibleCount: number; feedOk: boolean; offline: boolean }): { text: string; tone: LiveTone } {
  const head = o.sessions.map((s) => s.label).join(" · ");
  const with_ = (x: string) => (head ? `${head} · ${x}` : x);
  if (o.offline) return { text: with_("연결 끊김"), tone: "offline" };
  if (!o.sessions.some((s) => s.open)) return { text: head, tone: "closed" };
  if (!o.feedOk) return { text: with_("지연"), tone: "delayed" };
  if (o.liveCount > 0) return { text: with_(`실시간 ${o.liveCount}종목`), tone: "live" };
  if (o.eligibleCount > 0) return { text: with_("지연"), tone: "delayed" };
  return { text: with_("실시간 종목 없음"), tone: "closed" };
}

/** 상세 화면: 점이 없을 때 그 까닭 한 줄 (거래정지 · 주간거래 미지원 · NXT 비대상 · 닫힌 세션). 보여 줄 게 없으면 null */
export function sessionNote(q: Quote | null | undefined): string | null {
  const s = q?.session;
  if (!s) return null;
  if (s.halted) return "거래정지";
  if (!s.open) return s.label;
  if (s.eligible !== false) return null;
  if (s.phase === "overnight") return "주간거래 미지원 종목";
  if (s.phase === "nxt_pre" || s.phase === "nxt_after") return "NXT 거래 대상 아님 · 09:00 정규장부터 갱신";
  return null;
}
