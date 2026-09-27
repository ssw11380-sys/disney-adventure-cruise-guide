import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, useRootNavigationState } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useFeatures } from "@/api/hooks";
import { setConnectionWording } from "@/lib/connectionError";
import { claimFirstRun, firstRunDecision, hasPriorUse, markFirstRun, readFirstRun, type FirstRunMark } from "@/lib/firstRun";
import { setHapticPolicy } from "@/lib/haptics";
import { useSettings } from "@/lib/settings";
import { emptyGuideToRemember, GuideMarksContext, UxFlagsContext, useUx, uxFlagsFrom } from "@/lib/uxFlags";

/**
 * 3-24 '한 손 조작·빈 화면·첫 실행 안내'의 루트 연결 (app/_layout 이 providers 안에 둔다).
 *  - UxFlagsProvider: 기능 플래그 세 개(oneHand·firstRun·emptyGuide)를 서버에서 받아(앱 fallback 꺼짐) 아래로 내려 준다 (lib/uxFlags).
 *    마지막으로 받은 emptyGuide 는 서버 주소와 상관없이 기기에 기억한다 (연결 오류 안내 예외가 서버의 끔을 넘지 않게)
 *  - HapticsBridge: 햅틱 규칙(플래그 · 설정 '누를 때 진동')을 lib/haptics 에 알려 준다
 *  - ConnectionWordingBridge: 연결 오류 안내가 켜졌는지를 api/client 의 401 문구에 알려 준다 (알림 창·오류 화면 모두 칸 이름 문구)
 *  - GuideMarksProvider: 한 번 닫으면 다시 보이지 않는 안내 칸 기록 (잔고 끝 '관심 종목이 없습니다')
 *  - FirstRunGate: 이 기기에서 처음 쓰는 사람에게 첫 실행 안내(/welcome)를 한 번 띄운다. 기기에 사용 흔적이 있으면 띄우지 않고 '건너뜀'으로 적는다
 */
const LAST_EMPTY_GUIDE_KEY = "ux.lastEmptyGuide";
const WATCH_HINT_KEY = "guide.watchHintClosed";

export function UxFlagsProvider({ children }: { children: React.ReactNode }) {
  // useFeature(키, false) 와 같은 규칙 (lib/features featureOn). 연결 오류 안내만: 플래그를 못 받은 채 조회가 실패하면 켠다 (lib/uxFlags)
  const features = useFeatures();
  // 마지막으로 받은 emptyGuide (undefined = 기억을 읽는 중, null = 받은 적 없음)
  const [last, setLast] = useState<boolean | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(LAST_EMPTY_GUIDE_KEY)
      .then((v) => alive && setLast((cur) => (cur !== undefined ? cur : v === "1" ? true : v === "0" ? false : null)))
      .catch(() => alive && setLast((cur) => (cur !== undefined ? cur : null)));
    return () => {
      alive = false;
    };
  }, []);
  const received = emptyGuideToRemember(features.data);
  // 받은 값은 바로 기억에 옮긴다 (렌더 중 — 이번 실행에서 주소를 바꿔 새 주소의 플래그가 없을 때도 방금 받은 값을 쓰게) + 기기에 적는다
  if (received !== undefined && received !== last) setLast(received);
  useEffect(() => {
    if (received === undefined) return;
    AsyncStorage.setItem(LAST_EMPTY_GUIDE_KEY, received ? "1" : "0").catch(() => undefined);
  }, [received]);
  const next = uxFlagsFrom(features.data, features.data === undefined && features.isError, received ?? last);
  const { oneHand, firstRun, emptyGuide, connectionGuide, flagsMissing } = next;
  const value = useMemo(() => ({ oneHand, firstRun, emptyGuide, connectionGuide, flagsMissing }), [oneHand, firstRun, emptyGuide, connectionGuide, flagsMissing]);
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

export function ConnectionWordingBridge() {
  const { connectionGuide } = useUx();
  useEffect(() => {
    setConnectionWording(connectionGuide);
  }, [connectionGuide]);
  return null;
}

export function GuideMarksProvider({ children }: { children: React.ReactNode }) {
  // 읽기 전에는 닫힌 것으로 (읽은 뒤 나타나는 것은 괜찮지만, 보였다가 사라지며 목록이 들썩이지 않게)
  const [watchHintClosed, setClosed] = useState(true);
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(WATCH_HINT_KEY)
      .then((v) => alive && setClosed(v === "1"))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const closeWatchHint = useCallback(() => {
    setClosed(true);
    AsyncStorage.setItem(WATCH_HINT_KEY, "1").catch(() => undefined);
  }, []);
  const value = useMemo(() => ({ watchHintClosed, closeWatchHint }), [watchHintClosed, closeWatchHint]);
  return <GuideMarksContext.Provider value={value}>{children}</GuideMarksContext.Provider>;
}

export function FirstRunGate() {
  const { firstRun } = useUx();
  // undefined = 아직 읽는 중, null = 기록 없음(판단 필요)
  const [mark, setMark] = useState<FirstRunMark | null | undefined>(undefined);
  // 이 기기의 사용 흔적 (undefined = 읽는 중)
  const [prior, setPrior] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!firstRun || mark !== undefined) return;
    let alive = true;
    void Promise.all([readFirstRun(), hasPriorUse()]).then(([m, p]) => {
      if (!alive) return;
      setPrior(p);
      setMark(m);
    });
    return () => {
      alive = false;
    };
  }, [firstRun, mark]);
  if (!firstRun || mark !== null) return null;
  return <FirstRunProbe prior={prior} onDone={setMark} />;
}

/** 기록이 없을 때만 붙는다: 사용 흔적으로 한 번 정한다 (정하면 부모가 이 부품을 내려 내비게이션 상태 구독도 끝난다) */
function FirstRunProbe({ prior, onDone }: { prior: boolean | undefined; onDone: (m: FirstRunMark) => void }) {
  // 루트 내비게이터가 준비된 뒤에만 화면을 연다
  const ready = !!useRootNavigationState()?.key;
  useEffect(() => {
    const d = firstRunDecision(prior);
    if (d === "existing") {
      void markFirstRun("existing");
      onDone("existing");
    } else if (d === "show" && ready) {
      onDone("seen");
      if (claimFirstRun()) router.push("/welcome");
    }
  }, [prior, ready, onDone]);
  return null;
}
