import type { Market } from "@/api/types";
import { estimateTextWidth } from "@/lib/chartLayout";
import { font, fontCap, space } from "@/tokens";

/**
 * 토스에서 열기 (3-48, 기능 플래그 tossOpen — 사용자 결정 A 2026-09-28): 종목 상세에서 토스증권 공개 종목 페이지를 연다.
 * 주문은 사용자가 토스 앱·웹에서 직접 한다 — 이 앱은 주문 API·로그인이 필요한 API 를 부르지 않고, 공개 주소를 열기만 한다.
 *
 * 공개 주소 (조사 2026-09-28, 로그인 없이 직접 열어 봄): https://www.tossinvest.com/stocks/{종목}
 *  - 토스 웹의 주소 자리는 '티커·종목코드·상품 코드'를 모두 받아 토스가 스스로 푼다 (없는 코드는 '지원하지 않는 주식' 창 — 다른 종목으로 가지 않는다)
 *  - 한국: 접두사 없는 6자리 코드. 토스가 주식·ETF 는 A, ETN 은 Q 를 붙인다 → 'A' 를 직접 붙이면 ETN(예: 530134)이 없는 종목 창이 된다.
 *    종목 목록으로는 ETF 와 ETN 을 가를 수 없어(group_code 둘 다 EF) 접두사를 붙이지 않는다. 서버가 쓰는 상품 코드(A…)도 같은 까닭으로 쓰지 않는다
 *  - 미국: 토스 상품 코드(US…·NAS…·NYS…·AMX…)가 있으면 그것, 없으면 티커 (점 표기 BRK.B 까지 토스가 푼다)
 *  - 주소를 확실히 만들 수 없으면 null → 버튼 없음: 지수·환율 코드, 시장 모름, 시장과 코드 모양이 안 맞음, 야후식 하이픈 티커(BRK-B — 토스는 모름, 바꿔 추측하지 않는다)
 * 알려진 한계: 휴대폰 브라우저로 이 주소를 열면 토스는 'PC로 접속해주세요' 안내를 보여 줄 수 있고, 토스 앱은 https 링크를 가져가지 않는다(App Links 없음).
 * 폰에서 한 번 눌러 확인할 것 — 안 맞으면 서버 플래그로 끈다 (OTA 필요 없음)
 */

export const TOSS_STOCK_BASE = "https://www.tossinvest.com/stocks/";

/** 버튼 글 · 화면 읽기 이름 · 못 열었을 때 안내 (매수·매도 권유로 읽히는 말은 쓰지 않는다) */
export const TOSS_OPEN = {
  label: "토스에서 열기",
  a11y: "토스증권에서 이 종목 열기",
  failTitle: "토스증권을 열지 못했습니다",
  failBody: "브라우저나 토스 앱으로 링크를 열지 못했습니다. 잠시 뒤 다시 눌러 주세요.",
} as const;

const KR_MARKETS: ReadonlySet<string> = new Set(["KOSPI", "KOSDAQ"]);
const US_MARKETS: ReadonlySet<string> = new Set(["NASDAQ", "NYSE", "AMEX", "US"]);
/** 한국 종목 코드: 숫자로 시작하는 6자리 (서버 lib/codes 의 KR_CODE_RE 와 같다) */
const KR_CODE_RE = /^\d[0-9A-Z]{5}$/;
/** 미국 티커: 대문자로 시작, 점 뒤 한 글자까지 (하이픈은 받지 않는다 — 토스는 BRK.B 모양만 푼다) */
const US_TICKER_RE = /^[A-Z][A-Z0-9]{0,9}(?:\.[A-Z])?$/;
/** 토스 미국 상품 코드 (US20100629001 · NAS0230822008 …): 13자 */
const US_PRODUCT_RE = /^(?:US\d{11}|(?:NAS|NYS|AMX)\d{10})$/;
/** 지수·환율 화면 코드 — 시장 값이 무엇이든 종목 주소를 만들지 않는다 */
const MARKET_CODES: ReadonlySet<string> = new Set(["KOSPI", "KOSDAQ", "KOSPI200", "NASDAQ", "NDX", "SPX", "DJI", "SOX", "VIX", "USDKRW", "JPYKRW", "CNYKRW", "EURKRW"]);

/**
 * 종목의 토스증권 공개 페이지 주소. 확실히 만들 수 없으면 null (버튼을 숨긴다).
 * productCode: 토스 상품 코드를 알면 (지금 앱은 받지 않는다 — 서버 상세 응답에 없음. 미국만 쓴다)
 */
export function tossStockUrl({ code, market, productCode }: { code: string; market: Market | string | null | undefined; productCode?: string | null }): string | null {
  if (!code || !market || MARKET_CODES.has(code)) return null;
  if (KR_MARKETS.has(market)) return KR_CODE_RE.test(code) ? TOSS_STOCK_BASE + code : null;
  if (!US_MARKETS.has(market) || KR_CODE_RE.test(code)) return null;
  if (productCode && US_PRODUCT_RE.test(productCode)) return TOSS_STOCK_BASE + productCode;
  return US_TICKER_RE.test(code) ? TOSS_STOCK_BASE + code : null;
}

/**
 * 주소를 연다 (안드로이드: 그 주소를 가져가는 앱이 있으면 그 앱, 없으면 브라우저).
 * 못 열면(받을 앱 없음 등) 앱을 끄지 않고 안내 창 하나 — canOpenURL 은 쓰지 않는다 (안드로이드 11+ 는 manifest <queries> 없이는 늘 false, 넣으려면 새 APK)
 */
export async function openTossPage(url: string, deps: { open: (url: string) => unknown; fail: (title: string, body: string) => void }): Promise<boolean> {
  try {
    await deps.open(url);
    return true;
  } catch {
    deps.fail(TOSS_OPEN.failTitle, TOSS_OPEN.failBody);
    return false;
  }
}

/** 버튼 아이콘 크기 · 아이콘과 글 사이 */
export const TOSS_ICON = font.small + space.xxs;
const ICON_GAP = space.xs;

/** 버튼 폭 어림 (아이콘 + 간격 + 글). 버튼 글·아이콘은 fontCap.chrome(150%) 까지만 커진다 */
export function tossButtonWidth(fontScale: number): number {
  const s = Math.min(Math.max(fontScale || 1, 1), fontCap.chrome);
  return TOSS_ICON * s + ICON_GAP + estimateTextWidth(TOSS_OPEN.label, font.small * s);
}
