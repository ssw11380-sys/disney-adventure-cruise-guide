import { isKrCode, normalizeCode } from "../../lib/codes.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";
import { krRegularHours, parts, tradingDate } from "../../services/marketContext.js";
import type { FetchFn } from "./types.js";

/**
 * 한국 종목 기준가 — 토스증권·네이버가 '전일 대비'를 재는 값 (직전 거래일 한국거래소 정규장 종가, 권리락·배당락 날은 조정 기준가).
 *
 * 왜 따로 받나: 토스증권 공식 Open API 는 기준가를 주지 않고, 일봉 종가는 NXT 애프터마켓(20:00)까지 든 통합 종가다.
 * 그 종가로 등락을 내면 애프터마켓에서 가격이 움직인 종목은 토스 앱과 다르다
 * (2026-11-11: 삼성전자 통합 종가 197,300 기준 +5.42% · 토스 198,900 기준 +4.57%, 현대차는 부호가 반대 +0.18% · 토스 −0.18%).
 * 예전에는 토스 웹 시세의 base 를 썼는데 2026-11 에 그 주소가 막혔다(HTTP 400 invalid-client-state).
 *
 * 출처: 네이버 증권 실시간 시세 (polling.finance.naver.com — 로그인·키 없음, 여러 종목을 콤마로 한 번에).
 *   closePrice = 한국거래소 정규장 현재가/종가 (정규장이 끝난 뒤에도 정규장 종가 그대로 — NXT 애프터마켓 가격은 overMarketPriceInfo 에 따로),
 *   compareToPreviousClosePrice = 기준가 대비 → 기준가 = closePrice − 전일 대비
 *
 * 거래일이 바뀌는 순간(08:00 NXT 프리마켓 시작)부터 한국거래소 정규장이 열리기 전까지 네이버 값은 아직 지난 거래일 것이다.
 * 이때 새 거래일의 기준가는 지난 거래일의 정규장 종가(closePrice) 그 자체다:
 *   - 네이버 체결 날짜 = 지금 거래일 → 기준가 = closePrice − 전일 대비
 *   - 네이버 체결 날짜 < 지금 거래일, 새 거래일이 시작됨(개장 전이거나 다른 종목은 오늘 체결됨) → 기준가 = closePrice
 *   - 네이버 체결 날짜 < 지금 거래일인데 개장 시각이 지나도 어느 종목도 오늘 체결이 없음(목록에 없는 임시 휴장) → 지난 거래일 기준 그대로
 * 기준가는 거래일 동안 바뀌지 않으므로, 한 번 받은 값은 그 거래일이 끝날 때까지 새로 받지 못해도 그대로 쓴다.
 */

const POLLING_URL = "https://polling.finance.naver.com/api/realtime/domestic/stock";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";
/** 장이 열렸는지 보는 기준 종목 (삼성전자 — 거래일이면 개장 직후 반드시 체결된다). 요청마다 함께 묻는다 */
const SENTINEL = "005930";
/** 한 요청에 넣는 종목 수 */
const CHUNK = 40;
/** 받은 기준가를 다시 확인하는 간격. 그 사이에는 요청하지 않는다 */
const RECHECK_MS = 60_000;
/** 개장 전(종목은 아직 체결 전)으로 받은 값은 더 자주 다시 확인한다 — 개장하면 조정 기준가(권리락 등)로 바로 바뀌게 */
const RECHECK_PREOPEN_MS = 20_000;
/** 요청 하나의 제한 시간 */
const TIMEOUT_MS = 4_000;
/** 실패한 뒤 다시 묻기까지 쉬는 시간 (네이버가 죽었을 때 시세 갱신마다 두드리지 않게) */
const RETRY_AFTER_FAIL_MS = 15_000;
/** 개장 시각에서 이만큼 지나도 기준 종목 체결이 없으면 오늘은 열리지 않은 날로 본다 */
const OPEN_GRACE_MIN = 10;

type Json = Record<string, unknown>;

export interface KrBaseRow {
  /** 네이버가 준 한국거래소 정규장 현재가/종가 */
  close: number;
  /** 기준가 대비 (부호 있음) */
  change: number;
  /** 마지막 체결의 서울 날짜 YYYY-MM-DD */
  tradedDate: string;
}

interface Held {
  /** 이 기준가가 맞는 거래일 (서울 날짜) */
  day: string;
  base: number;
  at: number;
  /** 개장 전이라 지난 거래일 종가로 정한 값 (개장하면 다시 확인) */
  preOpen: boolean;
}

function digits(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,\s원]/g, "");
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 네이버 등락 구분: 1 상한 · 2 상승 · 3 보합 · 4 하한 · 5 하락 */
function signOf(compare: unknown): 1 | -1 | 0 {
  const code = String((compare as Json | undefined)?.["code"] ?? "");
  if (code === "1" || code === "2") return 1;
  if (code === "4" || code === "5") return -1;
  return 0;
}

/** 네이버 실시간 시세 한 줄 → 정규장 가격·전일 대비·체결 날짜. 칸이 모자라면 null */
export function parseKrBaseRow(d: Json): KrBaseRow | null {
  const close = digits(d["closePriceRaw"]) ?? digits(d["closePrice"]);
  const abs = digits(d["compareToPreviousClosePriceRaw"]) ?? digits(d["compareToPreviousClosePrice"]);
  const at = typeof d["localTradedAt"] === "string" ? Date.parse(d["localTradedAt"]) : NaN;
  if (close === null || close <= 0 || abs === null || Number.isNaN(at)) return null;
  // 이미 부호가 붙어 오면 그대로, 절댓값이면 구분 코드로 부호를 붙인다
  const change = abs < 0 ? abs : signOf(d["compareToPreviousPrice"]) * abs;
  return { close, change, tradedDate: parts(new Date(at), "Asia/Seoul").date };
}

/**
 * 지금 거래일(day)의 기준가를 고른다 (위 규칙). marketTraded: 기준 종목이 오늘 체결됐는지, preOpenWindow: 오늘이 거래일이고 아직 개장 전(여유 포함)인지.
 * 못 정하면 null
 */
export function pickKrBase(row: KrBaseRow, day: string, o: { marketTraded: boolean; preOpenWindow: boolean }): { base: number; preOpen: boolean } | null {
  const fromChange = row.close - row.change;
  if (row.tradedDate >= day) return fromChange > 0 ? { base: fromChange, preOpen: false } : null;
  // 네이버 값이 지난 거래일 것: 새 거래일이 시작됐으면 그 정규장 종가가 오늘 기준가
  if (o.marketTraded || o.preOpenWindow) return { base: row.close, preOpen: true };
  return fromChange > 0 ? { base: fromChange, preOpen: false } : null;
}

export class NaverKrBase {
  readonly name = "naver-base";
  private readonly held = new Map<string, Held>();
  private inflight: { codes: Set<string>; p: Promise<void> } | null = null;
  private failedAt = -Infinity;
  private readonly stats = { ok: 0, failed: 0, lastOkAt: null as string | null, lastError: null as string | null };

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 운영 확인용 (/health) */
  status(): { held: number; ok: number; failed: number; lastOkAt: string | null; lastError: string | null } {
    return { held: this.held.size, ...this.stats };
  }

  /**
   * 여러 종목의 지금 거래일 기준가. 받아 둔 값이 있으면 요청 없이, 없거나 오래됐으면 한 번에 받는다.
   * 새로 받지 못해도 같은 거래일에 받아 둔 값은 그대로 돌려준다 (기준가는 그날 바뀌지 않는다). 모르는 종목은 빠진다
   */
  async baseMany(codes: string[]): Promise<Map<string, number>> {
    const list = [...new Set(codes.map(normalizeCode))].filter(isKrCode);
    if (list.length === 0) return new Map();
    const t = this.now().getTime();
    const day = tradingDate(this.now().toISOString(), true);
    const fresh = (c: string) => {
      const h = this.held.get(c);
      return !!h && h.day === day && t - h.at < (h.preOpen ? RECHECK_PREOPEN_MS : RECHECK_MS);
    };
    const need = list.filter((c) => !fresh(c));
    if (need.length && t - this.failedAt >= RETRY_AFTER_FAIL_MS) {
      // 같은 종목을 받는 요청이 나가 있으면 그것을 같이 기다린다 (잔고·상세·브리핑이 동시에 물을 때)
      if (this.inflight && need.every((c) => this.inflight!.codes.has(c))) await this.inflight.p;
      else {
        const entry = { codes: new Set(need), p: this.refresh(need, day).catch(() => undefined) };
        this.inflight = entry;
        try {
          await entry.p;
        } finally {
          if (this.inflight === entry) this.inflight = null;
        }
      }
    }
    const out = new Map<string, number>();
    for (const c of list) {
      const h = this.held.get(c);
      if (h && h.day === day) out.set(c, h.base);
    }
    return out;
  }

  /** 한 종목 기준가 (없으면 null) */
  async basePrice(code: string): Promise<number | null> {
    const c = normalizeCode(code);
    return (await this.baseMany([c])).get(c) ?? null;
  }

  private async refresh(codes: string[], day: string): Promise<void> {
    const ask = codes.includes(SENTINEL) ? codes : [SENTINEL, ...codes];
    const rows = new Map<string, KrBaseRow>();
    try {
      for (let i = 0; i < ask.length; i += CHUNK) {
        const chunk = ask.slice(i, i + CHUNK);
        const res = await fetchWithTimeout(this.fetchFn, `${POLLING_URL}/${chunk.join(",")}`, { headers: { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" } }, TIMEOUT_MS);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { datas?: Json[] };
        for (const d of json.datas ?? []) {
          const code = String(d["itemCode"] ?? "");
          const row = parseKrBaseRow(d);
          if (code && row) rows.set(code, row);
        }
      }
    } catch (e) {
      this.failedAt = this.now().getTime();
      this.stats.failed++;
      this.stats.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
    const now = this.now();
    const seoul = parts(now, "Asia/Seoul");
    const marketTraded = rows.get(SENTINEL)?.tradedDate === day;
    // 오늘이 그 거래일이고(08:00 이후) 정규장 개장 + 여유 전이면 '개장 전'
    const preOpenWindow = seoul.date === day && seoul.minutes < krRegularHours(day).open + OPEN_GRACE_MIN;
    const at = now.getTime();
    for (const c of codes) {
      const row = rows.get(c);
      const picked = row ? pickKrBase(row, day, { marketTraded, preOpenWindow }) : null;
      if (picked) this.held.set(c, { day, base: picked.base, at, preOpen: picked.preOpen });
    }
    // 지난 거래일 값은 버린다 (종목을 지워도 남지 않게)
    for (const [c, h] of this.held) if (h.day !== day) this.held.delete(c);
    this.stats.ok++;
    this.stats.lastOkAt = now.toISOString();
    this.stats.lastError = null;
  }
}
