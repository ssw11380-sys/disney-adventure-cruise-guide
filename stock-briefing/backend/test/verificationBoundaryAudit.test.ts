import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { NaverFinanceProvider } from "../src/providers/market/naver.js";
import { codeSummaryLine } from "../src/services/briefingWording.js";
import { verifyReport } from "../src/services/reportVerification.js";
import { makeQuote } from "./helpers.js";

const snapshot = { quote: { ...makeQuote("005930", "고정 출처", 71_234), changeRate: 1.01, asOf: "2026-12-24T15:30:00+09:00" } };

describe("수치 검증 추가 경계 감사", () => {
  it.each([
    "현재가: 71,234원", "- **현재가**: 7.12만원", "| 현재가 | 7.1만 원 |",
    "현재 주가는 약 71,234원입니다.", "등락률: +1.01%", "전일 대비: 1.01% 상승",
  ])("정상 단독 주장은 불일치 경고 없이 확인한다: %s", (body) => {
    expect(verifyReport(body, snapshot)).toMatchObject({ checkedClaims: 1, issues: [] });
  });

  it.each([
    "과거 현재가: 70,000원", "현재가: 70,000원 (어제 기준)", "예상 현재가: 70,000원",
    "현재가: 70,000원 ~ 80,000원", "다른 기업 현재가: 70,000원", "현재가: $70,000",
  ])("같은 줄에 명시된 다른 시점·가정·범위·통화는 비교하지 않는다: %s", (body) => {
    expect(verifyReport(body, snapshot)).toMatchObject({ checkedClaims: 0, issues: [] });
  });

  it.each([
    "## 어제 기록\n현재가: 70,000원",
    "## 가정 시나리오\n현재가: 70,000원",
    "## 다른 기업 비교\n현재가: 70,000원",
  ])("절 제목에 붙은 시점·대상·가정의 숫자를 현재 시세로 오인하지 않는다: %s", (body) => {
    expect(verifyReport(body, snapshot)).toMatchObject({ checkedClaims: 0, issues: [] });
  });

  it("다른 시점의 절을 벗어나 같은 깊이의 현재 절로 돌아오면 다시 대조한다", () => {
    const body = "## 어제 기록\n현재가: 70,000원\n## 현재 위치\n현재가: 80,000원";
    expect(verifyReport(body, snapshot)).toMatchObject({ checkedClaims: 1, issues: [{ reported: "현재가: 80,000원", expected: "71,234원" }] });
  });

  it("과거 절의 하위 제목도 같은 문맥이며 상위의 현재 절에서만 대조를 재개한다", () => {
    const body = "## 과거 기록\n### 가격\n현재가: 70,000원\n### 등락\n등락률: -2.00%\n# 현재 위치\n현재가: 80,000원";
    expect(verifyReport(body, snapshot)).toMatchObject({ checkedClaims: 1, issues: [{ reported: "현재가: 80,000원" }] });
  });

  it.each([
    "현재가(장중): 70,000원", "현재가: 70,000원 (KRX+NXT 통합)",
    "현재가는 70,000원이며 전일 대비 -2.00%입니다.", "- 현재가 70,000원, 등락률 -2.00%",
    "현재가: 70,000원으로 20일선 아래입니다.", "종가: 70,000원",
  ])("범위 관찰: 자연어·복합 표기·가격 기준이 붙은 문장은 검사 대상이 아니다: %s", (body) => {
    // 미검출을 '본문 검증 통과'로 해석하면 안 된다. 검사기가 모든 모델 형식을 지원한다고 주장하지 않는다.
    expect(verifyReport(body, snapshot)).toMatchObject({ checkedClaims: 0, issues: [] });
  });

  it("반증: 등락률 뒤 존댓말 종결만 붙은 문장은 정상적으로 대조한다", () => {
    expect(verifyReport("등락률: -2.00%입니다.", snapshot)).toMatchObject({ checkedClaims: 1, issues: [{ field: "changeRate" }] });
  });

  it("현재 프롬프트가 요구하는 장중·통합 기준 표기는 실제로 존재하며 단독 주장 검사 범위와 다르다", async () => {
    const prompt = await readFile(new URL("../prompts/briefing_detail_safe.md", import.meta.url), "utf8");
    expect(prompt).toContain("현재가(장중)");
    expect(prompt).toContain("(KRX+NXT 통합)");
    expect(verifyReport("현재가(장중): 70,000원 (KRX+NXT 통합)", snapshot).checkedClaims).toBe(0);
    expect(verifyReport(codeSummaryLine(snapshot.quote), snapshot).checkedClaims).toBe(0);
  });

  it("현재 시세가 달라져도 저장한 자료와 비교하며 원본 자료를 변경하지 않는다", () => {
    const input = structuredClone(snapshot);
    expect(verifyReport("현재가: 71,234원", input).issues).toEqual([]);
    const current = { quote: { ...input.quote, price: 80_000 } };
    expect(verifyReport("현재가: 71,234원", current).issues).toHaveLength(1);
    expect(input).toEqual(snapshot);
    expect(verifyReport("현재가: 71,234원", input).quoteAsOf).toBe("2026-12-24T15:30:00+09:00");
  });

  it.each([null, [], "예전 자료", {}, { quote: null }, { quote: { price: "71234", changeRate: "1.01" } }])(
    "자료가 없거나 예전 자료의 형식이 다르면 수치 확인 완료로 바꾸지 않는다: %j", (input) => {
      expect(verifyReport("현재가: 71,234원", input)).toMatchObject({ quoteAsOf: null, checkedClaims: 0, issues: [] });
    },
  );

  it("제공자→보고서 경로 관찰: 네이버의 자료 시각은 마지막 체결 시각이 아닌 조회 시각이다", async () => {
    const tradedAt = "2026-12-24T15:30:00+09:00";
    const queriedAt = "2026-12-28T08:30:00+09:00";
    const fetchFn = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("polling.finance")
      ? { datas: [{ itemCode: "005930", closePriceRaw: "71234", compareToPreviousPrice: { code: "2" }, fluctuationsRatioRaw: "1.01", localTradedAt: tradedAt, marketStatus: "CLOSE" }] }
      : { totalInfos: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const quote = await new NaverFinanceProvider(fetchFn, () => new Date(queriedAt)).getQuote("005930");
    const result = verifyReport("현재가: 71,234원", { quote });
    expect(result.quoteAsOf).toBe(queriedAt);
    expect(result.quoteAsOf).not.toBe(tradedAt);
    expect(result.quoteSource).toBe("naver");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
