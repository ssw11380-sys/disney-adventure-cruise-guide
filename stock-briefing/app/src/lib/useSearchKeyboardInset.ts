import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, type KeyboardEvent, type KeyboardMetrics, type View } from "react-native";

/** 검색 화면만: 창이 줄지 않는 키보드는 실제로 겹친 높이만 비우고, 이미 줄어든 창은 다시 차감하지 않는다. */
export function useSearchKeyboardInset() {
  const viewportRef = useRef<View>(null);
  const keyboard = useRef<KeyboardMetrics | null>(Keyboard.metrics() ?? null);
  const alive = useRef(true);
  const measureId = useRef(0);
  const [keyboardInset, setKeyboardInset] = useState(0);

  const onViewportLayout = useCallback(() => {
    const id = ++measureId.current;
    const frame = keyboard.current;
    if (!frame || !Number.isFinite(frame.screenY) || !(frame.height > 0)) {
      setKeyboardInset(0);
      return;
    }
    // 여백을 넣는 바깥 View는 flex 높이를 유지한다. 그 안 Screen만 줄어들므로 측정/보정이 반복 차감되지 않는다.
    viewportRef.current?.measureInWindow((_x, y, _w, height) => {
      if (!alive.current || measureId.current !== id || keyboard.current !== frame) return;
      if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return;
      setKeyboardInset(Math.max(0, Math.min(height, y + height - frame.screenY)));
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    const show = (event: KeyboardEvent) => {
      keyboard.current = event.endCoordinates;
      onViewportLayout();
    };
    const hide = () => {
      keyboard.current = null;
      onViewportLayout();
    };
    const subscriptions = [
      Keyboard.addListener("keyboardDidShow", show),
      Keyboard.addListener("keyboardDidHide", hide),
      Keyboard.addListener("keyboardDidChangeFrame", show),
    ];
    // 다른 입력칸에서 이미 키보드를 연 채로 이 화면에 들어오는 경우도 처리한다.
    keyboard.current = Keyboard.metrics() ?? null;
    onViewportLayout();
    return () => {
      alive.current = false;
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [onViewportLayout]);

  return { viewportRef, keyboardInset, onViewportLayout };
}
