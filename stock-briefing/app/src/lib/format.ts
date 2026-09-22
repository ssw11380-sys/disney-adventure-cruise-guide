import type { Currency, Market } from "@/api/types";

export function formatWon(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const body = `${Math.round(abs).toLocaleString("ko-KR")}원`;
  if (opts.sign) return n > 0 ? `+${body}` : n < 0 ? `-${body}` : body;
  return n < 0 ? `-${body}` : body;
}

export function formatUsd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const body = `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (opts.sign) return n > 0 ? `+${body}` : n < 0 ? `-${body}` : body;
  return n < 0 ? `-${body}` : body;
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

export function formatPct(n: number | null | undefined, opts: { sign?: boolean } = { sign: true }): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const s = `${Math.abs(n).toFixed(2)}%`;
  if (!opts.sign) return s;
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

/** 큰 금액을 억/조 단위로 (시가총액, 매출 등). USD 는 B/M 단위 */
export function formatKrwCompact(n: number | null | undefined, currency: Currency = "KRW"): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (currency === "USD") {
    if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  }
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(abs >= 1e13 ? 0 : 1)}조원`;
  if (abs >= 1e8) return `${sign}${Math.round(abs / 1e8).toLocaleString("ko-KR")}억원`;
  return `${sign}${Math.round(abs).toLocaleString("ko-KR")}원`;
}

export function formatVolume(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
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
