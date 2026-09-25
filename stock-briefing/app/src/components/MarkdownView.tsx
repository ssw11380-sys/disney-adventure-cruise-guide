import React, { useMemo } from "react";
import { Linking } from "react-native";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import { font, radius, space, useTheme } from "@/theme";

/** 본문 속 링크는 밖(브라우저)에서 연다. 모듈 상수라 다시 그려도 같은 함수다 */
function openLink(url: string): boolean {
  void Linking.openURL(url);
  return false;
}

/** 마크다운 해석기 (라이브러리 기본값과 같은 설정). 그릴 때마다 새로 만들지 않게 한 번만 만든다 */
const PARSER = MarkdownIt({ typographer: true });

/**
 * 브리핑/분석 마크다운 렌더러. 테마 색을 스타일에 반영한다.
 * Markdown 은 React.memo 라 속성(글·스타일·링크 함수·해석기)이 같으면 다시 해석하지 않는다 → 속성을 모두 고정 값으로 넘긴다
 * (넓은 창 브리핑 탭처럼 체결이 올 때마다 부모가 다시 그려져도 본문 마크다운은 다시 읽고 그리지 않게, 3-42)
 */
export function MarkdownView({ children }: { children: string }) {
  const t = useTheme();
  const style = useMemo(
    () => ({
      body: { color: t.ink, fontSize: font.body, lineHeight: 23 },
      heading1: { color: t.ink, fontSize: font.title, fontWeight: "700" as const, marginTop: space.lg, marginBottom: space.sm },
      heading2: { color: t.ink, fontSize: font.h2, fontWeight: "700" as const, marginTop: space.lg, marginBottom: space.xs },
      heading3: { color: t.ink, fontSize: font.body, fontWeight: "700" as const, marginTop: space.md },
      paragraph: { marginTop: 0, marginBottom: space.sm },
      bullet_list: { marginBottom: space.sm },
      ordered_list: { marginBottom: space.sm },
      list_item: { marginBottom: space.xxs },
      strong: { fontWeight: "700" as const },
      code_inline: { backgroundColor: t.code, color: t.ink, borderRadius: 4, paddingHorizontal: space.xs },
      code_block: { backgroundColor: t.code, color: t.ink, borderRadius: radius.sm, padding: space.md, borderWidth: 0 },
      fence: { backgroundColor: t.code, color: t.ink, borderRadius: radius.sm, padding: space.md, borderWidth: 0 },
      blockquote: { backgroundColor: t.surfaceAlt, borderLeftColor: t.accent, borderLeftWidth: 3, paddingLeft: space.md, marginBottom: space.sm },
      hr: { backgroundColor: t.line, height: 1, marginVertical: space.md },
      table: { borderColor: t.line, borderWidth: 1, borderRadius: radius.sm, marginBottom: space.md },
      thead: { backgroundColor: t.surfaceAlt },
      th: { padding: space.s, color: t.ink, fontWeight: "700" as const },
      tr: { borderBottomColor: t.line, borderBottomWidth: 1 },
      td: { padding: space.s, color: t.ink },
      link: { color: t.accent, textDecorationLine: "underline" as const },
    }),
    [t],
  );
  return (
    <Markdown style={style} onLinkPress={openLink} markdownit={PARSER}>
      {children}
    </Markdown>
  );
}
