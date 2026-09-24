/**
 * 화면 읽기 프로그램(TalkBack)이 읽을 문장 (3-22). 화면의 기호(+ − ▲ ▼ $)를 말로 바꾸고, 한 줄을 한 문장으로 묶는다.
 * React Native 를 불러오지 않는 순수 모듈 (테스트에서 문장을 그대로 확인한다).
 */

/** 빈 조각을 빼고 쉼표로 잇는다 */
export function sentence(parts: (string | null | undefined | false)[]): string {
  return parts.filter((p): p is string => !!p && p.trim() !== "" && p.trim() !== "-").join(", ");
}

/** 달러 약식 단위 → 한국어 단위 (1T = 1조, 1B = 10억, 1M = 100만, 1K = 1천) */
const USD_UNIT: Record<string, [number, string]> = { T: [1, "조"], B: [10, "억"], M: [100, "만"], K: [1000, ""] };

/**
 * 금액 표기를 읽는 말로: "+20,000원" → "20,000원", "-$1,234.50" → "1,234.50달러", "$1.2B" → "12억 달러".
 * 부호는 뒤의 이익·손실·상승·하락이 말한다
 */
export function speakAmount(text: string): string {
  const s = text.trim().replace(/^[+\-−▲▼]/, "");
  if (!s.startsWith("$")) return s;
  const m = s.slice(1).match(/^([\d,.]+)([TBMK])$/);
  if (m) {
    const [k, unit] = USD_UNIT[m[2]!]!;
    const n = Number(m[1]!.replace(/,/g, "")) * k;
    return `${n.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}${unit} 달러`;
  }
  return `${s.slice(1)}달러`;
}

/** 등락률: "2.86% 상승" · "1.20% 하락" · "보합" */
export function speakRate(v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (v === 0) return "보합";
  const a = Math.abs(v);
  return `${a >= 1000 ? a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : a.toFixed(2)}% ${v > 0 ? "상승" : "하락"}`;
}

/** 손익: "20,000원 이익" · "1,500원 손실" · "손익 없음" (amount 는 화면 표기 그대로) */
export function speakProfit(amount: string, sign: number | null | undefined): string | null {
  if (sign === null || sign === undefined || !Number.isFinite(sign) || amount.trim() === "-") return null;
  if (sign === 0) return "손익 없음";
  return `${speakAmount(amount)} ${sign > 0 ? "이익" : "손실"}`;
}

/** 전일 대비 금액: "2,500원 상승" (amount 는 화면 표기, 화살표·부호 포함 가능) */
export function speakMove(amount: string, sign: number | null | undefined): string | null {
  if (sign === null || sign === undefined || !Number.isFinite(sign) || amount.trim() === "-") return null;
  if (sign === 0) return "변동 없음";
  return `${speakAmount(amount)} ${sign > 0 ? "상승" : "하락"}`;
}

export interface RowSpeech {
  name: string;
  us: boolean;
  /** 보유 종목이면 수량·평단·평가손익 */
  holding?: { quantity: string; avg: string; profit: string; profitSign: number; profitRate: number | null } | null;
  /** 시세 (없으면 missing 을 읽는다) */
  price?: { text: string; changeRate: number | null; live?: boolean } | null;
  missing?: string;
  /** 관심 종목의 전일 대비·거래량 */
  move?: { text: string; sign: number | null } | null;
  volume?: string;
}

/**
 * 잔고·관심 한 줄을 한 문장으로.
 *  보유: "삼성전자, 국내, 10주 보유, 평단 70,000원, 현재가 72,000원, 2.86% 상승, 평가손익 20,000원 이익, 수익률 2.86% 상승"
 *  관심: "애플, 미국, 관심, 현재가 230.10달러, 1.20% 하락, 전일 대비 2.80달러 하락, 거래량 5,000만주"
 */
export function stockRowLabel(r: RowSpeech): string {
  const h = r.holding;
  return sentence([
    r.name,
    r.us ? "미국" : "국내",
    h ? `${h.quantity}주 보유` : "관심",
    h ? `평단 ${speakAmount(h.avg)}` : null,
    r.price ? `현재가 ${speakAmount(r.price.text)}` : r.missing || "시세 없음",
    r.price ? speakRate(r.price.changeRate) : null,
    r.price?.live ? "실시간" : null,
    h ? `평가손익 ${speakProfit(h.profit, h.profitSign) ?? "없음"}` : null,
    h && speakRate(h.profitRate) ? `수익률 ${speakRate(h.profitRate)}` : null,
    !h && r.move ? (speakMove(r.move.text, r.move.sign) ? `전일 대비 ${speakMove(r.move.text, r.move.sign)}` : null) : null,
    !h && r.volume ? `거래량 ${r.volume}` : null,
  ]);
}
