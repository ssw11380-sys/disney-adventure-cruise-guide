import { Ionicons } from "@expo/vector-icons";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { haptic } from "@/lib/haptics";
import { swipeActionWidth, swipeOffset, swipePanConfig, swipeSettleOpen } from "@/lib/rowSwipe";
import { useTheme } from "@/theme";
import { font, fontCap, oneHand, space, touch } from "@/tokens";

/**
 * 잔고 줄 스와이프 (3-24, 기능 플래그 oneHand — 휴대폰·접은 화면의 잔고 목록만. 넓은 표는 길게 누르기 메뉴).
 * 줄을 왼쪽으로 한 번 밀면 오른쪽 끝에 버튼(수정 · 삭제/동기화 제외/관심 해제)이 함께 드러난다.
 *  - 가로로 14dp 움직여야 시작하고 그 전에 세로로 10dp 움직이면 포기 → 목록 스크롤 (차트 드래그와 같은 기준, lib/rowSwipe)
 *  - 줄을 누르는 것(상세 열기)·길게 누르기(메뉴)는 그대로. 줄이 밀리기 시작하면 누르기는 취소된다
 *  - 열린 줄을 누르면 닫힌다(상세를 열지 않음). 다른 줄을 열면 앞 줄은 닫힌다 (한 번에 한 줄)
 *  - 버튼은 화면 읽기에서 숨긴다: TalkBack 은 줄의 '동작'(수정 · 삭제 · 메뉴 열기)으로 같은 일을 한다 (StockRow rowActions)
 * 제스처 콜백은 JS 에서 돈다(runOnJS — 차트와 같은 방식, 새 네이티브 모듈 없음). 줄 이동은 RN Animated
 */
export interface SwipeAction {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** 지우는 버튼 (경고 색) */
  danger?: boolean;
  onPress: () => void;
}

/** 지금 열린 줄을 닫는 함수 (한 번에 한 줄만 열려 있다) */
let closeCurrent: (() => void) | null = null;
/** 열린 줄이 있으면 닫는다 (목록을 새로 그릴 때 등) */
export function closeOpenRow(): void {
  closeCurrent?.();
}

const NATIVE = Platform.OS !== "web";

export function SwipeRow({ actions, children, onLayout }: { actions: SwipeAction[]; children: React.ReactNode; onLayout?: (e: LayoutChangeEvent) => void }) {
  const t = useTheme();
  const { fontScale } = useWindowDimensions();
  const each = swipeActionWidth(fontScale);
  const width = each * actions.length;
  const [x] = useState(() => new Animated.Value(0));
  const [open, setOpen] = useState(false);
  // 버튼은 끄는 동안과 열려 있는 동안만 그린다 (닫힌 줄 수십 개에 버튼을 늘 깔아 두지 않게)
  const [shown, setShown] = useState(false);
  // 제스처 콜백이 읽는 최신 값 (제스처 객체는 한 번만 만든다 — 렌더마다 새로 만들면 진행 중인 끌기가 끊긴다)
  const box = useRef({ open: false, startOpen: false, tx0: 0, width, settle: (_o: boolean) => {} });
  useEffect(() => {
    box.current.width = width;
  }, [width]);
  useEffect(() => {
    const b = box.current;
    const close = () => b.settle(false);
    b.settle = (toOpen: boolean) => {
      const was = b.open;
      b.open = toOpen;
      if (toOpen) {
        if (closeCurrent && closeCurrent !== close) closeCurrent();
        closeCurrent = close;
        setShown(true);
        // 버튼이 새로 드러났을 때만 한 번
        if (!was) haptic("select");
      } else if (closeCurrent === close) closeCurrent = null;
      setOpen(toOpen);
      Animated.timing(x, { toValue: toOpen ? -b.width : 0, duration: oneHand.swipeSettleMs, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }).start(({ finished }) => {
        if (finished && !b.open) setShown(false);
      });
    };
    return () => {
      if (closeCurrent === close) closeCurrent = null;
    };
  }, [x]);

  /* eslint-disable react-hooks/refs -- 아래 콜백은 터치 때만 돈다 (렌더 중 ref 를 읽지 않는다) */
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetX([-swipePanConfig.activeX, swipePanConfig.activeX])
        .failOffsetY([-swipePanConfig.failY, swipePanConfig.failY])
        .maxPointers(1)
        .onStart((e) => {
          const b = box.current;
          b.startOpen = b.open;
          // 시작 조건(14dp)만큼 움직인 거리는 빼고 잰다 — 시작할 때 줄이 한꺼번에 튀지 않게 (차트 드래그와 같다)
          b.tx0 = e.translationX;
          setShown(true);
        })
        .onUpdate((e) => {
          const b = box.current;
          x.setValue(swipeOffset(e.translationX - b.tx0, b.startOpen, b.width));
        })
        .onEnd((e) => {
          const b = box.current;
          b.settle(swipeSettleOpen(e.translationX - b.tx0, e.velocityX, b.startOpen, b.width));
        }),
    [x],
  );
  /* eslint-enable react-hooks/refs */

  const close = () => box.current.settle(false);
  return (
    <View onLayout={onLayout} style={styles.wrap}>
      {shown ? (
        <View style={[styles.actions, { width }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {actions.map((a) => {
            // 청록(수정)·경고색(지우기) 바탕 위 글자: 버튼 공통 글자색 (ui Button primary·danger 와 같은 대비)
            const fg = t.accentInk;
            return (
              <Pressable
                key={a.key}
                onPress={() => {
                  close();
                  a.onPress();
                }}
                accessibilityRole="button"
                accessibilityLabel={a.label}
                style={({ pressed }) => [styles.action, { width: each, backgroundColor: a.danger ? t.danger : t.accent, opacity: pressed ? 0.8 : 1 }]}
              >
                <Ionicons name={a.icon} size={font.h2} color={fg} />
                <Text style={[styles.label, { color: fg }]} numberOfLines={2} maxFontSizeMultiplier={fontCap.row}>
                  {a.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <GestureDetector gesture={gesture}>
        <Animated.View style={{ transform: [{ translateX: x }] }}>
          {children}
          {/* 열린 줄을 누르면 닫는다 (상세를 열지 않음) */}
          {open ? <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityRole="button" accessibilityLabel="버튼 닫기" /> : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  // 밀린 줄이 화면 밖으로 삐져나가 보이지 않게
  wrap: { overflow: "hidden" },
  actions: { position: "absolute", top: 0, bottom: 0, right: 0, flexDirection: "row" },
  // 줄 높이(58 이상)를 채운다 — 최소 44
  action: { minHeight: touch.min, alignItems: "center", justifyContent: "center", gap: space.xxs, paddingHorizontal: space.xs },
  label: { fontSize: font.small, fontWeight: "700", textAlign: "center" },
});
