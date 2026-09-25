import { useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useFeature } from "@/api/hooks";
import { classifyWindow, foldLayoutOf, sameWindowClass, type FoldLayout, type WindowClass } from "@/lib/windowClass";

/**
 * 지금 창의 등급 (3-42). 폰을 접고 펴거나 돌리거나 팝업 창 크기를 바꾸면(useWindowDimensions) 다시 계산한다.
 * 2단·탭 막대의 켜기·끄기 폭이 다르므로(히스테리시스) 바로 전 등급을 기억해 둔다 —
 * 그리는 중에 ref 를 읽지 않도록(React 규칙) '이전 렌더 값 저장' 방식의 state 로 둔다. 등급이 같으면 같은 객체를 돌려준다
 */
export function useWindowClass(): WindowClass {
  const { width, height, fontScale } = useWindowDimensions();
  const [prev, setPrev] = useState<WindowClass | null>(null);
  const next = classifyWindow({ width, height, fontScale }, prev);
  const same = sameWindowClass(prev, next);
  if (!same) setPrev(next);
  return same && prev ? prev : next;
}

/**
 * 넓은 창 배치: 서버 플래그 foldLayout 이 켜져 있을 때만 창 등급을 따르고, 꺼져 있으면(앱 fallback 도 꺼짐)
 * 창 크기와 상관없이 휴대폰 화면 그대로(좁음·2단 없음·탭 아래)를 돌려준다
 */
export function useFoldLayout(): FoldLayout {
  const on = useFeature("foldLayout", false);
  const cls = useWindowClass();
  return useMemo(() => foldLayoutOf(on, cls), [on, cls]);
}
