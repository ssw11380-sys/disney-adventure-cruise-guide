import { unzipSync } from "fflate";
import iconv from "iconv-lite";
import type { ListedStock, Market } from "../../domain/types.js";
import { ProviderError } from "../../lib/errors.js";
import type { FetchFn, MasterProvider } from "./types.js";

/**
 * 한국투자증권이 공개 배포하는 종목 마스터 파일(kospi_code.mst / kosdaq_code.mst) 로더.
 * API 키 없이 받을 수 있어 종목명 검색의 1차 소스로 쓴다.
 *
 * 파일 형식 (cp949, 한 줄 = 한 종목):
 *   [단축코드 9][표준코드 12][한글명 ...][고정폭 숫자/코드 영역 N바이트]
 *   고정폭 영역은 KOSPI 228바이트, KOSDAQ 222바이트. 실제 파일에서는 이 영역이 공백 1바이트로 시작하고
 *   이어서 그룹코드 2바이트(ST=주식, EF=ETF, BC=수익증권 ...)가 온다. 앞 3바이트를 trim 해서 읽는다.
 */

const MASTER_URLS = {
  KOSPI: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
  KOSDAQ: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
} as const;

const TAIL_BYTES: Record<"KOSPI" | "KOSDAQ", number> = { KOSPI: 228, KOSDAQ: 222 };
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

export function parseMasterFile(raw: Buffer, market: "KOSPI" | "KOSDAQ"): ListedStock[] {
  const tail = TAIL_BYTES[market];
  const out: ListedStock[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === 0x0a) {
      let end = i;
      if (end > start && raw[end - 1] === 0x0d) end--;
      const line = raw.subarray(start, end);
      start = i + 1;
      if (line.length <= tail + 21) continue;
      const head = line.subarray(0, line.length - tail);
      const rest = line.subarray(line.length - tail);
      const code = iconv.decode(head.subarray(0, 9), "cp949").trim();
      const isin = iconv.decode(head.subarray(9, 21), "cp949").trim();
      const name = iconv.decode(head.subarray(21), "cp949").trim();
      const groupCode = iconv.decode(rest.subarray(0, 3), "cp949").trim() || null;
      if (!code || !name) continue;
      out.push({ code, name, market, isinCode: isin || null, groupCode });
    }
  }
  return out;
}

export class KisMasterProvider implements MasterProvider {
  readonly name = "kis-master";
  constructor(private readonly fetchFn: FetchFn = fetch) {}

  async fetchAll(): Promise<ListedStock[]> {
    const results = await Promise.all(
      (Object.keys(MASTER_URLS) as Array<keyof typeof MASTER_URLS>).map((m) => this.fetchMarket(m)),
    );
    return results.flat();
  }

  /** 배포 서버가 간헐적으로 503 을 내므로 몇 번 재시도한다. */
  private async download(market: keyof typeof MASTER_URLS): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchFn(MASTER_URLS[market]);
        if (res.ok) return res;
        lastErr = new ProviderError(this.name, `${market} 마스터 HTTP ${res.status}`);
      } catch (e) {
        lastErr = new ProviderError(this.name, `${market} 마스터 다운로드 실패`, e);
      }
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
    throw lastErr;
  }

  private async fetchMarket(market: keyof typeof MASTER_URLS): Promise<ListedStock[]> {
    const res = await this.download(market);
    const zip = new Uint8Array(await res.arrayBuffer());
    const files = unzipSync(zip);
    const entry = Object.values(files)[0];
    if (!entry) throw new ProviderError(this.name, `${market} zip 이 비어 있음`);
    return parseMasterFile(Buffer.from(entry), market);
  }
}

export function toMarket(s: string): Market {
  return s === "KOSPI" || s === "KOSDAQ" ? s : "UNKNOWN";
}
