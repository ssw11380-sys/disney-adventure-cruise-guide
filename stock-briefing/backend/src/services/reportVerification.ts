/** 입력 시세와 직접 비교할 수 있는 명시적 주장만 검사한다. 본문·해석·전망은 변경하지 않는다. */
export interface ReportVerification {
  scope: "quote_claims";
  quoteAsOf: string | null;
  quoteSource: string | null;
  checkedClaims: number;
  issues: Array<{ field: "price" | "changeRate"; reported: string; expected: string }>;
}

const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const stamp = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
const number = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });
// 가정·과거·범위·다른 가격과의 비교는 현재 시세의 단정으로 해석하지 않는다.
const QUALIFIED = /가정|예상|전망|경우|시나리오|예를|과거|전년|전월|어제|당시|이상|이하|초과|미만|사이|대비한|수\s*있/;
const OTHER_SUBJECT = /다른\s*(?:기업|종목)|경쟁사|예시|예제|지난/;
const PRICE = /^\s*(?:[-•]\s*)?\|?\s*(?:현재가|현재\s*(?:주가|가격)|기준\s*(?:주가|가격))\s*(?:[:：|]|은|는)?\s*(?:약\s*)?(\$?)([+-]?\d[\d,]*(?:\.\d+)?)\s*(억|만|천)?\s*(원|달러|USD|KRW)?(?=\s|[.,;|()]|입니다|이다|$)/i;
const RATE = /^\s*(?:[-•]\s*)?\|?\s*(?:전일\s*대비\s*(?:등락률)?|등락률)\s*(?:[:：|]|은|는)?\s*(?:약\s*)?([+-]?\d[\d,]*(?:\.\d+)?)\s*%\s*(상승|하락)?/;
const scales: Record<string, number> = { "억": 100_000_000, "만": 10_000, "천": 1_000 };
const roundedTolerance = (token: string, scale = 1) => 0.5 * 10 ** -(token.split(".")[1]?.length ?? 0) * scale + 1e-9;
// 뒤에 범위·다른 종목·과거 날짜·미지원 단위가 붙으면 숫자 일부만 떼어 단정하지 않는다.
const plainEnding = (tail: string) => /^(?:입니다|이다)?[\s.!|]*$/.test(tail.trim());

export function verifyReport(content: string, snapshot: unknown): ReportVerification {
  const quote = record(record(snapshot)?.quote);
  const result: ReportVerification = {
    scope: "quote_claims", quoteAsOf: stamp(quote?.asOf),
    quoteSource: typeof quote?.source === "string" ? quote.source : null,
    checkedClaims: 0, issues: [],
  };
  if (!quote) return result;
  const seen = new Set<string>();
  const check = (field: "price" | "changeRate", reported: string, actual: number, expected: number, tolerance: number, unit: string, contradictory = false) => {
    const key = `${field}:${reported}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.checkedClaims++;
    if (contradictory || Math.abs(actual - expected) > tolerance) result.issues.push({ field, reported, expected: `${number(expected)}${unit}` });
  };
  const sections: Array<{ level: number; excluded: boolean }> = [];
  for (const raw of content.split(/\n|(?<=[.!?;])\s+/)) {
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const level = heading[1]!.length;
      while (sections.length && sections.at(-1)!.level >= level) sections.pop();
      sections.push({ level, excluded: QUALIFIED.test(heading[2]!) || OTHER_SUBJECT.test(heading[2]!) });
    }
    // 과거·가정·다른 대상 절의 하위 문장도 같은 문맥이다. 같은 깊이 또는 상위의 현재 절에서 다시 검사한다.
    if (sections.some((section) => section.excluded)) continue;
    const line = raw.replace(/[*_`#]/g, "");
    if (QUALIFIED.test(line)) continue;
    const price = PRICE.exec(line);
    if (price && plainEnding(line.slice(price[0].length)) && finite(quote.price)) {
      const currency = price[1] || /달러|USD/i.test(price[4] ?? "") ? "USD" : /원|KRW/i.test(price[4] ?? "") ? "KRW" : null;
      // 환산 가격·단위가 생략된 숫자에는 현재가 비교를 적용하지 않는다.
      if (currency === quote.currency) {
        const scale = scales[price[3] ?? ""] ?? 1;
        check("price", price[0].trim(), Number(price[2]!.replace(/,/g, "")) * scale, quote.price, roundedTolerance(price[2]!, scale), currency === "KRW" ? "원" : "달러");
      }
    }
    const rate = RATE.exec(line);
    if (rate && plainEnding(line.slice(rate[0].length)) && finite(quote.changeRate)) {
      const token = rate[1]!;
      const value = Number(token.replace(/,/g, ""));
      const sign = rate[2] === "하락" ? -1 : rate[2] === "상승" ? 1 : null;
      const actual = sign === null ? value : sign * Math.abs(value);
      const contradictory = sign !== null && /^[+-]/.test(token) && value !== 0 && Math.sign(value) !== sign;
      check("changeRate", rate[0].trim(), actual, quote.changeRate, roundedTolerance(token), "%", contradictory);
    }
  }
  return result;
}
