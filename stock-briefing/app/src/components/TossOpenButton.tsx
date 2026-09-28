import Ionicons from "@expo/vector-icons/Ionicons";
import React from "react";
import { Alert, Linking, Pressable, StyleSheet, Text } from "react-native";
import { openTossPage, TOSS_ICON, TOSS_OPEN } from "@/lib/tossLink";
import { font, fontCap, slopFor, space, useTheme } from "@/theme";

/**
 * [↗ 토스에서 열기] (3-48, 기능 플래그 tossOpen): 종목 상세 '시세' 칸 제목 줄 오른쪽의 링크 모양 작은 버튼.
 * 누르면 토스증권 공개 종목 페이지를 연다 (lib/tossLink — 주문·로그인 없음). 못 열면 안내 창 하나.
 * 보이는 높이는 작은 글 한 줄(위아래 여백 없음 — '시세' 제목 줄 높이가 버튼이 없을 때와 같다)이고 누르는 곳은 hitSlop 으로 44 (디자인 규칙 3-22),
 * 좌우는 이웃과 겹치지 않게 space.xs. 글은 좁은 칸·큰 글씨에서 넘치지 않고 한 줄로 줄어든다 (fontCap.chrome 까지만 커짐)
 */
export function TossOpenButton({ url }: { url: string }) {
  const t = useTheme();
  const onPress = () => void openTossPage(url, { open: (u) => Linking.openURL(u), fail: (title, body) => Alert.alert(title, body) });
  return (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={TOSS_OPEN.a11y} hitSlop={slopFor(font.small * 1.35, space.xs)} style={styles.btn}>
      <Ionicons name="open-outline" size={TOSS_ICON} color={t.accent} />
      <Text style={[styles.label, { color: t.accent }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.chrome}>
        {TOSS_OPEN.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // 제목 줄 오른쪽 끝 (PaneTitle 은 양 끝 정렬, 휴대폰 제목 줄도 같게). 좁으면 버튼이 줄어든다 — 제목은 줄지 않는다
  btn: { flexDirection: "row", alignItems: "center", gap: space.xs, marginLeft: "auto", flexShrink: 1, minWidth: 0 },
  label: { fontSize: font.small, fontWeight: "600", flexShrink: 1 },
});
