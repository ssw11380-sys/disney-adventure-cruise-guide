import React from "react";

/**
 * 군더더기 글 줄이기 (2026-11-12, 기능 플래그 plainView — 서버 /api/features, 앱 fallback 꺼짐)가 켜졌는지.
 * 루트 레이아웃(components/PlainViewProvider)이 한 번 받아 아래 화면·부품에 내려 준다 →
 * 카드·줄 같은 작은 부품이 서버 조회 훅을 직접 부르지 않는다 (lib/uxFlags 와 같은 방식).
 * 제공자가 없으면(테스트·예전 화면) 꺼짐 = 지금 화면 그대로. 켰을 때의 글은 lib/plainView 에 모았다
 */
export const PlainViewContext = React.createContext(false);

export function usePlain(): boolean {
  return React.useContext(PlainViewContext);
}
