import type { AccountExposure, AccountExposureItem } from "@/api/types";
import { sentence, speakClock } from "@/lib/a11y";

/**
 * 브리핑 3차 4 — 비중 한 줄 (플래그 accountExposure) 화면용 순수 함수 (React Native 를 불러오지 않음 → 테스트).
 * 숫자는 서버가 계좌 브리핑을 만들 때 계산해 저장한 값 그대로 쓴다 (services/accountNumbers.exposureOf).
 * 사실만: 비중과 기준 시각. 높다·쏠림·위험·주의 같은 판단하는 말·등락 색 없음
 */

export const EXPOSURE_HEAD = "비중";
/** 둘째 줄의 계산 기준 (짧게 — 첫 화면을 늘리지 않게. 자세한 기준은 화면 아래 EXPOSURE_ABOUT). 현금·예수금은 토스 보유 조회에 없어 분모에 없음 */
export const EXPOSURE_BASIS = "현금 제외";
/**
 * 계좌 상세 맨 아래 '기준' 줄 아래 설명 (첫 화면 밖). '미국 상장'을 달러 자산 전체로 읽지 않게 — 국내에 상장된 해외 ETF 는 원화 종목이라 들지 않는다 (설계 '브리핑 3차 4')
 */
export const EXPOSURE_ABOUT =
  "비중은 종목 평가금액을 보유 종목 합계로 나눈 값입니다(현금 제외, 앱 잔고와 같은 기준). 미국 상장은 미국 거래소에서 달러로 거래하는 종목만 셉니다. 국내에 상장된 해외 ETF는 원화 종목이라 들지 않습니다.";
/** 둘째 줄에 이름을 보이는 레버리지·인버스 종목 수 (넘으면 '외 N종목' — 긴 이름이 많아도 총 평가 카드가 길어지지 않게) */
export const LEV_NAMES_MAX = 3;
/** 합계에서 뺀(비중을 모르는) 레버리지·인버스 종목 이름표 뒤에 붙이는 말 */
const UNCOUNTED_NOTE = "계산에서 뺌";

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

/** 이름표에 쓰는 칸 (합계에서 뺀 종목은 weight 가 없다) */
type LevLabelInput = Pick<AccountExposureItem, "name" | "kind" | "L"> & Partial<Pick<AccountExposureItem, "code" | "weight">>;

/**
 * 레버리지·인버스 종목 이름표: 'SOXL(3배)' · 'KODEX 인버스(-1배)' · 배수를 모르면 'X(레버리지)' · 'Y(인버스)'.
 * 합계에서 뺀 종목(uncounted)은 'SOXL(3배, 계산에서 뺌)'
 */
export function levInvLabel(x: LevLabelInput, uncounted = false): string {
  const what = x.L === null ? (x.kind === "inverse" ? "인버스" : "레버리지") : `${x.kind === "inverse" ? "-" : ""}${mult(x.L)}배`;
  return `${x.name}(${what}${uncounted ? `, ${UNCOUNTED_NOTE}` : ""})`;
}

/** 읽는 말: 'SOXL 3배' · 'KODEX 인버스 마이너스 1배' · 'X 레버리지' · 'Y 인버스' (합계에서 뺀 종목은 뒤에 '계산에서 뺌') */
function speakLevInv(x: LevLabelInput, uncounted = false): string {
  const what = x.L === null ? (x.kind === "inverse" ? "인버스" : "레버리지") : `${x.kind === "inverse" ? "마이너스 " : ""}${mult(x.L)}배`;
  return `${x.name} ${what}${uncounted ? ` ${UNCOUNTED_NOTE}` : ""}`;
}

/** 합계에서 뺀 종목 안내 — 이유는 시세(값·평가 없음)이거나 환율(미국 종목)이라 둘 다 적는다. 기호가 없어 화면 읽기에도 그대로 */
const excludedText = (n: number) => `시세나 환율을 받지 못한 ${n}종목은 빼고 계산`;
const guessedText = (n: number) => `상품 정보를 받지 못한 ${n}종목은 이름으로 구분했습니다`;

export interface ExposureView {
  /** 첫 줄 묶음: ['비중', '가장 큰 종목 엔비디아 21.3%', '상위 3종목 48.2%', '레버리지·인버스 9.1%', '미국 상장 62.4%'] — 화면은 ' · ' 로 잇고 좁으면 묶음째 줄바꿈 */
  line1: string[];
  /** 둘째 줄 묶음: ['레버리지·인버스: SOXL(3배)', 'RGTX(2배)', '현금 제외', '08:38 기준'] (+ '외 N종목'·합계에서 뺀 종목·이름으로 구분한 종목 안내) */
  line2: string[];
  /** 화면 읽기 한 문장 (기호 없이) */
  speech: string;
}

/**
 * 계좌 상세 총 평가 카드의 비중 두 줄과 읽는 말 (설계 '브리핑 3차 4'):
 *  - 1종목(합계에서 뺀 종목도 없음)이면 '가장 큰 종목 삼성전자 100%' 대신 '보유 1종목', 3종목 이하면 '상위 3종목' 조각을 뺌
 *  - 레버리지·인버스가 없으면 '레버리지·인버스 없음', 미국 종목이 없으면 '미국 상장 없음' (있는데 0.0 으로 반올림되면 '0.0%').
 *    합계에서 뺀 종목에만 있으면(환율·시세를 받지 못한 날) '없음'이 아니라 '비중 알 수 없음' — 뺀 레버리지·인버스는 둘째 줄에 '(…, 계산에서 뺌)'
 *  - 레버리지·인버스 이름은 앞 LEV_NAMES_MAX 개(합계에 넣은 것 값 큰 순 → 뺀 것)만, 넘으면 '외 N종목'
 *  - 둘째 줄 끝에 상품 정보를 받지 못해 이름으로 구분한 종목 수
 */
export function exposureView(e: AccountExposure): ExposureView {
  const clock = kstClock(e.asOf);
  const one = e.count === 1 && e.excluded === 0;
  const items = e.levInv.items;
  const uncounted = e.levInv.uncounted ?? [];
  const usUncounted = e.us.uncounted ?? 0;
  const lev = [...items.map((x) => ({ x, out: false })), ...uncounted.map((x) => ({ x, out: true }))];
  const shown = lev.slice(0, LEV_NAMES_MAX);
  const more = lev.length - shown.length;
  const levChunk = items.length ? `레버리지·인버스 ${pct(e.levInv.weight)}` : uncounted.length ? "레버리지·인버스 비중 알 수 없음" : "레버리지·인버스 없음";
  const usChunk = e.us.count > 0 ? `미국 상장 ${pct(e.us.weight)}` : usUncounted > 0 ? "미국 상장 비중 알 수 없음" : "미국 상장 없음";
  const line1 = [
    EXPOSURE_HEAD,
    one ? "보유 1종목" : `가장 큰 종목 ${e.top1.name} ${pct(e.top1.weight)}`,
    e.top3 ? `상위 3종목 ${pct(e.top3.weight)}` : null,
    levChunk,
    usChunk,
  ].filter((x): x is string => x !== null);
  const labels = shown.map((s) => levInvLabel(s.x, s.out));
  const line2 = [
    ...(labels.length ? [`레버리지·인버스: ${labels[0]}`, ...labels.slice(1)] : []),
    more > 0 ? `외 ${more}종목` : null,
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
    items.length ? `레버리지 인버스 상품 ${speakPct(e.levInv.weight)}` : uncounted.length ? "레버리지 인버스 상품 비중 알 수 없음" : "레버리지 인버스 상품 없음",
    ...shown.map((s) => speakLevInv(s.x, s.out)),
    more > 0 ? `외 ${more}종목` : null,
    e.us.count > 0 ? `미국 상장 종목 ${speakPct(e.us.weight)}` : usUncounted > 0 ? "미국 상장 종목 비중 알 수 없음" : "미국 상장 종목 없음",
    "현금 제외",
    e.excluded > 0 ? excludedText(e.excluded) : null,
    e.guessedByName > 0 ? guessedText(e.guessedByName) : null,
  ]);
  return { line1, line2, speech };
}
