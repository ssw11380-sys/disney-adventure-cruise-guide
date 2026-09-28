import Ionicons from "@expo/vector-icons/Ionicons";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { TossAppSheet } from "@/components/TossAppSheet";
import { TOSS_APP, TOSS_ICON, type TossAppTarget } from "@/lib/tossApp";
import { font, fontCap, slopFor, space, useTheme } from "@/theme";

/**
 * [↗ 토스 앱 열기] (3-48, 기능 플래그 tossOpen — 사용자 결정 '토스 앱만 열기'): 종목 상세 '시세' 칸 제목 줄 오른쪽의 링크 모양 작은 버튼.
 * 누르면 안내 시트(TossAppSheet)가 열리고, 시트의 [토스 앱 열기]가 토스 앱 자체를 연다 — 종목은 사용자가 토스 앱에서 직접 찾는다 (lib/tossApp).
 * 보이는 높이는 작은 글 한 줄(위아래 여백 없음 — '시세' 제목 줄 높이가 버튼이 없을 때와 같다)이고 hitSlop 을 더한 선언값은 44 (디자인 규칙 3-22).
 * 다만 아래쪽 여유가 바로 아래 형제(휴대폰 시세표 · 넓은 창 목록)와 겹치고 안드로이드는 나중에 그린 형제를 먼저 보므로,
 * 실제로 누르는 높이는 휴대폰 약 40dp(제목 줄 20 + 간격 8 → 약 4.5 겹침) · 넓은 창 약 38dp(PaneTitle 28 + 2 → 약 6.5 겹침)다 — 이미 있는 '더 보기'와 같은 방식.
 * 좌우는 이웃과 겹치지 않게 space.xs. 글은 좁은 칸·큰 글씨에서 넘치지 않고 한 줄로 줄어든다 (fontCap.chrome 까지만 커짐).
 * 시트(Modal)는 버튼 옆에 두지만 따로 뜨는 창이라 제목 줄 배치에는 끼지 않는다 (닫혀 있으면 그리지 않음)
 */
export function TossAppButton({ target }: { target: TossAppTarget }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={TOSS_APP.a11y} hitSlop={slopFor(font.small * 1.35, space.xs)} style={styles.btn}>
        <Ionicons name="open-outline" size={TOSS_ICON} color={t.accent} />
        <Text style={[styles.label, { color: t.accent }]} numberOfLines={1} maxFontSizeMultiplier={fontCap.chrome}>
          {TOSS_APP.label}
        </Text>
      </Pressable>
      {open ? <TossAppSheet target={target} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  // 제목 줄 오른쪽 끝 (PaneTitle 은 양 끝 정렬, 휴대폰 제목 줄도 같게). 좁으면 버튼이 줄어든다 — 제목은 줄지 않는다
  btn: { flexDirection: "row", alignItems: "center", gap: space.xs, marginLeft: "auto", flexShrink: 1, minWidth: 0 },
  label: { fontSize: font.small, fontWeight: "600", flexShrink: 1 },
});
