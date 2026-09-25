import type { MarketStatus, Quote, QuoteSession } from "@/api/types";
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
  return beforeUntil(q.session, now);
}

/** 세션 경계(until)가 아직 안 지났는지. 지났으면 받아 둔 세션은 끝난 것이다 (다시 받기 전 — 줄 점·상태 줄·위젯 칩이 같이 본다) */
function beforeUntil(s: QuoteSession | null | undefined, now: number): boolean {
  const until = s?.until ? Date.parse(s.until) : NaN;
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

/** 시장 하나의 지금 세션과 경계 (잔고 상태 줄 앞머리 한 칸 · 위젯 칩이 고르는 세션) */
export interface SessionView extends MarketSessionView {
  /** 세션 경계(until)가 아직 안 지남 */
  current: boolean;
  until: string | null;
}

/**
 * 보유 종목 세션 → 시장별 지금 세션. 열린 시장 먼저, 같으면 한국 → 미국. 시장마다 경계가 아직 안 지난 세션을 쓴다 (모두 지났으면 그대로 — current false).
 * 잔고 상태 줄(marketSessions)과 위젯 칩(marketChip)이 이 함수 하나로 세션을 고른다 → 칩의 세션 이름은 늘 상태 줄 맨 앞 세션이다.
 * 서버 services/widgetPayload.ts 의 sessionViews 와 같은 함수 (공용 픽스처 stock-briefing/shared/fixtures/marketChip.json — 한쪽을 고치면 다른 쪽도 같이)
 */
export function sessionViews(sessions: readonly (QuoteSession | null | undefined)[], now: number): SessionView[] {
  const pick = new Map<"KR" | "US", SessionView>();
  for (const s of sessions) {
    if (!s) continue;
    const current = beforeUntil(s, now);
    const had = pick.get(s.market);
    if (!had || (!had.current && current)) pick.set(s.market, { market: s.market, label: s.label, open: s.open, current, until: s.until });
  }
  const order = (m: "KR" | "US") => (m === "KR" ? 0 : 1);
  return [...pick.values()].sort((a, b) => Number(b.open) - Number(a.open) || order(a.market) - order(b.market));
}

/**
 * 목록에 있는 시장의 지금 세션 (잔고 상태 줄 앞머리). 열린 시장 먼저, 같으면 한국 → 미국.
 * 시장마다 경계가 아직 안 지난 종목의 세션을 쓴다. 모두 지났으면 이름과 순서는 그대로 두고 닫힌 것으로 본다 (경계 1초 뒤 다시 받는다) —
 * 경계에서 줄 점은 모두 꺼졌는데 상태 줄만 "실시간 N종목"(초록)이나 "지연"(주황)으로 남지 않게. 순서는 sessionViews 그대로다 (공용 픽스처의 head).
 * 세션 정보가 없으면(예전 서버) 빈 배열
 */
export function marketSessions(quotes: Quotes, now: number): MarketSessionView[] {
  return sessionViews(quotes.map((q) => q?.session), now).map(({ market, label, open, current }) => ({ market, label, open: open && current }));
}

/** 칩에 넣는 시장 하나 (다듬은 잔고 위젯): 달력으로 열려 있으면 "한국 장중"·"미국 장중", 아니면 그 시장 보유 종목의 지금 세션 이름 */
export interface ChipMarket {
  market: "KR" | "US";
  label: string;
}

/** 위젯 장 상태 칩 (widgets/payload WidgetMarket 과 같은 모양) */
export interface MarketChip {
  label: string;
  open: boolean;
  /** 시장별 거래 중 (토스 달력. 위젯 지연 판단은 열린 시장의 시세만 본다) */
  kr: boolean;
  us: boolean;
  /** 다음에 칩이 바뀌는 시각 (위젯은 이때 칩을 감추고, 휴장 중 건너뛰던 갱신을 다시 한다) */
  nextChangeAt: string | null;
  /** 시장별 문구 (보유 종목 세션을 넘겼을 때만). 경계가 지난 세션은 넣지 않는다 */
  markets?: ChipMarket[];
}

/**
 * 위젯 장 상태 칩 — 서버 services/widgetPayload.ts 의 marketChip 과 같은 함수 (공용 픽스처 shared/fixtures/marketChip.json).
 * 위젯이 스스로 받은 값(/api/widget?…&sessions=1 — widgets/data.ts WIDGET_PATH)과 앱이 바로 넘기는 값(WidgetBridge)이 번갈아 그려지므로
 * 둘이 다르면 칩이 오락가락한다. 서버는 sessions=1 이 없는 예전 앱에는 달력만 본 칩(sessions 없이 부른 이 함수)을 준다 — 예전 앱의 WidgetBridge 와 같게.
 *  - 토스 달력(한국 08:00~20:00, 미국은 정규장만)으로 열린 시장이 있으면: 실시간 / 한국 장중 / 미국 장중 (금색)
 *  - 두 시장이 달력으로 닫혀 있어도 보유 종목 세션에 열린 세션(미국 프리·애프터·주간거래)이 있으면 문구만 그 세션 이름 — 잔고 상태 줄 맨 앞 세션과 같은 말.
 *    open(금색)·kr·us 는 달력 그대로(위젯 갱신 주기·지연 판단은 그대로)
 *  - 아니면 휴장 / 한국 휴장 / 장 마감. sessions 가 비면(예전 서버·보유 없음) 달력만 — useAnyMarketOpen(잔고 상태 줄의 예전 서버 문구)도 이것
 *  - markets: 시장별 문구 (다듬은 잔고 위젯의 "미국 주간거래 · 한국 휴장"). 달력으로 열린 시장은 "한국 장중"·"미국 장중", 닫힌 시장은 그 시장 세션 이름.
 *    경계가 지난 세션(오프라인으로 옛 값만 있음)은 지금 세션처럼 보이지 않게 뺀다
 *  - nextChangeAt: 달력 경계와, 달력으로 닫힌 시장의 지금 세션 경계 중 가장 이른 때 — 열린 세션이 끝나는 때와 아직 열리지 않은 세션이 시작하는 때
 *    (삼일절 09:29 "휴장"이 10:00 미국 주간거래에 바뀌게)
 * now 는 세션 경계가 지났는지 볼 때만 쓴다 (기본: 장 상태를 받은 시각)
 */
export function marketChip(s: MarketStatus, sessions: readonly (QuoteSession | null | undefined)[] = [], now: number = Date.parse(s.now)): MarketChip {
  const kr = s.KR, us = s.US;
  const t = Number.isFinite(now) ? now : Date.now();
  const calOpen = (m: "KR" | "US") => (m === "KR" ? kr : us).isOpen;
  const views = sessionViews(sessions, t);
  const bounds = [kr, us].map((m) => (m.isOpen ? m.closesAt : m.opensAt)).filter((x): x is string => !!x).sort();
  let nextChangeAt = bounds[0] ?? null;
  for (const v of views) {
    // 경계가 지난 세션(받아 둔 시세가 지난 세션 것)은 쓰지 않는다
    const until = v.current && v.until && !calOpen(v.market) ? Date.parse(v.until) : NaN;
    if (Number.isFinite(until) && (nextChangeAt === null || until < Date.parse(nextChangeAt))) nextChangeAt = new Date(until).toISOString();
  }
  const markets = views.flatMap((v): ChipMarket[] => (calOpen(v.market) ? [{ market: v.market, label: v.market === "KR" ? "한국 장중" : "미국 장중" }] : v.current ? [{ market: v.market, label: v.label }] : []));
  const base = { kr: kr.isOpen, us: us.isOpen, nextChangeAt, ...(views.length ? { markets } : {}) };
  if (kr.isOpen || us.isOpen) return { label: kr.isOpen && us.isOpen ? "실시간" : kr.isOpen ? "한국 장중" : "미국 장중", open: true, ...base };
  const ext = views.find((v) => v.open && v.current);
  if (ext) return { label: ext.label, open: false, ...base };
  if (!kr.isTradingDay && !us.isTradingDay) return { label: "휴장", open: false, ...base };
  if (!kr.isTradingDay) return { label: "한국 휴장", open: false, ...base };
  return { label: "장 마감", open: false, ...base };
}

/** 앱이 위젯에 바로 넘기는 칩 (WidgetBridge): 장 상태(/api/market/status)와 잔고 시세의 세션으로. 장 상태를 모르면 null */
export function widgetChip(status: MarketStatus | null | undefined, stocks: readonly { quote?: Quote | null }[], now: number): MarketChip | null {
  return status ? marketChip(status, stocks.map((s) => s.quote?.session), now) : null;
}

/**
 * 점이 켜진 종목 수와, 지금 열린 세션의 거래 대상으로 확인된 종목 수 (상태 줄의 "지연" 판단). 경계(until)가 지난 세션은 세지 않는다 (줄 점과 같게).
 * 대상인지 모르는 종목(eligible null — 토스 정보를 못 받음, 한국거래소 애프터마켓 대상 목록 없음)은 세지 않는다:
 * 그런 종목은 이 세션에 체결이 있어야 점이 켜지므로, 점이 없다고 "지연"이라 하면 서버·앱이 멀쩡한데도 지연으로 보인다
 */
export function liveCounts(quotes: Quotes, now: number, feedOk: boolean): { live: number; eligible: number } {
  let live = 0;
  let eligible = 0;
  for (const q of quotes) {
    if (quoteLive(q, now, feedOk)) live++;
    if (q?.session?.open && q.session.eligible === true && beforeUntil(q.session, now)) eligible++;
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
 *  - 열린 세션의 거래 대상(확인된 종목)이 있는데 점이 하나도 없음(서버가 값을 못 받는 중): "… · 지연"
 *  - 열린 세션에 거래 대상으로 확인된 종목이 없음(예: NXT 비대상만 보유한 NXT 프리마켓, 대상인지 모르는 종목만 있고 체결이 아직 없음):
 *    "… · 실시간 종목 없음" (회색)
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

/**
 * 상세 화면: 점이 없을 때 그 까닭 한 줄 (거래정지 · 주간거래 미지원 · NXT 비대상 · 애프터마켓 비대상 · 닫힌 세션). 보여 줄 게 없으면 null.
 * NXT 애프터마켓(15:40~16:00) 비대상은 16:00 한국거래소 애프터마켓에서 거래될 수도 있어(ETF·ETN 등은 아님) 다음 갱신 시각을 약속하지 않는다
 */
export function sessionNote(q: Quote | null | undefined): string | null {
  const s = q?.session;
  if (!s) return null;
  if (s.halted) return "거래정지";
  if (!s.open) return s.label;
  if (s.eligible !== false) return null;
  if (s.phase === "overnight") return "주간거래 미지원 종목";
  if (s.phase === "nxt_pre") return "NXT 거래 대상 아님 · 09:00 정규장부터 갱신";
  if (s.phase === "nxt_after") return "NXT 거래 대상 아님";
  if (s.market === "KR" && s.phase === "after") return "애프터마켓 거래 대상 아님";
  return null;
}
