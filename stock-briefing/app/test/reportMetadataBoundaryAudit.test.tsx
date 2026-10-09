import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ReportVerification } from "@/api/types";
import { render } from "./miniRender";

vi.mock("react-native", () => ({ Text: "Text", View: "View" }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.light }; });
vi.mock("@/components/ui", () => ({ Muted: "Muted" }));
const { ReportVerificationNotice } = await import("@/components/ReportVerification");
const base: ReportVerification = { scope: "quote_claims", quoteAsOf: "2026-12-24T15:30:00+09:00", quoteSource: "고정 출처", checkedClaims: 1, issues: [] };

describe("보고서 메타데이터 추가 경계 감사", () => {
  it.each([undefined, null])("예전 서버에서 검증 메타데이터가 없으면 본문 주변 안내를 안전하게 그린다: %j", (value) => {
    expect(render(<ReportVerificationNotice verification={value as ReportVerification | undefined} />).text()).toBe("보고서에 사용한 시세 시각: 제공되지 않음");
  });

  it.each(["", "잘못된 시간"])("시각을 파싱할 수 없으면 새 시각을 만들어 보여 주지 않는다: %s", (quoteAsOf) => {
    expect(render(<ReportVerificationNotice verification={{ ...base, quoteAsOf }} />).text()).toContain("시각: 제공되지 않음");
  });

  it("날짜가 오래됐어도 자료 시각 그대로 표시하고 생성시각이나 현재시각으로 바꾸지 않는다", () => {
    const text = render(<ReportVerificationNotice verification={base} />).text();
    expect(text).toContain("12월 24일 (목) 15:30");
    expect(text).toContain("고정 출처");
    expect(text).not.toContain("생성");
    expect(text).toContain("보고서에 사용한 시세 시각");
    expect(text).toContain("일부 출처는 체결 시각 대신 조회 시각을 제공합니다");
  });

  it.each([0, 2])("검사한 주장 %i개와 경고 없음이 전체 사실성 보증으로 표시되지 않는다", (checkedClaims) => {
    const r = render(<ReportVerificationNotice verification={{ ...base, checkedClaims }} />);
    expect(r.text()).not.toMatch(/검증 완료|정확합니다|모두 일치|전체.*보증/);
    expect(r.all().some((node) => node.props.accessibilityRole === "alert")).toBe(false);
  });

  it.each([{}, { quoteAsOf: base.quoteAsOf }, { ...base, issues: null }, { ...base, issues: "잘못된 자료" }, { ...base, issues: [null] }])(
    "누락·손상된 issues가 보고서 화면을 중단하지 않는다: %j", (value) => {
      expect(() => render(<ReportVerificationNotice verification={value as unknown as ReportVerification} />)).not.toThrow();
    },
  );

  it("정상 경고는 원자료 값과 검사 범위를 함께 표시하고 본문 전체를 확정하지 않는다", () => {
    const r = render(<ReportVerificationNotice verification={{ ...base, issues: [{ field: "price", reported: "현재가: 70,000원", expected: "71,234원" }] }} />);
    expect(r.text()).toContain("현재가: 70,000원 · 원자료 71,234원");
    expect(r.text()).toContain("본문 전체의 사실성을 보증하지 않습니다");
    expect(r.all().some((node) => node.props.accessibilityRole === "alert")).toBe(true);
  });
});
