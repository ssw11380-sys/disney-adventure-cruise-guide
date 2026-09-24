import React from "react";
import { StyleSheet, View, type DimensionValue } from "react-native";
import { space, useTheme } from "@/theme";

/**
 * 처음 불러오는 동안 보여 줄 뼈대 화면 (전체 화면 스피너 대신).
 * 실제 화면과 같은 자리에 회색 막대를 두어, 값이 들어와도 화면이 크게 흔들리지 않게 한다.
 */
export function Bar({ w, h = 12, style }: { w: DimensionValue; h?: number; style?: object }) {
  const t = useTheme();
  return <View style={[{ width: w, height: h, borderRadius: 3, backgroundColor: t.surfaceAlt }, style]} />;
}

function Row() {
  const t = useTheme();
  return (
    <View style={[styles.row, { borderTopColor: t.line }]}>
      <View style={{ flex: 1, gap: space.s }}>
        <Bar w="45%" h={14} />
        <Bar w="30%" h={10} />
      </View>
      <View style={{ width: 96, gap: space.s, alignItems: "flex-end" }}>
        <Bar w={72} h={14} />
        <Bar w={48} h={10} />
      </View>
      <View style={{ width: 110, gap: space.s, alignItems: "flex-end" }}>
        <Bar w={80} h={14} />
        <Bar w={52} h={10} />
      </View>
    </View>
  );
}

/** 잔고 화면: 계좌 평가 패널 + 종목 행 */
export function HoldingsSkeleton() {
  const t = useTheme();
  return (
    <View accessibilityLabel="잔고 불러오는 중" accessible accessibilityRole="progressbar" accessibilityState={{ busy: true }}>
      <View style={[styles.panel, { backgroundColor: t.surface, borderColor: t.line }]}>
        <Bar w="40%" h={12} />
        <Bar w="60%" h={28} style={{ marginTop: space.sm }} />
        <View style={{ flexDirection: "row", gap: space.lg, marginTop: space.sm }}>
          <Bar w="40%" />
          <Bar w="30%" />
        </View>
      </View>
      {Array.from({ length: 7 }, (_, i) => (
        <Row key={i} />
      ))}
    </View>
  );
}

/** 종목 상세: 시세 머리 + 차트 자리 + 표 */
export function DetailSkeleton() {
  const t = useTheme();
  return (
    <View accessibilityLabel="종목 불러오는 중" accessible accessibilityRole="progressbar" accessibilityState={{ busy: true }} style={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
      <Bar w="35%" h={12} />
      <Bar w="55%" h={34} />
      <Bar w="40%" h={14} />
      <View style={{ height: 260, borderRadius: 4, backgroundColor: t.surfaceAlt, marginTop: space.md }} />
      {Array.from({ length: 4 }, (_, i) => (
        <View key={i} style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Bar w="30%" />
          <Bar w="25%" />
        </View>
      ))}
    </View>
  );
}

/** 브리핑 목록·상세: 카드 몇 장 */
export function CardsSkeleton({ count = 3 }: { count?: number }) {
  const t = useTheme();
  return (
    <View accessibilityLabel="불러오는 중" accessible accessibilityRole="progressbar" accessibilityState={{ busy: true }} style={{ gap: space.sm, paddingTop: space.sm }}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.card, { backgroundColor: t.surface, borderColor: t.line }]}>
          <Bar w="40%" h={14} />
          <Bar w="95%" />
          <Bar w="90%" />
          <Bar w="70%" />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderBottomWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: StyleSheet.hairlineWidth },
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.sm },
});
