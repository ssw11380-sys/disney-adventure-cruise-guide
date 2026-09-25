/**
 * 브리핑 알림 묶음 (3-19). 서버 backend/src/notifications/digest.ts 와 같은 규칙·문구 —
 * 백그라운드 확인(로컬 알림)도 세션마다 1건, 조용한 시간에는 0건, 알림을 끈 종목은 뺀다.
 * React Native 를 불러오지 않는 순수 모듈 (테스트·백그라운드 태스크에서 씀)
 */

export interface DigestItem {
  briefingId: number;
  code: string;
  name: string;
  summary: string;
  changeRate: number | null;
}

export interface NotifyPrefs {
  /** 세션당 1건으로 묶기 (서버 briefingDigest 플래그). false 면 예전처럼 종목마다 */
  digest: boolean;
  /** 계좌 한 장 브리핑 (서버 accountBriefing 플래그, 3-31). 켜져 있으면 세션 알림 앞머리가 계좌 요약. 예전 서버는 없음 → 꺼짐 */
  accountBriefing?: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  mutedCodes: string[];
}

/** 서버 설정을 못 받았을 때 (3-19 기본값) */
export const DEFAULT_PREFS: NotifyPrefs = { digest: true, accountBriefing: false, quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [] };

export interface DigestMessage {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

const SESSION_KO = { morning: "오전", afternoon: "오후" } as const;
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** 한국 시간으로 조용한 시간인지 (기기 시간대와 상관없이) */
export function inQuietHours(p: Pick<NotifyPrefs, "quietEnabled" | "quietStart" | "quietEnd">, now: Date): boolean {
  if (!p.quietEnabled) return false;
  const start = toMin(p.quietStart);
  const end = toMin(p.quietEnd);
  if (start === end) return false;
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export function formatRate(r: number): string {
  return `${r > 0 ? "+" : ""}${r.toFixed(2)}%`;
}

/** 원화 금액: "+1,234원" · "-2,868,108원" · "0원" (서버 formatWon 과 같다) */
export function formatWonSigned(n: number, sign = true): string {
  const r = Math.round(n);
  const body = `${Math.abs(r).toLocaleString("ko-KR")}원`;
  return r > 0 ? (sign ? `+${body}` : body) : r < 0 ? `-${body}` : body;
}

/** 세션 알림 앞머리에 쓰는 계좌 브리핑 (3-31, 서버 DigestAccount 와 같다) */
export interface DigestAccount {
  id: number;
  dayPnl: number;
  dayRate: number | null;
  top: { name: string; amount: number }[];
}

/** 계좌 브리핑 목록 항목(/api/account-briefings) → 알림 앞머리 (성공한 것만) */
export function digestAccountOf(
  b: { id: number; status: "ok" | "failed"; headline: { dayPnl: number; dayRate: number | null; top: { name: string; amount: number }[] } | null } | null | undefined,
): DigestAccount | null {
  if (!b || b.status !== "ok" || !b.headline) return null;
  return { id: b.id, dayPnl: b.headline.dayPnl, dayRate: b.headline.dayRate, top: b.headline.top.map((t) => ({ name: t.name, amount: t.amount })) };
}

/** 등락률 절댓값이 큰 순 (모르면 뒤로, 같으면 원래 순서) */
export function byMove<T>(items: T[], rate: (item: T) => number | null | undefined): T[] {
  const size = (r: number | null | undefined) => (r === null || r === undefined || !Number.isFinite(r) ? -1 : Math.abs(r));
  return items
    .map((item, i) => ({ item, i, s: size(rate(item)) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

/**
 * 세션 알림 한 건 (서버 buildDigest 와 같은 문구). account(3-31)가 있으면 앞머리가 계좌 요약이고,
 * 종목 브리핑이 없어도(모두 끈 종목) 계좌 브리핑만으로 1건. 누르면 계좌 브리핑 화면(accountBriefingId)
 */
export function buildDigest(session: "morning" | "afternoon", date: string, items: DigestItem[], account?: DigestAccount | null): DigestMessage | null {
  if (account) return accountDigest(session, date, items, account);
  if (items.length === 0) return null;
  const label = SESSION_KO[session];
  if (items.length === 1) {
    const b = items[0]!;
    return { title: `${b.name} ${label} 브리핑`, body: b.summary, data: { type: "briefing", briefingId: b.briefingId, code: b.code, session, date } };
  }
  const ranked = byMove(items, (i) => i.changeRate);
  const top = ranked.filter((i) => i.changeRate !== null).slice(0, 2);
  const lines: string[] = [];
  if (top.length) lines.push(`변동 상위 ${top.map((i) => `${i.name} ${formatRate(i.changeRate!)}`).join(" · ")}`);
  const first = (ranked[0]!.summary.split("\n")[0] ?? "").trim();
  if (first) lines.push(`${ranked[0]!.name}: ${first}`);
  return { title: `${label} 브리핑 ${items.length}종목`, body: lines.join("\n"), data: { type: "briefing", digest: true, session, date, count: items.length, briefingId: ranked[0]!.briefingId, code: ranked[0]!.code } };
}

function accountDigest(session: "morning" | "afternoon", date: string, items: DigestItem[], a: DigestAccount): DigestMessage {
  const label = SESSION_KO[session];
  const lines: string[] = [];
  const top = a.top.slice(0, 2);
  if (top.length) lines.push(top.map((t, i) => `${i === 0 ? "기여 1위" : "2위"} ${t.name} ${formatWonSigned(t.amount)}`).join(" · "));
  const ranked = byMove(items, (i) => i.changeRate);
  if (items.length) {
    const movers = ranked.filter((i) => i.changeRate !== null).slice(0, 2);
    lines.push(`종목 브리핑 ${items.length}종목${movers.length ? ` · 변동 상위 ${movers.map((i) => `${i.name} ${formatRate(i.changeRate!)}`).join(" · ")}` : ""}`);
  }
  const first = ranked[0];
  return {
    title: `${label} 계좌 브리핑 · 당일 ${formatWonSigned(a.dayPnl)}${a.dayRate !== null ? ` (${formatRate(a.dayRate)})` : ""}`,
    body: lines.join("\n"),
    data: { type: "briefing", digest: true, session, date, count: items.length, accountBriefingId: a.id, ...(first ? { briefingId: first.briefingId, code: first.code } : {}) },
  };
}

/**
 * 새 브리핑들을 세션(날짜·오전/오후)별로 묶어 알림 목록으로. 조용한 시간이면 빈 목록, 끈 종목은 뺀다 (묶음이 켜져 있을 때).
 * accounts(3-31): 같은 날짜·세션의 계좌 브리핑이 있고 서버 플래그(prefs.accountBriefing)가 켜져 있으면 그 세션 알림의 앞머리로 — 여전히 세션당 1건
 */
export function planNotifications(
  fresh: (DigestItem & { session: "morning" | "afternoon"; date: string })[],
  prefs: NotifyPrefs,
  now: Date,
  accounts: readonly (Parameters<typeof digestAccountOf>[0] & { date: string; session: "morning" | "afternoon" })[] = [],
): DigestMessage[] {
  // 묶음을 끄면(플래그) 예전 그대로: 종목마다 1건, 조용한 시간·끈 종목 없음 (서버와 같게)
  if (!prefs.digest) return fresh.map((f) => buildDigest(f.session, f.date, [f])!);
  if (inQuietHours(prefs, now)) return [];
  const muted = new Set(prefs.mutedCodes);
  const groups = new Map<string, { session: "morning" | "afternoon"; date: string; items: typeof fresh }>();
  for (const f of fresh) {
    const k = `${f.date}|${f.session}`;
    const g = groups.get(k) ?? { session: f.session, date: f.date, items: [] };
    if (!muted.has(f.code)) g.items.push(f);
    groups.set(k, g);
  }
  const out: DigestMessage[] = [];
  for (const g of groups.values()) {
    const account = prefs.accountBriefing ? digestAccountOf(accounts.find((a) => a && a.date === g.date && a.session === g.session)) : null;
    const m = buildDigest(g.session, g.date, g.items, account);
    if (m) out.push(m);
  }
  return out;
}

/** 브리핑 시간이 조용한 시간 안이면 알림이 가지 않는다고 미리 알린다 (예: 오전 06:30) */
export function quietWarnings(s: { quietEnabled?: boolean; quietStart?: string; quietEnd?: string; morningTime: string; afternoonTime: string; morningEnabled: boolean; afternoonEnabled: boolean }): string[] {
  if (!s.quietEnabled || !s.quietStart || !s.quietEnd) return [];
  const q = { quietEnabled: true, quietStart: s.quietStart, quietEnd: s.quietEnd };
  const at = (hhmm: string) => new Date(`2026-01-05T${hhmm}:00+09:00`);
  const out: string[] = [];
  if (s.morningEnabled && inQuietHours(q, at(s.morningTime))) out.push(`오전 브리핑(${s.morningTime})이 조용한 시간 안이라 알림이 가지 않습니다`);
  if (s.afternoonEnabled && inQuietHours(q, at(s.afternoonTime))) out.push(`오후 브리핑(${s.afternoonTime})이 조용한 시간 안이라 알림이 가지 않습니다`);
  return out;
}
