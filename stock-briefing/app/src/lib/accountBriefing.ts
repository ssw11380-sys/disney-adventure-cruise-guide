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
    "자세히 보기",
  ]);
}

/** 미국 정규장 날짜 "9/25(현지)" */
export function localDay(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(현지)`;
}
