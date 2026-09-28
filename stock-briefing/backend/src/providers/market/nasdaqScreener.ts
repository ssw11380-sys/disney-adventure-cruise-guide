import { fetchWithTimeout } from "../../lib/timedFetch.js";
import { ProviderError } from "../../lib/errors.js";
import { parseScreener, type ScreenerRow } from "../../services/valueReference.js";
import type { FetchFn } from "./types.js";

/**
 * Nasdaq 스크리너 (로그인 없는 공개 JSON, 비공식): 미국 상장 주식 약 7,000줄 — 부문·업종·시가총액.
 * 가치 지표 비교 기준(3-44 2단계)에서 주 1회 한 번만 부른다. ETF 는 들어 있지 않다.
 * 응답 모양이 바뀌거나 막히면 오류 → 지난 비교 기준을 14일까지 쓰고 그 뒤 '점수 없음 — 비교 기준이 2주 넘게 갱신되지 않았습니다'
 */
const URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class NasdaqScreener {
  readonly name = "nasdaq";
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async rows(): Promise<ScreenerRow[]> {
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, URL, { headers: { "user-agent": UA, accept: "application/json, text/plain, */*" } }, 60_000);
    } catch (e) {
      throw new ProviderError(this.name, "네트워크 오류: Nasdaq 스크리너", e);
    }
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: Nasdaq 스크리너`);
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new ProviderError(this.name, "응답 읽기 실패: Nasdaq 스크리너", e);
    }
    const rows = parseScreener(json);
    if (!rows.length) throw new ProviderError(this.name, "Nasdaq 스크리너 응답에 줄이 없습니다");
    return rows;
  }
}
