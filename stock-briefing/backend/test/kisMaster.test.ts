import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { parseMasterFile } from "../src/providers/market/kisMaster.js";

/** 실제 파일과 동일한 규격의 한 줄을 만든다: [코드9][표준12][이름 가변][고정폭 꼬리 N] */
function line(code: string, isin: string, name: string, group: string, tail: number): Buffer {
  const head = Buffer.concat([
    iconv.encode(code.padEnd(9), "cp949"),
    iconv.encode(isin.padEnd(12), "cp949"),
    iconv.encode(name.padEnd(30), "cp949"),
  ]);
  const rest = Buffer.alloc(tail, 0x20);
  rest.write(group, 1, "ascii"); // 실제 파일처럼 공백 1바이트 뒤에 그룹코드
  return Buffer.concat([head, rest, Buffer.from("\r\n")]);
}

describe("parseMasterFile", () => {
  it("KOSPI 파일에서 코드/표준코드/한글명/그룹코드를 읽는다 (꼬리 228바이트)", () => {
    const raw = Buffer.concat([
      line("000660", "KR7000660001", "SK하이닉스", "ST", 228),
      line("F70100030", "KR5701000303", "한투한미핵심성장포커스1(A)", "BC", 228),
    ]);
    const rows = parseMasterFile(raw, "KOSPI");
    expect(rows).toEqual([
      { code: "000660", name: "SK하이닉스", market: "KOSPI", isinCode: "KR7000660001", groupCode: "ST" },
      { code: "F70100030", name: "한투한미핵심성장포커스1(A)", market: "KOSPI", isinCode: "KR5701000303", groupCode: "BC" },
    ]);
  });

  it("KOSDAQ 파일은 꼬리 222바이트 기준으로 파싱한다", () => {
    const raw = line("247540", "KR7247540008", "에코프로비엠", "ST", 222);
    expect(parseMasterFile(raw, "KOSDAQ")).toEqual([
      { code: "247540", name: "에코프로비엠", market: "KOSDAQ", isinCode: "KR7247540008", groupCode: "ST" },
    ]);
  });

  it("빈 줄과 너무 짧은 줄은 건너뛴다", () => {
    const raw = Buffer.concat([Buffer.from("\n"), Buffer.from("short\n"), line("005930", "KR7005930003", "삼성전자", "ST", 228)]);
    expect(parseMasterFile(raw, "KOSPI")).toHaveLength(1);
  });
});
