import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createApi } from "@/api/client";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { CandleSeries, Evaluation, Quote, RegisteredStock, RegisteredWithQuote } from "@/api/types";
import { applyTickToCandles, isIntraday } from "./chartPrefs";
import { applyTick, applyTicksToList, evaluate, latestPerCode, newTradingDay, streamUrl, type StreamMessage, type StreamTick } from "./liveTick";
import { useSettings } from "./settings";

/**
 * 서버 /api/stream 웹소켓을 앱이 켜져 있는 동안 하나 유지하고, 체결이 올 때마다 react-query 캐시의
 * 현재가(홈 목록 · 종목 상세)를 바로 고친다. 화면은 평소처럼 캐시를 구독하고 있으니 3초 폴링 없이도 즉시 바뀐다.
 *  - 앱이 뒤로 가면 끊고, 다시 오면 붙는다 (배터리·데이터 절약)
 *  - 끊기면 1초 → 최대 30초 간격으로 다시 붙는다. 30초 넘게 아무 메시지(ping 포함)가 없으면 죽은 연결로 보고 다시 붙는다
 *  - 연결 상태는 useLiveStream() 으로 읽어 홈 배지("실시간 스트리밍")와 폴링 주기 완화에 쓴다
 */

interface LiveStreamState {
  connected: boolean;
  /** 마지막으로 연결된 시각. 체결이 한 번도 안 왔을 때 "실시간" 판단의 기준 */
  connectedAt: number | null;
  lastTickAt: number | null;
  ticks: number;
}

const LiveStreamContext = createContext<LiveStreamState>({ connected: false, connectedAt: null, lastTickAt: null, ticks: 0 });

export function useLiveStream(): LiveStreamState {
  return useContext(LiveStreamContext);
}

/** 앱이 켜진 시각. 기기에 저장해 둔 옛 잔고(이 시각보다 오래된 값)에는 체결을 덮지 않는다 — 옛 수량으로 "실시간"처럼 보이지 않게 */
const SESSION_START = Date.now();
/** 연결 상태(마지막 체결 시각·건수)를 화면에 알리는 간격 — 체결마다 알리면 화면 전체가 한 번 더 그려진다 */
const STATE_EVERY_MS = 5_000;
/** 거래일이 바뀐 체결을 보류한 종목의 시세를 다시 받는 최소 간격 (서버도 새 거래일 시세를 받기 전이면 옛 값을 주므로 두드리지 않게) */
const NEW_DAY_REFETCH_MS = 15_000;
/**
 * 새 일·주·월 봉이 열려 서버 봉을 바로 다시 받는 것은 서버 봉을 받은 지 이만큼 지났을 때만. 방금 받은 서버 봉에 그 봉이 없으면
 * (서버 봉 출처가 아직 새 거래일 봉을 열지 않음) 체결마다 다시 받지 않고 주기 갱신·다시 볼 때에 맡긴다
 */
const NEW_BAR_REFETCH_MS = 15_000;
/** 새 분봉이 열렸을 때 이보다 오래 서버 봉을 못 받았으면 바로 다시 받는다 (장중 분봉 주기 갱신 30초보다 길게 — 장중에는 요청이 늘지 않게) */
const INTRADAY_NEW_BAR_REFETCH_MS = 60_000;

type StockDetail = RegisteredStock & { quote: Quote | null; quoteError: string | null; evaluation?: Evaluation | null };

/**
 * 연결이 살아 있는 동안 받은 종목별 마지막 체결 (서버 주소별). 주기 갱신으로 받은 서버 봉은 서버 봉 캐시 값이라 최대 수십 초~몇 분 늦을 수 있어,
 * 받은 봉에 이 체결을 다시 얹는다(withLastTick) — 마지막 봉 종가가 상단 현재가보다 뒤처지지 않게 (PF-04).
 * 끊기면 비운다: 끊긴 동안 놓친 체결이 있을 수 있으니 그때는 서버 봉을 그대로 믿는다
 */
const lastTicks = new Map<string, StreamTick>();
const lastTickKey = (apiUrl: string, code: string) => `${apiUrl}\n${code}`;

export function rememberTicks(apiUrl: string, ticks: Iterable<StreamTick>): void {
  for (const t of ticks) {
    const prev = lastTicks.get(lastTickKey(apiUrl, t.code));
    if (prev && Date.parse(prev.timestamp) > Date.parse(t.timestamp)) continue;
    lastTicks.set(lastTickKey(apiUrl, t.code), t);
  }
}

export function forgetTicks(): void {
  lastTicks.clear();
}

/**
 * 서버에서 받은 봉에 연결 중 받은 마지막 체결을 다시 얹는다. 서버의 마지막 봉과 같은 구간일 때만 고·저·종을 고치고, 뒤 구간·지난 구간이면 그대로.
 * 서버에 없는 뒤 구간 봉은 붙이지 않는다 — 서버 봉을 다시 받는 것이 앱이 만든 봉을 지우는 길이라서. 붙이면 한국 평일 휴장일(추석·한글날 등,
 * tradingDate 가 모름)에 접속 직후 스냅샷 체결(서버가 값이 그대로여도 마지막 폴링 시각을 붙여 보냄)로 생긴 그날의 빈 봉이 다시 받을 때마다 되살아난다.
 * 방금 열린 봉이 서버 봉 캐시에 아직 없으면 다음 체결이 다시 열거나 다음 주기 갱신이 서버 봉으로 채운다 (PF-04)
 */
export function withLastTick(apiUrl: string, code: string, series: CandleSeries): CandleSeries {
  const tick = lastTicks.get(lastTickKey(apiUrl, series.code || code));
  if (!tick) return series;
  const candles = applyTickToCandles(series.candles, series.period, tick.price, tick.timestamp, series.code || code);
  return candles === series.candles || candles.length !== series.candles.length ? series : { ...series, candles };
}

/**
 * 체결 묶음을 react-query 캐시(잔고 목록 · 종목 상세 · 차트 봉)에 적용한다. 화면에 보이는 값이 바뀌었으면 true.
 *  - 바뀐 게 없으면 쿼리를 건드리지 않는다(undefined) — 같은 값을 다시 넣어도 react-query 는 "방금 받은 값"으로 받은 시각을 새로 찍는다
 *  - 거래일이 바뀐 체결은 붙이지 않고 held 에 모은다 → 새 거래일 시세를 다시 받는다 (PF-01)
 *  - 차트 봉은 체결로 고쳐도 서버에서 새로 받은 값이 아니므로 받은 시각·무효 표시를 그대로 둔다 → 다시 볼 때·주기 갱신 때 서버 봉(거래량 포함)으로 바로잡힌다 (PF-04)
 *  - openBars=false(접속 직후 스냅샷)면 차트에 새 봉을 열지 않고 마지막 봉만 고친다. 스냅샷 시각은 체결 시각이 아니라 서버가 값이 그대로여도
 *    마지막으로 폴링한 시각이라, 한국 평일 휴장일(tradingDate 가 모름)에 그날 봉을 만들어 버린다. 새 봉은 실제로 가격이 바뀐 체결(ticks)이 연다
 */
export function applyTicksToCache(qc: QueryClient, apiUrl: string, ticks: Map<string, StreamTick>, held: Set<string>, now = Date.now(), { openBars = true } = {}): boolean {
  let touched = false;
  const fresh = (key: unknown[]) => (qc.getQueryState(key)?.dataUpdatedAt ?? 0) >= SESSION_START;
  qc.setQueriesData<RegisteredWithQuote[]>({ queryKey: [apiUrl, "stocks"], exact: true }, (list) => {
    if (!list || !fresh([apiUrl, "stocks"])) return undefined;
    const next = applyTicksToList(list, ticks, held);
    if (next === list) return undefined;
    touched = true;
    return next;
  });
  for (const tick of ticks.values()) {
    qc.setQueriesData<StockDetail>({ queryKey: [apiUrl, "stock", tick.code], exact: true }, (d) => {
      if (!d) return undefined;
      if (newTradingDay(d.quote, tick)) held.add(tick.code);
      const quote = applyTick(d.quote, tick);
      if (quote === d.quote) return undefined;
      touched = true;
      return { ...d, quote, evaluation: evaluate(d, quote, d.evaluation) };
    });
    // 차트의 마지막 봉도 같이 움직인다 (분봉은 현지 시각, 일·주·월봉은 거래일로 같은 구간이면 고·저·종 갱신, 새 구간이면 새 봉)
    for (const q of qc.getQueryCache().findAll({ queryKey: [apiUrl, "candles", tick.code] })) {
      const series = q.state.data as CandleSeries | undefined;
      if (!series) continue;
      const next = applyTickToCandles(series.candles, series.period, tick.price, tick.timestamp, series.code || tick.code);
      if (next === series.candles || (!openBars && next.length !== series.candles.length)) continue;
      const { dataUpdatedAt, isInvalidated } = q.state;
      qc.setQueryData<CandleSeries>(q.queryKey, { ...series, candles: next }, { updatedAt: dataUpdatedAt });
      // 새 봉이 열렸으면 서버 봉을 다시 받는다 (보고 있지 않은 차트는 표시만 해 두고 다시 볼 때, 방금 받은 서버 봉이면 표시만).
      // 분봉은 장중 주기 갱신(30초)이 있어 그보다 오래된 봉일 때만 — 주기 갱신이 없는 한국 평일 휴장일에 서버 재시작 직후 첫 체결이 연
      // 가짜 분봉을 바로 지운다 (PF-04 검증 지적)
      const opened = next.length > series.candles.length;
      const refetchAfter = isIntraday(series.period) ? INTRADAY_NEW_BAR_REFETCH_MS : NEW_BAR_REFETCH_MS;
      const refetchNow = opened && now - dataUpdatedAt >= refetchAfter;
      if (opened || isInvalidated) void qc.invalidateQueries({ queryKey: q.queryKey, exact: true, refetchType: refetchNow ? "active" : "none" }, { cancelRefetch: false });
    }
  }
  return touched;
}

export function LiveStreamProvider({ children }: { children: React.ReactNode }) {
  const { apiUrl, apiToken, ready } = useSettings();
  const qc = useQueryClient();
  const [state, setState] = useState<LiveStreamState>({ connected: false, connectedAt: null, lastTickAt: null, ticks: 0 });
  const ticksRef = useRef(0);

  useEffect(() => {
    if (!apiUrl || !ready) return; // 저장된 토큰을 읽은 뒤에 붙는다
    let socket: WebSocket | null = null;
    let closed = false;
    let backoff = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    // 체결은 모아서 한 번에 적용한다: 서버가 250ms 묶음(ticks)으로 보내면 받은 즉시 한 번, 예전 서버의 낱개(tick)는 100ms 모아서.
    // 목록은 바뀐 종목만 새 객체라 그 줄만 다시 그려지고, 연결 상태(lastTickAt)는 5초에 한 번만 갱신한다 (3-17)
    const queue: StreamTick[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let lastStateAt = 0;
    // 거래일이 바뀐 체결을 보류한 종목: 새 거래일 기준가가 담긴 시세를 다시 받는다 (PF-01).
    // 상세는 종목마다, 목록은 한꺼번에 NEW_DAY_REFETCH_MS 에 한 번. 받는 중인 요청은 끊지 않고 그 결과를 쓴다
    const refetchedAt = new Map<string, number>();
    let listRefetchedAt = 0;
    const refetchNewDay = (codes: Set<string>) => {
      const now = Date.now();
      for (const code of codes) {
        if (now - (refetchedAt.get(code) ?? 0) < NEW_DAY_REFETCH_MS) continue;
        refetchedAt.set(code, now);
        void qc.invalidateQueries({ queryKey: [apiUrl, "stock", code], exact: true }, { cancelRefetch: false });
      }
      if (now - listRefetchedAt < NEW_DAY_REFETCH_MS) return;
      listRefetchedAt = now;
      void qc.invalidateQueries({ queryKey: [apiUrl, "stocks"], exact: true }, { cancelRefetch: false });
    };
    // snapshot: 접속 직후 스냅샷이면 차트에 새 봉을 열지 않는다 (applyTicksToCache 의 openBars)
    const applyNow = (snapshot = false) => {
      flushTimer = null;
      if (!queue.length) return;
      const ticks = latestPerCode(queue.splice(0));
      rememberTicks(apiUrl, ticks.values());
      const held = new Set<string>();
      const touched = applyTicksToCache(qc, apiUrl, ticks, held, Date.now(), { openBars: !snapshot });
      if (held.size) refetchNewDay(held);
      if (touched) {
        ticksRef.current += ticks.size;
        // 5초에 한 번 (실시간 판단은 30초 기준이라 충분, 마지막 체결은 늦게라도 반영되게 뒤에 한 번 더)
        const wait = STATE_EVERY_MS - (Date.now() - lastStateAt);
        if (wait <= 0) publishState();
        else stateTimer ??= setTimeout(publishState, wait);
      }
    };
    let stateTimer: ReturnType<typeof setTimeout> | null = null;
    const publishState = () => {
      stateTimer = null;
      lastStateAt = Date.now();
      setState((s) => ({ ...s, lastTickAt: lastStateAt, ticks: ticksRef.current }));
    };
    const enqueue = (ticks: StreamTick[], immediate: boolean, snapshot = false) => {
      queue.push(...ticks);
      if (immediate) {
        if (flushTimer) clearTimeout(flushTimer);
        applyNow(snapshot);
      } else flushTimer ??= setTimeout(() => applyNow(), 100);
    };

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        // 서버 ping(25초)도 못 받았으면 죽은 연결 → 닫아서 재접속 경로를 태운다
        try {
          socket?.close();
        } catch {
          /* ignore */
        }
      }, 45_000);
    };

    const connect = () => {
      if (closed || socket) return;
      let ws: WebSocket;
      try {
        // React Native 의 WebSocket 은 세 번째 인자로 헤더를 받는다 (표준 DOM 타입에는 없어서 캐스팅)
        const Ctor = WebSocket as unknown as new (url: string, protocols?: string[], options?: { headers?: Record<string, string> }) => WebSocket;
        ws = new Ctor(streamUrl(apiUrl, apiToken), undefined, apiToken ? { headers: { authorization: `Bearer ${apiToken}` } } : undefined);
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;
      ws.onopen = () => {
        backoff = 1000;
        // 체결을 묶음으로 받겠다고 알린다 (예전 서버는 무시하고 낱개로 보낸다)
        try {
          ws.send(JSON.stringify({ type: "hello", batch: true }));
        } catch {
          /* ignore */
        }
        setState((s) => ({ ...s, connected: true, connectedAt: Date.now() }));
        armWatchdog();
      };
      ws.onmessage = (ev) => {
        armWatchdog();
        let msg: StreamMessage;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "ticks" || msg.type === "snapshot") enqueue(msg.ticks, true, msg.type === "snapshot");
        else if (msg.type === "tick") enqueue([msg], false);
        else if (msg.type === "holdings") {
          // 토스 계좌 체결로 잔고가 바뀌었다 → 목록·상세를 바로 다시 받는다
          // 잔고 탭이 가려져 구독이 끊겨 있어도 바로 받는다 (위젯이 옛 잔고를 그리지 않게)
          // 잔고 탭이 가려져 구독이 끊겨 있어도 바로 받는다 (위젯이 옛 잔고를 그리지 않게) — 구독이 없으면 refetch 가 건너뛰므로 직접 받는다
          void qc.fetchQuery({ queryKey: [apiUrl, "stocks"], queryFn: createApi(apiUrl, apiToken).listStocks, staleTime: 0 }).catch(() => undefined);
          void qc.invalidateQueries({ queryKey: [apiUrl, "stock"] });
        }
      };
      ws.onerror = () => {
        /* onclose 가 이어서 온다 */
      };
      ws.onclose = () => {
        if (socket === ws) {
          socket = null;
          forgetTicks(); // 이미 새로 붙은 뒤 늦게 온 옛 연결의 close 는 새 연결의 체결을 지우지 않는다
        }
        setState((s) => ({ ...s, connected: false }));
        if (watchdog) clearTimeout(watchdog);
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer || AppState.currentState !== "active") return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };

    const disconnect = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (watchdog) clearTimeout(watchdog);
      reconnectTimer = null;
      watchdog = null;
      const ws = socket;
      socket = null;
      forgetTicks();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      setState((s) => ({ ...s, connected: false }));
    };

    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") {
        backoff = 1000;
        connect();
      } else disconnect();
    });
    if (AppState.currentState === "active") connect();

    return () => {
      closed = true;
      sub.remove();
      if (flushTimer) clearTimeout(flushTimer);
      if (stateTimer) clearTimeout(stateTimer);
      disconnect();
    };
  }, [apiUrl, apiToken, ready, qc]);

  return <LiveStreamContext.Provider value={state}>{children}</LiveStreamContext.Provider>;
}
