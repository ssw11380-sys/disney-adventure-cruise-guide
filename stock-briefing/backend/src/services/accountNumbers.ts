import { formatRate, formatWon } from "../notifications/digest.js";
import type { MarketStatus } from "../providers/market/calendar.js";
import type { MarketIndex } from "../providers/market/indices.js";
import { seoulDate } from "../lib/time.js";
import { isUsTradingDate, marketContext } from "./marketContext.js";
import type { Evaluation } from "./stockService.js";

/**
 * 계좌 한 장 브리핑(3-31)의 숫자와 문장. 숫자는 모두 여기서 코드로 계산하고, 모델은 이 숫자를 옮겨 적기만 한다.
 * DB·네트워크를 모르는 순수 함수라 단위 테스트로 묶는다.
 *
 * 기준은 앱 잔고 화면의 계좌 합계(app/src/lib/portfolio.ts summarize, 설정 기본값 afterCost=true)와 같다:
 *  - 총 평가금액: 토스 비용 비율이 있으면 수수료·세금 예상액을 뺀 평가금액. 미국 종목은 시세의 적용 환율(fxRate, 토스 표시 환율)로 원화 환산
 *  - 매입금액: 국내는 매입금액, 미국은 매수 당시 환율의 원화 매입금액(장부가 없으면 현재 환율 환산)
 *  - 당일 손익: 전일 대비 × 수량. 미국 종목은 같은 적용 환율로 환산 — 환율이 움직인 몫은 들어가지 않으므로 '환율 효과'로 따로 보여 준다
 *  - 환율을 모르는 미국 종목은 원화 합계에서 빼고 excluded 에 남긴다 (앱은 이때 원화 합계 대신 통화별로 보여 준다)
 */

export type AccountSession = "morning" | "afternoon";

/** 잔고 한 줄 (StockService.listWithQuotes 의 항목과 같은 모양, 필요한 칸만) */
export interface AccountHolding {
  code: string;
  name: string;
  quantity: number | null;
  avgPrice: number | null;
  quote: {
    currency?: "KRW" | "USD";
    price: number;
    change: number;
    changeRate: number;
    fxRate?: number | null;
    priceKrw?: number | null;
    stale?: boolean;
  } | null;
  evaluation: Evaluation | null;
}

/** 당일 손익 기여 한 줄 */
export interface AccountRow {
  code: string;
  name: string;
  currency: "KRW" | "USD";
  /** 당일 손익 기여(원, 정수). 줄마다 반올림한 값의 합이 당일 손익과 정확히 같게 나눈다 */
  amount: number;
  /** 전일 대비 등락률(%) */
  changeRate: number | null;
  /** 원화 평가금액(원, 앱 기준) */
  value: number;
}

export interface MarketBucket {
  count: number;
  /** 원화 평가금액 */
  value: number;
  /** 당일 손익(원). 국내 + 미국 = 계좌 당일 손익 */
  day: number;
  /** 전일 평가금액 대비 당일 손익(%) */
  dayRate: number | null;
}

export interface AccountFx {
  /** computed = 나눠 계산함, none = 미국 종목 없음, unavailable = 원/달러 변동을 받지 못함 */
  status: "computed" | "none" | "unavailable";
  reason: string | null;
  /** 원/달러 (지수 띠와 같은 출처: 네이버, 하나은행 매매기준율) */
  usdKrw: { value: number; change: number; changeRate: number; stale: boolean } | null;
  /** 원화 환산에 쓴 적용 환율 (앱 잔고 화면과 같은 토스 표시 환율) */
  appliedRate: number | null;
  /** 미국 보유분 원화 평가(비용 차감 전)의 하루 변화 = 가격 효과 + 환율 효과 */
  usdHoldingsKrwChange: number | null;
  /** 가격 효과 = 달러 등락 × 수량 × 적용 환율 = 당일 손익의 미국 몫 */
  priceEffect: number | null;
  /** 환율 효과 = 전일 달러 평가액 × 원/달러 전일 대비 (당일 손익에는 들어가지 않음) */
  fxEffect: number | null;
}

export interface AccountTotals {
  afterCost: boolean;
  /** 합계에 넣은 보유 종목 수 */
  holdings: number;
  /** 그중 시세가 지연된(새로 받지 못한) 종목 수 */
  stale: number;
  totalValue: number;
  totalCost: number;
  totalProfit: number;
  totalProfitRate: number | null;
  dayPnl: number;
  dayRate: number | null;
  /** 당일 손익 기여가 큰 순 상위 (|기여| 순) */
  contributions: AccountRow[];
  /** 상위 밖 종목의 합. contributions 의 합 + others.amount = dayPnl (정확히) */
  others: { count: number; amount: number } | null;
  markets: { kr: MarketBucket | null; us: MarketBucket | null };
  /** 합계에서 뺀 보유 종목과 이유 */
  excluded: Array<{ code: string; name: string; reason: string }>;
  fx: AccountFx;
}

export interface AccountIndexRow {
  code: string;
  name: string;
  value: number;
  change: number;
  changeRate: number;
  open: boolean;
  stale: boolean;
}

export interface AccountDisclosure {
  code: string;
  name: string;
  title: string;
  filedAt: string;
  url: string | null;
}

export interface AccountSchedule {
  kr: { date: string; tradingDay: boolean; now: string; hours: string | null; nextOpen: string | null };
  /** date = 오늘(한국 시간 기준 다음 또는 진행 중) 미국 정규장의 뉴욕 날짜 */
  us: { date: string; tradingDay: boolean; now: string; hours: string | null };
  /** 종목 브리핑이 이미 받아 둔 최근 DART 공시 (새로 부르지 않음) */
  disclosures: AccountDisclosure[];
}

export interface AccountData extends AccountTotals {
  version: 1;
  session: AccountSession;
  date: string;
  /** 숫자를 계산한 시각 (한국 시간 ISO) */
  asOf: string;
  /** 숫자 기준 한 줄 (화면 아래 안내) */
  basis: string;
  indices: AccountIndexRow[];
  /** 받지 못한 지수 이름 */
  missingIndices: string[];
  schedule: AccountSchedule;
  /** 설명(detail)을 누가 썼는지: 모델(llm) 또는 숫자만으로 만든 기본 문장(template)과 그 이유 */
  narrative: { source: "llm" | "template"; reason: string | null };
}

/** 상위 몇 종목까지 따로 보여 주는지 (나머지는 '그 외 N종목') */
export const TOP_N = 5;
/** 지수·환율 영향에 쓰는 지수 (지수 띠와 같은 목록에서) */
export const ACCOUNT_INDEX_CODES = ["KOSPI", "KOSDAQ", "NASDAQ", "SPX"] as const;
export const BASIS =
  "총 평가금액은 수수료·세금 예상액을 뺀 값(앱 기본 설정), 당일 손익은 전일 대비 등락 × 수량이며 미국 종목은 적용 환율로 원화 환산(앱 잔고 화면과 같음). 환율 효과는 원/달러 전일 대비 변동으로 따로 계산해 당일 손익에 넣지 않음";
export const KR_HOURS = "정규장 09:00~15:30 · 넥스트레이드 08:00~20:00";

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const round2 = (x: number) => Math.round(x * 100) / 100;

/** 종목의 원화 환율: 시세의 적용 환율, 없으면 원화 환산가 ÷ 가격 (앱 portfolio.fxOf 와 같다) */
export function fxOf(q: NonNullable<AccountHolding["quote"]>): number | null {
  return q.fxRate ?? (q.priceKrw && q.price ? q.priceKrw / q.price : null);
}

/**
 * 실수 여러 개를 정수로 나눈다 (최대 나머지 방식). 결과의 합 = target, 각 값은 원래 값의 내림 또는 올림.
 * target 은 기본이 합의 반올림이고, 위 단계에서 나눈 값(원래 합의 내림 또는 올림)을 줄 수도 있다
 */
export function apportion(values: readonly number[], target = Math.round(sum(values))): number[] {
  const out = values.map((v) => Math.floor(v));
  let rest = target - sum(out);
  const byFrac = values.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  // 보통 rest 는 0..n. 부동소수 오차로 벗어나도 합은 target 에 맞춘다 (큰 조각부터 +1, 작은 조각부터 −1)
  for (let k = 0; rest > 0 && byFrac.length; k = (k + 1) % byFrac.length, rest--) out[byFrac[k]!.i]! += 1;
  for (let k = byFrac.length - 1; rest < 0 && byFrac.length; k = (k - 1 + byFrac.length) % byFrac.length, rest++) out[byFrac[k]!.i]! -= 1;
  return out;
}

interface RawRow {
  code: string;
  name: string;
  currency: "KRW" | "USD";
  fx: number;
  changeRate: number | null;
  stale: boolean;
  value: number;
  cost: number;
  day: number;
  prev: number;
  nowUsd: number;
  prevUsd: number;
}

function bucket(rows: RawRow[], day: number): MarketBucket | null {
  if (!rows.length) return null;
  const prev = sum(rows.map((r) => r.prev));
  return { count: rows.length, value: Math.round(sum(rows.map((r) => r.value))), day, dayRate: prev > 0 ? round2((sum(rows.map((r) => r.day)) / prev) * 100) : null };
}

/** 잔고 목록 → 계좌 합계·당일 손익 기여·환율 효과 */
export function computeAccount(list: readonly AccountHolding[], opts: { afterCost?: boolean; topN?: number; usdKrw?: MarketIndex | null } = {}): AccountTotals {
  const afterCost = opts.afterCost ?? true;
  const topN = opts.topN ?? TOP_N;
  const excluded: AccountTotals["excluded"] = [];
  const rows: RawRow[] = [];
  for (const s of list) {
    const q = s.quote;
    const ev = s.evaluation;
    // 앱 summarize 와 같이 평가(수량·평단)와 시세가 모두 있는 종목만 합계에 넣는다
    if (!q || !ev) {
      if ((s.quantity ?? 0) > 0 && s.avgPrice !== null) excluded.push({ code: s.code, name: s.name, reason: "시세를 받지 못해 합계에서 뺐습니다" });
      continue;
    }
    const currency = q.currency ?? "KRW";
    const fx = currency === "USD" ? fxOf(q) : 1;
    if (!fx) {
      excluded.push({ code: s.code, name: s.name, reason: "환율을 받지 못해 원화 합계에서 뺐습니다" });
      continue;
    }
    const qty = s.quantity ?? 0;
    const native = afterCost && ev.afterCost ? ev.afterCost.marketValue : ev.marketValue;
    if (!Number.isFinite(q.price) || !Number.isFinite(native)) {
      excluded.push({ code: s.code, name: s.name, reason: "시세를 받지 못해 합계에서 뺐습니다" });
      continue;
    }
    // 등락을 모르면(출처가 빈 값) 당일 손익 0 으로 본다 — 합계가 NaN 이 되지 않게
    const change = Number.isFinite(q.change) ? q.change : 0;
    rows.push({
      code: s.code,
      name: s.name,
      currency,
      fx,
      changeRate: Number.isFinite(q.changeRate) ? q.changeRate : null,
      stale: q.stale === true,
      value: native * fx,
      cost: currency === "USD" ? (ev.costBasisKrw ?? ev.costBasis * fx) : ev.costBasis,
      day: change * qty * fx,
      prev: (q.price - change) * qty * fx,
      nowUsd: currency === "USD" ? q.price * qty : 0,
      prevUsd: currency === "USD" ? (q.price - change) * qty : 0,
    });
  }

  const kr = rows.filter((r) => r.currency === "KRW");
  const us = rows.filter((r) => r.currency === "USD");
  const dayRaw = sum(rows.map((r) => r.day));
  const dayPnl = Math.round(dayRaw);
  // 계좌 → 국내·미국 → 종목 순으로 나눠, 어느 단계에서 더해도 위 단계 값과 정확히 같게 한다
  const [krDay, usDay] = apportion([sum(kr.map((r) => r.day)), sum(us.map((r) => r.day))], dayPnl) as [number, number];
  const amount = new Map<RawRow, number>();
  apportion(kr.map((r) => r.day), krDay).forEach((a, i) => amount.set(kr[i]!, a));
  apportion(us.map((r) => r.day), usDay).forEach((a, i) => amount.set(us[i]!, a));

  const ranked = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Math.abs(b.r.day) - Math.abs(a.r.day) || a.i - b.i)
    .map((x) => x.r);
  const top = ranked.slice(0, topN);
  const rest = ranked.slice(topN);

  const valueRaw = sum(rows.map((r) => r.value));
  const costRaw = sum(rows.map((r) => r.cost));
  const prevRaw = sum(rows.map((r) => r.prev));

  return {
    afterCost,
    holdings: rows.length,
    stale: rows.filter((r) => r.stale).length,
    totalValue: Math.round(valueRaw),
    totalCost: Math.round(costRaw),
    totalProfit: Math.round(valueRaw - costRaw),
    totalProfitRate: costRaw > 0 ? round2(((valueRaw - costRaw) / costRaw) * 100) : null,
    dayPnl,
    dayRate: prevRaw > 0 ? round2((dayRaw / prevRaw) * 100) : null,
    contributions: top.map((r) => ({ code: r.code, name: r.name, currency: r.currency, amount: amount.get(r)!, changeRate: r.changeRate, value: Math.round(r.value) })),
    others: rest.length ? { count: rest.length, amount: sum(rest.map((r) => amount.get(r)!)) } : null,
    markets: { kr: bucket(kr, krDay), us: bucket(us, usDay) },
    excluded,
    fx: fxImpact(us, usDay, opts.usdKrw ?? null),
  };
}

/**
 * 미국 보유분의 원화 평가 변화를 가격 효과와 환율 효과로 나눈다.
 *   원화 변화 = 지금 달러 평가 × 적용 환율 − 전일 달러 평가 × (적용 환율 − 원/달러 변동)
 *            = 달러 등락 × 적용 환율(가격 효과 = 당일 손익의 미국 몫) + 전일 달러 평가 × 원/달러 변동(환율 효과)
 * 원/달러 변동은 지수 띠와 같은 출처(하나은행 매매기준율 전일 대비)라 적용 환율(토스 표시 환율)과 출처가 다르다 — 변동 폭만 쓴다
 */
function fxImpact(us: RawRow[], usDay: number, usdKrw: MarketIndex | null): AccountFx {
  const idx = usdKrw ? { value: usdKrw.value, change: usdKrw.change, changeRate: usdKrw.changeRate, stale: usdKrw.stale === true } : null;
  const none = { usdHoldingsKrwChange: null, priceEffect: null, fxEffect: null };
  if (!us.length) return { status: "none", reason: "미국 종목이 없어 환율 효과가 없습니다", usdKrw: idx, appliedRate: null, ...none };
  const appliedRate = us[0]!.fx;
  if (!usdKrw || !Number.isFinite(usdKrw.change)) {
    return { status: "unavailable", reason: "원/달러 전일 대비 변동을 받지 못해 환율 효과를 계산하지 못했습니다", usdKrw: idx, appliedRate, ...none };
  }
  const d = usdKrw.change;
  return {
    status: "computed",
    reason: null,
    usdKrw: idx,
    appliedRate,
    usdHoldingsKrwChange: Math.round(sum(us.map((r) => r.nowUsd * r.fx - r.prevUsd * (r.fx - d)))),
    priceEffect: usDay,
    fxEffect: Math.round(sum(us.map((r) => r.prevUsd * d))),
  };
}

/** 지수·환율 영향에 쓰는 지수 (없으면 missing) */
export function pickIndices(list: readonly MarketIndex[]): { rows: AccountIndexRow[]; missing: string[] } {
  const rows: AccountIndexRow[] = [];
  const missing: string[] = [];
  const names: Record<string, string> = { KOSPI: "코스피", KOSDAQ: "코스닥", NASDAQ: "나스닥", SPX: "S&P500" };
  for (const code of ACCOUNT_INDEX_CODES) {
    const i = list.find((x) => x.code === code);
    if (!i) missing.push(names[code]!);
    else rows.push({ code, name: i.name, value: i.value, change: i.change, changeRate: i.changeRate, open: i.open, stale: i.stale === true });
  }
  return { rows, missing };
}

// ── 오늘 일정 ────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** 시간대의 UTC 오프셋(분, 현지 − UTC) */
function offsetMin(tz: string, t: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]), Number(p["hour"]) % 24, Number(p["minute"]));
  return Math.round((asUtc - Math.floor(t / 60_000) * 60_000) / 60_000);
}

/** 뉴욕 현지 날짜·시각 → 그 순간 (서머타임 반영) */
function nyWall(date: string, h: number, m: number): number {
  const guess = Date.parse(`${date}T${pad(h)}:${pad(m)}:00Z`);
  const off = offsetMin("America/New_York", guess);
  const t = guess - off * 60_000;
  const off2 = offsetMin("America/New_York", t);
  return off2 === off ? t : guess - off2 * 60_000;
}

/** 순간 → 한국 시간 "9/25 22:30" */
export function kstShort(t: number | string): string {
  const ms = typeof t === "string" ? Date.parse(t) : t;
  const iso = new Date(ms + 9 * 3_600_000).toISOString();
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))} ${iso.slice(11, 16)}`;
}

/** 지금 기준으로 다음(또는 진행 중인) 미국 정규장의 뉴욕 날짜: 뉴욕 16:00 전이면 오늘, 뒤면 다음 날 */
export function usSessionDate(now: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const date = `${p["year"]}-${p["month"]}-${p["day"]}`;
  if (Number(p["hour"]) % 24 < 16) return date;
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 미국 정규장(09:30~16:00 ET)을 한국 시간으로: "정규장 9/25 22:30~9/26 05:00 (한국 시간)". 조기 폐장은 반영하지 않는다 */
export function usRegularKst(nyDate: string): string {
  return `정규장 ${kstShort(nyWall(nyDate, 9, 30))}~${kstShort(nyWall(nyDate, 16, 0))} (한국 시간)`;
}

/** 오늘 일정: 한국·미국 장 운영(달력·휴장 목록)과 지금 상태, 종목 브리핑이 받아 둔 최근 공시 */
export function buildSchedule(status: MarketStatus | null, now: Date, disclosures: AccountDisclosure[]): AccountSchedule {
  const date = seoulDate(now);
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  const krTrading = status ? status.KR.isTradingDay : wd >= 1 && wd <= 5;
  const usDate = usSessionDate(now);
  const usTrading = isUsTradingDate(usDate);
  return {
    kr: {
      date,
      tradingDay: krTrading,
      now: marketContext("005930", status, now).label,
      hours: krTrading ? KR_HOURS : null,
      nextOpen: krTrading ? null : (status?.KR.opensAt ?? null),
    },
    us: { date: usDate, tradingDay: usTrading, now: marketContext("AAPL", status, now).label, hours: usTrading ? usRegularKst(usDate) : null },
    disclosures,
  };
}

// ── 문장 ────────────────────────────────────────────────────

/** "+1,234원" · "-2,868,108원" · "0원" (알림 묶음과 같은 표기) */
export const won = formatWon;

const idx = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number, text: string) => (v > 0 ? `+${text}` : v < 0 ? `-${text}` : text);
const SESSION_KO: Record<AccountSession, string> = { morning: "오전", afternoon: "오후" };

/** 알림·카드용 요약 두 줄 (코드로 만든다 — 숫자가 늘 맞게) */
export function summaryText(d: AccountTotals): string {
  const top = d.contributions[0];
  const line1 = `당일 ${won(d.dayPnl)}${d.dayRate !== null ? ` (${formatRate(d.dayRate)})` : ""}${top ? ` · 기여 1위 ${top.name} ${won(top.amount)}` : ""}`;
  const line2 = `총 평가금액 ${won(d.totalValue, false)}${d.fx.status === "computed" ? ` · 환율 효과 ${won(d.fx.fxEffect!)}` : ""}`;
  return `${line1}\n${line2}`;
}

function contributionLine(r: AccountRow, rank: number): string {
  return `${rank}. ${r.name}: ${won(r.amount)}${r.changeRate !== null ? ` (등락률 ${formatRate(r.changeRate)})` : ""}`;
}

function fxLine(fx: AccountFx): string {
  const rate = fx.usdKrw ? `원/달러 ${idx(fx.usdKrw.value)}원 (전일 대비 ${signed(fx.usdKrw.change, `${idx(Math.abs(fx.usdKrw.change))}원`)}, ${formatRate(fx.usdKrw.changeRate)})${fx.usdKrw.stale ? " · 지연된 값" : ""}` : null;
  if (fx.status === "computed") {
    return `${rate}. 미국 보유분 원화 평가 변화 ${won(fx.usdHoldingsKrwChange!)} = 가격 효과 ${won(fx.priceEffect!)} + 환율 효과 ${won(fx.fxEffect!)} (환율 효과는 당일 손익에 넣지 않음)`;
  }
  if (fx.status === "none") return `${rate ? `${rate}. ` : ""}환율 효과: 해당 없음 — ${fx.reason}`;
  return `${rate ? `${rate}. ` : ""}환율 효과: 계산하지 못함 — ${fx.reason}`;
}

function scheduleLines(s: AccountSchedule): string[] {
  const out = [
    `한국: ${s.kr.tradingDay ? `오늘 거래일, ${s.kr.hours}` : `오늘 휴장${s.kr.nextOpen ? ` (다음 개장 ${kstShort(s.kr.nextOpen)})` : ""}`}. 지금: ${s.kr.now}`,
    `미국: ${s.us.tradingDay ? `${Number(s.us.date.slice(5, 7))}/${Number(s.us.date.slice(8, 10))}(현지) ${s.us.hours}` : `${Number(s.us.date.slice(5, 7))}/${Number(s.us.date.slice(8, 10))}(현지) 휴장`}. 지금: ${s.us.now}`,
  ];
  if (s.disclosures.length) out.push(`최근 공시: ${s.disclosures.map((x) => `${x.name} "${x.title}" (${x.filedAt})`).join(" / ")}`);
  else out.push("최근 공시: 보유 국내 종목의 최근 3일 공시 없음(종목 브리핑이 받아 둔 것 기준)");
  return out;
}

/** 모델에게 주는 '사실' 목록. 모델의 설명에 나온 숫자는 모두 이 안에 있어야 한다 */
export function factsText(d: AccountData): string {
  const lines: string[] = [];
  lines.push(`- 기준: ${d.basis}`);
  lines.push(`- 총 평가금액: ${won(d.totalValue, false)} (보유 ${d.holdings}종목${d.stale ? `, 시세 지연 ${d.stale}종목` : ""})`);
  lines.push(`- 당일 손익: ${won(d.dayPnl)}${d.dayRate !== null ? ` (${formatRate(d.dayRate)})` : ""}`);
  lines.push(`- 누적 평가손익: ${won(d.totalProfit)}${d.totalProfitRate !== null ? ` (${formatRate(d.totalProfitRate)})` : ""}`);
  const m: string[] = [];
  if (d.markets.kr) m.push(`국내 보유분 ${d.markets.kr.count}종목 ${won(d.markets.kr.day)}${d.markets.kr.dayRate !== null ? ` (${formatRate(d.markets.kr.dayRate)})` : ""}`);
  if (d.markets.us) m.push(`미국 보유분 ${d.markets.us.count}종목 ${won(d.markets.us.day)}${d.markets.us.dayRate !== null ? ` (${formatRate(d.markets.us.dayRate)})` : ""}`);
  if (m.length) lines.push(`- 시장별 당일 손익: ${m.join(" / ")}`);
  if (d.contributions.length) {
    lines.push("- 당일 손익 기여 상위:");
    d.contributions.forEach((r, i) => lines.push(`  ${contributionLine(r, i + 1)}`));
    if (d.others) lines.push(`  그 외 ${d.others.count}종목: ${won(d.others.amount)}`);
  }
  if (d.indices.length) lines.push(`- 지수: ${d.indices.map((i) => `${i.name} ${idx(i.value)} (${formatRate(i.changeRate)}${i.stale ? ", 지연" : ""})`).join(", ")}`);
  if (d.missingIndices.length) lines.push(`- 받지 못한 지수: ${d.missingIndices.join(", ")}`);
  lines.push(`- 환율: ${fxLine(d.fx)}`);
  for (const l of scheduleLines(d.schedule)) lines.push(`- ${l}`);
  if (d.excluded.length) lines.push(`- 합계에서 뺀 종목: ${d.excluded.map((e) => `${e.name}(${e.reason})`).join(", ")}`);
  return lines.join("\n");
}

/** 모델 설명을 쓸 수 없을 때의 기본 문장 (숫자만으로) */
export function templateNarrative(d: AccountData): string {
  const out: string[] = [];
  const top = d.contributions[0];
  out.push(`- ${SESSION_KO[d.session]} 기준 당일 손익은 ${won(d.dayPnl)}${d.dayRate !== null ? `(${formatRate(d.dayRate)})` : ""}입니다.${top ? ` 가장 크게 기여한 종목은 ${top.name}(${won(top.amount)})입니다.` : ""}`);
  if (d.contributions.length > 1 || d.others) {
    const listed = d.contributions.slice(0, 3).map((r) => `${r.name} ${won(r.amount)}`).join(", ");
    out.push(`- 기여 상위: ${listed}${d.others ? `, 그 외 ${d.others.count}종목 ${won(d.others.amount)}` : ""}.`);
  }
  const idxText = d.indices.map((i) => `${i.name} ${formatRate(i.changeRate)}`).join(", ");
  const mk: string[] = [];
  if (d.markets.kr?.dayRate != null) mk.push(`국내 보유분 ${formatRate(d.markets.kr.dayRate)}`);
  if (d.markets.us?.dayRate != null) mk.push(`미국 보유분 ${formatRate(d.markets.us.dayRate)}`);
  if (idxText || mk.length) out.push(`- ${[mk.join(", "), idxText ? `지수는 ${idxText}` : ""].filter(Boolean).join(" · ")}.`);
  if (d.fx.status === "computed") out.push(`- 원/달러 변동으로 미국 보유분의 원화 가치가 ${won(d.fx.fxEffect!)} 달라졌습니다(환율 효과, 당일 손익에는 넣지 않음).`);
  else if (d.fx.status === "unavailable") out.push(`- 환율 효과는 계산하지 못했습니다: ${d.fx.reason}`);
  const s = d.schedule;
  out.push(`- 오늘 일정: 한국 ${s.kr.tradingDay ? "거래일" : "휴장"}, 미국 ${s.us.tradingDay ? s.us.hours : "휴장"}.${s.disclosures.length ? ` 최근 공시 ${s.disclosures.length}건.` : ""}`);
  return out.join("\n");
}

// ── 모델 설명 검사 ────────────────────────────────────────────

/** 글 속 숫자 (쉼표 뺀 값, 부호 없이) */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

/** 순서(1위·2종목) 같은 작은 정수는 숫자를 지어낸 것으로 보지 않는다 */
const SMALL_INT_MAX = 10;
/** 설명에 나오면 안 되는 말: 매매 지시·전망 (나오면 기본 문장으로) */
const FORBIDDEN = /(매수|매도|추천|전망|목표가|오를 것|내릴 것|사야|팔아야|손절|익절)/;

/** 모델 설명을 그대로 써도 되는지. 사실에 없는 숫자, 매매·전망 표현, 빈 응답이면 이유와 함께 false */
export function checkNarrative(text: string, facts: string): { ok: true } | { ok: false; reason: string } {
  if (!text.trim()) return { ok: false, reason: "빈 응답" };
  if (text.length > 3000) return { ok: false, reason: "설명이 너무 김" };
  const allowed = new Set(numbersIn(facts));
  const unknown = [...new Set(numbersIn(text).filter((n) => !allowed.has(n) && !(Number.isInteger(n) && n <= SMALL_INT_MAX)))];
  if (unknown.length) return { ok: false, reason: `입력에 없는 숫자: ${unknown.slice(0, 5).join(", ")}` };
  const bad = text.match(FORBIDDEN);
  if (bad) return { ok: false, reason: `쓰지 않는 표현: ${bad[1]}` };
  return { ok: true };
}

/** 모델 응답 정리: 코드 울타리를 벗기고 앞뒤 공백 제거 */
export function cleanNarrative(text: string): string {
  return text.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
}

export function sessionKo(s: AccountSession): string {
  return SESSION_KO[s];
}
