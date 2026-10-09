import { isTimeoutError, ProviderError } from "../../lib/errors.js";
import { reutersCandidates } from "./fundamentals.js";
import { parseNaverIntegration } from "./naverFinance.js";
import type { FetchFn } from "./types.js";

/**
 * 네이버 업종 번호 (3-35 내 종목 테마 — 테마가 없는 종목을 발견 탭 '업종'과 같은 묶음으로). 로그인 없음, 코드가 이미 쓰는 주소들.
 *  - 미국: api.stock.naver.com/stock/{로이터코드}/basic → industryCodeType.code (SOFI 55101030 소비자 대출, NVDA 57101010 반도체 —
 *    발견 탭 미국 업종 id 와 같은 TRBC 번호, 2026-09-29 확인). ETF 는 null. 로이터 코드는 자동완성(resolveReuters) → 규칙 후보
 *  - 한국: m.stock.naver.com/api/stock/{코드}/integration → industryCode (005930 → 278 = 발견 탭 한국 업종 '반도체와반도체장비')
 */

type Json = Record<string, unknown>;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const NOT_FOUND = new Set([400, 404, 409]);

export interface UsIndustry {
  /** 네이버 로이터 코드 (시세 폴링에 쓴다) */
  reuters: string | null;
  /** TRBC 업종 번호 (없으면 null) */
  industry: string | null;
}

export class NaverIndustry {
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    /** 네이버 자동완성으로 로이터 코드 (NaverFundamentals.resolveReuters). 없으면 규칙 후보만 */
    private readonly resolveReuters: ((code: string) => Promise<string | null>) | null = null,
  ) {}

  /** JSON 한 번. 없는 종목(400·404·409)은 null, 그 밖의 실패는 ProviderError */
  private async json(url: string): Promise<Json | null> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new ProviderError("naver-industry", `${isTimeoutError(e) ? "시간 초과" : "네트워크 오류"}: ${url}`, e);
    }
    if (NOT_FOUND.has(res.status)) return null;
    if (!res.ok) throw new ProviderError("naver-industry", `HTTP ${res.status}: ${url}`);
    try {
      return (await res.json()) as Json;
    } catch (e) {
      throw new ProviderError("naver-industry", `JSON 읽기 실패: ${url}`, e);
    }
  }

  /** 미국 종목의 로이터 코드와 업종 번호. 어느 후보로도 찾지 못하면 null */
  async us(code: string): Promise<UsIndustry | null> {
    const resolved = this.resolveReuters ? await this.resolveReuters(code).catch(() => null) : null;
    const candidates = [...new Set([...(resolved ? [resolved] : []), ...reutersCandidates(code)])];
    let failed: unknown = null;
    for (const rc of candidates) {
      let j: Json | null;
      try {
        j = await this.json(`https://api.stock.naver.com/stock/${encodeURIComponent(rc)}/basic`);
      } catch (e) {
        failed = e;
        continue;
      }
      if (!j || (typeof j["stockName"] !== "string" && typeof j["reutersCode"] !== "string")) continue;
      const t = j["industryCodeType"] as Json | null | undefined;
      const ind = t?.["code"];
      return { reuters: typeof j["reutersCode"] === "string" ? j["reutersCode"] : rc, industry: typeof ind === "string" && /^\d+$/.test(ind) ? ind : null };
    }
    if (failed) throw failed;
    return null;
  }

  /** 한국 종목의 업종 번호 (없는 종목·업종 없음은 null) */
  async kr(code: string): Promise<string | null> {
    const j = await this.json(`https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/integration`);
    const v = j ? parseNaverIntegration(j)?.industryCode ?? (typeof j["industryCode"] === "string" ? j["industryCode"] : null) : null;
    return v && /^\d+$/.test(v) ? v : null;
  }
}
