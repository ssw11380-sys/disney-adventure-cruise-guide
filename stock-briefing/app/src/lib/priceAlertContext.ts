import React from "react";
import type { PriceAlertRule, Quote } from "@/api/types";

/**
 * 가격 알림 (3-29, 기능 플래그 priceAlerts) 문맥 — lib/uxFlags 의 UxFlagsContext·useUx 와 같은 모양.
 * 루트의 PriceAlertProvider(components)가 플래그·조건 목록·시트 열기를 한 번 정해 내려 준다 →
 * 종목 상세·설정 화면은 서버 조회 훅(@/api/hooks)을 새로 부르지 않고 이 문맥만 읽는다 (기존 화면 테스트의 가짜 훅 목록을 건드리지 않게).
 * 제공자가 없으면(화면 테스트 기본·예전 화면) 꺼짐 = 지금 화면 그대로
 */
export interface PriceAlertState {
  /** 플래그 priceAlerts (앱 fallback false) — 화면은 이 값 하나로 정한다 */
  on: boolean;
  rules: PriceAlertRule[];
  /** 시트 열기 — 종목 상세가 이름과 지금 시세를 넘긴다 */
  openSheet: (s: { code: string; name: string; quote: Quote | null }) => void;
  /** 지우기 — 확인 창은 부르는 부품이 confirmRemoveAlert 로 먼저 띄운다. 서버에서 지우고 조건 목록을 다시 받는다 */
  remove: (rule: PriceAlertRule) => Promise<void>;
  /** 종목 이름 (잔고 목록 캐시, 없으면 코드) — 설정 칸이 쓴다 (설정 화면이 쿼리 클라이언트를 직접 읽지 않게) */
  nameOf: (code: string) => string;
  /** 조건 목록을 아직 한 번도 받지 못했고 마지막 요청이 실패함(404 아님) — rules 가 빈 것은 '없음'이 아니라 '모름'. 없으면 거짓 */
  rulesFailed?: boolean;
}

export const PRICE_ALERTS_OFF: PriceAlertState = Object.freeze({
  on: false,
  rules: [],
  openSheet: () => {},
  remove: () => Promise.resolve(),
  nameOf: (code: string) => code,
  rulesFailed: false,
});

export const PriceAlertContext = React.createContext<PriceAlertState>(PRICE_ALERTS_OFF);

export function usePriceAlerts(): PriceAlertState {
  return React.useContext(PriceAlertContext);
}
