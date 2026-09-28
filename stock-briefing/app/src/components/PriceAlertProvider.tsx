import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Alert, AppState } from "react-native";
import { ApiRequestError } from "@/api/client";
import { useApi, useFeatures, useLivePoll } from "@/api/hooks";
import type { PriceAlertKind, PriceAlertRule, Quote, RegisteredWithQuote, VolumeStatus } from "@/api/types";
import { PriceAlertBanner } from "@/components/PriceAlertBanner";
import { PriceAlertSheet } from "@/components/PriceAlertSheet";
import { featureOn } from "@/lib/features";
import { haptic } from "@/lib/haptics";
import { PRICE_ALERTS_OFF, PriceAlertContext, type PriceAlertState } from "@/lib/priceAlertContext";
import { activeRules, ALERT_TEXT, announceText, checkQuoteRules, checkVolumeRules, codesKey, firedBook, notificationContent, notifyPriceAlert, type Hit } from "@/lib/priceAlerts";
import { useSettings } from "@/lib/settings";
import { priceAlert } from "@/tokens";

/**
 * 가격·등락률·거래량 알림 (3-29, 기능 플래그 priceAlerts — 앱 fallback 꺼짐). 루트 레이아웃이 화면 전체를 감싼다.
 *  - 문맥(lib/priceAlertContext): 켜짐 · 조건 목록 · 시트 열기 · 지우기 · 종목 이름. 꺼져 있으면 꺼짐 값만 내려 주고 요청·구독·기기 기록 읽기 0
 *  - 엔진: react-query 캐시에 성공 사건(체결이 고친 값·폴링으로 받은 값)이 오면 그 자리에서 확인한다 (타이머 없음 → 체결 도착부터 3초보다 훨씬 짧다).
 *    이번 실행에서, 앱이 앞에 있는 동안 받은 값만 (기기에 저장해 둔 옛 목록·뒤에 있던 동안 들어온 값으로는 울리지 않음).
 *    조건마다 그 종목 거래일에 한 번 (서버 기록 firedOn + 기기 기록 + 이번 실행 메모리)
 *  - 울리면: 기록 → 화면 위 카드 → 진동 한 번 → 화면 읽기 한 번 → 조건마다 알림 목록 한 줄(권한이 이미 있을 때, 소리 없음) → 서버에 울림 기록 → 조건 목록 캐시 고침
 *  - ListWatch: 활성 가격·등락률 조건이 있으면 잔고 목록을 늘 받아 둔다 (잔고 탭이 가려져도·소켓이 끊겨도). VolumeWatch: 활성 거래량 조건 종목의 상태를 30초마다
 */

/** 이 모듈을 불러온 때 (lib/liveStream 의 SESSION_START 와 같은 뜻 — 기기에 저장해 둔 옛 값은 이보다 오래됐다) */
const RUN_START = Date.now();
/** 서버에 못 보냈을 때도 하루 한 번을 지키는 기기 기록: { "<조건 id>": "<마지막으로 울린 날짜>" } */
const FIRED_KEY = "priceAlerts.fired.v1";

const is404 = (e: unknown) => e instanceof ApiRequestError && e.status === 404;

type RulesData = { rules: PriceAlertRule[] };
type StockDetail = { code?: string; name?: string; quote: Quote | null; registered?: boolean };

/**
 * 가격 조건이 있을 때 잔고 목록을 늘 받아 둔다 (잔고 탭이 가려져도, 소켓이 끊겨도).
 * 잔고 탭(useStocks)과 같은 키·같은 주기라 둘이 함께 있어도 요청은 하나다: 쿼리에 사건이 있을 때마다(받기 시작·받음·체결로 고침)
 * react-query 가 모든 관찰자의 주기 타이머를 같은 순간에 다시 걸고, 먼저 울린 쪽이 받기 시작하면 그 사건이 다른 쪽 타이머를 다시 건다.
 * 관찰자 수로 주기를 끄지 않는다 — 위젯 연결 등이 같은 키를 enabled: false 로 늘 보고 있고, 다른 관찰자가 빠질 때 남은 관찰자의 주기는 다시 계산되지 않는다
 */
function ListWatch() {
  const api = useApi();
  const { apiUrl } = useSettings();
  const every = useLivePoll();
  useQuery({
    queryKey: [apiUrl, "stocks"],
    queryFn: api.listStocks,
    staleTime: 2_000,
    retryDelay: 1_000,
    refetchIntervalInBackground: false,
    refetchInterval: every,
  });
  return null;
}

/** 활성 거래량 조건 종목의 거래량 급증 상태를 30초마다 (모두 정규장 밖이면 5분마다). 받은 값은 엔진이 캐시 사건으로 확인한다 */
function VolumeWatch({ codes }: { codes: string[] }) {
  const api = useApi();
  const { apiUrl } = useSettings();
  useQuery({
    queryKey: [apiUrl, "priceAlerts", "volume", codes.join(",")],
    queryFn: () => api.priceAlertVolume(codes),
    retry: 0,
    refetchIntervalInBackground: false,
    refetchInterval: (q) => (q.state.data?.items.length && q.state.data.items.every((i) => i.status === "closed") ? priceAlert.volumeIdleMs : priceAlert.volumePollMs),
  });
  return null;
}

export function PriceAlertProvider({ children }: { children: React.ReactNode }) {
  const on = featureOn(useFeatures().data, "priceAlerts", false);
  const api = useApi();
  const { apiUrl } = useSettings();
  const qc = useQueryClient();

  const rulesQ = useQuery({
    queryKey: [apiUrl, "priceAlerts"],
    queryFn: api.priceAlerts,
    enabled: on,
    staleTime: 30_000,
    // 예전 서버(404)는 조건 없음으로 보고 다시 묻지 않는다
    retry: (count, e) => !is404(e) && count < 1,
    // 앱으로 돌아올 때 30초 넘었으면 다시 (전역은 false — focusManager 는 AppState 에 묶여 있음)
    refetchOnWindowFocus: true,
    // 404 가 아닌 실패면 1분마다 다시 (앱을 켤 때 한 번 실패해 그 실행 내내 알림이 0 이 되지 않게)
    refetchInterval: (q) => (q.state.status === "error" && !is404(q.state.error) ? priceAlert.rulesRetryMs : false),
  });
  const rules = useMemo(() => rulesQ.data?.rules ?? [], [rulesQ.data]);
  const rulesReady = rulesQ.data !== undefined || is404(rulesQ.error);

  // 기기 기록 (켜져 있을 때만 읽는다. null = 아직 읽는 중)
  const device = useRef<Record<string, string> | null>(null);
  const [deviceLoaded, setDeviceLoaded] = useState(false);
  useEffect(() => {
    if (!on || device.current) return;
    let alive = true;
    const done = (v: Record<string, string>) => {
      if (!alive) return;
      device.current = v;
      setDeviceLoaded(true);
    };
    AsyncStorage.getItem(FIRED_KEY)
      .then((raw) => {
        const v: unknown = raw ? JSON.parse(raw) : {};
        const out: Record<string, string> = {};
        if (v && typeof v === "object") for (const [k, d] of Object.entries(v)) if (typeof d === "string") out[k] = d;
        done(out);
      })
      .catch(() => done({}));
    return () => {
      alive = false;
    };
  }, [on]);
  const ready = on && rulesReady && deviceLoaded;

  // 이번 실행 메모리 ("<id>|<date>") — 인스턴스마다 (새로 그린 제공자 = 빈 메모리)
  const memory = useRef<Set<string>>(new Set());
  // 앱이 마지막으로 앞에 온 때 (처음 그릴 때 이미 앞이면 RUN_START)
  const activeSince = useRef<number>(AppState.currentState === "active" ? RUN_START : Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (!on) return;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") activeSince.current = Date.now();
    });
    return () => sub.remove();
  }, [on]);

  // 이번 실행에서 받은 잔고 목록의 코드 모음 (쉬는 중 규칙 · 목록·거래량 받기 판단). 처음 본 모음은 기억만, 바뀌면 조건 목록을 다시 받는다
  const [listKey, setListKey] = useState<string | null>(null);
  // 이번 실행에서 받은 잔고 목록의 종목 이름 (설정 칸이 목록을 받은 뒤 이름으로 다시 그려지게 — 못 받았으면 기기에 저장해 둔 목록 캐시, 그것도 없으면 코드)
  const [names, setNames] = useState<Record<string, string>>({});
  const lastListKey = useRef<string | null>(null);

  // 화면 위 카드 (최신부터)
  const [banner, setBanner] = useState<Hit[]>([]);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideSeq = useRef(0);
  const armHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    const seq = ++hideSeq.current;
    const schedule = (reader: boolean) => {
      // 화면 읽기가 켜져 있으면 저절로 닫지 않는다
      if (reader || seq !== hideSeq.current) return;
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null;
        setBanner([]);
      }, priceAlert.bannerHideMs);
    };
    Promise.resolve(AccessibilityInfo.isScreenReaderEnabled())
      .then((v) => schedule(v === true))
      .catch(() => schedule(false));
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  // 캐시 사건에서 쓰는 최신 값 (구독을 다시 걸지 않으려고)
  const live = useRef({ ready, api, apiUrl });
  useEffect(() => {
    live.current = { ready, api, apiUrl };
  });

  /** 지금 규칙 (조건 목록 캐시 — 방금 받은 값까지) */
  const rulesNow = useCallback(() => qc.getQueryData<RulesData>([apiUrl, "priceAlerts"])?.rules ?? [], [qc, apiUrl]);
  /** 이번 실행에서 받은 잔고 목록의 코드 모음 (아니면 null) */
  const listCodesNow = useCallback((): Set<string> | null => {
    const st = qc.getQueryState<RegisteredWithQuote[]>([apiUrl, "stocks"]);
    return st?.data && st.dataUpdatedAt >= RUN_START ? new Set(st.data.map((s) => s.code)) : null;
  }, [qc, apiUrl]);
  const nameOf = useCallback((code: string) => names[code] ?? qc.getQueryData<RegisteredWithQuote[]>([apiUrl, "stocks"])?.find((s) => s.code === code)?.name ?? code, [names, qc, apiUrl]);

  /** 울린다: 기록 → 카드 → 진동 한 번 → 화면 읽기 한 번 → 알림 목록 → 서버 기록 → 조건 목록 캐시 */
  const fire = useCallback(
    (found: Hit[]) => {
      const hits = found.filter((h, i) => !memory.current.has(`${h.rule.id}|${h.date}`) && found.findIndex((x) => x.rule.id === h.rule.id) === i);
      if (!hits.length) return;
      const next: Record<string, string> = { ...(device.current ?? {}) };
      for (const h of hits) {
        memory.current.add(`${h.rule.id}|${h.date}`);
        next[String(h.rule.id)] = h.date;
      }
      device.current = next;
      AsyncStorage.setItem(FIRED_KEY, JSON.stringify(next)).catch(() => undefined);
      setBanner((prev) => [...hits, ...prev.filter((p) => !hits.some((h) => h.rule.id === p.rule.id && h.date === p.date))]);
      armHide();
      haptic("alert");
      try {
        AccessibilityInfo.announceForAccessibility(announceText(hits));
      } catch {
        /* 화면 읽기는 없어도 되는 것 */
      }
      for (const h of hits) notifyPriceAlert(notificationContent(h));
      const at = new Date().toISOString();
      const { api: a, apiUrl: url } = live.current;
      for (const h of hits) a.priceAlertFired(h.rule.id, { date: h.date, at, value: h.firedValue }).catch(() => undefined);
      // 시트·설정 칸이 '오늘 울림'을 바로 보이게 (받은 시각은 그대로 — 조건 목록이 새로 온 것으로 보지 않게)
      const st = qc.getQueryState<RulesData>([url, "priceAlerts"]);
      if (st?.data)
        qc.setQueryData<RulesData>(
          [url, "priceAlerts"],
          { rules: st.data.rules.map((r) => {
            const h = hits.find((x) => x.rule.id === r.id);
            return h ? { ...r, firedOn: h.date, firedAt: at } : r;
          }) },
          { updatedAt: st.dataUpdatedAt },
        );
    },
    [qc, armHide],
  );

  const book = useCallback(() => firedBook(rulesNow(), device.current ?? {}, memory.current), [rulesNow]);
  /** 앞에 있고 엔진이 준비됐을 때 기준 시각 (이보다 먼저 받은 값으로는 울리지 않음). 아니면 null */
  const since = useCallback(() => (live.current.ready && AppState.currentState === "active" ? Math.max(RUN_START, activeSince.current) : null), []);

  /** 지금 캐시로 한 번 확인 (잔고 목록 · 종목 상세들 · 마지막 거래량 응답) */
  const checkNow = useCallback(() => {
    const from = since();
    if (from === null) return;
    const url = live.current.apiUrl;
    const rs = rulesNow();
    const codes = listCodesNow();
    const fired = book();
    const now = Date.now();
    const hits: Hit[] = [];
    const listState = qc.getQueryState<RegisteredWithQuote[]>([url, "stocks"]);
    if (listState?.data && listState.dataUpdatedAt >= from) hits.push(...checkQuoteRules(rs, listState.data, now, fired, codes));
    for (const q of qc.getQueryCache().findAll({ queryKey: [url, "stock"] })) {
      const d = q.state.data as StockDetail | undefined;
      if (q.queryKey.length !== 3 || !d || q.state.dataUpdatedAt < from) continue;
      const code = String(q.queryKey[2]);
      hits.push(...checkQuoteRules(rs, [{ code, name: d.name ?? code, quote: d.quote, ...(d.registered === false ? { registered: false } : null) }], now, fired, codes));
    }
    for (const q of qc.getQueryCache().findAll({ queryKey: [url, "priceAlerts", "volume"] })) {
      const d = q.state.data as { items: VolumeStatus[] } | undefined;
      if (!d || q.state.dataUpdatedAt < from) continue;
      hits.push(...checkVolumeRules(rs, d.items, nameOf, fired, codes));
    }
    fire(hits);
  }, [qc, since, rulesNow, listCodesNow, book, nameOf, fire]);

  // 캐시 구독: 성공 사건 안에서 바로 확인 (켜져 있을 때만)
  useEffect(() => {
    if (!on) return;
    const noteList = (list: RegisteredWithQuote[]) => {
      const k = codesKey(list);
      // 등록 종목이 바뀌면 조건 목록을 다시 받는다 (registered 가 옛 값으로 남지 않게). 처음 본 모음은 기억만
      if (lastListKey.current !== null && lastListKey.current !== k) void qc.invalidateQueries({ queryKey: [apiUrl, "priceAlerts"], exact: true });
      lastListKey.current = k;
      setListKey(k);
      const next = Object.fromEntries(list.map((s) => [s.code, s.name]));
      setNames((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const first = qc.getQueryState<RegisteredWithQuote[]>([apiUrl, "stocks"]);
    if (first?.data && first.dataUpdatedAt >= RUN_START) noteList(first.data);
    const unsub = qc.getQueryCache().subscribe((e) => {
      if (e.type !== "updated" || e.action.type !== "success") return;
      const key = e.query.queryKey;
      if (key[0] !== apiUrl) return;
      const at = e.query.state.dataUpdatedAt;
      const isList = key.length === 2 && key[1] === "stocks";
      if (isList && at >= RUN_START && Array.isArray(e.query.state.data)) noteList(e.query.state.data as RegisteredWithQuote[]);
      const from = since();
      if (from === null || at < from) return;
      const rs = rulesNow();
      if (!rs.length) return;
      const now = Date.now();
      if (isList && Array.isArray(e.query.state.data)) {
        fire(checkQuoteRules(rs, e.query.state.data as RegisteredWithQuote[], now, book(), listCodesNow()));
      } else if (key.length === 3 && key[1] === "stock") {
        const d = e.query.state.data as StockDetail | undefined;
        const code = String(key[2]);
        if (d) fire(checkQuoteRules(rs, [{ code, name: d.name ?? code, quote: d.quote, ...(d.registered === false ? { registered: false } : null) }], now, book(), listCodesNow()));
      } else if (key[1] === "priceAlerts" && key[2] === "volume") {
        const d = e.query.state.data as { items: VolumeStatus[] } | undefined;
        if (d) fire(checkVolumeRules(rs, d.items, nameOf, book(), listCodesNow()));
      }
    });
    return () => unsub();
  }, [on, qc, apiUrl, since, rulesNow, listCodesNow, book, nameOf, fire]);

  // 엔진이 준비되는 순간과 조건 목록이 새로 올 때마다 '지금 캐시로 한 번 확인'
  useEffect(() => {
    if (ready) checkNow();
  }, [ready, rulesQ.dataUpdatedAt, checkNow]);

  // 시트
  const [sheet, setSheet] = useState<{ code: string; name: string; quote: Quote | null } | null>(null);
  const [sheetVolume, setSheetVolume] = useState<VolumeStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const openSheet = useCallback(
    (s: { code: string; name: string; quote: Quote | null }) => {
      setSheet(s);
      setSheetVolume(undefined);
      // 거래량 줄 둘째 글: 열 때 한 번 받는다 (거래량 조건이 없어도)
      api
        .priceAlertVolume([s.code])
        .then((r) => setSheetVolume(r.items.find((i) => i.code === s.code) ?? null))
        .catch(() => setSheetVolume(null));
    },
    [api],
  );
  const refetchRules = useCallback(() => void qc.invalidateQueries({ queryKey: [apiUrl, "priceAlerts"], exact: true }), [qc, apiUrl]);
  const remove = useCallback(
    async (rule: PriceAlertRule) => {
      try {
        await api.deletePriceAlert(rule.id);
      } catch (e) {
        if (!(e instanceof ApiRequestError && e.status === 404)) Alert.alert("알림을 지우지 못했습니다", e instanceof Error ? e.message : String(e));
      } finally {
        refetchRules();
      }
    },
    [api, refetchRules],
  );
  const save = (body: { code: string; kind: PriceAlertKind; value: number }) => {
    if (busy) return;
    setBusy(true);
    api
      .createPriceAlert(body)
      .then(() => {
        setSheet(null);
        haptic("success");
        try {
          AccessibilityInfo.announceForAccessibility(ALERT_TEXT.saved);
        } catch {
          /* 없어도 되는 것 */
        }
        refetchRules();
      })
      .catch((e: unknown) => {
        haptic("error");
        Alert.alert(ALERT_TEXT.saveFailTitle, e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  };

  const value = useMemo<PriceAlertState>(() => (on ? { on: true, rules, openSheet, remove, nameOf } : PRICE_ALERTS_OFF), [on, rules, openSheet, remove, nameOf]);

  // 목록 받기·거래량 받기: 엔진이 준비됐고 활성 조건이 있을 때만 (쉬는 중 조건은 넣지 않는다)
  const listCodes = listKey === null ? null : new Set(listKey ? listKey.split(",") : []);
  const active = ready ? activeRules(rules, listCodes) : [];
  const watchList = active.some((r) => r.kind !== "volume");
  const volumeCodes = [...new Set(active.filter((r) => r.kind === "volume").map((r) => r.code))].sort().slice(0, 10);

  return (
    <PriceAlertContext.Provider value={value}>
      {children}
      {on ? (
        <>
          {watchList ? <ListWatch /> : null}
          {volumeCodes.length ? <VolumeWatch codes={volumeCodes} /> : null}
          <PriceAlertBanner
            hits={banner}
            onOpen={(code) => {
              setBanner([]);
              router.push(`/stocks/${code}` as never);
            }}
            onClose={() => setBanner([])}
          />
          {sheet ? (
            <PriceAlertSheet
              code={sheet.code}
              name={sheet.name}
              quote={sheet.quote}
              rules={rules.filter((r) => r.code === sheet.code)}
              volume={sheetVolume}
              busy={busy}
              onSave={save}
              onRemove={(r) => void remove(r)}
              onClose={() => setSheet(null)}
            />
          ) : null}
        </>
      ) : null}
    </PriceAlertContext.Provider>
  );
}
