import type { AccountBriefing, AccountData } from "@/api/types";
import { sentence, speakAmount, speakProfit, speakRate } from "@/lib/a11y";
import { gated } from "@/lib/features";
import { formatDateKo, formatWon, SESSION_LABEL } from "@/lib/format";

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

/** 화면 읽기: 기여 표 한 줄을 한 문장으로 ("애플, 기여 18,089원 손실, 1.59% 하락") */
export function contributionSpeech(l: ContributionLine): string {
  return sentence([l.name, `기여 ${speakProfit(formatWon(l.amount, { sign: true }), Math.sign(l.amount)) ?? "없음"}`, l.others ? null : speakRate(l.changeRate)]);
}

/** 화면 읽기: 브리핑 탭 '내 계좌 브리핑' 카드 한 문장 */
export function accountCardSpeech(b: AccountBriefing): string {
  const h = b.headline;
  const top = h?.top[0];
  return sentence([
    "내 계좌 브리핑",
    `${formatDateKo(b.date)} ${SESSION_LABEL[b.session]}`,
    b.status === "failed" ? "생성 실패" : null,
    h ? `당일손익 ${speakProfit(formatWon(h.dayPnl, { sign: true }), Math.sign(h.dayPnl)) ?? "없음"}` : null,
    h ? speakRate(h.dayRate) : null,
    h ? `총 평가금액 ${speakAmount(formatWon(h.totalValue))}` : null,
    top ? `기여 1위 ${top.name} ${speakProfit(formatWon(top.amount, { sign: true }), Math.sign(top.amount)) ?? ""}` : null,
    h?.krPreviousDay ? "오늘 한국 휴장, 국내 종목은 직전 거래일 등락" : null,
    h?.usPreviousDay ? "지난밤 미국 휴장, 미국 종목은 직전 거래일 등락" : null,
    "자세히 보기",
  ]);
}

const profitText = (label: string, v: number) => `${label} ${speakProfit(formatWon(v, { sign: true }), Math.sign(v)) ?? "없음"}`;

/**
 * 화면 읽기: 상세 화면 맨 위 요약 카드 한 문장. 화면의 요약 줄('당일 -250,267원 (-2.66%) · 기여 1위 …')과 같은 숫자를
 * 기호 없이 말로 ("당일손익 250,267원 손실, 2.66% 하락, 기여 1위 리게티 컴퓨팅 268,838원 손실, …")
 */
export function summarySpeech(d: AccountData): string {
  const top = d.contributions[0];
  return sentence([
    "요약",
    profitText("당일손익", d.dayPnl),
    speakRate(d.dayRate),
    top ? profitText(`기여 1위 ${top.name}`, top.amount) : null,
    `총 평가금액 ${speakAmount(formatWon(d.totalValue))}`,
    d.fx.status === "computed" && d.fx.fxEffect !== null ? profitText("환율 효과", d.fx.fxEffect) : null,
    d.krPreviousDay ? "오늘 한국 휴장, 국내 종목은 직전 거래일 등락" : null,
    d.usPreviousDay ? "지난밤 미국 휴장, 미국 종목은 직전 거래일 등락" : null,
  ]);
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
