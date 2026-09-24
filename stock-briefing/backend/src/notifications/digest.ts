import type { PushMessage } from "./push.js";

/**
 * 브리핑 알림 묶음 (3-19). 세션(오전·오후)마다 알림 1건: "오후 브리핑 17종목" + 변동 상위 2종목.
 * 앱의 백그라운드 확인(로컬 알림)도 같은 규칙을 쓴다 (app/src/lib/briefingDigest.ts 와 문구를 맞춘다).
 * 권유로 읽힐 말은 쓰지 않는다 — 종목 이름과 등락률, 요약 첫 줄만.
 */

export interface DigestItem {
  briefingId: number;
  code: string;
  name: string;
  summary: string;
  /** 브리핑 시점 전일 대비 등락률(%). 모르면 null */
  changeRate: number | null;
}

export interface QuietHours {
  quietEnabled: boolean;
  /** HH:MM (한국 시간) */
  quietStart: string;
  quietEnd: string;
}

const SESSION_KO = { morning: "오전", afternoon: "오후" } as const;

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** 한국 시간으로 조용한 시간인지. 22:00~07:00 처럼 자정을 넘기는 구간도 */
export function inQuietHours(s: QuietHours, now: Date): boolean {
  if (!s.quietEnabled) return false;
  const start = toMin(s.quietStart);
  const end = toMin(s.quietEnd);
  if (start === end) return false;
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export function formatRate(r: number): string {
  return `${r > 0 ? "+" : ""}${r.toFixed(2)}%`;
}

/** 등락률 절댓값이 큰 순 (등락률을 모르면 뒤로) */
export function byMove<T extends { changeRate: number | null }>(items: T[]): T[] {
  const size = (r: number | null) => (r === null ? -1 : Math.abs(r));
  return [...items].sort((a, b) => size(b.changeRate) - size(a.changeRate));
}

/** 세션 알림 한 건. 대상이 없으면 null. 1종목이면 예전처럼 종목 이름과 요약 */
export function buildDigest(session: "morning" | "afternoon", date: string, items: DigestItem[]): PushMessage | null {
  if (items.length === 0) return null;
  const label = SESSION_KO[session];
  if (items.length === 1) {
    const b = items[0]!;
    return { title: `${b.name} ${label} 브리핑`, body: b.summary, data: { type: "briefing", briefingId: b.briefingId, code: b.code, session, date } };
  }
  const ranked = byMove(items);
  const top = ranked.filter((i) => i.changeRate !== null).slice(0, 2);
  const lines: string[] = [];
  if (top.length) lines.push(`변동 상위 ${top.map((i) => `${i.name} ${formatRate(i.changeRate!)}`).join(" · ")}`);
  const first = (ranked[0]!.summary.split("\n")[0] ?? "").trim();
  if (first) lines.push(`${ranked[0]!.name}: ${first}`);
  return {
    title: `${label} 브리핑 ${items.length}종목`,
    body: lines.join("\n"),
    // 예전 앱은 type "briefing" + briefingId 만 알아듣는다 → 1위 종목 브리핑으로 열리게 두고, 새 앱은 digest 를 보고 브리핑 탭으로
    data: { type: "briefing", digest: true, session, date, count: items.length, briefingId: ranked[0]!.briefingId, code: ranked[0]!.code },
  };
}
