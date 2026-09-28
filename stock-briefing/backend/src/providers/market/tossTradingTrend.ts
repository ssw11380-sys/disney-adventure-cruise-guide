import { ProviderError } from "../../lib/errors.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";
import type { FlowTrendRow, FlowTrendSource } from "./investorFlow.js";
import type { FetchFn } from "./types.js";

/**
 * 토스증권 웹 공개 화면의 투자자별 매매 (3-33 수급 탭 1순위, 로그인 없음 — 시세·배당 요약과 같은 호스트).
 *   GET /api/v1/stock-infos/trade/trend/trading-trend?productCode={A|Q}{코드}&size={N}   (최신순, size 200 까지, 다음 쪽은 &key=YYYY-MM-DD)
 *   GET /api/v2/stock-infos/{A|Q}{코드}   (상품 코드 확인 + 상장 주식 수 sharesOutstanding — 외국인 한도율 계산용, toss.ts 와 같은 주소)
 * 한국거래소 + 넥스트레이드 거래를 합친 값(토스 앱·토스 Open API 와 같은 기준). 칸: 개인·외국인·기관·기타법인 순매수(주 수), 외국인 보유율·보유·한도,
 * 종가, 장중 여부(inMarketTime), 세 분류 값이 나왔는지(has*), 그 줄을 고친 시각(updatedAt).
 * 상품 코드 접두어: 주권·ETF 는 'A', ETN 은 'Q' (520057 실측 — A 로 부르면 trading-trend HTTP 400 · stock-infos result null, Q 로 부르면 자료).
 * 공식 계약 API 가 아니라 모양이 바뀌면 던진다(부르는 쪽이 캐시·네이버로). 없는 코드·미국 종목은 HTTP 400
 */
const TREND_BASE = "https://wts-info-api.tossinvest.com/api/v1/stock-infos/trade/trend/trading-trend";
const INFO_BASE = "https://wts-info-api.tossinvest.com/api/v2/stock-infos";
/** 토스 웹 요청 하나의 최대 대기 (시세와 같게) */
const TIMEOUT_MS = 8_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const HEADERS = { "user-agent": UA, accept: "application/json", referer: "https://tossinvest.com/", origin: "https://tossinvest.com" };
/** 한 번에 받는 줄 수: 확정 60일 + 60일 전 보유율 한 줄 + 오늘(잠정)·여유 */
export const TOSS_TREND_SIZE = 70;
/** 토스 한국 상품 코드 접두어 (앞의 것부터 찾는다) */
const PREFIXES = ["A", "Q"] as const;
/** 상품 정보 캐시: 찾으면 24시간 · 두 접두어 모두 없으면 1시간 · 받지 못하면 5분 (그동안 다시 부르지 않는다) */
const INFO_TTL_MS = 24 * 3_600_000;
const INFO_MISS_TTL_MS = 3_600_000;
const INFO_FAIL_TTL_MS = 5 * 60_000;
/** 상품 정보를 기억하는 종목 수 (수급 캐시 300종목보다 넉넉히) */
const INFO_MAX = 500;

type Json = Record<string, unknown>;

/** 토스 상품 정보 가운데 수급 탭이 쓰는 것 */
export interface TossProductInfo {
  /** 'A005930' · 'Q520057' */
  productCode: string;
  /** 상장 주식 수 (sharesOutstanding — 모르면 null) */
  listedShares: number | null;
}

/** HTTP 상태가 성공이 아닌 응답 (400 = 그 상품 코드가 없음 — ETN 을 A 로 부른 경우 등) */
class TossHttpError extends ProviderError {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super("toss-web", `HTTP ${status}: ${url}`);
  }
}

/** 수 칸: 유한수 또는 없음(null·undefined) → 그 밖(글자·NaN)은 모양이 바뀐 것 */
function numOrNull(v: unknown, key: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new ProviderError("toss-web", `수급 출처 모양 바뀜: ${key}=${JSON.stringify(v)}`);
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * 원자료(응답 본문 전체) → 줄. 모양이 다르면 ProviderError.
 * has* 가 거짓인 분류는 값을 null 로 — 아직 나오지 않은 값(장중 개인 등)을 토스가 0 으로 채워 보내도 '0주'로 보이거나 합계에 들어가지 않게.
 * 기타법인은 has 칸이 따로 없고 개인처럼 장이 끝난 뒤 나오는 값이라 hasIndividual 이 거짓이면 함께 null
 */
export function parseTossTradingTrend(json: unknown): FlowTrendRow[] {
  const result = json && typeof json === "object" && !Array.isArray(json) ? (json as Json)["result"] : undefined;
  const body = result && typeof result === "object" ? (result as Json)["body"] : undefined;
  if (!Array.isArray(body)) throw new ProviderError("toss-web", "수급 출처 모양 바뀜: result.body 가 배열이 아닙니다");
  return body.map((raw) => {
    if (!raw || typeof raw !== "object") throw new ProviderError("toss-web", "수급 출처 모양 바뀜: 줄이 객체가 아닙니다");
    const r = raw as Json;
    const date = r["baseDate"];
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ProviderError("toss-web", `수급 출처 모양 바뀜: baseDate=${JSON.stringify(date)}`);
    const hasInd = boolOrNull(r["hasIndividual"]);
    const hasInst = boolOrNull(r["hasInstitution"]);
    const hasFor = boolOrNull(r["hasForeigner"]);
    const has = [hasInd, hasInst, hasFor];
    const updated = r["updatedAt"];
    // 값 모양 검사는 has 와 상관없이 한다 (모양이 바뀐 것을 놓치지 않게)
    const individual = numOrNull(r["netIndividualsBuyVolume"], "netIndividualsBuyVolume");
    const foreign = numOrNull(r["netForeignerBuyVolume"], "netForeignerBuyVolume");
    const institution = numOrNull(r["netInstitutionBuyVolume"], "netInstitutionBuyVolume");
    const otherCorp = numOrNull(r["netOtherCorporationBuyVolume"], "netOtherCorporationBuyVolume");
    return {
      date,
      individual: hasInd === false ? null : individual,
      foreign: hasFor === false ? null : foreign,
      institution: hasInst === false ? null : institution,
      otherCorp: hasInd === false ? null : otherCorp,
      foreignRatio: numOrNull(r["foreignerRatio"], "foreignerRatio"),
      foreignHolding: numOrNull(r["foreignerHoldingVolume"], "foreignerHoldingVolume"),
      foreignLimit: numOrNull(r["foreignerLimitVolume"], "foreignerLimitVolume"),
      close: numOrNull(r["close"], "close"),
      inMarketTime: boolOrNull(r["inMarketTime"]),
      hasAll: has.includes(false) ? false : has.every((x) => x === true) ? true : null,
      updatedAt: typeof updated === "string" && updated ? updated : null,
    };
  });
}

/**
 * v2/stock-infos 응답 → 상품 코드·상장 주식 수. result 가 null 이면(그 접두어로는 없는 상품) null.
 * result 가 있는데 code 모양이 다르면 모양이 바뀐 것이라 던진다. 상장 주식 수는 양의 수가 아니면 null
 */
export function parseTossStockInfo(json: unknown): TossProductInfo | null {
  if (!json || typeof json !== "object" || Array.isArray(json) || !("result" in json)) throw new ProviderError("toss-web", "종목 정보 모양 바뀜: result 가 없습니다");
  const r = (json as Json)["result"];
  if (r === null) return null;
  if (typeof r !== "object" || Array.isArray(r)) throw new ProviderError("toss-web", "종목 정보 모양 바뀜: result 가 객체가 아닙니다");
  const code = (r as Json)["code"];
  if (typeof code !== "string" || !/^[A-Z][0-9A-Z]{6}$/.test(code)) throw new ProviderError("toss-web", `종목 정보 모양 바뀜: code=${JSON.stringify(code)}`);
  const shares = (r as Json)["sharesOutstanding"];
  return { productCode: code, listedShares: typeof shares === "number" && Number.isFinite(shares) && shares > 0 ? shares : null };
}

export class TossTradingTrend implements FlowTrendSource {
  readonly name = "toss-web";
  /** 종목 코드 → 상품 정보 (info: 찾음 · null 없음 · undefined 받지 못함) */
  private readonly products = new Map<string, { at: number; info: TossProductInfo | null | undefined }>();

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async getJson(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, url, { headers: HEADERS }, TIMEOUT_MS);
    } catch (e) {
      throw new ProviderError(this.name, `네트워크 오류: ${url}`, e);
    }
    if (!res.ok) throw new TossHttpError(res.status, url);
    try {
      return await res.json();
    } catch (e) {
      throw new ProviderError(this.name, `JSON 파싱 실패: ${url}`, e);
    }
  }

  /**
   * 상품 코드·상장 주식 수 (v2/stock-infos — A 로 없으면 Q). 찾음 · null(두 접두어 모두 없음) · undefined(받지 못함·모양 바뀜) — 던지지 않는다.
   * 캐시: 찾음 24시간 · 없음 1시간 · 받지 못함 5분
   */
  async product(code: string): Promise<TossProductInfo | null | undefined> {
    const t = this.now().getTime();
    const hit = this.products.get(code);
    if (hit && t - hit.at < (hit.info ? INFO_TTL_MS : hit.info === null ? INFO_MISS_TTL_MS : INFO_FAIL_TTL_MS)) return hit.info;
    let info: TossProductInfo | null | undefined = null;
    try {
      for (const p of PREFIXES) {
        info = parseTossStockInfo(await this.getJson(`${INFO_BASE}/${p}${encodeURIComponent(code)}`));
        if (info) break;
      }
    } catch {
      info = undefined; // 부가 정보 — 받지 못해도 수급은 부른다 (한도율만 어림으로)
    }
    this.products.delete(code);
    this.products.set(code, { at: t, info });
    while (this.products.size > INFO_MAX) {
      const oldest = this.products.keys().next().value;
      if (oldest === undefined) break;
      this.products.delete(oldest);
    }
    return info;
  }

  /** 상장 주식 수 (외국인 한도율 계산용 — 모르면 null, 던지지 않는다). trend 가 먼저 받아 둔 캐시를 쓴다 */
  async listedShares(code: string): Promise<number | null> {
    return (await this.product(code))?.listedShares ?? null;
  }

  private async fetchTrend(productCode: string, size: number): Promise<FlowTrendRow[]> {
    return parseTossTradingTrend(await this.getJson(`${TREND_BASE}?productCode=${encodeURIComponent(productCode)}&size=${size}`));
  }

  /**
   * 투자자별 매매 (최신순). 상품 정보를 알면 그 코드로 한 번. 모르면 상품 정보와 'A' 수급을 함께 불러(기다림이 늘지 않게)
   * 'A' 가 HTTP 400 이면 상품 정보의 코드(ETN 은 'Q')로 한 번 더 — 상품 정보를 받지 못했으면 'Q' 로 한 번 더
   */
  async trend(code: string, size: number = TOSS_TREND_SIZE): Promise<FlowTrendRow[]> {
    const n = Math.min(200, Math.max(1, Math.floor(size)));
    const hit = this.products.get(code);
    if (hit?.info && this.now().getTime() - hit.at < INFO_TTL_MS) return this.fetchTrend(hit.info.productCode, n);
    const a = `A${code}`;
    const [info, first] = await Promise.all([
      this.product(code),
      this.fetchTrend(a, n).then(
        (rows) => ({ rows }),
        (err: unknown) => ({ err }),
      ),
    ]);
    if ("rows" in first) return first.rows;
    const next = info ? info.productCode : info === undefined ? `Q${code}` : null;
    if (next && next !== a && first.err instanceof TossHttpError && first.err.status === 400) return this.fetchTrend(next, n);
    throw first.err;
  }
}
