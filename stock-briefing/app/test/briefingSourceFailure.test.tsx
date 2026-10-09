import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefingWithData } from "@/api/types";
import { cleanupRenders, render } from "./miniRender";

const h = vi.hoisted(() => ({ openURL: vi.fn(), alert: vi.fn() }));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", Linking: { openURL: h.openURL }, Alert: { alert: h.alert },
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.light }; });
vi.mock("@/components/ui", () => ({ Card: "Card", Muted: "Muted", SectionTitle: "SectionTitle" }));
const { BriefingSources } = await import("@/components/BriefingSources");
const data = {
  quote: null,
  news: [{ title: "시험 뉴스", source: "시험 언론사", publishedAt: "2026-10-02T09:00:00+09:00", url: "https://example.test/news" }],
  disclosures: [{ receiptNo: "test", title: "시험 공시", filer: "시험 기업", filedAt: "2026-10-02", url: "https://example.test/disclosure" }],
} as BriefingWithData["data"];

beforeEach(() => { cleanupRenders(); h.openURL.mockReset(); h.alert.mockReset(); });

describe("보고서 근거 원문 열기 실패", () => {
  it.each(["뉴스", "공시"])("%s 원문을 기기에서 열지 못하면 실패와 다음 행동을 알린다", async (kind) => {
    h.openURL.mockRejectedValue(new Error("시험 브라우저 오류"));
    const r = render(<BriefingSources data={data} />);
    const link = r.all().find((n) => n.type === "Pressable" && String(n.props.accessibilityLabel).startsWith(`${kind}:`))!;
    r.act(() => (link.props.onPress as () => void)());
    await Promise.resolve(); await Promise.resolve();
    expect(h.openURL).toHaveBeenCalledOnce();
    expect(h.alert).toHaveBeenCalledWith("원문을 열지 못했습니다", "브라우저 연결을 확인한 뒤 다시 눌러 주세요.");
  });

  it("정상 원문은 한 번만 열고 보고서 본문이나 조회를 바꾸지 않는다", async () => {
    h.openURL.mockResolvedValue(undefined);
    const r = render(<BriefingSources data={data} />);
    const link = r.all().find((n) => n.type === "Pressable")!;
    r.act(() => (link.props.onPress as () => void)());
    await Promise.resolve(); await Promise.resolve();
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith("https://example.test/news");
    expect(h.alert).not.toHaveBeenCalled();
    expect(r.text()).toContain("시험 뉴스");
  });
});
