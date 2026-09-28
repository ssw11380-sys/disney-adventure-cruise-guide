import { ProviderError } from "../../lib/errors.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";
import type { FlowTrendRow, FlowTrendSource } from "./investorFlow.js";
import type { FetchFn } from "./types.js";

/**
 * 네이버 증권 모바일의 투자자별 매매 (3-33 수급 탭 2순위 — 토스 웹이 막힐 때만, 로그인 없음 — 시세 지표와 같은 호스트).
 *   GET https://m.stock.naver.com/api/stock/{코드}/trend?pageSize={N}   (최신순, pageSize 60 까지 — 61 부터 HTTP 400)
 * 한국거래소 거래만(넥스트레이드 빠짐)이라 토스 앱 숫자와 같지 않다 — 화면이 기준을 밝힌다. 기타법인·외국인 한도는 없다.
 * 수는 "+5,330,121"·"-4,999,903"·"0"·"" 글자, 보유율은 "46.56%". 값이 없는 칸은 "" 또는 "-"(일부 ETN 의 보유율 — 530036 실측) → null.
 * 그 밖의 모양이면 던진다. 없는 코드는 빈 배열
 */
const URL_BASE = "https://m.stock.naver.com/api/stock";
const TIMEOUT_MS = 8_000;
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";
/** 네이버가 한 번에 주는 최대 줄 수 */
export const NAVER_TREND_MAX = 60;

type Json = Record<string, unknown>;

function fail(msg: string): never {
  throw new ProviderError("naver", `수급 출처 모양 바뀜: ${msg}`);
}

/** 값이 없다는 표시 (빈 칸 · 없음 · "-") */
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && (v.trim() === "" || v.trim() === "-"));

/** "+1,234" · "-1,234" · "0" · "270,000" → 수, "" · "-" · 없음 → null */
function qty(v: unknown, key: string): number | null {
  if (blank(v)) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || !/^[+-]?[\d,]+$/.test(v.trim())) fail(`${key}=${JSON.stringify(v)}`);
  return Number(v.trim().replace(/,/g, "")) || 0;
}

/** "46.56%" → 46.56, "" · "-" → null */
function pct(v: unknown, key: string): number | null {
  if (blank(v)) return null;
  const m = typeof v === "string" ? /^(\d+(?:\.\d+)?)%?$/.exec(v.trim()) : null;
  if (!m) fail(`${key}=${JSON.stringify(v)}`);
  return Number(m[1]);
}

export function parseNaverTrend(json: unknown): FlowTrendRow[] {
  if (!Array.isArray(json)) fail("배열이 아닙니다");
  return json.map((raw) => {
    if (!raw || typeof raw !== "object") fail("줄이 객체가 아닙니다");
    const r = raw as Json;
    const d = r["bizdate"];
    if (typeof d !== "string" || !/^\d{8}$/.test(d)) fail(`bizdate=${JSON.stringify(d)}`);
    return {
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      individual: qty(r["individualPureBuyQuant"], "individualPureBuyQuant"),
      foreign: qty(r["foreignerPureBuyQuant"], "foreignerPureBuyQuant"),
      institution: qty(r["organPureBuyQuant"], "organPureBuyQuant"),
      otherCorp: null,
      foreignRatio: pct(r["foreignerHoldRatio"], "foreignerHoldRatio"),
      foreignHolding: null,
      foreignLimit: null,
      close: qty(r["closePrice"], "closePrice"),
      inMarketTime: null,
      hasAll: null,
      updatedAt: null,
    };
  });
}

export class NaverInvestorTrend implements FlowTrendSource {
  readonly name = "naver";

  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async trend(code: string, size: number = NAVER_TREND_MAX): Promise<FlowTrendRow[]> {
    const url = `${URL_BASE}/${encodeURIComponent(code)}/trend?pageSize=${Math.min(NAVER_TREND_MAX, Math.max(1, Math.floor(size)))}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } }, TIMEOUT_MS);
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
    return parseNaverTrend(json);
  }
}
