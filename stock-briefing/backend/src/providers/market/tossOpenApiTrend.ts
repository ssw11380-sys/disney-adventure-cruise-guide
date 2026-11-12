import { ProviderError, within } from "../../lib/errors.js";
import type { FlowTrendRow, FlowTrendSource } from "./investorFlow.js";

/**
 * 토스증권 공식 Open API 의 투자자별 매매동향 (수급 탭 출처 — 플래그 flowOpenApi).
 *   GET /api/v1/stocks/{종목코드}/investor-trading?count={N}   (최신순, count 100 까지 · 요청 한도 그룹 STOCK_TRADING_TREND 초당 10회)
 * 한국거래소 + 넥스트레이드 거래를 합친 값(토스 앱과 같은 기준)이고, 예전 토스 웹 공개 화면 자료(tossTradingTrend.ts — 2026-11 부터 막힘)와 같은 칸을 준다:
 * 개인·외국인(등록외국인)·기관·기타법인 순매수(주 수), 외국인 보유·한도·보유율, 그 줄을 고친 시각(updatedAt).
 * 다른 점:
 *  - 아직 나오지 않은 값은 null 로 온다 (당일 잠정 기록의 개인·기타법인·외국인 보유) — 웹의 has* 칸 대신 개인 값이 있는지로 '모두 나왔는지'를 본다
 *  - 장중 여부(inMarketTime) 칸이 없다 → 모름(null). 오늘 줄의 확정 판정은 받은 시각(20:30 뒤)과 updatedAt(18:00 뒤)으로만 (investorFlowCalc.isFinalRow)
 *  - 종가 칸이 없다 → 한국거래소 정규장 일봉 종가를 따로 받아 붙인다 (deps.closes — 웹 자료의 close 도 정규장 종가였다: 2026-09-28 삼성전자 270,000 = 네이버 종가).
 *    공식 API 일봉은 넥스트레이드 애프터마켓까지 든 통합 종가라 쓰지 않는다. 종가를 받지 못하면 그 칸만 비운다(null)
 *  - 보유율은 소수 비율로 온다 (0.4599 = 45.99% — 실측: 넷째 자리 반올림, 웹의 '소수 둘째 자리 % 반올림'과 같은 값)
 * 미국 종목은 HTTP 400 unsupported-market (부르는 쪽이 한국 종목만 부른다). 모양이 바뀌면 던진다(부르는 쪽이 캐시·다음 출처로)
 */

/** 한 번에 받는 줄 수 (토스 웹 때와 같게): 확정 60일 + 60일 전 보유율 한 줄 + 오늘(잠정)·여유 */
export const OPENAPI_TREND_SIZE = 70;
/** 정규장 종가 일봉을 기다리는 최대 시간 (넘으면 종가 없이) */
const CLOSES_WAIT_MS = 4_000;
const NAME = "toss-openapi";

type Json = Record<string, unknown>;

/** 수 칸(십진수 글자·수) → 수. 없으면(null·undefined) null, 그 밖(빈 글자·NaN)은 모양이 바뀐 것 */
function numOrNull(v: unknown, key: string): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new ProviderError(NAME, `수급 출처 모양 바뀜: ${key}=${JSON.stringify(v)}`);
  return n;
}

/**
 * 분류 하나의 순매수: 분류가 없으면(null — 아직 나오지 않음) null, 있는데 netBuyVolume 이 없으면 모양이 바뀐 것.
 * 문서로는 외국인·기관이 늘 있지만, 비어 온 줄 하나 때문에 70줄을 모두 버리지 않도록 그 값만 비운다 (그 줄은 '모두 나옴'이 아니게 — 합계에서는 빠진 날로 센다)
 */
function netOf(v: unknown, key: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new ProviderError(NAME, `수급 출처 모양 바뀜: ${key} 가 객체가 아닙니다`);
  const n = numOrNull((v as Json)["netBuyVolume"], `${key}.netBuyVolume`);
  if (n === null) throw new ProviderError(NAME, `수급 출처 모양 바뀜: ${key}.netBuyVolume 이 없습니다`);
  return n;
}

/**
 * 응답(result) → 줄 (최신순 그대로). 모양이 다르면 ProviderError.
 * closes: 날짜 → 한국거래소 정규장 종가 (없는 날은 null)
 */
export function parseOpenApiTrend(result: unknown, closes: ReadonlyMap<string, number> = new Map()): FlowTrendRow[] {
  const records = result && typeof result === "object" && !Array.isArray(result) ? (result as Json)["records"] : undefined;
  if (!Array.isArray(records)) throw new ProviderError(NAME, "수급 출처 모양 바뀜: records 가 배열이 아닙니다");
  return records.map((raw) => {
    if (!raw || typeof raw !== "object") throw new ProviderError(NAME, "수급 출처 모양 바뀜: 줄이 객체가 아닙니다");
    const r = raw as Json;
    const date = r["date"];
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ProviderError(NAME, `수급 출처 모양 바뀜: date=${JSON.stringify(date)}`);
    const individual = netOf(r["individual"], "individual");
    const foreign = netOf(r["foreigner"], "foreigner");
    const institution = netOf(r["institution"], "institution");
    const holding = r["foreignerHolding"];
    if (holding !== null && holding !== undefined && (typeof holding !== "object" || Array.isArray(holding))) throw new ProviderError(NAME, "수급 출처 모양 바뀜: foreignerHolding 이 객체가 아닙니다");
    const h = (holding ?? null) as Json | null;
    const rate = h ? numOrNull(h["holdingRate"], "foreignerHolding.holdingRate") : null;
    const updated = r["updatedAt"];
    const close = closes.get(date);
    return {
      date,
      individual,
      foreign,
      institution,
      otherCorp: netOf(r["otherCorporation"], "otherCorporation"),
      // 소수 비율 → % (소수 둘째 자리 — 0.4599 × 100 = 45.989999… 를 45.99 로)
      foreignRatio: rate === null ? null : Math.round(rate * 10_000) / 100,
      foreignHolding: h ? numOrNull(h["holdingQuantity"], "foreignerHolding.holdingQuantity") : null,
      foreignLimit: h ? numOrNull(h["limitQuantity"], "foreignerHolding.limitQuantity") : null,
      close: close !== undefined && Number.isFinite(close) && close > 0 ? close : null,
      inMarketTime: null,
      // 개인 값은 확정치가 반영될 때부터 온다 (당일 잠정 기록에는 null) — 외국인·기관은 문서로는 늘 있다
      hasAll: individual !== null && foreign !== null && institution !== null,
      updatedAt: typeof updated === "string" && updated ? updated : null,
    };
  });
}

export interface OpenApiTrendDeps {
  /** 공식 API 읽기 (TossOpenApiClient.get — 응답의 result 를 준다) */
  get: (path: string, params?: Record<string, string | number | boolean | undefined>) => Promise<unknown>;
  /** 상장 주식 수 (공식 종목 정보 — 외국인 한도율 계산용). 모르면 null */
  listedShares?: (code: string) => Promise<number | null>;
  /** 날짜별 한국거래소 정규장 종가 (최근 days 거래일). 받지 못하면 던져도 된다 — 종가 칸만 비운다 */
  closes?: (code: string, days: number) => Promise<Map<string, number>>;
}

export class TossOpenApiTrend implements FlowTrendSource {
  readonly name = NAME;

  constructor(private readonly deps: OpenApiTrendDeps) {}

  /** 투자자별 매매 (최신순). 요청 하나(100줄까지) + 정규장 종가 일봉 한 번을 함께 */
  async trend(code: string, size: number = OPENAPI_TREND_SIZE): Promise<FlowTrendRow[]> {
    const n = Math.min(100, Math.max(1, Math.floor(size)));
    const none = new Map<string, number>();
    const [result, closes] = await Promise.all([
      this.deps.get(`/api/v1/stocks/${encodeURIComponent(code)}/investor-trading`, { count: n }),
      // 종가는 덤이다 — 받지 못하거나 늦으면(CLOSES_WAIT_MS) 그 칸만 비우고 수급은 그대로 준다
      this.deps.closes ? within(this.deps.closes(code, n + 5).catch(() => none), CLOSES_WAIT_MS, none) : Promise.resolve(none),
    ]);
    return parseOpenApiTrend(result, closes);
  }

  /** 상장 주식 수 (모르면 null, 던지지 않는다) */
  async listedShares(code: string): Promise<number | null> {
    if (!this.deps.listedShares) return null;
    return this.deps.listedShares(code).catch(() => null);
  }
}
