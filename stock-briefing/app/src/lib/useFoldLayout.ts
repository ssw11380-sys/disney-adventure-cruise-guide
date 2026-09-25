import { useEffect, useMemo } from "react";
import { useWindowDimensions } from "react-native";
import { useFeature } from "@/api/hooks";
import { classifyWindow, foldLayoutOf, sameWindowClass, type FoldLayout, type WindowClass } from "@/lib/windowClass";

/**
 * 앱 전체가 함께 쓰는 '바로 전 창 등급' (2단·탭 막대의 켜기·끄기 폭이 다르므로 전 상태가 필요하다 — 히스테리시스).
 * 화면마다 따로 기억하면, 기준선 근처(816~839)에서 먼저 떠 있던 탭 틀은 2단·막대로, 그때 새로 연 화면은 1단으로
 * 서로 다르게 볼 수 있다 → 한 곳에 두고 모든 화면이 같은 값에서 계산한다.
 * 그리는 중에는 읽기만 하고, 화면에 반영된 뒤(effect)에 바꾼다 (한 번에 그려지는 화면들은 모두 같은 전 상태를 본다)
 */
const memory: { last: WindowClass | null } = { last: null };

/** 테스트용: 기억한 창 등급을 지운다 (앱을 새로 연 것과 같다) */
export function forgetWindowClass(): void {
  memory.last = null;
}

/**
 * 지금 창의 등급 (3-42). 폰을 접고 펴거나 돌리거나 팝업 창 크기를 바꾸면(useWindowDimensions) 다시 계산한다.
 * 등급이 같으면 같은 객체를 돌려준다 (받는 쪽이 다시 계산하지 않게)
 */
export function useWindowClass(): WindowClass {
  const { width, height, fontScale } = useWindowDimensions();
  const prev = memory.last;
  const next = classifyWindow({ width, height, fontScale }, prev);
  const cls = prev && sameWindowClass(prev, next) ? prev : next;
  useEffect(() => {
    memory.last = cls;
  }, [cls]);
  return cls;
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
