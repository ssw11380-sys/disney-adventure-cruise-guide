import { nyWall } from "./accountNumbers.js";
import { isKrTradingDate, KR_HOLIDAYS, krRegularHours, KR_SPECIAL_HOURS, US_EARLY_CLOSES, US_HOLIDAY_NAMES, US_HOLIDAYS } from "./marketContext.js";

/**
 * 시장 요약의 '일정' 줄에 쓰는 큰 일정 (정적 목록, 모델·수집 없음). 앱에는 목록을 두지 않고 서버 응답만 쓴다.
 * 공식 출처 4가지를 사람이 확인해 넣는다 — BLS 는 서버 요청을 403 으로 막아 자동으로 받지 않는다(우회하지 않음).
 *  - fomc: 미 연준 금리 결정. 결정문은 마지막 날 14:00 ET (연준 관행 — 페이지에 시각은 없다). 날짜는 직전 회의에서 확정되기 전까지 잠정
 *  - cpi·jobs: 미 노동통계국 소비자물가·고용보고서, 08:30 ET. 정부 사정으로 미뤄질 수 있어 '예정'
 *  - bok: 한국은행 통화정책방향 결정회의. 발표 시각은 분 단위 공지가 없어 '오전'
 * 장 운영(한국 휴장·다음 개장·미국 휴장·조기 폐장·수능일 지연 개장)은 marketContext 의 목록에서 만든다.
 * 해마다 새로 넣기 (docs/진행상황.md '해마다 할 일'): 11월 한은 다음 해 · 12월 BLS 다음 해·KRX 휴장일 · 여름 연준 그다음 해 · 회의마다 연준 잠정 날짜 확인.
 * 목록 마지막 날짜를 넘은 종류는 '모름'으로 보고 일정 줄을 만들지 않는다 (틀린 일정보다 없는 일정이 낫다) — /health eventsCoverage 로 보인다
 */

export type OfficialKind = "fomc" | "cpi" | "jobs" | "bok";
export type EventKind = OfficialKind | "kr-holiday" | "kr-open" | "us-holiday" | "us-early" | "kr-special";

export interface MarketEventDef {
  kind: OfficialKind;
  /** 그 기관 현지 날짜 */
  localDate: string;
  /** 현지 시각 HH:MM, 또는 분 단위 공지가 없으면 '오전' */
  localTime: string | "오전";
  tz: "America/New_York" | "Asia/Seoul";
  /** 몇 월분 (CPI·고용) */
  ref: string | null;
  /** 경제전망(SEP) 발표 포함 (FOMC) */
  sep?: boolean;
}

export const EVENT_SOURCES: Record<OfficialKind, string> = {
  fomc: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  cpi: "https://www.bls.gov/schedule/news_release/cpi.htm",
  jobs: "https://www.bls.gov/schedule/news_release/empsit.htm",
  bok: "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755",
};

const fomc = (localDate: string, sep = false): MarketEventDef => ({ kind: "fomc", localDate, localTime: "14:00", tz: "America/New_York", ref: null, ...(sep ? { sep } : {}) });
const bls = (kind: "cpi" | "jobs", localDate: string, ref: string): MarketEventDef => ({ kind, localDate, localTime: "08:30", tz: "America/New_York", ref });
const bok = (localDate: string): MarketEventDef => ({ kind: "bok", localDate, localTime: "오전", tz: "Asia/Seoul", ref: null });

/** 2026-09-26 기준 공식 페이지에서 옮긴 목록 (연준 2027 은 게시됨, BLS·한은 2027 은 아직 발표 전이라 없음) */
export const MARKET_EVENTS: readonly MarketEventDef[] = [
  // 연준 FOMC (결정 = 회의 마지막 날). *는 경제전망 포함
  fomc("2026-10-28"),
  fomc("2026-12-09", true),
  fomc("2027-01-27"),
  fomc("2027-03-17", true),
  fomc("2027-04-28"),
  fomc("2027-06-09", true),
  fomc("2027-07-28"),
  fomc("2027-09-15", true),
  fomc("2027-10-27"),
  fomc("2027-12-08", true),
  fomc("2028-01-26"),
  // 미국 소비자물가 (몇 월분)
  bls("cpi", "2026-10-14", "9월"),
  bls("cpi", "2026-11-10", "10월"),
  bls("cpi", "2026-12-10", "11월"),
  // 미국 고용보고서
  bls("jobs", "2026-10-02", "9월"),
  bls("jobs", "2026-11-06", "10월"),
  bls("jobs", "2026-12-04", "11월"),
  // 한국은행 기준금리 결정 (2026)
  bok("2026-01-15"),
  bok("2026-02-26"),
  bok("2026-04-10"),
  bok("2026-05-28"),
  bok("2026-07-16"),
  bok("2026-08-27"),
  bok("2026-10-22"),
  bok("2026-11-26"),
];

/** 저장·응답에 쓰는 일정 한 건 (문구는 볼 때 '오늘'/날짜로 그린다 — marketSummaryCalc eventText) */
export interface SummaryEvent {
  kind: EventKind;
  /** 한국 날짜 (이 날짜로 '오늘' 또는 'M/D(요)' 를 붙인다) */
  date: string;
  /** 연휴 범위의 끝 날짜 (한국 휴장 여러 날) */
  endDate?: string;
  /** 한국 시각 HH:MM, '오전', 없으면 null (하루 종일) */
  time: string | null;
  /** 날짜·시각 뒤에 붙는 말 (예: '미국 9월 소비자물가(CPI) 발표', '한국 휴장(한글날)') */
  text: string;
  /** 정렬·24시간 창에 쓰는 순간 (ISO) */
  at: string;
  /** 발표가 미뤄질 수 있는 일정 (BLS) 또는 잠정 날짜 (연준) */
  tentative?: boolean;
  source?: string;
}

const KST = 9 * 3_600_000;
const pad = (n: number) => String(n).padStart(2, "0");
const kstDate = (t: number) => new Date(t + KST).toISOString().slice(0, 10);
const kstHm = (t: number) => new Date(t + KST).toISOString().slice(11, 16);
/** 서울 날짜·시각 → 순간 */
export const kstWall = (date: string, h: number, m: number) => Date.parse(`${date}T${pad(h)}:${pad(m)}:00+09:00`);
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isWeekend = (date: string) => {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
};

/** 공식 일정의 순간. '오전'은 정렬·창 계산용으로 10:00 (한국 시간) 으로 본다 */
export function eventInstant(e: MarketEventDef): number {
  if (e.localTime === "오전") return kstWall(e.localDate, 10, 0);
  const [h, m] = e.localTime.split(":").map(Number) as [number, number];
  return e.tz === "America/New_York" ? nyWall(e.localDate, h, m) : kstWall(e.localDate, h, m);
}

/** 종류별 목록의 마지막 날짜 (/health eventsCoverage) */
export function eventsCoverage(list: readonly MarketEventDef[] = MARKET_EVENTS): Record<OfficialKind, string | null> {
  const out: Record<OfficialKind, string | null> = { fomc: null, cpi: null, jobs: null, bok: null };
  for (const e of list) if (!out[e.kind] || e.localDate > out[e.kind]!) out[e.kind] = e.localDate;
  return out;
}

/** 오늘(한국 날짜)이 목록 마지막 날짜를 넘은 종류 — 그 종류는 '모름'으로 보고 일정 줄에 넣지 않는다 */
export function unknownKinds(today: string, list: readonly MarketEventDef[] = MARKET_EVENTS): OfficialKind[] {
  const cov = eventsCoverage(list);
  return (Object.keys(cov) as OfficialKind[]).filter((k) => !cov[k] || today > cov[k]!);
}

function officialText(e: MarketEventDef): string {
  switch (e.kind) {
    case "fomc":
      return "미국 금리 결정(FOMC) 발표";
    case "cpi":
      return `미국 ${e.ref ?? ""} 소비자물가(CPI) 발표`.replace(/\s+/g, " ");
    case "jobs":
      return `미국 ${e.ref ?? ""} 고용보고서 발표`.replace(/\s+/g, " ");
    case "bok":
      return "한국은행 기준금리 결정";
  }
}

function official(e: MarketEventDef): SummaryEvent {
  const t = eventInstant(e);
  return {
    kind: e.kind,
    date: e.localTime === "오전" ? e.localDate : kstDate(t),
    time: e.localTime === "오전" ? "오전" : kstHm(t),
    text: officialText(e),
    at: new Date(t).toISOString(),
    ...(e.kind !== "bok" ? { tentative: true } : {}),
    source: EVENT_SOURCES[e.kind],
  };
}

/** 한국 휴장 이름의 바탕 ('추석 연휴'·'설날 대체공휴일' → '추석'·'설날') */
function holidayBase(name: string): string {
  return name.replace(/\s*(연휴|대체공휴일)$/, "").trim() || name;
}

/** 여러 날 휴장의 이름: 바탕 이름이 같으면 하나('추석'), 다르면 '·'로 ('연말·신정' — 12/31 연말 휴장과 1/1 신정이 이어질 때) */
function rangeName(dates: readonly string[]): string {
  return [...new Set(dates.map((d) => holidayBase(KR_HOLIDAYS[d] ?? "")).filter((x) => x))].join("·") || "휴장";
}

/** 한국 개장 시각 'HH:MM' (새해 첫 거래일·수능일 10:00 등 특수일) */
const openHm = (date: string) => {
  const h = krRegularHours(date);
  return `${pad(Math.floor(h.open / 60))}:${pad(h.open % 60)}`;
};

/** 다음 한국 거래일 (주말·KR_HOLIDAYS 건너뜀) */
export function nextKrTradingDate(date: string): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 30 && !isKrTradingDate(d); i++) d = addDays(d, 1);
  return d;
}

/**
 * 네이버 장 상태가 알려 준 한국 다음 거래일 (그날 받은 값). 목록에 없는 임시공휴일이 끼어도 다음 개장 날짜가 맞게 이 값을 먼저 쓴다 —
 * today 는 네이버 값의 오늘 날짜(today.date), next 는 next.tradeBaseAt
 */
export interface KrNextOpen {
  today: string;
  next: string;
}

/** 쓸 수 있는 네이버 다음 거래일인지: 날짜 꼴이고, 기준 날짜(today)보다 뒤이고, 주말이 아니다 */
function validNext(n: KrNextOpen | null | undefined, today: string): string | null {
  if (!n || n.today !== today || !/^\d{4}-\d{2}-\d{2}$/.test(n.next) || n.next <= today || isWeekend(n.next)) return null;
  return n.next;
}

/** 직전 한국 거래일 */
export function prevKrTradingDate(date: string): string {
  let d = addDays(date, -1);
  for (let i = 0; i < 30 && !isKrTradingDate(d); i++) d = addDays(d, -1);
  return d;
}

/**
 * 장 운영 일정: 한국 휴장(연속이면 'M/D~M/D 추석 연휴 한국 휴장' 한 건 + 다음 개장), 미국 휴장·조기 폐장, 한국 특수일(수능일 지연 개장).
 * 한국 휴장은 그날 09:00, 미국은 그날 09:30 ET(조기 폐장은 13:00 ET) 를 순간으로 본다.
 *  - 이어진 휴장은 창 안에 드는 첫 휴장일부터 본다 — 연휴 둘째 날 아침(9/25 08:30, 2027-01-01 08:30)에도 '오늘 한국 휴장(추석)'·'오늘 한국 휴장(신정)'.
 *    남은 날이 하루면 한 날 휴장 줄, 여러 날이면 범위 줄 + 다음 개장
 *  - 이어진 휴장의 바탕 이름이 다르면 '·'로 잇는다 ('12/31~1/1 연말·신정 연휴 한국 휴장')
 *  - 다음 개장: 네이버 다음 거래일(krNext)이 그 연휴 뒤면 그 날(목록에 없는 임시공휴일이 끼어도 맞게), 아니면 목록으로 센 날.
 *    그날이 특수일(새해 첫 거래일·수능일)이면 개장 시각을 붙인다 ('다음 개장 1/4(월) 10:00')
 */
function operations(from: number, to: number, krNext?: KrNextOpen | null): SummaryEvent[] {
  const out: SummaryEvent[] = [];
  const startDate = kstDate(from - 86_400_000);
  const endDate = kstDate(to + 86_400_000);
  // 한국 휴장: 날짜 순으로 보면서 사이에 주말만 있는 휴장은 한 범위로
  const kr = Object.keys(KR_HOLIDAYS).filter((d) => d >= startDate && d <= endDate).sort();
  for (let i = 0; i < kr.length; i++) {
    const start = i;
    while (i + 1 < kr.length) {
      let gap = addDays(kr[i]!, 1);
      while (isWeekend(gap)) gap = addDays(gap, 1);
      if (gap !== kr[i + 1]) break;
      i++;
    }
    // 창(from~to) 안에 드는 첫 휴장일부터 연휴 끝까지
    const range = kr.slice(start, i + 1);
    const k = range.findIndex((d) => kstWall(d, 9, 0) >= from && kstWall(d, 9, 0) < to);
    if (k < 0) continue;
    const rest = range.slice(k);
    const first = rest[0]!;
    const last = rest[rest.length - 1]!;
    const at = kstWall(first, 9, 0);
    if (rest.length === 1) {
      out.push({ kind: "kr-holiday", date: first, time: null, text: `한국 휴장(${KR_HOLIDAYS[first]!})`, at: new Date(at).toISOString() });
    } else {
      out.push({ kind: "kr-holiday", date: first, endDate: last, time: null, text: `${rangeName(rest)} 연휴 한국 휴장`, at: new Date(at).toISOString() });
      // 긴 연휴는 다음 개장을 함께 적는다 (같은 줄 두 번째 칸). 네이버 값은 연휴 첫날 전이나 연휴 안(오늘이 휴장일)에 받은 것
      const naver = krNext && krNext.today <= first ? validNext(krNext, krNext.today) : null;
      const open = naver && naver > last ? naver : nextKrTradingDate(last);
      out.push({ kind: "kr-open", date: open, time: krRegularHours(open).reason ? openHm(open) : null, text: "다음 개장", at: new Date(at + 1).toISOString() });
    }
  }
  // 한국 특수일 (수능일 10:00 개장 등)
  for (const [date, h] of Object.entries(KR_SPECIAL_HOURS)) {
    const at = kstWall(date, Math.floor(h.open / 60), h.open % 60);
    if (at < from || at >= to) continue;
    const hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    out.push({ kind: "kr-special", date, time: null, text: `한국 ${h.reason} ${hm(h.open)} 개장, ${hm(h.close)} 마감`, at: new Date(at).toISOString() });
  }
  // 미국 휴장·조기 폐장 (그날 뉴욕 정규장이 열렸을 시각의 한국 날짜로)
  for (const date of US_HOLIDAYS) {
    const at = nyWall(date, 9, 30);
    if (at < from || at >= to) continue;
    out.push({ kind: "us-holiday", date: kstDate(at), time: null, text: `미국 휴장(${US_HOLIDAY_NAMES[date] ?? "휴장일"})`, at: new Date(at).toISOString() });
  }
  for (const date of US_EARLY_CLOSES) {
    const at = nyWall(date, 13, 0);
    if (at < from || at >= to) continue;
    out.push({ kind: "us-early", date: kstDate(at), time: kstHm(at), text: "미국 조기 폐장(뉴욕 13:00)", at: new Date(at).toISOString() });
  }
  return out;
}

/**
 * 요약 시각(now)부터 hours 안의 일정 (가까운 순). 목록 마지막 날짜를 넘은 공식 종류는 넣지 않는다.
 * next = 그 창 뒤의 첫 공식 일정 (상세 화면 '다음:' 줄)
 */
export function upcomingEvents(
  now: Date,
  opts: { hours?: number; list?: readonly MarketEventDef[]; krNext?: KrNextOpen | null } = {},
): { within: SummaryEvent[]; next: SummaryEvent | null; unknown: OfficialKind[] } {
  const from = now.getTime();
  const to = from + (opts.hours ?? 24) * 3_600_000;
  const list = opts.list ?? MARKET_EVENTS;
  const unknown = unknownKinds(kstDate(from), list);
  const known = list.filter((e) => !unknown.includes(e.kind));
  const within = [...known.filter((e) => eventInstant(e) >= from && eventInstant(e) < to).map(official), ...operations(from, to, opts.krNext)].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const later = known
    .filter((e) => eventInstant(e) >= to)
    .sort((a, b) => eventInstant(a) - eventInstant(b))[0];
  return { within, next: later ? official(later) : null, unknown };
}

/**
 * 오늘(한국 휴장일)의 다음 개장 한 건 — 시각까지 (특수일이면 그 개장 시각).
 * 네이버 장 상태의 다음 거래일(next.tradeBaseAt, 오늘 받은 값)이 있으면 그 날, 없으면 휴장일 목록으로 센 날 (목록에 없는 임시공휴일이 끼어도 맞게)
 */
export function nextOpenEvent(today: string, krNext?: KrNextOpen | null): SummaryEvent {
  const open = validNext(krNext, today) ?? nextKrTradingDate(today);
  const h = krRegularHours(open);
  const at = kstWall(open, Math.floor(h.open / 60), h.open % 60);
  return { kind: "kr-open", date: open, time: openHm(open), text: "다음 개장", at: new Date(at).toISOString() };
}
