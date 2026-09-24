import React, { useEffect, useState } from "react";
import { Animated, Platform, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { space, useTheme } from "@/theme";

/**
 * HTS 처럼 가격이 바뀌는 순간 배경을 잠깐 물들인다 (오르면 빨강, 내리면 파랑) — 값이 실제로 바뀔 때만.
 * react-native Animated 만 쓰므로 네이티브 모듈 추가 없이 OTA 로 배포된다.
 * 배경색 대신 뒤에 깐 색 판의 불투명도를 네이티브 드라이버로 움직인다 → 체결이 몰려도 JS 스레드를 쓰지 않는다 (3-17)
 */
export function FlashPrice({ value, text, style }: { value: number | null | undefined; text: string; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  const [anim] = useState(() => new Animated.Value(0));
  // "이전 값" 패턴: 렌더 중에 비교해서 바뀐 경우에만 방향과 깜빡임 횟수를 갱신한다
  const [prev, setPrev] = useState(value);
  const [dir, setDir] = useState<1 | -1>(1);
  const [flash, setFlash] = useState(0);
  if (value !== prev) {
    setPrev(value);
    if (value !== null && value !== undefined && prev !== null && prev !== undefined) {
      setDir(value > prev ? 1 : -1);
      setFlash((f) => f + 1);
    }
  }

  useEffect(() => {
    if (flash === 0) return;
    anim.setValue(1);
    const a = Animated.timing(anim, { toValue: 0, duration: 700, useNativeDriver: Platform.OS !== "web" });
    a.start();
    return () => a.stop();
  }, [flash, anim]);

  return (
    <View style={{ borderRadius: 4, paddingHorizontal: space.xxs, marginHorizontal: -space.xxs, overflow: "hidden" }}>
      <Animated.View style={[StyleSheet.absoluteFill, { pointerEvents: "none", backgroundColor: dir > 0 ? `${t.up}55` : `${t.down}55`, opacity: anim }]} />
      <Text style={style}>{text}</Text>
    </View>
  );
}
