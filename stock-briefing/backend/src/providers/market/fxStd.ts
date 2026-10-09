import { ProviderError } from "../../lib/errors.js";
import { fetchWithTimeout } from "../../lib/timedFetch.js";

/**
 * 세법 기준환율 (3-37 해외주식 양도세 추정) — 로그인 없는 공개 값만.
 *  1) 서울외국환중개 '기간별 매매기준율' 페이지가 그래프에 쓰는 공개 XML (`/ExRate/StdExRate_xml.jsp?arr_value=USD_시작_끝`, EUC-KR,
 *     `<set label='26.09.01' value='1373.6' />` 한 줄이 하루). 고시가 없는 날(한국 휴일·주말)은 줄이 없다.
 *     https 는 인증서 이름이 맞지 않아 http 로 묻는다 — 받는 것은 공개 환율뿐이라 개인 정보는 나가지 않고,
 *     변조 가능성을 줄이려고 부르는 쪽(journalService)이 네이버 값과 1% 넘게 다르면 쓰지 않는다
 *  2) 없으면 하나은행 고시 환율(네이버 일별 종가 — 이미 쓰는 지수·환율 일봉)으로 대신하고 그렇게 표시한다
 * 한국은행 ECOS 는 공식 API 지만 인증키(가입)가 필요해 쓰지 않는다
 */

export interface DailyRate {
  date: string;
  rate: number;
}

export const SMBS_STD_URL = "http://www.smbs.biz/ExRate/StdExRate_xml.jsp";

/** XML 본문 → 날짜별 매매기준율 (날짜 순, 같은 날은 마지막 값). 모양이 다르면 빈 배열 */
export function parseSmbsStd(xml: string): DailyRate[] {
  const out = new Map<string, number>();
  const re = /<set\b[^>]*?\blabel\s*=\s*['"](\d{2})\.(\d{2})\.(\d{2})['"][^>]*?\bvalue\s*=\s*['"]([\d.,]+)['"][^>]*\/?>/gi;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const rate = Number(m[4]!.replace(/,/g, ""));
    if (!Number.isFinite(rate) || rate <= 0) continue;
    out.set(`20${m[1]}-${m[2]}-${m[3]}`, rate);
  }
  return [...out].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, rate]) => ({ date, rate }));
}

function decode(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("euc-kr").decode(buf);
  } catch {
    // ICU 가 없는 런타임: 필요한 칸(날짜·숫자)은 ASCII 라 latin1 로 읽어도 된다
    return new TextDecoder("latin1").decode(buf);
  }
}

export class SmbsStdRates {
  readonly name = "smbs";
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  /** [from, to] 기간의 달러 매매기준율 (최대 1년씩 나눠 묻는다) */
  async range(from: string, to: string): Promise<DailyRate[]> {
    const out: DailyRate[] = [];
    for (let s = from; s <= to; ) {
      const e = minDate(to, addYear(s));
      const url = `${SMBS_STD_URL}?arr_value=USD_${s}_${e}`;
      const res = await fetchWithTimeout(this.fetchFn, url, { headers: { accept: "text/xml,*/*" } });
      if (!res.ok) throw new ProviderError(this.name, `매매기준율 응답 ${res.status}`);
      const rows = parseSmbsStd(decode(await res.arrayBuffer()));
      out.push(...rows.filter((r) => r.date >= s && r.date <= e));
      s = nextDay(e);
    }
    return out;
  }
}

const minDate = (a: string, b: string) => (a < b ? a : b);
function addYear(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function nextDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
