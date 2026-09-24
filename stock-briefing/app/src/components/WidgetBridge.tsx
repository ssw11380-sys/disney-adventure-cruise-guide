import { useIsRestoring, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAnyMarketOpen, useApi, useMarketStatus } from "@/api/hooks";
import type { RegisteredWithQuote } from "@/api/types";
import { useSettings } from "@/lib/settings";
import { widgetPushDue } from "@/widgets/pushPolicy";
import { refreshWidgets } from "@/widgets/refresh";

/**
 * 앱 → 홈 화면 위젯 즉시 갱신 (3-16 규칙: 시세만 바뀌면 1분에 한 번, 표시 설정·장 상태가 바뀌거나 앱을 떠날 때는 바로).
 * 탭 화면이 아니라 앱 맨 위에 둔다 — 숨은 탭은 얼려 두므로(3-17 freezeOnBlur) 설정 탭에서 원화 표시를 바꾸고 홈으로 나가도 반영되게.
 * 잔고 캐시는 읽기만 한다(스스로 서버를 부르지 않음): 잔고 탭 폴링·체결 스트림이 캐시를 고치면 따라간다.
 */
export function WidgetBridge() {
  const api = useApi();
  const { apiUrl, showKrw, afterCost } = useSettings();
  const stocks = useQuery<RegisteredWithQuote[]>({ queryKey: [apiUrl, "stocks"], queryFn: api.listStocks, enabled: false });
  const data = stocks.data;
  const dataAt = stocks.dataUpdatedAt;
  const live = useAnyMarketOpen();
  const ms = useMarketStatus().data;
  const krOpen = ms?.KR.isOpen ?? false;
  const usOpen = ms?.US.isOpen ?? false;
  const market = useMemo(
    () => (live.loaded ? { label: live.label, open: live.open, nextChangeAt: null, kr: krOpen, us: usOpen } : null),
    [live.loaded, live.label, live.open, krOpen, usOpen],
  );
  // 이번 실행에서 서버에서 받은 잔고인지: 받은 시각이 앱을 연 뒤인지로 본다 (기기 저장값 복원·오프라인 실패로 옛 잔고를 넘기지 않게)
  const [mountedAt] = useState(() => Date.now());
  const restoring = useIsRestoring();
  const fetchedThisSession = !restoring && dataAt > mountedAt;
  const pushKey = `${showKrw}|${afterCost}|${market?.label ?? ""}`;
  const last = useRef({ at: 0, key: "" });
  const push = useRef<(leaving: boolean) => void>(() => undefined);
  useEffect(() => {
    push.current = (leaving: boolean) => {
      const now = Date.now();
      if (!data || !widgetPushDue({ now, fetchedThisSession, lastAt: last.current.at, lastKey: last.current.key, key: pushKey, leaving })) return;
      last.current = { at: now, key: pushKey };
      void refreshWidgets({ stocks: data, showKrw, afterCost, market });
    };
    push.current(false);
  }, [data, dataAt, pushKey, showKrw, afterCost, market, fetchedThisSession]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "background") push.current(true);
    });
    return () => sub.remove();
  }, []);
  return null;
}
