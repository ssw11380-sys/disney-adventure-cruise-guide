import { useEffect } from "react";
import { AppState } from "react-native";
import { useApi, useFeature } from "@/api/hooks";
import { useAccountView } from "@/lib/account";
import { isLocalModeEnabled } from "@/lib/backgroundBriefings";
import { notifyFilings } from "@/lib/filingNotify";
import { ensureFilingChannel } from "@/lib/notifications";
import { useSettings } from "@/lib/settings";
import { loadNotifyPrefs } from "@/widgets/data";

/** 앱이 앞에 있는 동안 확인 간격 */
export const FOREGROUND_CHECK_MS = 5 * 60_000;
/** 마지막 확인이 이 안이면 건너뜀 (앞으로 올 때 · 주기가 겹쳐도 한 번) */
export const FOREGROUND_SKIP_MS = 4 * 60_000;

let lastRun = Number.NEGATIVE_INFINITY;

/** 테스트용: 마지막 확인 시각을 지운다 */
export function forgetFilingForeground(): void {
  lastRun = Number.NEGATIVE_INFINITY;
}

/**
 * 앱이 앞에 있을 때의 새 공시 확인 (3-38, 플래그 filingAlerts): 앱이 앞으로 올 때와 앞에 있는 동안 5분마다 /api/filings/alerts → 알림 규칙
 * (lib/filingNotify — 백그라운드 확인과 같은 기록·잠금이라 두 번 울리지 않는다). '브리핑 알림' 로컬 모드일 때만 (서버 푸시 기기는 서버가 보낼 몫).
 * 권한이 없으면 알림 규칙이 아무것도 적지 않는다. 플래그가 꺼져 있거나 모르면 아무 요청도 하지 않는다.
 * 주인 아닌 계정(계정 A단계)은 주인의 보유 종목 공시를 묻지 않는다 (가격 사건 알림 MovementAlertBridge 와 같은 규칙)
 */
export function FilingAlertBridge() {
  const on = useFeature("filingAlerts", false);
  const { ready } = useSettings();
  const api = useApi();
  const { member } = useAccountView();
  useEffect(() => {
    if (!on || !ready || member) return;
    let alive = true;
    const run = async () => {
      const now = Date.now();
      if (now - lastRun < FOREGROUND_SKIP_MS) return;
      if (!(await isLocalModeEnabled())) return;
      lastRun = now;
      try {
        await ensureFilingChannel();
        const prefs = await loadNotifyPrefs();
        if (!prefs || !alive) return;
        const r = await api.filingAlerts();
        if (!alive || !Array.isArray(r?.items)) return;
        await notifyFilings(r.items, { prefs });
      } catch {
        /* 다음 확인에서 다시 (끊김·예전 서버 404) */
      }
    };
    void run();
    const timer = setInterval(() => void run(), FOREGROUND_CHECK_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void run();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [on, ready, member, api]);
  return null;
}
