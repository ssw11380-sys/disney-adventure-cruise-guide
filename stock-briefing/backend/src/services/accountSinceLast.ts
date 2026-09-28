import { weightPct, type AccountData, type AccountOneSide, type AccountPosition, type AccountQtyChange, type AccountSinceLast, type AccountWeightChange } from "./accountNumbers.js";

/**
 * 브리핑 3차 3 — 지난 브리핑과 비교 (플래그 accountSinceLast). DB·네트워크를 모르는 순수 함수.
 * 계좌 브리핑 두 건(같은 세션 — 어제 오전 ↔ 오늘 오전)이 저장한 숫자끼리 비교한다: 같은 기준(비용 차감·그때의 적용 환율)·같은 시각대.
 * 매매 기록(3-36 스냅샷)은 장 마감 뒤 값이라 브리핑 시각과 맞지 않아 쓰지 않는다.
 *  - 총 평가금액·평가손익: 지난 → 이번, 차이 (총 평가는 변화율도)
 *  - 수량이 바뀐 종목: 새 종목·없어진 종목·늘어남·줄어듦 (수량으로 판단 — 시세가 없어 합계에서 뺀 종목도 수량이 같으면 바뀌지 않은 것)
 *  - 비중 변화: 두 브리핑 모두 값이 있는 종목의 비중(종목 평가 ÷ 총 평가, 소수 한 자리) 차이가 0.5%p 이상인 것, 큰 순 3개
 *  - 지난 브리핑에 종목별 값(positions)이 없으면(배포 첫날) 종목별 변화는 null
 *  - 한쪽 브리핑 합계에서만 빠진 종목(두 브리핑 모두 보유 — 한쪽에서만 시세·환율을 받지 못함)은 금액·비중 비교에서 양쪽 모두 뺀다(scope common).
 *    그대로 빼면 값이 그대로여도 '총 평가 -1,000,000원 · 삼성전자 60.0% → 66.7%' 같은 가짜 변화가 생긴다. 종목별 값이 없어 뺄 수 없으면 scope mixed
 */

/** 비교할 지난 브리핑을 찾는 기간 (날짜 차이, 이 날수 안이면 비교) */
export const SINCE_LAST_DAYS = 10;
/** 비중 변화 문턱 (%p, 보이는 두 값의 차) */
export const WEIGHT_MIN_PP = 0.5;
/** 비중 변화 줄 수 */
export const WEIGHT_TOP = 3;

/** 비교에 쓰는 칸 (계좌 브리핑 data 의 일부) */
export type SinceLastInput = Pick<AccountData, "session" | "date" | "asOf" | "totalValue" | "totalProfit" | "excluded"> & { positions?: AccountPosition[] | undefined };

/** 부동소수 오차 안에서 같은 수량 (소수 주식 0.1 + 0.2 ↔ 0.3) */
const EPS = 1e-9;
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

type Excluded = SinceLastInput["excluded"] | undefined;

export function compareSinceLast(prev: { id: number; data: SinceLastInput }, now: SinceLastInput): AccountSinceLast {
  const p = prev.data;
  const both = p.positions && now.positions ? { prev: p.positions, now: now.positions } : null;
  const oneSide = both ? oneSideOf(both.prev, both.now, p.excluded, now.excluded) : excludedDiff(p.excluded, now.excluded);
  const scope: AccountSinceLast["scope"] = oneSide.length === 0 ? "all" : both ? "common" : "mixed";
  // 금액: common 이면 한쪽 합계에만 들어 있는 종목의 값·평가손익을 그 합계에서 뺀다 (positions 의 값 합 = 합계, 매입 합 = 매입금액 — 정확히 나눠 저장)
  let vFrom = p.totalValue;
  let vTo = now.totalValue;
  let pFrom = p.totalProfit;
  let pTo = now.totalProfit;
  if (scope === "common" && both) {
    const before = new Map(both.prev.map((x) => [x.code, x]));
    const after = new Map(both.now.map((x) => [x.code, x]));
    for (const o of oneSide) {
      const x = o.side === "now" ? before.get(o.code) : after.get(o.code);
      if (!x || x.value === null) continue;
      const pnl = x.value - (x.cost ?? x.value);
      if (o.side === "now") {
        vFrom -= x.value;
        pFrom -= pnl;
      } else {
        vTo -= x.value;
        pTo -= pnl;
      }
    }
  }
  const change = vTo - vFrom;
  const out: AccountSinceLast = {
    prev: { id: prev.id, date: p.date, session: p.session, asOf: p.asOf },
    value: { from: vFrom, to: vTo, change, rate: vFrom > 0 ? round2((change / vFrom) * 100) : null },
    profit: { from: pFrom, to: pTo, change: pTo - pFrom },
    positions: null,
    weights: null,
    excludedNow: (now.excluded ?? []).map((e) => ({ code: e.code, name: e.name })),
    // 저장된 JSON 이라 칸이 빠진 기록이 있어도 비교는 한다
    excludedPrev: (p.excluded ?? []).map((e) => ({ code: e.code, name: e.name })),
    scope,
    oneSide,
  };
  if (!both) return out;
  out.positions = qtyChanges(both.prev, both.now);
  // 비중의 분모도 같은 범위(한쪽에만 들어 있는 종목을 뺀 합계) — 빠진 종목 때문에 다른 종목 비중이 바뀌어 보이지 않게
  out.weights = weightChanges(both.prev, vFrom, both.now, vTo);
  return out;
}

/** 합계에서 뺀 이유 → 시세(price) 또는 환율(fx). 이유를 모르면 시세 */
function whyOf(excluded: Excluded, code: string): AccountOneSide["why"] {
  const r = (excluded ?? []).find((e) => e.code === code)?.reason ?? "";
  return /환율/.test(r) ? "fx" : "price";
}

/** 두 브리핑 모두 보유했는데 한쪽 합계에서만 빠진 종목 (지금 목록 순서). 새 종목·없어진 종목은 그 브리핑에만 있어 수량 변화로 말한다 */
function oneSideOf(prev: AccountPosition[], now: AccountPosition[], prevEx: Excluded, nowEx: Excluded): AccountOneSide[] {
  const before = new Map(prev.map((x) => [x.code, x]));
  const out: AccountOneSide[] = [];
  for (const x of now) {
    const b = before.get(x.code);
    if (!b || (b.value === null) === (x.value === null)) continue;
    out.push(x.value === null ? { code: x.code, name: x.name, side: "now", why: whyOf(nowEx, x.code) } : { code: x.code, name: x.name, side: "prev", why: whyOf(prevEx, x.code) });
  }
  return out;
}

/** 종목별 값이 없을 때: 두 브리핑의 합계에서 뺀 종목 목록이 다른 것 (이번에만 → now, 지난번에만 → prev) */
function excludedDiff(prevEx: Excluded, nowEx: Excluded): AccountOneSide[] {
  const p = prevEx ?? [];
  const n = nowEx ?? [];
  const inPrev = new Set(p.map((e) => e.code));
  const inNow = new Set(n.map((e) => e.code));
  return [
    ...n.filter((e) => !inPrev.has(e.code)).map((e) => ({ code: e.code, name: e.name, side: "now" as const, why: whyOf(n, e.code) })),
    ...p.filter((e) => !inNow.has(e.code)).map((e) => ({ code: e.code, name: e.name, side: "prev" as const, why: whyOf(p, e.code) })),
  ];
}

function qtyChanges(prev: AccountPosition[], now: AccountPosition[]): NonNullable<AccountSinceLast["positions"]> {
  const before = new Map(prev.map((x) => [x.code, x]));
  const after = new Map(now.map((x) => [x.code, x]));
  const added: AccountQtyChange[] = [];
  const increased: AccountQtyChange[] = [];
  const decreased: AccountQtyChange[] = [];
  for (const x of now) {
    const b = before.get(x.code);
    if (!b) added.push({ code: x.code, name: x.name, from: 0, to: x.quantity });
    else if (x.quantity > b.quantity + EPS) increased.push({ code: x.code, name: x.name, from: b.quantity, to: x.quantity });
    else if (x.quantity < b.quantity - EPS) decreased.push({ code: x.code, name: x.name, from: b.quantity, to: x.quantity });
  }
  const removed = prev.filter((x) => !after.has(x.code)).map((x) => ({ code: x.code, name: x.name, from: x.quantity, to: 0 }));
  return { added, removed, increased, decreased };
}

function weightChanges(prev: AccountPosition[], prevTotal: number, now: AccountPosition[], nowTotal: number): AccountWeightChange[] {
  if (!(prevTotal > 0) || !(nowTotal > 0)) return [];
  const before = new Map(prev.map((x) => [x.code, x]));
  const rows: Array<AccountWeightChange & { raw: number; i: number }> = [];
  now.forEach((x, i) => {
    const b = before.get(x.code);
    if (x.value === null || !b || b.value === null) return;
    const fromRaw = (b.value / prevTotal) * 100;
    const toRaw = (x.value / nowTotal) * 100;
    // 보이는 비중은 비중 한 줄(exposureOf)과 같은 정확한 반올림 (21.35 → 21.4)
    const from = weightPct(b.value, prevTotal);
    const to = weightPct(x.value, nowTotal);
    // 보이는 두 값의 차 (원 값의 차를 반올림하면 '18.2% → 18.8% (+0.5%p)'처럼 화면 안에서 어긋날 수 있다)
    const diff = round1(to - from);
    if (Math.abs(diff) + EPS < WEIGHT_MIN_PP) return;
    rows.push({ code: x.code, name: x.name, from, to, change: diff, raw: toRaw - fromRaw, i });
  });
  // 큰 순: 보이는 변화 → 원 값의 변화(부동소수 오차는 같은 것으로) → 지금 목록 순서(먼저 등록한 종목)
  const rawDiff = (a: { raw: number }, b: { raw: number }) => {
    const d = Math.abs(b.raw) - Math.abs(a.raw);
    return Math.abs(d) > EPS ? d : 0;
  };
  return rows
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || rawDiff(a, b) || a.i - b.i)
    .slice(0, WEIGHT_TOP)
    .map(({ code, name, from, to, change }) => ({ code, name, from, to, change }));
}
