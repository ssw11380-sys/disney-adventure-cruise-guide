import type { FilingAlertItem, HoldingSchedule, ScheduleFilingItem, ScheduleFilings } from "@/api/types";
import { sentence, speakClock } from "@/lib/a11y";
import { speakDay } from "@/lib/accountSinceLast";
import { inQuietHours, type NotifyPrefs } from "@/lib/briefingDigest";
import type { EventsView } from "@/lib/holdingEvents";
import { mdw } from "@/lib/marketSummary";
import { isKrCode, nyOffsetByRule } from "@/lib/marketTime";

/**
 * 3-38 새 공시 알림·일정 화면 (플래그 filingAlerts·holdingSchedule) 순수 함수 — React Native 를 불러오지 않는다 (테스트·백그라운드 태스크).
 * 공시 제목은 서버가 SEC 서식·항목 번호를 우리말로 옮긴 것('실적 발표(8-K 2.02)') 그대로. 사실만: 판단·권유하는 말 없음, 등락 색 없음.
 * 문구는 공용 픽스처(shared/fixtures/filingAlerts.json texts)와 같다 — 서버 문구 검사(BRIEFING_BANNED)가 같은 글을 본다
 */

// ── 문구 ──────────────────────────────────────────────────────────

export const SCHEDULE_TITLE = "일정·공시";
/** '일정·공시' 화면이 꺼져 있고(holdingSchedule) 공시 알림만 켜져 있을 때 알림으로 온 화면의 제목 (최근 3일 새 공시만) */
export const ALERTS_TITLE = "새 공시";
export const SCHEDULE_LINK = "일정·공시 모두 보기";
/** 링크의 화면 읽기 이름은 보이는 글(SCHEDULE_LINK) 그대로 — 음성 명령으로 보이는 글을 말해도 맞게(label-in-name). 뜻은 힌트로 */
export const SCHEDULE_LINK_HINT = "보유 종목 일정과 공시 화면 열기";
export const SCHEDULE_OFF = "지금은 일정·공시를 볼 수 없습니다";
/** 받는 중 한 줄 — 앱이 아는 서버 플래그로 (scheduleLoadingText) */
export const SCHEDULE_LOADING = "일정·공시를 받는 중…";
export const EVENTS_LOADING = "일정을 받는 중…";
export const FILINGS_LOADING = "공시를 받는 중…";
/** 실적 발표일(holdingEarnings)이 꺼져 있고 미국 보유가 있을 때 '다가오는 일정' 카드 작은 글 */
export const EARNINGS_AFTER_FILING = "미국 실적은 발표된 뒤 공시(8-K 2.02)로 보입니다.";
export const FILINGS_HEAD = "최근 공시 (미국)";
export const FILINGS_NO_US = "미국 보유 종목이 없어 공시를 확인하지 않습니다.";
export const FILINGS_NONE_COVERED = "공시를 확인하는 미국 보유 종목이 없습니다.";
export const FILINGS_FAILED = "공시 목록을 받지 못했습니다. 화면을 다시 열면 다시 받습니다.";
/** '일정·공시' 요청이 실패했을 때 (일정도 같은 요청이라 함께 밝힌다) — 서버가 공시를 꺼 두었으면 EVENTS_FAILED_SCREEN */
export const SCHEDULE_FAILED = "일정·공시를 받지 못했습니다. 화면을 다시 열면 다시 받습니다.";
/** 일정만 받지 못함 (서버 eventsFailed · 공시가 꺼진 서버의 요청 실패) */
export const EVENTS_FAILED_SCREEN = "일정을 받지 못했습니다. 화면을 다시 열면 다시 받습니다.";
export const TITLE_NOTE = "공시 제목은 SEC 서식과 항목 번호를 우리말로 옮긴 것이며, 내용 요약이 아닙니다.";
export const STALE_NEVER = "SEC 공시 확인이 아직 되지 않았습니다. 서버가 다시 확인하면 채워집니다.";
export const NEW_CHIP = "새 공시";
export const EXPAND_HINT = "누르면 자세히";
/** 펼친 줄의 힌트 */
export const COLLAPSE_HINT = "누르면 접기";
export const ITEMS_HEAD = "들어 있는 항목";
export const OPEN_ORIGINAL = "SEC 원문 보기 (영어)";
export const OPEN_ORIGINAL_SPEECH = "SEC 원문 보기, 영어, 브라우저로 열림";
export const OPEN_FAILED = "원문을 열지 못했습니다.";
export const KR_HEAD = "한국 공시";
/** 설정 '공시 알림' 줄의 DART 안내 (알림 설정이라 '알림은') */
export const KR_NO_KEY = "한국 공시 알림은 DART 키가 있어야 받을 수 있습니다.";
/** '일정·공시' 화면 한국 공시 칸 (목록 화면이라 '공시는' — 키가 없으면 종목 브리핑도 국내 공시를 받지 않는다) */
export const KR_SCREEN_NO_KEY = "한국 공시는 DART 키가 있어야 받을 수 있습니다.";
export const KR_NOT_YET = "한국 공시 알림은 다음 단계에서 넣습니다.";
/**
 * 한국 공시 칸 둘째 줄 — 계좌 상세 '오늘 일정' 카드의 '최근 공시 (보유 국내 종목, 3일)'이 이 화면에 없는 까닭을 밝힌다.
 * DART 키가 있는 서버(kr notYet)에서만 — 키가 없으면 종목 브리핑이 국내 공시를 받지 않아 그 카드도 늘 '없음'이다 (3-38 리뷰 3)
 */
export const KR_IN_ACCOUNT = "보유 국내 종목의 최근 공시(3일)는 계좌 브리핑 상세의 '오늘 일정' 카드에서 볼 수 있습니다.";
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
/** 이 기기 첫 확인에서도 알리는 새 공시: 접수 뒤 이 시간 안 (서버 5분 + 백그라운드 15분 + 여유) */
export const FIRST_CHECK_FRESH_MS = 30 * 60_000;
/** 대상 아님 줄에 보이는 이름 수 */
const NAMES_MAX = 5;
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;

export function filingsSub(days: number): string {
  return `보유 미국 종목 · 최근 ${days}일 · SEC`;
}
export function filingsNone(days: number): string {
  return `최근 ${days}일 안에 올라온 공시가 없습니다.`;
}
/** 알림으로 온 '새 공시' 화면(ALERTS_TITLE)의 공시 칸 — 서버 알림 목록 기간(/api/filings/alerts?days=3) */
export const ALERT_DAYS = 3;
/**
 * '새 공시' 화면 공시 칸의 없음 — 기준 잡기 줄(처음 확인할 때 이미 있던 공시)은 빠지므로 '새 공시'라고 밝힌다
 * (아래 줄은 '보유 미국 종목 · 최근 3일 · SEC' 그대로 — 화면 제목 '새 공시'가 밝히고, 폰 글자 200% 에서 '· SEC'가 홀로 줄을 시작하지 않게)
 */
export function alertsNone(days: number): string {
  return `최근 ${days}일 안에 새 공시가 없습니다.`;
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

/** 묶음 안의 공백을 줄바꿈 없는 공백으로 — 좁은 칸·큰 글씨에서 묶음째 다음 줄로 가게 (묶음 사이 줄바꿈은 부르는 쪽의 줄 모양이 맡는다) */
const keep = (t: string) => t.replace(/ /g, "\u00a0");

/**
 * SEC 가 새 공시를 받는 시간인지: 미국 동부 평일 06:00~22:59 (서버 services/filingAlerts inEdgarHours · cron 과 같은 창).
 * 기기 Intl 시간대 자료에 기대지 않고 미국 서머타임 규칙(nyOffsetByRule)으로 — 백그라운드 확인이 휴장 건너뛰기를 할지 정할 때 쓴다
 */
export function inEdgarHours(now: number): boolean {
  const et = new Date(now + nyOffsetByRule(now) * 60_000);
  const wd = et.getUTCDay();
  const h = et.getUTCHours();
  return wd >= 1 && wd <= 5 && h >= 6 && h <= 22;
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
  /**
   * 같은 줄을 묶음으로: ['SEC에 올라온 시각:', '한국 7/30(목) 05:04 ·', '미국 동부 7/29(수) 16:04'] — 묶음 안 공백은 줄바꿈 없는 공백,
   * '·'는 앞 묶음 끝에 (200% 에서 '한국 9/8(화)' / '20:25 · …'처럼 날짜와 시각이 갈라지거나 '·'로 줄이 시작하지 않게)
   */
  timeParts: string[];
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
    timeParts: (k && e ? ["SEC에 올라온 시각:", `한국 ${k.text} ·`, `미국 동부 ${e.text}`] : ["SEC 제출일:", `${mdw(i.filingDate)} (미국 날짜)`]).map(keep),
    timeSpeech: k && e ? sentence(["SEC에 올라온 시각", `한국 ${k.speech}`, `미국 동부 ${e.speech}`]) : sentence(["SEC 제출일", `${speakDay(i.filingDate)} 미국 날짜`]),
  };
}

/**
 * 순간(ISO) → 서울 { text: '9/29 08:40', speech: '9월 29일 8시 40분' }. 기준 줄 읽기는 다가오는 일정 카드(lib/holdingEvents stamp)와 같은 24시간 말투
 * ('16시 15분') — 같은 화면의 두 기준 줄이 다르게 읽히지 않게. 공시 줄의 접수 시각은 오전·오후(speakAmPm) 그대로
 */
function stamp(iso: string | null): { text: string; speech: string } | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const s = new Date(t + 9 * 3_600_000).toISOString();
  const md = `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  const hm = s.slice(11, 16);
  return { text: `${md} ${hm}`, speech: `${Number(s.slice(5, 7))}월 ${Number(s.slice(8, 10))}일 ${speakClock(hm)}` };
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
export function scheduleFilingsView(f: ScheduleFilings, viewed: ReadonlySet<string> = new Set(), days = FILING_DAYS, mode: "schedule" | "alerts" = "schedule"): FilingsView {
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
  const alerts = mode === "alerts";
  return {
    title: FILINGS_HEAD,
    sub: filingsSub(days),
    lines,
    more: all.length - lines.length + Math.max(0, f.more),
    // 미국 보유가 ETF·ETN 뿐이면 '없어'가 아니라 '확인하는 종목이 없습니다' (아래 대상 아님 글이 이유를 밝힌다). 알림 목록('새 공시' 화면)은 보유 여부를 모른다
    empty: all.length ? null : alerts ? alertsNone(days) : noUs ? (f.notCovered.length ? FILINGS_NONE_COVERED : FILINGS_NO_US) : filingsNone(days),
    notes,
    basis: [at ? `${at.text} 기준` : null, "출처 SEC EDGAR"].filter((x): x is string => x !== null).join(" · "),
    basisSpeech: sentence([at ? `${at.speech} 기준` : null, "출처 SEC EDGAR"]),
    fresh: all.filter((x) => x.isNew).length,
  };
}

/**
 * 계좌 상세 링크 줄 끝 '새 공시 2건' (0이면 null). 앞의 '·'는 링크 글 묶음 끝에 붙인다 ('일정·공시 모두 보기 ·' + '새 공시 2건 ›') —
 * 200% 에서 둘째 줄이 '·'로 시작하지 않게
 */
export function freshCount(n: number): string | null {
  return n > 0 ? `새 공시 ${n}건` : null;
}

/** '일정·공시' 요청이 실패했을 때 한 줄 (앱이 아는 서버 플래그로 — 공시가 꺼져 있으면 일정만, 일정이 꺼져 있으면 공시만, 모르면 둘 다) */
export function scheduleFailedText(eventsOn: boolean, filingsOn: boolean): string {
  if (eventsOn && !filingsOn) return EVENTS_FAILED_SCREEN;
  if (filingsOn && !eventsOn) return FILINGS_FAILED;
  return SCHEDULE_FAILED;
}

/** 받는 중 한 줄 (실패 글과 같은 규칙 — 공시가 꺼져 있으면 '일정을', 일정이 꺼져 있으면 '공시를', 모르면 둘 다) */
export function scheduleLoadingText(eventsOn: boolean, filingsOn: boolean): string {
  if (eventsOn && !filingsOn) return EVENTS_LOADING;
  if (filingsOn && !eventsOn) return FILINGS_LOADING;
  return SCHEDULE_LOADING;
}

/** 화면 제목: '일정·공시' 화면이 꺼져 있고 공시 알림만 켜져 있으면(알림으로 옴) '새 공시' */
export function scheduleScreenTitle(scheduleOn: boolean, filingsOn: boolean): string {
  return !scheduleOn && filingsOn ? ALERTS_TITLE : SCHEDULE_TITLE;
}

/** 계좌 상세 '다가오는 일정'의 받지 못함 글 끝 (저장본이라 다음 브리핑 때) */
export const AGAIN_BRIEFING = "다음 브리핑 때 다시 받습니다";
/** 이 화면은 열 때 받는다 — 서버는 받지 못한 결과를 캐시하지 않고, 앱은 곧바로 다시 묻는다 (lib/scheduleQuery scheduleStaleMs) */
export const AGAIN_SCREEN = "화면을 다시 열면 다시 받습니다";

/** '다가오는 일정'의 받지 못함 글을 이 화면에 맞게 (AGAIN_BRIEFING → AGAIN_SCREEN) */
export function screenRetryView(v: EventsView): EventsView {
  const fix = (t: string) => t.split(AGAIN_BRIEFING).join(AGAIN_SCREEN);
  return { ...v, empty: v.empty === null ? null : fix(v.empty), notes: v.notes.map(fix), headSpeech: fix(v.headSpeech) };
}

/**
 * '미국 실적은 발표된 뒤 공시(8-K 2.02)로 보입니다.'를 붙일지: 이 화면에 공시 칸이 있고 그 칸이 확인하는 미국 종목이 있을 때만
 * (미국 보유가 ETF·ETN 뿐이면 공시 칸이 '확인하는 종목이 없습니다'라 붙이지 않는다 — 3-38 리뷰 3)
 */
export function filingsCoverUs(f: ScheduleFilings | null | undefined): boolean {
  return !!f && (f.watched > 0 || f.failed.length > 0 || f.pending.length > 0);
}

/** 서버 알림 목록(/api/filings/alerts)을 공시 칸 모양으로 — '새 공시' 화면(ALERTS_TITLE)이 쓴다. 펼친 항목 풀이는 알림 목록에 없어 비운다 */
export function alertsAsFilings(items: readonly FilingAlertItem[]): ScheduleFilings {
  return {
    items: items.map((i) => ({ ...i, detail: [], note: null, isNew: false })),
    more: 0,
    watched: 0,
    notCovered: [],
    failed: [],
    pending: [],
    lastOkAt: null,
    warning: null,
  };
}

/** 받은 '일정·공시'에 받지 못한 칸·종목이 있는지 (있으면 화면을 다시 열 때 곧바로 다시 묻는다) */
export function scheduleHasFailure(s: HoldingSchedule | undefined): boolean {
  if (!s) return false;
  return !!s.eventsFailed || !!s.filingsFailed || !!(s.events && (s.events.failed.length > 0 || s.events.earningsFailed));
}

/** 받아 둔 위젯 응답의 종목(c 코드 · qty 수량)에 보유(수량 > 0) 미국 종목이 있는지 — 없으면 공시 알림이 올 일이 없다 */
export function holdsUs(stocks: readonly { c: string; qty: number | null }[] | null | undefined): boolean {
  return !!stocks?.some((s) => !isKrCode(s.c) && (s.qty ?? 0) > 0);
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
    // 접수 시각을 모르면 SEC 제출일(미국 날짜)이라고 밝힌다 (화면 펼침 글과 같게)
    return { title: `${i.name} 새 공시`, body: i.kst ? `${i.title} · SEC에 ${filingLine(i).when} 올라옴` : `${i.title} · SEC 제출일 ${mdw(i.filingDate)} (미국 날짜)`, data };
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
 * 종목별 알림에서 끈 종목인지: 그 회사(CIK)의 보유 코드(서버 codes — GOOGL·GOOG)를 모두 껐을 때만 조용히.
 * 하나라도 켜져 있으면 그 종목의 공시이기도 하므로 알린다. 예전 서버(codes 없음)는 대표 코드 하나로
 */
function mutedAll(i: FilingAlertItem, muted: ReadonlySet<string>): boolean {
  const codes = i.codes?.length ? i.codes : [i.code];
  return codes.every((c) => muted.has(c));
}

/**
 * 알림 규칙 (설계 6.2, 표 테스트):
 *  1. 기준을 아직 안 잡음(이 기기 첫 확인) → 접수 30분이 지난 것은 '본 것'(켜자마자 며칠 치가 쏟아지지 않게), 30분 안의 것은 아래 규칙대로 —
 *     첫 확인이 곧 첫 새 공시일 때(기능을 켠 뒤 앱을 열지 않은 기기) 그 공시가 사라지지 않게
 *  2. 이미 본 접수 번호 → 건너뜀
 *  3. 접수 시각(없으면 서버가 처음 본 시각)이 24시간보다 오래됨 → 조용히 '본 것'
 *  4. 이 기기 '공시 알림' 끔 · 종목별 알림에서 끈 종목(같은 회사를 두 코드로 가지면 둘 다 껐을 때) → 조용히 '본 것' (다시 켰을 때 밀린 것이 쏟아지지 않게)
 *  5. 조용한 시간이면 → 아무것도 적지 않고 미룸 (끝난 뒤 첫 확인에서 3번 규칙 안의 것만 한 번에)
 *  6. 남은 것 → 알림 1건, 모두 '본 것'
 */
export function planFilingNotification(input: FilingPlanInput): FilingPlan {
  const now = input.now.getTime();
  const refOf = (i: FilingAlertItem) => Date.parse(i.acceptedAt ?? i.firstSeenAt);
  const unseen = input.items.filter((i, idx, arr) => !input.seen.has(i.accession) && arr.findIndex((x) => x.accession === i.accession) === idx);
  const baseline = input.init ? [] : unseen.filter((i) => !(now - refOf(i) <= FIRST_CHECK_FRESH_MS));
  const fresh = input.init ? unseen : unseen.filter((i) => !baseline.includes(i));
  const init = !input.init;
  const base = baseline.map((i) => i.accession);
  const none: FilingPlan = { message: null, markSeen: base, notified: [], init, deferred: false };
  if (!fresh.length) return none;
  const muted = new Set(input.prefs.mutedCodes);
  const quiet: string[] = [];
  const send: FilingAlertItem[] = [];
  for (const i of fresh) {
    const ref = refOf(i);
    if (Number.isNaN(ref) || now - ref > ALERT_MAX_AGE_MS || !input.enabled || mutedAll(i, muted)) quiet.push(i.accession);
    else send.push(i);
  }
  if (send.length && inQuietHours(input.prefs, input.now)) return { ...none, markSeen: [...base, ...quiet], deferred: true };
  return { message: filingMessage(send), markSeen: [...base, ...quiet, ...send.map((i) => i.accession)], notified: send, init, deferred: false };
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

/**
 * '마지막 공시 알림 7/30(목) 07:03 · SEC에 올라온 뒤 1시간 59분' (기록이 없으면 null).
 * 여러 건을 묶어 알리면 기록이 같은 알린 시각으로 최신 공시부터 붙는다 — 마지막 묶음에서 가장 늦게 올라온(가장 최신) 공시로 잰다
 * (묶음의 가장 오래된 공시로 재면 '20분 안' 기준을 확인할 때 늦은 시간이 부풀려 보였다 — 3-38 리뷰 3)
 */
export function lastAlertLine(log: readonly FilingLogEntry[]): string | null {
  const tail = log[log.length - 1];
  if (!tail) return null;
  const accOf = (e: FilingLogEntry) => (e.acceptedAt ? Date.parse(e.acceptedAt) : NaN);
  const last = log
    .filter((e) => e.notifiedAt === tail.notifiedAt)
    .reduce((best, e) => (Number.isNaN(accOf(best)) || accOf(e) > accOf(best) ? e : best), tail);
  const t = Date.parse(last.notifiedAt);
  if (Number.isNaN(t)) return null;
  const k = new Date(t + 9 * 3_600_000).toISOString();
  const when = `${mdw(k.slice(0, 10))} ${k.slice(11, 16)}`;
  const acc = last.acceptedAt ? Date.parse(last.acceptedAt) : NaN;
  return `마지막 공시 알림 ${when}${Number.isNaN(acc) || t < acc ? "" : ` · SEC에 올라온 뒤 ${span(t - acc)}`}`;
}
