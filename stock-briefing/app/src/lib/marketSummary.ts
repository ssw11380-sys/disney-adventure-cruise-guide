import type { CompareRow, HoldingsCompare, MarketSummary, MarketSummaryData, SectorRow, SummaryEvent, SummaryMarket, SummaryNews, SummaryYield } from "@/api/types";

/**
 * 시장 전체 요약 문장 (플래그 marketSummary). 서버 backend/src/services/marketSummaryCalc.ts 의 문장 함수와 같은 글을 만든다 —
 * shared/fixtures/marketSummary.json 으로 두 쪽이 같은지 본다 (app/test/marketSummary.test.ts).
 * React Native 를 불러오지 않는 순수 모듈 (알림 briefingDigest·백그라운드 태스크·테스트에서 씀).
 *  - 숫자·문장은 서버가 저장한 값(data)으로 틀에 채운다. AI 문장 없음
 *  - '오늘/밤사이'는 볼 때 날짜(한국)로 정한다: 자정 뒤·주말·다음 날 아침에 보면 날짜로 바뀐다 (저장한 문구가 아님)
 *  - 쓰지 않는 말: 선방·부진·기회·주의 같은 평가, 원인 표현. '강한/약한'은 업종에만, 종목은 '지수보다 높음/낮음'
 * 색을 칠할 수 있게 줄을 조각(Seg)으로 만들고, 글은 조각을 이은 것이다
 */

/** 줄 조각. tone 이 있으면 등락 색(한국 관례: 오름 빨강, 내림 파랑), muted 면 흐린 글자 */
export interface Seg {
  text: string;
  tone?: number;
  muted?: boolean;
}

export type LineKind = "holiday" | "indices" | "rates" | "sectors" | "holdings" | "events" | "news";
export interface SummaryLine {
  kind: LineKind;
  text: string;
}
export interface SegLine {
  kind: LineKind;
  segs: Seg[];
}

/** '비슷' 기준 ±1.00%p (서버 SIMILAR_BAND_BP 와 같다) */
export const SIMILAR_BAND_BP = 100;
/** 카드·요약 줄 최대 수 */
export const MAX_LINES = 6;
/** 6줄이 넘으면 뒤에서부터 뺀다: 뉴스 → 일정 → 업종 (그다음 환율·금리) */
export const LINE_DROP: readonly LineKind[] = ["news", "events", "sectors", "rates"];
/** 카드 맨 아래 고지 한 줄 */
export const SUMMARY_NOTE = "숫자로 만든 요약 · 뉴스 제목은 언론사 원문 · 매매 권유가 아닙니다";

// ── 날짜 ─────────────────────────────────────────────────────

const WD = ["일", "월", "화", "수", "목", "금", "토"];
const pad = (n: number) => String(n).padStart(2, "0");
const kstDateOf = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
const kstHmOf = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(11, 16);
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** "9/25" */
export const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
/** "9/25(금)" */
export const mdw = (date: string) => `${md(date)}(${WD[weekday(date)]})`;
const dayName = (date: string) => `${WD[weekday(date)]}요일`;
/** 보는 날짜 (한국) */
export const viewDateOf = (at: Date) => kstDateOf(at.getTime());

/** 서울 날짜·시각 → 순간 */
const kstWall = (date: string, minutes: number) => Date.parse(`${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00+09:00`);

/** 뉴욕 현지 날짜·시각 → 순간 (서머타임 반영) */
function nyWall(date: string, minutes: number): number {
  const off = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    return Math.round((Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]), Number(p["hour"]) % 24, Number(p["minute"])) - Math.floor(t / 60_000) * 60_000) / 60_000);
  };
  const guess = Date.parse(`${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00Z`);
  const o = off(guess);
  const t = guess - o * 60_000;
  const o2 = off(t);
  return o2 === o ? t : guess - o2 * 60_000;
}

/** 그 세션의 정규장 마감 순간 (장중 라벨 '오늘 16:30 마감'에 쓴다). 한국은 저장한 마감 시각(수능일 16:30), 미국은 뉴욕 마감 시각 */
function closeAt(d: Pick<MarketSummaryData, "market" | "basisDate" | "closeTime">): number {
  const [h, m] = d.closeTime.split(":").map(Number) as [number, number];
  return d.market === "KR" ? kstWall(d.basisDate, h * 60 + m) : nyWall(d.basisDate, h * 60 + m);
}

// ── 숫자 ─────────────────────────────────────────────────────

const idx2 = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "-" : "");
/** "+0.48%" (알림 formatRate 와 같다) */
export const rateText = (r: number) => `${r > 0 ? "+" : ""}${r.toFixed(2)}%`;
/** "+3.50원" */
const wonChange = (v: number) => `${sign(v)}${idx2(Math.abs(v))}원`;
/** 차이 "+3.18%p" (정수 1/100 로 반올림) */
export const ppText = (diff: number) => {
  const bp = Math.round(diff * 100);
  return `${sign(bp)}${(Math.abs(bp) / 100).toFixed(2)}%p`;
};
/** 지수 값 "7,080.92" */
export const indexValueText = (v: number) => idx2(v);
/** 원/달러 "1,359.00원" */
export const wonText = (v: number) => `${idx2(v)}원`;
/** 전일 대비 원 "+3.50원" */
export const wonChangeText = wonChange;
const YIELD_SOURCE: Record<SummaryYield["source"], string> = { treasury: "미 재무부", naver: "로이터·네이버" };
export const yieldSourceText = (y: SummaryYield) => YIELD_SOURCE[y.source];
export const yieldValueText = (y: SummaryYield) => `${y.value.toFixed(y.dp.value)}%`;
export const yieldChangeText = (y: SummaryYield) => (y.change !== null ? `${sign(y.change)}${Math.abs(y.change).toFixed(y.dp.change)}%p` : "");
const marketWord = (m: SummaryMarket) => (m === "US" ? "미국" : "국내");

const join = (segs: Seg[]) => segs.map((s) => s.text).join("");

// ── 제목·기준·휴장 ────────────────────────────────────────────

const titleDate = (d: Pick<MarketSummaryData, "holiday" | "marketDate" | "basisDate">) => (d.holiday ? d.marketDate : d.basisDate);

/** '밤사이 미국' · '금요일(9/25) 미국' · '오늘 한국' · '9/23(수) 한국' (알림 첫 줄 앞머리) */
export function sessionWord(d: Pick<MarketSummaryData, "market" | "holiday" | "marketDate" | "basisDate">, view: Date): string {
  const today = viewDateOf(view);
  const td = titleDate(d);
  if (d.market === "US") return td === addDays(today, -1) ? "밤사이 미국" : `${dayName(td)}(${md(td)}) 미국`;
  return td === today ? "오늘 한국" : `${mdw(td)} 한국`;
}

/** 제목: '밤사이 미국 시장' / '금요일(9/25) 미국 시장' · '오늘 한국 시장' / '9/23(수) 한국 시장' — 볼 때 날짜로 */
export function titleText(d: Pick<MarketSummaryData, "market" | "holiday" | "marketDate" | "basisDate">, view: Date): string {
  return `${sessionWord(d, view)} 시장`;
}

/** 휴장 줄: '오늘 한국 휴장(추석) · 아래는 직전 거래일 9/23 기준' · '지난밤 미국 휴장(추수감사절) · 아래는 직전 거래일 11/25(수) 기준' */
export function holidayText(d: Pick<MarketSummaryData, "market" | "holiday" | "basisDate">, view: Date, withBasis = true): string | null {
  if (!d.holiday) return null;
  const today = viewDateOf(view);
  const name = d.holiday.name ? `(${d.holiday.name})` : "";
  if (d.market === "US") {
    const when = d.holiday.date === addDays(today, -1) ? "지난밤" : mdw(d.holiday.date);
    return `${when} 미국 휴장${name}${withBasis ? ` · 아래는 직전 거래일 ${mdw(d.basisDate)} 기준` : ""}`;
  }
  const when = d.holiday.date === today ? "오늘" : mdw(d.holiday.date);
  return `${when} 한국 휴장${name}${withBasis ? ` · 아래는 직전 거래일 ${md(d.basisDate)} 기준` : ""}`;
}

/** 기준 줄: '9/25(금) 뉴욕 장 마감 기준 · 주말 이틀 휴장' · '9/23(수) 15:30 장 마감 기준' · '장중 값(16:00 기준) · 오늘 16:30 마감' */
export function basisText(d: Pick<MarketSummaryData, "market" | "holiday" | "basisDate" | "weekendGap" | "earlyClose" | "closeTime" | "phase" | "asOf">, view: Date): string {
  const today = viewDateOf(view);
  const made = Date.parse(d.asOf);
  if (d.phase === "intraday") {
    const close = closeAt(d);
    const closeDay = kstDateOf(close);
    return `장중 값(${kstHmOf(made)} 기준) · ${closeDay === today ? "오늘" : mdw(closeDay)} ${kstHmOf(close)} 마감`;
  }
  if (d.market === "US") {
    const pre = d.holiday ? "직전 거래일 " : "";
    const early = d.earlyClose ? " (조기 폐장 13:00 ET)" : "";
    if (d.phase === "prelim") return `${pre}${mdw(d.basisDate)} 뉴욕 장 마감 직후 값${early} · 최종값 확정 전`;
    return `${pre}${mdw(d.basisDate)} 뉴욕 장 마감 기준${early}${d.weekendGap ? " · 주말 이틀 휴장" : ""}`;
  }
  return `${d.holiday ? "직전 거래일 " : ""}${mdw(d.basisDate)} ${d.closeTime} 장 마감 기준`;
}

/** 목록 줄 배지 '9/25(금) 마감' · '장중' · '휴장' */
export function closeBadge(d: MarketSummaryData): string {
  if (d.phase === "intraday") return "장중";
  if (d.holiday) return "휴장";
  return `${mdw(d.basisDate)} 마감`;
}

// ── 줄 조각 ───────────────────────────────────────────────────

/** 지수 줄: 아침 '나스닥 +0.48% · …', 오후 '코스피 7,080.92 +0.90% · …', 휴장 '코스피 (9/23) +0.90% · …' */
export function indexSegs(d: Pick<MarketSummaryData, "market" | "indices" | "holiday">): Seg[] | null {
  if (!d.indices.some((i) => i.changeRate !== null)) return null;
  const out: Seg[] = [];
  d.indices.forEach((i, n) => {
    if (n > 0) out.push({ text: " · " });
    if (i.changeRate === null) {
      out.push({ text: `${i.name} —` });
      return;
    }
    const day = d.holiday && i.date ? ` (${md(i.date)})` : "";
    const val = d.market === "KR" && !d.holiday && i.value !== null ? ` ${idx2(i.value)}` : "";
    out.push({ text: `${i.name}${day}${val} ` }, { text: rateText(i.changeRate), tone: i.changeRate });
  });
  return out;
}

/** 원/달러 칸: '원/달러 1,359.00원 +3.50원 (9/23 고시)' — 고시일이 요약 날짜와 같으면 날짜를 붙이지 않는다 */
export function fxSegs(d: Pick<MarketSummaryData, "fx" | "date">): Seg[] | null {
  const f = d.fx;
  if (!f) return null;
  return [{ text: `원/달러 ${idx2(f.value)}원 ` }, { text: wonChange(f.change), tone: f.change }, ...(f.date && f.date !== d.date ? [{ text: ` (${md(f.date)} 고시)`, muted: true }] : [])];
}

/** 미 10년물 칸 (출처 표기 필수) */
export function yieldSegs(y: SummaryYield | null): Seg[] | null {
  if (!y) return null;
  return [{ text: `미 10년물 ${yieldValueText(y)}` }, ...(y.change !== null ? [{ text: " " }, { text: yieldChangeText(y), tone: y.change }] : []), { text: ` (${YIELD_SOURCE[y.source]})`, muted: true }];
}

/** 환율·금리 줄 */
export function ratesSegs(d: Pick<MarketSummaryData, "fx" | "date" | "yield10y">): Seg[] | null {
  const parts = [fxSegs(d), yieldSegs(d.yield10y)].filter((x): x is Seg[] => !!x);
  if (!parts.length) return null;
  return parts.flatMap((p, i) => (i ? [{ text: " · " }, ...p] : p));
}

const sectorItems = (list: SectorRow[]): Seg[] => list.flatMap((s, i) => [...(i ? [{ text: " · " }] : []), { text: `${s.name} ` }, { text: rateText(s.changeRate), tone: s.changeRate }]);
const basisPrefix = (d: Pick<MarketSummaryData, "holiday" | "basisDate">): Seg[] => (d.holiday ? [{ text: `${md(d.basisDate)} 기준 · `, muted: true }] : []);

/** 업종 줄: '강한 업종 산업재 +0.95% · 기술 +0.80% / 약한 업종 커뮤니케이션 -0.90% · 에너지 -0.89% (섹터 ETF 기준)' */
export function sectorSegs(d: Pick<MarketSummaryData, "sectors" | "holiday" | "basisDate">): Seg[] | null {
  const s = d.sectors;
  if (!s || !s.strong.length) return null;
  return [...basisPrefix(d), { text: "강한 업종 " }, ...sectorItems(s.strong), { text: " / 약한 업종 " }, ...sectorItems(s.weak), ...(s.basis === "etf" ? [{ text: " (섹터 ETF 기준)", muted: true }] : [])];
}

/** 카드의 업종 두 줄: '강 산업재 +0.95% · 기술 +0.80%' / '약 커뮤니케이션 -0.90% · 에너지 -0.89% (섹터 ETF 기준)' */
export function sectorCardSegs(d: Pick<MarketSummaryData, "sectors" | "holiday" | "basisDate">): [Seg[], Seg[]] | null {
  const s = d.sectors;
  if (!s || !s.strong.length) return null;
  return [
    [...basisPrefix(d), { text: "강 " }, ...sectorItems(s.strong)],
    [{ text: "약 " }, ...sectorItems(s.weak), ...(s.basis === "etf" ? [{ text: " (섹터 ETF 기준)", muted: true }] : [])],
  ];
}

/**
 * 내 종목 줄: '내 미국 12종목 · 지수보다 높음 2 (마이크로소프트 +3.66%, 지수와 차이 +3.18%p) · 낮음 3 (메타 -3.33%, 차이 -3.81%p) · 비슷 7'.
 * 모두 비슷하면 '내 미국 12종목 모두 지수와 ±1%p 안'. 개수에는 색을 칠하지 않는다. mine=false 면 앞의 '내 ' 없이 (카드 이름표가 '내 종목')
 */
export function holdingsSegs(d: Pick<MarketSummaryData, "holdings" | "holiday" | "basisDate">, opts: { mine?: boolean } = {}): Seg[] | null {
  const h = d.holdings;
  if (!h || h.compared === 0) return null;
  const head = `${opts.mine === false ? "" : "내 "}${marketWord(h.market)} ${h.compared}종목`;
  if (!h.high.length && !h.low.length) return [...basisPrefix(d), { text: `${head} 모두 지수와 ±${(SIMILAR_BAND_BP / 100).toFixed(0)}%p 안` }];
  let first = true;
  const paren = (r: CompareRow | undefined): Seg[] => {
    if (!r) return [];
    const label = first ? "지수와 차이" : "차이";
    first = false;
    return [{ text: ` (${r.name} ` }, { text: rateText(r.changeRate), tone: r.changeRate }, { text: `, ${label} ${ppText(r.diff)})` }];
  };
  return [...basisPrefix(d), { text: `${head} · 지수보다 높음 ${h.high.length}` }, ...paren(h.high[0]), { text: ` · 낮음 ${h.low.length}` }, ...paren(h.low[0]), { text: ` · 비슷 ${h.similar.length}` }];
}

/** 넓은 창 목록 줄의 한 줄: '내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7' (괄호 없이) */
export function holdingsShort(h: HoldingsCompare | null): string | null {
  if (!h || h.compared === 0) return null;
  const head = `내 ${marketWord(h.market)} ${h.compared}종목`;
  if (!h.high.length && !h.low.length) return `${head} 모두 지수와 ±${(SIMILAR_BAND_BP / 100).toFixed(0)}%p 안`;
  return `${head} · 지수보다 높음 ${h.high.length} · 낮음 ${h.low.length} · 비슷 ${h.similar.length}`;
}

/** 상세 보조 줄: '내 미국 12종목: 상승 8 · 하락 4 / 나스닥 +0.48% · S&P500 +0.51%' */
export function holdingsAuxSegs(h: HoldingsCompare): Seg[] {
  const moves = [`상승 ${h.up}`, `하락 ${h.down}`, ...(h.flat ? [`보합 ${h.flat}`] : [])].join(" · ");
  const bench = h.benchmarks.flatMap((b, i) => [...(i ? [{ text: " · " }] : []), { text: `${b.name} ` }, { text: rateText(b.changeRate), tone: b.changeRate }]);
  return [{ text: `내 ${marketWord(h.market)} ${h.compared}종목: ${moves}` }, ...(bench.length ? [{ text: " / " }, ...bench] : [])];
}

/** 일정 한 칸: '오늘 21:30 미국 9월 소비자물가(CPI) 발표' · '10/29(목) 03:00 …' · '9/24~9/25 추석 연휴 한국 휴장' · '다음 개장 9/28(월) 09:00' */
export function eventText(e: SummaryEvent, view: Date): string {
  const today = viewDateOf(view);
  const rel = (date: string) => (date === today ? "오늘" : mdw(date));
  if (e.kind === "kr-open") return `다음 개장 ${mdw(e.date)}${e.time ? ` ${e.time}` : ""}`;
  if (e.endDate) return `${md(e.date)}~${md(e.endDate)} ${e.text}`;
  return `${rel(e.date)}${e.time ? ` ${e.time}` : ""} ${e.text}`;
}

/** 일정 칸들 (가까운 순 최대 2개, '·' 로) — 카드는 이름표가 '일정'이라 앞머리 없이 */
export function eventsBody(d: Pick<MarketSummaryData, "events">, view: Date): string | null {
  const list = d.events.within.slice(0, 2);
  return list.length ? list.map((e) => eventText(e, view)).join(" · ") : null;
}

/** 뉴스 시각: 요약 날짜와 같은 날이면 HH:MM, 아니면 M/D HH:MM (한국 시간) */
export function newsTime(n: Pick<SummaryNews, "publishedAt">, date: string): string {
  const t = Date.parse(n.publishedAt);
  const day = kstDateOf(t);
  return `${day === date ? "" : `${md(day)} `}${kstHmOf(t)}`;
}

/** 요약의 뉴스 줄 (언론사·시각만 — 제목은 카드·상세 뉴스 칸에 원문 그대로). 휴장일처럼 새 기사가 아니면 없다 */
export function newsLine(d: Pick<MarketSummaryData, "news" | "date">): string | null {
  if (!d.news.fresh || !d.news.items.length) return null;
  return `뉴스 ${d.news.items.length}건 · ${d.news.items.map((n) => `${n.outlet} ${newsTime(n, d.date)}`).join(" · ")}`;
}

/** 줄 수 상한 (보이는 순서 유지) */
export function fitLines<T extends { kind: LineKind }>(lines: T[], max = MAX_LINES): T[] {
  let out = [...lines];
  for (const k of LINE_DROP) {
    if (out.length <= max) break;
    out = out.filter((l) => l.kind !== k);
  }
  return out.slice(0, max);
}

/** 요약 줄 조각 (최대 6줄, 볼 때 날짜로). 지수를 하나도 못 받았으면 빈 목록 */
export function summarySegLines(d: MarketSummaryData, view: Date): SegLine[] {
  const idx = indexSegs(d);
  if (!idx) return [];
  const ev = eventsBody(d, view);
  const news = newsLine(d);
  const all: (SegLine | null)[] = [
    d.holiday ? { kind: "holiday", segs: [{ text: holidayText(d, view)! }] } : null,
    { kind: "indices", segs: idx },
    lineOf("rates", ratesSegs(d)),
    lineOf("sectors", sectorSegs(d)),
    lineOf("holdings", holdingsSegs(d)),
    ev ? { kind: "events", segs: [{ text: `일정 · ${ev}` }] } : null,
    news ? { kind: "news", segs: [{ text: news }] } : null,
  ];
  return fitLines(all.filter((l): l is SegLine => l !== null));
}

function lineOf(kind: LineKind, segs: Seg[] | null): SegLine | null {
  return segs ? { kind, segs } : null;
}

/** 요약 줄 글 (서버 summaryLines 와 같다) */
export function summaryLines(d: MarketSummaryData, view: Date): SummaryLine[] {
  return summarySegLines(d, view).map((l) => ({ kind: l.kind, text: join(l.segs) }));
}

/** 보조 줄 글 (서버 holdingsAux 와 같다) */
export function holdingsAux(h: HoldingsCompare): string {
  return join(holdingsAuxSegs(h));
}

/**
 * 세션 알림 첫 줄 (보내는 순간의 문구 — 서버 digestLine 과 같다). 지수 두 개를 모두 못 받았으면 null
 *  - '밤사이 미국 나스닥 +0.48% · S&P500 +0.51% · 내 미국 12종목 중 지수보다 높음 2 · 낮음 3'
 *  - 휴장: '오늘 한국 휴장(추석) · 코스피 +0.90% · 코스닥 +1.21% (9/23 기준)'
 */
export function digestLine(d: MarketSummaryData, at: Date): string | null {
  const pair = d.indices.slice(0, 2).filter((i) => i.changeRate !== null);
  if (!pair.length) return null;
  const idx = pair.map((i) => `${i.name} ${rateText(i.changeRate!)}`).join(" · ");
  if (d.holiday) return `${holidayText(d, at, false)} · ${idx} (${md(d.basisDate)} 기준)`;
  // 장중이면 그 시각, 미국 마감 직후 최종값 전이면 그 표시 (카드 기준 줄과 같은 사실)
  const live = d.phase === "intraday" ? ` 장중(${kstHmOf(Date.parse(d.asOf))} 기준)` : d.phase === "prelim" ? "(최종값 전)" : "";
  const h = d.holdings;
  let mine = "";
  if (h && h.compared > 0) {
    const head = `내 ${marketWord(h.market)} ${h.compared}종목`;
    mine = !h.high.length && !h.low.length ? ` · ${head} 모두 지수와 ±${(SIMILAR_BAND_BP / 100).toFixed(0)}%p 안` : ` · ${head} 중 지수보다 높음 ${h.high.length} · 낮음 ${h.low.length}`;
  }
  return `${sessionWord(d, at)}${live} ${idx}${mine}`;
}

// ── 카드 ─────────────────────────────────────────────────────

export type CardRow = { kind: "rates" | "sectors" | "holdings" | "events"; label: string; lines: Seg[][] } | { kind: "news"; label: string; items: SummaryNews[]; more: number };

/**
 * 카드 이름표 줄 (요약 줄과 같은 최대 6줄 규칙 — 휴장 배너·지수 칸도 한 줄로 센다).
 * 환율·금리 / 업종(강·약 두 줄) / 내 종목 / 일정 / 뉴스 N건(제목 2개 한 줄씩, 나머지는 '외 N건')
 */
export function cardRows(d: MarketSummaryData, view: Date): CardRow[] {
  const kinds = new Set(summarySegLines(d, view).map((l) => l.kind));
  const rows: CardRow[] = [];
  const rates = ratesSegs(d);
  if (kinds.has("rates") && rates) rows.push({ kind: "rates", label: d.market === "US" ? "환율·금리" : "환율", lines: [rates] });
  const sec = sectorCardSegs(d);
  if (kinds.has("sectors") && sec) rows.push({ kind: "sectors", label: "업종", lines: sec });
  const hold = holdingsSegs(d, { mine: false });
  if (kinds.has("holdings") && hold) rows.push({ kind: "holdings", label: "내 종목", lines: [hold] });
  const ev = eventsBody(d, view);
  if (kinds.has("events") && ev) rows.push({ kind: "events", label: "일정", lines: [[{ text: ev }]] });
  if (kinds.has("news")) rows.push({ kind: "news", label: `뉴스 ${d.news.items.length}건`, items: d.news.items.slice(0, 2), more: Math.max(0, d.news.items.length - 2) });
  return rows;
}

/** 브리핑 탭 맨 위 카드에 보일 요약: 플래그가 켜져 있고 목록을 받았으면 가장 최근 것 */
export function marketCardItem(on: boolean, list: readonly MarketSummary[] | undefined): MarketSummary | undefined {
  return on && list?.length ? list[0] : undefined;
}

/** 목록 줄의 짧은 시각 '9/28 오전' */
export function summaryWhen(s: Pick<MarketSummary, "date" | "session">): string {
  return `${md(s.date)} ${s.session === "afternoon" ? "오후" : "오전"}`;
}

// ── 화면 읽기 ─────────────────────────────────────────────────

/**
 * 화면 읽기용 문장: 기호를 말로 ('+0.48%' → '0.48% 상승', '+3.18%p' → '3.18%포인트 높음', '±1%p' → '플러스마이너스 1%포인트', '—' → '받지 못함')
 */
export function speakText(text: string): string {
  return text
    .replace(/±(\d+)%p/g, "플러스마이너스 $1%포인트")
    .replace(/([+-])(\d[\d,]*\.?\d*)%p/g, (_m, s: string, n: string) => `${n}%포인트 ${s === "+" ? "높음" : "낮음"}`)
    .replace(/([+-])(\d[\d,]*\.?\d*)%/g, (_m, s: string, n: string) => `${n}% ${s === "+" ? "상승" : "하락"}`)
    .replace(/([+-])(\d[\d,]*\.?\d*)원/g, (_m, s: string, n: string) => `${n}원 ${s === "+" ? "상승" : "하락"}`)
    .replace(/ —/g, " 받지 못함")
    .replace(/ · /g, ", ")
    .replace(/ \/ /g, ", ");
}

/** 카드·목록 줄을 한 문장으로 */
export function cardSpeech(s: MarketSummary, view: Date): string {
  const d = s.data;
  const when = `${md(s.date)} ${s.session === "afternoon" ? "오후" : "오전"}`;
  if (s.status === "failed" || !d) return `시장 요약, ${when}, 생성 실패, 자세히 보기`;
  const lines = summaryLines(d, view).map((l) => speakText(l.text));
  return [titleText(d, view), when, speakText(basisText(d, view)), ...lines, "숫자로 만든 요약, 매매 권유가 아닙니다", "자세히 보기"].join(", ");
}
