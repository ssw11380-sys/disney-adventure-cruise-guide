import { useQueryClient } from "@tanstack/react-query";
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { CandleSeries, Evaluation, Quote, RegisteredStock, RegisteredWithQuote } from "@/api/types";
import { applyTickToCandles } from "./chartPrefs";
import { applyTick, evaluate, streamUrl, type StreamMessage, type StreamTick } from "./liveTick";
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

type StockDetail = RegisteredStock & { quote: Quote | null; quoteError: string | null; evaluation?: Evaluation | null };

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

    const apply = (tick: StreamTick) => {
      let touched = false;
      qc.setQueriesData<RegisteredWithQuote[]>({ queryKey: [apiUrl, "stocks"], exact: true }, (list) => {
        if (!list) return list;
        let changed = false;
        const next = list.map((s) => {
          if (s.code !== tick.code) return s;
          const quote = applyTick(s.quote, tick);
          if (quote === s.quote) return s;
          changed = true;
          return { ...s, quote, evaluation: evaluate(s, quote, s.evaluation) };
        });
        if (changed) touched = true;
        return changed ? next : list;
      });
      qc.setQueriesData<StockDetail>({ queryKey: [apiUrl, "stock", tick.code], exact: true }, (d) => {
        if (!d) return d;
        const quote = applyTick(d.quote, tick);
        if (quote === d.quote) return d;
        touched = true;
        return { ...d, quote, evaluation: evaluate(d, quote, d.evaluation) };
      });
      // 차트의 마지막 봉도 같이 움직인다 (일·주·월봉은 고·저·종 갱신, 분봉은 구간이 바뀌면 새 봉)
      qc.setQueriesData<CandleSeries>({ queryKey: [apiUrl, "candles", tick.code] }, (series) => {
        if (!series) return series;
        const next = applyTickToCandles(series.candles, series.period, tick.price, tick.timestamp);
        return next === series.candles ? series : { ...series, candles: next };
      });
      if (touched) {
        ticksRef.current += 1;
        setState((s) => ({ ...s, lastTickAt: Date.now(), ticks: ticksRef.current }));
      }
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
        if (msg.type === "tick") apply(msg);
        else if (msg.type === "snapshot") for (const t of msg.ticks) apply(t);
        else if (msg.type === "holdings") {
          // 토스 계좌 체결로 잔고가 바뀌었다 → 목록·상세를 바로 다시 받는다
          void qc.invalidateQueries({ queryKey: [apiUrl, "stocks"] });
          void qc.invalidateQueries({ queryKey: [apiUrl, "stock"] });
        }
      };
      ws.onerror = () => {
        /* onclose 가 이어서 온다 */
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
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
      disconnect();
    };
  }, [apiUrl, apiToken, ready, qc]);

  return <LiveStreamContext.Provider value={state}>{children}</LiveStreamContext.Provider>;
}
