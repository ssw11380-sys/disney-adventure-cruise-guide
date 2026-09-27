import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, usePathname, useRootNavigationState } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useFeatures } from "@/api/hooks";
import { setConnectionWording } from "@/lib/connectionError";
import { autoOpenPath, claimFirstRun, firstRunDecision, hasPriorUse, markFirstRun, readFirstRun, type FirstRunMark } from "@/lib/firstRun";
import { setHapticPolicy } from "@/lib/haptics";
import { useSettings } from "@/lib/settings";
import { emptyGuideToRemember, GuideMarksContext, UxFlagsContext, useUx, uxFlagsFrom, type UxFlags } from "@/lib/uxFlags";

/**
 * 3-24 '한 손 조작·빈 화면·첫 실행 안내'의 루트 연결 (app/_layout 이 providers 안에 둔다).
 *  - UxFlagsProvider: 기능 플래그 세 개(oneHand·firstRun·emptyGuide)를 서버에서 받아(앱 fallback 꺼짐) 아래로 내려 준다 (lib/uxFlags).
 *    마지막으로 받은 emptyGuide 는 서버 주소와 상관없이 기기에 기억한다 (연결 오류 안내 예외가 서버의 끔을 넘지 않게)
 *  - HapticsBridge: 햅틱 규칙(플래그 · 설정 '누를 때 진동')을 lib/haptics 에 알려 준다
 *  - ConnectionWordingBridge: 연결 오류 안내가 켜졌는지를 api/client 의 401 문구에 알려 준다 (알림 창·오류 화면 모두 칸 이름 문구)
 *  - GuideMarksProvider: 한 번 닫으면 다시 보이지 않는 안내 칸 기록 (잔고 끝 '관심 종목이 없습니다')
 *  - FirstRunGate: 이 기기에서 처음 쓰는 사람에게 첫 실행 안내(/welcome)를 한 번 띄운다. 기기에 사용 흔적이 있으면 띄우지 않고 '건너뜀'으로 적는다.
 *    흔적은 앱을 켤 때(이 파일이 불러오는 lib/firstRun 을 불러오는 순간 — 쿼리 캐시 복원·다시 쓰기 전) 한 번 읽어 둔 값을 쓴다 (lib/firstRun bootTraces).
 *    저절로 여는 것은 탭 첫 화면에 있을 때만 (검색·종목 상세·알림으로 연 화면을 덮지 않는다)
 */
const LAST_EMPTY_GUIDE_KEY = "ux.lastEmptyGuide";
const WATCH_HINT_KEY = "guide.watchHintClosed";

export function UxFlagsProvider({ children }: { children: React.ReactNode }) {
  // useFeature(키, false) 와 같은 규칙 (lib/features featureOn). 연결 오류 안내만: 플래그를 못 받은 채 조회가 실패하면 이 기기가 마지막으로 받은 emptyGuide 를 따른다 (lib/uxFlags)
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
  const computed = uxFlagsFrom(features.data, features.data === undefined && features.isError, received ?? last);
  // 서버 주소를 바꿔 새 주소의 플래그를 받는 중(값 없음·아직 실패 아님)에는 직전 주소에서 받은 값을 그대로 둔다 →
  // 설정에서 새 주소를 저장할 때마다 켬→끔→켬으로 바뀌며 '서버 연결' 칸·두 기둥이 다시 그려지지(입력 포커스·칸 상태가 사라지지) 않게.
  // 앱을 막 켜서 아직 한 번도 받지 못했으면 직전 값이 없어 그대로(모두 꺼짐)
  const [held, setHeld] = useState<UxFlags | null>(null);
  const settled = features.data !== undefined || features.isError;
  // 받았거나 실패가 정해진 값만 기억한다 (렌더 중 — 이전 렌더 값 저장 패턴, 값이 같으면 다시 그리지 않음)
  if (settled && !sameUx(held, computed)) setHeld(computed);
  const next = !settled && held ? held : computed;
  const { oneHand, firstRun, emptyGuide, connectionGuide, flagsMissing } = next;
  const value = useMemo(() => ({ oneHand, firstRun, emptyGuide, connectionGuide, flagsMissing }), [oneHand, firstRun, emptyGuide, connectionGuide, flagsMissing]);
  return <UxFlagsContext.Provider value={value}>{children}</UxFlagsContext.Provider>;
}

const UX_KEYS = ["oneHand", "firstRun", "emptyGuide", "connectionGuide", "flagsMissing"] as const;
function sameUx(a: UxFlags | null, b: UxFlags): boolean {
  return a !== null && UX_KEYS.every((k) => a[k] === b[k]);
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
  // 루트 내비게이터가 준비된 뒤에만, 탭 첫 화면에 있을 때만 화면을 연다 (다른 화면이면 탭으로 돌아올 때까지 기다린다)
  const ready = !!useRootNavigationState()?.key;
  const onTab = autoOpenPath(usePathname());
  useEffect(() => {
    const d = firstRunDecision(prior);
    if (d === "existing") {
      void markFirstRun("existing");
      onDone("existing");
    } else if (d === "show" && ready && onTab) {
      onDone("seen");
      if (claimFirstRun()) router.push("/welcome");
    }
  }, [prior, ready, onTab, onDone]);
  return null;
}
