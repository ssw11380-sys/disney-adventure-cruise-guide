/**
 * 기간 수익률 (3-37, 플래그 tradeJournal) — 매일 장 마감 뒤 찍은 계좌 기록(스냅샷)으로 계산하는 시간가중 수익률(TWR). 순수 함수.
 *
 * 왜 시간가중인가: 중간에 돈을 더 넣거나(매수) 빼면(매도) 단순 수익률(끝 ÷ 시작 − 1)은 '벌어서 늘어난 것'과 '더 넣어서 늘어난 것'을 섞는다.
 * 시간가중은 사고판 금액을 빼고 구간마다의 수익률을 곱해 이어, 넣은 돈의 크기·시점에 흔들리지 않는다. 그래서 큰 숫자는 '수익률 (시간가중)',
 * 그 아래 '기간 손익'(실제 번 돈 = 끝 평가금액 − 시작 평가금액 − 매수 금액 + 매도 금액)을 함께 준다.
 *  - 평가 시점 k(스냅샷)마다 V_k = Σ 수량 × 정규장 종가(없으면 그때 현재가 — 몇 번이었는지 센다), 전체(원화)의 미국 몫은 × 그 스냅샷 환율
 *  - 두 시점 사이(앞 스냅샷 시각 초과 ~ 뒤 스냅샷 시각 이하) 체결: 매수 합 B_k, 매도 합 S_k. 주문 내역에 없는 수량 변화(이관 추정)는 그날 가격으로 들어오고 나간 것으로
 *  - r_k = (V_k + S_k − B_k − V_{k−1}) ÷ (V_{k−1} + B_k) (매수는 구간 처음, 매도는 구간 끝에 있었다고 봄). 분모 ≤ 0 이면 그 구간은 건너뜀
 *  - 수익률 = Π(1 + r_k) − 1, 기간 손익 = V_끝 − V_시작 − ΣB + ΣS
 *  - 시장: 한국(원) = 한국 스냅샷, 미국(달러) = 미국 스냅샷 달러 값(환율 효과 없음), 전체(원화) = 두 시장 스냅샷을 시각 순으로 이어, 시점마다
 *    '그 시각까지의 최신 한국 + 최신 미국(그 스냅샷 환율)'. 한 시장의 흐름은 그 시장의 다음 스냅샷에서 센다(미국은 그 스냅샷 환율로 원화)
 *  - 빈칸(gap)은 앞뒤를 한 구간으로 이어 계산, 의심을 안고 저장한 스냅샷은 평가 시점에서 뺀다
 *  - 현금 입출금·배당은 넣지 않는다(토스 Open API 가 주지 않음 — 주식 평가금액만의 가격 수익률)
 *  - 공개 조건(로드맵 '3-36 뒤 최소 2주를 모은 다음 공개'): 기록 전체(기간과 상관없이)의 평가 시점이 READY_DAYS(10)거래일 미만이면 숫자를 주지 않는다
 *    (ready false, recordDays 로 '지금 N거래일'). 기록이 충분해도 고른 기간 안 평가 시점이 MIN_POINTS(2) 미만이면 계산할 수 없어 ready false
 *    (1주는 거래일이 많아야 5~6일이라, 기간 안 점 수로 막으면 영영 나오지 않는다)
 */

export type ReturnsMarket = "ALL" | "KR" | "US";
export type Preset = "1W" | "1M" | "3M" | "YTD" | "1Y" | "custom";

export const READY_DAYS = 10;
/** 고른 기간 안에 이만큼 평가 시점이 있어야 계산한다 (시작·끝) */
export const MIN_POINTS = 2;

export interface RetSnap {
  date: string;
  market: "KR" | "US";
  asOf: string;
  status: "ok" | "gap";
  /** 의심을 안고 저장된 스냅샷 (계좌 몫이 빠졌을 수 있음) — 평가 시점에서 뺀다 */
  doubted: boolean;
  /** 미국: 그 스냅샷 환율 */
  fx: number | null;
  holdings: Array<{ code: string; quantity: number; price: number | null; regularClose: number | null }>;
}

export interface RetFlow {
  market: "KR" | "US";
  side: "BUY" | "SELL";
  /** 종목 통화 */
  amount: number;
  at: string;
  /** trade = 체결, transfer = 주문 내역에 없는 수량 변화(이관 추정 — 그날 가격) */
  kind: "trade" | "transfer";
}

export interface ReturnsBody {
  ready: boolean;
  /** 고른 기간 안 평가 시점의 거래일 수 */
  tradingDays: number;
  /** 기록 전체의 평가 시점 거래일 수 (공개 조건은 이것 ≥ needDays) */
  recordDays: number;
  needDays: number;
  requested: { from: string; to: string };
  actual: { from: string; to: string } | null;
  clippedToRecordStart: boolean;
  /**
   * 전체(원화)인데 고른 기간의 미국 기록이 모두 평가 환율 없이 저장됨 — 원화로 이을 수 없어 숫자가 없다(기간을 늘려도 같음).
   * 한국·미국(달러)은 따로 계산된다
   */
  usFxMissing: boolean;
  market: ReturnsMarket;
  currency: "KRW" | "USD";
  /** 퍼센트 (소수 둘째 자리) */
  twr: number | null;
  pnl: number | null;
  startValue: number | null;
  endValue: number | null;
  buys: number;
  sells: number;
  transfersEstimated: number;
  gaps: string[];
  doubtedSkipped: string[];
  priceBasis: { regularClose: number; priceFallback: number; fallbackCodes: string[] };
  /** 날짜별 누적 수익률 (퍼센트) */
  series: Array<{ date: string; cum: number }>;
}

const t = (iso: string) => Date.parse(iso);
const pct = (x: number) => {
  const v = Math.round(x * 10_000) / 100;
  return v === 0 ? 0 : v;
};

function shiftMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 기간 고르기 → [from, to] (to = 오늘, 한국 날짜) */
export function presetRange(preset: Exclude<Preset, "custom">, today: string): { from: string; to: string } {
  const from =
    preset === "1W" ? addDays(today, -7) : preset === "1M" ? shiftMonths(today, -1) : preset === "3M" ? shiftMonths(today, -3) : preset === "YTD" ? `${today.slice(0, 4)}-01-01` : shiftMonths(today, -12);
  return { from, to: today };
}

interface Point {
  snap: RetSnap;
  /** 그 시장 몫의 값 (종목 통화) */
  value: number;
}

/** 스냅샷 한 장의 평가금액 (종목 통화) — 정규장 종가, 없으면 현재가 (둘 다 없으면 그 종목은 뺀다) */
function valueOf(s: RetSnap, basis: ReturnsBody["priceBasis"], codes: Set<string>): number {
  let v = 0;
  for (const h of s.holdings) {
    const px = h.regularClose ?? h.price;
    if (h.regularClose !== null) basis.regularClose++;
    else if (h.price !== null) {
      basis.priceFallback++;
      codes.add(h.code);
    }
    if (px !== null && Number.isFinite(px)) v += h.quantity * px;
  }
  return v;
}

/** 평가 시점으로 쓰는 스냅샷: 성공(ok)·의심 없음, 전체(원화)의 미국 몫은 환율이 있어야 */
function usableSnap(s: RetSnap, market: ReturnsMarket): boolean {
  const markets = market === "ALL" ? ["KR", "US"] : [market];
  return markets.includes(s.market) && s.status === "ok" && !s.doubted && (s.market === "KR" || market !== "ALL" || s.fx !== null);
}

/** opts.minDays: 공개 조건(기본 READY_DAYS — 기록 전체 거래일) — 계산만 확인하는 테스트는 1 */
export function periodReturns(
  q: { requested: { from: string; to: string }; market: ReturnsMarket; recordSince: string | null },
  snaps: RetSnap[],
  flows: RetFlow[],
  opts: { minDays?: number } = {},
): ReturnsBody {
  const { requested, market } = q;
  const currency = market === "US" ? "USD" : "KRW";
  const markets = market === "ALL" ? (["KR", "US"] as const) : ([market] as const);
  const inRange = snaps.filter((s) => (markets as readonly string[]).includes(s.market) && s.date >= requested.from && s.date <= requested.to);
  const gaps = [...new Set(inRange.filter((s) => s.status === "gap").map((s) => s.date))].sort();
  const doubtedSkipped = [...new Set(inRange.filter((s) => s.status === "ok" && s.doubted).map((s) => s.date))].sort();
  const usable = inRange.filter((s) => usableSnap(s, market)).sort((a, b) => t(a.asOf) - t(b.asOf));
  // 기록 전체 길이 (고른 기간과 상관없이) — 공개 조건
  const recordDays = new Set(snaps.filter((s) => usableSnap(s, market)).map((s) => s.date)).size;
  const basis = { regularClose: 0, priceFallback: 0, fallbackCodes: [] as string[] };
  const fallbackCodes = new Set<string>();
  const points: Point[] = usable.map((snap) => ({ snap, value: valueOf(snap, basis, fallbackCodes) }));
  basis.fallbackCodes = [...fallbackCodes].sort();
  const clipped = !!q.recordSince && requested.from < q.recordSince;
  const usFxMissing = market === "ALL" && !usable.some((s) => s.market === "US") && inRange.some((s) => s.market === "US" && s.status === "ok" && !s.doubted && s.fx === null);
  const base: ReturnsBody = {
    ready: false,
    tradingDays: 0,
    recordDays,
    needDays: READY_DAYS,
    requested,
    actual: null,
    clippedToRecordStart: clipped,
    usFxMissing,
    market,
    currency,
    twr: null,
    pnl: null,
    startValue: null,
    endValue: null,
    buys: 0,
    sells: 0,
    transfersEstimated: 0,
    gaps,
    doubtedSkipped,
    priceBasis: basis,
    series: [],
  };

  // 전체: 두 시장이 모두 한 번 이상 나온 시점부터. 시점마다 그 시장 몫만 바뀐다
  const latest: Partial<Record<"KR" | "US", Point>> = {};
  const seq: Array<{ p: Point; total: number; flowIn: number; flowOut: number; transfers: number }> = [];
  const toBase = (p: Point, v: number) => (market === "ALL" && p.snap.market === "US" ? v * (p.snap.fx ?? 0) : v);
  for (const p of points) {
    const m = p.snap.market;
    const prev = latest[m];
    latest[m] = p;
    const ready = markets.every((x) => latest[x]);
    if (!ready) continue;
    const total = markets.reduce((s, x) => s + toBase(latest[x]!, latest[x]!.value), 0);
    // 이 시장의 앞 시점 뒤 ~ 이 시점까지의 흐름 (전체의 첫 시점이면 흐름 없음 — 시작 값에 이미 들어 있다)
    let flowIn = 0,
      flowOut = 0,
      transfers = 0;
    if (prev && seq.length > 0) {
      const t1 = t(prev.snap.asOf),
        t2 = t(p.snap.asOf);
      for (const f of flows) {
        if (f.market !== m) continue;
        const at = t(f.at);
        if (!(at > t1 && at <= t2)) continue;
        const v = toBase(p, f.amount);
        if (f.side === "BUY") flowIn += v;
        else flowOut += v;
        if (f.kind === "transfer") transfers++;
      }
    }
    seq.push({ p, total, flowIn, flowOut, transfers });
  }
  if (seq.length === 0) return base;
  const tradingDays = new Set(seq.map((x) => x.p.snap.date)).size;
  const actual = { from: seq[0]!.p.snap.date, to: seq.at(-1)!.p.snap.date };
  // 기록이 아직 짧음 · 기록은 충분하지만 고른 기간 안 평가 시점이 모자람 (시작과 끝이 있어야 계산)
  if (recordDays < (opts.minDays ?? READY_DAYS) || seq.length < MIN_POINTS) return { ...base, tradingDays, actual };
  let growth = 1;
  let buys = 0,
    sells = 0,
    transfers = 0;
  const series: Array<{ date: string; cum: number }> = [{ date: seq[0]!.p.snap.date, cum: 0 }];
  for (let k = 1; k < seq.length; k++) {
    const a = seq[k - 1]!,
      b = seq[k]!;
    buys += b.flowIn;
    sells += b.flowOut;
    transfers += b.transfers;
    const denom = a.total + b.flowIn;
    if (denom > 0) growth *= 1 + (b.total + b.flowOut - b.flowIn - a.total) / denom;
    const cum = pct(growth - 1);
    const last = series.at(-1)!;
    if (last.date === b.p.snap.date) last.cum = cum;
    else series.push({ date: b.p.snap.date, cum });
  }
  const round = (v: number) => (currency === "KRW" ? Math.round(v) : Math.round(v * 100) / 100);
  const startValue = round(seq[0]!.total);
  const endValue = round(seq.at(-1)!.total);
  return {
    ...base,
    ready: true,
    tradingDays,
    actual,
    twr: pct(growth - 1),
    pnl: round(seq.at(-1)!.total - seq[0]!.total - buys + sells),
    startValue,
    endValue,
    buys: round(buys),
    sells: round(sells),
    transfersEstimated: transfers,
    series,
  };
}
