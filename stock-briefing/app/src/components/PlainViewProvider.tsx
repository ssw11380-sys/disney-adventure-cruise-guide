import React from "react";
import { useFeature } from "@/api/hooks";
import { PlainViewContext } from "@/lib/plainFlag";

/**
 * 군더더기 글 줄이기(플래그 plainView)를 서버에서 한 번 받아 아래로 내려 준다 (app/_layout 이 providers 안에 둔다).
 * 서버가 끄거나(FEATURE 끔) 받지 못하면 꺼짐 — 화면은 지금 그대로다
 */
export function PlainViewProvider({ children }: { children: React.ReactNode }) {
  const on = useFeature("plainView", false);
  return <PlainViewContext.Provider value={on}>{children}</PlainViewContext.Provider>;
}
