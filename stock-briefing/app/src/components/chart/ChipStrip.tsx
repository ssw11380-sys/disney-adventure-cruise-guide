import { LinearGradient } from "expo-linear-gradient";
import React, { useRef, useState } from "react";
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { fadeEdges, NO_FADE, sameEdges, type FadeEdges } from "@/lib/chartLayout";
import { clearOf, slopFor, space } from "@/theme";

/** 칩의 보이는 높이 (3-22: 24 → 32). 누르는 영역은 위아래로 넓혀 44, 좌우는 칩 간격(6)의 절반만 — 이웃 칩과 겹치지 않게 */
export const CHIP_H = 32;
export const CHIP_SLOP = slopFor(CHIP_H, space.s / 2);
/** 흐려지는 가장자리 폭 */
const FADE_W = space.xl;

/**
 * 옆으로 넘기는 칩 띠 (차트의 기간·봉 수·이동평균 칩).
 *
 * 누르는 영역: 가로 스크롤 안의 칩은 스크롤 영역 밖 터치를 받지 못한다(안드로이드) → 띠를 위아래 6씩 넓혀
 * 칩 hitSlop(44)이 들어가게 하고, 같은 만큼 음수 여백을 줘서 보이는 배치(칩 줄 32)는 그대로 둔다 (3-22 리뷰).
 *
 * 끝 흐림(fade, 폴드 진단 25번): 넘길 내용이 더 있는 쪽 끝을 바탕색으로 흐리게 칠해, 반쯤 잘린 마지막 칩('30분'·'RSI')이
 * 깨진 글자가 아니라 넘길 수 있다는 표시로 보이게 한다. 넘길 수 없으면(칩이 다 보이면) 칠하지 않는다.
 * 흐린 끝에 꺾쇠(›)는 두지 않는다 — 잘린 칩 글자 위에 겹쳐 'RSI/M›'·'30분›'처럼 뭉개지고, 옆의 ‹ › 이동 버튼과 같은 모양이라 누르면
 * 넘어갈 것 같지만 누르기는 그 밑의 칩(RSI 켜기·1분봉)으로 갔다 (2026-09-26 검증).
 * backdrop 은 띠 뒤 바탕색(패널 t.surface, 전체 화면 t.bg). 스크롤 영역은 흐림을 얹는 틀을 위아래로 꽉 채운다.
 * 모든 창에서 쓴다 — 처음에는 넓은 창만이었으나 접은 화면에서도 잘린 칩이 깨져 보여(2026-09-26 RGTX 캡처) 버그 수정으로 넓혔다.
 */
export function ChipStrip({ children, backdrop, style }: { children: React.ReactNode; backdrop: string; style?: StyleProp<ViewStyle> }) {
  // 폭·내용 폭·스크롤 위치는 이벤트 때만 바뀌므로 ref 에 두고, 가장자리가 바뀔 때만 다시 그린다 (넘기는 동안 매번 그리지 않게).
  // 접고 펴서 폭이 바뀌면 onLayout 이 새 폭을 알려 다시 계산한다
  const metrics = useRef({ view: 0, content: 0, x: 0 });
  const [edges, setEdges] = useState<FadeEdges>(NO_FADE);
  const sync = (patch: Partial<{ view: number; content: number; x: number }>) => {
    Object.assign(metrics.current, patch);
    const next = fadeEdges(metrics.current);
    setEdges((prev) => (sameEdges(prev, next) ? prev : next));
  };
  return (
    <View style={[styles.chipScroll, style]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        onLayout={(e) => sync({ view: e.nativeEvent.layout.width })}
        onContentSizeChange={(w: number) => sync({ content: w })}
        onScroll={(e) => sync({ x: e.nativeEvent.contentOffset.x })}
        scrollEventThrottle={16}
      >
        {children}
      </ScrollView>
      {edges.left ? <Fade side="left" color={backdrop} /> : null}
      {edges.right ? <Fade side="right" color={backdrop} /> : null}
    </View>
  );
}

/** 가장자리 흐림: 안쪽은 투명, 바깥 끝은 바탕색. 누르기·화면 읽기는 그대로 통과시킨다 (흐림 밑의 칩은 보이는 만큼 그대로 눌린다) */
function Fade({ side, color }: { side: "left" | "right"; color: string }) {
  const clear = clearOf(color);
  const colors: readonly [string, string] = side === "right" ? [clear, color] : [color, clear];
  return (
    <LinearGradient
      colors={colors}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.fade, side === "right" ? styles.fadeRight : styles.fadeLeft]}
    />
  );
}

const styles = StyleSheet.create({
  chipScroll: { marginVertical: -CHIP_SLOP.top },
  chips: { flexDirection: "row", gap: space.s, alignItems: "center", paddingVertical: CHIP_SLOP.top },
  // 칩 줄(32) 높이에만 칠한다 (위아래로 넓힌 누르는 영역은 바탕 그대로)
  fade: { position: "absolute", top: CHIP_SLOP.top, bottom: CHIP_SLOP.top, width: FADE_W, pointerEvents: "none" },
  fadeLeft: { left: 0 },
  fadeRight: { right: 0 },
});
