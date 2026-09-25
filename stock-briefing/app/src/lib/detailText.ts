import { speakProfit, speakRate, sentence } from "@/lib/a11y";
import { formatPct, formatPrice, shownSign } from "@/lib/format";
import type { EvalView } from "@/lib/liveTick";

/**
 * 종목 상세 머리의 글자 (순수 함수 → 단위 테스트).
 *  - realText: 업종처럼 자리표시('-', '—', 'N/A', 공백)로 오는 값은 없는 것으로 (예전 'RGTX · NASDAQ · -')
 *  - displayName: 등록 이름이 티커뿐이면 시세가 준 사람이 읽는 이름(quote.fullName — 새 서버만)으로
 *  - holdingLine: 휴대폰·접은 화면 시세 머리 아래 '보유 160주 · 평가손익 -2,342,254원 (-26.25%)' 한 줄 (기능 플래그 detailPolish)
 */

/** 자리표시가 아닌 글자. '-' · '—' · 'N/A' · 빈 글자 · 공백이면 null */
export function realText(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" || /^(-|—|–|n\/a|null|undefined)$/i.test(s) ? null : s;
}

/** 티커 비교용: 대문자 + 공백·점·하이픈 빼기 (BRK.B = BRK-B = BRK B) */
const tickerKey = (s: string) => s.replace(/[\s.-]/g, "").toUpperCase();

/**
 * 화면에 쓸 종목 이름. 등록 이름이 비었거나 코드(티커)와 같으면(토스 동기화로 들어온 RGTX 등) 시세의 사람이 읽는 이름(fullName)을 쓴다.
 * fullName 이 없거나 자리표시이거나 그것도 티커면 등록 이름(없으면 코드) 그대로 — 이름을 지어내지 않는다
 */
export function displayName(name: string | null | undefined, code: string, fullName?: string | null): string {
  const own = realText(name);
  if (own && tickerKey(own) !== tickerKey(code)) return own;
  const full = realText(fullName);
  if (full && tickerKey(full) !== tickerKey(code)) return full;
  return own ?? code;
}

export interface HoldingLine {
  quantity: string;
  profit: string;
  rate: string;
  /** 보이는 값의 부호 (색) — '0원'·'0.00%' 로 보이면 0 (BH-38) */
  profitSign: number;
  rateSign: number;
  /** '보유 160주 · 평가손익 -2,342,254원 (-26.25%)' */
  text: string;
  /** 화면 읽기 한 문장: '보유 160주, 평가손익 2,342,254원 손실, 수익률 26.25% 하락' */
  a11y: string;
}

/**
 * 시세 머리 아래 보유 한 줄. 잔고 화면 줄과 같은 평가(evalView — 매도 비용 차감·원화로 보기 설정을 따름)를 받는다.
 * 보유 수량이 없거나 평가가 없으면(평단 없음·시세 없음) null → 줄을 그리지 않는다
 */
export function holdingLine(quantity: number | null | undefined, ev: EvalView | null | undefined): HoldingLine | null {
  if (!ev || quantity === null || quantity === undefined || !(quantity > 0)) return null;
  // 잔고 화면 줄과 같은 수량 표기 (소수 주는 넷째 자리까지, 끝의 0 은 뺀다 — 2.5주)
  const qty = quantity.toLocaleString("ko-KR", { maximumFractionDigits: Number.isInteger(quantity) ? 0 : 4 });
  const profit = formatPrice(ev.profit, ev.currency, { sign: true });
  const rate = formatPct(ev.profitRate);
  const profitSign = shownSign(ev.profit, profit);
  const rateSign = shownSign(ev.profitRate, rate);
  return {
    quantity: qty,
    profit,
    rate,
    profitSign,
    rateSign,
    text: `보유 ${qty}주 · 평가손익 ${profit} (${rate})`,
    a11y: sentence([`보유 ${qty}주`, `평가손익 ${speakProfit(profit, profitSign) ?? "없음"}`, speakRate(ev.profitRate) ? `수익률 ${speakRate(ev.profitRate)}` : null]),
  };
}
