import { useIsFocused } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { takeLastViewed, type NavItem } from "@/lib/holdingsNav";
import { useTheme } from "@/theme";
import { foldDetail } from "@/tokens";

/**
 * 잔고로 돌아왔을 때 '마지막에 본 종목' 줄 표시 (3-42 웨이브 C · 설계 ‹ n/17 ›: 뒤로 1번이면 잔고로 돌아가고, 마지막에 본 줄로 스크롤해 강조).
 * 종목 상세에서 ‹ › 로 넘겨 본 경우에만 움직인다 (lib/holdingsNav takeLastViewed — ‹ › 는 기능 플래그 foldLayout 이 켜진 넓은 창에만 있다).
 * ‹ › 를 쓰지 않았으면 아무것도 하지 않아 잔고 화면은 지금 그대로다.
 *  - 잔고 화면이 다시 보일 때 한 번 읽는다. 그 줄이 자리(onLayout)를 알려 주면 목록 칸 가운데쯤으로 한 번만 스크롤한다
 *    (등락률순이면 체결마다 줄 자리가 바뀌어도 다시 스크롤하지 않는다)
 *  - 테두리 강조는 foldDetail.returnMarkMs 뒤 사라진다. 화면 읽기(TalkBack)에는 '마지막에 본 종목, 이름' 을 알린다
 */
export interface ReturnMark {
  /** 강조 중인 종목 코드 (없으면 null) */
  code: string | null;
  /** 목록 스크롤 칸의 onLayout (칸 높이를 알아야 줄을 가운데쯤 둔다) */
  onViewLayout: (e: LayoutChangeEvent) => void;
  /** 줄 하나를 감싼다: 강조할 줄이면 자리를 재는 틀 + 테두리, 아니면 받은 줄 그대로 (key 는 코드) */
  wrap: (code: string, row: React.ReactElement) => React.ReactElement;
}

/** 내비게이션 밖(테스트 등)에서는 늘 보이는 것으로 (api/hooks 의 화면 보임 판단과 같은 방식) */
function useFocusedSafe(): boolean {
  try {
    return useIsFocused();
  } catch {
    return true;
  }
}

export function useReturnMark(scrollTo: (y: number) => void): ReturnMark {
  const t = useTheme();
  const focused = useFocusedSafe();
  const [mark, setMark] = useState<NavItem | null>(null);
  const viewH = useRef(0);
  // 이번 강조에서 이미 스크롤했는지 (줄 자리가 바뀌어도 한 번만)
  const scrolled = useRef(false);
  useEffect(() => {
    if (!focused) return;
    // 화면이 다시 보인 다음 차례에 읽는다 (effect 안에서 바로 상태를 바꿔 한 번 더 그리지 않게). 그 전에 가려지면 읽지 않는다
    const id = setTimeout(() => {
      const last = takeLastViewed();
      if (!last) return;
      scrolled.current = false;
      setMark(last);
      try {
        AccessibilityInfo.announceForAccessibility(`마지막에 본 종목, ${last.name}`);
      } catch {
        // 화면 읽기 알림이 없는 환경은 건너뛴다
      }
    }, 0);
    return () => clearTimeout(id);
  }, [focused]);
  useEffect(() => {
    if (!mark) return;
    const id = setTimeout(() => setMark(null), foldDetail.returnMarkMs);
    return () => clearTimeout(id);
  }, [mark]);
  const onViewLayout = (e: LayoutChangeEvent) => {
    viewH.current = e.nativeEvent.layout.height;
  };
  const onRowLayout = (e: LayoutChangeEvent) => {
    if (scrolled.current) return;
    scrolled.current = true;
    const { y, height } = e.nativeEvent.layout;
    // 줄을 목록 칸 가운데쯤에 (위의 고정 머리글에 가리지 않게). 칸 높이를 아직 모르면 줄 위로 줄 두 개만큼 여유
    const top = viewH.current > height ? y - (viewH.current - height) / 2 : y - height * 2;
    scrollTo(Math.max(0, Math.round(top)));
  };
  const overlay: ViewStyle = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderWidth: foldDetail.returnMarkW, borderColor: t.accent };
  return {
    code: mark?.code ?? null,
    onViewLayout,
    wrap: (code, row) =>
      mark && code === mark.code ? (
        <View key={code} onLayout={onRowLayout}>
          {row}
          <View pointerEvents="none" style={overlay} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden />
        </View>
      ) : (
        row
      ),
  };
}
