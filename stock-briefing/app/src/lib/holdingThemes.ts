import type { HoldingThemes, HoldingThemesSnapshot, HtGroup, HtHolding, HtKind, HtMarket, HtMarketInfo } from "@/api/types";
import { sentence, speakClock, speakRate } from "./a11y";
import { speakDay } from "./accountSinceLast";
import { formatDateKo, formatPct } from "./format";

/**
 * 내 종목 테마 (3-35, 플래그 holdingThemes) 보기 모델 — React Native 를 불러오지 않는 순수 모듈 (테스트가 문구를 그대로 본다).
 * 사실만: 등락률·오른/내린/보합 수·거래대금 평소 대비·든 내 종목. 좋다·나쁘다로 읽히는 말(강세·약세·수혜·주목 …)은 쓰지 않고, 색은 등락률 글자에만
 */

export type HtPeriod = "day" | "week";

export const KIND_LABEL: Record<`${HtMarket}:${HtKind}`, string> = { "US:theme": "미국 테마", "US:sector": "미국 업종", "KR:theme": "한국 테마", "KR:sector": "한국 업종" };
export const MARKET_LABEL: Record<HtMarket, string> = { US: "미국", KR: "한국" };
export const PERIOD_LABEL: Record<HtPeriod, string> = { day: "오늘", week: "1주" };
export const SCREEN_TITLE = "내 종목 테마";
export const MOST_TITLE = "내 종목이 많이 속한 테마";
export const TOP_TITLE = "등락률 높은 3개";
export const BOTTOM_TITLE = "등락률 낮은 3개";
export const UNMAPPED_TITLE = "연결하지 못한 종목";
export const BY_HOLDING_TITLE = "종목별로 보기";
export const NOT_IN_LIST_NOTE = "발견 탭 목록에는 없는 테마(거래대금 100만 달러 미만)";
export const NOT_IN_CALC_NOTE = "등락률 계산에는 안 듦";
export const OFF_TITLE = "이 기능은 지금 꺼져 있습니다";
export const EMPTY_TITLE = "보유 종목이 없습니다";
export const EMPTY_HINT = "종목을 사면(또는 보유 수량을 넣으면) 그 종목이 속한 테마를 보여 드립니다.";
export const ERROR_TITLE = "내 종목 테마를 불러오지 못했습니다";
export const ERROR_HINT = "연결을 확인하고 다시 시도하세요.";
export const PREPARING_LINE = "테마 목록을 처음 준비하는 중입니다 (약 2분). 준비된 시장부터 보여 드립니다.";
export const CARD_BUTTON = "지금 기준으로 전체 보기";
/** 내 종목 줄 머리: 1주 칩에서도 내 종목 등락률은 오늘 값이라 기간을 밝힌다 (테마 1주 등락률과 섞여 보이지 않게) */
export const MINE_LABEL = "내 종목";
export const MINE_LABEL_TODAY = "내 종목 (오늘)";
export const HALTED_TEXT = "거래정지";
export const NO_QUOTE_TEXT = "시세 없음";
/** 구성 종목이 300개 넘는 업종 (발견 탭 상세가 등락률 상위만 줌 — 날마다 더하는 종목이 달라 평소와 견주지 않음) */
export const TV_TRUNCATED_TEXT = "거래대금 평소 비교 없음 (구성 종목이 300개가 넘는 업종)";
/** 테마·업종에 연결한 보유 종목이 하나도 없을 때 (카드 제목·칩 없이 한 줄) */
export function noneLinkedText(held: number): string {
  return `보유 ${held}종목 중 테마·업종에 연결한 종목이 없습니다`;
}
/** 내 테마 전체가 이보다 많으면 앞의 ALL_SHOWN 개만 보이고 '나머지 N개 더 보기' (한국 대형주는 테마가 수십 개) */
export const ALL_FOLD_OVER = 12;
export const ALL_SHOWN = 10;
export function moreRowsText(n: number): string {
  return `나머지 ${n}개 더 보기`;
}
/** 한 줄에 보이는 내 종목 수 (넘으면 '외 N종목') */
export const HOLDINGS_SHOWN = 3;

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** 'YYYY-MM-DD' → '9/26(금)' (그 날짜 그대로 — 미국 날짜도 바꾸지 않음) */
export function dayShort(ymd: string | null | undefined): string {
  const m = ymd ? /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd) : null;
  if (!m) return "";
  const wd = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${Number(m[2])}/${Number(m[3])}(${WEEKDAY[wd]})`;
}

/** 등락률 글자 (−0 없음, 값 없으면 '-') */
export function rateText(v: number | null | undefined): string {
  return formatPct(v);
}

/** 내 종목 표시 이름: 레버리지·인버스·지수 상품은 'SOXL(반도체 지수 3배)' · 'SOXS(반도체 지수 -3배)' · 'RGTX(리게티 컴퓨팅 2배)' */
export function holdingLabel(h: Pick<HtHolding, "code" | "name" | "via">): string {
  const v = h.via;
  if (!v) return h.name;
  const L = v.L === null ? "" : ` ${v.inverse ? "-" : ""}${v.L}배`;
  return `${h.code}(${v.name}${L})`;
}

/** 내 종목 등락률 글자: 거래정지(설계 E10) · 시세 없음 · '+1.20%' */
function holdingRateText(h: Pick<HtHolding, "changeRate" | "halted">): string {
  if (h.halted) return HALTED_TEXT;
  return h.changeRate === null ? NO_QUOTE_TEXT : rateText(h.changeRate);
}

/** 화면 읽기용 내 종목 이름 ('RGTX, 리게티 컴퓨팅 2배 상품') */
function holdingSpeech(h: HtHolding): string {
  const v = h.via;
  const name = v ? `${h.code}, ${v.name} ${v.inverse ? "마이너스 " : ""}${v.L ?? ""}배 상품` : h.name;
  return sentence([name, h.halted ? HALTED_TEXT : h.changeRate === null ? NO_QUOTE_TEXT : speakRate(h.changeRate), h.inCalc === false ? NOT_IN_CALC_NOTE : null]);
}

/** 거래대금 평소 대비 한 줄 (설계 2-A) */
export function tvText(tv: HtGroup["tradingValue"]): string {
  if (tv.truncated) return TV_TRUNCATED_TEXT;
  const pct = tv.ratioPct === null ? null : tv.ratioPct > 1000 ? "1,000% 넘음" : `${tv.ratioPct.toLocaleString("en-US")}%`;
  switch (tv.state) {
    case "collecting":
      return `거래대금 평소 비교 · 기록 모으는 중 (${Math.min(tv.days, 5)}/5거래일)`;
    case "none":
      return "거래대금 값 없음";
    case "final":
      return pct ? `거래대금 평소의 ${pct}` : "거래대금 값 없음";
    case "partial":
      return pct ? `거래대금 지금까지 평소 하루의 ${pct}` : "거래대금 값 없음";
    case "lastDay":
      return pct ? `거래대금 ${dayShort(tv.day)} 평소의 ${pct}` : "거래대금 값 없음";
  }
}

/**
 * 거래대금 줄의 화면 읽기 (평소가 20일보다 적게 모였으면 몇 거래일 평균인지 밝힘).
 * 날짜 '9/25(금)'·분수 '(3/5거래일)'는 '25분의 9'처럼 읽히지 않게 말로 바꾼다 (speakDay — 3-49·다가오는 일정과 같은 규칙)
 */
export function tvSpeech(tv: HtGroup["tradingValue"]): string {
  let base = tvText(tv);
  if (tv.state === "collecting" && !tv.truncated) base = `거래대금 평소 비교, 기록 모으는 중, 5거래일 중 ${Math.min(tv.days, 5)}거래일`;
  else if (tv.state === "lastDay" && tv.day && !tv.truncated) base = base.replace(dayShort(tv.day), speakDay(tv.day));
  base = base.replace(/%/g, "퍼센트").replace(/ · /g, ", ");
  return tv.ratioPct !== null && tv.days > 0 && tv.days < 20 ? `${base}, 최근 ${tv.days}거래일 평균 기준` : base;
}

export interface HoldingPart {
  label: string;
  rate: number | null;
  rateText: string;
  note: string | null;
}

export interface ThemeRowView {
  key: string;
  name: string;
  market: HtMarket;
  rate: number | null;
  rateText: string;
  kindLine: string;
  tvLine: string | null;
  /** '내 종목' — 1주 칩이면 '내 종목 (오늘)' (내 종목 등락률은 늘 오늘 정규장 값) */
  mineLabel: string;
  holdings: HoldingPart[];
  /** '외 2종목' (없으면 0) */
  more: number;
  note: string | null;
  speech: string;
  href: string;
}

function strengthOf(g: HtGroup, period: HtPeriod) {
  return period === "day" ? g.day : g.week;
}

/** 테마 한 줄 (설계 2.2 ⑤) */
export function rowView(g: HtGroup, period: HtPeriod): ThemeRowView {
  const s = strengthOf(g, period);
  const rate = s?.changeRate ?? null;
  const kind = KIND_LABEL[`${g.market}:${g.kind}`];
  const breadth = s && s.up !== null && s.down !== null && s.flat !== null ? `오른 ${s.up} · 내린 ${s.down} · 보합 ${s.flat}` : null;
  const shown = g.holdings.slice(0, HOLDINGS_SHOWN);
  const holdings: HoldingPart[] = shown.map((h) => ({ label: holdingLabel(h), rate: h.halted ? null : h.changeRate, rateText: holdingRateText(h), note: h.inCalc === false ? NOT_IN_CALC_NOTE : null }));
  const mineLabel = period === "week" ? MINE_LABEL_TODAY : MINE_LABEL;
  const more = Math.max(0, g.holdings.length - HOLDINGS_SHOWN);
  const tvLine = period === "day" ? tvText(g.tradingValue) : null;
  const note = g.market === "US" && g.kind === "theme" && !g.inDiscoverList ? NOT_IN_LIST_NOTE : null;
  const speech = `${sentence([
    g.name,
    kind,
    `${PERIOD_LABEL[period]} ${rate === null ? "등락률 없음" : (speakRate(rate) ?? "")}`,
    s && s.up !== null ? `오른 종목 ${s.up}개` : null,
    s && s.down !== null ? `내린 종목 ${s.down}개` : null,
    s && s.flat !== null ? `보합 ${s.flat}개` : null,
    tvLine ? tvSpeech(g.tradingValue) : null,
    // 1주 칩: 테마는 1주 등락률, 내 종목은 오늘 등락률 — 읽을 때도 기간을 밝힌다
    `${period === "week" ? "내 종목 오늘 등락률" : "내 종목"} ${g.holdings.map(holdingSpeech).join(", ")}`,
    note,
  ])}. 누르면 발견 탭 테마 상세`;
  const href = `/discover/theme/${encodeURIComponent(g.id)}?market=${g.market}&kind=${g.kind}&name=${encodeURIComponent(g.name)}&period=${period}&rate=${rate ?? ""}`;
  return { key: g.key, name: g.name, market: g.market, rate, rateText: rateText(rate), kindLine: breadth ? `${kind} · ${breadth}` : kind, tvLine, mineLabel, holdings, more, note, speech, href };
}

/** 등락률 높은 순 (같으면 이름순, 값 없음은 맨 뒤) — 서버 holdingThemesCalc.topBottom 과 같은 규칙 */
function sortByRate(rows: ThemeRowView[]): ThemeRowView[] {
  return [...rows].sort((a, b) => {
    if (a.rate === null && b.rate === null) return a.name.localeCompare(b.name, "ko");
    if (a.rate === null) return 1;
    if (b.rate === null) return -1;
    return b.rate - a.rate || a.name.localeCompare(b.name, "ko");
  });
}

export interface MarketView {
  market: HtMarket;
  rows: ThemeRowView[];
  /** 값 있는 묶음이 6개 이상이면 높은 3개·낮은 3개(낮은 것부터) */
  split: boolean;
  top: ThemeRowView[];
  bottom: ThemeRowView[];
  /** '내 테마 12개 · 등락률 높은 순' */
  allTitle: string;
}

export function marketView(d: HoldingThemes, market: HtMarket, period: HtPeriod): MarketView {
  const rows = sortByRate(d.groups.filter((g) => g.market === market).map((g) => rowView(g, period)));
  const ranked = rows.filter((r) => r.rate !== null);
  const split = ranked.length >= 6;
  return { market, rows, split, top: split ? ranked.slice(0, 3) : [], bottom: split ? ranked.slice(-3).reverse() : [], allTitle: `내 테마 ${rows.length}개 · 등락률 높은 순` };
}

/** 시장 칩 (묶음이 있는 시장만, 미국 먼저). 한 시장뿐이면 칩 없이 그 시장만 */
export function marketChips(d: HoldingThemes): { market: HtMarket; label: string; speech: string; count: number }[] {
  return (["US", "KR"] as const)
    .filter((m) => d.groups.some((g) => g.market === m))
    .map((m) => {
      const count = d.groups.filter((g) => g.market === m).length;
      return { market: m, label: `${MARKET_LABEL[m]} ${count}`, speech: `${MARKET_LABEL[m]}, 내 테마 ${count}개`, count };
    });
}

/** 처음 고를 시장: 기기에 기억한 시장(있고 묶음이 있으면) → 원화 보유액이 큰 시장 → 미국 */
export function defaultMarket(d: HoldingThemes, remembered: HtMarket | null): HtMarket | null {
  const chips = marketChips(d).map((c) => c.market);
  if (!chips.length) return null;
  if (remembered && chips.includes(remembered)) return remembered;
  if (chips.length === 1) return chips[0]!;
  return (d.markets.KR?.heldValue ?? 0) > (d.markets.US?.heldValue ?? 0) ? "KR" : "US";
}

export interface MostView {
  title: string;
  parts: { key: string; text: string }[];
  coverage: string;
  unmapped: string | null;
  speech: string;
}

/** 계좌 한 줄 카드 (설계 2.2 ①) */
export function mostView(d: HoldingThemes): MostView {
  const parts = d.mostHeld.map((m) => ({ key: m.key, text: `${m.name} ${m.count}종목` }));
  const coverage = `보유 ${d.coverage.held}종목 중 ${d.coverage.mapped}종목을 테마·업종에 연결했습니다`;
  const unmappedN = d.coverage.unmapped.length;
  return {
    title: MOST_TITLE,
    parts,
    coverage,
    unmapped: unmappedN ? `연결하지 못한 ${unmappedN}종목` : null,
    speech: `${sentence([MOST_TITLE, ...parts.map((p) => p.text)])}. 보유 ${d.coverage.held}종목 중 ${d.coverage.mapped}종목 연결`,
  };
}

/** 종목별로 보기 (설계 2.2 ⑦): '삼성전자 · 한국 테마 31개' + 그 묶음들을 등락률 순으로 */
export interface ByHoldingView {
  code: string;
  head: string;
  items: { name: string; rate: number | null; rateText: string }[];
  /** 한 종목 한 문장 (테마가 수십 개여도 화면 읽기가 한 번에 넘어가게) */
  speech: string;
}

export function byHoldingView(d: HoldingThemes, period: HtPeriod): ByHoldingView[] {
  const byKey = new Map(d.groups.map((g) => [g.key, g]));
  return d.byHolding.map((h) => {
    const gs = h.keys.map((k) => byKey.get(k)).filter((g): g is HtGroup => !!g);
    const counts = (["theme", "sector"] as const)
      .map((kind) => [kind, gs.filter((g) => g.kind === kind).length] as const)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => `${KIND_LABEL[`${h.market}:${kind}`]} ${n}개`);
    const items = sortByRate(gs.map((g) => rowView(g, period))).map((r) => ({ name: r.name, rate: r.rate, rateText: r.rateText }));
    const head = [h.name, ...counts].join(" · ");
    const speech = sentence([head.replace(/ · /g, ", "), `${PERIOD_LABEL[period]} 등락률 높은 순`, ...items.map((it) => `${it.name} ${it.rate === null ? "등락률 없음" : (speakRate(it.rate) ?? "")}`)]).replace(/%/g, "퍼센트");
    return { code: h.code, head, items, speech };
  });
}

// ── 계좌 브리핑 카드 (설계 2.3) ───────────────────────────────

export interface CardLine {
  key: string;
  head: string;
  parts: { name: string; rate: number | null; rateText: string | null }[];
  tail: string | null;
  speech: string;
}

function sessionWord(m: HtMarket, s: NonNullable<HoldingThemesSnapshot["markets"][HtMarket]>): string {
  const d = dayShort(s.basisDay);
  if (m === "US") return `미국 ${d} 정규장`.replace(/\s+/g, " ").trim();
  if (s.session === "regular") return `한국 ${d} 장중`.replace(/\s+/g, " ");
  if (s.session === "extended") return `한국 ${d} 시간외`.replace(/\s+/g, " ");
  // 장 시작 전(08:00~09:00): 값은 직전 거래일 것 (출처가 오늘 값을 아직 주지 않음)
  if (s.session === "pre") return "한국 장 시작 전 · 직전 거래일 값";
  return `한국 ${d} 마감`.replace(/\s+/g, " ");
}

/** 기준 줄의 시장 조각을 읽는 말로 ('미국 9/26(금) 정규장' → '미국 9월 26일 금요일 정규장') */
function sessionSpeech(m: HtMarket, s: NonNullable<HoldingThemesSnapshot["markets"][HtMarket]>): string {
  const w = sessionWord(m, s);
  return s.basisDay && dayShort(s.basisDay) ? w.replace(dayShort(s.basisDay), speakDay(s.basisDay)) : w;
}

/** 계좌 브리핑 상세 '내 종목 테마' 카드 줄 (저장한 값 그대로). 시장 묶음이 없으면 빈 줄 목록 */
export function accountThemesView(s: HoldingThemesSnapshot, asOfClock: string): { title: string; lines: CardLine[]; basis: string; basisSpeech: string; button: string } {
  const lines: CardLine[] = [];
  if (s.mostHeld.length) {
    const parts = s.mostHeld.map((m) => ({ name: `${m.name} ${m.count}종목`, rate: null, rateText: null }));
    lines.push({ key: "most", head: MOST_TITLE, parts, tail: null, speech: sentence([MOST_TITLE, ...parts.map((p) => p.name)]) });
  }
  for (const m of ["US", "KR"] as const) {
    const x = s.markets[m];
    if (!x || !x.top.length) continue;
    const toParts = (rows: { name: string; changeRate: number }[]) => rows.map((r) => ({ name: r.name, rate: r.changeRate, rateText: rateText(r.changeRate) }));
    const speak = (head: string, rows: { name: string; changeRate: number }[], tail: string | null) => sentence([head, ...rows.map((r) => `${r.name} ${speakRate(r.changeRate) ?? ""}`), tail]);
    if (x.split) {
      const th = `${MARKET_LABEL[m]} · ${TOP_TITLE}`;
      const bh = `${MARKET_LABEL[m]} · ${BOTTOM_TITLE}`;
      lines.push({ key: `${m}:top`, head: th, parts: toParts(x.top), tail: null, speech: speak(th, x.top, null) });
      lines.push({ key: `${m}:bottom`, head: bh, parts: toParts(x.bottom), tail: null, speech: speak(bh, x.bottom, null) });
    } else {
      const tail = x.more > 0 ? `외 ${x.more}개` : null;
      lines.push({ key: `${m}:all`, head: MARKET_LABEL[m], parts: toParts(x.top), tail, speech: speak(MARKET_LABEL[m], x.top, tail) });
    }
  }
  const basis = [
    `보유 ${s.coverage.held}종목 중 ${s.coverage.mapped}종목 연결`,
    ...(["US", "KR"] as const).filter((m) => s.markets[m]).map((m) => sessionWord(m, s.markets[m]!)),
    asOfClock ? `${asOfClock} 기준` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // 화면 읽기: '9/26(금)'·'08:38' 을 말로 ('26분의 9'처럼 읽히지 않게)
  const basisSpeech = sentence([
    `보유 ${s.coverage.held}종목 중 ${s.coverage.mapped}종목 연결`,
    ...(["US", "KR"] as const).filter((m) => s.markets[m]).map((m) => sessionSpeech(m, s.markets[m]!).replace(/ · /g, ", ")),
    asOfClock ? `${speakClock(asOfClock)} 기준` : null,
  ]);
  return { title: SCREEN_TITLE, lines, basis, basisSpeech, button: CARD_BUTTON };
}

/**
 * 화면 상태 줄 (발견 탭 상태 줄과 같은 말). 미국 장 마감이면 기준 거래일을 뉴욕 날짜로 밝히고 한국 시각은 괄호로 —
 * 거래대금 줄의 뉴욕 날짜('9/25(금)')와 한국 시각 날짜('9월 26일 (토)')가 서로 다른 날로 보이지 않게
 */
export function statusView(info: Pick<HtMarketInfo, "session" | "asOf" | "tvDay" | "note">, market: HtMarket): { text: string; speech: string; moving: boolean } {
  const s = info.session;
  const moving = s === "regular" || s === "extended";
  const label =
    s === "regular"
      ? "장중 · 1분마다 갱신"
      : s === "extended"
        ? "시간외 거래 반영 중 · 1분마다 갱신"
        : s === "pre"
          ? "장 시작 전 · 직전 거래일 기준"
          : market === "US"
            ? "장 마감 · 직전 정규장 기준"
            : "장 마감 · 마지막 거래 기준";
  const usDay = market === "US" && !moving && info.tvDay && dayShort(info.tvDay) ? info.tvDay : null;
  const when = info.asOf ? formatDateKo(info.asOf, true) : null;
  const text = [
    usDay ? `장 마감 · 미국 ${dayShort(usDay)} 정규장 기준` : label,
    when ? (usDay ? `한국 시각 ${when}` : `${when} 기준`) : null,
    info.note,
  ]
    .filter(Boolean)
    .join(" · ");
  const hm = info.asOf ? /T(\d{2}:\d{2})/.exec(info.asOf)?.[1] : undefined;
  const whenSpeech = info.asOf && hm ? `${speakDay(info.asOf.slice(0, 10))} ${speakClock(hm)}` : null;
  const speech = sentence([
    usDay ? `장 마감, 미국 ${speakDay(usDay)} 정규장 기준` : label.replace(/ · /g, ", "),
    whenSpeech ? (usDay ? `한국 시각 ${whenSpeech}` : `${whenSpeech} 기준`) : null,
    info.note,
  ]);
  return { text, speech, moving };
}

/** 내 종목 테마 다시 받기 간격 (ms, 없으면 false): 첫 준비 중이면 30초, 어느 시장이든 값이 바뀌는 시간(장중·시간외)이면 60초 */
export function holdingThemesEvery(d: HoldingThemes | null): number | false {
  const ms = d ? Object.values(d.markets) : [];
  if (ms.some((m) => m?.preparing)) return 30_000;
  return ms.some((m) => m && (m.session === "regular" || m.session === "extended")) ? 60_000 : false;
}

/** 앱이 쓰는 모든 고정 문구와 조합 (문구 검사 테스트용) */
export function allAppTexts(): string[] {
  const tv = (state: HtGroup["tradingValue"]["state"], ratioPct: number | null, days: number) => tvText({ today: 1, avg: 1, days, ratioPct, state, day: "2026-09-25", currency: "KRW" });
  const out = [
    SCREEN_TITLE,
    MOST_TITLE,
    TOP_TITLE,
    BOTTOM_TITLE,
    UNMAPPED_TITLE,
    BY_HOLDING_TITLE,
    NOT_IN_LIST_NOTE,
    NOT_IN_CALC_NOTE,
    OFF_TITLE,
    EMPTY_TITLE,
    EMPTY_HINT,
    ERROR_TITLE,
    ERROR_HINT,
    PREPARING_LINE,
    CARD_BUTTON,
    MINE_LABEL,
    MINE_LABEL_TODAY,
    HALTED_TEXT,
    NO_QUOTE_TEXT,
    TV_TRUNCATED_TEXT,
    noneLinkedText(2),
    moreRowsText(57),
    "내 종목 오늘 등락률",
    "장 마감 · 미국 9/25(금) 정규장 기준 · 한국 시각 9월 26일 (토) 05:00",
    ...Object.values(KIND_LABEL),
    "내 테마 12개 · 등락률 높은 순",
    "보유 17종목 중 15종목을 테마·업종에 연결했습니다",
    "연결하지 못한 2종목",
    "내 종목",
    "1분마다 갱신",
    "장중",
    "시간외 거래 반영 중",
    "장 시작 전 · 직전 거래일 기준",
    "장 마감 · 직전 정규장 기준",
    "장 마감 · 마지막 거래 기준",
    "내 종목 테마 보기",
    "테마",
  ];
  for (const st of ["final", "partial", "lastDay", "collecting", "none"] as const) for (const [r, d] of [[134, 20], [62, 12], [1234, 20], [null, 3]] as const) out.push(tv(st, r, d));
  return out;
}
