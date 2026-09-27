import React from "react";
import type { FeatureFlags } from "@/api/types";
import { featureOn } from "@/lib/features";

/**
 * 3-24 '한 손 조작·빈 화면·첫 실행 안내' 기능 플래그 세 개. 서버 /api/features 에서 받고(앱 fallback 꺼짐),
 * 루트 레이아웃(components/UxBridge 의 UxFlagsProvider)이 한 번 받아 아래 화면·부품에 내려 준다 →
 * 표 줄·빈 화면·오류 화면 같은 작은 부품이 서버 조회 훅을 직접 부르지 않는다. 제공자가 없으면(테스트·예전 화면) 모두 꺼짐 = 지금 화면 그대로.
 *  - oneHand: 잔고 줄 스와이프(수정·삭제/동기화 제외, 넓은 표는 길게 누르기 메뉴) · 햅틱(설정에서 끄기) · 종목 상세 아래 고정 막대(관심·차트) · 스크롤하면 머리에 현재가
 *  - firstRun: 첫 실행 안내 한 화면(위젯 추가법·알림 권한·토스 연동 상태) · 설정 > 정보 '처음 사용 안내 다시 보기'
 *  - emptyGuide: 주요 화면 빈 상태의 안내 문구 + 행동 버튼 1개 · 연결 오류 화면의 '설정 열기'(서버 연결 칸을 펼쳐 보여 줌)와 설정 칸 이름에 맞춘 오류 문구
 */
export interface UxFlags {
  oneHand: boolean;
  firstRun: boolean;
  emptyGuide: boolean;
  /**
   * 연결 오류 안내를 쓸지: 오류 화면·끊김 띠의 '설정 열기', 칸 이름에 맞춘 오류 문구, 설정의 서버 연결 칸 펼치기와
   * 설정의 빈 칸 안내(서버에 닿지 않아 알림·토스 칸이 빔 → '서버 연결 열기').
   * = emptyGuide 켜짐, 또는 지금 주소에서 플래그를 받지 못한 채(flagsMissing) 기기가 기억한 마지막 emptyGuide 가 끔이 아닐 때
   * (서버 주소·토큰이 틀리면 플래그도 받을 수 없어 서버가 끌 수 없다 — 규칙 'fallback 꺼짐'의 의도적 예외).
   * 마지막으로 받은 값은 서버 주소와 상관없이 기억한다(lastEmptyGuide) → 서버가 끔을 준 뒤 주소를 틀리게 바꿔도 켜지지 않는다.
   * 주요 화면의 빈 상태 안내(잔고·브리핑·발견·비중)는 이 값이 아니라 emptyGuide 만 본다
   */
  connectionGuide: boolean;
  /** 지금 서버 주소에서 플래그를 한 번도 받지 못한 채 플래그 조회가 실패하는 중 (서버에 닿지 않음·주소·토큰이 틀림) */
  flagsMissing: boolean;
}

export const UX_OFF: UxFlags = Object.freeze({ oneHand: false, firstRun: false, emptyGuide: false, connectionGuide: false, flagsMissing: false });

/**
 * 받은 플래그(없으면 undefined)와 플래그 조회 실패 여부, 기기가 기억한 마지막 emptyGuide 로 (순수 함수 — 테스트용).
 * lastEmptyGuide: true/false = 마지막으로 받은 값, null = 받은 적 없음, undefined = 아직 기억을 읽는 중(예외를 켜지 않는다)
 */
export function uxFlagsFrom(flags: FeatureFlags | undefined, fetchFailed: boolean, lastEmptyGuide?: boolean | null): UxFlags {
  const emptyGuide = featureOn(flags, "emptyGuide", false);
  const flagsMissing = flags === undefined && fetchFailed;
  return {
    oneHand: featureOn(flags, "oneHand", false),
    firstRun: featureOn(flags, "firstRun", false),
    emptyGuide,
    connectionGuide: emptyGuide || (flagsMissing && lastEmptyGuide !== false && lastEmptyGuide !== undefined),
    flagsMissing,
  };
}

/** 받은 플래그에서 기억할 emptyGuide (플래그를 받지 못했으면 undefined — 기억을 바꾸지 않는다) */
export function emptyGuideToRemember(flags: FeatureFlags | undefined): boolean | undefined {
  return flags === undefined ? undefined : featureOn(flags, "emptyGuide", false);
}

export const UxFlagsContext = React.createContext<UxFlags>(UX_OFF);

export function useUx(): UxFlags {
  return React.useContext(UxFlagsContext);
}

/**
 * 한 번 닫으면 다시 보이지 않는 안내 칸 (3-24 emptyGuide, 기기에 기억 — components/UxBridge 의 GuideMarksProvider).
 *  - watchHintClosed: 잔고 목록 끝 '관심 종목이 없습니다' 칸 (보유만 있고 관심 종목이 없을 때 늘 붙던 칸 — 닫을 수 있게)
 * 제공자가 없으면(테스트) 닫지 않은 것으로 본다
 */
export interface GuideMarks {
  watchHintClosed: boolean;
  closeWatchHint: () => void;
}

export const GuideMarksContext = React.createContext<GuideMarks>({ watchHintClosed: false, closeWatchHint: () => {} });

export function useGuideMarks(): GuideMarks {
  return React.useContext(GuideMarksContext);
}
