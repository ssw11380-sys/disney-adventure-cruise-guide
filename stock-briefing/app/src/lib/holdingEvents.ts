import type { AccountBriefing, AccountEventItem, AccountEvents } from "@/api/types";
import { sentence, speakAmount, speakClock } from "@/lib/a11y";
import { speakDay } from "@/lib/accountSinceLast";
import { formatWon } from "@/lib/format";
import { mdw } from "@/lib/marketSummary";

/**
 * 브리핑 3차 5 — 다가오는 일정 (플래그 holdingEvents) 화면용 순수 함수 (React Native 를 불러오지 않음 → 테스트).
 * 일정은 서버가 계좌 브리핑을 만들 때 받아 저장한 그대로 쓴다 (services/holdingEvents — 토스증권 배당 요약·캘린더, 네이버 배당락일).
 * 사실만: 날짜·종목·일정 이름과 발표된 주당 금액, 기준 시각·출처. 실적 발표일은 '(예정)'. 판단·권유하는 말 없음
 */

/** 카드에 보이는 일정 줄 수 (넘으면 '외 N건') */
export const EVENTS_LINES_MAX = 8;
/** 이번 주 한 줄에 이름을 보이는 일정 수 (넘으면 '외 N건') */
export const WEEK_ITEMS_MAX = 2;
export const EVENTS_HEAD = "다가오는 일정";
/** 배당락일의 뜻 (배당락일 줄이 있을 때) */
export const EX_DIVIDEND_NOTE = "배당락일: 이날부터 산 주식에는 이번 배당이 붙지 않습니다.";
/** 실적 발표일을 넣었을 때 (플래그 holdingEarnings — 그때 기준) */
export const EARNINGS_NOTE = "실적 발표일은 토스증권 캘린더에 오른 큰 종목만 보이고, 회사 사정으로 날짜가 바뀌기도 합니다.";
/** 국내 종목이 있을 때 (앞날 배당락일이 거의 없는 이유) */
export const KR_DIVIDEND_NOTE = "국내 종목 배당은 보통 기준일 뒤에 정해져 미리 보이지 않습니다.";
/** 모두 받지 못함 — 계좌 브리핑마다 다시 받으므로 사실 */
export const EVENTS_FAILED = "일정을 받지 못했습니다. 다음 브리핑 때 다시 받습니다.";
export const EARNINGS_FAILED = "실적 발표일을 받지 못했습니다. 다음 브리핑 때 다시 받습니다.";
export const WEEK_HEAD = "이번 주 일정";

/** 카드 제목 '다가오는 일정 (보유 종목 · 30일 안)' */
export function eventsTitle(days: number): string {
  return `${EVENTS_HEAD} (보유 종목 · ${days}일 안)`;
}

/** 일정이 없을 때 한 줄 */
export function eventsNone(e: Pick<AccountEvents, "days" | "earnings" | "earningsFailed">): string {
  return e.earnings && !e.earningsFailed ? `${e.days}일 안에 알려진 배당락일·실적 발표일이 없습니다.` : `${e.days}일 안에 알려진 배당락일이 없습니다.`;
}

/** 배당 일정을 받지 못한 종목 (일부만) */
export function failedNote(names: string[]): string {
  return `배당 일정을 받지 못한 종목: ${names.join(", ")} (다음 브리핑 때 다시 받습니다)`;
}

/** 토스증권·네이버 배당락일이 달라 뺀 종목 */
export function conflictNote(names: string[]): string {
  return `토스증권과 네이버의 배당락일이 달라 뺀 종목: ${names.join(", ")}`;
}

/** 주당 금액 '$0.2715' · '$0.98' · '370원' */
export function amountText(i: Pick<AccountEventItem, "amount" | "currency">): string | null {
  if (i.amount === undefined || !Number.isFinite(i.amount) || i.amount <= 0) return null;
  return i.currency === "USD" ? `$${i.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : i.currency === "KRW" ? formatWon(i.amount) : null;
}

/** 일정 이름 '리얼티인컴 배당락일 (미국 날짜)' · '마이크로소프트 실적 발표 (예정)' */
function whatText(i: AccountEventItem): string {
  return i.kind === "exDividend" ? `${i.name} 배당락일${i.usDate ? " (미국 날짜)" : ""}` : `${i.name} 실적 발표 (예정)`;
}

export interface EventLine {
  key: string;
  /** '9/30(수)' · '10/29(목) 오전 5시 이후' */
  when: string;
  /** ['9/30(수)', '리얼티인컴 배당락일 (미국 날짜)', '주당 $0.2715'] — 화면은 ' · ' 로 잇고 좁으면 묶음째 줄바꿈 */
  parts: string[];
  /** 보이는 한 줄 전체 */
  text: string;
  /** 화면 읽기 한 문장 */
  speech: string;
}

/** 일정 한 줄: '9/30(수) · 리얼티인컴 배당락일 (미국 날짜) · 주당 $0.2715' · '10/29(목) 오전 5시 이후 · 마이크로소프트 실적 발표 (예정)' */
export function eventLine(i: AccountEventItem): EventLine {
  // 시각 글은 토스가 준 것('오전 5시 이후') — 없으면 한국 시각 'HH:MM'
  const time = i.kind === "earnings" ? (i.timeText ?? i.kstTime ?? null) : null;
  const when = time ? `${mdw(i.date)} ${time}` : mdw(i.date);
  const amount = i.kind === "exDividend" ? amountText(i) : null;
  const parts = [when, whatText(i), amount ? `주당 ${amount}` : null].filter((x): x is string => x !== null);
  const spokenTime = time ? (i.timeText ?? speakClock(time)) : null;
  return {
    key: `${i.kind}-${i.code}-${i.date}`,
    when,
    parts,
    text: parts.join(" · "),
    speech: sentence([
      `${speakDay(i.date)}${i.kind === "exDividend" && i.usDate ? " 미국 날짜" : ""}${spokenTime ? ` ${spokenTime}` : ""}`,
      i.kind === "exDividend" ? `${i.name} 배당락일` : `${i.name} 실적 발표 예정`,
      amount ? `주당 ${speakAmount(amount)}` : null,
    ]),
  };
}

/** 순간(ISO) → 서울 '9/28 08:38' (읽지 못하면 null) */
function stamp(iso: string): { text: string; speech: string } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = new Date(t + 9 * 3_600_000).toISOString();
  const date = s.slice(0, 10);
  const hm = s.slice(11, 16);
  return { text: `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} ${hm}`, speech: `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일 ${speakClock(hm)}` };
}

export interface EventsView {
  title: string;
  /** 보이는 줄 (EVENTS_LINES_MAX 까지) */
  lines: EventLine[];
  /** 넘친 줄 수 ('외 N건') */
  more: number;
  /** 줄이 없을 때 한 줄 (없음 · 받지 못함). 줄이 있으면 null */
  empty: string | null;
  /** 줄 아래 작은 글 (뜻 · 받지 못한 것 · 두 출처가 다름 · 국내 배당) */
  notes: string[];
  /** '9/28 08:38 기준 · 출처 토스증권·네이버' */
  basis: string;
  /** 화면 읽기: 제목 묶음 한 문장 (제목 · 없음이면 그 글) */
  headSpeech: string;
  /** 화면 읽기: 기준 줄 */
  basisSpeech: string;
}

/**
 * 계좌 상세 '다가오는 일정' 카드에 그릴 글과 읽는 말 (설계 '브리핑 3차 5'):
 *  - 줄: 날짜 순 EVENTS_LINES_MAX 개까지, 넘으면 '외 N건'
 *  - 없음: '30일 안에 알려진 배당락일·실적 발표일이 없습니다.'(실적 켬) · '… 배당락일이 없습니다.'(끔).
 *    배당 일정을 모두 받지 못했으면(실적도 끔이거나 받지 못함) '일정을 받지 못했습니다. 다음 브리핑 때 다시 받습니다.'
 *  - 작은 글: 배당락일 뜻(배당락일 줄이 있을 때) · 실적 발표일 안내(실적을 넣었을 때) 또는 '실적 발표일을 받지 못했습니다 …' ·
 *    일부 종목을 받지 못함 · 두 출처가 달라 뺀 종목 · 국내 종목 배당(국내 종목이 있을 때)
 *  - 기준: '9/28 08:38 기준 · 출처 토스증권·네이버' (줄의 출처 — 줄이 없으면 토스증권)
 */
export function eventsView(e: AccountEvents): EventsView {
  const all = e.items.map(eventLine);
  const lines = all.slice(0, EVENTS_LINES_MAX);
  const holdings = e.kr + e.us;
  const allFailed = holdings > 0 && e.failed.length >= holdings && (!e.earnings || e.earningsFailed);
  const empty = all.length ? null : allFailed ? EVENTS_FAILED : eventsNone(e);
  const partFailed = !allFailed && e.failed.length > 0;
  const notes = [
    e.items.some((i) => i.kind === "exDividend") ? EX_DIVIDEND_NOTE : null,
    e.earnings ? (e.earningsFailed ? (allFailed ? null : EARNINGS_FAILED) : EARNINGS_NOTE) : null,
    partFailed ? failedNote(e.failed.map((f) => f.name)) : null,
    e.conflicts.length ? conflictNote(e.conflicts.map((c) => c.name)) : null,
    e.kr > 0 ? KR_DIVIDEND_NOTE : null,
  ].filter((x): x is string => x !== null);
  const sources = new Set<string>();
  for (const i of e.items) {
    if (i.source !== "naver") sources.add("토스증권");
    if (i.source !== "toss") sources.add("네이버");
  }
  const src = sources.size ? ["토스증권", "네이버"].filter((s) => sources.has(s)) : ["토스증권"];
  const at = stamp(e.asOf);
  const title = eventsTitle(e.days);
  return {
    title,
    lines,
    more: all.length - lines.length,
    empty,
    notes,
    basis: [at ? `${at.text} 기준` : null, `출처 ${src.join("·")}`].filter((x): x is string => x !== null).join(" · "),
    headSpeech: sentence([`${EVENTS_HEAD}, 보유 종목 ${e.days}일 안`, all.length ? `${all.length}건` : empty]),
    basisSpeech: sentence([at ? `${at.speech} 기준` : null, `출처 ${src.join(" ")}`]),
  };
}

export interface WeekLine {
  /** ['이번 주 일정', '마이크로소프트 실적 10/29(목)', '메타 실적 10/29(목) 외 1건'] — 화면은 ' · ' 로 잇고 좁으면 묶음째 줄바꿈 */
  parts: string[];
  text: string;
  /** 화면 읽기 조각 '이번 주 보유 종목 일정, 마이크로소프트 실적 10월 29일 목요일, …, 외 1건' */
  speech: string;
}

/**
 * 브리핑 탭 계좌 카드·줄의 '이번 주 일정 · 마이크로소프트 실적 10/29(목) · 메타 실적 10/29(목) 외 1건' 한 줄
 * (headline.week — 그 주 첫 오전 계좌 브리핑이고 이번 주 일정이 있을 때만 서버가 싣는다). 실패한 브리핑·칸이 없으면 null
 */
export function weekLine(b: Pick<AccountBriefing, "status" | "headline">): WeekLine | null {
  const w = b.status === "ok" ? b.headline?.week : undefined;
  if (!w?.length) return null;
  const shown = w.slice(0, WEEK_ITEMS_MAX);
  const more = w.length - shown.length;
  const label = (x: (typeof w)[number]) => `${x.name} ${x.kind === "exDividend" ? "배당락일" : "실적"}`;
  const parts = [WEEK_HEAD, ...shown.map((x, i) => `${label(x)} ${mdw(x.date)}${more > 0 && i === shown.length - 1 ? ` 외 ${more}건` : ""}`)];
  return {
    parts,
    text: parts.join(" · "),
    speech: sentence(["이번 주 보유 종목 일정", ...shown.map((x) => `${label(x)} ${speakDay(x.date)}`), more > 0 ? `외 ${more}건` : null]),
  };
}
