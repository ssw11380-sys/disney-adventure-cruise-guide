import type { AccountBriefing, AccountData } from "@/api/types";
import { sentence, speakAmount, speakClock, speakProfit, speakRate } from "@/lib/a11y";
import { sinceLine } from "@/lib/accountSinceLast";
import { weekLine } from "@/lib/holdingEvents";
import { KR_PREVIOUS_DAY_LINE, krPreviousDayLine, usHolidayWhen, usPreviousDayLine } from "@/lib/briefingDigest";
import { gated } from "@/lib/features";
import { formatDateKo, formatWon, SESSION_LABEL, shownSign } from "@/lib/format";
import { mdw } from "@/lib/marketSummary";

/**
 * 계좌 한 장 브리핑(3-31) 화면용 순수 함수 (React Native 를 불러오지 않음 → 테스트).
 * 숫자는 서버가 계산해 둔 값을 그대로 쓴다 — 앱에서 다시 계산하지 않는다.
 */

/**
 * 브리핑 탭 맨 위 카드에 보일 계좌 브리핑: 플래그가 켜져 있고 받은 목록이 있을 때 가장 최근 것.
 * 꺼져 있으면(또는 예전 서버 404 → 빈 목록) 없음 → 카드가 없다
 */
export function accountCardItem(on: boolean, list: readonly AccountBriefing[] | undefined): AccountBriefing | undefined {
  return gated(on, list?.[0]);
}

export interface ContributionLine {
  key: string;
  name: string;
  amount: number;
  changeRate: number | null;
  /** '그 외 N종목' 줄 */
  others: boolean;
}

/** 기여 표: 상위 종목 + '그 외 N종목'. 줄의 합(sum)이 당일 손익과 1원 안에서 같은지(matches)도 함께 */
export function contributionTable(d: Pick<AccountData, "contributions" | "others" | "dayPnl">): { lines: ContributionLine[]; sum: number; matches: boolean } {
  const lines: ContributionLine[] = d.contributions.map((c) => ({ key: c.code, name: c.name, amount: c.amount, changeRate: c.changeRate, others: false }));
  if (d.others) lines.push({ key: "__others", name: `그 외 ${d.others.count}종목`, amount: d.others.amount, changeRate: null, others: true });
  const sum = lines.reduce((a, l) => a + l.amount, 0);
  return { lines, sum, matches: Math.abs(sum - d.dayPnl) <= 1 };
}

/**
 * '기여 1위·상위': 당일 손익과 같은 방향 종목만 크기 순으로 (당일 손익이 0 이면 크기 순 그대로). 서버 accountNumbers.leaders 와 같은 규칙 —
 * 서버가 저장한 요약 줄 '기여 1위 …'(summaryText)와 목록 headline.top 이 이것으로 골랐다. 기여 표(contributions)는 크기 순 그대로 둔다
 * (오른 날 표 첫 줄이 손실 종목일 수 있다 — 그 줄을 '기여 1위'로 읽으면 화면의 요약 줄과 다른 종목을 말하게 된다)
 */
export function leaders<T extends { amount: number }>(d: { dayPnl: number; contributions: readonly T[] }): T[] {
  const dir = Math.sign(d.dayPnl);
  return dir === 0 ? [...d.contributions] : d.contributions.filter((c) => Math.sign(c.amount) === dir);
}

/** 화면 읽기: 기여 표 한 줄을 한 문장으로 ("애플, 기여 18,089원 손실, 1.59% 하락") */
export function contributionSpeech(l: ContributionLine): string {
  return sentence([l.name, `기여 ${speakProfit(formatWon(l.amount, { sign: true }), Math.sign(l.amount)) ?? "없음"}`, l.others ? null : speakRate(l.changeRate)]);
}

/**
 * 화면 읽기: 미국 휴장 한 마디. 휴장일이 브리핑 날짜의 전날(또는 모름)이면 '지난밤 미국 휴장, …',
 * 아니면(금요일 휴장 다음 월요일) '12월 25일 (금) 미국 휴장, …' (화면의 '12/25(금) 미국 휴장 · …' 줄과 같은 날짜를 말로)
 */
export function usPreviousDaySpeech(briefingDate: string, holidayDate?: string | null): string {
  const when = usHolidayWhen(briefingDate, holidayDate);
  return `${when === "지난밤" || !holidayDate ? "지난밤" : formatDateKo(holidayDate)} 미국 휴장, 미국 종목은 직전 거래일 등락`;
}

/**
 * 화면 읽기: 한국 휴장 한 마디. trim(플래그 briefingTrim)이면 브리핑 날짜를 말로 ('9월 25일 (금) 한국 휴장, …' — 화면의 '9/25(금) 한국 휴장 · …' 줄과 같게),
 * 아니면 예전 문장 ('오늘 한국 휴장, …')
 */
function krPreviousDaySpeech(date: string, trim: boolean): string {
  return `${trim ? formatDateKo(date) : "오늘"} 한국 휴장, 국내 종목은 직전 거래일 등락`;
}

/** 달력 전날 YYYY-MM-DD */
function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 계좌 줄의 휴장 한 줄 (보이는 글 · 화면 읽기 조각) */
export interface AccountHolidayLine {
  text: string;
  speech: string;
}

/**
 * 접은 화면 계좌 줄의 휴장 줄 (브리핑 2차 2, 플래그 briefingCompactTop — 한국 → 미국 순서). today = 보는 날(서울 'YYYY-MM-DD').
 *  - 한국: trim(플래그 briefingTrim)이면 브리핑 날짜 줄 '9/25(금) 한국 휴장 · …'. 아니면 예전 글 '오늘 한국 휴장 · …'을 브리핑 날짜가 오늘일 때만
 *    (월요일에 금요일 줄이 '오늘'로 뜨지 않게), 아니면 없음
 *  - 미국: 브리핑 날짜가 오늘이면 '지난밤 미국 휴장 · …'(또는 휴장일이 전날이 아니면 '12/25(금) 미국 휴장 · …').
 *    오늘이 아니면 '지난밤'이 틀린 말이 되므로 늘 날짜 모양 — 휴장일을 모르면(예전 기록) 브리핑 날짜의 달력 전날
 */
export function accountHolidayLines(b: Pick<AccountBriefing, "date" | "headline">, opts: { trim: boolean; today: string }): AccountHolidayLine[] {
  const h = b.headline;
  if (!h) return [];
  const out: AccountHolidayLine[] = [];
  if (h.krPreviousDay) {
    if (opts.trim) out.push({ text: krPreviousDayLine(b.date), speech: krPreviousDaySpeech(b.date, true) });
    else if (b.date === opts.today) out.push({ text: KR_PREVIOUS_DAY_LINE, speech: krPreviousDaySpeech(b.date, false) });
  }
  if (h.usPreviousDay) {
    if (b.date === opts.today) {
      out.push({ text: usPreviousDayLine(b.date, h.usHolidayDate), speech: usPreviousDaySpeech(b.date, h.usHolidayDate) });
    } else {
      const day = h.usHolidayDate ?? dayBefore(b.date);
      out.push({ text: `${mdw(day)} 미국 휴장 · 미국 종목은 직전 거래일 등락`, speech: `${formatDateKo(day)} 미국 휴장, 미국 종목은 직전 거래일 등락` });
    }
  }
  return out;
}

/** 당일 손익의 보이는 부호 (0원으로 보이면 0) */
const dayPnlSign = (dayPnl: number) => shownSign(dayPnl, formatWon(dayPnl, { sign: true }));

/**
 * 기여 상위 묶음 머리 (브리핑 2차 3, 플래그 moversMerge): '당일 손익 기여 상위 (오른 종목)' · 당일 손익이 음수면 '(내린 종목)' ·
 * 0 이면 괄호 없이 '당일 손익 기여 상위'. 종목은 서버가 당일 손익과 같은 방향에서만 고른다 — 그래서 '가장 많이 움직인'이라고 하지 않는다
 */
export function contributorsHead(dayPnl: number): string {
  const s = dayPnlSign(dayPnl);
  return s > 0 ? "당일 손익 기여 상위 (오른 종목)" : s < 0 ? "당일 손익 기여 상위 (내린 종목)" : "당일 손익 기여 상위";
}

/** 화면 읽기: 기여 상위 묶음 조각들 ('당일 손익 기여 상위 오른 종목', '삼성전자 348,000원 이익', …, '8시 38분 기준'). 종목이 없으면 빈 목록 */
function contributorsSpeech(b: AccountBriefing): string[] {
  const h = b.headline;
  if (!h || h.top.length === 0) return [];
  const s = dayPnlSign(h.dayPnl);
  const time = briefingTime(b.createdAt);
  return [
    s > 0 ? "당일 손익 기여 상위 오른 종목" : s < 0 ? "당일 손익 기여 상위 내린 종목" : "당일 손익 기여 상위",
    ...h.top.map((c) => `${c.name} ${speakProfit(formatWon(c.amount, { sign: true }), Math.sign(c.amount)) ?? ""}`.trim()),
    time ? `${speakClock(time)} 기준` : "",
  ];
}

/**
 * 화면 읽기: 브리핑 탭 '내 계좌 브리핑' 카드 한 문장. 옵션이 없으면 예전 문장 그대로 (넓은 창 줄·큰 카드의 끈 상태).
 *  - trim = 플래그 briefingTrim (한국 휴장 날짜)
 *  - contributors = 플래그 moversMerge 로 기여 상위 묶음을 보일 때: '기여 1위 …' 조각 대신 묶음 전체와 'HH시 MM분 기준'
 *  - today = 접은 화면 계좌 줄의 휴장 줄(플래그 briefingCompactTop)을 보일 때 보는 날 — 휴장 조각을 보이는 줄과 같은 판단으로 (accountHolidayLines)
 *  - since = 브리핑 3차 3 '9/25(금) 오전보다 총 평가 …' 한 줄(플래그 accountSinceLast)을 보일 때: 보이는 자리와 같은 순서로 기여(1위 또는 상위 묶음) 뒤·휴장 앞에
 *    그 줄의 읽는 말 (비교가 없는 브리핑이면 그대로)
 *  - week = 브리핑 3차 5 '이번 주 일정 · …' 한 줄(플래그 holdingEvents)을 보일 때: 보이는 자리와 같은 순서로 비교 줄 뒤·휴장 앞에 그 줄의 읽는 말 (없는 브리핑이면 그대로)
 *  - time = 3-32 숫자의 시각(플래그 numberBasis — 카드·줄이 'HH:MM 기준'을 그릴 때): 'H시 M분 기준'을 기여 1위 바로 뒤(비교·이번 주·휴장 앞)에.
 *    화면에서 그 시각은 당일 손익·기여 1위와 같은 줄(넓은 창 줄 끝)·당일 손익 이름 뒤(큰 카드)에 있다 — 끝에 두면 바로 앞의
 *    '리얼티인컴 배당락일 9월 30일 수요일'·휴장 줄의 시각처럼 들렸다 (기여 상위 묶음은 이미 묶음 끝에 시각이 있어 부르는 쪽이 넘기지 않음)
 */
export function accountCardSpeech(b: AccountBriefing, opts: { trim?: boolean; contributors?: boolean; today?: string; since?: boolean; week?: boolean; time?: boolean } = {}): string {
  const h = b.headline;
  const list = opts.contributors ? contributorsSpeech(b) : [];
  const top = list.length ? undefined : h?.top[0];
  const holidays =
    opts.today !== undefined
      ? accountHolidayLines(b, { trim: !!opts.trim, today: opts.today }).map((l) => l.speech)
      : [h?.krPreviousDay ? krPreviousDaySpeech(b.date, !!opts.trim) : null, h?.usPreviousDay ? usPreviousDaySpeech(b.date, h.usHolidayDate) : null];
  return sentence([
    "내 계좌 브리핑",
    `${formatDateKo(b.date)} ${SESSION_LABEL[b.session]}`,
    b.status === "failed" ? "생성 실패" : null,
    h ? `당일손익 ${speakProfit(formatWon(h.dayPnl, { sign: true }), Math.sign(h.dayPnl)) ?? "없음"}` : null,
    h ? speakRate(h.dayRate) : null,
    h ? `총 평가금액 ${speakAmount(formatWon(h.totalValue))}` : null,
    top ? `기여 1위 ${top.name} ${speakProfit(formatWon(top.amount, { sign: true }), Math.sign(top.amount)) ?? ""}` : null,
    ...list,
    // 3-32 (numberBasis): 숫자의 시각 — 카드·줄이 'HH:MM 기준'을 그릴 때만 (기여 상위 묶음이 있으면 부르는 쪽이 넘기지 않음).
    // 당일 손익·기여 1위 바로 뒤 (보이는 줄과 같은 자리 — 아래 비교·일정·휴장 줄의 시각으로 들리지 않게)
    opts.time && b.status !== "failed" && briefingTime(b.createdAt) ? `${speakClock(briefingTime(b.createdAt))} 기준` : null,
    opts.since ? (sinceLine(b)?.speech ?? null) : null,
    opts.week ? (weekLine(b)?.speech ?? null) : null,
    ...holidays,
    "자세히 보기",
  ]);
}

const profitText = (label: string, v: number) => `${label} ${speakProfit(formatWon(v, { sign: true }), Math.sign(v)) ?? "없음"}`;

/**
 * 화면 읽기: 상세 화면 맨 위 요약 카드 한 문장. 화면의 요약 줄('당일 -250,267원 (-2.66%) · 기여 1위 …')과 같은 숫자를
 * 기호 없이 말로 ("당일손익 250,267원 손실, 2.66% 하락, 기여 1위 리게티 컴퓨팅 268,838원 손실, …"). opts.trim = 플래그 briefingTrim (없으면 예전 문장)
 * '기여 1위'는 서버 요약 줄과 같은 규칙(leaders — 당일 손익과 같은 방향)으로 고른다. 표 첫 줄(크기 순)을 쓰면 반대 방향 종목이
 * 크기 1위인 날 화면은 '기여 1위 엔비디아 +169,763원', 화면 읽기는 '기여 1위 애플 171,154원 손실'로 서로 다른 종목을 말했다
 */
export function summarySpeech(d: AccountData, opts: { trim?: boolean } = {}): string {
  const top = leaders(d)[0];
  return sentence([
    "요약",
    profitText("당일손익", d.dayPnl),
    speakRate(d.dayRate),
    top ? profitText(`기여 1위 ${top.name}`, top.amount) : null,
    `총 평가금액 ${speakAmount(formatWon(d.totalValue))}`,
    d.fx.status === "computed" && d.fx.fxEffect !== null ? profitText("환율 효과", d.fx.fxEffect) : null,
    d.krPreviousDay ? krPreviousDaySpeech(d.date, !!opts.trim) : null,
    d.usPreviousDay ? usPreviousDaySpeech(d.date, d.usHolidayDate) : null,
  ]);
}

/**
 * 상세 맨 위 요약 카드에 그릴 줄 (서버가 저장한 summary 를 줄로 나눈 것). opts.trim(플래그 briefingTrim)이면 정확히 '오늘 한국 휴장 · …'인 줄만
 * 브리핑 날짜 줄('9/25(금) 한국 휴장 · …', krPreviousDayLine)로 바꿔 그린다 — 저장한 글은 그대로. 없으면 저장한 줄 그대로
 */
export function summaryShownLines(b: Pick<AccountBriefing, "summary" | "date">, opts: { trim?: boolean } = {}): string[] {
  const lines = b.summary.split("\n");
  return opts.trim ? lines.map((l) => (l === KR_PREVIOUS_DAY_LINE ? krPreviousDayLine(b.date) : l)) : lines;
}

/** 화면 읽기: 환율 효과 등식 줄 한 문장 ("미국 보유분 원화 평가 변화 209,723원 손실, 가격 효과 234,440원 손실, 환율 효과 24,717원 이익, …") */
export function fxEquationSpeech(fx: AccountData["fx"]): string | null {
  if (fx.status !== "computed" || fx.usdHoldingsKrwChange === null || fx.priceEffect === null || fx.fxEffect === null) return null;
  return sentence([
    profitText("미국 보유분 원화 평가 변화", fx.usdHoldingsKrwChange),
    `가격 효과와 환율 효과의 합`,
    profitText("가격 효과", fx.priceEffect),
    profitText("환율 효과", fx.fxEffect),
    "환율 효과는 원달러 전일 대비 변동으로 계산하며 당일 손익에는 넣지 않습니다",
  ]);
}

/**
 * 모델 설명 대신 기본 설명을 쓴 이유를 화면에 보일 말로. 숫자 검사 탈락·모델 오류의 자세한 이유(지어낸 숫자·오류 문구)는
 * 화면에 옮기지 않는다 — 틀린 숫자를 실제 값으로 읽지 않게 (자세한 이유는 서버 기록과 data 에만)
 */
export function templateNote(reason: string | null | undefined): string {
  const r = reason ?? "";
  if (/설정되지 않음/.test(r)) return "모델이 설정되지 않아 위 숫자로 만든 기본 설명을 보여 드립니다.";
  if (/^(입력에 없는 숫자|숫자 표기|방향이|부호가 빠진|쓰지 않는 표현|쓰지 않는 표기|빈 응답|설명이 너무)/.test(r)) return "모델 설명이 검사를 통과하지 못해 위 숫자로 만든 기본 설명을 보여 드립니다.";
  if (/^(모델 호출 실패|모델 응답 시간)/.test(r)) return "모델 설명을 받지 못해 위 숫자로 만든 기본 설명을 보여 드립니다.";
  return "위 숫자로 만든 기본 설명입니다.";
}

/**
 * 브리핑을 만든 한국 시각 "08:35". 오늘 일정 카드의 장 상태는 이 시각의 것이다 — 오전 브리핑은 오후 브리핑이 생길 때까지
 * 맨 위 카드로 남으므로 '지금'이라고 보이면 정오에 연 사람이 한국 정규장이 열려 있는데도 '개장 전'으로 읽는다
 */
export function briefingTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

/** 미국 정규장 날짜 "9/25(현지)" */
export function localDay(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(현지)`;
}
