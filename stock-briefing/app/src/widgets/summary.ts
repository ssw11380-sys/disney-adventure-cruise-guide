import { sentence, speakRate } from "@/lib/a11y";
import { shownSign } from "@/lib/format";
import { holdingsCountText, md, rateText, speakText } from "@/lib/marketSummary";
import type { IndexInput, SummaryInput } from "./layout";
import { HOME_URI } from "./model";
import type { WidgetSummary } from "./payload";

/**
 * 브리핑 위젯 첫 줄 — 시장 전체 요약 (플래그 marketSummary, 확정 설계 '화면·알림 설계' 5번). 순수 함수 (위젯 그림·테스트가 같이 쓴다).
 * 숫자는 서버가 요약에 저장한 값 그대로(코드로 만든 값, AI 문장 없음)이고, 글은 틀에 채운다. 평가·권유·원인 말은 쓰지 않는다.
 *  - 칩: '밤사이 미국'(숫자의 거래일이 보는 날의 전날일 때만) · '9/25 미국'(월요일·휴장 다음 날·다음 날에 볼 때) · '오늘 한국' · '9/23 한국'(자정 뒤·주말에 볼 때) ·
 *    '오늘 한국 휴장(추석)'(좁으면 이름 없이). 장중 값이면 ' 장중(16:00)', 미국 최종값 전이면 '(최종값 전)' — 보는 날짜로 정한다 (저장한 문구가 아님)
 *  - 지수: 이름과 등락률(색). 한국 휴장이면 직전 거래일 날짜를 흐리게 ('코스피 +0.90% 9/23'). 받지 못한 지수는 뺀다 (상세에 '—'와 까닭)
 *  - 둘째 줄(높이가 남을 때만 — layout.ts planBriefing): '내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7' (휴장이면 앞에 '9/23 기준 · ')
 *  - 누르면 그 요약의 상세 (/briefings/market/<id>)
 */

/** 첫 줄 지수 한 칸 (layout.ts 가 폭을 재는 모양 + 색·화면 읽기) */
export interface SummaryItem extends IndexInput {
  code: string;
  changeRate: number;
  /** 등락률 글자의 부호 — "0.00%" 로 보이면 0 (기본 글자색, BH-38) */
  sign: number;
}

/** 첫 줄을 누르면 여는 곳: 그 요약의 상세 화면 (앱 라우트 briefings/market/[id]) */
export const summaryUri = (id: number) => `${HOME_URI}briefings/market/${id}`;

const kstDateOf = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
const kstHmOf = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(11, 16);
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 칩 글자 후보 (긴 것부터 — 좁으면 뒤의 것). now = 그리는 순간 (보는 날짜, 한국).
 * 미국: 숫자의 거래일(basisDate)이 보는 날의 전날이면 '밤사이 미국', 아니면 '9/25 미국' (월요일·추수감사절 다음 날 — 사양 보정).
 * 한국: 휴장이면 '오늘 한국 휴장(추석)'(다른 날 보면 '9/25 한국 휴장(추석)'), 아니면 거래일이 오늘이면 '오늘 한국', 아니면 '9/23 한국'
 */
export function summaryChips(s: Pick<WidgetSummary, "market" | "basisDate" | "holiday" | "phase" | "asOf">, now: number): string[] {
  const today = kstDateOf(now);
  if (s.market === "KR" && s.holiday) {
    const base = `${s.holiday.date === today ? "오늘" : md(s.holiday.date)} 한국 휴장`;
    return s.holiday.name ? [`${base}(${s.holiday.name})`, base] : [base];
  }
  const td = s.basisDate;
  const word = s.market === "US" ? (td === addDays(today, -1) ? "밤사이 미국" : `${md(td)} 미국`) : td === today ? "오늘 한국" : `${md(td)} 한국`;
  const made = Date.parse(s.asOf);
  const phase = s.phase === "intraday" && Number.isFinite(made) ? ` 장중(${kstHmOf(made)})` : s.phase === "prelim" ? "(최종값 전)" : "";
  return [`${word}${phase}`];
}

/** 첫 줄 지수 (요약 순서 그대로 — 좁으면 layout 이 뒤에서부터 뺀다: 필라반도체 → 다우). 받지 못한 지수는 뺀다 */
export function summaryItems(s: Pick<WidgetSummary, "market" | "basisDate" | "holiday" | "indices">): SummaryItem[] {
  // 한국 휴장: 숫자가 직전 거래일 값이라 칸마다 그 날짜 (칩은 '오늘 한국 휴장'). 미국 휴장 다음 날은 칩이 이미 그 날짜('11/25 미국')
  const dated = s.market === "KR" && !!s.holiday;
  return s.indices.flatMap((i): SummaryItem[] => {
    if (i.changeRate === null || !Number.isFinite(i.changeRate)) return [];
    const rate = rateText(i.changeRate);
    return [{ code: i.code, label: i.name, value: "", rate, stale: false, tag: dated ? md(i.date ?? s.basisDate) : null, short: true, changeRate: i.changeRate, sign: shownSign(i.changeRate, rate) }];
  });
}

/** 둘째 줄: 내 보유 종목과 지수 (개수만). 비교한 종목이 없으면 null. 휴장이면 앞에 'M/D 기준 · ' (카드의 내 종목 줄과 같은 규칙) */
export function summarySecond(s: Pick<WidgetSummary, "market" | "basisDate" | "holiday" | "holdings">): string | null {
  const h = s.holdings;
  if (!h || h.compared <= 0) return null;
  return `${s.holiday ? `${md(s.basisDate)} 기준 · ` : ""}${holdingsCountText(s.market, h)}`;
}

/** layout.ts planBriefing 에 넘기는 첫 줄 (지수가 하나도 없으면 null — 첫 줄 없이 지금 그림) */
export function summaryInput(s: WidgetSummary, now: number): SummaryInput<SummaryItem> | null {
  const items = summaryItems(s);
  if (!items.length) return null;
  return { chips: summaryChips(s, now), items, second: summarySecond(s) };
}

/** 날짜 'M/D' → 'M월 D일' (화면 읽기) */
const speakDates = (text: string) => text.replace(/(\d{1,2})\/(\d{1,2})(?!\d)/g, (_m, m: string, d: string) => `${Number(m)}월 ${Number(d)}일`);

/**
 * 첫 줄 누르는 칸의 화면 읽기 문장 (보이는 것만 — 좁아서 뺀 지수는 읽지 않는다):
 * '시장 요약, 밤사이 미국, 나스닥 0.48% 상승, S&P500 0.51% 상승, 내 미국 12종목, 지수보다 높음 2, 낮음 3, 비슷 7, 자세히 보기'
 */
export function summarySpeech(chip: string, items: readonly SummaryItem[], second: string | null): string {
  return sentence([
    "시장 요약",
    speakDates(chip),
    ...items.map((i) => [i.label, speakRate(i.changeRate), i.tag ? `${speakDates(i.tag)} 값` : null].filter(Boolean).join(" ")),
    second ? speakDates(speakText(second)) : null,
    "자세히 보기",
  ]);
}
