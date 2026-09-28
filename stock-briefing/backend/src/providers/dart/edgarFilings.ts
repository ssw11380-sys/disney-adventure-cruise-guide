/**
 * 3-38 새 공시 알림 (플래그 filingAlerts): SEC EDGAR submissions(`data.sec.gov/submissions/CIK##########.json`, 로그인·키 없음)에서
 * 알림 대상 서식의 최근 공시만 뽑는다. 받기는 EdgarProvider.submissionsJson(같은 User-Agent·요청 간격 gate)이 하고, 여기는 순수 함수만 둔다.
 *  - 알림 대상 서식: 8-K(수시)·10-Q(분기)·10-K(연간)·6-K(외국 기업 수시)·20-F(외국 기업 연간)·40-F(캐나다 기업 연간)와 각 정정(/A)
 *  - 그 밖(Form 4 내부자 거래·144·13G·DEF 14A·S-8·SD 등)은 저장하지 않는다 (종목 상세 뉴스 탭 공시 목록에는 지금처럼 있다)
 *  - 모양이 바뀌면(열 이름이 없거나 길이가 서로 다름) FilingShapeError — 줄을 넣지 않고 /health 에 'shape'
 */

/** 알림 대상 서식 (정정 /A 는 isAlertForm 이 함께 받는다) */
export const ALERT_FORMS: ReadonlySet<string> = new Set(["8-K", "10-Q", "10-K", "6-K", "20-F", "40-F"]);

/** 서식이 알림 대상인지 (정정 /A 포함) */
export function isAlertForm(form: string): boolean {
  return ALERT_FORMS.has(form.endsWith("/A") ? form.slice(0, -2) : form);
}

export interface SecFilingRow {
  /** 접수 번호 "0001193125-26-323632" */
  accession: string;
  /** "8-K" · "8-K/A" … */
  form: string;
  /** 8-K 항목 번호 ["2.02","9.01"] (8-K 외 []) */
  items: string[];
  /** SEC 접수 시각 (UTC, 초까지 "2026-07-29T20:04:53Z"). 읽지 못하면 null */
  acceptedAt: string | null;
  /** SEC 가 붙인 제출일 (미국 동부 17:30 뒤 접수는 다음 영업일) */
  filingDate: string;
  reportDate: string | null;
  /** 주 문서 파일 이름 "msft-20260729.htm" */
  primaryDoc: string;
  /** primaryDocDescription */
  description: string;
}

/** SEC 응답 모양이 예상과 다름 (열이 없거나 열 길이가 서로 다름) */
export class FilingShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilingShapeError";
  }
}

const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 8-K 항목 번호 모양 "2.02" */
const ITEM_RE = /^\d{1,2}\.\d{2}$/;

/** 순간(Date·ISO) → 초까지 UTC "2026-07-29T20:04:53Z" (저장·비교에 쓰는 한 가지 모양) */
export function isoSec(t: Date | number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** SEC acceptanceDateTime("2026-07-29T20:04:53.000Z") → "2026-07-29T20:04:53Z". 읽지 못하면 null */
export function acceptedIso(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  // 시간대 표시가 없으면 UTC 로 본다 (실측: 늘 Z 로 온다)
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  return Number.isNaN(t) ? null : isoSec(t);
}

/**
 * submissions JSON → 알림 대상 서식 줄 (sinceDate 이후 제출일, SEC 순서 그대로 — 최신 먼저).
 * items 는 쉼표로 나눈 8-K 항목 번호 (모양이 이상한 조각은 뺀다). 접수 번호 모양이 다른 줄은 뺀다
 */
export function parseRecentFilings(json: unknown, sinceDate: string): SecFilingRow[] {
  const recent = (json as { filings?: { recent?: Record<string, unknown> } } | null)?.filings?.recent;
  if (!recent || typeof recent !== "object") throw new FilingShapeError("filings.recent 가 없습니다");
  const col = (name: string, required = true): unknown[] | null => {
    const v = recent[name];
    if (Array.isArray(v)) return v;
    if (required) throw new FilingShapeError(`filings.recent.${name} 가 배열이 아닙니다`);
    return null;
  };
  const form = col("form")!;
  const accession = col("accessionNumber")!;
  const filingDate = col("filingDate")!;
  const primaryDoc = col("primaryDocument")!;
  const accepted = col("acceptanceDateTime", false);
  const items = col("items", false);
  const reportDate = col("reportDate", false);
  const desc = col("primaryDocDescription", false);
  const n = form.length;
  for (const [name, c] of Object.entries({ accessionNumber: accession, filingDate, primaryDocument: primaryDoc, acceptanceDateTime: accepted, items, reportDate, primaryDocDescription: desc })) {
    if (c && c.length !== n) throw new FilingShapeError(`filings.recent 열 길이가 다릅니다: form ${n} · ${name} ${c.length}`);
  }
  const out: SecFilingRow[] = [];
  for (let i = 0; i < n; i++) {
    const f = String(form[i] ?? "").trim().toUpperCase();
    if (!isAlertForm(f)) continue;
    const date = String(filingDate[i] ?? "");
    if (!DATE_RE.test(date) || date < sinceDate) continue;
    const acc = String(accession[i] ?? "");
    if (!ACCESSION_RE.test(acc)) continue;
    const rd = reportDate ? String(reportDate[i] ?? "") : "";
    out.push({
      accession: acc,
      form: f,
      items: f.startsWith("8-K") ? splitItems(items?.[i]) : [],
      acceptedAt: acceptedIso(accepted?.[i]),
      filingDate: date,
      reportDate: DATE_RE.test(rd) ? rd : null,
      primaryDoc: String(primaryDoc[i] ?? ""),
      description: String(desc?.[i] ?? "").trim(),
    });
  }
  return out;
}

/** "2.02,9.01" → ["2.02","9.01"] (겹치면 한 번, 모양이 이상한 조각은 뺀다) */
export function splitItems(v: unknown): string[] {
  if (typeof v !== "string") return [];
  const out: string[] = [];
  for (const raw of v.split(",")) {
    const x = raw.trim();
    if (ITEM_RE.test(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * SEC 원문 주소 (기존 getDisclosures 와 같은 규칙): https://www.sec.gov/Archives/edgar/data/{CIK 숫자}/{접수 번호에서 - 뺀 것}/{주 문서}.
 * 주 문서가 없으면 그 공시 목록 페이지
 */
export function filingUrl(cik: string, accession: string, primaryDoc: string): string {
  const acc = accession.replace(/-/g, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}`;
  // 파일 이름 조각만 ('..'·빈 조각·앞 '.' 없음) — 그 공시 폴더 밖을 가리키지 않게
  return primaryDoc && /^[\w-]+(?:[./][\w-]+)*$/.test(primaryDoc) ? `${base}/${primaryDoc}` : `${base}/${accession}-index.htm`;
}
