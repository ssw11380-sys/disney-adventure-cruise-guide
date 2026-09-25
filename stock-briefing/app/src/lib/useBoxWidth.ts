import { useCallback, useState } from "react";
import { useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { railWidth } from "@/lib/windowClass";

/**
 * 넓은 창 배치(3-42)에서 표·히트맵·설정 칸이 실제로 받은 폭. 부르는 쪽이 틀(View)에 onLayout 을 달아 잰다.
 * 재기 전이거나 창 크기가 바뀐 뒤 아직 다시 재지 못했으면 어림한다: 창 폭 − (탭 화면에 왼쪽 세로 탭 막대가 있으면) 막대 폭.
 * (플래그를 늦게 받아 onLayout 을 나중에 단 경우 레이아웃이 바뀌기 전까지 다시 재지 않을 수 있어 어림값이 맞아야 한다)
 * 발견(components/discover/shared 에서 다시 내보냄)·설정 탭이 함께 쓴다
 */
export function useBoxWidth(rail = false): [number, (e: LayoutChangeEvent) => void] {
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const estimate = width - (rail ? railWidth(fontScale) + insets.left : 0);
  // 잰 폭과 그때의 창 폭 (창이 바뀌면 잰 값은 버리고 어림한다)
  const [box, setBox] = useState<{ w: number; win: number } | null>(null);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const w = e.nativeEvent.layout.width;
      // 같은 값이면 다시 그리지 않는다
      setBox((b) => (b && b.w === w && b.win === width ? b : { w, win: width }));
    },
    [width],
  );
  return [box && box.win === width ? box.w : estimate, onLayout];
}
