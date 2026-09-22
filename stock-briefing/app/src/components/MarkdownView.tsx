import React, { useMemo } from "react";
import { Linking } from "react-native";
import Markdown from "react-native-markdown-display";
import { font, radius, space, useTheme } from "@/theme";

/** 브리핑/분석 마크다운 렌더러. 테마 색을 스타일에 반영한다. */
export function MarkdownView({ children }: { children: string }) {
  const t = useTheme();
  const style = useMemo(
    () => ({
      body: { color: t.ink, fontSize: font.body, lineHeight: 23 },
      heading1: { color: t.ink, fontSize: 20, fontWeight: "700" as const, marginTop: space.lg, marginBottom: space.sm },
      heading2: { color: t.ink, fontSize: font.h2, fontWeight: "700" as const, marginTop: space.lg, marginBottom: space.xs },
      heading3: { color: t.ink, fontSize: font.body, fontWeight: "700" as const, marginTop: space.md },
      paragraph: { marginTop: 0, marginBottom: space.sm },
      bullet_list: { marginBottom: space.sm },
      ordered_list: { marginBottom: space.sm },
      list_item: { marginBottom: 2 },
      strong: { fontWeight: "700" as const },
      code_inline: { backgroundColor: t.code, color: t.ink, borderRadius: 4, paddingHorizontal: 4 },
      code_block: { backgroundColor: t.code, color: t.ink, borderRadius: radius.sm, padding: space.md, borderWidth: 0 },
      fence: { backgroundColor: t.code, color: t.ink, borderRadius: radius.sm, padding: space.md, borderWidth: 0 },
      blockquote: { backgroundColor: t.surfaceAlt, borderLeftColor: t.accent, borderLeftWidth: 3, paddingLeft: space.md, marginBottom: space.sm },
      hr: { backgroundColor: t.line, height: 1, marginVertical: space.md },
      table: { borderColor: t.line, borderWidth: 1, borderRadius: radius.sm, marginBottom: space.md },
      thead: { backgroundColor: t.surfaceAlt },
      th: { padding: 6, color: t.ink, fontWeight: "700" as const },
      tr: { borderBottomColor: t.line, borderBottomWidth: 1 },
      td: { padding: 6, color: t.ink },
      link: { color: t.accent, textDecorationLine: "underline" as const },
    }),
    [t],
  );
  return (
    <Markdown
      style={style}
      onLinkPress={(url) => {
        void Linking.openURL(url);
        return false;
      }}
    >
      {children}
    </Markdown>
  );
}
