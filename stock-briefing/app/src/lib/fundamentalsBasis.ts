import type { Quote } from "@/api/types";
import { formatDateKo } from "./format";

const LABELS: Record<string, string> = { per: "PER", pbr: "PBR", eps: "EPS", bps: "BPS", high52w: "52주 최고", low52w: "52주 최저", marketCap: "시가총액", dividendPerShare: "주당배당", dividendYieldPct: "배당수익률" };

/** 빈 시각을 현재 시각으로 바꾸지 않는다. 수신 시각은 공시·결산 기준일이 아니다. */
export function fundamentalsBasisText(basis: Quote["fundamentalsBasis"]): { title: string; detail: string; warning: boolean } | null {
  if (!basis) return null;
  const fields = basis.fields.map(field => LABELS[field]).filter(Boolean);
  const received = typeof basis.receivedAt === "string" && basis.receivedAt.trim() && Number.isFinite(Date.parse(basis.receivedAt))
    ? `${new Date(Date.parse(basis.receivedAt) + 9 * 3_600_000).getUTCFullYear()}년 ${formatDateKo(basis.receivedAt, true)} 수신` : "수신 시각 미확인";
  if (!fields.length) return basis.refreshFailed
    ? { title: "재무 보강 갱신 실패", detail: "추가 재무 자료를 확인하지 못했습니다. 시세 제공 자료는 그대로 표시합니다.", warning: true }
    : null;
  const source = basis.source?.startsWith("naver") ? "네이버" : basis.source || "출처 미확인";
  return {
    title: basis.refreshFailed ? "재무 갱신 실패 · 이전 자료" : "재무 자료 기준",
    detail: `${fields.join("·")} · ${source} · ${received}. 공시·결산 기준일과는 다릅니다.`,
    warning: basis.refreshFailed,
  };
}
