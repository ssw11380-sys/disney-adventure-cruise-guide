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

/** 계좌 한 장 브리핑(3-31)이 이번 세션에 만들어졌으면 알림 앞머리를 계좌 요약으로 */
export interface DigestAccount {
  /** 계좌 브리핑 id (알림을 누르면 계좌 브리핑 화면) */
  id: number;
  /** 당일 손익(원) */
  dayPnl: number;
  dayRate: number | null;
  /** 당일 손익 기여 상위 (앞의 2개만 쓴다) */
  top: Array<{ name: string; amount: number }>;
  /** 오늘 한국 휴장이라 국내 종목의 등락이 직전 거래일 것 → 본문에 한 줄로 밝힌다 */
  krPreviousDay?: boolean;
}

/** 계좌 브리핑 알림 본문에 붙이는 한 줄 (accountNumbers.KR_PREVIOUS_DAY_NOTE 와 같다. 앱 briefingDigest 도 같은 문구) */
export const KR_PREVIOUS_DAY_LINE = "오늘 한국 휴장 · 국내 종목은 직전 거래일 등락";

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

/** 원화 금액: "+1,234원" · "-2,868,108원" · "0원" (반올림한 값의 부호. sign=false 면 + 를 붙이지 않음) */
export function formatWon(n: number, sign = true): string {
  const r = Math.round(n);
  const body = `${Math.abs(r).toLocaleString("ko-KR")}원`;
  return r > 0 ? (sign ? `+${body}` : body) : r < 0 ? `-${body}` : body;
}

/** 등락률 절댓값이 큰 순 (등락률을 모르면 뒤로) */
export function byMove<T extends { changeRate: number | null }>(items: T[]): T[] {
  const size = (r: number | null) => (r === null ? -1 : Math.abs(r));
  return [...items].sort((a, b) => size(b.changeRate) - size(a.changeRate));
}

/**
 * 세션 알림 한 건. 대상이 없으면 null. 1종목이면 예전처럼 종목 이름과 요약.
 * account(3-31)가 있으면 계좌 요약이 앞머리: "오전 계좌 브리핑 · 당일 -2,868,108원 (-1.23%)" / "기여 1위 … · 2위 …" / "종목 브리핑 17종목 · 변동 상위 …".
 * 종목 브리핑이 없어도(모두 끈 종목·모델 장애) 계좌 브리핑만으로 1건
 */
export function buildDigest(session: "morning" | "afternoon", date: string, items: DigestItem[], account?: DigestAccount | null): PushMessage | null {
  if (account) return accountDigest(session, date, items, account);
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

/** 계좌 브리핑이 앞머리인 세션 알림. 예전 앱은 accountBriefingId 를 몰라 digest 를 보고 브리핑 탭으로 간다 */
function accountDigest(session: "morning" | "afternoon", date: string, items: DigestItem[], a: DigestAccount): PushMessage {
  const label = SESSION_KO[session];
  const lines: string[] = [];
  const top = a.top.slice(0, 2);
  if (top.length) lines.push(top.map((t, i) => `${i === 0 ? "기여 1위" : "2위"} ${t.name} ${formatWon(t.amount)}`).join(" · "));
  if (a.krPreviousDay) lines.push(KR_PREVIOUS_DAY_LINE);
  const ranked = byMove(items);
  if (items.length) {
    const movers = ranked.filter((i) => i.changeRate !== null).slice(0, 2);
    lines.push(`종목 브리핑 ${items.length}종목${movers.length ? ` · 변동 상위 ${movers.map((i) => `${i.name} ${formatRate(i.changeRate!)}`).join(" · ")}` : ""}`);
  }
  const first = ranked[0];
  return {
    title: `${label} 계좌 브리핑 · 당일 ${formatWon(a.dayPnl)}${a.dayRate !== null ? ` (${formatRate(a.dayRate)})` : ""}`,
    body: lines.join("\n"),
    data: { type: "briefing", digest: true, session, date, count: items.length, accountBriefingId: a.id, ...(first ? { briefingId: first.briefingId, code: first.code } : {}) },
  };
}
