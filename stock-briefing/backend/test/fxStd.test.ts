import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSmbsStd, SmbsStdRates, SMBS_STD_URL } from "../src/providers/market/fxStd.js";

/**
 * 세법 기준환율 (3-37): 서울외국환중개 '기간별 매매기준율' 공개 XML. 픽스처는 2026-09-28 에 받은 모양 그대로(EUC-KR)다 — 네트워크 없음
 */
const FIX = readFileSync(fileURLToPath(new URL("./fixtures/journal/smbs-std-usd-2026-09.xml", import.meta.url)));

describe("서울외국환중개 매매기준율 XML", () => {
  it("녹화한 모양을 날짜별 값으로 읽는다 — 추석(9/24·25)·주말은 줄이 없다", () => {
    const rows = parseSmbsStd(new TextDecoder("euc-kr").decode(FIX));
    expect(rows[0]).toEqual({ date: "2026-09-01", rate: 1373.6 });
    expect(rows.find((r) => r.date === "2026-09-23")).toEqual({ date: "2026-09-23", rate: 1360 });
    expect(rows.at(-1)).toEqual({ date: "2026-09-28", rate: 1352 });
    expect(rows.some((r) => r.date === "2026-09-24" || r.date === "2026-09-25" || r.date === "2026-09-26")).toBe(false);
    expect(rows).toHaveLength(18);
  });

  it("모양이 다르거나 값이 이상하면 버린다 (빈 배열)", () => {
    expect(parseSmbsStd("<html>점검 중</html>")).toEqual([]);
    expect(parseSmbsStd("<set label='26.09.01' value='abc' />")).toEqual([]);
    expect(parseSmbsStd(`<set color='x' label="26.09.02" value="1,370.3"/>`)).toEqual([{ date: "2026-09-02", rate: 1370.3 }]);
  });

  it("기간을 http 공개 주소로 묻고, 1년이 넘으면 나눠 묻는다", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(FIX, { status: 200, headers: { "content-type": "text/xml; charset=EUC-KR" } });
    }) as unknown as typeof fetch;
    const rows = await new SmbsStdRates(fake).range("2026-09-01", "2026-09-28");
    expect(urls).toEqual([`${SMBS_STD_URL}?arr_value=USD_2026-09-01_2026-09-28`]);
    expect(rows).toHaveLength(18);
    urls.length = 0;
    await new SmbsStdRates(fake).range("2025-01-01", "2026-09-28");
    expect(urls).toEqual([`${SMBS_STD_URL}?arr_value=USD_2025-01-01_2025-12-31`, `${SMBS_STD_URL}?arr_value=USD_2026-01-01_2026-09-28`]);
  });

  it("응답이 실패면 던진다 (부르는 쪽이 다음에 다시)", async () => {
    const fake = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
    await expect(new SmbsStdRates(fake).range("2026-09-01", "2026-09-28")).rejects.toThrow(/503/);
  });
});
