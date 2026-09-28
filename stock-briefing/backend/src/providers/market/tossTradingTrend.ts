import { ProviderError } from "../../lib/errors.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";
import type { FlowTrendRow, FlowTrendSource } from "./investorFlow.js";
import type { FetchFn } from "./types.js";

/**
 * 토스증권 웹 공개 화면의 투자자별 매매 (3-33 수급 탭 1순위, 로그인 없음 — 시세·배당 요약과 같은 호스트).
 *   GET /api/v1/stock-infos/trade/trend/trading-trend?productCode=A{코드}&size={N}   (최신순, size 200 까지, 다음 쪽은 &key=YYYY-MM-DD)
 * 한국거래소 + 넥스트레이드 거래를 합친 값(토스 앱·토스 Open API 와 같은 기준). 칸: 개인·외국인·기관·기타법인 순매수(주 수), 외국인 보유율·보유·한도,
 * 종가, 장중 여부(inMarketTime), 세 분류 값이 나왔는지(has*), 그 줄을 고친 시각(updatedAt).
 * 공식 계약 API 가 아니라 모양이 바뀌면 던진다(부르는 쪽이 캐시·네이버로). 없는 코드·미국 종목은 HTTP 400
 */
const URL_BASE = "https://wts-info-api.tossinvest.com/api/v1/stock-infos/trade/trend/trading-trend";
/** 토스 웹 요청 하나의 최대 대기 (시세와 같게) */
const TIMEOUT_MS = 8_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
/** 한 번에 받는 줄 수: 확정 60일 + 60일 전 보유율 한 줄 + 오늘(잠정)·여유 */
export const TOSS_TREND_SIZE = 70;

type Json = Record<string, unknown>;

/** 수 칸: 유한수 또는 없음(null·undefined) → 그 밖(글자·NaN)은 모양이 바뀐 것 */
function numOrNull(v: unknown, key: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new ProviderError("toss-web", `수급 출처 모양 바뀜: ${key}=${JSON.stringify(v)}`);
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** 원자료(응답 본문 전체) → 줄. 모양이 다르면 ProviderError */
export function parseTossTradingTrend(json: unknown): FlowTrendRow[] {
  const result = json && typeof json === "object" && !Array.isArray(json) ? (json as Json)["result"] : undefined;
  const body = result && typeof result === "object" ? (result as Json)["body"] : undefined;
  if (!Array.isArray(body)) throw new ProviderError("toss-web", "수급 출처 모양 바뀜: result.body 가 배열이 아닙니다");
  return body.map((raw) => {
    if (!raw || typeof raw !== "object") throw new ProviderError("toss-web", "수급 출처 모양 바뀜: 줄이 객체가 아닙니다");
    const r = raw as Json;
    const date = r["baseDate"];
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ProviderError("toss-web", `수급 출처 모양 바뀜: baseDate=${JSON.stringify(date)}`);
    const has = [boolOrNull(r["hasIndividual"]), boolOrNull(r["hasInstitution"]), boolOrNull(r["hasForeigner"])];
    const updated = r["updatedAt"];
    return {
      date,
      individual: numOrNull(r["netIndividualsBuyVolume"], "netIndividualsBuyVolume"),
      foreign: numOrNull(r["netForeignerBuyVolume"], "netForeignerBuyVolume"),
      institution: numOrNull(r["netInstitutionBuyVolume"], "netInstitutionBuyVolume"),
      otherCorp: numOrNull(r["netOtherCorporationBuyVolume"], "netOtherCorporationBuyVolume"),
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

export class TossTradingTrend implements FlowTrendSource {
  readonly name = "toss-web";

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async trend(code: string, size: number = TOSS_TREND_SIZE): Promise<FlowTrendRow[]> {
    const url = `${URL_BASE}?productCode=A${encodeURIComponent(code)}&size=${Math.min(200, Math.max(1, Math.floor(size)))}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://tossinvest.com/", origin: "https://tossinvest.com" } }, TIMEOUT_MS);
    } catch (e) {
      throw new ProviderError(this.name, `네트워크 오류: ${url}`, e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${url}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new ProviderError(this.name, `JSON 파싱 실패: ${url}`, e);
    }
    return parseTossTradingTrend(json);
  }
}
