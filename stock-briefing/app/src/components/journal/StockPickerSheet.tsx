import Ionicons from "@expo/vector-icons/Ionicons";
import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { JOURNAL } from "@/lib/journal";
import { font, radius, space, touch, useTheme } from "@/theme";

/**
 * '종목 고르기' 창 (3-37 매매일지 기록 탭): 기간 안에 체결이 있는 종목만, 건수 많은 순(서버 순서 그대로). 맨 위 '모든 종목'.
 * 휴대폰은 아래에 붙이고 넓은 창은 가운데 (최대 560dp — 다른 시트와 같은 폭)
 */
export function StockPickerSheet({ stocks, value, onPick, onClose }: { stocks: { code: string; name: string; count: number }[]; value: string | null; onPick: (code: string | null) => void; onClose: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const item = (code: string | null, label: string) => {
    const on = value === code;
    return (
      <Pressable
        key={code ?? "all"}
        onPress={() => onPick(code)}
        accessibilityRole="radio"
        accessibilityLabel={label}
        accessibilityState={{ checked: on }}
        style={({ pressed }) => [styles.item, { borderTopColor: t.line, backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
      >
        <Text style={{ color: on ? t.accent : t.ink, fontSize: font.body, fontWeight: on ? "700" : "400", flex: 1 }}>{label}</Text>
        {on ? <Ionicons name="checkmark" size={font.h2} color={t.accent} /> : null}
      </Pressable>
    );
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: t.scrim }]} onPress={onClose} accessibilityRole="button" accessibilityLabel={`${JOURNAL.pickStock} ${JOURNAL.close}`} />
        <View style={[styles.sheet, { backgroundColor: t.surface, borderColor: t.lineStrong, paddingBottom: insets.bottom + space.sm }]}>
          <Text style={{ color: t.muted, fontSize: font.small, paddingHorizontal: space.lg, paddingVertical: space.sm }} accessibilityRole="header">
            {JOURNAL.pickStock}
          </Text>
          <ScrollView style={styles.list}>
            {item(null, JOURNAL.allStocks)}
            {stocks.map((s) => item(s.code, `${s.name} · ${s.count}건`))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", alignItems: "center" },
  sheet: { width: "100%", maxWidth: 560, maxHeight: "80%", borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  list: { flexGrow: 0 },
  item: { minHeight: touch.min, flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth },
});
