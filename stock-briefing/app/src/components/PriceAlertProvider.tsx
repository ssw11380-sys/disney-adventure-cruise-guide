import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { router, usePathname } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Alert, AppState } from "react-native";
import { ApiRequestError } from "@/api/client";
import { useApi, useFeatures, useLivePoll } from "@/api/hooks";
import type { PriceAlertKind, PriceAlertRule, Quote, RegisteredWithQuote, VolumeStatus } from "@/api/types";
import { PriceAlertBanner } from "@/components/PriceAlertBanner";
import { PriceAlertSheet } from "@/components/PriceAlertSheet";
import { featureOn } from "@/lib/features";
import { haptic } from "@/lib/haptics";
import { quotesOf } from "@/lib/liveDot";
import { PRICE_ALERTS_OFF, PriceAlertContext, type PriceAlertState } from "@/lib/priceAlertContext";
import { activeRules, ALERT_TEXT, announceText, checkQuoteRules, checkVolumeRules, codesKey, firedBook, isDetailPath, notificationContent, notifyPriceAlert, sessionEdges, type Hit } from "@/lib/priceAlerts";
import { personalBlocked, sessionVersion, subscribeSession } from "@/lib/session";
import { useSettings } from "@/lib/settings";
import { priceAlert } from "@/tokens";

/**
 * 가격·등락률·거래량 알림 (3-29, 기능 플래그 priceAlerts — 앱 fallback 꺼짐). 루트 레이아웃이 화면 전체를 감싼다.
 *  - 문맥(lib/priceAlertContext): 켜짐 · 조건 목록 · 시트 열기 · 지우기 · 종목 이름. 꺼져 있으면 꺼짐 값만 내려 주고 요청·구독·기기 기록 읽기 0
 *  - 엔진: react-query 캐시에 성공 사건(체결이 고친 값·폴링으로 받은 값)이 오면 그 자리에서 확인한다 (타이머 없음 → 체결 도착부터 3초보다 훨씬 짧다).
 *    이번 실행에서, 앱이 앞에 있는 동안 받은 값만 (기기에 저장해 둔 옛 목록·뒤에 있던 동안 들어온 값으로는 울리지 않음).
 *    조건마다 그 종목 거래일에 한 번 (서버 기록 firedOn + 기기 기록 + 이번 실행 메모리)
 *  - 울리면: 기록 → 화면 위 카드 → 진동 한 번 → 화면 읽기 한 번 → 조건마다 알림 목록 한 줄(권한이 이미 있을 때, 소리 없음) → 서버에 울림 기록 → 조건 목록 캐시 고침
 *  - ListWatch: 활성 가격·등락률 조건이 있으면 잔고 목록을 늘 받아 둔다 (잔고 탭이 가려져도·소켓이 끊겨도). VolumeWatch: 활성 거래량 조건 종목의 상태를 30초마다.
 *    BoundaryWatch: 알림 종목 시세의 세션 경계 1초 뒤 목록(과 보고 있는 상세)을 다시 받는다 (체결이 촘촘해 주기 받기가 밀려도)
 *  - 종목 이름: 이번 실행에서 받은 잔고 목록 → 목록 캐시 → 기기에 기억해 둔 이름(조건이 있는 종목만 — 등록에서 뺀 종목도 설정 칸에 이름으로) → 코드
 */

/** 이 모듈을 불러온 때 (lib/liveStream 의 SESSION_START 와 같은 뜻 — 기기에 저장해 둔 옛 값은 이보다 오래됐다) */
const RUN_START = Date.now();
/** 서버에 못 보냈을 때도 하루 한 번을 지키는 기기 기록: { "<조건 id>": "<마지막으로 울린 날짜>" } */
const FIRED_KEY = "priceAlerts.fired.v1";
/** 조건이 있는 종목의 이름: { "<코드>": "<이름>" } — 등록에서 빼 잔고 목록에 없는 종목도 설정 칸에 코드 대신 이름으로 */
const NAMES_KEY = "priceAlerts.names.v1";
const NO_NAMES: Record<string, string> = Object.freeze({}) as Record<string, string>;

/** 기기에 저장한 { 글자: 글자 } 읽기 (모양이 다른 값은 뺀다) */
function readStringMap(raw: string | null): Record<string, string> {
  const v: unknown = raw ? JSON.parse(raw) : {};
  const out: Record<string, string> = {};
  if (v && typeof v === "object") for (const [k, d] of Object.entries(v)) if (typeof d === "string") out[k] = d;
  return out;
}

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

/**
 * 세션 경계 뒤에 목록(과 보고 있는 상세)을 한 번 더 받는다 (3-29 검토 must).
 * 체결은 가격만 고치고 세션(quote.session)은 그대로 둔다. 그런데 체결이 캐시를 고칠 때마다 react-query 가 ListWatch·잔고 탭의 주기 타이머를
 * 다시 걸어(hooks useLivePoll 의 알려진 한계) 체결이 주기보다 촘촘한 동안에는 '경계 1초 뒤 한 번 더 받기'가 계속 밀린다 →
 * 캐시의 세션이 경계 전 값(장 시작 전 · until 지남)으로 남아 quoteDate 가 null — 조건에 맞아도 울리지 않았다
 * (NXT 프리마켓·장 시작 전에 켜 둔 채 09:00 개장, KRX 15:20 → NXT 애프터, 미국 프리 → 정규 · 정규 → 애프터).
 * 그래서 쿼리 사건과 상관없는 타이머로, 알림 종목(codes) 시세의 가장 가까운 경계 1초 뒤에 그 쿼리를 다시 받는다.
 *  - 체결은 경계(until)를 바꾸지 않으므로 체결 사건이 이 타이머를 뒤로 밀지 않는다 (더 이른 경계가 생길 때만 당긴다)
 *  - 받은 값이 아직 옛 세션이면(서버 시계가 조금 늦음) 3초 뒤 다시, 같은 경계로 3번까지. 받는 중이면 끊지 않고 그 결과를 본다
 *  - 앱이 뒤에 있으면 받지 않는다. 앞으로 돌아오면 바로 확인해 지난 경계가 있으면 받는다 (돌아온 뒤 재연결 체결이 주기 타이머를 또 밀어도)
 */
function BoundaryWatch({ codes }: { codes: string }) {
  const qc = useQueryClient();
  const { apiUrl } = useSettings();
  useEffect(() => {
    const wanted = new Set(codes.split(","));
    const cache = qc.getQueryCache();
    const isTarget = (key: readonly unknown[]) =>
      key[0] === apiUrl && ((key.length === 2 && key[1] === "stocks") || (key.length === 3 && key[1] === "stock" && wanted.has(String(key[2]))));
    // 목록(ListWatch 가 늘 보고 있음)과 보고 있는 상세 중 알림 종목의 시세만
    const targets = () => cache.findAll({ queryKey: [apiUrl], type: "active" }).filter((q) => isTarget(q.queryKey));
    const quotesIn = (q: Query) => quotesOf(q.state.data).filter((x) => !!x && wanted.has(x.code));
    const tries = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armedFor: number | null = null;
    /** at 에 확인 (이미 더 이른 확인이 걸려 있으면 그대로 — 체결 사건이 타이머를 뒤로 밀지 않게) */
    const arm = (at: number | null) => {
      if (at === null || (armedFor !== null && armedFor <= at)) return;
      if (timer) clearTimeout(timer);
      armedFor = at;
      timer = setTimeout(sweep, Math.min(Math.max(0, at - Date.now()), priceAlert.boundaryMaxWaitMs));
    };
    /** 다음 확인 시각: 앞으로 올 가장 이른 경계 + 1초 */
    const nextAt = (now: number) => {
      let best: number | null = null;
      for (const q of targets()) {
        const n = sessionEdges(quotesIn(q), now).next;
        if (n !== null && (best === null || n < best)) best = n;
      }
      return best === null ? null : best + priceAlert.boundaryDelayMs;
    };
    /** 지난 경계가 남은 쿼리를 다시 받고(앞에 있을 때만) 다음 확인을 건다 */
    function sweep() {
      if (timer) clearTimeout(timer);
      timer = null;
      armedFor = null;
      const now = Date.now();
      let again = false;
      if (AppState.currentState === "active") {
        for (const q of targets()) {
          const { passed } = sessionEdges(quotesIn(q), now);
          if (passed === null) continue;
          // 받는 중이면 그 결과를 3초 뒤 본다
          if (q.state.fetchStatus === "fetching") {
            again = true;
            continue;
          }
          const k = `${q.queryHash}|${passed}`;
          const n = tries.get(k) ?? 0;
          if (n >= priceAlert.boundaryTries) continue;
          tries.set(k, n + 1);
          again = true;
          void qc.refetchQueries({ queryKey: q.queryKey, exact: true, type: "active" }, { cancelRefetch: false });
        }
      }
      arm(again ? now + priceAlert.boundaryRetryMs : nextAt(now));
    }
    const unsub = cache.subscribe((e) => {
      if (!isTarget(e.query.queryKey)) return;
      // 보는 화면이 새로 붙음(상세를 엶 · 잔고 탭으로 돌아옴) → 지난 경계가 있는지 곧 확인
      if (e.type === "observerAdded") arm(Date.now());
      // 새로 받은 값(경계가 바뀌었을 수 있음). 체결로 고친 값은 경계가 그대로라 걸린 타이머를 바꾸지 않는다
      else if (e.type === "updated" && e.action.type === "success") arm(nextAt(Date.now()));
    });
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") arm(Date.now());
    });
    arm(Date.now());
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      sub.remove();
    };
  }, [qc, apiUrl, codes]);
  return null;
}

/** 화면 위 카드. 줄을 눌렀을 때 이미 그 종목 상세에 있으면 카드만 닫는다 (같은 상세가 스택에 하나 더 쌓여 뒤로 가기를 두 번 누르지 않게) */
function BannerHost({ hits, onClose }: { hits: Hit[]; onClose: () => void }) {
  const path = usePathname();
  return (
    <PriceAlertBanner
      hits={hits}
      onOpen={(code) => {
        onClose();
        if (!isDetailPath(path, code)) router.push(`/stocks/${code}` as never);
      }}
      onClose={onClose}
    />
  );
}

export function PriceAlertProvider({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const { apiUrl } = useSettings();
  // 계정 A단계 (검증 4차): 로그인 화면이 떠 있는 동안·주인 아닌 계정은 꺼짐 — 조건을 묻지도(서버는 403·빈 값) 1분마다 다시 묻지도 않는다
  useSyncExternalStore(subscribeSession, sessionVersion, sessionVersion);
  const on = featureOn(useFeatures().data, "priceAlerts", false) && !personalBlocked(apiUrl);
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
  // 한 번도 받지 못했고 404 가 아닌 실패 → 빈 목록은 '없음'이 아니라 '모름' (설정 칸·시트가 빈 상태 대신 '불러오지 못함')
  const rulesFailed = rulesQ.data === undefined && rulesQ.isError && !is404(rulesQ.error);

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
      .then((raw) => done(readStringMap(raw)))
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
  // AppState 를 첫 그림부터 쭉 보고 있었는지 (꺼져 있는 동안은 구독하지 않으므로 — 꺼짐 = 구독 0 — 그사이 뒤로 갔다 왔는지 모른다)
  const watchedFromMount = useRef(on);
  // 앞에 온 때를 켜진 순간으로 잡았음 → 준비되면 그 전에 받은 잔고 목록을 한 번 다시 받는다 (아래 효과)
  const refreshOnReady = useRef(false);
  useEffect(() => {
    if (!on) return;
    // 구독을 붙이는 지금 앞에 있는데 앞에 온 때를 모르면 지금부터로 본다: 처음 그릴 때 뒤였고 'active' 사건이 구독보다 먼저 왔음(Infinity 로 남으면
    // 그 실행 내내 울리지 않음) · 실행 도중 켜짐(옛 값이면 준비 순간의 확인이 뒤에 있던 동안 들어온 값까지 봄)
    if (AppState.currentState === "active" && (!watchedFromMount.current || activeSince.current === Number.POSITIVE_INFINITY)) {
      activeSince.current = Date.now();
      refreshOnReady.current = true;
    }
    watchedFromMount.current = true;
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") activeSince.current = Date.now();
    });
    return () => {
      sub.remove();
      watchedFromMount.current = false;
    };
  }, [on]);

  // 이번 실행에서 받은 잔고 목록 — 코드 모음(쉬는 중 규칙 · 목록·거래량 받기 판단)과 종목 이름(설정 칸이 목록을 받은 뒤 이름으로 다시 그려지게).
  // 받은 서버 주소를 같이 적어 두고 지금 주소와 다르면 없는 것으로 본다 (서버를 바꾸면 옛 서버의 코드 모음으로 조건을 거르지 않게)
  const [listSeen, setListSeen] = useState<{ url: string; key: string; names: Record<string, string> } | null>(null);
  const listKey = listSeen?.url === apiUrl ? listSeen.key : null;
  const names = listSeen?.url === apiUrl ? listSeen.names : NO_NAMES;
  // 마지막으로 본 코드 모음 (이 서버에서 처음 본 모음은 기억만, 바뀌면 조건 목록을 다시 받는다)
  const lastListKey = useRef<{ url: string; key: string } | null>(null);

  // 기기에 기억해 둔 종목 이름 (켜져 있을 때 한 번 읽는다. null = 아직 읽는 중) · 이번 실행에서 저장한 조건의 종목 이름
  const [savedNames, setSavedNames] = useState<Record<string, string> | null>(null);
  const [createdNames, setCreatedNames] = useState<Record<string, string>>({});
  // 기기에 마지막으로 적은(또는 읽은) 글 — 같으면 다시 적지 않는다
  const writtenNames = useRef<string | null>(null);
  useEffect(() => {
    if (!on || savedNames !== null) return;
    let alive = true;
    const done = (v: Record<string, string>) => {
      if (!alive) return;
      writtenNames.current = JSON.stringify(v);
      setSavedNames(v);
    };
    AsyncStorage.getItem(NAMES_KEY)
      .then((raw) => done(readStringMap(raw)))
      .catch(() => done({}));
    return () => {
      alive = false;
    };
  }, [on, savedNames]);
  // 기억할 이름 = '조건이 있는 종목'의 이름만 (조건이 없어진 종목은 뺀다 — 많아야 30종목). 조건 목록을 받기 전에는 읽은 그대로
  const rememberedNames = useMemo(() => {
    if (savedNames === null || rulesQ.data === undefined) return savedNames;
    const next: Record<string, string> = {};
    for (const r of rules) {
      const n = names[r.code] ?? createdNames[r.code] ?? savedNames[r.code];
      if (n && n !== r.code) next[r.code] = n;
    }
    return next;
  }, [savedNames, rulesQ.data, rules, names, createdNames]);
  useEffect(() => {
    if (!on || rememberedNames === null || rulesQ.data === undefined) return;
    const json = JSON.stringify(rememberedNames);
    if (json === writtenNames.current) return;
    writtenNames.current = json;
    AsyncStorage.setItem(NAMES_KEY, json).catch(() => undefined);
  }, [on, rememberedNames, rulesQ.data]);

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
  const nameOf = useCallback(
    (code: string) => names[code] ?? qc.getQueryData<RegisteredWithQuote[]>([apiUrl, "stocks"])?.find((s) => s.code === code)?.name ?? rememberedNames?.[code] ?? code,
    [names, qc, apiUrl, rememberedNames],
  );

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
      // 등록 종목이 바뀌면 조건 목록을 다시 받는다 (registered 가 옛 값으로 남지 않게). 이 서버에서 처음 본 모음은 기억만
      const last = lastListKey.current;
      if (last !== null && last.url === apiUrl && last.key !== k) void qc.invalidateQueries({ queryKey: [apiUrl, "priceAlerts"], exact: true });
      lastListKey.current = { url: apiUrl, key: k };
      const next = Object.fromEntries(list.map((s) => [s.code, s.name]));
      setListSeen((prev) => (prev && prev.url === apiUrl && prev.key === k && JSON.stringify(prev.names) === JSON.stringify(next) ? prev : { url: apiUrl, key: k, names: next }));
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

  // 목록 받기·거래량 받기: 엔진이 준비됐고 활성 조건이 있을 때만 (쉬는 중 조건은 넣지 않는다)
  const listCodes = listKey === null ? null : new Set(listKey ? listKey.split(",") : []);
  const active = ready ? activeRules(rules, listCodes) : [];
  const quoteCodes = [...new Set(active.filter((r) => r.kind !== "volume").map((r) => r.code))].sort().join(",");
  const watchList = quoteCodes !== "";
  const volumeCodes = [...new Set(active.filter((r) => r.kind === "volume").map((r) => r.code))].sort().slice(0, 10);

  // 실행 도중 켜져(첫 실행·앱 데이터 지움·7일 넘게 안 켬·서버 주소 바꿈 — 저장된 플래그가 없음) 앞에 온 때를 켜진 순간으로 잡았으면,
  // 그 전에 받은 잔고 목록은 확인하지 않으므로 준비되는 순간 한 번 다시 받는다 → 이미 맞은 조건이 다음 목록 주기(스트림 중 30초)를 기다리지 않고
  // 첫 확인에서 울린다 (작업지시 6장 1번). 받는 중이면 끊지 않는다. 활성 가격 조건이 생길 때까지 미룬다
  useEffect(() => {
    if (!ready || !watchList || !refreshOnReady.current) return;
    refreshOnReady.current = false;
    const from = since();
    const st = qc.getQueryState([apiUrl, "stocks"]);
    if (from !== null && st?.data !== undefined && st.dataUpdatedAt < from) void qc.invalidateQueries({ queryKey: [apiUrl, "stocks"], exact: true }, { cancelRefetch: false });
  }, [ready, watchList, qc, apiUrl, since]);

  // 시트
  const [sheet, setSheet] = useState<{ code: string; name: string; quote: Quote | null } | null>(null);
  const [sheetVolume, setSheetVolume] = useState<VolumeStatus | null | undefined>(undefined);
  // 시트를 열 때마다 하나씩 — 늦게 온 앞 시트의 거래량 응답(최대 40초)이 지금 열린 다른 종목 시트를 덮어쓰지 않게
  const sheetSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  // 저장 잠금: busy 는 다음 그림에서야 바뀌므로 [알림 저장]을 아주 빨리 두 번 누르면 요청이 두 번 갈 수 있다 → 누르는 순간 잠근다
  const saving = useRef(false);
  const openSheet = useCallback(
    (s: { code: string; name: string; quote: Quote | null }) => {
      const seq = ++sheetSeq.current;
      setSheet(s);
      setSheetVolume(undefined);
      // 거래량 줄 둘째 글: 열 때 한 번 받는다 (거래량 조건이 없어도). 그사이 다른 시트를 열었으면 버린다
      const mine = () => seq === sheetSeq.current;
      api
        .priceAlertVolume([s.code])
        .then((r) => {
          if (mine()) setSheetVolume(r.items.find((i) => i.code === s.code) ?? null);
        })
        .catch(() => {
          if (mine()) setSheetVolume(null);
        });
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
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const name = sheet?.code === body.code ? sheet.name : null;
    api
      .createPriceAlert(body)
      .then(() => {
        if (name) setCreatedNames((prev) => (prev[body.code] === name ? prev : { ...prev, [body.code]: name }));
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
      .finally(() => {
        saving.current = false;
        setBusy(false);
      });
  };

  const value = useMemo<PriceAlertState>(
    () => (on ? { on: true, rules, openSheet, remove, nameOf, rulesFailed } : PRICE_ALERTS_OFF),
    [on, rules, openSheet, remove, nameOf, rulesFailed],
  );

  return (
    <PriceAlertContext.Provider value={value}>
      {children}
      {on ? (
        <>
          {watchList ? <ListWatch /> : null}
          {watchList ? <BoundaryWatch codes={quoteCodes} /> : null}
          {volumeCodes.length ? <VolumeWatch codes={volumeCodes} /> : null}
          <BannerHost hits={banner} onClose={() => setBanner([])} />
          {sheet ? (
            <PriceAlertSheet
              code={sheet.code}
              name={sheet.name}
              quote={sheet.quote}
              rules={rules.filter((r) => r.code === sheet.code)}
              rulesFailed={rulesFailed}
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
