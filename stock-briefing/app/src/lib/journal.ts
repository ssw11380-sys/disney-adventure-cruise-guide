import type { JournalExcludedSell, JournalItem, JournalRealizedSum, JournalResponse, JournalReturns, JournalTax, JournalTaxItem, JournalTaxUnexplained, ReturnsMarket, ReturnsPreset } from "@/api/types";
import { sentence, speakAmount, speakProfit, speakRate } from "./a11y";
import { formatPct, formatPrice, shownSign } from "./format";
import { clampScale } from "./textScale";

/**
 * 매매일지 (3-37, 기능 플래그 tradeJournal · tradeRecords) — 화면 글·화면 읽기 문장·기간 고르기. React Native 를 불러오지 않는 순수 모듈.
 * 사실만 적는다: 매매를 권하거나 세금에 대한 행동을 권하는 말은 쓰지 않는다 (문구 검사 test/journal.test.ts)
 * 검토 반영 10차 종목·해 규칙: 그해 주문 내역으로 설명되지 않는 변화가 있던 종목의 그해 매도는 숫자 없이 '확인이 필요한 매도'로 따로 보이고
 * (그해 있었던 일 · 비율 짐작은 '(추정)' 이름표로만 · 토스증권 앱에서 확인하라는 안내), 그 종목이 든 기간은 수익률에서 뺐다고 알린다
 */

type Cur = "KRW" | "USD";

export const JOURNAL = {
  title: "매매일지",
  open: "매매일지 열기",
  cardDesc: "토스 체결 기록으로 실현손익·기간 수익률·해외주식 양도세(추정)를 봐요.",
  cardNoToss: "토스증권을 연동하면 장 마감 뒤부터 기록이 쌓여요.",
  cardRecords: "기록",
  stockRow: "이 종목 매매 기록",
  stockRowA11y: "이 종목 매매 기록 보기",
  stockLink: "매매 기록",
  stockPanelTitle: "매매 기록",
  tabs: [
    { value: "list", label: "기록" },
    { value: "returns", label: "수익률" },
    { value: "tax", label: "양도세 추정" },
  ] as const,
  emptyNoToss: "토스증권을 연동하면 장 마감 뒤부터 매매 기록이 쌓여요.",
  emptyNone: "이 기간에 저장된 체결이 없어요.",
  emptyYear: "기간 1년으로 보기",
  openSettings: "설정 열기",
  allStocks: "모든 종목",
  pickStock: "종목 고르기",
  clearStock: "종목 거르기 지우기",
  pickPeriod: "기간 고르기",
  apply: "적용",
  change: "바꾸기",
  rangeMax: "기간은 400일까지 고를 수 있어요.",
  rangeOrder: "시작이 끝보다 늦어요.",
  /** 기록과 다른 변화 줄 셋째 줄 */
  changeNote: "그해 이 종목의 매도 손익과 이 종목이 든 기간의 수익률은 계산하지 않았어요.",
  /** 확인이 필요한 매도 줄 오른쪽 (숫자 대신) */
  excludedRight: "확인 필요",
  excludedToss: "실제 손익은 토스증권 앱의 거래 내역에서 확인해 주세요.",
  excludedNote: "그해 주문 내역으로 설명되지 않는 변화(분할·병합·무상증자·입고·출고·분사·큰 주가 변화 등)가 있던 종목의 그해 매도라 위 실현손익 합계에 넣지 않았어요. 실제 손익은 토스증권 앱의 거래 내역에서 확인해 주세요.",
  pickHint: "왼쪽에서 체결을 고르면 계산이 보여요.",
  method: "평균 구매가는 이동평균법(산 금액 합을 수량으로 나눈 값, 토스와 같은 방식)으로 계산했어요.",
  noteTitle: "메모",
  notePlaceholder: "이 거래에 남길 메모 (200자까지)",
  noteA11y: "메모, 200자까지",
  noteSaved: "메모를 저장했어요.",
  noteFailed: "메모를 저장하지 못했어요. 다시 해 주세요.",
  noteSave: "저장",
  noteClear: "지우기",
  /** [지우기]는 입력 칸만 비운다 — 서버의 메모는 [저장]을 눌러야 지워진다 (되돌릴 수 없는 바로 지우기 막기) */
  noteClearA11y: "메모 입력 칸 비우기",
  noteDeleted: "메모를 지웠어요.",
  /** 저장한 메모가 있는데 입력 칸을 비웠을 때 */
  noteEmptyHint: "비운 채 [저장]을 누르면 저장한 메모를 지워요.",
  close: "닫기",
  costsNone: "토스가 주지 않아 빼지 않았어요",
  grossNote: "실현손익은 수수료·세금을 빼기 전 금액이에요 (토스 주문 내역에 비용이 없음).",
} as const;

/** '양도세 추정' 탭 이름 폭 어림 (굵은 14 글자 다섯 자 + 여유, 글자 100%) */
const TAX_TAB_W = 84;

/**
 * 위 탭 이름: 한 칸(창 폭 ÷ 3)에 '양도세 추정'이 한 줄로 안 들어가면(좁은 폭 × 큰 글씨) '양도세' — 글자 중간에서 줄이 바뀌지 않게.
 * '추정'은 그 탭 맨 위 상자·제목에 늘 있다
 */
export function journalTabs(width: number, fontScale: number): { value: "list" | "returns" | "tax"; label: string }[] {
  const fits = width / 3 >= TAX_TAB_W * clampScale(fontScale);
  return JOURNAL.tabs.map((t) => (t.value === "tax" && !fits ? { value: t.value, label: "양도세" } : { value: t.value, label: t.label }));
}

export const NOTE_MAX = 200;
export const MAX_RANGE_DAYS = 400;

export type ListPreset = Exclude<ReturnsPreset, "custom"> | "custom";
export const PERIODS: readonly { value: ListPreset; label: string }[] = [
  { value: "1W", label: "1주" },
  { value: "1M", label: "1달" },
  { value: "3M", label: "3달" },
  { value: "YTD", label: "올해" },
  { value: "1Y", label: "1년" },
  { value: "custom", label: "직접" },
];
export const MARKETS: readonly { value: ReturnsMarket; label: string }[] = [
  { value: "ALL", label: "전체" },
  { value: "KR", label: "한국" },
  { value: "US", label: "미국" },
];

// ── 날짜 ─────────────────────────────────────────────────────────────

/** 한국 날짜 YYYY-MM-DD */
export function kstDate(ms: number): string {
  return new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function shiftMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** 기간 고르기 → [from, to] (to = 오늘, 한국 날짜). 서버 journalReturns.presetRange 와 같은 규칙 */
export function periodRange(preset: Exclude<ListPreset, "custom">, today: string): { from: string; to: string } {
  const from =
    preset === "1W" ? addDays(today, -7) : preset === "1M" ? shiftMonths(today, -1) : preset === "3M" ? shiftMonths(today, -3) : preset === "YTD" ? `${today.slice(0, 4)}-01-01` : shiftMonths(today, -12);
  return { from, to: today };
}

/** 직접 고른 기간이 괜찮은지 (틀리면 화면 글) */
export function customRangeError(from: string, to: string): string | null {
  if (from > to) return JOURNAL.rangeOrder;
  if (addDays(from, MAX_RANGE_DAYS) < to) return JOURNAL.rangeMax;
  return null;
}

/** '9월 1일' */
export function mdKo(date: string): string {
  return `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
}

/** '9/1' */
export function mdShort(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
/** '9월 25일 (금)' */
export function dayHeader(date: string): string {
  return `${mdKo(date)} (${WEEK[new Date(`${date}T12:00:00Z`).getUTCDay()]})`;
}

/** 읽는 날짜 '9월 25일 금요일' */
export function daySpeech(date: string): string {
  return `${mdKo(date)} ${WEEK[new Date(`${date}T12:00:00Z`).getUTCDay()]}요일`;
}

/** 한국 시각 조각 (연·월·일·시·분·초) */
function kstParts(iso: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const k = new Date(t + 9 * 3_600_000);
  return { y: k.getUTCFullYear(), mo: k.getUTCMonth() + 1, d: k.getUTCDate(), h: k.getUTCHours(), mi: k.getUTCMinutes(), s: k.getUTCSeconds() };
}
const two = (n: number) => String(n).padStart(2, "0");

/** 줄에 쓰는 시각: 체결 시각 '23:10' · 주문 시각 '주문 22:31' · 확인 시각 '9/29 05:05 전' */
export function timeText(item: Pick<JournalItem, "at" | "timeBasis">): string {
  const p = kstParts(item.at);
  if (!p) return "";
  const hm = `${two(p.h)}:${two(p.mi)}`;
  if (item.timeBasis === "filled") return hm;
  if (item.timeBasis === "ordered") return `주문 ${hm}`;
  return `${p.mo}/${p.d} ${hm} 전`;
}

/** 읽는 시각: '9월 25일 오후 11시 10분' · 초까지(seconds) '9월 25일 오후 11시 10분 4초' (상세의 체결 시각 — 화면이 초까지 보인다) */
export function speakTime(iso: string, seconds = false): string {
  const p = kstParts(iso);
  if (!p) return "";
  const ampm = p.h < 12 ? "오전" : "오후";
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  if (seconds) return `${p.mo}월 ${p.d}일 ${ampm} ${h12}시 ${p.mi}분 ${p.s}초`;
  return `${p.mo}월 ${p.d}일 ${ampm} ${h12}시${p.mi ? ` ${p.mi}분` : ""}`;
}

/** 상세 '체결' 줄 화면 읽기 (화면 글 detailTime 과 같은 내용을 읽는 말로) */
function detailTimeSpeech(item: Pick<JournalItem, "at" | "timeBasis">): string {
  if (item.timeBasis === "filled") return `체결 ${speakTime(item.at, true)}`;
  if (item.timeBasis === "ordered") return `체결, 주문 시각 ${speakTime(item.at)}, 체결 시각 없음`;
  return `체결, ${speakTime(item.at)} 전 확인, 토스가 체결 시각을 주지 않음`;
}

/** 상세의 체결 시각 줄 */
export function detailTime(item: Pick<JournalItem, "at" | "timeBasis">): string {
  const p = kstParts(item.at);
  if (!p) return "-";
  if (item.timeBasis === "filled") return `${p.y}년 ${p.mo}월 ${p.d}일 ${two(p.h)}:${two(p.mi)}:${two(p.s)}`;
  if (item.timeBasis === "ordered") return `주문 시각 ${p.mo}월 ${p.d}일 ${two(p.h)}:${two(p.mi)} · 체결 시각 없음`;
  return `${p.mo}/${p.d} ${two(p.h)}:${two(p.mi)} 전 (토스가 체결 시각을 주지 않음)`;
}

// ── 숫자 ─────────────────────────────────────────────────────────────

/** 수량: 끝 0 을 지운 여섯째 자리까지 + '주' (BH-48) */
export function qtyText(q: number): string {
  return `${Number(q.toFixed(6)).toLocaleString("en-US", { maximumFractionDigits: 6 })}주`;
}

/** 금액 (부호 선택) */
export function money(v: number | null | undefined, cur: Cur, sign = false): string {
  return formatPrice(v, cur, { sign });
}

/** 평균 구매가·체결가: 달러는 넷째 자리까지(필요할 때만), 원은 정수 */
export function avgText(v: number | null | undefined, cur: Cur): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  if (cur === "KRW") return formatPrice(v, "KRW");
  const s = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return `$${s}`;
}

const sideText = (side: JournalItem["side"]) => (side === "BUY" ? "매수" : side === "SELL" ? "매도" : "");

// ── 기록 줄 ──────────────────────────────────────────────────────────

/** 확인이 필요한 매도 (그해 주문 내역으로 설명되지 않는 변화가 있던 종목) */
const excludedSell = (item: JournalItem) => item.side === "SELL" && item.realized?.status === "unexplained";

/** 실현손익 글 '+$17.43 (+10.25%)' (모르면 '실현손익 모름', 확인이 필요하면 '확인 필요') */
export function realizedText(item: JournalItem): string {
  const r = item.realized;
  if (excludedSell(item)) return JOURNAL.excludedRight;
  if (!r || r.status === "unknown-cost" || r.gross === null) return "실현손익 모름";
  const base = `${money(r.gross, item.currency, true)}${r.rate !== null ? ` (${formatPct(r.rate)})` : ""}`;
  if (r.status === "order-uncertain") return `${base} · 순서 추정`;
  return base;
}

/**
 * 줄 오른쪽: 매도는 실현손익 숫자만(추정·순서 추정 꼬리표는 셋째 줄 까닭 문장이 말한다 — 큰 글씨에서 숫자가 잘리지 않게), 매수는 산 금액
 */
export function rightText(item: JournalItem): string {
  if (item.kind === "change") return "";
  if (item.side !== "SELL") return money(item.amount, item.currency);
  if (excludedSell(item)) return JOURNAL.excludedRight;
  const r = item.realized;
  if (!r || r.status === "unknown-cost" || r.gross === null) return "실현손익 모름";
  return `${money(r.gross, item.currency, true)}${r.rate !== null ? ` (${formatPct(r.rate)})` : ""}`;
}

/** 줄 오른쪽 색의 부호 (손익) — 매수·모름은 0 */
export function rightSign(item: JournalItem): number {
  const r = item.realized;
  if (item.side !== "SELL" || !r || r.gross === null || r.status === "unknown-cost") return 0;
  return shownSign(r.gross, money(r.gross, item.currency));
}

/** 기록과 다른 변화 줄의 이름 ('기록과 다름' · '큰 주가 변화') */
const changeLabel = (item: JournalItem) => (item.change?.kind === "possible-action" ? "큰 주가 변화" : "기록과 다름");

/** 줄 제목 '[매도] SOXL' 의 뒤 · 기록과 다른 변화 줄 '[기록과 다름] NAVER' · '[큰 주가 변화] NAVER' */
export function titleText(item: JournalItem): string {
  if (item.kind === "change") return `[${changeLabel(item)}] ${item.name}`;
  return item.name;
}

/** 둘째 줄 '5주 · 평균 $37.50 · 23:10 · 판매 금액 $187.50' (며칠에 걸친 몫은 '이 날 2주 (주문 4주 중)') */
export function detailLine(item: JournalItem): string {
  if (item.kind === "change") return item.change?.text ?? "";
  const qty = item.part ? `이 날 ${qtyText(item.quantity)} (주문 ${qtyText(item.orderQuantity)} 중)` : qtyText(item.quantity);
  return [
    item.accountLabel,
    qty,
    `평균 ${avgText(item.price, item.currency)}`,
    timeText(item),
    item.side === "SELL" ? `판매 금액 ${money(item.amount, item.currency)}` : null,
    item.status === "OPEN" ? "일부 체결 (진행 중)" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 셋째 줄들: 추정·모름·확인 필요 까닭(서버 문장 — 확인이 필요한 매도는 그해 있었던 일·이름표도), 메모. 기록과 다른 변화 줄은 이름표 + 계산하지 않았다는 말 */
export function extraLines(item: JournalItem): string[] {
  if (item.kind === "change") return [item.change?.guess, JOURNAL.changeNote].filter((x): x is string => !!x);
  const out: string[] = [];
  const r = item.realized;
  if (item.side === "SELL" && r && r.status !== "ok" && r.reason) out.push(r.reason);
  if (excludedSell(item)) {
    if (r?.change) out.push(r.change);
    if (r?.guess) out.push(r.guess);
  }
  if (item.note) out.push(`메모: ${item.note}`);
  return out;
}

/** 화면 읽기 한 문장 ('9월 25일 오후 11시 10분, SOXL 5주 매도, 평균 37.50달러, 판매 금액 187.50달러, 실현손익 17.43달러 이익, 10.25퍼센트, 메모 있음') */
export function rowSpeech(item: JournalItem): string {
  if (item.kind === "change") return sentence([speakTime(item.at), changeLabel(item), item.name, item.change?.text, item.change?.guess, JOURNAL.changeNote]);
  const r = item.realized;
  const time = item.timeBasis === "filled" ? speakTime(item.at) : item.timeBasis === "ordered" ? `주문 시각 ${speakTime(item.at)}` : `${speakTime(item.at)} 전 확인`;
  const sell = item.side === "SELL";
  const known = sell && r && r.status !== "unknown-cost" && r.status !== "unexplained" && r.gross !== null;
  return sentence([
    time,
    item.accountLabel,
    `${item.name} ${item.part ? `이 날 ${qtyText(item.quantity)}, 주문 ${qtyText(item.orderQuantity)} 중` : qtyText(item.quantity)} ${sideText(item.side)}`,
    `평균 ${speakAmount(avgText(item.price, item.currency))}`,
    sell ? `판매 금액 ${speakAmount(money(item.amount, item.currency))}` : `산 금액 ${speakAmount(money(item.amount, item.currency))}`,
    known ? `실현손익 ${speakProfit(money(r!.gross, item.currency), rightSign(item)) ?? "없음"}` : excludedSell(item) ? `실현손익 ${JOURNAL.excludedRight}` : sell ? "실현손익 모름" : null,
    known && r!.rate !== null ? `${Math.abs(r!.rate).toFixed(2)}퍼센트` : null,
    sell && r && r.status === "order-uncertain" ? "순서 추정" : null,
    item.status === "OPEN" ? "일부 체결, 진행 중" : null,
    item.note ? "메모 있음" : null,
  ]);
}

/** 날짜 묶음 머리 오른쪽 '실현 +45,000원 · +$17.43' (매도가 없는 날은 null) */
export function dayRealizedText(r: JournalRealizedSum): string | null {
  const parts = [r.KRW !== null ? money(r.KRW, "KRW", true) : null, r.USD !== null ? money(r.USD, "USD", true) : null].filter(Boolean);
  return parts.length ? `실현 ${parts.join(" · ")}` : null;
}

/** 손익 읽는 말 ('45,000원 이익' · '1.20달러 손실') */
function profitSpeech(v: number, cur: Cur): string {
  const shown = money(v, cur);
  return speakProfit(shown, shownSign(v, shown)) ?? speakAmount(shown);
}

/** 날짜 묶음 머리 화면 읽기 '9월 23일 수요일, 실현손익 321,000원 손실, 17.43달러 이익' */
export function dayHeadSpeech(date: string, r: JournalRealizedSum): string {
  const parts = [r.KRW !== null ? profitSpeech(r.KRW, "KRW") : null, r.USD !== null ? profitSpeech(r.USD, "USD") : null].filter(Boolean);
  return sentence([daySpeech(date), parts.length ? `실현손익 ${parts.join(", ")}` : null]);
}

export interface SummaryView {
  range: string;
  /** speech: 화면 읽기 문장 ('미국 실현손익 3,652.75달러 이익, 원화 약 5,000,000원 이익, 추정') */
  lines: { label: string; value: string; sign: number; speech: string }[];
  counts: string;
  notes: string[];
  /** 확인이 필요한 매도 (매도마다 한 줄, 숫자 없음) */
  excluded: { title: string; lines: string[]; note: string } | null;
}

/** 확인이 필요한 매도 한 줄 '10/7 삼성전자 5주 · 10월 7일 기록: 수량 10 → 35주 · … · 1→4 분할로 보여요(추정)' */
function excludedLine(x: JournalExcludedSell): string {
  return [`${mdShort(x.date)} ${x.name} ${qtyText(x.quantity)}`, x.change ?? x.reason, x.guess].filter(Boolean).join(" · ");
}

/** 요약 카드 */
export function summaryView(resp: JournalResponse): SummaryView | null {
  const s = resp.summary;
  if (!s || !resp.from || !resp.to) return null;
  const r = s.realized;
  const lines: SummaryView["lines"] = [];
  if (r.KRW !== null) lines.push({ label: "국내", value: money(r.KRW, "KRW", true), sign: shownSign(r.KRW, money(r.KRW, "KRW")), speech: `국내 실현손익 ${profitSpeech(r.KRW, "KRW")}` });
  if (r.USD !== null) {
    const usKrw = r.krwTotal !== null ? r.krwTotal - (r.KRW ?? 0) : null;
    lines.push({
      label: "미국",
      value: `${money(r.USD, "USD", true)}${usKrw !== null ? ` (원화 약 ${money(usKrw, "KRW", true)}, 추정)` : ""}`,
      sign: shownSign(r.USD, money(r.USD, "USD")),
      speech: sentence([`미국 실현손익 ${profitSpeech(r.USD, "USD")}`, usKrw !== null ? `원화 약 ${profitSpeech(usKrw, "KRW")}` : null, usKrw !== null ? "추정" : null]),
    });
  }
  if (r.krwTotal !== null && r.KRW !== null && r.USD !== null)
    lines.push({
      label: "합계",
      value: `${r.krwTotalEstimated ? "약 " : ""}${money(r.krwTotal, "KRW", true)}`,
      sign: shownSign(r.krwTotal, money(r.krwTotal, "KRW")),
      speech: `합계 실현손익 ${r.krwTotalEstimated ? "약 " : ""}${profitSpeech(r.krwTotal, "KRW")}`,
    });
  const notes: string[] = [];
  if (s.sells > 0 && s.costs.toss === 0) notes.push(JOURNAL.grossNote);
  if (s.unknownSells > 0) notes.push(`실현손익을 모르는 매도 ${s.unknownSells}건은 합계에서 뺐어요 (평균 구매가를 몰라요).`);
  if (s.truncated.length) notes.push(`오래된 주문이 다 오지 않은 종목 ${s.truncated.length}개가 있어요.`);
  const ex = s.excludedSells ?? [];
  return {
    range: `${mdKo(resp.from)} ~ ${mdKo(resp.to)}`,
    lines,
    counts: `매수 ${s.buys}건 · 매도 ${s.sells}건 · 체결 ${s.orders}건`,
    notes,
    excluded: ex.length ? { title: `확인이 필요한 매도 ${ex.length}건`, lines: ex.map(excludedLine), note: JOURNAL.excludedNote } : null,
  };
}

/** 고른 기간이 기록 시작보다 앞이면 목록 위 한 줄. 종목을 골랐으면 머리 카드의 '기록 시작' 줄이 같은 말을 해서 없음 */
export function beforeRecordNote(resp: JournalResponse): string | null {
  if (resp.code || resp.head) return null;
  if (!resp.recordSince || !resp.from || resp.from >= resp.recordSince) return null;
  return `${mdKo(resp.recordSince)}부터 저장한 기록이에요. 그 전 체결은 토스에서 받아 온 것만 있어요.`;
}

// ── 거래 상세 ─────────────────────────────────────────────────────────

export interface DetailRow {
  label: string;
  value: string;
  sign?: number;
  /** 화면 읽기 문장 (없으면 '이름 값') — 금액·기호를 읽는 말로 */
  speech?: string;
}

/** 거래 상세 위 표 (체결 · 수량 · 평균 체결가 · 금액 · 주문 상태) */
export function detailRows(item: JournalItem): DetailRow[] {
  return [
    { label: "체결", value: detailTime(item), speech: detailTimeSpeech(item) },
    { label: "수량", value: item.part ? `${qtyText(item.quantity)} (주문 ${qtyText(item.orderQuantity)} 중 이 날 몫)` : qtyText(item.quantity) },
    { label: "평균 체결가", value: avgText(item.price, item.currency), speech: `평균 체결가 ${speakAmount(avgText(item.price, item.currency))}` },
    { label: item.side === "SELL" ? "판매 금액" : "산 금액", value: money(item.amount, item.currency), speech: `${item.side === "SELL" ? "판매 금액" : "산 금액"} ${speakAmount(money(item.amount, item.currency))}` },
    { label: "주문 상태", value: item.status === "OPEN" ? "일부 체결 · 진행 중" : "체결 완료" },
    ...(item.accountLabel ? [{ label: "계좌", value: item.accountLabel }] : []),
  ];
}

/** 매도 상세 '실현손익 계산' (모르면 까닭만) */
export function calcRows(item: JournalItem): { rows: DetailRow[]; notes: string[] } {
  const r = item.realized;
  if (!r) return { rows: [], notes: [] };
  if (r.status === "unexplained")
    return {
      rows: [{ label: "실현손익", value: JOURNAL.excludedRight, speech: `실현손익 ${JOURNAL.excludedRight}` }],
      notes: [r.reason, r.change ? `그해 있었던 일: ${r.change}` : null, r.guess, JOURNAL.excludedToss].filter((x): x is string => !!x),
    };
  if (r.status === "unknown-cost" || r.gross === null) return { rows: [{ label: "실현손익", value: "모름" }], notes: [r.reason ?? "평균 구매가를 몰라요."] };
  const cur = item.currency;
  const rows: DetailRow[] = [
    { label: "판매 금액", value: money(item.amount, cur), speech: `판매 금액 ${speakAmount(money(item.amount, cur))}` },
    {
      label: `− 평균 구매가 ${avgText(r.avgCost, cur)} × ${qtyText(item.quantity)}`,
      value: money(r.costAmount, cur),
      speech: `빼는 금액, 평균 구매가 ${speakAmount(avgText(r.avgCost, cur))} 곱하기 ${qtyText(item.quantity)}, ${speakAmount(money(r.costAmount, cur))}`,
    },
    {
      label: "= 실현손익",
      value: `${money(r.gross, cur, true)}${r.rate !== null ? ` (${formatPct(r.rate)})` : ""}`,
      sign: shownSign(r.gross, money(r.gross, cur)),
      speech: sentence([`실현손익 ${profitSpeech(r.gross, cur)}`, r.rate !== null ? `${Math.abs(r.rate).toFixed(2)}퍼센트` : null]),
    },
    { label: "수수료·세금", value: costText(r.costs, cur), speech: costSpeech(r.costs, cur) },
  ];
  const notes: string[] = [];
  if (r.krw) {
    if (r.krw.gross !== null) {
      rows.push({
        label: "원화로는",
        value: `약 ${money(r.krw.gross, "KRW", true)}${r.krw.estimated ? " (추정)" : ""}`,
        sign: shownSign(r.krw.gross, money(r.krw.gross, "KRW")),
        speech: sentence([`원화로는 약 ${profitSpeech(r.krw.gross, "KRW")}`, r.krw.estimated ? "추정" : null]),
      });
      if (r.krw.sellFx !== null) notes.push(`판매 때 환율 ${r.krw.sellFx.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}원(토스) · 매수 때 환율로 쌓은 원화 평균 구매가 기준`);
    } else if (r.krw.reason) notes.push(r.krw.reason);
  }
  if (r.status !== "ok" && r.reason) notes.push(r.reason);
  notes.push(JOURNAL.method);
  const b = basisText(r.basis, r.anchorDate);
  if (b) notes.push(b);
  return { rows, notes };
}

function costText(c: NonNullable<JournalItem["realized"]>["costs"], cur: Cur): string {
  if (c.source === "toss" && c.total !== null) return `${money(-c.total, cur, true)} (토스 주문 내역)`;
  if (c.source === "estimated" && c.total !== null) return `약 ${money(-c.total, cur, true)} · 토스 평가 차감 비율로 추정 (위 실현손익에서는 빼지 않음)`;
  return JOURNAL.costsNone;
}

function costSpeech(c: NonNullable<JournalItem["realized"]>["costs"], cur: Cur): string {
  if (c.source === "toss" && c.total !== null) return `수수료·세금 ${speakAmount(money(c.total, cur))} 뺌, 토스 주문 내역`;
  if (c.source === "estimated" && c.total !== null) return `수수료·세금 약 ${speakAmount(money(c.total, cur))}, 토스 평가 차감 비율로 추정, 위 실현손익에서는 빼지 않음`;
  return `수수료·세금, ${JOURNAL.costsNone}`;
}

/** 어디서 출발한 계산인지 */
export function basisText(basis: NonNullable<JournalItem["realized"]>["basis"], anchorDate: string | null): string | null {
  if (basis === "snapshot" && anchorDate) return `기준: ${mdKo(anchorDate)} 토스 잔고에서 출발`;
  if (basis === "history-checked" && anchorDate) return `주문 내역으로 계산 · ${mdKo(anchorDate)} 토스 평균 구매가와 맞음`;
  if (basis === "history-only") return "주문 내역만으로 계산 · 토스 잔고와 맞춰 보지 못함";
  return null;
}

/** 매수 상세 '이 매수 뒤 평균 구매가 $34.0133 · 30주' */
export function afterBuyText(item: JournalItem): string | null {
  const a = item.afterBuy;
  if (!a) return null;
  return `이 매수 뒤 평균 구매가 ${avgText(a.avgCost, item.currency)} · ${qtyText(a.quantity)}`;
}

/** 서버 cleanNote 처럼: 줄바꿈·탭은 빈칸으로, 앞뒤 빈칸은 뗀다 (제어 문자는 서버가 지움) */
function tidyNote(text: string | null | undefined): string {
  return (text ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

/** 입력 칸이 저장한 메모와 같은지 (같으면 [저장]을 끈다 — 서버에 보낼 것이 없음) */
export function noteUnchanged(text: string, saved: string | null): boolean {
  return tidyNote(text) === tidyNote(saved);
}

/** 저장 뒤 알림 글: 메모가 남으면 '저장했어요', 저장한 메모가 있었는데 비웠으면 '지웠어요', 처음부터 없었으면 없음 */
export function noteResultText(before: string | null, after: string | null): string | null {
  if (after) return JOURNAL.noteSaved;
  return before ? JOURNAL.noteDeleted : null;
}

/** 메모 글자 수 (보이는 글자) */
export function noteLength(text: string): number {
  return [...text].length;
}

/** 입력 칸: 200자에서 멈춘다 */
export function clampNote(text: string): string {
  const chars = [...text];
  return chars.length > NOTE_MAX ? chars.slice(0, NOTE_MAX).join("") : text;
}

// ── 이 종목 머리 카드 ─────────────────────────────────────────────────

export function headLines(h: NonNullable<JournalResponse["head"]>): string[] {
  const cur = h.holding?.currency ?? h.realized.currency;
  return [
    h.holding ? `지금 ${qtyText(h.holding.quantity)} · 평균 구매가 ${avgText(h.holding.avgCost, cur)}` : "지금 보유 없음",
    `기록된 실현손익 ${h.realized.amount !== null ? money(h.realized.amount, h.realized.currency, true) : "없음"} · 매수 ${h.buys}건 · 매도 ${h.sells}건`,
    ...(h.recordSince ? [`기록 시작: ${mdKo(h.recordSince)} (그 전 거래는 토스에서 받아 온 주문 내역만)`] : []),
  ];
}

/** 종목 상세 '보유 없음 · 저장된 체결 3건' */
export function stockPanelText(orders: number): string {
  return `보유 없음 · 저장된 체결 ${orders}건`;
}

// ── 수익률 ────────────────────────────────────────────────────────────

/**
 * 숫자를 못 보여 줄 때 안내: 기록 전체가 아직 짧음('지금 N거래일' — 기록 전체 길이) · 기록은 충분한데 고른 기간 안 기록이 2번보다 적음.
 * 기간 안 기록이 0일이면 마지막 기록일(recordUntil) 뒤인지 · 기록 시작 전인지 · 그 사이인지로 까닭을 나눈다.
 * recordDays 가 없는 예전 서버는 기간 안 거래일로 센다
 */
export function returnsNotReady(r: JournalReturns): string {
  const need = r.needDays ?? 10;
  const record = r.recordDays ?? r.tradingDays ?? 0;
  // 전체(원화): 미국 기록에 평가 환율이 없으면 기간을 늘려도 같다 — 그 까닭을 바로
  if (r.usFxMissing) return "미국 계좌 기록에 평가 환율이 없어 전체(원화) 수익률을 계산할 수 없어요. 한국·미국은 따로 볼 수 있어요.";
  // 고른 기간의 구간을 모두 건너뜀 (0% 로 보이지 않게)
  if (r.allSkipped) return `고른 기간의 계좌 기록은 모두 ${SKIP_WHAT} 기간이라 수익률을 계산하지 않았어요. 그 기간의 값을 짐작해 넣지 않아요.`;
  if (record >= need && (r.tradingDays ?? 0) === 0) {
    // 고른 기간에 기록이 0일: 마지막 기록 뒤(기록이 멈춤 — 동기화 실패 등) · 기록 시작 전 · 그 사이(주말·휴일·빠진 날)를 나눠 말한다
    const range = r.requested ? `(${mdKo(r.requested.from)} ~ ${mdKo(r.requested.to)})` : "";
    const head = `고른 기간${range}에는 계좌 기록이 없어요.`;
    const since = r.recordSince ?? null;
    const until = r.recordUntil ?? null;
    if (until && r.requested && r.requested.from > until) {
      return `${head} 마지막 기록은 ${mdKo(until)}이고, 그 뒤로는 계좌 기록이 저장되지 않았어요. 기록은 매일 장 마감 뒤 저장돼요.`;
    }
    if (since && r.requested && r.requested.to < since) return `${head} 기록은 ${mdKo(since)}부터 있어요.`;
    if (since && until) return `${head} 기록은 ${mdKo(since)}부터 ${mdKo(until)}까지 있고, 그 사이 주말·휴일과 기록이 빠진 날에는 기록이 없어요.`;
    // 마지막 기록일을 주지 않는 예전 서버
    return `${head}${since ? ` 기록은 ${mdKo(since)}부터 있고,` : ""} 주말·휴일과 기록 시작 전 날짜에는 기록이 없어요.`;
  }
  if (record >= need) return `고른 기간 안에 계좌 기록이 ${r.tradingDays ?? 0}거래일뿐이라 수익률을 계산할 수 없어요. 기간을 더 길게 골라 주세요.`;
  const since = r.recordSince ?? r.actual?.from ?? null;
  return `기간 수익률은 매일 장 마감 뒤 찍은 계좌 기록으로 계산해요. 기록이 ${need}거래일 쌓이면 보여 드려요. 지금 ${record}거래일${since ? ` (${mdKo(since)}부터)` : ""}.`;
}

export function returnsHeader(r: JournalReturns): string | null {
  if (!r.actual) return null;
  return `${mdKo(r.actual.from)}${r.clippedToRecordStart ? "(기록 시작)" : ""} ~ ${mdKo(r.actual.to)} · ${r.tradingDays}거래일`;
}

/** 수익률에서 건너뛴 기간 (검토 반영 10차 — 확인이 필요한 종목·해) */
const SKIP_WHAT = "확인이 필요한 종목이 든";

/** 건너뛴 날 한 줄 '… 2일(10/7 · 10/8)은 수익률·기간 손익에서 뺐어요.' (날짜는 셋까지 + '등') — 없으면 null */
function skippedText(r: JournalReturns): string | null {
  const d = r.uncertainSkipped ?? [];
  if (!d.length) return null;
  return `${SKIP_WHAT} ${d.length}일(${d.slice(0, 3).map(mdShort).join(" · ")}${d.length > 3 ? " 등" : ""})은 수익률·기간 손익에서 뺐어요.`;
}

export function returnsLines(r: JournalReturns): { pnl: string; pnlSign: number; values: string; flows: string | null; clipped: string | null; skipped: string | null } {
  const cur: Cur = r.currency ?? "KRW";
  const pnl = money(r.pnl ?? null, cur, true);
  return {
    pnl: `기간 손익 ${pnl}`,
    pnlSign: shownSign(r.pnl ?? null, pnl),
    values: `시작 평가금액 ${money(r.startValue ?? null, cur)} → 끝 ${money(r.endValue ?? null, cur)}`,
    flows: (r.buys ?? 0) > 0 || (r.sells ?? 0) > 0 ? `그 사이 매수 ${money(r.buys ?? 0, cur)} · 매도 ${money(r.sells ?? 0, cur)} (수익률 계산에서 뺐어요)` : null,
    clipped: r.clippedToRecordStart ? "고른 기간보다 기록이 짧아 기록 시작일부터 계산했어요." : null,
    skipped: skippedText(r),
  };
}

/** '계산 방법' 펼침 (고정 문장 + 있을 때만) */
export function returnsMethod(r: JournalReturns): string[] {
  const out = [
    "시간가중 수익률: 날마다의 수익률을 곱해 이은 값이에요. 중간에 사고판 금액은 빼고 계산해서, 돈을 더 넣거나 뺀 것에 흔들리지 않아요.",
    "기간 손익: 끝 평가금액 − 시작 평가금액 − 매수 금액 + 매도 금액이에요.",
    "평가금액은 매일 장 마감 뒤 찍은 계좌 기록의 수량 × 정규장 종가예요.",
  ];
  const fb = r.priceBasis?.fallbackCodes.length ?? 0;
  if (fb) out.push(`종가가 없는 ${fb}종목은 그때 현재가로 계산했어요.`);
  out.push("현금 입출금과 배당은 넣지 않았어요. 주식 평가금액만의 수익률이에요.");
  if (r.gaps?.length) out.push(`빠진 날 ${r.gaps.length}일은 앞뒤를 이어 계산했어요.`);
  if (r.doubtedSkipped?.length) out.push(`믿기 어려운 기록 ${r.doubtedSkipped.length}일은 빼고 계산했어요.`);
  if (r.uncertainSkipped?.length)
    out.push("그해 주문 내역으로 설명되지 않는 변화(분할·병합·무상증자·주식배당·입고·출고·분사·큰 주가 변화 등)가 있던 종목은 확인이 필요한 종목이라, 그해 그 종목이 든 기간을 수익률·기간 손익에서 뺐어요. 그 기간의 값을 짐작해 넣지 않아요.");
  if (r.market === "ALL") out.push("미국 종목은 그날 기록의 환율로 원화로 바꿨어요. 환율이 움직인 몫도 들어 있어요.");
  if (r.market === "US") out.push("달러 기준이에요. 환율은 넣지 않았어요.");
  out.push("토스 앱 수익분석의 수익률과 계산 방법이 달라 다를 수 있어요.");
  return out;
}

/** 요약 묶음 화면 읽기: 기간·수익률·기간 손익 + 화면에 보이는 시작→끝 평가금액·그 사이 사고판 금액·기록 시작일부터 계산한 까닭 */
export function returnsSpeech(r: JournalReturns): string {
  if (!r.ready || !r.actual) return returnsNotReady(r);
  const cur: Cur = r.currency ?? "KRW";
  const pnl = money(r.pnl ?? null, cur);
  const flows = (r.buys ?? 0) > 0 || (r.sells ?? 0) > 0;
  return sentence([
    `${mdKo(r.actual.from)}부터 ${mdKo(r.actual.to)}까지 ${r.tradingDays}거래일`,
    `수익률 시간가중 ${speakRate(r.twr ?? null) ?? "없음"}`,
    `기간 손익 ${speakProfit(pnl, shownSign(r.pnl ?? null, pnl)) ?? "없음"}`,
    r.startValue !== null && r.startValue !== undefined && r.endValue !== null && r.endValue !== undefined
      ? `시작 평가금액 ${speakAmount(money(r.startValue, cur))}에서 끝 ${speakAmount(money(r.endValue, cur))}`
      : null,
    flows ? `그 사이 매수 ${speakAmount(money(r.buys ?? 0, cur))}, 매도 ${speakAmount(money(r.sells ?? 0, cur))}, 수익률 계산에서 뺐어요` : null,
    r.clippedToRecordStart ? "고른 기간보다 기록이 짧아 기록 시작일부터 계산했어요" : null,
    skippedText(r),
  ]);
}

/** 누적 수익률 선 그림 제목·양 끝 날짜 (점이 2개 이상일 때) */
export function returnLineLabels(series: { date: string; cum: number }[]): { title: string; from: string; to: string } | null {
  if (series.length < 2) return null;
  return { title: "날짜별 누적 수익률", from: mdKo(series[0]!.date), to: mdKo(series[series.length - 1]!.date) };
}

// ── 양도세 추정 ───────────────────────────────────────────────────────

export const TAX = {
  notice: "참고용 추정이에요. 세금 신고·납부 금액이 아니며, 실제 세금은 홈택스나 세무 전문가에게 확인해 주세요.",
  notAdvice: "이 화면은 세무 조언이 아니에요.",
  period: "결제일 기준 1월 1일 ~ 12월 31일",
  underDeduction: "양도차익 합계가 기본공제 250만 원 이하예요.",
  perSell: "매도별 계산 보기",
  rulesTitle: "계산 기준",
  krTitle: "국내 주식",
  krAssumption: "대주주가 아닌 경우 국내 상장주식을 팔아 생긴 차익에는 양도세가 없다고 보고 계산하지 않았어요.",
  krNoTax: "토스 주문 내역에 증권거래세 금액이 없어 보여 드리지 못해요.",
  unexplainedTitle: "확인이 필요한 매도",
  unexplainedNote: "그해 주문 내역으로 설명되지 않는 변화가 있던 종목의 매도라 위 합계에 넣지 않았어요. 실제 양도차익은 토스증권 앱에서 확인해 주세요.",
  rules: [
    "취득가액: 이동평균법(토스증권이 쓰는 방식)으로 계산했어요. 증권사마다 선입선출법을 쓰기도 해 금액이 다를 수 있어요.",
    "환율: 매수·매도 결제일의 기준환율(서울외국환중개 매매기준율)이에요. 받지 못한 날은 하나은행 고시 환율로 대신하고 따로 표시해요.",
    "결제일: 미국 거래일 다음 영업일(현지)에 결제되는 규칙으로 국내 결제일을 추정했어요. 결제일이 12월 31일을 넘기면 다음 해 몫으로 세요.",
    "비용: 토스 주문 내역에 수수료·세금이 있으면 뺐고, 없으면 빼지 않았어요.",
    "대상: 이 앱이 저장한 토스증권 계좌의 해외주식 매매만이에요. 다른 증권사·다른 계좌의 매매, 배당, 환전 손익은 넣지 않았어요.",
    "세율 22%와 기본공제 250만 원은 2026년 세법 기준으로 넣은 값이에요. 세법이 바뀌면 달라질 수 있어요. 원 단위 끝수는 버렸어요.",
    "확인 필요: 그해 주문 내역으로 설명되지 않는 변화(분할·병합·무상증자·입고·출고·분사·큰 주가 변화 등)가 있던 종목은 그해 매도를 모두 합계에서 빼고 '확인이 필요한 매도'로 따로 보여 드려요.",
  ],
} as const;

/** 받는 중이면 1분마다 다시 묻되 5번까지 (끝나지 않는 '받는 중' 막기 — 3-44 교훈) */
export const TAX_RETRY_MS = 60_000;
export const TAX_RETRY_MAX = 5;
export function taxRefetch(data: JournalTax | undefined, tries: number): number | false {
  return data?.enabled && (data.fxPending ?? 0) > 0 && tries < TAX_RETRY_MAX ? TAX_RETRY_MS : false;
}

/**
 * 다시 묻기 횟수를 셀 기준 (쿼리의 받은 횟수 dataUpdateCount): 받는 중이 아니면 null, 받는 중이 막 시작됐으면 그때의 받은 횟수.
 * 다시 물은 횟수 = 지금 받은 횟수 − 기준. 그 전에 쌓인 받은 횟수(앱을 다시 열어 새로 받은 것 등)는 세지 않는다
 */
export function pendingStart(prev: number | null, data: JournalTax | undefined, count: number): number | null {
  if (!data?.enabled || (data.fxPending ?? 0) <= 0) return null;
  return prev === null || prev > count ? count : prev;
}

export interface TaxView {
  title: string;
  /** speech: 화면 읽기 문장 (금액·기호를 읽는 말로) */
  rows: { label: string; value: string; sign?: number; strong?: boolean; speech: string }[];
  sub: string;
  zeroNote: string | null;
  pending: string | null;
  excluded: { title: string; lines: string[] } | null;
  /** 합계에 들어 있는, 순서 모름으로 추정한 매도 (includeUncertain 일 때만) — 따로 알린다 */
  estimated: { title: string; lines: string[] } | null;
  /** 확인이 필요한 매도 (숫자 없이 매도마다 한 줄 — 늘 합계에서 뺌) */
  unexplained: { title: string; lines: string[]; note: string } | null;
}

/** 확인이 필요한 매도 한 줄 '9/28 SOXL 4,000주 · 판매 금액 $100,000.00 · 그해 있었던 일 · 이름표' */
function unexplainedLine(x: JournalTaxUnexplained): string {
  return [`${mdShort(x.tradeDate)} ${x.name} ${qtyText(x.quantity)}`, `판매 금액 ${money(x.proceedsUsd, "USD")}`, x.change ?? x.reason, x.guess].filter(Boolean).join(" · ");
}

export function taxView(d: JournalTax, retriesDone: boolean): TaxView | null {
  if (!d.enabled || !d.totals || !d.year) return null;
  const t = d.totals;
  const won = (v: number, sign = false) => money(v, "KRW", sign);
  const netText = `${won(t.net, true)}${t.net < 0 ? " (손실)" : ""}`;
  const deduction = d.rules?.deduction ?? 2_500_000;
  // 평균 구매가를 추정한 매도가 합계에 들어 있으면 합계 줄·아래 줄에 '추정 포함' (예전 서버는 칸이 없어 0)
  const estN = d.estimatedIncluded ?? 0;
  const rows: TaxView["rows"] = [
    {
      label: `양도차익 합계 (이익 − 손실${estN ? ", 추정 포함" : ""})`,
      value: netText,
      sign: shownSign(t.net, won(t.net)),
      speech: `양도차익 합계, 이익에서 손실을 뺀 금액${estN ? ", 추정 포함" : ""}, ${profitSpeech(t.net, "KRW")}`,
    },
    { label: "기본공제", value: won(-deduction, true), speech: `기본공제 ${speakAmount(won(deduction))} 빼기` },
    { label: "과세 대상 금액", value: won(t.base), speech: `과세 대상 금액 ${speakAmount(won(t.base))}` },
    { label: "세율", value: "22% (양도소득세 20% + 지방소득세 2%)", speech: "세율 22퍼센트, 양도소득세 20퍼센트와 지방소득세 2퍼센트" },
    { label: "예상 세액 (추정)", value: won(t.tax), strong: true, speech: `예상 세액 추정 ${speakAmount(won(t.tax))}` },
  ];
  const pendingN = d.fxPending ?? 0;
  // 다시 묻기를 다 썼는데도 받는 중이면 빠진 매도로 보여 준다 (끝나지 않는 '받는 중' 막기)
  const pending = pendingN > 0 && !retriesDone ? `환율을 받는 중이에요 (${pendingN}건). 잠시 뒤 다시 계산해요.` : null;
  const ex = [...(d.excluded ?? [])];
  const exCount = ex.reduce((s, x) => s + x.count, 0) + (pendingN > 0 && retriesDone ? pendingN : 0);
  const lines = ex.map((x) => `${x.name} ${x.count}건 · ${x.reason}`);
  if (pendingN > 0 && retriesDone) lines.push(`${pendingN}건 · 결제일 환율을 아직 받지 못했어요`);
  // 같은 날 사고판 순서를 몰라 합계에서 뺀 매도 (까닭 줄은 excluded 에 서버가 넣었다): 그 추정 양도차익을 참고로 한 줄
  const unN = d.uncertainExcluded ?? 0;
  if (unN > 0 && d.uncertainGainKrw !== null && d.uncertainGainKrw !== undefined) lines.push(`사고판 순서를 몰라 뺀 매도 ${unN}건의 추정 양도차익은 ${won(d.uncertainGainKrw, true)}이에요.`);
  const unexplained = d.unexplainedSells ?? [];
  return {
    title: `해외주식 양도세 추정 · ${d.year}년`,
    rows,
    sub: `이익 ${won(t.gains, true)} · 손실 ${won(t.losses)} · 매도 ${t.sells}건${estN ? ` (추정 포함 ${estN}건)` : ""}`,
    zeroNote: t.net > 0 && t.base === 0 ? TAX.underDeduction : null,
    pending,
    excluded: exCount > 0 ? { title: `계산에서 뺀 매도 ${exCount}건이 있어 실제와 다를 수 있어요.`, lines } : null,
    estimated: estN > 0 ? { title: `평균 구매가를 추정한 매도 ${estN}건이 합계에 들어 있어요.`, lines: (d.estimatedSells ?? []).map((x) => `${x.name} ${x.count}건 · ${x.reason}`) } : null,
    unexplained: unexplained.length ? { title: TAX.unexplainedTitle, lines: unexplained.map(unexplainedLine), note: TAX.unexplainedNote } : null,
  };
}

/** 매도별 계산 두 줄. outside: 합계에서 뺀 매도 (순서를 모름) — 첫 줄 끝에 '합계에서 뺌' */
export function taxItemLines(x: JournalTaxItem, outside = false): [string, string] {
  const fx = x.fxSell;
  const src = !fx ? "" : fx.provisional ? "(결제일 전이라 최근 고시)" : fx.source === "naver-hana" ? "(하나은행 고시로 대신)" : fx.date !== x.settleDate ? `(${mdShort(fx.date)} 고시)` : "";
  const rate = fx ? `환율 ${fx.rate.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}원${src}` : "환율 없음";
  const first = `${mdShort(x.tradeDate)} ${x.name} ${qtyText(x.quantity)} · 결제일 ${mdShort(x.settleDate)}${x.settleSource === "estimated" ? "(추정)" : ""} · ${rate}${outside ? " · 합계에서 뺌" : x.estimate ? " · 추정 포함" : ""}`;
  const second = `양도가액 ${money(x.proceedsKrw, "KRW")} − 취득가액 ${money(x.costKrw, "KRW")}${x.costsKrw !== null ? ` − 비용 ${money(x.costsKrw, "KRW")}` : ""} = ${money(x.gainKrw, "KRW", true)}`;
  return [first, second];
}

/** 폴드 가로 오른쪽 칸: 매도별 계산에 넣은 매도가 없을 때 */
export function perSellNone(year: number): string {
  return `${year}년 계산에 넣은 해외주식 매도가 없어요.`;
}

export function krTaxLine(d: JournalTax): string {
  const s = d.kr?.securitiesTax;
  if (!s || s.amount === null) return TAX.krNoTax;
  return `증권거래세(매도할 때 내는 세금): ${d.year}년 ${money(-s.amount, "KRW", true)} (토스 주문 내역)`;
}

// ── 입구 ─────────────────────────────────────────────────────────────

/** 매매일지 화면 주소 (기록 탭 + 종목 거르기) */
export function journalHref(opts: { tab?: "list" | "returns" | "tax"; code?: string } = {}): string {
  const p: string[] = [];
  if (opts.tab && opts.tab !== "list") p.push(`tab=${opts.tab}`);
  if (opts.code) p.push(`code=${encodeURIComponent(opts.code)}`);
  return `/journal${p.length ? `?${p.join("&")}` : ""}`;
}
