import Ionicons from "@expo/vector-icons/Ionicons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ALERT_TEXT, hitBody, hitSpeech, hitTitle, type Hit } from "@/lib/priceAlerts";
import { font, fontCap, radius, space, touch, useTheme } from "@/theme";
import { priceAlert } from "@/tokens";

/**
 * 화면 위 가격 알림 카드 (3-29, 플래그 priceAlerts — 속성만 받는다, 루트의 PriceAlertProvider 가 그린다).
 * 모든 화면 위(위쪽 안전 영역 + space.sm 아래), 최대 폭 priceAlert.bannerMaxW (펼친 화면은 가운데). 최신부터 3줄, 넘치면 '외 N건'.
 * 줄을 누르면 그 종목 상세, 닫기는 모두 닫음. 화면 읽기는 제공자가 알릴 때 한 번 읽는다 — 카드에는 accessibilityLiveRegion 을 두지 않는다
 * (둘을 함께 쓰면 TalkBack 이 같은 알림을 두 번 읽을 수 있다). 줄·닫기 이름표는 손가락으로 짚으면 읽힌다
 */
export function PriceAlertBanner({ hits, onOpen, onClose }: { hits: Hit[]; onOpen: (code: string) => void; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  if (!hits.length) return null;
  const shown = hits.slice(0, priceAlert.bannerRows);
  const more = hits.length - shown.length;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + space.sm, left: insets.left + space.md, right: insets.right + space.md }]}>
      <View style={[styles.card, { backgroundColor: t.surfaceAlt, borderColor: t.lineStrong, shadowColor: t.shadow }]}>
        <View style={styles.head}>
          <Ionicons name="notifications" size={font.body} color={t.gold} />
          <Text style={[styles.headText, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
            {ALERT_TEXT.bannerHead}
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="가격 알림 닫기" style={styles.close}>
            <Ionicons name="close" size={font.title} color={t.sub} />
          </Pressable>
        </View>
        {shown.map((h) => (
          <Pressable
            key={`${h.rule.id}|${h.date}`}
            onPress={() => onOpen(h.code)}
            accessibilityRole="button"
            accessibilityLabel={hitSpeech(h)}
            accessibilityHint="종목 화면 열기"
            style={({ pressed }) => [styles.row, { borderTopColor: t.line, opacity: pressed ? 0.75 : 1 }]}
          >
            <Text style={[styles.title, { color: t.ink }]} numberOfLines={2} maxFontSizeMultiplier={fontCap.row}>
              {hitTitle(h)}
            </Text>
            <Text style={[styles.body, { color: t.sub }]} numberOfLines={2} maxFontSizeMultiplier={fontCap.row}>
              {hitBody(h)}
            </Text>
          </Pressable>
        ))}
        {more > 0 ? (
          <Text style={[styles.more, { color: t.muted }]} maxFontSizeMultiplier={fontCap.row}>
            {`외 ${more}건`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", alignItems: "center" },
  card: { width: "100%", maxWidth: priceAlert.bannerMaxW, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: space.md, paddingBottom: space.sm, elevation: 6, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  head: { flexDirection: "row", alignItems: "center", gap: space.xs },
  headText: { flex: 1, fontSize: font.small },
  close: { width: touch.min, minHeight: touch.min, alignItems: "center", justifyContent: "center", marginRight: -space.md },
  row: { minHeight: touch.min, justifyContent: "center", paddingVertical: space.s, gap: space.xxs, borderTopWidth: StyleSheet.hairlineWidth },
  title: { fontSize: font.body, fontWeight: "700" },
  body: { fontSize: font.small, fontVariant: ["tabular-nums"] },
  more: { fontSize: font.small, paddingTop: space.xs },
});
