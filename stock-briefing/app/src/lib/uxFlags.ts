import React from "react";

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
}

export const UX_OFF: UxFlags = Object.freeze({ oneHand: false, firstRun: false, emptyGuide: false });

export const UxFlagsContext = React.createContext<UxFlags>(UX_OFF);

export function useUx(): UxFlags {
  return React.useContext(UxFlagsContext);
}
