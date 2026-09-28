import type { AccountExposure, AccountExposureItem } from "@/api/types";
import { sentence, speakClock } from "@/lib/a11y";

/**
 * 브리핑 3차 4 — 비중 한 줄 (플래그 accountExposure) 화면용 순수 함수 (React Native 를 불러오지 않음 → 테스트).
 * 숫자는 서버가 계좌 브리핑을 만들 때 계산해 저장한 값 그대로 쓴다 (services/accountNumbers.exposureOf).
 * 사실만: 비중과 기준 시각. 높다·쏠림·위험·주의 같은 판단하는 말·등락 색 없음
 */

export const EXPOSURE_HEAD = "비중";
/** 둘째 줄의 계산 기준 (현금·예수금은 토스 보유 조회에 없어 분모에 없음) */
export const EXPOSURE_BASIS = "보유 종목 평가금액 기준, 현금 제외";

/** 비중 "21.3%" (늘 소수 한 자리 — 지난 브리핑과 비교 카드의 비중과 같은 모양) */
const pct = (w: number) => `${w.toFixed(1)}%`;
/** 읽는 말 "21.3퍼센트" */
const speakPct = (w: number) => `${w.toFixed(1)}퍼센트`;
/** 배수 "3" · "1.5" */
const mult = (L: number) => (Number.isInteger(L) ? String(L) : String(Number(L.toFixed(2))));

/** 순간(ISO) → 서울 시각 "08:38". 읽지 못하면 null (틀린 시각을 보이지 않게 조각을 뺀다) */
function kstClock(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + 9 * 3_600_000).toISOString().slice(11, 16);
}

/** 레버리지·인버스 종목 이름표: 'SOXL(3배)' · 'KODEX 인버스(-1배)' · 배수를 모르면 'X(레버리지)' · 'Y(인버스)' */
export function levInvLabel(x: AccountExposureItem): string {
  if (x.L === null) return `${x.name}(${x.kind === "inverse" ? "인버스" : "레버리지"})`;
  return `${x.name}(${x.kind === "inverse" ? "-" : ""}${mult(x.L)}배)`;
}

/** 읽는 말: 'SOXL 3배' · 'KODEX 인버스 마이너스 1배' · 'X 레버리지' · 'Y 인버스' */
function speakLevInv(x: AccountExposureItem): string {
  if (x.L === null) return `${x.name} ${x.kind === "inverse" ? "인버스" : "레버리지"}`;
  return `${x.name} ${x.kind === "inverse" ? "마이너스 " : ""}${mult(x.L)}배`;
}

const excludedText = (n: number) => `시세가 없는 ${n}종목은 빼고 계산`;
const guessedText = (n: number) => `상품 정보를 받지 못한 ${n}종목은 이름으로 구분했습니다`;

export interface ExposureView {
  /** 첫 줄 묶음: ['비중', '가장 큰 종목 엔비디아 21.3%', '상위 3종목 48.2%', '레버리지·인버스 9.1%', '미국 상장 62.4%'] — 화면은 ' · ' 로 잇고 좁으면 묶음째 줄바꿈 */
  line1: string[];
  /** 둘째 줄 묶음: ['레버리지·인버스: SOXL(3배)', 'RGTX(2배)', '보유 종목 평가금액 기준, 현금 제외', '08:38 기준'] (+ 시세 없는 종목·이름으로 구분한 종목 안내) */
  line2: string[];
  /** 화면 읽기 한 문장 (기호 없이) */
  speech: string;
}

/**
 * 계좌 상세 총 평가 카드의 비중 두 줄과 읽는 말 (설계 '브리핑 3차 4'):
 *  - 1종목이면 '가장 큰 종목 삼성전자 100%' 대신 '보유 1종목', 3종목 이하면 '상위 3종목' 조각을 뺌
 *  - 레버리지·인버스가 없으면 '레버리지·인버스 없음', 미국 종목이 없으면 '미국 상장 없음' (있는데 0.0 으로 반올림되면 '0.0%')
 *  - 둘째 줄 끝에 상품 정보를 받지 못해 이름으로 구분한 종목 수
 */
export function exposureView(e: AccountExposure): ExposureView {
  const clock = kstClock(e.asOf);
  const one = e.count === 1;
  const items = e.levInv.items;
  const line1 = [
    EXPOSURE_HEAD,
    one ? "보유 1종목" : `가장 큰 종목 ${e.top1.name} ${pct(e.top1.weight)}`,
    e.top3 ? `상위 3종목 ${pct(e.top3.weight)}` : null,
    items.length ? `레버리지·인버스 ${pct(e.levInv.weight)}` : "레버리지·인버스 없음",
    e.us.count > 0 ? `미국 상장 ${pct(e.us.weight)}` : "미국 상장 없음",
  ].filter((x): x is string => x !== null);
  const labels = items.map(levInvLabel);
  const line2 = [
    ...(labels.length ? [`레버리지·인버스: ${labels[0]}`, ...labels.slice(1)] : []),
    EXPOSURE_BASIS,
    e.excluded > 0 ? excludedText(e.excluded) : null,
    clock ? `${clock} 기준` : null,
    e.guessedByName > 0 ? guessedText(e.guessedByName) : null,
  ].filter((x): x is string => x !== null);
  const speech = sentence([
    EXPOSURE_HEAD,
    clock ? `${speakClock(clock)} 기준` : null,
    one ? "보유 1종목" : `가장 큰 종목 ${e.top1.name} ${speakPct(e.top1.weight)}`,
    e.top3 ? `상위 3종목 합 ${speakPct(e.top3.weight)}` : null,
    items.length ? `레버리지 인버스 상품 ${speakPct(e.levInv.weight)}` : "레버리지 인버스 상품 없음",
    ...items.map(speakLevInv),
    e.us.count > 0 ? `미국 상장 종목 ${speakPct(e.us.weight)}` : "미국 상장 종목 없음",
    "현금 제외",
    e.excluded > 0 ? excludedText(e.excluded) : null,
    e.guessedByName > 0 ? guessedText(e.guessedByName) : null,
  ]);
  return { line1, line2, speech };
}
