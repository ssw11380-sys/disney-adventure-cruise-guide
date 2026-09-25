import type { Currency, RegisteredWithQuote } from "@/api/types";
import { sentence, speakAmount } from "@/lib/a11y";
import { formatWon, isUsMarket } from "@/lib/format";
import { evalView } from "@/lib/liveTick";
import { fxOf } from "@/lib/portfolio";

/**
 * 비중 보기 (플래그 allocationView): 잔고를 국내·해외 / 통화 / 업종 / 종목으로 나눈 원화 비중.
 * React Native 를 불러오지 않는 순수 모듈 (단위 테스트). 사실(금액·비중)만 보여 주고 판단 문구는 넣지 않는다.
 *
 * 금액은 잔고 탭 총 평가금액과 같은 기준에서 나온다 (portfolio.summarize 와 같은 evalView·환율·비용 차감 설정):
 *  - 평가금액은 (설정 시) 수수료·세금 차감 후, 해외 종목은 그 종목 시세의 환율(fxOf)로 원화 환산
 *  - 환율을 모르는 해외 종목이 하나라도 있으면 잔고 탭 합계가 "원화 종목"만이므로 여기서도 원화 종목만 센다
 *  - 수량이 있는데 시세·평가가 없는 종목은 잔고 합계에 없으므로 빼고, 몇 종목인지 알린다
 * 비중은 소수 첫째 자리로 최대 나머지 방식 반올림을 해 차트마다 합이 정확히 100.0 이다.
 * 금액도 같은 방식으로 원 단위를 맞춰, 차트마다 합이 화면의 총 평가금액(원 단위 반올림)과 같다.
 */

export type AllocationKind = "market" | "currency" | "industry" | "stock";

export interface Slice {
  key: string;
  label: string;
  /** 원화 평가금액 (원 단위). 차트 안 합 = Allocation.total */
  won: number;
  /** 비중 % (소수 첫째 자리). 차트 안 합 = 100.0 */
  pct: number;
  /** 이 조각에 든 종목 수 */
  count: number;
  /** 색 칸 번호 (0부터, 토큰 t.chart.pie). null 이면 회색(t.chart.pieOther) */
  slot: number | null;
  /** 작은 조각을 모은 '기타' */
  other: boolean;
}

export interface AllocationChart {
  kind: AllocationKind;
  title: string;
  slices: Slice[];
}

export interface Allocation {
  /** 원화 합계 (원 단위) = 잔고 탭 총 평가금액 */
  total: number;
  /** 환율을 모르는 해외 종목이 있어 원화 종목만 합쳤다 (잔고 탭의 "총 평가금액 (원화 종목)"과 같은 경우) */
  krwOnly: boolean;
  /** 비중에 들어간 종목 수 */
  count: number;
  /** 뺀 종목 수: 시세 없음 · 평가금액 없음(평단 미입력 등) · 환율 없음(해외) */
  excluded: { noQuote: number; noEval: number; noFx: number };
  /** 국내·해외 → 통화 → 업종 → 종목 순. 들어간 종목이 없으면 빈 배열 */
  charts: AllocationChart[];
}

/** 색을 칠하는 칸 수 (tokens 의 chart.pie 길이와 같다). 8번째 조각부터와 '기타'는 회색 */
export const PIE_SLOTS = 7;
/** 업종은 큰 순으로 7개, 나머지는 '기타' */
export const TOP_INDUSTRY = 7;
/** 종목은 큰 순으로 10개, 나머지는 '기타' */
export const TOP_STOCK = 10;
export const UNKNOWN_INDUSTRY = "업종 정보 없음";
export const OTHER_LABEL = "기타";

export const CHART_TITLE: Record<AllocationKind, string> = {
  market: "국내 / 해외",
  currency: "통화",
  industry: "업종",
  stock: "종목별",
};

/**
 * 최대 나머지 방식 반올림: 값의 비율대로 정수 target 을 나눠, 합이 정확히 target 이 되게 한다.
 * 나머지가 같으면 값이 큰 쪽, 그것도 같으면 앞쪽이 먼저 1 을 받는다. 합이 0 이면 모두 0
 */
export function apportion(values: number[], target: number): number[] {
  const vs = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = vs.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || !(target > 0)) return vs.map(() => 0);
  const raw = vs.map((v) => (v / sum) * target);
  const out = raw.map((r) => Math.floor(r));
  let left = target - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || vs[b.i]! - vs[a.i]! || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k]!.i]! += 1;
  return out;
}

interface Item {
  code: string;
  name: string;
  us: boolean;
  currency: Currency;
  industry: string | null;
  value: number;
}

interface Group {
  key: string;
  label: string;
  value: number;
  count: number;
  slot: number | null;
  other: boolean;
}

/** 묶음 → 원·비중을 맞춘 조각 */
function toSlices(groups: Group[], total: number): Slice[] {
  const values = groups.map((g) => g.value);
  const won = apportion(values, total);
  const tenths = apportion(values, 1000);
  return groups.map((g, i) => ({ key: g.key, label: g.label, won: won[i]!, pct: tenths[i]! / 10, count: g.count, slot: g.slot, other: g.other }));
}

/** 같은 키끼리 더한다 (처음 나온 순서 유지) */
function sumBy(items: Item[], keyOf: (x: Item) => string): Map<string, { value: number; count: number }> {
  const m = new Map<string, { value: number; count: number }>();
  for (const x of items) {
    const k = keyOf(x);
    const g = m.get(k) ?? { value: 0, count: 0 };
    g.value += x.value;
    g.count += 1;
    m.set(k, g);
  }
  return m;
}

/** 이름이 정해진 두 묶음(국내·해외, 원화·달러): 색은 묶음마다 고정 (값이 바뀌어도 같은 색) */
function fixedChart(kind: AllocationKind, items: Item[], total: number, defs: { key: string; label: string; test: (x: Item) => boolean }[]): AllocationChart {
  const groups: Group[] = [];
  defs.forEach((d, slot) => {
    const xs = items.filter(d.test);
    if (xs.length) groups.push({ key: d.key, label: d.label, value: xs.reduce((a, x) => a + x.value, 0), count: xs.length, slot, other: false });
  });
  return { kind, title: CHART_TITLE[kind], slices: toSlices(groups, total) };
}

const byValue = (a: { value: number; label: string }, b: { value: number; label: string }) => b.value - a.value || a.label.localeCompare(b.label, "ko");

/** 업종: 큰 순 7개(업종 정보 없음도 한 묶음으로 겨룸, 자리는 이름 있는 업종 뒤) + 기타 */
function industryChart(items: Item[], total: number): AllocationChart {
  const sums = sumBy(items, (x) => x.industry ?? "");
  const all = [...sums].map(([k, g]) => ({ key: k || "unknown", label: k || UNKNOWN_INDUSTRY, value: g.value, count: g.count, unknown: !k })).sort(byValue);
  const top = all.slice(0, TOP_INDUSTRY);
  const rest = all.slice(TOP_INDUSTRY);
  const ordered = [...top.filter((g) => !g.unknown), ...top.filter((g) => g.unknown)];
  const groups: Group[] = ordered.map((g, i) => ({ key: g.key, label: g.label, value: g.value, count: g.count, slot: i < PIE_SLOTS ? i : null, other: false }));
  if (rest.length) groups.push({ key: "other", label: OTHER_LABEL, value: rest.reduce((a, g) => a + g.value, 0), count: rest.reduce((a, g) => a + g.count, 0), slot: null, other: true });
  return { kind: "industry", title: CHART_TITLE.industry, slices: toSlices(groups, total) };
}

/** 종목: 큰 순 10개 + 기타. 색은 앞 7개까지 (색이 많으면 서로 구분되지 않아 8번째부터는 회색) */
function stockChart(items: Item[], total: number): AllocationChart {
  const sorted = items.map((x) => ({ key: x.code, label: x.name, value: x.value })).sort(byValue);
  const top = sorted.slice(0, TOP_STOCK);
  const rest = sorted.slice(TOP_STOCK);
  const groups: Group[] = top.map((x, i) => ({ ...x, count: 1, slot: i < PIE_SLOTS ? i : null, other: false }));
  if (rest.length) groups.push({ key: "other", label: OTHER_LABEL, value: rest.reduce((a, x) => a + x.value, 0), count: rest.length, slot: null, other: true });
  return { kind: "stock", title: CHART_TITLE.stock, slices: toSlices(groups, total) };
}

/** 잔고 목록 → 네 가지 비중 (afterCost 는 잔고 탭과 같은 설정값) */
export function allocation(list: RegisteredWithQuote[], afterCost: boolean): Allocation {
  const excluded = { noQuote: 0, noEval: 0, noFx: 0 };
  // 잔고 합계(summarize)에 들어가는 종목: 평가와 시세가 모두 있는 것
  const held: RegisteredWithQuote[] = [];
  for (const s of list) {
    const owned = (s.quantity ?? 0) > 0 || !!s.evaluation;
    if (!owned) continue; // 관심 종목
    if (!s.quote) excluded.noQuote += 1;
    else if (!s.evaluation) excluded.noEval += 1;
    else held.push(s);
  }
  // 환율을 모르는 해외 종목이 하나라도 있으면 잔고 탭도 원화 종목만 합친다 → 같은 기준
  const curOf = (s: RegisteredWithQuote): Currency => s.quote!.currency ?? "KRW";
  const krwOnly = held.some((s) => curOf(s) === "USD" && !fxOf(s));
  const items: Item[] = [];
  for (const s of held) {
    const cur = curOf(s);
    if (krwOnly && cur === "USD") {
      excluded.noFx += 1;
      continue;
    }
    const v = evalView(s.evaluation, { afterCost, toKrw: true, currency: cur, fx: fxOf(s) });
    if (!v) continue;
    const industry = s.quote!.industry?.trim() || null;
    items.push({ code: s.code, name: s.name, us: isUsMarket(s.market), currency: cur, industry, value: Math.max(0, v.marketValue) });
  }
  const total = Math.round(items.reduce((a, x) => a + x.value, 0));
  const charts: AllocationChart[] = items.length
    ? [
        fixedChart("market", items, total, [
          { key: "domestic", label: "국내", test: (x) => !x.us },
          { key: "overseas", label: "해외", test: (x) => x.us },
        ]),
        fixedChart("currency", items, total, [
          { key: "KRW", label: "원화", test: (x) => x.currency === "KRW" },
          { key: "USD", label: "달러", test: (x) => x.currency === "USD" },
        ]),
        industryChart(items, total),
        stockChart(items, total),
      ]
    : [];
  return { total, krwOnly, count: items.length, excluded, charts };
}

/** 원 차트 조각 하나의 각도 (라디안, 12시 방향 0, 시계 방향). full = 조각이 하나뿐이라 고리 전체 */
export interface Arc {
  start: number;
  end: number;
  full: boolean;
}

/**
 * 원 차트 조각 각도. 조각 사이에 gap(라디안)만큼 바탕색 틈을 둔다 — 닿는 조각을 선 대신 틈으로 가른다.
 * 값이 0 이거나 틈보다 좁은 조각은 null (그리지 않고 범례에만 남는다)
 */
export function donutArcs(values: number[], gap: number): (Arc | null)[] {
  const vs = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const sum = vs.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return vs.map(() => null);
  const live = vs.filter((v) => v > 0).length;
  let acc = 0;
  return vs.map((v) => {
    const from = acc;
    acc += v;
    if (!v) return null;
    if (live === 1) return { start: 0, end: 2 * Math.PI, full: true };
    const start = (from / sum) * 2 * Math.PI + gap / 2;
    const end = (acc / sum) * 2 * Math.PI - gap / 2;
    return end > start ? { start, end, full: false } : null;
  });
}

/** 반지름 r 인 원 위의 호 (SVG path). 선 굵기로 고리 두께를 낸다 */
export function arcPath(cx: number, cy: number, r: number, a: Arc): string {
  const pt = (t: number) => `${(cx + r * Math.sin(t)).toFixed(2)} ${(cy - r * Math.cos(t)).toFixed(2)}`;
  if (a.full) return `M ${pt(0)} A ${r} ${r} 0 1 1 ${pt(Math.PI)} A ${r} ${r} 0 1 1 ${pt(0)}`;
  return `M ${pt(a.start)} A ${r} ${r} 0 ${a.end - a.start > Math.PI ? 1 : 0} 1 ${pt(a.end)}`;
}

/** 뺀 종목 안내 한 줄: "시세 없는 1종목 제외". 없으면 null */
export function excludedNote(ex: Allocation["excluded"]): string | null {
  const parts = [
    ex.noQuote ? `시세 없는 ${ex.noQuote}종목` : null,
    ex.noEval ? `평가금액 없는 ${ex.noEval}종목` : null,
    ex.noFx ? `환율 정보가 없는 해외 ${ex.noFx}종목` : null,
  ].filter((p): p is string => !!p);
  return parts.length ? `${parts.join(" · ")} 제외` : null;
}

/** 비중 표기: 소수 첫째 자리 "62.3%" */
export const pctText = (pct: number): string => `${pct.toFixed(1)}%`;

/** 차트 한 개를 화면 읽기용 한 문장으로: "국내 62.3%, 해외 37.7%" */
export function chartSummary(c: AllocationChart): string {
  return c.slices.map((s) => `${s.label} ${pctText(s.pct)}`).join(", ");
}

/** 범례 한 줄을 한 문장으로: "삼성전자, 720,000원, 비중 39.8%" · "기타, 3종목, 120,000원, 비중 2.1%" */
export function sliceLabel(s: Slice): string {
  return sentence([s.label, s.count > 1 ? `${s.count}종목` : null, speakAmount(formatWon(s.won)), `비중 ${pctText(s.pct)}`]);
}
