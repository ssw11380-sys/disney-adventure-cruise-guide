import { estimateTextWidth } from "@/lib/chartLayout";
import { realText } from "@/lib/detailText";
import { font, fontCap, space } from "@/tokens";

/**
 * 토스 앱 열기 (3-48, 기능 플래그 tossOpen — 사용자 결정 2026-09-28 '토스 앱만 열기').
 * 종목 상세 '시세' 칸 제목 줄의 [토스 앱 열기] → 작은 안내 시트('토스 앱 → 증권 → 검색에서 "삼성전자"(005930)을 찾아 주세요')
 * → [토스 앱 열기] 가 토스 앱 자체를 연다. 종목은 사용자가 토스 앱에서 직접 찾고, 주문도 토스 앱에서 직접 한다.
 *  - 이 앱은 주문 API·로그인이 필요한 API 를 부르지 않고, 서버 호출도 없다
 *  - 여는 주소는 토스 앱의 공개 스킴 supertoss:// 하나 (토스페이먼츠 문서의 앱 연동 값, 패키지 viva.republica.toss).
 *    종목 화면으로 바로 가는 공개 딥링크는 없어 경로를 추측해 만들지 않는다
 *  - 웹 주소(tossinvest.com/stocks/…)는 쓰지 않는다: 휴대폰 브라우저에는 'PC로 접속해주세요'만 보이고 토스 앱은 https 링크를 가져가지 않는다 (조사 2026-09-28)
 *  - 못 열면(토스 앱 없음) 시트 안에 안내 + [Play 스토어에서 보기] (market:// → 안 되면 https Play 주소)
 *  - canOpenURL 은 쓰지 않는다 (안드로이드 11+ 는 manifest <queries> 없이는 늘 false — 넣으려면 새 APK)
 */

/** 토스 앱 공개 스킴 (앱 자체만 연다 — 종목 경로 없음) */
export const TOSS_APP_URL = "supertoss://";
/** 토스 앱 패키지 (Play 스토어 주소용) */
export const TOSS_PACKAGE = "viva.republica.toss";
/** Play 스토어: 스토어 앱 먼저, 안 되면 웹 주소 (브라우저·스토어 앱이 받음) */
export const PLAY_STORE_URLS = [`market://details?id=${TOSS_PACKAGE}`, `https://play.google.com/store/apps/details?id=${TOSS_PACKAGE}`] as const;

/** 버튼·시트 글 (매수·매도 권유로 읽히는 말은 쓰지 않는다 — 주문은 '토스 앱에서 직접' 이라는 사실만) */
export const TOSS_APP = {
  label: "토스 앱 열기",
  a11y: "토스 앱 열기, 토스에서 이 종목을 직접 찾아야 합니다",
  sheetTitle: "토스 앱에서 찾기",
  open: "토스 앱 열기",
  close: "닫기",
  scrim: "토스 앱 안내 닫기",
  note: "주문은 토스 앱에서 직접 합니다.",
  fail: "토스 앱을 열지 못했습니다. 토스 앱이 설치되어 있는지 확인해 주세요.",
  /** 화면에는 두 문장을 두 줄로 (좁은 폰에서 '확인해'가 두 줄로 갈라지지 않게). 화면 읽기는 fail 한 줄 */
  failLines: ["토스 앱을 열지 못했습니다.", "토스 앱이 설치되어 있는지 확인해 주세요."],
  store: "Play 스토어에서 보기",
  storeFail: "Play 스토어를 열지 못했습니다. 잠시 뒤 다시 눌러 주세요.",
} as const;

/** 지수·환율 화면 코드 — 종목이 아니므로 버튼을 두지 않는다 (지수 화면은 /market 이지만 코드로도 한 번 더 막는다) */
const MARKET_CODES: ReadonlySet<string> = new Set(["KOSPI", "KOSDAQ", "KOSPI200", "NASDAQ", "NDX", "SPX", "DJI", "SOX", "VIX", "USDKRW", "JPYKRW", "CNYKRW", "EURKRW"]);

/** 티커 비교용: 대문자 + 공백·점·하이픈 빼기 (lib/detailText 와 같은 규칙) */
const tickerKey = (s: string) => s.replace(/[\s.-]/g, "").toUpperCase();

export interface TossAppTarget {
  /** 토스 앱에서 찾을 이름 (등록 이름. 이름이 티커뿐이면 시세가 준 사람이 읽는 이름) */
  name: string;
  /** 한국 6자리 코드 · 미국 티커 (그대로) */
  code: string;
}

/**
 * 버튼을 둘 종목과 시트에 보일 이름·코드. 이름이 없는 종목·지수·환율은 null (버튼 없음).
 * 이름이 티커뿐이면(토스 동기화로 들어온 RGTX 등) 시세가 준 이름(fullName)을 쓴다 — 없으면 티커 그대로. 이름을 지어내지 않는다
 */
export function tossAppTarget({ code, name, fullName }: { code: string; name: string | null | undefined; fullName?: string | null }): TossAppTarget | null {
  const c = realText(code);
  const own = realText(name);
  if (!c || !own || MARKET_CODES.has(c.toUpperCase())) return null;
  if (tickerKey(own) !== tickerKey(c)) return { name: own, code: c };
  const full = realText(fullName);
  return { name: full && tickerKey(full) !== tickerKey(c) ? full : own, code: c };
}

/**
 * 시트 첫 문장을 세 조각으로 (가운데 '"삼성전자"(005930)' 는 굵게 그린다).
 * 화면에는 before 뒤에서 줄을 바꿔 '토스 앱 → 증권 → 검색에서' / '"삼성전자"(005930)을 찾아 주세요.' 두 줄로 — 좁은 폰에서 '요.' 한 글자만 다음 줄로 떨어지지 않게
 */
export function tossFindParts(t: TossAppTarget): { before: string; strong: string; after: string } {
  return { before: "토스 앱 → 증권 → 검색에서", strong: `"${t.name}"(${t.code})`, after: "을 찾아 주세요." };
}

/** 시트 첫 문장 (화면 읽기·테스트): '토스 앱 → 증권 → 검색에서 "삼성전자"(005930)을 찾아 주세요.' */
export function tossFindText(t: TossAppTarget): string {
  const p = tossFindParts(t);
  return `${p.before} ${p.strong}${p.after}`;
}

/** 시트 본문 전체 (첫 문장 + 주문 안내) — 화면 읽기·테스트용 */
export function tossSheetBody(t: TossAppTarget): string {
  return `${tossFindText(t)} ${TOSS_APP.note}`;
}

type Open = (url: string) => unknown;

/** 토스 앱을 연다. 열었으면 true, 못 열었으면(토스 앱 없음 등 — openURL 이 거절·예외) false */
export async function openTossApp(open: Open): Promise<boolean> {
  try {
    await open(TOSS_APP_URL);
    return true;
  } catch {
    return false;
  }
}

/** Play 스토어의 토스 앱 페이지: market:// 먼저, 안 되면 https 주소. 둘 다 못 열면 false */
export async function openTossStore(open: Open): Promise<boolean> {
  for (const url of PLAY_STORE_URLS) {
    try {
      await open(url);
      return true;
    } catch {
      // 다음 주소로
    }
  }
  return false;
}

/** 버튼 아이콘 크기 · 아이콘과 글 사이 */
export const TOSS_ICON = font.small + space.xxs;
const ICON_GAP = space.xs;

/** 버튼 폭 어림 (아이콘 + 간격 + 글). 버튼 글·아이콘은 fontCap.chrome(150%) 까지만 커진다 */
export function tossButtonWidth(fontScale: number): number {
  const s = Math.min(Math.max(fontScale || 1, 1), fontCap.chrome);
  return TOSS_ICON * s + ICON_GAP + estimateTextWidth(TOSS_APP.label, font.small * s);
}
