import type { AccountBriefing, AccountData, AccountQtyChange, AccountSinceLast, BriefingSession } from "@/api/types";
import { sentence, speakAmount, speakClock } from "@/lib/a11y";
import { formatPct, formatWon, SESSION_LABEL, shownSign } from "@/lib/format";
import { mdw } from "@/lib/marketSummary";

/**
 * 브리핑 3차 3 — 지난 브리핑과 비교 (플래그 accountSinceLast) 화면용 순수 함수 (React Native 를 불러오지 않음 → 테스트).
 * 숫자는 서버가 계좌 브리핑을 만들 때 계산해 저장한 값 그대로 쓴다 (services/accountSinceLast.compareSinceLast).
 * 사실만: 늘어남·줄어듦과 기준 시각. '어제'라고 쓰지 않고 날짜로 (나중에 봐도 맞는 말). 판단·권유하는 말 없음
 */

/** 수량이 바뀐 종목 줄을 몇 개까지 보이는지 (넘으면 '외 N종목') */
export const QTY_LINES_MAX = 8;
// 팔면 그 종목의 평가이익도 평가손익에서 빠지고, 수량은 사고판 것 말고도(분할·잔고 수정·첫 등록·동기화) 바뀐다 → 두 금액 모두·'사고판 것 등'
export const SINCE_NOTE_TRADED = "수량이 바뀐 종목이 있어, 총 평가금액·평가손익 변화에는 수량 변화(사고판 것 등)가 함께 들어 있습니다.";
export const SINCE_NOTE_FIRST = "종목별 변화는 다음 브리핑부터 보입니다 (이전 브리핑에 종목별 값이 없음).";
export const SINCE_NOTE_BASIS = "두 브리핑에 저장된 숫자로 비교합니다 · 미국 종목은 그때의 환율로 원화 환산.";
export const QTY_HEAD = "수량이 바뀐 종목";
export const QTY_NONE = "수량이 바뀐 종목 없음";
export const WEIGHT_HEAD = "비중 변화가 큰 종목";
export const WEIGHT_NONE = "비중이 0.5%p 이상 바뀐 종목 없음";

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** 순간(ISO) → 서울 날짜·시각 { date: "2026-09-25", hm: "08:38" }. 읽지 못하면 null */
function kst(iso: string): { date: string; hm: string } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = new Date(t + 9 * 3_600_000).toISOString();
  return { date: s.slice(0, 10), hm: s.slice(11, 16) };
}

/** 화면: "9/25(금) 08:38" (시각을 모르면 날짜만) */
function stamp(asOf: string, date: string): string {
  const k = kst(asOf);
  return k ? `${mdw(k.date)} ${k.hm}` : mdw(date);
}

/** 읽는 말: "9월 25일 금요일" */
export function speakDay(date: string): string {
  return `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일 ${WD[weekday(date)]}요일`;
}

/** 읽는 말: "9월 25일 금요일 8시 38분" */
function speakStamp(asOf: string, date: string): string {
  const k = kst(asOf);
  return k ? `${speakDay(k.date)} ${speakClock(k.hm)}` : speakDay(date);
}

/** 수량 "10주" · "1.25주" (소수는 넷째 자리까지, 잔고 줄과 같은 표기) */
export function qtyText(n: number): string {
  return `${Number.isInteger(n) ? n.toLocaleString("ko-KR") : n.toLocaleString("ko-KR", { maximumFractionDigits: 4 })}주`;
}

/** 비중 "18.2%" (늘 소수 한 자리) */
const pctText = (v: number) => `${v.toFixed(1)}%`;
/** 비중 변화 "+2.8%p" · "-1.1%p" */
const ppText = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(1)}%p`;

/** 카드 제목: '지난 오전 브리핑과 비교' */
export function sinceTitle(session: BriefingSession): string {
  return `지난 ${SESSION_LABEL[session]} 브리핑과 비교`;
}

/** 비교할 브리핑이 없을 때 (처음·10일 넘음) 한 줄 */
export function sinceNone(session: BriefingSession): string {
  return `비교할 지난 ${SESSION_LABEL[session]} 브리핑이 없습니다.`;
}

/** 금액 변화를 말로: '544,322원 늘어남' · '1,000원 줄어듦' · '변화 없음' (보이는 값 기준) */
function speakChange(amount: string, sign: number): string {
  return sign === 0 ? "변화 없음" : `${speakAmount(amount)} ${sign > 0 ? "늘어남" : "줄어듦"}`;
}

/** 말 끝에 '으로/로': 받침이 없거나 ㄹ 받침이면 '로' ('원으로' · '이익으로' · '손실로') */
function withRo(word: string): string {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  const jong = c >= 0 && c < 11172 ? c % 28 : 0;
  return `${word}${jong === 0 || jong === 8 ? "로" : "으로"}`;
}

/** 평가손익 값을 말로: '1,234,000원 이익' · '500,000원 손실' · '0원' (보이는 부호 기준) */
function speakPnl(v: number): string {
  const text = formatWon(v, { sign: true });
  const s = shownSign(v, text);
  return s === 0 ? speakAmount(text) : `${speakAmount(text)} ${s > 0 ? "이익" : "손실"}`;
}

/** 두 값 → '12,345,678원에서 11,926,340원으로' (화면의 '지난 → 이번'을 화면 읽기에도) */
const speakFromTo = (from: string, to: string) => `${from}에서 ${withRo(to)}`;

/** 한쪽 브리핑 합계에서만 빠진 종목 한 조각: '테슬라(이번 브리핑에서 시세를 받지 못함)' */
function oneSideText(o: NonNullable<AccountSinceLast["oneSide"]>[number]): string {
  return `${o.name}(${o.side === "now" ? "이번" : "지난"} 브리핑에서 ${o.why === "fx" ? "환율을" : "시세를"} 받지 못함)`;
}

/** 금액·비중을 두 브리핑 모두 값이 있는 종목끼리 비교했을 때 (scope common) */
export function sinceNoteCommon(names: string[]): string {
  return `한쪽 브리핑 합계에서만 빠진 종목이 있어, 총 평가금액·평가손익·비중은 두 브리핑 모두 값이 있는 종목끼리 비교했습니다: ${names.join(", ")}.`;
}

/** 종목별 값이 없어 그 종목을 빼지 못했을 때 (scope mixed) */
export function sinceNoteMixed(names: string[]): string {
  return `두 브리핑의 합계에서 뺀 종목이 다르지만, 지난 브리핑에 종목별 값이 없어 총 평가금액·평가손익 변화에서 그 종목을 빼지 못했습니다: ${names.join(", ")}.`;
}

/** 두 브리핑 모두(또는 그 종목이 있는 한쪽에서만) 합계에서 뺀 종목 — 금액·비중 어느 쪽에도 들어 있지 않음 */
export function sinceNoteExcluded(names: string[]): string {
  return `시세나 환율을 받지 못해 합계에서 뺀 종목(${names.join(", ")})은 금액·비중 비교에 들어 있지 않습니다.`;
}

export interface SinceQtyLine {
  key: string;
  /** '새 종목' · '없어진 종목' · '수량 늘어남' · '수량 줄어듦' */
  label: string;
  /** '삼성전자 10주' · '테슬라 (전에 3주)' · '엔비디아 5주 → 8주' */
  body: string;
  /** body 를 줄바꿈 묶음으로 ('엔비디아' · '5주' · '→ 8주') — 좁으면 묶음째 다음 줄로 */
  parts: string[];
  speech: string;
}

export interface SinceWeightLine {
  key: string;
  /** '엔비디아 18.2% → 21.0%' */
  body: string;
  /** body 를 줄바꿈 묶음으로 ('엔비디아' · '18.2%' · '→ 21.0%') */
  parts: string[];
  /** '(+2.8%p)' */
  change: string;
  sign: number;
}

export interface SinceLastView {
  title: string;
  /** '9/25(금) 08:38 → 9/28(월) 08:38' */
  range: string;
  value: { amount: string; rate: string | null; sign: number; rateSign: number; fromTo: string; fromToParts: string[] };
  profit: { amount: string; sign: number; fromTo: string; fromToParts: string[] };
  /** 수량이 바뀐 종목 (지난 브리핑에 종목별 값이 없으면 null, 없으면 빈 줄 목록) */
  qty: { lines: SinceQtyLine[]; more: number; count: number } | null;
  /** 비중 변화가 큰 종목 (지난 브리핑에 종목별 값이 없으면 null) */
  weights: SinceWeightLine[] | null;
  /** 카드 아래 작은 글 (사고판 금액 · 첫날 · 합계에서 뺀 종목 · 비교 기준) */
  notes: string[];
  /** 화면 읽기: 제목·기간·총 평가·평가손익 한 문장 */
  headSpeech: string;
  /** 화면 읽기: 수량 묶음 한 문장 (없으면 null) */
  qtySpeech: string | null;
  /** 화면 읽기: 비중 묶음 한 문장 (없으면 null) */
  weightSpeech: string | null;
}

/** '총 평가금액 -419,338원 (-3.40%)' 의 금액·변화율 부분을 한 글로 (테스트·화면 읽기가 같은 글을 본다) */
export function valueChangeText(v: SinceLastView["value"]): string {
  return v.rate ? `${v.amount} (${v.rate})` : v.amount;
}

function qtyLines(p: NonNullable<AccountSinceLast["positions"]>): SinceQtyLine[] {
  const line = (kind: string, label: string, c: AccountQtyChange, parts: string[], spoken: string): SinceQtyLine => ({ key: `${kind}-${c.code}`, label, body: parts.join(" "), parts, speech: `${label} ${c.name} ${spoken}` });
  const moved = (c: AccountQtyChange) => [c.name, qtyText(c.from), `→ ${qtyText(c.to)}`];
  return [
    ...p.added.map((c) => line("a", "새 종목", c, [c.name, qtyText(c.to)], qtyText(c.to))),
    ...p.removed.map((c) => line("r", "없어진 종목", c, [c.name, `(전에 ${qtyText(c.from)})`], `전에 ${qtyText(c.from)}`)),
    ...p.increased.map((c) => line("i", "수량 늘어남", c, moved(c), `${qtyText(c.from)}에서 ${qtyText(c.to)}`)),
    ...p.decreased.map((c) => line("d", "수량 줄어듦", c, moved(c), `${qtyText(c.from)}에서 ${qtyText(c.to)}`)),
  ];
}

/** '12,345,678원 → 12,890,000원' 을 ['12,345,678원', '→ 12,890,000원'] 으로 */
const fromTo = (from: string, to: string) => [from, `→ ${to}`];

const toText = (parts: string[]) => ({ fromTo: parts.join(" "), fromToParts: parts });

/** 계좌 상세 '지난 오전 브리핑과 비교' 카드에 그릴 글과 읽는 말 */
export function sinceLastView(s: AccountSinceLast, now: Pick<AccountData, "session" | "date" | "asOf">): SinceLastView {
  const amount = formatWon(s.value.change, { sign: true });
  const sign = shownSign(s.value.change, amount);
  const rate = s.value.rate !== null && sign !== 0 ? formatPct(s.value.rate) : null;
  const profitAmount = formatWon(s.profit.change, { sign: true });
  const profitSign = shownSign(s.profit.change, profitAmount);
  const all = s.positions ? qtyLines(s.positions) : null;
  const qty = all ? { lines: all.slice(0, QTY_LINES_MAX), more: Math.max(0, all.length - QTY_LINES_MAX), count: all.length } : null;
  const weights = s.weights
    ? s.weights.map((w) => {
        const parts = [w.name, pctText(w.from), `→ ${pctText(w.to)}`];
        return { key: w.code, body: parts.join(" "), parts, change: `(${ppText(w.change)})`, sign: Math.sign(w.change) };
      })
    : null;
  // 한쪽 브리핑 합계에서만 빠진 종목 (서버가 금액·비중 비교에서 양쪽 모두 뺐거나 — common — 종목별 값이 없어 빼지 못함 — mixed)
  const oneSide = s.scope === "common" || s.scope === "mixed" ? (s.oneSide ?? []) : [];
  const oneSideCodes = new Set(oneSide.map((o) => o.code));
  // 그 밖에 합계에서 뺀 종목 (이번·지난, 같은 종목은 한 번): 두 브리핑 모두 뺐거나 그 종목이 한쪽 브리핑에만 있음 → 금액·비중 어느 쪽에도 없음
  const seen = new Set<string>();
  const excluded = [...s.excludedNow, ...s.excludedPrev].filter((e) => !oneSideCodes.has(e.code) && !seen.has(e.code) && !!seen.add(e.code)).map((e) => e.name);
  const notes = [
    qty && qty.count > 0 ? SINCE_NOTE_TRADED : null,
    s.positions === null ? SINCE_NOTE_FIRST : null,
    oneSide.length ? (s.scope === "mixed" ? sinceNoteMixed : sinceNoteCommon)(oneSide.map(oneSideText)) : null,
    excluded.length ? sinceNoteExcluded(excluded) : null,
    SINCE_NOTE_BASIS,
  ].filter((x): x is string => x !== null);
  const rateWord = rate ? `${Math.abs(s.value.rate!).toFixed(2)}퍼센트` : null;
  const valueFrom = formatWon(s.value.from);
  const valueTo = formatWon(s.value.to);
  return {
    title: sinceTitle(now.session),
    range: `${stamp(s.prev.asOf, s.prev.date)} → ${stamp(now.asOf, now.date)}`,
    value: { amount, rate, sign, rateSign: rate ? shownSign(s.value.rate, rate) : 0, ...toText(fromTo(valueFrom, valueTo)) },
    profit: { amount: profitAmount, sign: profitSign, ...toText(fromTo(formatWon(s.profit.from, { sign: true }), formatWon(s.profit.to, { sign: true }))) },
    qty,
    weights,
    notes,
    // 보이는 '지난 → 이번' 두 값도 읽는다 (묶음 하나로 읽혀 안의 글에 따로 갈 수 없으므로)
    headSpeech: sentence([
      sinceTitle(now.session),
      `${speakStamp(s.prev.asOf, s.prev.date)}부터 ${speakStamp(now.asOf, now.date)}까지`,
      `총 평가금액 ${speakFromTo(speakAmount(valueFrom), speakAmount(valueTo))} ${speakChange(amount, sign)}`,
      rateWord,
      `평가손익 ${speakFromTo(speakPnl(s.profit.from), speakPnl(s.profit.to))} ${speakChange(profitAmount, profitSign)}`,
    ]),
    qtySpeech: qty ? (qty.count ? sentence([`${QTY_HEAD} ${qty.count}개`, ...all!.map((l) => l.speech)]) : QTY_NONE) : null,
    weightSpeech: weights
      ? weights.length
        ? sentence([WEIGHT_HEAD, ...s.weights!.map((w) => `${w.name} ${w.from.toFixed(1)}퍼센트에서 ${w.to.toFixed(1)}퍼센트로 ${Math.abs(w.change).toFixed(1)}퍼센트포인트 ${w.change > 0 ? "늘어남" : "줄어듦"}`)])
        : "비중이 0.5퍼센트포인트 이상 바뀐 종목 없음"
      : null,
  };
}

export interface SinceLine {
  /** '9/25(금) 오전보다 총 평가' */
  head: string;
  /** '+544,322원' */
  amount: string;
  sign: number;
  /** '1종목 빼고 비교' — 한쪽 브리핑 합계에서만 빠져 금액 비교에서 뺀 종목이 있을 때 (없으면 null) */
  left: string | null;
  /** '수량 바뀐 종목 2' (없으면 null) */
  qty: string | null;
  /** 보이는 한 줄 전체 */
  text: string;
  /** 화면 읽기 조각 */
  speech: string;
}

/**
 * 브리핑 탭 계좌 카드·줄의 한 줄 (headline.since — 비교가 저장된 브리핑만): '9/25(금) 오전보다 총 평가 +544,322원 · 수량 바뀐 종목 2'.
 * 한쪽 브리핑 합계에서만 빠진 종목을 빼고 비교했으면 '· 1종목 빼고 비교'를 붙인다 (자세한 이유는 상세 카드).
 * '어제'가 아니라 날짜로. 실패한 브리핑·비교가 없는 브리핑(금액을 맞추지 못한 브리핑 포함 — 서버가 칸을 싣지 않음)은 null
 */
export function sinceLine(b: Pick<AccountBriefing, "status" | "headline">): SinceLine | null {
  const s = b.status === "ok" ? b.headline?.since : undefined;
  if (!s) return null;
  const head = `${mdw(s.date)} ${SESSION_LABEL[s.session]}보다 총 평가`;
  const amount = formatWon(s.change, { sign: true });
  const sign = shownSign(s.change, amount);
  const left = s.leftOut ? `${s.leftOut}종목 빼고 비교` : null;
  const qty = s.qtyChanged ? `수량 바뀐 종목 ${s.qtyChanged}` : null;
  return {
    head,
    amount,
    sign,
    left,
    qty,
    text: [`${head} ${amount}`, left, qty].filter((x): x is string => x !== null).join(" · "),
    speech: sentence([
      `${speakDay(s.date)} ${SESSION_LABEL[s.session]} 브리핑보다 총 평가금액 ${speakChange(amount, sign)}`,
      s.leftOut ? `한쪽 브리핑 합계에서만 빠진 ${s.leftOut}종목은 빼고 비교` : null,
      qty ? `수량이 바뀐 종목 ${s.qtyChanged}개` : null,
    ]),
  };
}
