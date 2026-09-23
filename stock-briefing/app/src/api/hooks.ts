import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { isTradingHoursKst } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { createApi, type Api } from "./client";
import type { AnalysisKind, BriefingSession, CandlePeriod } from "./types";

export function useApi(): Api {
  const { apiUrl, apiToken } = useSettings();
  return useMemo(() => createApi(apiUrl, apiToken), [apiUrl, apiToken]);
}

/** 쿼리 키에 apiUrl 을 넣어 서버 주소를 바꾸면 캐시가 분리되게 한다 */
function useKey(...parts: unknown[]) {
  const { apiUrl } = useSettings();
  return [apiUrl, ...parts];
}

export function useHealth() {
  const api = useApi();
  return useQuery({ queryKey: useKey("health"), queryFn: api.health, staleTime: 30_000, retry: 0 });
}

/** 장 운영 상태 (서버가 토스 달력으로 판단, 5분 캐시). 실패하면 요일·시간 추정 */
export function useMarketStatus() {
  const api = useApi();
  return useQuery({ queryKey: useKey("market"), queryFn: api.marketStatus, staleTime: 5 * 60_000, refetchInterval: 5 * 60_000, retry: 0 });
}

/** 한국·미국 중 하나라도 거래 중이면 true. 서버 상태가 없으면 시간 기반 추정 */
export function useAnyMarketOpen(): { open: boolean; label: string; loaded: boolean } {
  const m = useMarketStatus();
  if (!m.data) return { open: isTradingHoursKst(), label: isTradingHoursKst() ? "실시간" : "장 마감", loaded: false };
  const kr = m.data.KR, us = m.data.US;
  if (kr.isOpen || us.isOpen) return { open: true, label: kr.isOpen && us.isOpen ? "실시간" : kr.isOpen ? "한국 장중" : "미국 장중", loaded: true };
  if (!kr.isTradingDay && !us.isTradingDay) return { open: false, label: "휴장", loaded: true };
  if (!kr.isTradingDay) return { open: false, label: "한국 휴장", loaded: true };
  return { open: false, label: "장 마감", loaded: true };
}

/**
 * 현재가 갱신 주기. 서버가 등록 종목 시세를 한 번에 받아(토스 웹 2초 캐시 / Open API 웹소켓) 돌려주므로
 * 장 시간에는 3초마다 다시 받아 HTS 처럼 움직이게 하고, 장이 닫힌 시간에는 1분으로 늦춘다.
 */
export function useLiveInterval(): number {
  const health = useHealth();
  const { open } = useAnyMarketOpen();
  if (health.isError) return 60_000;
  return open ? 3_000 : 60_000;
}

export function useStocks() {
  const api = useApi();
  const interval = useLiveInterval();
  return useQuery({ queryKey: useKey("stocks"), queryFn: api.listStocks, staleTime: Math.min(interval, 30_000), refetchInterval: interval, refetchIntervalInBackground: false });
}

export function useStock(code: string) {
  const api = useApi();
  const interval = useLiveInterval();
  return useQuery({ queryKey: useKey("stock", code), queryFn: () => api.getStock(code), staleTime: Math.min(interval, 30_000), refetchInterval: interval, refetchIntervalInBackground: false, enabled: !!code });
}

export function useTossStatus() {
  const api = useApi();
  return useQuery({ queryKey: useKey("tossStatus"), queryFn: api.tossStatus, staleTime: 30_000, retry: 0 });
}

export function useSearch(q: string) {
  const api = useApi();
  const query = q.trim();
  return useQuery({
    queryKey: useKey("search", query),
    queryFn: () => api.searchStocks(query),
    enabled: query.length > 0,
    staleTime: 5 * 60_000,
  });
}

export function useCandles(code: string, period: CandlePeriod, count = 90) {
  const api = useApi();
  return useQuery({ queryKey: useKey("candles", code, period, count), queryFn: () => api.getCandles(code, period, count), staleTime: 5 * 60_000 });
}

export function useAnalysis(code: string, kind: AnalysisKind, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: useKey("analysis", code, kind),
    queryFn: () => api.getAnalysis(code, kind),
    enabled,
    staleTime: 10 * 60_000,
    retry: 0,
  });
}

export function useStockNews(code: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: useKey("news", code), queryFn: () => api.getStockNews(code), enabled, staleTime: 5 * 60_000 });
}

export function useLatestBriefings() {
  const api = useApi();
  return useQuery({ queryKey: useKey("briefings", "latest"), queryFn: api.latestBriefings, staleTime: 30_000 });
}

export function useBriefings(filter: { code?: string; date?: string; session?: BriefingSession; limit?: number }) {
  const api = useApi();
  return useQuery({ queryKey: useKey("briefings", "list", filter), queryFn: () => api.listBriefings(filter), staleTime: 30_000 });
}

export function useBriefing(id: number) {
  const api = useApi();
  return useQuery({ queryKey: useKey("briefing", id), queryFn: () => api.getBriefing(id), enabled: Number.isFinite(id) && id > 0 });
}

export function useNotificationSettings() {
  const api = useApi();
  return useQuery({ queryKey: useKey("notificationSettings"), queryFn: api.getNotificationSettings, staleTime: 30_000, retry: 0 });
}

export function useDevices() {
  const api = useApi();
  return useQuery({ queryKey: useKey("devices"), queryFn: api.listDevices, staleTime: 30_000, retry: 0 });
}

export function useNotificationMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const { apiUrl } = useSettings();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: [apiUrl, "notificationSettings"] });
    void qc.invalidateQueries({ queryKey: [apiUrl, "devices"] });
    void qc.invalidateQueries({ queryKey: [apiUrl, "health"] });
  };
  return {
    updateSettings: useMutation({
      mutationFn: api.updateNotificationSettings,
      onSuccess: (data) => {
        qc.setQueryData([apiUrl, "notificationSettings"], data);
        invalidate();
      },
    }),
    sendTest: useMutation({ mutationFn: api.sendTestNotification, onSuccess: invalidate }),
    invalidate,
  };
}

/** 종목 등록/수정/삭제, 브리핑 실행 뮤테이션. 성공 시 관련 쿼리를 무효화한다. */
export function useStockMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const { apiUrl } = useSettings();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: [apiUrl, "stocks"] });
    void qc.invalidateQueries({ queryKey: [apiUrl, "briefings"] });
  };
  return {
    register: useMutation({ mutationFn: api.registerStock, onSuccess: invalidate }),
    update: useMutation({
      mutationFn: ({ code, ...body }: { code: string; quantity?: number | null; avgPrice?: number | null; memo?: string | null }) => api.updateStock(code, body),
      onSuccess: (_d, v) => {
        invalidate();
        void qc.invalidateQueries({ queryKey: [apiUrl, "stock", v.code] });
      },
    }),
    remove: useMutation({ mutationFn: api.removeStock, onSuccess: invalidate }),
    run: useMutation({
      mutationFn: ({ session, codes, force }: { session: BriefingSession; codes?: string[]; force?: boolean }) => api.runBriefings(session, codes, force),
      onSuccess: invalidate,
    }),
    refreshAnalysis: useMutation({
      mutationFn: ({ code, kind }: { code: string; kind: AnalysisKind }) => api.getAnalysis(code, kind, true),
      onSuccess: (data) => qc.setQueryData([apiUrl, "analysis", data.code, data.kind], data),
    }),
  };
}
