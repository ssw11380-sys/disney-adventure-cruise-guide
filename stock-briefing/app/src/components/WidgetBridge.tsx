import { useIsRestoring, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAnyMarketOpen, useApi, useMarketStatus } from "@/api/hooks";
import type { FeatureFlags, MarketIndex, RegisteredWithQuote } from "@/api/types";
import { useSettings } from "@/lib/settings";
import { pickBoard, pickWidgetIndices, widgetFeatures } from "@/widgets/payload";
import { widgetPushDue } from "@/widgets/pushPolicy";
import { refreshWidgets } from "@/widgets/refresh";

/**
 * 앱 → 홈 화면 위젯 즉시 갱신 (3-16 규칙: 시세만 바뀌면 1분에 한 번, 표시 설정·장 상태가 바뀌거나 앱을 떠날 때는 바로).
 * 탭 화면이 아니라 앱 맨 위에 둔다 — 숨은 탭은 얼려 두므로(3-17 freezeOnBlur) 설정 탭에서 원화 표시를 바꾸고 홈으로 나가도 반영되게.
 * 잔고·지수·기능 플래그 캐시는 읽기만 한다(스스로 서버를 부르지 않음): 잔고 탭 폴링·체결 스트림·지수 띠가 캐시를 고치면 따라간다.
 * 지수·플래그 캐시는 기기에 며칠 남은 옛 값일 수 있어(플래그는 브리핑·설정 화면에서만 다시 받는다) 받은 시각을 함께 넘기고,
 * 위젯이 받아 둔 /api/widget 응답이 더 새것이면 그쪽을 쓴다 (data.ts pushWidgetData)
 */
export function WidgetBridge() {
  const api = useApi();
  const { apiUrl, showKrw, afterCost } = useSettings();
  const stocks = useQuery<RegisteredWithQuote[]>({ queryKey: [apiUrl, "stocks"], queryFn: api.listStocks, enabled: false });
  const data = stocks.data;
  const dataAt = stocks.dataUpdatedAt;
  // 위젯 손익 전환·지수 줄 플래그와 지수 띠 값 (앱이 받은 것과 받은 시각. 위젯이 받아 둔 것이 더 새것이면 그쪽)
  const flagsQ = useQuery<FeatureFlags>({ queryKey: [apiUrl, "features"], queryFn: api.features, enabled: false });
  const flags = flagsQ.data;
  const flagsAt = flagsQ.dataUpdatedAt;
  const idx = useQuery<{ indices: MarketIndex[] }>({ queryKey: [apiUrl, "indices"], queryFn: api.marketIndices, enabled: false });
  const features = useMemo(() => (flags ? { at: flagsAt, flags: widgetFeatures(flags.features) } : null), [flags, flagsAt]);
  const idxList = idx.data?.indices;
  const idxAt = idx.dataUpdatedAt;
  const indices = useMemo(() => (idxList ? { at: idxAt, list: pickWidgetIndices(idxList) } : null), [idxList, idxAt]);
  // 지수·환율 위젯 판: 같은 지수 띠 9개 (앱이 새 지수를 받으면 위젯도 같은 숫자로)
  const board = useMemo(() => (idxList ? { at: idxAt, list: pickBoard(idxList) } : null), [idxList, idxAt]);
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
  // 플래그가 바뀌어도 바로 (손익 전환·지수 줄이 켜지고 꺼지는 것을 1분 기다리지 않게)
  const pushKey = `${showKrw}|${afterCost}|${market?.label ?? ""}|${features ? `${features.flags.pnlToggle}|${features.flags.indexLine}|${features.flags.market}` : ""}`;
  const last = useRef({ at: 0, key: "" });
  const push = useRef<(leaving: boolean) => void>(() => undefined);
  useEffect(() => {
    push.current = (leaving: boolean) => {
      const now = Date.now();
      if (!data || !widgetPushDue({ now, fetchedThisSession, lastAt: last.current.at, lastKey: last.current.key, key: pushKey, leaving })) return;
      last.current = { at: now, key: pushKey };
      void refreshWidgets({ stocks: data, showKrw, afterCost, market, features, indices, board });
    };
    push.current(false);
  }, [data, dataAt, pushKey, showKrw, afterCost, market, fetchedThisSession, features, indices, board]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "background") push.current(true);
    });
    return () => sub.remove();
  }, []);
  return null;
}
