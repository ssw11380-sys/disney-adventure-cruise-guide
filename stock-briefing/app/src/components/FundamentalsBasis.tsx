import React from "react";
import { Text, View } from "react-native";
import type { Quote } from "@/api/types";
import { fundamentalsBasisText } from "@/lib/fundamentalsBasis";
import { font, space, useTheme } from "@/theme";

/** 모든 상세 배치가 같은 기준 안내를 쓴다. 글씨 확대 때도 줄 수를 제한하지 않는다. */
export function FundamentalsBasis({ basis }: { basis: Quote["fundamentalsBasis"] }) {
  const t = useTheme();
  const text = fundamentalsBasisText(basis);
  if (!text) return null;
  return (
    <View style={{ marginTop: space.s, gap: space.xxs }} accessible accessibilityLabel={`${text.title}. ${text.detail}`}>
      <Text style={{ color: text.warning ? t.danger : t.muted, fontSize: font.small, fontWeight: "600" }}>{text.title}</Text>
      <Text style={{ color: t.muted, fontSize: font.tiny }}>{text.detail}</Text>
    </View>
  );
}
