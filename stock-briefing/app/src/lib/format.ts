import type { Currency, Market } from "@/api/types";

/**
 * 절댓값 표기(body)에 부호를 붙인다. 부호는 반올림한 뒤 보이는 값으로 정한다 — 0 으로 보이면(숫자가 모두 0) 부호 없이
 * ("-0원"·"+0원"·"-$0.00"·"-0.00%" 대신 "0원"·"$0.00"·"0.00%", BH-38)
 */
function withSign(n: number, body: string, sign: boolean | undefined): string {
  if (!/[1-9]/.test(body)) return body;
  if (sign && n > 0) return `+${body}`;
  return n < 0 ? `-${body}` : body;
}

export function formatWon(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return withSign(n, `${Math.round(Math.abs(n)).toLocaleString("ko-KR")}원`, opts.sign);
}

export function formatUsd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return withSign(n, `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, opts.sign);
}

/**
 * 금액을 표시 단위로 반올림한 값 (원은 정수, 달러는 센트). 금액의 부호·등락 색을 이 값으로 정하면 화면에 0 으로 보이는 금액을
 * 손실·이익 색으로 칠하지 않는다 (BH-38). 반올림해 0 이면 0 (-0 아님)
 */
export function shownAmount(n: number | null | undefined, currency: Currency | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const unit = currency === "USD" ? 100 : 1;
  return Math.sign(n) * (Math.round(Math.abs(n) * unit) / unit) || 0;
}

/** 통화에 맞춘 가격 표기. KRW 는 "201,000원", USD 는 "$340.22" */
export function formatPrice(n: number | null | undefined, currency: Currency | undefined, opts: { sign?: boolean } = {}): string {
  return currency === "USD" ? formatUsd(n, opts) : formatWon(n, opts);
}

const US_MARKETS: ReadonlySet<string> = new Set(["NASDAQ", "NYSE", "AMEX", "US"]);
export function isUsMarket(market: Market | string | null | undefined): boolean {
  return !!market && US_MARKETS.has(market);
}
export function currencyOfMarket(market: Market | string | null | undefined): Currency {
  return isUsMarket(market) ? "USD" : "KRW";
}
export const CURRENCY_LABEL: Record<Currency, string> = { KRW: "원화", USD: "달러" };

/**
 * 표시 통화 결정. showKrw 이고 환율이 있으면 달러 금액을 원화로 바꾼다.
 * 반환값의 currency 로 formatPrice 를 부르면 된다.
 */
export function toDisplay(n: number | null | undefined, currency: Currency | undefined, fxRate: number | null | undefined, showKrw: boolean): { value: number | null; currency: Currency } {
  const cur = currency ?? "KRW";
  if (n === null || n === undefined || !Number.isFinite(n)) return { value: null, currency: cur };
  if (cur === "USD" && showKrw && fxRate) return { value: n * fxRate, currency: "KRW" };
  return { value: n, currency: cur };
}

/** toDisplay + formatPrice 를 한 번에 */
export function formatMoney(n: number | null | undefined, currency: Currency | undefined, fxRate: number | null | undefined, showKrw: boolean, opts: { sign?: boolean } = {}): string {
  const d = toDisplay(n, currency, fxRate, showKrw);
  return formatPrice(d.value, d.currency, opts);
}

/** 정규장 밖 가격의 짧은 라벨: NXT 야간/프리마켓, 미국 애프터/프리마켓 */
export function afterMarketLabel(a: { venue: "NXT" | "US"; session: "PRE_MARKET" | "AFTER_MARKET" | "UNKNOWN"; status: "OPEN" | "CLOSE" }): string {
  const venue = a.venue === "NXT" ? "NXT" : "미국";
  const session = a.session === "PRE_MARKET" ? "프리마켓" : a.venue === "NXT" ? "야간" : "애프터마켓";
  return `${venue} ${session}${a.status === "OPEN" ? "(거래 중)" : ""}`;
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** 지수·환율 값: 1,000 이상은 콤마, 소수 둘째 자리 (홈 지수 띠와 잔고 위젯 지수 줄이 같은 표기를 쓴다) */
export function formatIndexValue(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPct(n: number | null | undefined, opts: { sign?: boolean } = { sign: true }): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  // 1,000% 넘는 급등(상장 첫날·동전주)도 읽기 쉽게 자리 구분
  const a = Math.abs(n);
  const s = `${a >= 1000 ? a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : a.toFixed(2)}%`;
  if (!opts.sign) return s;
  return withSign(n, s, true);
}

/** 큰 금액을 억/조 단위로 (시가총액, 매출 등). USD 는 B/M 단위 */
export function formatKrwCompact(n: number | null | undefined, currency: Currency = "KRW"): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  // 경계는 반올림한 값 기준 (999.96B 가 "1000.0B" 가 아니라 "1.00T" 로)
  if (currency === "USD") {
    if (abs >= 999.95e9) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
    if (abs >= 999.95e6) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 999.5e3) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e4) return `${sign}$${Math.round(abs / 1e3).toLocaleString("en-US")}K`;
    return withSign(n, `$${Math.round(abs).toLocaleString("en-US")}`, false);
  }
  if (abs >= 9_999.5e8) return `${sign}${(abs / 1e12).toFixed(abs >= 9.95e12 ? 0 : 1)}조원`;
  if (abs >= 9_999.5e4) return `${sign}${Math.round(abs / 1e8).toLocaleString("ko-KR")}억원`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString("ko-KR")}만원`;
  return withSign(n, `${Math.round(abs).toLocaleString("ko-KR")}원`, false);
}

export function formatVolume(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  if (n >= 9_999.5e4) return `${(n / 1e8).toFixed(1)}억`;
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만`;
  return n.toLocaleString("ko-KR");
}

/** ISO 또는 YYYY-MM-DD → "9월 22일 (월)" */
export function formatDateKo(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "-";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00+09:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short" }).format(d);
  if (!withTime) return date;
  const time = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${date} ${time}`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.round(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

export const SESSION_LABEL: Record<"morning" | "afternoon", string> = { morning: "오전", afternoon: "오후" };

/** 한국·미국 장이 열려 있을 만한 시간인지 (KST). 평일 08:00 ~ 다음날 07:00 이면 true (한국 08~20시, 미국 17시~익일 07시) */
export function isTradingHoursKst(d = new Date()): boolean {
  const kst = new Date(d.getTime() + 9 * 3_600_000);
  const day = kst.getUTCDay(); // 0 일 ~ 6 토
  const h = kst.getUTCHours();
  if (day === 0) return false; // 일요일
  if (day === 6) return h < 7; // 토요일 새벽 = 미국 금요일 장
  if (day === 1) return h >= 8; // 월요일 08시부터
  return h >= 8 || h < 7;
}

/** 호가 표기 (단위 없이): KRW "196,000", USD "44.52". 목록·시세표용 */
export function formatQuote(n: number | null | undefined, currency: Currency | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  if (currency === "USD") return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Math.round(n).toLocaleString("ko-KR");
}

/** 전일 대비 화살표 표기: "▲2,500" / "▼0.30" / "0" */
export function formatArrow(n: number | null | undefined, currency: Currency | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const body = formatQuote(Math.abs(n), currency);
  // 반올림해 0 으로 보이면 화살표 없이 (BH-38)
  if (!/[1-9]/.test(body)) return "0";
  return `${n > 0 ? "▲" : "▼"}${body}`;
}

/** showKrw 를 반영한 호가 표기 */
export function formatQuoteDisplay(n: number | null | undefined, currency: Currency | undefined, fxRate: number | null | undefined, showKrw: boolean): string {
  const d = toDisplay(n, currency, fxRate, showKrw);
  return formatQuote(d.value, d.currency);
}

export function formatArrowDisplay(n: number | null | undefined, currency: Currency | undefined, fxRate: number | null | undefined, showKrw: boolean): string {
  const d = toDisplay(n, currency, fxRate, showKrw);
  return formatArrow(d.value, d.currency);
}
