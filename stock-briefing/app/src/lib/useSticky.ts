import { useState } from "react";
import { stickyStep } from "@/lib/foldScreens";

/**
 * 창 폭에 따라 바뀌는 배치 값(칸 수, 두 칸이면 1 …)에 켜기·끄기 여유를 준다 (3-42 웨이브 E, 히스테리시스).
 * f 는 폭 → 값이고 폭이 넓을수록 크거나 같아야 한다. 바로 전 값은 이 화면(컴포넌트)이 기억한다:
 * 팝업·자유 크기 창을 끌어 기준선 근처를 오가도 값이 번갈아 바뀌지 않아, 칸 수가 바뀌면 새로 만드는 목록(FlatList key)이 스크롤 위치를 잃지 않는다.
 * 값만 돌려주므로 결과를 쓰지 않는 배치(좁은 창·플래그 꺼짐)의 화면은 전과 같다
 */
export function useSticky(width: number, f: (w: number) => number): number {
  const [prev, setPrev] = useState<number | null>(null);
  const v = stickyStep(prev, width, f);
  // 이전 렌더 값 저장 (그리는 중에 바로 반영 — effect 를 기다리지 않는다)
  if (v !== prev) setPrev(v);
  return v;
}
