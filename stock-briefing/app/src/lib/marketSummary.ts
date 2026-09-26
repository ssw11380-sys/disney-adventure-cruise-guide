import type { CompareRow, HoldingsCompare, MarketSummary, MarketSummaryData, SectorRow, SummaryEvent, SummaryIndex, SummaryMarket, SummaryNews, SummaryYield } from "@/api/types";
import { font, layout as LK, marketSummary as MSK, space } from "@/tokens";

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

/** '비슷' 기준 ±1.00%p (서버 SIMILAR_BAND_BP 와 같다 — 앱 테스트가 두 값이 같은지 본다) */
export const SIMILAR_BAND_BP = 100;
/** 기준 글: 표 머리·안내는 '1.00', 화면 읽기는 '1' */
const BAND_PP = (SIMILAR_BAND_BP / 100).toFixed(2);
const BAND_SPOKEN = String(SIMILAR_BAND_BP / 100);
/** 상세 '내 보유 종목과 지수' 묶음 머리 — 기준 상수로 만든다 (기준을 바꾸면 머리 글도 같이 바뀌어 분류와 어긋나지 않게) */
export const GROUP_TITLE: Record<"high" | "similar" | "low", string> = {
  high: `지수보다 높음 (+${BAND_PP}%p 이상)`,
  similar: `비슷 (±${BAND_PP}%p 안)`,
  low: `지수보다 낮음 (-${BAND_PP}%p 이하)`,
};
/** 묶음 머리 화면 읽기 ('+1.00%p' 를 '1%포인트 높음'처럼 두 번 읽지 않게 따로 적는다) */
export const GROUP_SPEECH: Record<"high" | "similar" | "low", string> = {
  high: `지수보다 높음, 차이 ${BAND_SPOKEN}%포인트 이상`,
  similar: `비슷, 차이 플러스마이너스 ${BAND_SPOKEN}%포인트 안`,
  low: `지수보다 낮음, 차이 마이너스 ${BAND_SPOKEN}%포인트 이하`,
};
/** 상세 '이 요약을 만든 기준'의 '비슷' 안내 */
export const SIMILAR_NOTE = `'비슷'은 지수와의 차이가 ±${BAND_PP}%p 안인 종목입니다 (좋고 나쁨의 뜻이 아님).`;
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

/**
 * 제목에 쓰는 날짜 (서버와 같다).
 *  - 미국: 숫자의 거래일(basisDate). 월요일·휴장 다음 날에는 숫자가 어젯밤 것이 아니므로 '밤사이'가 아니라 그 거래일로 ('수요일(11/25) 미국 시장')
 *  - 한국: 휴장이면 그 휴장일('오늘 한국 시장' + 휴장 배지·배너), 아니면 거래일
 */
const titleDate = (d: Pick<MarketSummaryData, "market" | "holiday" | "marketDate" | "basisDate">) => (d.market === "KR" && d.holiday ? d.marketDate : d.basisDate);

/** '밤사이 미국'(숫자의 거래일이 보는 날의 전날일 때만) · '금요일(9/25) 미국' · '오늘 한국' · '9/23(수) 한국' (알림 첫 줄 앞머리) */
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

/** 목록 줄 배지 '9/25(금) 마감' · '장중' · '최종값 전'(미국 마감 직후, 네이버 최종값 전) · '휴장' — 확정 전 값은 목록 줄에서도 알 수 있게 */
export function closeBadge(d: MarketSummaryData): string {
  if (d.phase === "intraday") return "장중";
  if (d.phase === "prelim") return "최종값 전";
  if (d.holiday) return "휴장";
  return `${mdw(d.basisDate)} 마감`;
}

/** 목록 줄 배지를 경고색(warn)으로 칠할지: 휴장·장중·최종값 전 */
export function closeBadgeWarn(d: MarketSummaryData): boolean {
  return !!d.holiday || d.phase !== "final";
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

/** 원/달러 고시일 표기 (서버 fxDateNote 와 같다): 요약 날짜와 같으면 없음, 다르면 ' (9/23 고시)', 확인하지 못했으면 ' (고시일 확인 못 함)' */
export function fxDateNote(f: { date: string | null }, date: string): string {
  if (!f.date) return " (고시일 확인 못 함)";
  return f.date !== date ? ` (${md(f.date)} 고시)` : "";
}

/** 원/달러 칸: '원/달러 1,359.00원 +3.50원 (9/23 고시)' — 고시일이 요약 날짜와 같으면 날짜를 붙이지 않는다 */
export function fxSegs(d: Pick<MarketSummaryData, "fx" | "date">): Seg[] | null {
  const f = d.fx;
  if (!f) return null;
  const note = fxDateNote(f, d.date);
  return [{ text: `원/달러 ${idx2(f.value)}원 ` }, { text: wonChange(f.change), tone: f.change }, ...(note ? [{ text: note, muted: true }] : [])];
}

/** 미 10년물 칸 (출처 표기 필수). withDate(휴장 다음 날): ' (11/25 기준 · 미 재무부)' */
export function yieldSegs(y: SummaryYield | null, withDate = false): Seg[] | null {
  if (!y) return null;
  return [
    { text: `미 10년물 ${yieldValueText(y)}` },
    ...(y.change !== null ? [{ text: " " }, { text: yieldChangeText(y), tone: y.change }] : []),
    { text: ` (${withDate ? `${md(y.date)} 기준 · ` : ""}${YIELD_SOURCE[y.source]})`, muted: true },
  ];
}

/** 환율·금리 줄 (휴장이면 금리에도 'M/D 기준' — 원/달러는 고시일을 따로 적는다) */
export function ratesSegs(d: Pick<MarketSummaryData, "fx" | "date" | "yield10y" | "holiday">): Seg[] | null {
  const parts = [fxSegs(d), yieldSegs(d.yield10y, !!d.holiday)].filter((x): x is Seg[] => !!x);
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
  return [...basisPrefix(d), { text: `${head} · 지수보다 높음 ${h.high.length}` }, ...paren(widestOf(h.high)), { text: ` · 낮음 ${h.low.length}` }, ...paren(widestOf(h.low)), { text: ` · 비슷 ${h.similar.length}` }];
}

/**
 * 묶음에서 지수와 차이가 가장 큰 종목 (한 줄 문구 괄호, 서버 widestOf 와 같은 규칙): 높음은 가장 큰 +, 낮음은 가장 큰 −, 같으면 이름 순 앞.
 * 서버는 묶음 안을 부호 그대로 큰 순(낮음은 0에 가까운 것부터)으로 주므로 첫 줄이 아니라 따로 고른다
 */
export function widestOf(rows: readonly CompareRow[]): CompareRow | undefined {
  let best: CompareRow | undefined;
  for (const r of rows) {
    const d = best ? Math.abs(Math.round(r.diff * 100)) - Math.abs(Math.round(best.diff * 100)) : 1;
    if (d > 0 || (d === 0 && r.name.localeCompare(best!.name, "ko") < 0)) best = r;
  }
  return best;
}

/** 넓은 창 목록 줄의 한 줄: '내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7' (괄호 없이) */
export function holdingsShort(h: HoldingsCompare | null): string | null {
  if (!h || h.compared === 0) return null;
  return holdingsCountText(h.market, { compared: h.compared, high: h.high.length, low: h.low.length, similar: h.similar.length });
}

/**
 * 개수만으로 만든 내 종목 한 줄 (넓은 창 목록 줄·브리핑 위젯 둘째 줄이 같은 글): '내 미국 12종목 · 지수보다 높음 2 · 낮음 3 · 비슷 7',
 * 모두 비슷하면 '내 미국 12종목 모두 지수와 ±1%p 안'. 개수는 서버가 ±1.00%p 로 나눈 것 그대로
 */
export function holdingsCountText(market: SummaryMarket, h: { compared: number; high: number; low: number; similar: number }): string {
  const head = `내 ${marketWord(market)} ${h.compared}종목`;
  if (!h.high && !h.low) return `${head} 모두 지수와 ±${(SIMILAR_BAND_BP / 100).toFixed(0)}%p 안`;
  return `${head} · 지수보다 높음 ${h.high} · 낮음 ${h.low} · 비슷 ${h.similar}`;
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

/**
 * 뉴스 '원문' 링크로 열 주소: http·https 주소만 (서버도 이런 주소만 저장하지만, 예전에 저장한 요약·다른 출처 값도 한 번 더 본다 —
 * javascript:·intent: 같은 주소는 열지 않고 '원문' 칸을 두지 않는다). 아니면 null
 */
export function newsLink(url: string | null | undefined): string | null {
  const u = typeof url === "string" ? url.trim() : "";
  return /^https?:\/\/\S+$/i.test(u) ? u : null;
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

// ── 줄바꿈 덩어리 (그릴 때만 — 글 함수·서버와 같은 글은 그대로) ─────────────

/**
 * 줄바꿈 덩어리: 그 안에서는 줄이 바뀌지 않는 조각 묶음. SegText 가 덩어리마다 한 줄짜리 글로 그려 flexWrap 줄에 놓으므로
 * 줄은 덩어리 사이(공백 자리)에서만 바뀐다 — 안드로이드는 한글을 음절마다 끊을 수 있어 '비 / 슷 2'·'미 10년 / 물'·'(마이크로소프 / 트'·
 * '지수와 차 / 이'처럼 낱말이 갈라졌다 (예전에는 보이지 않는 묶음 글자로 흐린 조각만 묶어, 흐리지 않은 이름표·종목 이름은 갈라졌다).
 * 글자는 하나도 바꾸지 않으므로(보이지 않는 글자 없음) 화면 읽기 문장도 그대로다
 */
export type Chunk = Seg[];

/** 앞 덩어리 끝에 붙이는 구분자 (줄 첫머리에 오지 않게) */
const SEPARATORS = new Set(["·", "/"]);
/** 숫자로 시작하는 낱말 ('7'·'+3.18%p)'·'12종목'·'10년물') 또는 괄호 속 날짜만 ('(9/23)') */
const NUMERIC_START = /^(?:[+\-−]?\d|\(\d{1,2}\/\d{1,2}\)$)/;
/** 시각 뒤에 붙여 한 덩어리로 두는 말 ('08:30 생성'·'16:30 마감'·'(16:00 기준)'·'10:00 개장,' — '생성'만 다음 줄로 넘어가지 않게) */
const AFTER_TIME = /^(?:생성|마감|기준|개장|발표)[)·,]?$/;

type Piece = { kind: "text"; text: string; seg: Seg } | { kind: "space" };

/**
 * 줄 조각을 줄바꿈 덩어리로 나눈다. 덩어리를 ' '로 이으면 원래 글(앞뒤 공백 뺀)과 같다.
 * 공백은 줄바꿈 자리지만, 다음은 덩어리 안에 묶는다:
 *  - 한글 이름표 뒤 숫자: '비슷 7'·'높음 2'·'차이 +3.18%p)'·'국내 5종목'·'코스피 7,080.92'·'10년물 5.17%'·'코스피 (9/23)'
 *  - 등락 숫자(색 조각) 앞: '나스닥 +0.48%'·'5.17% -0.01%p'·'1,359.00원 +3.50원'·'(마이크로소프트 +3.66%,'
 *  - 흐린 조각(출처·기준 괄호) 안: '(미 재무부)'·'(섹터 ETF 기준)'·'(9/23 고시)'·'9/25 기준 ·' (앞뒤 공백은 줄바꿈 자리)
 *  - 한 글자 낱말 뒤: '내 미국'·'미 10년물'·'강 산업재'·'약 커뮤니케이션'·'장 마감', 줄 끝 한 글자 낱말·개수 앞: '±1%p 안'·'(+1.00%p 이상) 2'
 *  - 시각 뒤 '생성·마감·기준·개장·발표': '08:30 생성'·'16:30 마감'·'(16:00 기준)'
 *  - 구분자 '·'·'/'와 받지 못한 칸 '—' 앞: 앞 덩어리 끝에 붙인다
 */
export function chunkSegs(segs: readonly Seg[]): Chunk[] {
  const pieces: Piece[] = [];
  for (const s of segs) {
    if (s.muted) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text)!;
      if (m[1]) pieces.push({ kind: "space" });
      if (m[2]) pieces.push({ kind: "text", text: m[2], seg: s });
      if (m[3]) pieces.push({ kind: "space" });
      continue;
    }
    s.text.split(" ").forEach((part, i) => {
      if (i > 0) pieces.push({ kind: "space" });
      if (part) pieces.push({ kind: "text", text: part, seg: s });
    });
  }
  const textAt = (k: number) => {
    const p = pieces[k];
    return p?.kind === "text" ? p.text : null;
  };
  /** i 번째 공백 앞 낱말 (공백 사이의 글 조각을 이은 것) */
  const wordBefore = (i: number) => {
    let w = "";
    for (let k = i - 1; textAt(k) !== null; k--) w = textAt(k)! + w;
    return w;
  };
  /** i 번째 공백 뒤 낱말과, 그것이 줄의 마지막 낱말인지 */
  const wordAfter = (i: number) => {
    let w = "";
    let k = i + 1;
    for (; textAt(k) !== null; k++) w += textAt(k)!;
    return { w, last: !pieces.slice(k).some((p) => p.kind === "text") };
  };
  const glued = (i: number): boolean => {
    const before = wordBefore(i);
    const next = pieces[i + 1];
    if (!before || next?.kind !== "text") return false;
    const after = wordAfter(i);
    if (SEPARATORS.has(after.w) || after.w === "—") return true;
    if (SEPARATORS.has(before)) return false;
    if (next.seg.tone !== undefined) return true;
    if (/\d{1,2}:\d{2}$/.test(before) && AFTER_TIME.test(after.w)) return true;
    if (/[가-힣]$/.test(before) && NUMERIC_START.test(after.w)) return true;
    if (/^[가-힣]$/.test(before)) return true;
    return after.last && /^(?:[가-힣]|\d+)$/.test(after.w);
  };
  const chunks: Chunk[] = [];
  let cur: Seg[] = [];
  const add = (text: string, seg: Seg) => {
    const last = cur[cur.length - 1];
    if (last && last.tone === seg.tone && !!last.muted === !!seg.muted) cur[cur.length - 1] = { ...last, text: last.text + text };
    else cur.push({ text, ...(seg.tone !== undefined ? { tone: seg.tone } : {}), ...(seg.muted ? { muted: true } : {}) });
  };
  pieces.forEach((p, i) => {
    if (p.kind === "text") add(p.text, p.seg);
    else if (glued(i)) add(" ", (pieces[i - 1] as { seg: Seg }).seg);
    else if (cur.length) {
      chunks.push(cur);
      cur = [];
    }
  });
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** 덩어리 하나의 글 */
export const chunkText = (c: Chunk) => c.map((s) => s.text).join("");

/** 줄바꿈 덩어리 사이 간격 (dp) = 그 글자 크기의 띄어쓰기 폭 어림. size = 글자 크기, scale = 글자 배율 */
export function wordGap(size: number, scale: number): number {
  return Math.max(2, Math.round(size * scale * 0.27));
}

// ── 카드 지수 칸 배치 ─────────────────────────────────────────

/**
 * 글자 폭 어림 (글자 크기 1 에 대한 배수, 넉넉히): 숫자·부호 0.6, 쉼표·마침표·쌍점·공백 0.3, % 0.9, 한글 1.0, 그 밖 0.65.
 * 숫자 칸이 말줄임 없이 들어가는지 볼 때만 쓴다 ('+0.48%' 16dp×130% ≈ 75 — 실측 74.3)
 */
export function textEm(s: string): number {
  let em = 0;
  for (const ch of s) em += /[0-9+\-−]/.test(ch) ? 0.6 : /[.,: ]/.test(ch) ? 0.3 : ch === "%" ? 0.9 : /[가-힣]/.test(ch) ? 1 : 0.65;
  return em;
}

// ── 카드 뉴스 한 줄 자르기 ─────────────────────────────────────

/**
 * 글자 폭 어림 표 (글자 크기 1 에 대한 배수). 2026-09 실측 — 안드로이드가 라틴 글자·숫자·문장 부호를 그리는 Roboto(글꼴 목록 첫 글꼴이 그 글자를 가지면
 * 늘 그것으로 그린다)와 웹 미리보기의 Segoe UI 에서 잰 폭 가운데 넓은 값을 둘째 자리에서 올렸다. 한글은 두 곳 모두 Noto Sans CJK KR(= Noto Sans KR) 0.92.
 * (8차 검토: 한글을 1.0·문장 부호를 1.0 으로 넉넉히 잡아 줄 끝에 4~5자만큼 빈 곳이 남던 것을 줄임.) 숫자 0.57, 공백 0.28, '…' 0.74(Roboto 0.67·Segoe 0.73),
 * '·' 0.27, '%' 0.82. 표에 없는 글자(한자·전각 괄호·'‥'·'⋯'·화살표 — 안드로이드에서 Roboto 에 없어 CJK 글꼴로 그린다)는 1.0.
 * 기기 글꼴이 이보다 넓으면 카드 뉴스 줄은 안드로이드에서 글자를 조금 줄여 넣는다 (adjustsFontSizeToFit — 숫자 가운데서 잘리지 않게)
 */
const ASCII_EM: Readonly<Record<string, number>> = (() => {
  const t: Record<string, number> = { " ": 0.28, "!": 0.29, '"': 0.4, "#": 0.62, $: 0.57, "%": 0.82, "&": 0.8, "'": 0.23, "(": 0.35, ")": 0.35, "*": 0.44, "+": 0.69, ",": 0.22, "-": 0.4, ".": 0.27, "/": 0.42 };
  Object.assign(t, { ":": 0.25, ";": 0.22, "<": 0.69, "=": 0.69, ">": 0.69, "?": 0.48, "@": 0.96, "[": 0.31, "\\": 0.41, "]": 0.31, "^": 0.69, _: 0.46, "`": 0.31, "{": 0.34, "|": 0.25, "}": 0.34, "~": 0.69 });
  for (const d of "0123456789") t[d] = 0.57;
  const upper = [0.66, 0.63, 0.66, 0.71, 0.57, 0.56, 0.69, 0.72, 0.28, 0.56, 0.63, 0.54, 0.9, 0.75, 0.76, 0.64, 0.76, 0.62, 0.6, 0.6, 0.69, 0.64, 0.94, 0.63, 0.61, 0.6];
  const lower = [0.55, 0.59, 0.53, 0.59, 0.53, 0.35, 0.59, 0.57, 0.25, 0.25, 0.51, 0.25, 0.88, 0.57, 0.59, 0.59, 0.59, 0.35, 0.52, 0.34, 0.57, 0.49, 0.76, 0.5, 0.49, 0.5];
  upper.forEach((v, i) => (t[String.fromCharCode(65 + i)] = v));
  lower.forEach((v, i) => (t[String.fromCharCode(97 + i)] = v));
  return t;
})();
const OTHER_EM: Readonly<Record<string, number>> = { "’": 0.23, "‘": 0.23, "“": 0.38, "”": 0.38, "…": 0.74, "·": 0.27, "–": 0.66, "•": 0.41, "×": 0.69, "÷": 0.69, "±": 0.69, "°": 0.38, "€": 0.57, "£": 0.59, "¥": 0.54, "″": 0.38, "′": 0.23 };
const HANGUL_EM = 0.92;
/**
 * 폭 없는 글자·방향 표시 (U+200B~U+200F·U+2060·U+FEFF) — 폭 0 으로 센다 (SS3/SS7). 서버는 뜻 없는 U+200B·U+2060·U+FEFF 만 제목에서 지우고
 * ZWJ·ZWNJ·방향 표시(글자 모양을 바꿈)는 두므로, 그것들과 예전 저장본에 남은 글자도 여기서 폭 0
 */
const isInvisible = (c: number) => (c >= 0x200b && c <= 0x200f) || c === 0x2060 || c === 0xfeff;
/** 글자 하나의 폭 어림 */
export function charEm(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3131 && c <= 0x318e)) return HANGUL_EM;
  if (isInvisible(c)) return 0;
  return ASCII_EM[ch] ?? OTHER_EM[ch] ?? 1;
}
/** 눈에 보이는 글자 수 (폭 없는 글자는 세지 않는다 — NEWS_MIN_HEAD·언론사 머리 조건이 보이지 않는 글자로 채워지지 않게) */
export function visibleLength(s: string): number {
  let n = 0;
  for (const ch of s) if (!isInvisible(ch.codePointAt(0) ?? 0)) n++;
  return n;
}
/** 뉴스 제목 한 줄의 글자 폭 어림 (글자 크기 1 에 대한 배수) */
export function lineEm(s: string): number {
  let em = 0;
  for (const ch of s) em += charEm(ch);
  return em;
}

/** 반올림·줄 폭 버림에 남기는 여유 (글자 크기 배수 — 14dp 에서 약 2.8dp. 표 값이 두 글꼴 가운데 넓은 쪽이라 실제 글은 대개 이보다 더 좁다) */
export const NEWS_FIT_MARGIN_EM = 0.2;
/** 아주 좁은 칸에서도 제목 앞부분을 이만큼(글자 수)은 보인다 — 한 줄에 이보다 적게 들어가면 두 줄로 */
export const NEWS_MIN_HEAD = 8;
/** 두 줄로 놓을 때 첫 줄 끝에서 낱말째 넘어가며 비는 폭 어림 */
const WRAP_SLACK_EM = 3;

/**
 * 제목 속 숫자 덩어리 (부호·▲▼ + 숫자·쉼표·소수점 + 붙은 단위·화살표): '0.48%↑'·'7,080선'·'▲90.71p'·'1.21%↓'·'2.4조'·'15:30'.
 * (8차 검토 must) 만·천·억·조·년·월·시 뒤에 숫자가 이어지면(띄어 써도) 한 덩어리: '2만7000선'·'2조4907억원'·'27만3000원'·'7만 8581달러'·
 * '1조 5000억'·'3시30분'·'9월 26일' — '나스닥 2만…'·'외국인 2조…'처럼 틀린 값으로 읽히는 자리에서 끊지 않게
 */
const TITLE_NUMBER_RE =
  /[+\-−▲▼△▽]?\d[\d,.:]*(?:%p|%|bp|pt|p|P|포인트|선|원|달러|엔|위안|유로|루피아|배|만|천|억|조|년|월|일|시|분|초|위|대|개|명|주|건|곳|종)*(?:(?<=[만천억조년월시])\s?\d[\d,.:]*(?:%p|%|bp|pt|p|P|포인트|선|원|달러|엔|위안|유로|루피아|배|만|천|억|조|년|월|일|시|분|초|위|대|개|명|주|건|곳|종)*)*[↑↓]?/g;
/** 제목 속 숫자 덩어리 자리 (끝이 숫자인지 함께) — 테스트도 쓴다 */
export function titleNumbers(title: string): { start: number; end: number; digitEnd: boolean }[] {
  return [...title.matchAll(TITLE_NUMBER_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, digitEnd: /\d$/.test(m[0]) }));
}
/** 끊은 자리 끝에 남기지 않을 글자 (띄어쓰기·구분자 '·'·'ㆍ'(U+318D)·'∙'·'‧'·여는 괄호·점 말줄임 '...') */
const TRAILING_CUT_RE = /(?:[\s·ㆍ∙‧,…⋯‥\-–—([{【<|/]|\.{2,})+$/;

/**
 * 낱말 글자 (한글·자모·영문·숫자, 'S&P'·'M&A'의 &) — 이 글자끼리 붙은 자리에서 끊으면 낱말 가운데다.
 * 자모 범위에서 'ㆍ'(U+318D, 아래아 — 제목에서는 '우려ㆍ국채금리'처럼 가운뎃점으로 쓴다)는 뺀다: '·'처럼 낱말 사이 구분자 (검증 보정 2)
 */
const WORD_CHAR_RE = /[가-힣ㄱ-\u318C\u318EA-Za-z0-9&]/;
/** 끊은 자리 앞의 낱말 조각 (마지막 띄어쓰기·문장 부호 뒤) */
const WORD_TAIL_RE = /[가-힣ㄱ-\u318C\u318EA-Za-z0-9&]+$/;
/** 끊은 자리 뒤에 남는 낱말 나머지 (다음 띄어쓰기·문장 부호 앞까지) */
const WORD_HEAD_RE = /^[가-힣ㄱ-\u318C\u318EA-Za-z0-9&]+/;
/** 한글 음절 하나 */
const HANGUL_CHAR_RE = /[가-힣]/;
/** 낱말 조각 끝의 한글 덩어리 ('SK하이'의 '하이', '원익IPS까'의 '까') */
const HANGUL_TAIL_RE = /[가-힣]+$/;
/**
 * 끊은 자리 뒤가 이 토씨뿐이면 앞 조각은 온전한 낱말일 수 있다 ('영업점|에'·'코스피|는' — 물리지 않는다).
 * 헷갈리지 않는 토씨만 둔다 (검증 must): 가·이·도·의·과·만 등은 흔한 낱말의 끝 음절이기도 해서('유|가'·'주|가'·'추|가'·'순매|도'·'속|도'·'합|의'·
 * '최고|가'·'닛케|이') '유…'·'주…'처럼 조각이 남았다
 */
const PARTICLE_RE = /^(?:은|는|을|를|에|에서|으로|로|와|에게)$/;
/** 두 음절 토씨의 가운데 ('실현으|로'·'거래소에|서'·'투자자에|게') — 끊은 자리 앞 글자 + 뒤 글자 */
const SPLIT_PARTICLE_RE = /^(?:으로|에서|에게)$/;
/** '상승하|는'·'결정되|는'처럼 풀이말 줄기 뒤의 '는·은'은 토씨가 아니다 (앞 조각이 낱말이 아님) */
const VERB_STEM_END_RE = /[하되]$/;
/**
 * 토씨 예외: 끊은 자리 앞 조각(frag, 끝 한글 덩어리 run)이 뒤(rest) 토씨 앞의 온전한 낱말인지 — 뒤가 헷갈리지 않는 토씨뿐이고,
 * 한글 덩어리가 두 음절 이상이거나('영업점|에'·'강세|에') 영문·숫자 머리에 한글이 붙은 낱말('AI주|는'·'10월|에'·'HD현대|로')일 때.
 * 한 음절 한글 조각('만|에'·'제|로')과 풀이말 줄기('상승하|는')는 낱말로 보지 않는다
 */
function beforeParticle(frag: string, run: string, rest: string): boolean {
  if (!run || !PARTICLE_RE.test(rest)) return false;
  if ((rest === "는" || rest === "은") && VERB_STEM_END_RE.test(run)) return false;
  return Array.from(run).length >= 2 || frag.length > run.length;
}
/**
 * 낱말 가운데서 끊을 때 이 글자 수 이하 조각이 남으면 그 낱말 앞에서 끊는다 (SS1/SS9: '…상승 마감…다…'·'…랠리…나스…'·'반도체·석…').
 * 조각 전체가 아니라 끝의 한글 덩어리(뒤가 한글일 때)·영문·숫자 덩어리(뒤가 영문·숫자일 때)로 잰다 (검증 보정 2 must: 'SK하이|닉스'·'원익IPS까|지'는
 * 영문까지 세면 4·6자라 '…SK하이…'·'…원익IPS까…'가 남았다 — isOrphan)
 */
export const NEWS_ORPHAN_MAX = 3;

/** 낱말 조각 끝의 영문·숫자 덩어리 ('원익IP'의 'IP') */
const LATIN_TAIL_RE = /[A-Za-z0-9&]+$/;
/**
 * 끊은 자리(cut) 앞 낱말 조각이 그 낱말 앞으로 물려야 할 조각인지. 조각 끝에서 뒤 글자(원문)와 같은 글자 갈래의 덩어리로 잰다 —
 * 뒤가 한글이면 끝 한글 덩어리의 음절 수(영문·숫자 머리는 세지 않음 — 'SK하이|닉스'는 '하이' 2음절, '원익IPS까|지'는 '까' 1음절),
 * 뒤가 영문·숫자면 끝 영문·숫자 덩어리의 글자 수('원익IP|S'는 'IP' 2자, 'Acquis|ition'은 6자). 그 덩어리가 없으면(글자 갈래가 바뀌는 자리
 * 'SK|하이닉스'·'원익|IPS') 조각 전체의 글자 수. NEWS_ORPHAN_MAX 이하이고 토씨 예외가 아니면 물린다
 */
function isOrphan(frag: string, next: string, rest: string): boolean {
  const hangul = HANGUL_TAIL_RE.exec(frag)?.[0] ?? "";
  const run = HANGUL_CHAR_RE.test(next) ? hangul : (LATIN_TAIL_RE.exec(frag)?.[0] ?? "");
  return Array.from(run || frag).length <= NEWS_ORPHAN_MAX && !beforeParticle(frag, hangul, rest);
}

/**
 * avail(글자 크기 배수) 안에 드는 가장 긴 앞부분 — 숫자 덩어리 안이거나 숫자로 끝나는 덩어리 바로 뒤면 그 덩어리 앞에서.
 * 낱말 가운데서 끊게 되면: 남는 조각(마지막 띄어쓰기·문장 부호 뒤)이 짧으면(isOrphan — 한글 낱말은 끝 한글 덩어리가 NEWS_ORPHAN_MAX 음절 이하)
 * 그 낱말 앞(영문·숫자 머리까지 — 'SK하이|닉스'는 'SK하이닉스' 앞)에서 끊는다
 * ('…상승 마감…다우'를 '…상승 마감…다…'가 아니라 '…상승 마감…'으로 — '다'로 끝난 문장처럼 읽히지 않게). 조각이 더 길면('Acquis…') 그대로 두어
 * 줄 끝 빈 곳을 작게 한다. 끊은 자리 뒤가 헷갈리지 않는 토씨뿐이고 앞 조각이 낱말이면('영업점|에') 두고(beforeParticle), 두 음절 토씨 가운데면
 * ('실현으|로') 토씨 앞으로 한 글자 물린다. 물린 뒤 남는 앞부분이 NEWS_MIN_HEAD 자보다 짧아지면 물리지 않는다 (아주 좁은 칸). 규칙들은 더 바뀌지 않을 때까지
 * 번갈아 본다 — 숫자 앞으로 물린 자리가 낱말 가운데이거나 낱말 앞으로 물린 자리가 숫자 덩어리 안일 수 있다 ('다우·S&P500' → 'S&P…'가 아니라 '다우…')
 */
function cutTitle(title: string, avail: number): string {
  const chars = Array.from(title);
  let k = 0;
  let em = 0;
  while (k < chars.length && em + charEm(chars[k]!) <= avail) em += charEm(chars[k++]!);
  let head = chars.slice(0, k).join("");
  const numbers = titleNumbers(title);
  for (;;) {
    head = head.replace(TRAILING_CUT_RE, "");
    const cut = head.length;
    const hit = numbers.find((n) => n.start < cut && (cut < n.end || (cut === n.end && n.digitEnd)));
    if (hit) {
      head = title.slice(0, hit.start);
      continue;
    }
    // 두 음절 토씨 가운데('…실현으|로')면 토씨를 통째로 넘긴다 — '…실현으…'가 아니라 '…실현…' (그 뒤 '실현|으로'는 토씨 예외로 본다)
    if (cut > 1 && HANGUL_CHAR_RE.test(head[cut - 2]!) && SPLIT_PARTICLE_RE.test(head[cut - 1]! + (title[cut] ?? "")) && visibleLength(head) > NEWS_MIN_HEAD) {
      head = head.slice(0, -1);
      continue;
    }
    // 낱말 가운데: 앞 글자와 뒤 글자(원문)가 모두 낱말 글자
    if (cut > 0 && WORD_CHAR_RE.test(title[cut] ?? "") && WORD_CHAR_RE.test(head[cut - 1]!)) {
      const frag = WORD_TAIL_RE.exec(head);
      const rest = WORD_HEAD_RE.exec(title.slice(cut))?.[0] ?? "";
      if (frag && frag.index > 0 && isOrphan(frag[0], title[cut]!, rest)) {
        const before = head.slice(0, frag.index).replace(TRAILING_CUT_RE, "");
        if (visibleLength(before) >= NEWS_MIN_HEAD) {
          head = before;
          continue;
        }
      }
    }
    break;
  }
  return head;
}

/** 카드 뉴스 제목 줄: 보일 글과 줄 수 (보통 1, 아주 좁은 칸에서만 2) */
export interface NewsFit {
  text: string;
  lines: 1 | 2;
}

/**
 * 카드 뉴스 제목 한 줄 (7차·8차 검토): 제목만 한 줄에 둔다 (언론사·시각은 상세에 — 화면 읽기는 카드 문장이 함께 읽는다).
 * 줄 폭(width dp)에 들어가지 않으면 말줄임을 안드로이드 한 줄 말줄임(글자 단위)에 맡기지 않고 여기서 자른다 — 잘릴 자리가 숫자(와 붙은 %·선·p·원·↑ 등,
 * '2만7000선' 같은 복합 수 전체) 안이거나 숫자 바로 뒤면 그 숫자 앞에서 끊고 '…'. 폭은 lineEm(실측 어림) + 여유 NEWS_FIT_MARGIN_EM 로 잰다.
 * 한 줄에 제목 앞부분이 NEWS_MIN_HEAD 자보다 적게 남는 아주 좁은 칸(큰 글씨 + 좁은 창)에서만 두 줄로 놓는다 ('…'만 남지 않게).
 * size = 글자 크기, scale = 글자 배율
 */
export function fitNewsTitle(title: string, width: number, size: number, scale: number): NewsFit {
  const room = width / (size * scale);
  if (!(room > 0) || lineEm(title) <= room - NEWS_FIT_MARGIN_EM) return { text: title, lines: 1 };
  const ell = charEm("…");
  const one = cutTitle(title, room - ell - NEWS_FIT_MARGIN_EM);
  if (visibleLength(one) >= NEWS_MIN_HEAD) return { text: `${one}…`, lines: 1 };
  const room2 = 2 * room - 2 * NEWS_FIT_MARGIN_EM - WRAP_SLACK_EM;
  if (lineEm(title) <= room2) return { text: title, lines: 2 };
  let two = cutTitle(title, room2 - ell);
  if (visibleLength(two) < NEWS_MIN_HEAD) {
    // 그래도 모자라면 앞 NEWS_MIN_HEAD 자(보이는 글자) — 그 자리가 숫자 덩어리 안이면 덩어리 끝까지 (숫자를 가르지 않게)
    let k = 0;
    for (let seen = 0; k < title.length && seen < NEWS_MIN_HEAD; ) {
      const ch = String.fromCodePoint(title.codePointAt(k)!);
      if (visibleLength(ch)) seen++;
      k += ch.length;
    }
    const hit = titleNumbers(title).find((n) => n.start < k && k < n.end);
    two = title.slice(0, hit ? hit.end : k).replace(TRAILING_CUT_RE, "");
  }
  return { text: two.length < title.length ? `${two}…` : title, lines: 2 };
}

/** 언론사 머리와 제목 사이 */
export const NEWS_OUTLET_SEP = " · ";

/**
 * 잘린 앞부분(head — title 의 앞부분)이 낱말 사이에서 끝나는지: 끊은 자리 앞 글자와 뒤 글자(원문)가 둘 다 낱말 글자면 낱말 가운데라 false
 * ('·'·'ㆍ'는 구분자 — '우려ㆍ|국채금리'는 낱말 사이). 테스트·측정이 쓴다
 */
export function cutAtWordEnd(title: string, head: string): boolean {
  if (!head || !title.startsWith(head)) return false;
  if (head.length >= title.length) return true;
  return !(WORD_CHAR_RE.test(head.slice(-1)) && WORD_CHAR_RE.test(title[head.length]!));
}

/** 카드 뉴스 줄: 흐린 언론사 머리(없으면 null) + 제목 글과 줄 수 */
export interface NewsLineFit extends NewsFit {
  outlet: string | null;
}

/**
 * 카드 뉴스 한 줄 (SS5·SS11): 줄 앞에 흐린 언론사 머리('연합뉴스 · ')를 붙여 누가 쓴 제목인지 카드에서도 보이게 한다. 시각은 상세에만.
 * 머리는 머리를 붙이고도 제목 전체가 한 줄에 들어갈 때만 붙인다 (검증 보정 2 — 머리가 제목 끝의 방향 낱말·숫자를 밀어내지 않게:
 * 예전 '아주경제 · [뉴욕증시 마감] 美국채 금리·유가 상승에 일제히…'는 제목만이면 '…일제히 하락…'까지 보였다). 아니면 제목만 (fitNewsTitle —
 * 잘려도 그 규칙 그대로). 그래서 머리가 붙은 줄은 늘 제목 전체다. 두 줄 모드(아주 좁은 칸)에는 붙이지 않는다
 */
export function fitNewsLine(n: Pick<SummaryNews, "title" | "outlet">, width: number, size: number, scale: number): NewsLineFit {
  const plain = fitNewsTitle(n.title, width, size, scale);
  const outlet = (n.outlet ?? "").trim();
  if (outlet && plain.lines === 1 && plain.text === n.title) {
    const room = width / (size * scale);
    if (lineEm(`${outlet}${NEWS_OUTLET_SEP}${n.title}`) <= room - NEWS_FIT_MARGIN_EM) return { text: n.title, lines: 1, outlet };
  }
  return { ...plain, outlet: null };
}

/** 지수 칸 종가 줄: 아침 '27,068.72', 오후 '7,080.92 · +63.01' */
export function indexValueLine(i: Pick<SummaryIndex, "value" | "change">, market: SummaryMarket): string | null {
  if (i.value === null) return null;
  const change = market === "KR" && i.change !== null ? ` · ${sign(i.change)}${idx2(Math.abs(i.change))}` : "";
  return `${idx2(i.value)}${change}`;
}

/**
 * 지수 칸을 한 줄에 몇 개씩 놓을지 (카드 4칸·2칸, compact = 넓은 창 목록 줄의 작은 칸).
 * 칸 안에 이름·등락률·종가가 말줄임 없이 들어가면 한 줄에 모두, 아니면 두 줄(4칸 → 2×2), 그래도 안 되면 한 줄에 하나.
 * width = 칸들이 놓일 폭(dp), scale = 글자 배율(fontCap.row 까지) — 울트라 411·글자 130%에서 4칸이면 '+0.48%'가 '+0.4…'로 잘렸다
 */
export function indexCellCols(d: Pick<MarketSummaryData, "indices" | "market">, width: number, scale: number, compact = false): number {
  const n = d.indices.length;
  if (n <= 1) return Math.max(n, 1);
  const need =
    Math.max(
      ...d.indices.map((i) =>
        Math.max(
          textEm(i.name) * (compact ? font.tiny : font.small),
          textEm(i.changeRate === null ? "—" : rateText(i.changeRate)) * (compact ? font.body : font.h2),
          compact ? 0 : textEm(indexValueLine(i, d.market) ?? "") * font.tiny,
        ),
      ),
    ) * scale;
  for (const cols of [n, Math.ceil(n / 2)]) {
    const inner = (width - (cols - 1) * MSK.cellGap) / cols - 2 * MSK.cellPadX;
    if (inner >= need) return cols;
  }
  return 1;
}

/**
 * 지수 이름 아래 시각: 미국은 출처 시각 '뉴욕 17:15'·'뉴욕 16:39'(출처가 값을 마지막으로 고친 현지 시각 — 저장한 시각 문자열 그대로, 최종값인지 볼 수 있게),
 * 한국은 그 값의 마감 '15:30 마감'(수능일 '16:30 마감'), 장중 요약이면 출처 시각 '서울 16:00'. 모르면 null
 */
export function indexSourceTime(i: Pick<SummaryIndex, "asOf">, d: Pick<MarketSummaryData, "market" | "phase" | "closeTime">): string | null {
  // 한국 지수는 15:30(수능일 16:30) 마감에 확정된 값인데 네이버가 값을 다시 적는 시각은 20:15 무렵이라, 출처 시각을 보이면
  // 애프터마켓 값으로 오해할 수 있다 — 장중 요약이 아니면 그 값의 마감 시각을 보인다 (미국은 최종값 시각이 뜻이 있어 그대로)
  if (d.market === "KR" && d.phase !== "intraday") return `${d.closeTime} 마감`;
  const m = /T(\d{2}):(\d{2})/.exec(i.asOf ?? "");
  return m ? `${d.market === "US" ? "뉴욕" : "서울"} ${m[1]}:${m[2]}` : null;
}

// ── 상세 표 배치 ──────────────────────────────────────────────

/** 표 한 줄의 좌우 안쪽 여백 합(space.lg ×2)과 칸 사이 간격(space.sm) — MarketSummaryBody 의 tr 스타일과 같다 */
const ROW_PAD = space.lg * 2;
const COL_GAP = space.sm;

/**
 * '내 보유 종목과 지수' 표 배치. width = 표(카드) 폭 dp, scale = 글자 배율(fontCap.row 까지, 숫자 칸 폭도 이만큼 늘린다).
 *  - full: 종목 | 등락률 | 비교 지수 | 차이 (목업)
 *  - compact: 종목(아래 줄에 비교 지수) | 등락률 | 차이 — 이름 칸이 nameMinW 보다 좁아질 때 (펼친 세로 두 칸·울트라 바깥 화면·큰 글씨)
 */
export function holdingsTableMode(width: number, scale: number): "full" | "compact" {
  const need = ROW_PAD + COL_GAP * 3 + (MSK.colRate + MSK.colBench + MSK.colDiff + MSK.nameMinW) * scale;
  return width >= need ? "full" : "compact";
}

/** '주요 지수' 표 배치: full = 지수 | 종가 | 전일 대비 | 등락률, compact = 지수 | 종가(아래 줄에 전일 대비) | 등락률 */
export function indicesTableMode(width: number, scale: number): "full" | "compact" {
  const need = ROW_PAD + COL_GAP * 3 + (MSK.colValue + MSK.colChange + MSK.colRate + MSK.indexNameMinW) * scale;
  return width >= need ? "full" : "compact";
}

/**
 * 상세 본문 한 칸의 폭 어림 (onLayout 으로 실제 폭을 받기 전 첫 그림에 쓴다 — 받으면 그 값으로 바꾼다).
 * stack = 창 폭, split = 창 폭의 절반(두 칸), pane = 브리핑 탭 2단 오른쪽 칸(창 폭 − 목록 칸 − 구분선)
 */
export function bodyWidthGuess(windowW: number, layout: "stack" | "split" | "pane"): number {
  if (layout === "split") return Math.floor((windowW - LK.divider) / 2);
  if (layout === "pane") return Math.max(0, windowW - LK.listPaneW - LK.divider);
  return windowW;
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
    .replace(/±(\d+(?:\.\d+)?)%p/g, "플러스마이너스 $1%포인트")
    // 금리 전일 대비는 지수와의 차이가 아니라 움직임이다: '미 10년물 5.17% -0.01%p' → '… 0.01%포인트 하락' ('낮음'으로 읽지 않게)
    .replace(/(미 10년물 \d[\d.]*%) ([+-])(\d[\d.]*)%p/g, (_m, head: string, s: string, n: string) => `${head} ${speakPointMove(`${s}${n}%p`)}`)
    .replace(/([+-])(\d[\d,]*\.?\d*)%p/g, (_m, s: string, n: string) => `${n}%포인트 ${s === "+" ? "높음" : "낮음"}`)
    .replace(/([+-])(\d[\d,]*\.?\d*)%/g, (_m, s: string, n: string) => `${n}% ${s === "+" ? "상승" : "하락"}`)
    .replace(/([+-])(\d[\d,]*\.?\d*)원/g, (_m, s: string, n: string) => `${n}원 ${s === "+" ? "상승" : "하락"}`)
    // 받지 못한 지수 칸 '나스닥 —' 만 '받지 못함'으로 (안내 문단의 줄표 ' — ' 는 쉼표로)
    .replace(/ —(?= ·|$)/g, " 받지 못함")
    .replace(/ — /g, ", ")
    .replace(/ · /g, ", ")
    .replace(/ \/ /g, ", ");
}

/** 금리처럼 %p 로 적은 '움직임'을 말로: '-0.01%p' → '0.01%포인트 하락', '+0.02%p' → '0.02%포인트 상승' */
export function speakPointMove(text: string): string {
  return text.replace(/([+-])(\d[\d.]*)%p/g, (_m, s: string, n: string) => `${n}%포인트 ${s === "+" ? "상승" : "하락"}`);
}

/**
 * 카드·목록 줄을 한 문장으로. card = 브리핑 탭 맨 위 카드: 카드에 보이는 뉴스 제목(언론사·시각·원문 제목)도 읽는다 —
 * 카드 전체가 누르는 칸 하나라 화면 읽기 사용자는 이 문장으로만 카드를 듣는다 (제목은 원문 그대로, 기호를 말로 바꾸지 않는다)
 */
export function cardSpeech(s: MarketSummary, view: Date, opts: { card?: boolean } = {}): string {
  const d = s.data;
  const when = `${md(s.date)} ${s.session === "afternoon" ? "오후" : "오전"}`;
  if (s.status === "failed" || !d) return `시장 요약, ${when}, 생성 실패, 자세히 보기`;
  const news = opts.card ? cardRows(d, view).find((r) => r.kind === "news") : undefined;
  const lines = summaryLines(d, view).map((l) => (l.kind === "news" && news?.kind === "news" ? newsSpeech(news, d) : speakText(l.text)));
  return [titleText(d, view), when, speakText(basisText(d, view)), ...lines, "숫자로 만든 요약, 매매 권유가 아닙니다", "자세히 보기"].join(", ");
}

/** 카드 뉴스 칸을 말로: '뉴스 3건, 뉴스1 9/26 05:32, <원문 제목>, KBS 9/26 05:22, <원문 제목>, 외 1건' */
function newsSpeech(r: Extract<CardRow, { kind: "news" }>, d: Pick<MarketSummaryData, "news" | "date">): string {
  const items = r.items.map((n) => `${n.outlet} ${newsTime(n, d.date)}, ${n.title}`);
  return [`뉴스 ${d.news.items.length}건`, ...items, ...(r.more ? [`외 ${r.more}건`] : [])].join(", ");
}
