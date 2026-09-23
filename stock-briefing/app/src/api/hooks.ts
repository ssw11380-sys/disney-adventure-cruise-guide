import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type Query } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { isTradingHoursKst } from "@/lib/format";
import { pollInterval, streamFresh } from "@/lib/freshness";
import { useLiveStream } from "@/lib/liveStream";
import { loadedCredentials, useSettings } from "@/lib/settings";
import { createApi, type Api } from "./client";
import type { AnalysisKind, BriefingSession, CandlePeriod, DiscoverMarket, DiscoverRank, RankCategory, ThemeKind, ThemePeriod } from "./types";

export function useApi(): Api {
  const { apiUrl, apiToken, ready } = useSettings();
  return useMemo(() => (ready ? createApi(apiUrl, apiToken) : deferredApi()), [apiUrl, apiToken, ready]);
}

/** 저장된 서버 주소·토큰을 읽기 전의 API: 요청마다 읽기가 끝나길 기다렸다가 그 값으로 보낸다 */
function deferredApi(): Api {
  const shape = createApi("", "");
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(shape)) {
    out[name] =
      typeof v === "function"
        ? (...args: unknown[]) =>
            loadedCredentials().then((c) => (createApi(c.apiUrl, c.apiToken) as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(...args))
        : v;
  }
  return out as unknown as Api;
}

/** 쿼리 키에 apiUrl 을 넣어 서버 주소를 바꾸면 캐시가 분리되게 한다 */
function useKey(...parts: unknown[]) {
  const { apiUrl } = useSettings();
  return [apiUrl, ...parts];
}

export function useHealth() {
  const api = useApi();
  // 한 번 실패해도 1분 뒤 다시 확인한다 (예전에는 실패 상태로 굳어 시세 갱신이 1분 주기에 묶였다)
  return useQuery({ queryKey: useKey("health"), queryFn: api.health, staleTime: 30_000, retry: 0, refetchInterval: 60_000, refetchIntervalInBackground: false });
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
 * 체결 스트림이 값을 주는 동안은 보정용 30초, 요청이 실패하는 동안은 짧게 다시 시도한다 (규칙은 lib/freshness 의 pollInterval).
 * 쿼리마다 실패 여부가 다르므로 react-query 의 함수형 refetchInterval 로 넘긴다.
 */
export function useLivePoll(): (q: Query<any, any, any, any>) => number {
  const { open } = useAnyMarketOpen();
  const stream = useLiveStream();
  return (q) =>
    pollInterval({
      open,
      streamFresh: streamFresh(stream, Date.now()),
      failing: q.state.status === "error" || q.state.fetchFailureCount > 0,
    });
}

export function useStocks() {
  const api = useApi();
  const every = useLivePoll();
  return useQuery({ queryKey: useKey("stocks"), queryFn: api.listStocks, staleTime: 2_000, refetchInterval: every, refetchIntervalInBackground: false, retryDelay: 1_000 });
}

export function useStock(code: string) {
  const api = useApi();
  const every = useLivePoll();
  return useQuery({ queryKey: useKey("stock", code), queryFn: () => api.getStock(code), staleTime: 2_000, refetchInterval: every, refetchIntervalInBackground: false, retryDelay: 1_000, enabled: !!code });
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
/** 자동 갱신은 앞쪽 몇 쪽을 볼 때만 — 깊이 내려 두면 갱신마다 받아 둔 쪽을 모두 다시 받게 되므로 멈춘다(당겨서 새로고침은 그대로) */
export const AUTO_REFRESH_MAX_PAGES = 3;
type RankPageParam = { page: number; ver?: number };

export function useDiscoverRank(market: DiscoverMarket, category: RankCategory, size = 50) {
  const api = useApi();
  const qc = useQueryClient();
  const { apiUrl } = useSettings();
  const interval = useDiscoverInterval(market);
  // 목록을 떠나면 첫 쪽만 남긴다 — 돌아왔을 때 깊이 내려 두었던 쪽을 모두 다시 받지 않게.
  // 받는 중인 다음 쪽·자동 갱신은 먼저 취소하고(늦게 온 응답이 잘라 둔 쪽을 되살리지 않게), 받은 시각은 그대로 둔다(오래된 값이 새 값처럼 남지 않게)
  useEffect(
    () => () => {
      const key = [apiUrl, "discoverRank", market, category, size];
      const d = qc.getQueryData<InfiniteData<DiscoverRank, RankPageParam>>(key);
      const state = qc.getQueryState(key);
      if (!d || d.pages.length <= 1 || state?.status === "error") return;
      void qc.cancelQueries({ queryKey: key, exact: true });
      qc.setQueryData<InfiniteData<DiscoverRank, RankPageParam>>(key, { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) }, { updatedAt: state?.dataUpdatedAt });
    },
    [qc, apiUrl, market, category, size],
  );
  return useInfiniteQuery({
    queryKey: useKey("discoverRank", market, category, size),
    queryFn: ({ pageParam }) => api.discoverRank(market, category, pageParam.page, size, pageParam.ver),
    initialPageParam: { page: 1 } as RankPageParam,
    // 서버 상한(20쪽)과 빈 쪽에서 멈춘다 (빈 "더 보기"가 끝없이 이어지지 않게).
    // 다음 쪽은 앞 쪽과 같은 목록 판(ver)에서 받는다 — 그 사이 서버 목록이 바뀌어도 줄이 빠지거나 겹치지 않게
    getNextPageParam: (last) => (last.hasMore && last.items.length > 0 && last.page < 20 ? { page: last.page + 1, ver: last.ver } : undefined),
    staleTime: Math.min(interval, 30_000),
    refetchInterval: (q) => ((q.state.data?.pages.length ?? 0) > AUTO_REFRESH_MAX_PAGES ? false : discoverEvery(q.state.data?.pages[0]?.marketOpen, interval)),
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
  return useQuery({ queryKey: useKey("candles", code, period, count), queryFn: () => api.getCandles(code, period, count), staleTime: 5 * 60_000, enabled: !!code });
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

export function useBriefings(filter: { code?: string; date?: string; session?: BriefingSession; limit?: number }, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: useKey("briefings", "list", filter), queryFn: () => api.listBriefings(filter), staleTime: 30_000, enabled });
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
