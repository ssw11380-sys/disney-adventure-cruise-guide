import { useState } from "react";
import { stickyStep } from "@/lib/foldScreens";

/**
 * 창 폭에 따라 바뀌는 배치 값(칸 수, 두 칸이면 1 …)에 켜기·끄기 여유를 준다 (3-42 웨이브 E, 히스테리시스).
 * f 는 폭 → 값이고 폭이 넓을수록 크거나 같아야 한다. 바로 전 값은 이 화면(컴포넌트)이 기억한다:
 * 팝업·자유 크기 창을 끌어 기준선 근처를 오가도 값이 번갈아 바뀌지 않아, 칸 수가 바뀌면 새로 만드는 목록(FlatList key)이 스크롤 위치를 잃지 않는다.
 *
 * width 가 null 이면(넓은 배치를 쓰지 않는 좁은 창·플래그 꺼짐) 바로 전 값을 지우고 null 을 돌려준다.
 * → 접은 화면에서 펴면 처음 여는 것과 똑같이 기준선 그대로 고른다 (같은 창이면 같은 배치 — 전에 어떤 창이었는지와 상관없이).
 *   접은 화면의 폭을 기억해 두면 펴자마자 '여유만큼 더 넓어야 바꾼다'가 걸려, 같은 창인데 처음 열 때와 배치가 달라졌다
 */
export function useSticky(width: number | null, f: (w: number) => number): number | null {
  const [prev, setPrev] = useState<number | null>(null);
  const v = width === null ? null : stickyStep(prev, width, f);
  // 이전 렌더 값 저장 (그리는 중에 바로 반영 — effect 를 기다리지 않는다)
  if (v !== prev) setPrev(v);
  return v;
}
