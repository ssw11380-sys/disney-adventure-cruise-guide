import Ionicons from "@expo/vector-icons/Ionicons";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { MEMBER_NOTICE, useAccountView } from "@/lib/account";
import { font, fontCap, radius, space, useTheme } from "@/theme";

/**
 * 주인 아닌 계정의 잔고·브리핑 탭 맨 위 차분한 안내 칸 (계정 A단계). 개인 종목(보유·관심·브리핑·알림)은 다음 단계에서 열린다 —
 * 지금은 서버가 빈 값을 준다. 주인·로그인 전·플래그 꺼짐이면 아무것도 그리지 않는다
 */
export function MemberNotice() {
  const t = useTheme();
  const { member } = useAccountView();
  if (!member) return null;
  return (
    <View style={[styles.box, { backgroundColor: t.surfaceAlt, borderColor: t.line }]} accessible accessibilityRole="text" accessibilityLabel={MEMBER_NOTICE}>
      <Ionicons name="information-circle-outline" size={18} color={t.accent} />
      <Text style={{ color: t.ink, fontSize: font.small, flex: 1, lineHeight: 18 }} maxFontSizeMultiplier={fontCap.chrome}>
        {MEMBER_NOTICE}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, marginBottom: space.sm },
});
