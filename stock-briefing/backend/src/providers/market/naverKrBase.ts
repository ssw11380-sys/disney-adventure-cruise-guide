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
 * 출처: 네이버 증권 (로그인·키 없음)
 *   실시간 시세 polling.finance.naver.com — 여러 종목을 콤마로 한 번에
 *     closePrice = 한국거래소 현재가. 정규장이 끝난 뒤에도 애프터마켓(16:00~20:00) 체결이 있으면 그 가격으로 계속 바뀐다 — 정규장 종가가 아니다
 *       (2026-11-11 삼성전자: 15:30 정규장 종가 206,000 · 20:00 closePrice 208,000)
 *     compareToPreviousClosePrice = 그 거래일 기준가 대비 → 그 거래일 기준가 = closePrice − 전일 대비 (애프터마켓 중에도 성립)
 *     overMarketPriceInfo = NXT 프리·애프터마켓 시세 (overPrice · 기준가 대비 · 체결 시각)
 *   분봉 api.stock.naver.com/chart/domestic/item/<코드>/minute — 정규장 마감 시각(15:30)의 봉이 정규장 종가
 *     (2026-11-10 15:30 봉 198,900 · 1,212,000 · 275,000 · 193,000 = 11/11 에 토스·네이버가 쓴 기준가와 같음)
 *
 * 거래일이 바뀌는 순간(08:00 NXT 프리마켓 시작)부터 그 종목이 한국거래소 정규장에서 체결되기 전까지 네이버 값은 지난 거래일 것이다.
 * 이때 새 거래일의 기준가는 지난 거래일의 '정규장' 종가다 (애프터마켓 마지막 가격이 아니다):
 *   1) 네이버 체결 날짜 = 지금 거래일 → 기준가 = closePrice − 전일 대비
 *   2) 오늘 NXT 프리마켓에서 체결됨(overMarketPriceInfo 의 체결 날짜 = 지금 거래일) → 기준가 = overPrice − 그 기준가 대비 (네이버가 오늘 기준가로 잰 값)
 *   3) 새 거래일이 시작됐는데(개장 전이거나 다른 종목은 오늘 체결됨) 이 종목은 아직 체결 전 → 지난 거래일 정규장 종가:
 *      - 분봉에서 정규장 마감 시각(보통 15:30, 수능일 16:30 — krRegularHours)까지의 마지막 가격
 *      - 지난 거래일 마지막 체결이 정규장 안이면(애프터마켓 체결 없음 — ETF 등) closePrice 가 곧 정규장 종가라 분봉을 묻지 않는다
 *      - 분봉을 아직 못 받았으면 closePrice 를 어림값(approx)으로 쓰고, 받는 대로 바꾼다
 *   4) 네이버 체결 날짜 < 지금 거래일인데 개장 시각이 지나도 어느 종목도 오늘 체결이 없음(목록에 없는 임시 휴장) → 지난 거래일 기준 그대로
 * 분봉은 저녁(애프터마켓에서 가격이 움직인 것을 본 때)에 미리 받아 둔다 — 아침 08:00 에 기다리지 않게.
 *
 * 기준가는 거래일 동안 바뀌지 않으므로, 한 번 받은 값은 그 거래일이 끝날 때까지 새로 받지 못해도 그대로 쓴다.
 * 받아 둔 값이 있으면 다시 확인은 뒤에서 한다 — 네이버가 느려도 부르는 쪽(시세 조회)을 기다리게 하지 않는다.
 */

const POLLING_URL = "https://polling.finance.naver.com/api/realtime/domestic/stock";
const MINUTE_URL = "https://api.stock.naver.com/chart/domestic/item";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36";
const HEADERS = { "user-agent": UA, accept: "application/json", referer: "https://m.stock.naver.com/" };
/** 장이 열렸는지 보는 기준 종목 (삼성전자 — 거래일이면 개장 직후 반드시 체결된다). 요청마다 함께 묻는다 */
const SENTINEL = "005930";
/** 한 요청에 넣는 종목 수 */
const CHUNK = 40;
/** 받은 기준가를 다시 확인하는 간격. 그 사이에는 요청하지 않는다. 네이버가 값을 주지 않은 종목도 이 동안은 다시 묻지 않는다 */
const RECHECK_MS = 60_000;
/** 개장 전(종목은 아직 체결 전)으로 받은 값은 더 자주 다시 확인한다 — 개장하면 조정 기준가(권리락 등)로 바로 바뀌게 */
const RECHECK_PREOPEN_MS = 20_000;
/** 요청 하나의 제한 시간 */
const TIMEOUT_MS = 4_000;
/** 실패한 뒤 다시 묻기까지 쉬는 시간 (네이버가 죽었을 때 시세 갱신마다 두드리지 않게) */
const RETRY_AFTER_FAIL_MS = 15_000;
/** 개장 시각에서 이만큼 지나도 기준 종목 체결이 없으면 오늘은 열리지 않은 날로 본다 */
const OPEN_GRACE_MIN = 10;
/** 정규장 종가(분봉)를 기다리는 최대 시간 — 넘으면 어림값으로 먼저 답하고 받는 대로 바꾼다 */
const REGULAR_WAIT_MS = 900;
/** 분봉 요청을 동시에 보내는 수 */
const REGULAR_CONCURRENCY = 4;
/** 분봉을 받지 못한 종목을 다시 묻기까지 */
const REGULAR_RETRY_MS = 30_000;
/** 받아 둔 정규장 종가를 버리는 나이 (달력 날짜) */
const REGULAR_KEEP_DAYS = 10;

type Json = Record<string, unknown>;

export interface KrBaseRow {
  /** 네이버가 준 한국거래소 현재가 (정규장 뒤 애프터마켓 체결이 있으면 그 가격 — 정규장 종가가 아닐 수 있다) */
  close: number;
  /** 그 거래일 기준가 대비 (부호 있음) */
  change: number;
  /** 마지막 체결의 서울 날짜 YYYY-MM-DD */
  tradedDate: string;
  /** 마지막 체결의 서울 시각 (자정부터 분) */
  tradedMinutes: number;
  /** NXT 프리·애프터마켓 시세 (없으면 null): 가격 · 그 거래일 기준가 대비 · 체결 날짜 */
  over: { price: number; change: number; tradedDate: string } | null;
}

interface Held {
  /** 이 기준가가 맞는 거래일 (서울 날짜) */
  day: string;
  base: number;
  at: number;
  /** 개장 전이라 지난 거래일 값으로 정한 값 (개장하면 다시 확인) */
  preOpen: boolean;
  /** 정규장 종가를 아직 몰라 마지막 체결가로 어림한 값 (분봉을 받으면 바뀐다) */
  approx: boolean;
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

/** 이미 부호가 붙어 오면 그대로, 절댓값이면 구분 코드로 부호를 붙인다 */
const signed = (abs: number, compare: unknown): number => (abs < 0 ? abs : signOf(compare) * abs);

/** 자정부터 분 → "HHMM" */
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`;

/** overMarketPriceInfo (NXT 프리·애프터마켓) → 가격·기준가 대비·체결 날짜. 칸이 모자라면 null */
function parseOver(v: unknown): KrBaseRow["over"] {
  if (!v || typeof v !== "object") return null;
  const o = v as Json;
  const price = digits(o["overPriceRaw"]) ?? digits(o["overPrice"]);
  const abs = digits(o["compareToPreviousClosePriceRaw"]) ?? digits(o["compareToPreviousClosePrice"]);
  const at = typeof o["localTradedAt"] === "string" ? Date.parse(o["localTradedAt"]) : NaN;
  if (price === null || price <= 0 || abs === null || Number.isNaN(at)) return null;
  return { price, change: signed(abs, o["compareToPreviousPrice"]), tradedDate: parts(new Date(at), "Asia/Seoul").date };
}

/** 네이버 실시간 시세 한 줄 → 현재가·전일 대비·체결 날짜와 시각·시간외 시세. 칸이 모자라면 null */
export function parseKrBaseRow(d: Json): KrBaseRow | null {
  const close = digits(d["closePriceRaw"]) ?? digits(d["closePrice"]);
  const abs = digits(d["compareToPreviousClosePriceRaw"]) ?? digits(d["compareToPreviousClosePrice"]);
  const at = typeof d["localTradedAt"] === "string" ? Date.parse(d["localTradedAt"]) : NaN;
  if (close === null || close <= 0 || abs === null || Number.isNaN(at)) return null;
  const seoul = parts(new Date(at), "Asia/Seoul");
  return { close, change: signed(abs, d["compareToPreviousPrice"]), tradedDate: seoul.date, tradedMinutes: seoul.minutes, over: parseOver(d["overMarketPriceInfo"]) };
}

/**
 * 분봉 목록에서 그 날짜(date) 정규장 마감 시각(closeMinutes — 자정부터 분)까지의 마지막 가격 = 정규장 종가.
 * 마감 동시호가(15:20~15:30)에는 봉이 없고 15:30 봉이 종가 단일가다. 그 뒤 봉(시간외 종가·애프터마켓)은 쓰지 않는다. 없으면 null
 */
export function pickRegularClose(rows: unknown, date: string, closeMinutes: number): number | null {
  if (!Array.isArray(rows)) return null;
  const ymd = date.replaceAll("-", "");
  const limit = `${ymd}${hhmm(closeMinutes)}59`;
  let best: { at: string; price: number } | null = null;
  for (const r of rows as Json[]) {
    const at = String(r?.["localDateTime"] ?? "");
    const price = digits(r?.["currentPrice"]);
    if (!/^\d{14}$/.test(at) || !at.startsWith(ymd) || at > limit || price === null || price <= 0) continue;
    if (!best || at > best.at) best = { at, price };
  }
  return best?.price ?? null;
}

/**
 * 지금 거래일(day)의 기준가를 고른다 (위 규칙 1~4).
 *  - marketTraded: 기준 종목이 오늘 체결됐는지, preOpenWindow: 오늘이 거래일이고 아직 개장 전(여유 포함)인지
 *  - regularClose: 이 줄의 체결 날짜(지난 거래일)의 정규장 종가를 분봉에서 받아 둔 값 (없으면 null)
 * approx: 정규장 종가를 몰라 마지막 체결가로 어림했다. 못 정하면 null
 */
export function pickKrBase(
  row: KrBaseRow,
  day: string,
  o: { marketTraded: boolean; preOpenWindow: boolean; regularClose?: number | null },
): { base: number; preOpen: boolean; approx: boolean } | null {
  const fromChange = row.close - row.change;
  if (row.tradedDate >= day) return fromChange > 0 ? { base: fromChange, preOpen: false, approx: false } : null;
  // 오늘 NXT 프리마켓에서 체결된 종목: 네이버가 오늘 기준가로 잰 '기준가 대비'가 있다 (권리락 날의 조정 기준가도 이 값)
  if (row.over && row.over.tradedDate >= day) {
    const fromOver = row.over.price - row.over.change;
    if (fromOver > 0) return { base: fromOver, preOpen: true, approx: false };
  }
  if (o.marketTraded || o.preOpenWindow) {
    // 새 거래일이 시작됐는데 이 종목은 아직 체결 전: 오늘 기준가 = 지난 거래일 '정규장' 종가
    if (o.regularClose != null && o.regularClose > 0) return { base: o.regularClose, preOpen: true, approx: false };
    // 마지막 체결이 정규장 안이면(애프터마켓 체결 없음) closePrice 가 곧 정규장 종가
    if (row.tradedMinutes <= krRegularHours(row.tradedDate).close) return { base: row.close, preOpen: true, approx: false };
    // 애프터마켓에서 가격이 움직였는데 정규장 종가를 아직 모른다 → 마지막 체결가로 어림 (분봉을 받으면 바뀐다)
    return { base: row.close, preOpen: true, approx: true };
  }
  return fromChange > 0 ? { base: fromChange, preOpen: false, approx: false } : null;
}

/**
 * 기준가 출처 두 개를 잇는다: 먼저 primary(네이버), 거기에 없는 종목만 fallback(토스 웹)에 한 번 더 묻는다.
 * fallback 은 waitMs 만 기다린다 — 느리거나 막혀 있어도 primary 가 준 값까지 늦어지지(버려지지) 않게
 */
export async function krBaseWithFallback(
  codes: string[],
  primary: (codes: string[]) => Promise<Map<string, number>>,
  fallback: (codes: string[]) => Promise<Map<string, number>>,
  waitMs = 700,
): Promise<Map<string, number>> {
  const out = new Map(await primary(codes).catch(() => new Map<string, number>()));
  const missing = codes.filter((c) => !out.has(c));
  if (missing.length === 0) return out;
  const extra = await new Promise<Map<string, number>>((resolve) => {
    const timer = setTimeout(() => resolve(new Map()), waitMs);
    void fallback(missing)
      .catch(() => new Map<string, number>())
      .then((m) => {
        clearTimeout(timer);
        resolve(m);
      });
  });
  for (const [c, b] of extra) out.set(c, b);
  return out;
}

export class NaverKrBase {
  readonly name = "naver-base";
  private readonly held = new Map<string, Held>();
  /** 종목별 지난 거래일 정규장 종가 (분봉에서) — 새 거래일 개장 전 기준가로 쓴다 */
  private readonly regular = new Map<string, { date: string; price: number }>();
  private readonly regularInflight = new Map<string, Promise<number | null>>();
  private readonly regularFailedAt = new Map<string, number>();
  private regularActive = 0;
  private readonly regularQueue: Array<() => void> = [];
  /** 네이버가 값을 주지 않은 종목을 물은 시각 — RECHECK_MS 동안은 그 종목 때문에 다시 묻지 않는다 */
  private readonly missAt = new Map<string, number>();
  private inflight: { codes: Set<string>; p: Promise<void> } | null = null;
  private failedAt = -Infinity;
  private readonly stats = { ok: 0, failed: 0, regularOk: 0, regularFailed: 0, lastOkAt: null as string | null, lastError: null as string | null, regularLastError: null as string | null };
  private readonly regularWaitMs: number;

  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
    opts: { regularWaitMs?: number } = {},
  ) {
    this.regularWaitMs = opts.regularWaitMs ?? REGULAR_WAIT_MS;
  }

  /** 운영 확인용 (/health). approx: 정규장 종가를 아직 몰라 어림값을 쓰는 종목 수, regular: 받아 둔 정규장 종가 수 */
  status(): { held: number; approx: number; regular: number; ok: number; failed: number; regularOk: number; regularFailed: number; lastOkAt: string | null; lastError: string | null; regularLastError: string | null } {
    let approx = 0;
    for (const h of this.held.values()) if (h.approx) approx++;
    return { held: this.held.size, approx, regular: this.regular.size, ...this.stats };
  }

  /** 뒤에서 도는 갱신(다시 확인 · 분봉)이 끝날 때까지 기다린다 (테스트·종료용) */
  async idle(): Promise<void> {
    for (let i = 0; i < 20 && (this.inflight || this.regularInflight.size); i++) {
      await this.inflight?.p;
      await Promise.all([...this.regularInflight.values()]);
    }
  }

  /**
   * 여러 종목의 지금 거래일 기준가. 모르는 종목은 빠진다.
   *  - 받아 둔 값이 모두 있으면(같은 거래일) 바로 돌려주고, 오래된 값의 다시 확인은 뒤에서 한다 (기다리지 않는다)
   *  - 받아 둔 값이 없는 종목이 있을 때만 받아 오기를 기다린다. 새로 받지 못해도 받아 둔 값은 그대로 돌려준다
   */
  async baseMany(codes: string[]): Promise<Map<string, number>> {
    const list = [...new Set(codes.map(normalizeCode))].filter(isKrCode);
    if (list.length === 0) return new Map();
    const t = this.now().getTime();
    const day = tradingDate(this.now().toISOString(), true);
    const have = (c: string) => this.held.get(c)?.day === day;
    const fresh = (c: string) => {
      const h = this.held.get(c);
      if (h && h.day === day) return t - h.at < (h.preOpen ? RECHECK_PREOPEN_MS : RECHECK_MS);
      return t - (this.missAt.get(c) ?? -Infinity) < RECHECK_MS;
    };
    const need = list.filter((c) => !fresh(c));
    if (need.length && t - this.failedAt >= RETRY_AFTER_FAIL_MS) {
      const p = this.request(need, day);
      if (need.some((c) => !have(c))) await p;
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

  /** 받아 오기 1회. 같은 종목을 받는 요청이 나가 있으면 그것을 같이 쓴다 (잔고·상세·브리핑이 동시에 물을 때). 던지지 않는다 */
  private request(need: string[], day: string): Promise<void> {
    if (this.inflight && need.every((c) => this.inflight!.codes.has(c))) return this.inflight.p;
    const entry: { codes: Set<string>; p: Promise<void> } = { codes: new Set(need), p: Promise.resolve() };
    entry.p = this.refresh(need, day)
      .catch(() => undefined)
      .finally(() => {
        if (this.inflight === entry) this.inflight = null;
      });
    this.inflight = entry;
    return entry.p;
  }

  private async refresh(codes: string[], day: string): Promise<void> {
    const ask = codes.includes(SENTINEL) ? codes : [SENTINEL, ...codes];
    const rows = new Map<string, KrBaseRow>();
    try {
      for (let i = 0; i < ask.length; i += CHUNK) {
        const chunk = ask.slice(i, i + CHUNK);
        const res = await fetchWithTimeout(this.fetchFn, `${POLLING_URL}/${chunk.join(",")}`, { headers: HEADERS }, TIMEOUT_MS);
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
    /** 지금 어림값을 쓰는 종목의 분봉 — 잠깐 기다려 본다 */
    const pending: Promise<void>[] = [];
    for (const c of codes) {
      const row = rows.get(c);
      const known = row ? this.regular.get(c) : undefined;
      const regularClose = row && known?.date === row.tradedDate ? known.price : null;
      const picked = row ? pickKrBase(row, day, { marketTraded, preOpenWindow, regularClose }) : null;
      if (!row || !picked) {
        this.missAt.set(c, at);
        continue;
      }
      this.missAt.delete(c);
      this.held.set(c, { day, base: picked.base, at, preOpen: picked.preOpen, approx: picked.approx });
      if (picked.approx) {
        pending.push(
          this.regularClose(c, row.tradedDate).then((price) => {
            const h = this.held.get(c);
            if (price !== null && h && h.day === day && h.approx) this.held.set(c, { ...h, base: price, approx: false });
          }),
        );
      } else if (row.tradedDate === day && regularClose === null && row.tradedMinutes > krRegularHours(row.tradedDate).close) {
        // 저녁: 애프터마켓에서 가격이 움직였다 → 내일 아침에 쓸 정규장 종가를 미리 받아 둔다 (기다리지 않는다)
        void this.regularClose(c, row.tradedDate);
      }
    }
    // 지난 거래일 값·오래된 기록은 버린다 (종목을 지워도 남지 않게)
    for (const [c, h] of this.held) if (h.day !== day) this.held.delete(c);
    const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - REGULAR_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const [c, r] of this.regular) if (r.date < cutoff) this.regular.delete(c);
    for (const [c, missed] of this.missAt) if (at - missed > 10 * RECHECK_MS) this.missAt.delete(c);
    for (const [c, failed] of this.regularFailedAt) if (at - failed > 10 * REGULAR_RETRY_MS) this.regularFailedAt.delete(c);
    this.stats.ok++;
    this.stats.lastOkAt = now.toISOString();
    this.stats.lastError = null;
    if (pending.length && this.regularWaitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.regularWaitMs);
        void Promise.all(pending).then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * 그 날짜(지난 거래일)의 정규장 종가를 분봉에서. 받아 둔 값이 있으면 그대로, 받는 중이면 같이 기다린다.
   * 받지 못하면 null (던지지 않는다) — REGULAR_RETRY_MS 뒤에 다시 물을 수 있다
   */
  private regularClose(code: string, date: string): Promise<number | null> {
    const hit = this.regular.get(code);
    if (hit?.date === date) return Promise.resolve(hit.price);
    const key = `${code}:${date}`;
    const running = this.regularInflight.get(key);
    if (running) return running;
    if (this.now().getTime() - (this.regularFailedAt.get(code) ?? -Infinity) < REGULAR_RETRY_MS) return Promise.resolve(null);
    const p = this.slot(() => this.fetchRegularClose(code, date))
      .then((price): number | null => {
        if (price === null) throw new Error(`${code} ${date} 정규장 분봉 없음`);
        this.regular.set(code, { date, price });
        this.regularFailedAt.delete(code);
        this.stats.regularOk++;
        this.stats.regularLastError = null;
        return price;
      })
      .catch((e: unknown) => {
        this.regularFailedAt.set(code, this.now().getTime());
        this.stats.regularFailed++;
        this.stats.regularLastError = e instanceof Error ? e.message : String(e);
        return null;
      })
      .finally(() => this.regularInflight.delete(key));
    this.regularInflight.set(key, p);
    return p;
  }

  /** 분봉 요청을 동시에 REGULAR_CONCURRENCY 개까지만 (끝나면 기다리던 요청에 자리를 그대로 넘긴다) */
  private async slot<T>(run: () => Promise<T>): Promise<T> {
    if (this.regularActive >= REGULAR_CONCURRENCY) await new Promise<void>((r) => this.regularQueue.push(r));
    else this.regularActive++;
    try {
      return await run();
    } finally {
      const next = this.regularQueue.shift();
      if (next) next();
      else this.regularActive--;
    }
  }

  private async fetchRegularClose(code: string, date: string): Promise<number | null> {
    const h = krRegularHours(date);
    const ymd = date.replaceAll("-", "");
    // 정규장 시작 ~ 마감 조금 뒤까지 받아 마감 시각까지의 마지막 가격을 고른다 (끝을 넉넉히 — 마감 봉이 빠지지 않게)
    const url = `${MINUTE_URL}/${code}/minute?startDateTime=${ymd}${hhmm(h.open)}&endDateTime=${ymd}${hhmm(h.close + 5)}`;
    const res = await fetchWithTimeout(this.fetchFn, url, { headers: HEADERS }, TIMEOUT_MS);
    if (!res.ok) throw new Error(`분봉 HTTP ${res.status}`);
    return pickRegularClose(await res.json(), date, h.close);
  }
}
