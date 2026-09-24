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
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  mutedCodes: string[];
}

/** 서버 설정을 못 받았을 때 (3-19 기본값) */
export const DEFAULT_PREFS: NotifyPrefs = { digest: true, quietEnabled: true, quietStart: "22:00", quietEnd: "07:00", mutedCodes: [] };

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

/** 등락률 절댓값이 큰 순 (모르면 뒤로, 같으면 원래 순서) */
export function byMove<T>(items: T[], rate: (item: T) => number | null | undefined): T[] {
  const size = (r: number | null | undefined) => (r === null || r === undefined || !Number.isFinite(r) ? -1 : Math.abs(r));
  return items
    .map((item, i) => ({ item, i, s: size(rate(item)) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

export function buildDigest(session: "morning" | "afternoon", date: string, items: DigestItem[]): DigestMessage | null {
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
  return { title: `${label} 브리핑 ${items.length}종목`, body: lines.join("\n"), data: { type: "briefingDigest", session, date, count: items.length, briefingId: ranked[0]!.briefingId } };
}

/** 새 브리핑들을 세션(날짜·오전/오후)별로 묶어 알림 목록으로. 조용한 시간이면 빈 목록, 끈 종목은 뺀다 (묶음이 켜져 있을 때) */
export function planNotifications(
  fresh: (DigestItem & { session: "morning" | "afternoon"; date: string })[],
  prefs: NotifyPrefs,
  now: Date,
): DigestMessage[] {
  // 묶음을 끄면(플래그) 예전 그대로: 종목마다 1건, 조용한 시간·끈 종목 없음 (서버와 같게)
  if (!prefs.digest) return fresh.map((f) => buildDigest(f.session, f.date, [f])!);
  if (inQuietHours(prefs, now)) return [];
  const muted = new Set(prefs.mutedCodes);
  const items = fresh.filter((f) => !muted.has(f.code));
  const groups = new Map<string, typeof items>();
  for (const f of items) {
    const k = `${f.date}|${f.session}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  return [...groups.values()].map((g) => buildDigest(g[0]!.session, g[0]!.date, g)!);
}
