import React, { useEffect, useState } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, Text, View, type AccessibilityActionEvent, type GestureResponderEvent } from "react-native";
import type { FlowDay } from "@/api/types";
import { FLOW_NAMES } from "@/lib/flowText";
import { barHeight, barLayout, barScale, BAR_ROW_H, pickIndex } from "@/lib/flowView";
import { font, fontCap, space, touch, useTheme } from "@/theme";

const KEYS = ["individual", "foreign", "institution"] as const;
/** 막대 줄 사이 */
const ROW_GAP = space.xs;

/** 화면 읽기(TalkBack)가 켜져 있는지 — 처음 값은 비동기로 오고, 켜고 끄면 따라 바뀐다. 모르면 꺼짐 */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    let sub: { remove(): void } | undefined;
    try {
      Promise.resolve(AccessibilityInfo.isScreenReaderEnabled()).then(
        (v) => alive && setOn(v === true),
        () => undefined,
      );
      sub = AccessibilityInfo.addEventListener("screenReaderChanged", (v: boolean) => alive && setOn(v === true));
    } catch {
      // 화면 읽기 상태를 모르는 환경 — 꺼진 것으로 (누르기 그대로)
    }
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  return on;
}

/**
 * 날마다 막대 세 줄 (개인 · 외국인 · 기관 — 3-33 수급 탭). 막대 하나 = 하루, 왼쪽이 오래된 날. 세 줄은 같은 눈금(보이는 기간 |값| 최대),
 * 가운데 0선에서 위(+, 산 주식이 많음)·아래(−) — 색은 앱 공통 등락 색(빨강·파랑), 같은 뜻을 +/− 글자로도 보인다(합계·고른 날 줄).
 * 그림(react-native-svg)이 아니라 View 로 그린다 — 막대가 많아야 60개 × 세 줄이라 View 로 충분하고, 부품 테스트가 svg 가짜 없이 돈다.
 * 누르기: 막대 위 투명 칸 하나(세 줄 높이 ≥ 44)에서 누른 x 로 가장 가까운 날을 고른다 — 60일 막대가 가늘어도 누를 수 있게.
 * 화면 읽기: 칸 하나로 요약을 읽고(adjustable), 위·아래로 쓸어 날을 하나씩 옮긴다 (정확한 값은 '날짜별 숫자 보기' 표).
 * 화면 읽기가 켜져 있으면 누르기(onPress)는 받지 않는다 — 두 번 두드림은 칸 가운데를 누른 것이 되어 엉뚱한 날(가운데 날)로 옮겨 가기 때문
 */
export function FlowBars({
  days,
  width,
  labelW,
  picked,
  onPick,
  speech,
  pickedText,
}: {
  /** 오래된 날 → 최근 날 */
  days: readonly FlowDay[];
  /** 막대 칸 전체 폭 (줄 이름 칸 포함) */
  width: number;
  labelW: number;
  picked: number;
  onPick: (i: number) => void;
  speech: string;
  pickedText: string;
}) {
  const t = useTheme();
  const reader = useScreenReader();
  const area = Math.max(0, width - labelW);
  const n = days.length;
  const { slot, bar } = barLayout(area, n);
  const max = barScale(days);
  const half = BAR_ROW_H / 2;
  const radius = Math.min(2, bar / 2);
  // 누른 곳의 x (칸 기준): 안드로이드 locationX, 웹 미리보기는 DOM offsetX (없으면 가장 최근 날)
  const onPress = (e: GestureResponderEvent) => {
    const ne = e.nativeEvent as { locationX?: number; offsetX?: number };
    onPick(pickIndex(Number.isFinite(ne.locationX) ? ne.locationX : ne.offsetX, area, n));
  };
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "increment") onPick(Math.min(n - 1, picked + 1));
    if (e.nativeEvent.actionName === "decrement") onPick(Math.max(0, picked - 1));
  };
  const totalH = BAR_ROW_H * KEYS.length + ROW_GAP * (KEYS.length - 1);
  return (
    <View style={{ width, height: totalH }}>
      {KEYS.map((k, row) => (
        <View key={k} style={[styles.row, { top: row * (BAR_ROW_H + ROW_GAP) }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <View style={[styles.label, { width: labelW }]}>
            <Text style={{ color: t.sub, fontSize: font.small }} maxFontSizeMultiplier={fontCap.row} numberOfLines={1}>
              {FLOW_NAMES[k]}
            </Text>
          </View>
          <View style={{ width: area, height: BAR_ROW_H }}>
            {/* 고른 날 칸 (세 줄에 같은 자리) */}
            {n > 0 ? <View style={[styles.abs, { left: picked * slot, width: slot, top: 0, height: BAR_ROW_H, backgroundColor: t.surfaceAlt }]} /> : null}
            {/* 0선 */}
            <View style={[styles.abs, { left: 0, width: area, top: half, height: StyleSheet.hairlineWidth, backgroundColor: t.lineStrong }]} />
            {days.map((d, i) => {
              const v = d[k];
              const h = barHeight(v, max, half);
              if (!h || v === null) return null;
              const up = v > 0;
              return (
                <View
                  key={d.date}
                  testID={`flow-bar-${k}-${i}`}
                  style={[
                    styles.abs,
                    {
                      left: i * slot + (slot - bar) / 2,
                      width: bar,
                      top: up ? half - h : half,
                      height: h,
                      backgroundColor: up ? t.up : t.down,
                      ...(up ? { borderTopLeftRadius: radius, borderTopRightRadius: radius } : { borderBottomLeftRadius: radius, borderBottomRightRadius: radius }),
                    },
                  ]}
                />
              );
            })}
          </View>
        </View>
      ))}
      {/* 누르는 칸: 세 줄 전체 높이, 막대 칸 폭 */}
      <Pressable
        testID="flow-bars-press"
        onPress={reader ? undefined : onPress}
        accessibilityRole="adjustable"
        accessibilityLabel={speech}
        accessibilityValue={{ text: pickedText }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={onAction}
        style={[styles.abs, { left: labelW, top: 0, width: area, height: totalH, minHeight: touch.min }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { position: "absolute", left: 0, right: 0, height: BAR_ROW_H, flexDirection: "row" },
  label: { height: BAR_ROW_H, justifyContent: "center", paddingRight: space.sm },
  abs: { position: "absolute" },
});
