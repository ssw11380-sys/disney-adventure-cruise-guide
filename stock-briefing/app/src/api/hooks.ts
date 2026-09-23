import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { isTradingHoursKst } from "@/lib/format";
import { useLiveStream } from "@/lib/liveStream";
import { useSettings } from "@/lib/settings";
import { createApi, type Api } from "./client";
import type { AnalysisKind, BriefingSession, CandlePeriod, DiscoverMarket, RankCategory, ThemeKind, ThemePeriod } from "./types";

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

/** 지수 띠. 서버가 30초 캐시하므로 30초마다 */
export function useMarketIndices() {
  const api = useApi();
  return useQuery({ queryKey: useKey("indices"), queryFn: api.marketIndices, staleTime: 30_000, refetchInterval: 30_000, refetchIntervalInBackground: false, retry: 0 });
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
  const stream = useLiveStream();
  if (health.isError) return 60_000;
  // 웹소켓 스트림이 붙어 있으면 체결이 바로 캐시에 반영되므로 폴링은 보정용으로 30초에 한 번만
  if (stream.connected) return 30_000;
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

/** 발견 탭: 그 나라 장이 열려 있으면 30초, 아니면 5분마다 */
function useDiscoverInterval(market: DiscoverMarket): number {
  const m = useMarketStatus();
  const open = market === "KR" ? m.data?.KR.isOpen : m.data?.US.isOpen;
  return (open ?? true) ? 30_000 : 5 * 60_000;
}

/** 서버가 알려 준 장 상태(미국은 정규장만 장중)로 갱신 주기를 고른다. 아직 응답이 없으면 달력 기준 */
const discoverEvery = (open: boolean | undefined, fallback: number) => (open === undefined ? fallback : open ? 30_000 : 5 * 60_000);

/** 순위 목록 (거래대금·거래량·급상승·급하락). 50개씩, 끝까지 내리면 다음 쪽 */
export function useDiscoverRank(market: DiscoverMarket, category: RankCategory, size = 50) {
  const api = useApi();
  const interval = useDiscoverInterval(market);
  return useInfiniteQuery({
    queryKey: useKey("discoverRank", market, category, size),
    queryFn: ({ pageParam }) => api.discoverRank(market, category, pageParam, size),
    initialPageParam: 1,
    // 서버 상한(20쪽)과 빈 쪽에서 멈춘다 (빈 "더 보기"가 끝없이 이어지지 않게)
    getNextPageParam: (last) => (last.hasMore && last.items.length > 0 && last.page < 20 ? last.page + 1 : undefined),
    staleTime: Math.min(interval, 30_000),
    refetchInterval: (q) => discoverEvery(q.state.data?.pages[0]?.marketOpen, interval),
    refetchIntervalInBackground: false,
  });
}

/** 테마·업종 목록. 주·월 등락률은 자주 바뀌지 않아 이전 값을 두고(placeholder) 바꿔 보여 준다 */
export function useDiscoverThemes(market: DiscoverMarket, kind: ThemeKind, period: ThemePeriod) {
  const api = useApi();
  const interval = useDiscoverInterval(market);
  return useQuery({
    queryKey: useKey("discoverThemes", market, kind, period),
    queryFn: () => api.discoverThemes(market, kind, period),
    placeholderData: keepPreviousData,
    staleTime: Math.min(interval, 30_000),
    refetchInterval: (q) => discoverEvery(q.state.data?.marketOpen, interval),
    refetchIntervalInBackground: false,
  });
}

export function useDiscoverTheme(market: DiscoverMarket, kind: ThemeKind, id: string) {
  const api = useApi();
  const interval = useDiscoverInterval(market);
  return useQuery({
    queryKey: useKey("discoverTheme", market, kind, id),
    queryFn: () => api.discoverTheme(market, kind, id),
    enabled: !!id,
    staleTime: Math.min(interval, 30_000),
    refetchInterval: (q) => discoverEvery(q.state.data?.marketOpen, interval),
    refetchIntervalInBackground: false,
  });
}

/** 지수·환율 차트. 분봉은 30초마다, 일·주·월봉은 5분마다 다시 받는다 */
export function useMarketCandles(code: string, period: CandlePeriod, count: number) {
  const api = useApi();
  const intraday = period === "1m" || period === "5m" || period === "30m";
  return useQuery({
    queryKey: useKey("marketCandles", code, period, count),
    queryFn: () => api.marketCandles(code, period, count),
    enabled: !!code,
    staleTime: intraday ? 20_000 : 5 * 60_000,
    refetchInterval: intraday ? 30_000 : 5 * 60_000,
    refetchIntervalInBackground: false,
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
