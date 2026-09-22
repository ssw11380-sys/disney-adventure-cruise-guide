export function formatWon(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const body = `${Math.round(abs).toLocaleString("ko-KR")}원`;
  if (opts.sign) return n > 0 ? `+${body}` : n < 0 ? `-${body}` : body;
  return n < 0 ? `-${body}` : body;
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

/** 큰 금액을 억/조 단위로 (시가총액, 매출 등) */
export function formatKrwCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
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
