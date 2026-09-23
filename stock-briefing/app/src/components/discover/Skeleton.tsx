import React, { useEffect, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { space, useTheme } from "@/theme";

/** 목록을 불러오는 동안 보이는 뼈대 줄 (천천히 밝아졌다 어두워진다). height 는 실제 줄 높이와 맞춘다 */
export function SkeletonRows({ count = 10, height, rank = true }: { count?: number; height: number; rank?: boolean }) {
  const t = useTheme();
  const [pulse] = useState(() => new Animated.Value(0.45));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const bone = (w: number | `${number}%`, h = 11) => <View style={{ width: w, height: h, borderRadius: 3, backgroundColor: t.surfaceAlt }} />;
  return (
    <Animated.View style={{ opacity: pulse }} accessibilityLabel="불러오는 중">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.row, { height, borderBottomColor: t.line, backgroundColor: t.surface }]}>
          {rank ? bone(14) : null}
          <View style={{ flex: 1, gap: 6 }}>
            {bone(`${55 + ((i * 17) % 30)}%`, 13)}
            {bone(`${25 + ((i * 11) % 20)}%`, 9)}
          </View>
          <View style={{ alignItems: "flex-end", gap: 6, width: 90 }}>
            {bone(70, 13)}
            {bone(44, 9)}
          </View>
          <View style={{ alignItems: "flex-end", gap: 6, width: 76 }}>
            {bone(60, 13)}
            {bone(36, 9)}
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, borderBottomWidth: StyleSheet.hairlineWidth },
});
