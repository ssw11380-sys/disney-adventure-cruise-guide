import type { FilingAlertItem, ScheduleFilingItem, ScheduleFilings } from "@/api/types";
import { sentence } from "@/lib/a11y";
import { speakDay } from "@/lib/accountSinceLast";
import { inQuietHours, type NotifyPrefs } from "@/lib/briefingDigest";
import { mdw } from "@/lib/marketSummary";

/**
 * 3-38 새 공시 알림·일정 화면 (플래그 filingAlerts·holdingSchedule) 순수 함수 — React Native 를 불러오지 않는다 (테스트·백그라운드 태스크).
 * 공시 제목은 서버가 SEC 서식·항목 번호를 우리말로 옮긴 것('실적 발표(8-K 2.02)') 그대로. 사실만: 판단·권유하는 말 없음, 등락 색 없음.
 * 문구는 공용 픽스처(shared/fixtures/filingAlerts.json texts)와 같다 — 서버 문구 검사(BRIEFING_BANNED)가 같은 글을 본다
 */

// ── 문구 ──────────────────────────────────────────────────────────

export const SCHEDULE_TITLE = "일정·공시";
export const SCHEDULE_LINK = "일정·공시 모두 보기";
export const SCHEDULE_LINK_SPEECH = "보유 종목 일정과 공시 모두 보기";
export const SCHEDULE_OFF = "지금은 일정·공시를 볼 수 없습니다";
export const EVENTS_LOADING = "일정을 받는 중…";
/** 실적 발표일(holdingEarnings)이 꺼져 있고 미국 보유가 있을 때 '다가오는 일정' 카드 작은 글 */
export const EARNINGS_AFTER_FILING = "미국 실적은 발표된 뒤 공시(8-K 2.02)로 보입니다.";
export const FILINGS_HEAD = "최근 공시 (미국)";
export const FILINGS_NO_US = "미국 보유 종목이 없어 공시를 확인하지 않습니다.";
export const FILINGS_NONE_COVERED = "공시를 확인하는 미국 보유 종목이 없습니다.";
export const FILINGS_FAILED = "공시 목록을 받지 못했습니다. 화면을 다시 열면 다시 받습니다.";
export const TITLE_NOTE = "공시 제목은 SEC 서식과 항목 번호를 우리말로 옮긴 것이며, 내용 요약이 아닙니다.";
export const STALE_NEVER = "SEC 공시 확인이 아직 되지 않았습니다. 서버가 다시 확인하면 채워집니다.";
export const NEW_CHIP = "새 공시";
export const EXPAND_HINT = "누르면 자세히";
export const ITEMS_HEAD = "들어 있는 항목";
export const OPEN_ORIGINAL = "SEC 원문 보기 (영어)";
export const OPEN_ORIGINAL_SPEECH = "SEC 원문 보기, 영어, 브라우저로 열림";
export const OPEN_FAILED = "원문을 열지 못했습니다.";
export const KR_HEAD = "한국 공시";
export const KR_NO_KEY = "한국 공시 알림은 DART 키가 있어야 받을 수 있습니다.";
export const KR_NOT_YET = "한국 공시 알림은 다음 단계에서 넣습니다.";
export const SETTING_TITLE = "공시 알림";
export const SETTING_ABOUT = "보유 미국 종목에 새 SEC 공시(실적 발표·분기 보고서 등)가 올라오면 알립니다.";
export const SETTING_MUTED = "종목별 알림에서 끈 종목은 공시 알림도 오지 않습니다.";
export const SETTING_DEVICE_OFF = "위 브리핑 알림을 켜야 이 기기에 알림이 옵니다.";
export const CHANNEL_NAME = "공시 알림";
export const CHANNEL_ABOUT = "보유 미국 종목의 새 SEC 공시";

/** 화면에 보이는 공시 줄 수 (넘으면 '외 N건') */
export const FILING_LINES_MAX = 30;
/** 화면 '최근 공시'의 기간 (서버 SCHEDULE_FILING_DAYS 와 같다) */
export const FILING_DAYS = 30;
/** 알림 본문에 이름을 보이는 공시 수 (넘으면 '외 N건') */
export const NOTIFY_LINES_MAX = 3;
/** 접수 뒤 이 시간이 지난 공시는 알리지 않는다 (서버 ALERT_MAX_AGE_MS 와 같다) */
export const ALERT_MAX_AGE_MS = 24 * 3_600_000;
/** 대상 아님 줄에 보이는 이름 수 */
const NAMES_MAX = 5;
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;

export function filingsSub(days: number): string {
  return `보유 미국 종목 · 최근 ${days}일 · SEC`;
}
export function filingsNone(days: number): string {
  return `최근 ${days}일 안에 올라온 공시가 없습니다.`;
}
export function settingQuiet(start: string, end: string): string {
  return `조용한 시간(${start}~${end})에 올라온 공시는 조용한 시간이 끝난 뒤 한 번에 알립니다.`;
}

/** 알림 data·주소의 접수 번호 (모양이 다르면 null — 화면 주소에 넣기 전에 거른다) */
export function parseAccession(v: unknown): string | null {
  return typeof v === "string" && ACCESSION_RE.test(v) ? v : null;
}

// ── 시각 ──────────────────────────────────────────────────────────

/** 'HH:MM' → '오전 5시 4분' · '오후 4시' · '오전 12시' (자정) */
export function speakAmPm(hm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return hm;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h < 12 ? "오전" : "오후"} ${h12}시${min ? ` ${min}분` : ""}`;
}

/** 벽시계 'YYYY-MM-DDTHH:MM' → { text: '7/30(목) 05:04', speech: '7월 30일 목요일 오전 5시 4분' } (읽지 못하면 null) */
function wall(v: string | null): { text: string; speech: string } | null {
  const m = v ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(v) : null;
  if (!m) return null;
  return { text: `${mdw(m[1]!)} ${m[2]}`, speech: `${speakDay(m[1]!)} ${speakAmPm(m[2]!)}` };
}

/**
 * 제목을 두 묶음으로: '중요 계약 체결 외 3건' + '(8-K 1.01)' — 좁은 칸·큰 글씨에서 서식 번호 묶음째 다음 줄로 가게 (묶음 안 공백은 줄바꿈 없는 공백).
 * 괄호가 없으면 한 묶음
 */
export function titleChunks(title: string): string[] {
  const m = /^(.*?)(\(.+\))$/.exec(title);
  return m && m[1] ? [m[1], m[2]!.replace(/ /g, " ")] : [title];
}

/** 제목 '실적 발표(8-K 2.02)' → 읽는 말 '실적 발표, 8-K 2.02' · '연간 보고서(20-F, 외국 기업)' → '연간 보고서, 20-F, 외국 기업' */
export function titleSpeech(title: string): string {
  const m = /^(.*)\((.+)\)$/.exec(title);
  return m ? sentence([m[1]!.trim(), m[2]!.trim()]) : title;
}

export interface FilingLine {
  key: string;
  /** '7/30(목) 05:04' (접수 시각을 모르면 제출일 '7/29(수)') */
  when: string;
  /** 첫 줄 '7/30(목) 05:04 · 마이크로소프트' */
  head: string;
  /** 둘째 줄 = 서버 제목 */
  title: string;
  /** 화면 읽기 한 문장 '7월 30일 목요일 오전 5시 4분, 마이크로소프트, 실적 발표, 8-K 2.02, 새 공시' */
  speech: string;
  /** 펼친 첫 줄 'SEC에 올라온 시각: 한국 7/30(목) 05:04 · 미국 동부 7/29(수) 16:04' */
  time: string;
  timeSpeech: string;
}

/** 공시 한 줄의 글과 읽는 말 (isNew = 화면의 '새 공시' 칩이 보일 때) */
export function filingLine(i: FilingAlertItem, isNew = false): FilingLine {
  const k = wall(i.kst);
  const e = wall(i.et);
  const when = k?.text ?? mdw(i.filingDate);
  return {
    key: i.accession,
    when,
    head: `${when} · ${i.name}`,
    title: i.title,
    speech: sentence([k?.speech ?? speakDay(i.filingDate), i.name, titleSpeech(i.title), isNew ? NEW_CHIP : null]),
    time: k && e ? `SEC에 올라온 시각: 한국 ${k.text} · 미국 동부 ${e.text}` : `SEC 제출일: ${mdw(i.filingDate)} (미국 날짜)`,
    timeSpeech: k && e ? sentence(["SEC에 올라온 시각", `한국 ${k.speech}`, `미국 동부 ${e.speech}`]) : sentence(["SEC 제출일", `${speakDay(i.filingDate)} 미국 날짜`]),
  };
}

/** 순간(ISO) → 서울 { text: '9/29 08:40', speech: '9월 29일 8시 40분' } */
function stamp(iso: string | null): { text: string; speech: string } | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const s = new Date(t + 9 * 3_600_000).toISOString();
  const md = `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  const hm = s.slice(11, 16);
  return { text: `${md} ${hm}`, speech: `${Number(s.slice(5, 7))}월 ${Number(s.slice(8, 10))}일 ${speakAmPm(hm)}` };
}

const names = (list: readonly { name: string }[]) => {
  const shown = list.slice(0, NAMES_MAX).map((x) => x.name);
  const more = list.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` 외 ${more}종목` : ""}`;
};

/** '공시를 확인하지 않는 종목: QQQ, SOXL (ETF·ETN) · ABCD (SEC 목록에 없음)' — 이름은 종류마다 5개까지 */
export function notCoveredNote(list: ScheduleFilings["notCovered"]): string | null {
  const etf = list.filter((x) => x.reason === "etf");
  const nf = list.filter((x) => x.reason === "notFound");
  const parts = [etf.length ? `${names(etf)} (ETF·ETN)` : null, nf.length ? `${names(nf)} (SEC 목록에 없음)` : null].filter((x): x is string => x !== null);
  return parts.length ? `공시를 확인하지 않는 종목: ${parts.join(" · ")}` : null;
}

/** 'SEC 공시 확인이 9/29 07:55 이후 되지 않았습니다. 서버가 다시 확인하면 채워집니다.' */
export function staleNote(lastOkAt: string | null): string {
  const at = stamp(lastOkAt);
  return at ? `SEC 공시 확인이 ${at.text} 이후 되지 않았습니다. 서버가 다시 확인하면 채워집니다.` : STALE_NEVER;
}
export function failedNote(list: readonly { name: string }[]): string {
  return `공시를 받지 못한 종목: ${names(list)} (다음 확인 때 다시 받습니다)`;
}
export function pendingNote(list: readonly { name: string }[]): string {
  return `아직 공시를 확인하지 않은 종목: ${names(list)} (서버가 확인하는 중입니다)`;
}

export interface FilingsView {
  title: string;
  sub: string;
  /** 보이는 줄 (FILING_LINES_MAX 까지) — 새 공시 칩 여부 포함 */
  lines: { item: ScheduleFilingItem; line: FilingLine; isNew: boolean }[];
  /** 넘친 줄 수 ('외 N건' — 서버가 주지 않은 줄 포함) */
  more: number;
  /** 줄이 없을 때 한 줄 */
  empty: string | null;
  /** 작은 글: 제목 뜻(줄이 있을 때) · 멈춤 · 받지 못한 종목 · 아직 확인하지 않은 종목 · 대상 아님 */
  notes: string[];
  /** '9/29 08:40 기준 · 출처 SEC EDGAR' (모두 받은 시각을 모르면 '출처 SEC EDGAR') */
  basis: string;
  basisSpeech: string;
  /** 새 공시 수 (칩이 보이는 줄) */
  fresh: number;
}

/**
 * '최근 공시 (미국)' 칸의 글 (설계 2.2 ②). viewed = 이 기기에서 펼쳐 본 접수 번호 — '새 공시' 칩은 서버 isNew 이고 아직 펼쳐 보지 않은 줄에만.
 * 미국 보유 종목이 없으면(확인 0 · 대상 아님만) '미국 보유 종목이 없어 …'
 */
export function scheduleFilingsView(f: ScheduleFilings, viewed: ReadonlySet<string> = new Set(), days = FILING_DAYS): FilingsView {
  const all = f.items.map((item) => {
    const isNew = item.isNew && !viewed.has(item.accession);
    return { item, line: filingLine(item, isNew), isNew };
  });
  const lines = all.slice(0, FILING_LINES_MAX);
  const noUs = f.watched === 0 && f.failed.length === 0 && f.pending.length === 0;
  const stale = f.warning === "stale" || f.warning === "shape" || f.warning === "blocked";
  const notes = [
    all.length ? TITLE_NOTE : null,
    stale ? staleNote(f.lastOkAt) : null,
    f.failed.length ? failedNote(f.failed) : null,
    f.pending.length ? pendingNote(f.pending) : null,
    notCoveredNote(f.notCovered),
  ].filter((x): x is string => x !== null);
  const at = stamp(f.lastOkAt);
  return {
    title: FILINGS_HEAD,
    sub: filingsSub(days),
    lines,
    more: all.length - lines.length + Math.max(0, f.more),
    // 미국 보유가 ETF·ETN 뿐이면 '없어'가 아니라 '확인하는 종목이 없습니다' (아래 대상 아님 글이 이유를 밝힌다)
    empty: all.length ? null : noUs ? (f.notCovered.length ? FILINGS_NONE_COVERED : FILINGS_NO_US) : filingsNone(days),
    notes,
    basis: [at ? `${at.text} 기준` : null, "출처 SEC EDGAR"].filter((x): x is string => x !== null).join(" · "),
    basisSpeech: sentence([at ? `${at.speech} 기준` : null, "출처 SEC EDGAR"]),
    fresh: all.filter((x) => x.isNew).length,
  };
}

/** 계좌 상세 링크 줄 끝 '· 새 공시 2건' (0이면 null) */
export function freshSuffix(n: number): string | null {
  return n > 0 ? `· 새 공시 ${n}건` : null;
}

// ── 알림 ──────────────────────────────────────────────────────────

export interface FilingMessage {
  title: string;
  body: string;
  data: { type: "filing"; accessions: string[]; focus: string };
}

/**
 * 알림 한 건 (설계 2.4): 1건 '마이크로소프트 새 공시' / '실적 발표(8-K 2.02) · SEC에 7/30(목) 05:04 올라옴',
 * 여러 건 '보유 종목 새 공시 3건' / '마이크로소프트 · 실적 발표(8-K 2.02)' 줄 3개까지 + '외 N건'. 순서는 받은 그대로(최신 먼저)
 */
export function filingMessage(items: readonly FilingAlertItem[]): FilingMessage | null {
  if (!items.length) return null;
  const data = { type: "filing" as const, accessions: items.map((i) => i.accession), focus: items[0]!.accession };
  if (items.length === 1) {
    const i = items[0]!;
    return { title: `${i.name} 새 공시`, body: `${i.title} · SEC에 ${filingLine(i).when} 올라옴`, data };
  }
  const shown = items.slice(0, NOTIFY_LINES_MAX).map((i) => `${i.name} · ${i.title}`);
  const more = items.length - shown.length;
  return { title: `보유 종목 새 공시 ${items.length}건`, body: [...shown, more > 0 ? `외 ${more}건` : null].filter((x): x is string => x !== null).join("\n"), data };
}

export interface FilingPlanInput {
  /** 서버 알림 목록 (/api/filings/alerts — 최신 먼저) */
  items: readonly FilingAlertItem[];
  /** 이미 본(알렸거나 알리지 않기로 한) 접수 번호 */
  seen: ReadonlySet<string>;
  /** 기준을 잡았는지 (기능을 처음 켬·앱 설치 뒤 첫 확인이면 false) */
  init: boolean;
  /** 알림 규칙: 조용한 시간·끈 종목 (서버 /api/notifications/settings) */
  prefs: Pick<NotifyPrefs, "quietEnabled" | "quietStart" | "quietEnd" | "mutedCodes">;
  /** 이 기기 '공시 알림' 스위치 */
  enabled: boolean;
  now: Date;
}

export interface FilingPlan {
  /** 보낼 알림 (없으면 null) */
  message: FilingMessage | null;
  /** '본 것'으로 적을 접수 번호 */
  markSeen: string[];
  /** 알린 공시 (기기 기록 — 설정 '마지막 공시 알림') */
  notified: FilingAlertItem[];
  /** 기준을 잡음 (첫 확인) */
  init: boolean;
  /** 조용한 시간이라 미룸 (아무것도 적지 않음) */
  deferred: boolean;
}

/**
 * 알림 규칙 (설계 6.2, 표 테스트):
 *  1. 기준을 아직 안 잡음 → 모두 '본 것', 알림 0
 *  2. 이미 본 접수 번호 → 건너뜀
 *  3. 접수 시각(없으면 서버가 처음 본 시각)이 24시간보다 오래됨 → 조용히 '본 것'
 *  4. 이 기기 '공시 알림' 끔 · 종목별 알림에서 끈 종목 → 조용히 '본 것' (다시 켰을 때 밀린 것이 쏟아지지 않게)
 *  5. 조용한 시간이면 → 아무것도 적지 않고 미룸 (끝난 뒤 첫 확인에서 3번 규칙 안의 것만 한 번에)
 *  6. 남은 것 → 알림 1건, 모두 '본 것'
 */
export function planFilingNotification(input: FilingPlanInput): FilingPlan {
  const fresh = input.items.filter((i, idx, arr) => !input.seen.has(i.accession) && arr.findIndex((x) => x.accession === i.accession) === idx);
  const none: FilingPlan = { message: null, markSeen: [], notified: [], init: false, deferred: false };
  if (!input.init) return { ...none, markSeen: fresh.map((i) => i.accession), init: true };
  if (!fresh.length) return none;
  const now = input.now.getTime();
  const muted = new Set(input.prefs.mutedCodes);
  const quiet: string[] = [];
  const send: FilingAlertItem[] = [];
  for (const i of fresh) {
    const ref = Date.parse(i.acceptedAt ?? i.firstSeenAt);
    if (Number.isNaN(ref) || now - ref > ALERT_MAX_AGE_MS || !input.enabled || muted.has(i.code)) quiet.push(i.accession);
    else send.push(i);
  }
  if (send.length && inQuietHours(input.prefs, input.now)) return { ...none, markSeen: quiet, deferred: true };
  return { message: filingMessage(send), markSeen: [...quiet, ...send.map((i) => i.accession)], notified: send, init: false, deferred: false };
}

// ── 설정 '마지막 공시 알림' ─────────────────────────────────────────

export interface FilingLogEntry {
  accession: string;
  /** SEC 접수 시각 (모르면 null) */
  acceptedAt: string | null;
  /** 이 기기가 알린 때 ISO */
  notifiedAt: string;
}

/** 'n시간 m분' · 'm분' · '1분 미만' */
function span(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "1분 미만";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}시간${m ? ` ${m}분` : ""}` : `${m}분`;
}

/** '마지막 공시 알림 7/30(목) 07:03 · SEC에 올라온 뒤 1시간 59분' (기록이 없으면 null) */
export function lastAlertLine(log: readonly FilingLogEntry[]): string | null {
  const last = log[log.length - 1];
  if (!last) return null;
  const t = Date.parse(last.notifiedAt);
  if (Number.isNaN(t)) return null;
  const k = new Date(t + 9 * 3_600_000).toISOString();
  const when = `${mdw(k.slice(0, 10))} ${k.slice(11, 16)}`;
  const acc = last.acceptedAt ? Date.parse(last.acceptedAt) : NaN;
  return `마지막 공시 알림 ${when}${Number.isNaN(acc) || t < acc ? "" : ` · SEC에 올라온 뒤 ${span(t - acc)}`}`;
}
