import { isTimeoutError, ProviderError } from "../../lib/errors.js";
import type { FetchFn } from "./types.js";

/**
 * 토스증권 웹 '회사 → 사업 테마' (3-35 내 종목 테마) — 로그인·쿠키 없이 받는 공개 JSON (wts-info-api, 발견 탭 테마북과 같은 호스트).
 *  - 종목 정보: GET /v2/stock-infos/{상품코드} → companyCode (TSLA US20100629001 → NAS006XY7-E0, ETF 는 EF…)
 *  - 회사 테마: GET /v2/companies/{companyCode}/tics → majorList(주요 사업) · minorList(그 외 사업, 매출 10% 이하) 의 id·title
 * 테마 구성 종목 목록(tics/{id}/stocks)에는 주요 사업 회사만 들어 있어(2026-09-29 확인 — MSFT 의 '양자컴퓨터'는 그 외 사업이고 목록에 없음)
 * 부르는 쪽은 majorList 만 쓴다. 머리·시간 제한·재시도 규칙은 tossTics.ts 와 같게 (그 파일은 건드리지 않는다)
 */

type Json = Record<string, unknown>;

const BASE = "https://wts-info-api.tossinvest.com/api";
const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  accept: "application/json",
  referer: "https://tossinvest.com/",
  origin: "https://tossinvest.com",
};

export interface CompanyTic {
  id: string;
  title: string;
}

export interface CompanyTics {
  companyCode: string | null;
  major: CompanyTic[];
  minor: CompanyTic[];
}

function tics(v: unknown): CompanyTic[] {
  if (!Array.isArray(v)) return [];
  const out: CompanyTic[] = [];
  for (const t of v as Json[]) {
    const id = t["id"] ?? t["ticsId"];
    const title = t["title"] ?? t["name"];
    if ((typeof id === "number" || typeof id === "string") && typeof title === "string" && title.trim()) out.push({ id: String(id), title: title.trim() });
  }
  return out;
}

/** companies/{cc}/tics 응답(result) 읽기 */
export function parseCompanyTics(result: unknown): { major: CompanyTic[]; minor: CompanyTic[] } {
  const r = (result ?? {}) as Json;
  return { major: tics(r["majorList"]), minor: tics(r["minorList"]) };
}

export class TossCompanyTics {
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly retryDelayMs = 800,
  ) {}

  private async call(path: string): Promise<unknown> {
    try {
      return await this.callRaw(path);
    } catch (e) {
      throw e instanceof ProviderError ? e : new ProviderError("toss-company-tics", e instanceof Error ? e.message : String(e), e);
    }
  }

  private async callRaw(path: string): Promise<unknown> {
    const once = () => this.fetchFn(`${BASE}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(10_000) });
    let res: Response;
    try {
      res = await once();
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (isTimeoutError(e)) throw e;
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      res = await once();
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`토스 회사 테마 HTTP ${res.status} (${path.split("?")[0]})`);
    const j = (await res.json()) as Json;
    return j["result"] ?? null;
  }

  /** 상품 코드 → 회사 코드 (없는 상품이면 null) */
  async companyCode(productCode: string): Promise<string | null> {
    const r = (await this.call(`/v2/stock-infos/${encodeURIComponent(productCode)}`)) as Json | null;
    const cc = r?.["companyCode"];
    return typeof cc === "string" && cc.trim() ? cc.trim() : null;
  }

  /** 회사 코드 → 주요 사업·그 외 사업 테마 (없으면 빈 목록) */
  async companyTics(companyCode: string): Promise<{ major: CompanyTic[]; minor: CompanyTic[] }> {
    return parseCompanyTics(await this.call(`/v2/companies/${encodeURIComponent(companyCode)}/tics`));
  }

  /** 상품 코드 하나로 두 번 (회사 코드가 없으면 빈 목록) */
  async forProduct(productCode: string): Promise<CompanyTics> {
    const companyCode = await this.companyCode(productCode);
    if (!companyCode) return { companyCode: null, major: [], minor: [] };
    return { companyCode, ...(await this.companyTics(companyCode)) };
  }
}
