import { isKrCode } from "../lib/codes.js";
import { BOND_ETF_RE, KR_ETF_BRAND_RE, LEVERAGE_RE } from "../services/marketSummaryCalc.js";

/**
 * 레버리지·인버스·채권형 상품 가리기와 레버리지 주의 사실 상자 (3-44 지표 점수 1단계). 순수 함수.
 *  - 레버리지(정방향) 상품은 이 상품 가격으로 추세 지표 점수를 내지 않는다(매일 배수를 다시 맞추는 구조라 변동성 손실에 끌린다).
 *    기초자산 점수를 '참고' 한 줄로만 보이고, 사실 상자(63거래일 수익 비교·변동성·최대 낙폭·계산상 변동성 손실)를 앞에 둔다
 *  - 인버스·채권·금리형 상품은 점수를 내지 않는다
 *  - 가리는 순서: 토스 웹 상품 정보(leverageFactor·singleStockEtp) → 정적 표 → 이름 규칙. 기초자산은 표 → 미국 단일 종목 상품만 이름.
 *    찾은 기초자산은 일봉으로 한 번 더 확인한다(verifyUnderlying) — 하루 수익이 기초자산의 L배를 따라가지 않으면 '기초자산을 확인하지 못함'
 */

/** 토스 웹 v2/stock-infos 에서 읽는 칸 (providers/market/toss parseProductFacts). 모르면 null */
export interface ProductFacts {
  name?: string | null;
  englishName?: string | null;
  detailName?: string | null;
  /** 상품 구분: ST 주권 · EF ETF · EN ETN … */
  group?: string | null;
  /** 토스 시세 거래소: NSQ · NYS · AMX · KSP · KSQ */
  exchange?: string | null;
  /** 배수 (일반 0, SOXL 3, RGTX 2, 인버스는 음수로 온다고 본다) */
  leverageFactor?: number | null;
  /** 단일 종목 레버리지 상품 (RGTX true) */
  singleStockEtp?: boolean | null;
  derivativeEtf?: boolean | null;
  /** 보통주 (false = 우선주 — 가치 지표 '대상 아님', 3-44 2단계) */
  commonShare?: boolean | null;
  /** 스팩(기업인수목적회사) */
  spac?: boolean | null;
  /** 정리매매 */
  clearance?: boolean | null;
}

/**
 * 정적 표: 상품 → 점수 계산 대상(같은 지수를 1배로 따르는 ETF 또는 그 주식)·배수·따르는 것.
 * SOXL 과 SOXX 는 같은 NYSE 반도체 지수를 따른다(운용사·자료 확인 2026-09-28, 네이버 설명의 'PHLX 반도체 지수'는 예전 이름) —
 * 최근 1년 하루 수익 기준 SOXL = SOXX × 2.94, 상관 0.999. RGTX = RGTI × 1.99, 상관 0.9996 (기록된 일봉)
 */
export const LEVERAGED_TABLE: Readonly<Record<string, { underlying: string; L: number; tracks: string }>> = {
  SOXL: { underlying: "SOXX", L: 3, tracks: "NYSE 반도체 지수" },
  TQQQ: { underlying: "QQQ", L: 3, tracks: "나스닥100 지수" },
  QLD: { underlying: "QQQ", L: 2, tracks: "나스닥100 지수" },
  UPRO: { underlying: "SPY", L: 3, tracks: "S&P500 지수" },
  SPXL: { underlying: "SPY", L: 3, tracks: "S&P500 지수" },
  SSO: { underlying: "SPY", L: 2, tracks: "S&P500 지수" },
  TECL: { underlying: "XLK", L: 3, tracks: "미국 기술 섹터 지수" },
  NVDL: { underlying: "NVDA", L: 2, tracks: "엔비디아 주가" },
  NVDU: { underlying: "NVDA", L: 2, tracks: "엔비디아 주가" },
  TSLL: { underlying: "TSLA", L: 2, tracks: "테슬라 주가" },
  CONL: { underlying: "COIN", L: 2, tracks: "코인베이스 주가" },
  MSTU: { underlying: "MSTR", L: 2, tracks: "스트래티지 주가" },
  MSTX: { underlying: "MSTR", L: 2, tracks: "스트래티지 주가" },
  RGTX: { underlying: "RGTI", L: 2, tracks: "리게티 컴퓨팅 주가" },
  PLTU: { underlying: "PLTR", L: 2, tracks: "팔란티어 주가" },
  AMDL: { underlying: "AMD", L: 2, tracks: "AMD 주가" },
  "122630": { underlying: "069500", L: 2, tracks: "코스피200 지수" },
  "233740": { underlying: "229200", L: 2, tracks: "코스닥150 지수" },
};

/**
 * 인버스: 'UltraShort'·'울트라숏', 'Short'(채권 낱말이 같이 있으면 짧은 만기 채권이라 아님), 'Bear'·한글 '베어', 인버스·곱버스 (marketSummaryCalc 의 isLeverageName 인버스 부분과 같은 규칙 +
 * 한글 '베어'). 토스 한글 이름 '디렉시온 데일리 반도체 베어 3X'(SOXS)가 '3X' 만 보고 레버리지로, 'AXS 테슬라 베어 데일리 ETF'(TSLQ)가 보통 상품으로 잡히지 않게 (브리핑 3차 4 검토 지적).
 * '베어'는 '숏'처럼 앞뒤가 한글이 아닐 때만 ('베어링' 같은 낱말은 아님)
 */
const ULTRASHORT_RE = /(ultrashort|울트라\s?숏)/i;
const SHORT_RE = /(\bshort\b|(?<![가-힣])숏(?![가-힣]))/i;
const SHORT_BOND_RE = /(income|bond|\bterm\b|duration|maturity|muni|t-bill|floating)/i;
const INVERSE_WORD_RE = /(\bbear\b|(?<![가-힣])베어(?![가-힣])|인버스|곱버스)/i;
/** 이름의 배수 ('2X', '3x') */
const MULT_RE = /(\d(?:\.\d+)?)\s*x\b/i;
/** 미국 단일 종목 상품의 기초 티커 ('… 2X LONG RGTI ETF', 'NVDA Bull 2X') */
const LONG_TICKER_RE = [/\b(?:Long|Bull)\s+([A-Z]{1,5})\b/i, /\b([A-Z]{1,5})\s+(?:Bull|Long)\b/i];

export type ProductKind =
  | { kind: "normal"; etf: boolean }
  | { kind: "inverse"; etf: true }
  | { kind: "bond"; etf: true }
  | { kind: "leveraged"; L: number; underlying: string | null; tracks: string | null; source: "table" | "name" | null; etf: true };

function isInverseName(names: string): boolean {
  if (ULTRASHORT_RE.test(names) || INVERSE_WORD_RE.test(names)) return true;
  return SHORT_RE.test(names) && !SHORT_BOND_RE.test(names);
}

/**
 * 상품 가리기. names = 등록 이름(한글·영문 무엇이든), facts = 토스 웹 상품 정보(없으면 null — 종목 마스터 분류만 group 으로 넣어도 된다).
 * 토스·종목 마스터가 보통 주식(group ST)이라고 하고 배수도 없으면 이름 규칙(Bear·Bull·Short·2X·채권…)을 쓰지 않는다 —
 * 'Build-A-Bear Workshop' 같은 회사 이름이 인버스·레버리지 상품으로 잡히지 않게
 */
export function classifyProduct(code: string, name: string, facts: ProductFacts | null | undefined): ProductKind {
  const names = [name, facts?.name, facts?.englishName, facts?.detailName].filter((x): x is string => typeof x === "string" && x.length > 0).join(" ");
  const kr = isKrCode(code);
  const lf = typeof facts?.leverageFactor === "number" && Number.isFinite(facts.leverageFactor) ? facts.leverageFactor : null;
  const table = LEVERAGED_TABLE[code];
  if (facts?.group === "ST" && (lf === null || lf === 0) && !table && facts.derivativeEtf !== true) return { kind: "normal", etf: false };
  const etf = facts?.group === "EF" || facts?.group === "EN" || (kr && KR_ETF_BRAND_RE.test(name)) || !!table || (lf !== null && lf !== 0) || facts?.derivativeEtf === true;
  if ((lf !== null && lf < 0) || isInverseName(names)) return { kind: "inverse", etf: true };
  const leveraged = (lf !== null && lf > 1) || !!table || LEVERAGE_RE.test(names);
  if (leveraged) {
    const nameL = MULT_RE.exec(names)?.[1];
    const L = lf !== null && lf > 1 ? lf : (table?.L ?? (nameL ? Number(nameL) : kr && /레버리지/.test(names) ? 2 : null));
    if (table && (L === null || L === table.L)) return { kind: "leveraged", L: table.L, underlying: table.underlying, tracks: table.tracks, source: "table", etf: true };
    // 표에 없으면: 미국 단일 종목 상품(지수형이 아니라고 알려진 것은 빼고)만 이름에서 기초 티커를 찾는다. 한국 상품은 짐작하지 않는다
    let underlying: string | null = null;
    if (!kr && facts?.singleStockEtp !== false) {
      for (const re of LONG_TICKER_RE) {
        const m = re.exec(facts?.englishName ?? names);
        const tk = m?.[1]?.toUpperCase();
        if (tk && tk !== code && !/^(ETF|ETN|DAILY|SHARE|SHS|TRUST)$/.test(tk)) {
          underlying = tk;
          break;
        }
      }
    }
    return { kind: "leveraged", L: L ?? 2, underlying, tracks: null, source: underlying ? "name" : null, etf: true };
  }
  if (etf && BOND_ETF_RE.test(names)) return { kind: "bond", etf: true };
  return { kind: "normal", etf };
}

/**
 * 상품 가리기 입력을 한곳에서 (지표 점수 3-44 · 계좌 비중 한 줄 브리핑 3차 4 가 같이 씀): 토스 웹 상품 정보가 없거나 분류 칸이 비면
 * 종목 마스터 분류(listed_stocks.group_code — ST·EF·EN)를 group 으로 넣는다 — 보통 주식 이름의 'Bear'·'Short' 로 인버스를 짐작하지 않게
 */
export function productKindOf(code: string, name: string, facts: ProductFacts | null | undefined, groupCode?: string | null): ProductKind {
  const hint: ProductFacts | null = facts || groupCode ? { ...facts, group: facts?.group ?? groupCode ?? null } : null;
  return classifyProduct(code, name, hint);
}

/** 계좌 비중 한 줄(브리핑 3차 4)의 상품 종류. L = 배수의 크기(인버스도 양수, 모르면 null), guessed = 토스 상품 정보 없이 이름 규칙으로 가림 */
export interface LevInv {
  kind: "leveraged" | "inverse" | null;
  L: number | null;
  guessed: boolean;
}

/**
 * 상장지수상품(ETF·ETN) 이름 표시: 'ETF'·'ETN'·배수 '2X'·'Daily'·운용사(ProShares·Direxion·GraniteShares·T-REX·Defiance·Tradr·AXS)·'Ultra'·레버리지·인버스.
 * 상품 정보도 종목 마스터 분류도 없는 미국 종목(짐작)은 이 표시가 있을 때만 이름의 Bear·Short·Bull 로 레버리지·인버스라고 센다 —
 * 'Build-A-Bear Workshop' 같은 회사 이름이 인버스로 잡히지 않게 (브리핑 3차 4 검토 지적, 계좌 비중 한 줄만 — 지표 점수는 classifyProduct 그대로)
 */
const ETP_MARK_RE =
  /(\bet[fnp]s?\b|\d(?:\.\d+)?\s*x\b|\bdaily\b|데일리|\bultra|울트라|proshares|프로셰어즈|direxion|디렉시온|graniteshares|그래닛셰어즈|\bt-rex\b|티렉스|defiance|디파이언스|\btradr\b|\baxs\b|레버리지|인버스|곱버스)/i;

/**
 * 레버리지·인버스인지와 배수 (브리핑 3차 4, 지표 점수와 같은 가리기 — productKindOf). 배수는 아는 것만: 상품 정보의 배수(인버스는 음수의 크기) →
 * 정적 표 → 이름의 '2X' → 국내 '레버리지'(2배). 그 밖은 null — classifyProduct 가 점수 계산용으로 채우는 기본 2배를 화면에 옮기지 않게.
 * guessed: 상품 정보를 받지 못했고 종목 마스터도 보통 주식(ST)이라고 하지 않았고 정적 표에도 없어, 이름 규칙으로 가린 것.
 * 짐작한 미국 종목은 이름에 상장지수상품 표시(ETP_MARK_RE)가 없으면 레버리지·인버스로 세지 않는다 (보통 주식 이름의 'Bear' 등)
 */
export function levInvOf(code: string, name: string, facts: ProductFacts | null | undefined, groupCode?: string | null): LevInv {
  const kind = productKindOf(code, name, facts, groupCode);
  const guessed = !facts && groupCode !== "ST" && !LEVERAGED_TABLE[code];
  const lf = typeof facts?.leverageFactor === "number" && Number.isFinite(facts.leverageFactor) ? facts.leverageFactor : null;
  const names = [name, facts?.name, facts?.englishName, facts?.detailName].filter((x): x is string => typeof x === "string" && x.length > 0).join(" ");
  if (guessed && !isKrCode(code) && groupCode !== "EF" && groupCode !== "EN" && !ETP_MARK_RE.test(names)) return { kind: null, L: null, guessed };
  const nameL = Number(MULT_RE.exec(names)?.[1] ?? NaN);
  const byName = Number.isFinite(nameL) && nameL > 0 ? nameL : null;
  if (kind.kind === "leveraged") {
    const table = LEVERAGED_TABLE[code];
    const L = lf !== null && lf > 1 ? lf : kind.source === "table" && table ? table.L : (byName ?? (isKrCode(code) && /레버리지/.test(names) ? 2 : null));
    return { kind: "leveraged", L, guessed };
  }
  if (kind.kind === "inverse") return { kind: "inverse", L: lf !== null && lf < 0 ? Math.abs(lf) : byName, guessed };
  return { kind: null, L: null, guessed };
}

/**
 * 분배금이 큰 상품 (추세 계산 9.6): 커버드콜·옵션 프리미엄 상품. 일봉에 분배금이 들어 있지 않아 가격만으로 계산한 추세가 실제 수익보다 낮게 나온다 →
 * 점수는 내되 안내 한 줄을 붙인다. ETF·ETN 일 때만 본다(회사 이름의 '프리미엄'은 상관없음)
 */
export const HIGH_DISTRIBUTION_RE = /(covered\s*call|커버드\s*콜|option\s+income|premium\s+income|yieldmax|buy[-\s]?write|프리미엄)/i;
export function isHighDistribution(name: string, facts: ProductFacts | null | undefined, etf: boolean): boolean {
  if (!etf) return false;
  return [name, facts?.name, facts?.englishName, facts?.detailName].some((x) => typeof x === "string" && HIGH_DISTRIBUTION_RE.test(x));
}

export interface DayCandle {
  date: string;
  close: number;
}

/** 두 일봉의 같은 날짜로 맞춘 하루 단순 수익 짝 (가장 최근부터 max 개, 두 쪽 모두 바로 앞 봉이 있는 날만) */
function pairedReturns(product: readonly DayCandle[], underlying: readonly DayCandle[], max: number): Array<[number, number]> {
  const ui = new Map(underlying.map((c, i) => [c.date, i]));
  const out: Array<[number, number]> = [];
  for (let i = product.length - 1; i >= 1 && out.length < max; i--) {
    const j = ui.get(product[i]!.date);
    const j0 = ui.get(product[i - 1]!.date);
    if (j === undefined || j0 === undefined || j !== j0 + 1) continue;
    out.push([product[i]!.close / product[i - 1]!.close - 1, underlying[j]!.close / underlying[j0]!.close - 1]);
  }
  return out;
}

/** 기초자산 확인 기준: 최근 63거래일(최소 40일) 하루 수익의 상관 0.98 이상, 기울기가 배수의 ±15% 안 */
export const UNDERLYING_CHECK = { days: 63, minDays: 40, minCorr: 0.98, betaTol: 0.15 } as const;

/**
 * 상품 하루 수익이 기초자산 하루 수익의 L배를 따라가는지. ok: true 확인됨 · false 따라가지 않음(기초자산을 모르는 것으로) · null 자료 부족(맞춘 날 40일 미만).
 * 과거 기록: SOXL~SOXX 상관 0.999·기울기 2.92~2.94, RGTX~RGTI 0.9995·1.98~1.99. 엉뚱한 기초(SOXL~QQQ 0.88, RGTX~IONQ 0.92)는 걸러진다
 */
export function verifyUnderlying(product: readonly DayCandle[], underlying: readonly DayCandle[], L: number): { ok: boolean | null; days: number; corr: number | null; beta: number | null } {
  const rows = pairedReturns(product, underlying, UNDERLYING_CHECK.days);
  const n = rows.length;
  if (n < UNDERLYING_CHECK.minDays) return { ok: null, days: n, corr: null, beta: null };
  const me = rows.reduce((a, r) => a + r[0], 0) / n;
  const mu = rows.reduce((a, r) => a + r[1], 0) / n;
  let see = 0;
  let suu = 0;
  let seu = 0;
  for (const [a, b] of rows) {
    see += (a - me) ** 2;
    suu += (b - mu) ** 2;
    seu += (a - me) * (b - mu);
  }
  if (suu === 0 || see === 0) return { ok: false, days: n, corr: null, beta: null };
  const beta = seu / suu;
  const corr = seu / Math.sqrt(see * suu);
  return { ok: corr >= UNDERLYING_CHECK.minCorr && Math.abs(beta / L - 1) <= UNDERLYING_CHECK.betaTol, days: n, corr, beta };
}

export interface LeverageFacts {
  L: number;
  /** 상품 마지막 봉 날짜와 63거래일 전 날짜 */
  asOf: string;
  from: string;
  /** 최근 63거래일 수익 (%): 상품 · 기초자산 · 단순 L배 */
  etf63Pct: number;
  und63Pct: number | null;
  naiveLx63Pct: number | null;
  /** 최근 3개월(63개 일간 로그수익) 변동성 (연, %) */
  sigEtfAnnPct: number;
  sigUnderlyingAnnPct: number | null;
  /** 계산상 변동성 손실 (연, %): 기초자산이 제자리이고 변동성이 1년 이어진다고 가정 = (1 − e^{−(L²−L)/2·σ²}) × 100 */
  volDecayPctPerYear: number | null;
  /** 최근 1년(252봉) 최대 낙폭 (%) */
  etfMdd1yPct: number;
}

const sdSample = (a: readonly number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};
const logReturns = (cs: readonly DayCandle[]) => cs.slice(1).map((c, i) => Math.log(c.close / cs[i]!.close));

/** 레버리지 주의 상자 숫자 (점수 아님, 사실만). 상품 기록이 64봉보다 짧으면 null. 기초자산이 없으면 상품 자체 값만 */
export function leverageFacts(product: readonly DayCandle[], underlying: readonly DayCandle[] | null, L: number): LeverageFacts | null {
  const e = product;
  if (e.length < 64) return null;
  const t = e.length - 1;
  const e63 = e[t - 63]!;
  const sigE = sdSample(logReturns(e.slice(-64))) * Math.sqrt(252);
  let peak = -Infinity;
  let mdd = 0;
  for (const c of e.slice(-252)) {
    peak = Math.max(peak, c.close);
    mdd = Math.max(mdd, 1 - c.close / peak);
  }
  let und63: number | null = null;
  let sigU: number | null = null;
  if (underlying && underlying.length >= 64) {
    const ui = new Map(underlying.map((c, i) => [c.date, i]));
    const j = ui.get(e[t]!.date);
    const jj = ui.get(e63.date);
    if (j !== undefined && jj !== undefined) und63 = underlying[j]!.close / underlying[jj]!.close - 1;
    sigU = sdSample(logReturns(underlying.slice(-64))) * Math.sqrt(252);
  }
  const drag = sigU !== null ? ((L * L - L) / 2) * sigU * sigU : null;
  return {
    L,
    asOf: e[t]!.date,
    from: e63.date,
    etf63Pct: 100 * (e[t]!.close / e63.close - 1),
    und63Pct: und63 !== null ? 100 * und63 : null,
    naiveLx63Pct: und63 !== null ? 100 * L * und63 : null,
    sigEtfAnnPct: 100 * sigE,
    sigUnderlyingAnnPct: sigU !== null ? 100 * sigU : null,
    volDecayPctPerYear: drag !== null ? 100 * (1 - Math.exp(-drag)) : null,
    etfMdd1yPct: 100 * mdd,
  };
}
