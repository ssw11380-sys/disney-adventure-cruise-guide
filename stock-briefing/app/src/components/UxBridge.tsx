import { router, useRootNavigationState } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { useFeature, useRegisteredStocks } from "@/api/hooks";
import { claimFirstRun, firstRunDecision, markFirstRun, readFirstRun, type FirstRunMark } from "@/lib/firstRun";
import { setHapticPolicy } from "@/lib/haptics";
import { useSettings } from "@/lib/settings";
import { UxFlagsContext, useUx } from "@/lib/uxFlags";

/**
 * 3-24 '한 손 조작·빈 화면·첫 실행 안내'의 루트 연결 (app/_layout 이 providers 안에 둔다).
 *  - UxFlagsProvider: 기능 플래그 세 개(oneHand·firstRun·emptyGuide)를 서버에서 받아(앱 fallback 꺼짐) 아래로 내려 준다 (lib/uxFlags)
 *  - HapticsBridge: 햅틱 규칙(플래그 · 설정 '누를 때 진동')을 lib/haptics 에 알려 준다
 *  - FirstRunGate: 새 사용자(등록 종목 0)에게 첫 실행 안내(/welcome)를 한 번 띄운다. 이미 종목이 있으면 띄우지 않고 '건너뜀'으로 적는다
 */
export function UxFlagsProvider({ children }: { children: React.ReactNode }) {
  const oneHand = useFeature("oneHand", false);
  const firstRun = useFeature("firstRun", false);
  const emptyGuide = useFeature("emptyGuide", false);
  const value = useMemo(() => ({ oneHand, firstRun, emptyGuide }), [oneHand, firstRun, emptyGuide]);
  return <UxFlagsContext.Provider value={value}>{children}</UxFlagsContext.Provider>;
}

export function HapticsBridge() {
  const { oneHand } = useUx();
  const { haptics } = useSettings();
  useEffect(() => {
    setHapticPolicy({ oneHand, user: haptics });
  }, [oneHand, haptics]);
  return null;
}

export function FirstRunGate() {
  const { firstRun } = useUx();
  // undefined = 아직 읽는 중, null = 기록 없음(판단 필요)
  const [mark, setMark] = useState<FirstRunMark | null | undefined>(undefined);
  useEffect(() => {
    if (!firstRun || mark !== undefined) return;
    let alive = true;
    void readFirstRun().then((m) => {
      if (alive) setMark(m);
    });
    return () => {
      alive = false;
    };
  }, [firstRun, mark]);
  if (!firstRun || mark !== null) return null;
  return <FirstRunProbe onDone={setMark} />;
}

/** 등록 종목 수를 보고 한 번 정한다 (정하면 부모가 이 부품을 내려 잔고 목록 구독도 끝난다) */
function FirstRunProbe({ onDone }: { onDone: (m: FirstRunMark) => void }) {
  const stocks = useRegisteredStocks();
  // 루트 내비게이터가 준비된 뒤에만 화면을 연다
  const ready = !!useRootNavigationState()?.key;
  const count = stocks.data?.length;
  useEffect(() => {
    const d = firstRunDecision(count);
    if (d === "existing") {
      void markFirstRun("existing");
      onDone("existing");
    } else if (d === "show" && ready) {
      onDone("seen");
      if (claimFirstRun()) router.push("/welcome");
    }
  }, [count, ready, onDone]);
  return null;
}
