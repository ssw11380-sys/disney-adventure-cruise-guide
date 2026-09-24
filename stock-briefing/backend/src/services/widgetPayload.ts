import type { MarketStatus } from "../providers/market/calendar.js";
import type { Briefing } from "./briefingService.js";
import type { RegisteredWithQuote } from "./stockService.js";

/**
 * 홈 화면 위젯 한 번에 필요한 것만 (3-16). 위젯 3종이 이 응답 하나를 같이 쓴다.
 *  - 시세는 위젯이 쓰는 칸만(가격·등락·통화·시각·환율·지연 표시), 평가는 그대로
 *  - 장 상태 칩: 앱 잔고 탭 띠와 같은 규칙(/api/market/status 기준)
 *  - 브리핑: 보유 비중(원화 환산 평가금) 상위 3종목의 최신 요약
 */

export interface WidgetMarket {
  /** 칩 문구: 실시간 / 한국 장중 / 미국 장중 / 휴장 / 한국 휴장 / 장 마감 */
  label: string;
  open: boolean;
  /** 다음에 장 상태가 바뀌는 시각 (위젯 백그라운드 갱신이 휴장 중 호출을 건너뛸 때 이때까지만) */
  nextChangeAt: string | null;
}

/**
 * 짧은 키 (응답을 gzip 2KB 안으로). 앱 widgets/payload.ts 가 RegisteredWithQuote 모양으로 되돌린다.
 *  - 손익·수익률은 보내지 않고 앱에서 평가금 − 매입금으로 계산 (서버 evaluate 와 같은 식)
 */
export interface WidgetStock {
  c: string; // 코드
  n: string; // 이름
  qty: number | null;
  avg: number | null;
  /** 시세: [가격, 전일 대비, 등락률 %, 통화, 시세 시각 ISO, 환율|null, 지연 1|0] */
  q: [number, number, number, "KRW" | "USD", string, number | null, 0 | 1] | null;
  /** 평가: [평가금, 매입금, 비용 차감 평가금|null, 원화 매입금|null, 원화 매입금 출처|null] */
  e: [number, number, number | null, number | null, "exact" | "estimated" | null] | null;
}

export interface WidgetPayload {
  v: 1;
  market: WidgetMarket | null;
  stocks: WidgetStock[];
  briefings: Array<{ id: number; code: string; name: string; session: string; date: string; summary: string; createdAt: string }>;
  /** 모든 종목의 최신 브리핑 id (앱 백그라운드 알림이 새 브리핑이 있을 때만 전체 목록을 받게) */
  latestIds: number[];
}

/** 앱 useAnyMarketOpen 과 같은 규칙 */
export function marketChip(s: MarketStatus): WidgetMarket {
  const kr = s.KR, us = s.US;
  const bounds = [kr, us].map((m) => (m.isOpen ? m.closesAt : m.opensAt)).filter((x): x is string => !!x).sort();
  const nextChangeAt = bounds[0] ?? null;
  if (kr.isOpen || us.isOpen) return { label: kr.isOpen && us.isOpen ? "실시간" : kr.isOpen ? "한국 장중" : "미국 장중", open: true, nextChangeAt };
  if (!kr.isTradingDay && !us.isTradingDay) return { label: "휴장", open: false, nextChangeAt };
  if (!kr.isTradingDay) return { label: "한국 휴장", open: false, nextChangeAt };
  return { label: "장 마감", open: false, nextChangeAt };
}

/** 위젯 표시에 필요한 자릿수만 (등락률 소수 2자리, 금액·가격·환율 4자리) */
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** "2026-09-24T12:03:51.000+09:00" → "2026-09-24T12:03:51+09:00" */
const shortIso = (iso: string) => iso.replace(/\.000(?=[Z+-])/, "");

function slim(s: RegisteredWithQuote): WidgetStock {
  const q = s.quote;
  const e = s.evaluation;
  return {
    c: s.code,
    n: s.name,
    qty: s.quantity,
    avg: s.avgPrice,
    q: q ? [r4(q.price), r4(q.change), r2(q.changeRate), q.currency, shortIso(q.asOf), q.fxRate == null ? null : r4(q.fxRate), q.stale ? 1 : 0] : null,
    // 금액은 소수 4자리까지 (달러 금액을 원화로 바꿔도 1원 미만 차이 — 앱 잔고와 같은 숫자가 되게)
    e: e ? [r4(e.marketValue), r4(e.costBasis), e.afterCost ? r4(e.afterCost.marketValue) : null, e.costBasisKrw === null ? null : Math.round(e.costBasisKrw), e.krwCostSource] : null,
  };
}

const krwValue = (s: RegisteredWithQuote) => {
  const v = s.evaluation?.marketValue ?? 0;
  return s.quote?.currency === "USD" ? v * (s.quote.fxRate ?? 1400) : v;
};

export function buildWidgetPayload(stocks: RegisteredWithQuote[], latest: Array<{ code: string; name: string; latest: Briefing | null }>, status: MarketStatus | null): WidgetPayload {
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const ok = latest.filter((b) => b.latest?.status === "ok");
  // 보유 비중 큰 순 → 비중이 같으면(관심 종목) 최신 순
  ok.sort((a, b) => {
    const d = krwValue(byCode.get(b.code)!) - krwValue(byCode.get(a.code)!);
    if (Number.isFinite(d) && d !== 0) return d;
    return a.latest!.createdAt < b.latest!.createdAt ? 1 : -1;
  });
  return {
    v: 1,
    market: status ? marketChip(status) : null,
    stocks: stocks.map(slim),
    latestIds: ok.map((b) => b.latest!.id).sort((a, b) => a - b),
    briefings: ok.slice(0, 3).map((b) => ({ id: b.latest!.id, code: b.code, name: b.name, session: b.latest!.session, date: b.latest!.date, summary: b.latest!.summary, createdAt: b.latest!.createdAt })),
  };
}
