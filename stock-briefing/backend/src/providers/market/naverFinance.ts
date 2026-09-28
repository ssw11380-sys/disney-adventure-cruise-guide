import { isKrCode } from "../../lib/codes.js";
import { isTimeoutError, ProviderError } from "../../lib/errors.js";
import type { FetchFn } from "./types.js";

/**
 * 한국 종목 재무 요약 (3-44 3단계 '한국 간이 가치', 네이버 증권 모바일 공개 JSON — 로그인 없음).
 *  - 연간: m.stock.naver.com/api/stock/{code}/finance/annual — 최근 3개 결산(실적) + 다음 해 추정 1열
 *  - 분기: m.stock.naver.com/api/stock/{code}/finance/quarter — 최근 5개 분기(실적) + 다음 분기 추정 1열
 *  - 요약 지표: m.stock.naver.com/api/stock/{code}/integration — 네이버가 보이는 PER·PBR·EPS·BPS(교차 점검용)·업종 번호
 * 규칙 (설계 B9·A7):
 *  - 열은 trTitleList 의 isConsensus = "N"(실적)만 쓴다. "Y"(증권사 추정)는 버린다. 열 이름(키 202512)으로 정렬 — columns 객체의 순서는 섞여 온다
 *  - 금액 줄(매출액·영업이익·순이익)은 억원, 주당 줄(EPS·BPS·주당배당금)은 원, 비율 줄(ROE·부채비율·당좌비율 등)은 %. 줄 이름에 '(백만원)'·'(원)'이
 *    붙어 오면 억원으로 바꾼다. 값의 '-'·'N/A'·빈칸은 값 없음
 *  - integration 의 추정 PER·EPS(cnsPer·cnsEps)·consensusInfo(목표가·투자의견)·리포트 제목은 읽지 않는다
 * 요청: 공용 게이트로 요청 사이 최소 0.7초(밤 배치 한 번에 수백 종목 — 한 곳에 몰리지 않게), 10초 제한, 앱 화면과 같은 모바일 User-Agent
 */

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";
const BASE = "https://m.stock.naver.com/api/stock";
const TIMEOUT_MS = 10_000;
/** 요청 사이 최소 간격 (밤 배치가 네이버에 몰리지 않게) */
export const NAVER_FINANCE_GAP_MS = 700;
/** 없는 종목이라는 답 (네이버는 모르는 코드에 409 StockConflict·404) */
const NOT_FOUND = new Set([400, 404, 409]);

type Json = Record<string, unknown>;

export type KrRowKey =
  | "revenue"
  | "opIncome"
  | "netIncome"
  | "niControlling"
  | "niNci"
  | "opMargin"
  | "netMargin"
  | "roe"
  | "debtRatio"
  | "quickRatio"
  | "reserveRatio"
  | "eps"
  | "per"
  | "bps"
  | "pbr"
  | "dps";

/** 네이버 줄 이름 → 열쇠 (단위 괄호를 뗀 이름) */
export const KR_ROW_TITLES: Readonly<Record<string, KrRowKey>> = {
  매출액: "revenue",
  영업이익: "opIncome",
  당기순이익: "netIncome",
  지배주주순이익: "niControlling",
  비지배주주순이익: "niNci",
  영업이익률: "opMargin",
  순이익률: "netMargin",
  ROE: "roe",
  부채비율: "debtRatio",
  당좌비율: "quickRatio",
  유보율: "reserveRatio",
  EPS: "eps",
  PER: "per",
  BPS: "bps",
  PBR: "pbr",
  주당배당금: "dps",
};
/** 금액 줄 (억원으로 맞춘다) */
const AMOUNT_ROWS: ReadonlySet<KrRowKey> = new Set(["revenue", "opIncome", "netIncome", "niControlling", "niNci"]);

export interface KrFinanceColumn {
  /** 열 이름 '202512' */
  key: string;
  /** 결산·분기 끝 달 '2025-12' */
  end: string;
  values: Partial<Record<KrRowKey, number>>;
}
export interface KrFinanceTable {
  period: "annual" | "quarter";
  /** 실적 열만 (오래된 → 최신) */
  columns: KrFinanceColumn[];
  /** 버린 추정 열 수 (isConsensus = Y) */
  consensusDropped: number;
}

/**
 * 네이버 숫자 글 → 숫자. '3,336,059' · '-7,193원' · '12.13배' · '0.62%' · '1,581조 4,184억'(→ 원) · '−2.5'. 값 없음('-'·'N/A'·빈칸)은 null
 */
export function parseKrNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/−/g, "-");
  if (!s || s === "-" || /^n\/?a$/i.test(s)) return null;
  // 조·억 단위 (시가총액 등): '1,581조 4,184억' → 원
  if (/[조억]/.test(s)) {
    const jo = /(-?[\d,.]+)\s*조/.exec(s);
    const eok = /(-?[\d,.]+)\s*억/.exec(s);
    const n = (m: RegExpExecArray | null) => (m ? Number(m[1]!.replace(/,/g, "")) : 0);
    const total = n(jo) * 1e12 + n(eok) * 1e8;
    return (jo || eok) && Number.isFinite(total) ? total : null;
  }
  const t = s.replace(/[,\s원배%]/g, "");
  if (!t || t === "-") return null;
  const x = Number(t);
  return Number.isFinite(x) ? x : null;
}

/** 줄 이름에서 단위 괄호를 떼고, 금액 줄을 억원으로 맞추는 배수 ('매출액(백만원)' → ['매출액', 0.01]) */
function titleUnit(title: string): { name: string; scale: number } {
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(title.trim());
  if (!m) return { name: title.trim(), scale: 1 };
  const unit = m[2]!.replace(/\s/g, "");
  const scale = unit === "백만원" ? 0.01 : unit === "천원" ? 1e-5 : unit === "원" ? 1e-8 : unit === "조원" ? 1e4 : 1;
  return { name: m[1]!.trim(), scale };
}

/** finance/annual · finance/quarter 원본 → 실적 열 표. 모양이 다르면 null */
export function parseNaverFinance(raw: unknown, period: "annual" | "quarter"): KrFinanceTable | null {
  const info = (raw as Json | null)?.["financeInfo"] as Json | undefined;
  const titles = info?.["trTitleList"];
  const rows = info?.["rowList"];
  if (!Array.isArray(titles) || !Array.isArray(rows)) return null;
  const actual: string[] = [];
  let dropped = 0;
  for (const t of titles as Json[]) {
    const key = typeof t["key"] === "string" ? t["key"] : "";
    if (!/^\d{6}$/.test(key)) continue;
    if (String(t["isConsensus"] ?? "N").toUpperCase() !== "N") {
      dropped++;
      continue;
    }
    actual.push(key);
  }
  actual.sort();
  const columns: KrFinanceColumn[] = actual.map((key) => ({ key, end: `${key.slice(0, 4)}-${key.slice(4, 6)}`, values: {} }));
  const byKey = new Map(columns.map((c) => [c.key, c]));
  for (const r of rows as Json[]) {
    const { name, scale } = titleUnit(String(r["title"] ?? ""));
    const k = KR_ROW_TITLES[name];
    if (!k) continue;
    const cols = (r["columns"] as Record<string, Json> | undefined) ?? {};
    for (const [key, cell] of Object.entries(cols)) {
      const col = byKey.get(key);
      if (!col) continue; // 추정 열·모르는 열
      const raw = cell?.["value"];
      const v = parseKrNumber(raw);
      if (v === null) continue;
      // 값에 '억'·'조'가 붙어 오면 parseKrNumber 가 원으로 바꾼 것 → 억원으로
      const won = typeof raw === "string" && /[조억]/.test(raw);
      col.values[k] = AMOUNT_ROWS.has(k) ? (won ? v / 1e8 : v * scale) : v;
    }
  }
  return { period, columns, consensusDropped: dropped };
}

/** integration 에서 쓰는 것만 (교차 점검·업종 번호). 추정 PER·EPS·목표가·투자의견은 읽지 않는다 */
export interface KrIntegration {
  name: string | null;
  endType: string | null;
  industryCode: string | null;
  per: number | null;
  eps: number | null;
  pbr: number | null;
  bps: number | null;
  /** PER·EPS 가 어느 분기 기준인지 ('2026.06.' → '2026-06') */
  perAsOf: string | null;
  /** 시가총액 (원) */
  marketCap: number | null;
}

export function parseNaverIntegration(raw: unknown): KrIntegration | null {
  const j = raw as Json | null;
  const infos = j?.["totalInfos"];
  if (!j || !Array.isArray(infos)) return null;
  const m = new Map<string, Json>();
  for (const it of infos as Json[]) if (typeof it["code"] === "string") m.set(it["code"], it);
  const n = (k: string) => parseKrNumber(m.get(k)?.["value"]);
  const desc = m.get("per")?.["valueDesc"] ?? m.get("eps")?.["valueDesc"];
  const d = typeof desc === "string" ? /^(\d{4})\.(\d{2})/.exec(desc) : null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    name: text(j["stockName"]),
    endType: text(j["stockEndType"]),
    industryCode: text(j["industryCode"]),
    per: n("per"),
    eps: n("eps"),
    pbr: n("pbr"),
    bps: n("bps"),
    perAsOf: d ? `${d[1]}-${d[2]}` : null,
    marketCap: n("marketValue"),
  };
}

/** 한국 종목 재무 요약 받기 (공용 게이트로 요청 사이 0.7초 — 밤 배치·화면 요청 백그라운드 받기 모두) */
export class NaverFinanceClient {
  readonly name = "naver-finance";
  private nextAt = 0;

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly opts: { gapMs?: number; timeoutMs?: number } = {},
  ) {}

  private async gate(): Promise<void> {
    const gap = this.opts.gapMs ?? NAVER_FINANCE_GAP_MS;
    if (gap <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  /** JSON 한 번. 없는 종목(400·404·409)은 null, 그 밖의 실패는 ProviderError */
  private async json(url: string): Promise<unknown | null> {
    await this.gate();
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS) });
    } catch (e) {
      throw new ProviderError(this.name, `${isTimeoutError(e) ? "시간 초과" : "네트워크 오류"}: ${url}`, e);
    }
    if (NOT_FOUND.has(res.status)) return null;
    if (!res.ok) throw new ProviderError(this.name, `HTTP ${res.status}: ${url}`);
    try {
      return await res.json();
    } catch (e) {
      throw new ProviderError(this.name, `JSON 읽기 실패: ${url}`, e);
    }
  }

  /** 연간·분기 두 번 (+ summary 면 요약 지표 한 번 — 대상 종목만, 밤 배치의 비교 회사는 받지 않는다). 없는 종목이면 null */
  async finance(code: string, opts: { summary?: boolean } = {}): Promise<{ annual: unknown; quarter: unknown; integration: unknown | null } | null> {
    if (!isKrCode(code)) throw new ProviderError(this.name, `한국 종목만 지원합니다: ${code}`);
    const annual = await this.json(`${BASE}/${code}/finance/annual`);
    if (annual === null) return null;
    const quarter = await this.json(`${BASE}/${code}/finance/quarter`);
    if (quarter === null) return null;
    // 요약 지표는 교차 점검·업종 번호용 — 받지 못해도 재무는 쓴다
    const integration = opts.summary === false ? null : await this.json(`${BASE}/${code}/integration`).catch(() => null);
    return { annual, quarter, integration };
  }
}
