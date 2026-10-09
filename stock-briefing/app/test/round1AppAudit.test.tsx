import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "./miniRender";

const h = vi.hoisted(() => ({ openURL: vi.fn(), alert: vi.fn() }));
vi.mock("react-native", () => ({ Linking: { openURL: h.openURL }, Alert: { alert: h.alert } }));
vi.mock("react-native-markdown-display", () => ({ default: "Markdown", MarkdownIt: (options: unknown) => ({ options }) }));
vi.mock("@/theme", async () => { const t = await import("@/tokens"); return { ...t, useTheme: () => t.dark }; });
const { MarkdownView } = await import("@/components/MarkdownView");
const content = "## 분석 근거\n본문 [공시](https://example.test/disclosure)";
function rendered() {
  const r = render(<MarkdownView>{content}</MarkdownView>);
  const markdown = r.all().find(n => n.type === "Markdown")!;
  return { markdown, press: markdown.props.onLinkPress as (url: string) => boolean };
}
beforeEach(() => { h.openURL.mockReset(); h.alert.mockReset(); });
afterEach(cleanupRenders);

describe("1차 앱 검증: 본문에 들어 있는 원문 링크", () => {
  it("정상 원문을 즉시 한 번 열고 기본 중복 열기를 막으며 본문은 보존한다", async () => {
    h.openURL.mockResolvedValue(undefined);
    const { markdown, press } = rendered();
    expect(press("https://example.test/disclosure")).toBe(false);
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith("https://example.test/disclosure");
    await Promise.resolve();
    expect(h.alert).not.toHaveBeenCalled();
    expect(markdown.children).toEqual([content]);
  });

  it("브라우저 거부를 안내하고 사용자 재시도는 한 번만 더 연다", async () => {
    const failure = Promise.reject(new Error("모의 브라우저 거부"));
    // 변경 전 콜백의 미처리 거부가 검사 프로세스를 방해하지 않게 시험용 Promise만 회수한다.
    void failure.catch(() => {});
    h.openURL.mockReturnValueOnce(failure).mockResolvedValueOnce(undefined);
    const { press } = rendered();
    expect(press("https://example.test/disclosure")).toBe(false);
    await Promise.resolve(); await Promise.resolve();
    expect(h.alert).toHaveBeenCalledExactlyOnceWith("원문을 열지 못했습니다", "브라우저 연결을 확인한 뒤 다시 눌러 주세요.");
    expect(h.openURL).toHaveBeenCalledTimes(1);
    expect(press("https://example.test/disclosure")).toBe(false);
    await Promise.resolve();
    expect(h.openURL).toHaveBeenCalledTimes(2);
    expect(h.alert).toHaveBeenCalledTimes(1);
  });

  it("본문 콜백에 웹 주소가 아닌 값이 와도 운영체제에 넘기지 않는다", async () => {
    const { press } = rendered();
    expect(press("intent://example.test/disclosure")).toBe(false);
    await Promise.resolve();
    expect(h.openURL).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalledExactlyOnceWith("원문을 열지 못했습니다", "브라우저 연결을 확인한 뒤 다시 눌러 주세요.");
  });
});
