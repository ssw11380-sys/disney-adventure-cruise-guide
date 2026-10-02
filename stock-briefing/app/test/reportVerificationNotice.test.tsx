import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";
import type { ReportVerification } from "@/api/types";
vi.mock("react-native", () => ({ Text: "Text", View: "View" }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.light }; });
vi.mock("@/components/ui", () => ({ Muted: "Muted" }));
const { ReportVerificationNotice } = await import("@/components/ReportVerification");
const base: ReportVerification = { scope: "quote_claims", quoteAsOf: "2026-10-02T09:05:00+09:00", quoteSource: "고정 출처", checkedClaims: 1, issues: [] };
describe("보고서의 실제 시세 시각과 숫자 불일치 안내", () => {
  it("명시적 수치가 일치해도 전체 본문 검증 완료 표시를 하지 않는다", () => {
    const r = render(<ReportVerificationNotice verification={base} />);
    expect(r.text()).toContain("보고서에 사용한 시세 시각");
    expect(r.text()).toContain("고정 출처");
    expect(r.text()).not.toContain("검증 완료");
    expect(r.all().some(n => n.props.accessibilityRole === "alert")).toBe(false);
  });
  it("불일치 주장과 원자료를 함께 보여 주고 확인 범위를 밝힌다", () => {
    const r = render(<ReportVerificationNotice verification={{ ...base, issues: [{ field: "price", reported: "현재가: 99,000원", expected: "100,000원" }] }} />);
    expect(r.text()).toContain("현재가: 99,000원 · 원자료 100,000원");
    expect(r.text()).toContain("명시적 표기만 대조");
    expect(r.all().some(n => n.props.accessibilityRole === "alert")).toBe(true);
  });
  it.each([undefined, { ...base, quoteAsOf: null }, { ...base, quoteAsOf: "잘못됨" }])("없는 자료 시각은 현재 또는 생성 시각으로 꾸미지 않는다", (verification) => {
    expect(render(<ReportVerificationNotice verification={verification} />).text()).toContain("보고서에 사용한 시세 시각: 제공되지 않음");
  });
});
