import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "./miniRender";

/**
 * 마크다운 렌더러 (components/MarkdownView). 라이브러리 Markdown 은 React.memo 라 속성이 같으면 다시 해석하지 않는다.
 * 넓은 창 브리핑 탭은 체결마다 부모가 다시 그려지므로(3-42), 링크 함수·해석기·스타일을 그릴 때마다 같은 값으로 넘기는지 본다
 */
const h = vi.hoisted(() => ({ openURL: vi.fn(async () => true), made: [] as unknown[] }));

vi.mock("react-native", () => ({ Linking: { openURL: h.openURL } }));
vi.mock("react-native-markdown-display", () => ({
  default: "Markdown",
  MarkdownIt: (options: unknown) => {
    h.made.push(options);
    return { options };
  },
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/tokens");
  return { ...tokens, useTheme: () => tokens.dark };
});

const { MarkdownView } = await import("@/components/MarkdownView");

const TEXT = "## 한 줄 요약\n본문 [출처](https://example.com)";
const markdownOf = (r: ReturnType<typeof render>) => r.all().find((n) => n.type === "Markdown")!;

describe("MarkdownView — 다시 그려도 Markdown(React.memo)에 같은 속성", () => {
  it("링크 함수·해석기·스타일이 그릴 때마다 같다 → 부모가 다시 그려져도 마크다운을 다시 읽지 않는다", () => {
    const r = render(<MarkdownView>{TEXT}</MarkdownView>);
    const first = markdownOf(r).props;
    r.rerender(<MarkdownView>{TEXT}</MarkdownView>);
    const second = markdownOf(r).props;
    for (const k of ["onLinkPress", "markdownit", "style"]) expect(second[k], k).toBe(first[k]);
    // 새로 그린 다른 MarkdownView 도 같은 링크 함수·해석기를 쓴다 (모듈 상수)
    const other = markdownOf(render(<MarkdownView>{"다른 글"}</MarkdownView>)).props;
    expect(other.onLinkPress).toBe(first.onLinkPress);
    expect(other.markdownit).toBe(first.markdownit);
    // 해석기는 라이브러리 기본값과 같은 설정으로 한 번만 만든다
    expect(h.made).toEqual([{ typographer: true }]);
  });

  it("본문 속 링크는 밖(브라우저)에서 열고, 라이브러리의 기본 열기는 막는다(false)", () => {
    const md = markdownOf(render(<MarkdownView>{TEXT}</MarkdownView>));
    expect((md.props.onLinkPress as (url: string) => boolean)("https://example.com")).toBe(false);
    expect(h.openURL).toHaveBeenCalledWith("https://example.com");
    expect(md.children).toEqual([TEXT]);
  });
});
