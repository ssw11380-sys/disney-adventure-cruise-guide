import { useIsRestoring, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useApi, useMarketStatus, useTossAccountSnapshotCache } from "@/api/hooks";
import { ApiRequestError } from "@/api/client";
import type { FeatureFlags, LatestBriefing, MarketIndex, RegisteredWithQuote } from "@/api/types";
import { widgetChip } from "@/lib/liveDot";
import { personalBlocked, sessionFor, sessionIdentityVersion, sessionVersion, subscribeSession } from "@/lib/session";
import { useSettings } from "@/lib/settings";
import { pickBoard, pickWidgetIndices, widgetFeatures } from "@/widgets/payload";
import { widgetPushDue } from "@/widgets/pushPolicy";
import { refreshBriefingWidget, refreshWidgets, widgetBriefingsKey } from "@/widgets/refresh";
import { resetWidgetAccountSnapshot } from "@/widgets/data";

/**
 * 앱 → 홈 화면 위젯 즉시 갱신 (3-16 규칙: 시세만 바뀌면 1분에 한 번, 표시 설정·장 상태가 바뀌거나 앱을 떠날 때는 바로).
 * 탭 화면이 아니라 앱 맨 위에 둔다 — 숨은 탭은 얼려 두므로(3-17 freezeOnBlur) 설정 탭에서 원화 표시를 바꾸고 홈으로 나가도 반영되게.
 * 잔고·지수·기능 플래그 캐시는 읽기만 한다(스스로 서버를 부르지 않음): 잔고 탭 폴링·체결 스트림·지수 띠가 캐시를 고치면 따라간다.
 * 지수·플래그 캐시는 기기에 며칠 남은 옛 값일 수 있어(플래그는 브리핑·설정 화면에서만 다시 받는다) 받은 시각을 함께 넘기고,
 * 위젯이 받아 둔 /api/widget 응답이 더 새것이면 그쪽을 쓴다 (data.ts pushWidgetData).
 * 브리핑 위젯 (위젯 검토 7번, 다듬은 모습 widgetPolish): 브리핑 탭이 받은 최신 브리핑 목록과 받은 시각도 넘긴다 — 위젯은 서버와 같은 규칙으로 3종목을 고르고,
 * 위젯이 받아 둔 응답보다 늦게 받은 목록일 때만 쓴다 (refresh.tsx). 목록은 캐시에 있거나 누가 무효화했을 때만(다시 만들기·브리핑 알림·종목 등록·수정·삭제) 받는다 —
 * 앱을 켰다고 처음부터 받지는 않는다. 잔고를 이번 실행에서 받지 않았으면(위젯·알림으로 브리핑 상세에 바로 들어감) 브리핑 위젯만 다시 그린다
 */
export function WidgetBridge() {
  const api = useApi();
  const { apiUrl, apiToken, ready, showKrw, afterCost, widgetRowCurrency } = useSettings();
  // 다듬은 잔고 위젯 종목 줄 손익 통화 (설정 "위젯 종목 금액") — 바꾸면 바로 다시 그린다 (key)
  const rowKrw = widgetRowCurrency === "krw";
  // 계정 A단계 (검증 4차 M1): 로그인 전·주인 아닌 계정·자동 로그인을 끈 세션(메모리에만)이면 앱이 받은 데이터를 위젯에 넘기지 않는다 —
  // 위젯은 계정이 바뀔 때 그린 '로그인하면 보여요'(또는 준비 중) 그대로 (앱을 닫으면 사라져야 할 세션의 잔고를 홈 화면에 남기지 않게)
  useSyncExternalStore(subscribeSession, sessionVersion, sessionVersion);
  const identity = sessionIdentityVersion();
  // 실제 인증 교체만 계좌 캐시 경계다. 첫 관찰·일반 로딩은 유효한 위젯 저장본을 버리지 않는다.
  // 토큰은 메모리에서만 비교하며 위젯 인자·저장값·키에 넣지 않는다.
  const credentialBoundary = useRef<{ apiUrl: string; apiToken: string; identity: number } | null>(ready === false ? null : { apiUrl, apiToken, identity });
  const accountReset = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (ready === false) return;
    const previous = credentialBoundary.current;
    if (!previous) { credentialBoundary.current = { apiUrl, apiToken, identity }; return; }
    if (previous.apiUrl === apiUrl && previous.apiToken === apiToken && previous.identity === identity) return;
    credentialBoundary.current = { apiUrl, apiToken, identity };
    const pending = resetWidgetAccountSnapshot();
    accountReset.current = pending;
    void pending.then(() => { if (accountReset.current === pending) accountReset.current = null; }, () => undefined);
  }, [apiUrl, apiToken, identity, ready]);
  const here = sessionFor(apiUrl);
  const accountQ = useTossAccountSnapshotCache();
  const denied = accountQ.error instanceof ApiRequestError && (accountQ.error.status === 401 || accountQ.error.status === 403);
  const blocked = ready === false || personalBlocked(apiUrl) || (!!here && !here.remember) || denied;
  const stocks = useQuery<RegisteredWithQuote[]>({ queryKey: [apiUrl, "stocks"], queryFn: api.listStocks, enabled: false });
  const data = stocks.data;
  const dataAt = stocks.dataUpdatedAt;
  // 위젯 손익 전환·지수 줄 플래그와 지수 띠 값 (앱이 받은 것과 받은 시각. 위젯이 받아 둔 것이 더 새것이면 그쪽)
  const flagsQ = useQuery<FeatureFlags>({ queryKey: [apiUrl, "features"], queryFn: api.features, enabled: false });
  const flags = flagsQ.data;
  const flagsAt = flagsQ.dataUpdatedAt;
  const idx = useQuery<{ indices: MarketIndex[] }>({ queryKey: [apiUrl, "indices"], queryFn: api.marketIndices, enabled: false });
  const features = useMemo(() => (flags ? { at: flagsAt, flags: widgetFeatures(flags.features) } : null), [flags, flagsAt]);
  const tossAccount = useMemo(() => {
    if (blocked || !features) return null;
    if (!features.flags.tossAccount) return { at: flagsAt, body: { on: false, snapshot: null, sync: null } };
    const body = accountQ.data;
    if (!body) return null;
    return { at: Math.max(accountQ.dataUpdatedAt, accountQ.errorUpdatedAt), body: accountQ.isError && body.sync
      ? { ...body, sync: { ...body.sync, lastError: "앱에서 계좌 새로고침 실패 · 마지막 수신 금액입니다." } } : body };
  }, [blocked, features, flagsAt, accountQ.data, accountQ.dataUpdatedAt, accountQ.errorUpdatedAt, accountQ.isError]);
  // 받은 시각만 바뀐 같은 응답과 종목 체결은 긴급 갱신을 만들지 않는다. 계좌 금액·기준·오류 상태가 바뀐 때만 바로 그린다.
  const accountKey = useMemo(() => tossAccount ? JSON.stringify(tossAccount.body) : "", [tossAccount]);
  const polish = features?.flags.polish === true;
  // 최신 브리핑 목록 (브리핑 탭 쿼리 [apiUrl, "briefings", "latest"] 의 캐시). 다듬은 모습이 켜져 있고, 목록이 이미 캐시에 있거나 무효화됐을 때만 이 관찰자가 켜진다:
  // 다시 만들기(useStockMutations run)·브리핑 알림(NotificationBridge)이 목록을 무효화하면, 브리핑 탭이 가려져 구독을 끊었어도(탭은 돌아올 때 받는다)
  // 여기서 다시 받아 위젯에 바로 넘긴다. 이번 실행에서 브리핑 탭을 연 적이 없어도(목록은 기기에 저장하지 않는다 — queryPersist) 무효화되면 한 번 받는다:
  // 앱을 새로 켜 위젯 항목·알림으로 브리핑 상세에 바로 들어가 '이 종목만 다시 만들기'를 누르는 흔한 흐름 (검증 지적).
  // 종목 등록·수정·삭제(useStockMutations 의 같은 무효화)도 한 번씩 다시 받는다 — 삭제한 종목의 브리핑이 위젯에서 빠지게. 목록이 같으면 넘기지 않는다.
  // 스스로는 받지 않는다 (마운트·포커스·재연결에 다시 받지 않고, 목록이 없고 무효화되지 않았으면 꺼져 있다 — 토큰을 바꿔 캐시를 비워도 받지 않음). 꺼짐이면 지금처럼 읽기만
  const briefQ = useQuery<LatestBriefing[]>({
    queryKey: [apiUrl, "briefings", "latest"],
    queryFn: api.latestBriefings,
    enabled: (q) => polish && (q.state.data !== undefined || q.state.isInvalidated),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // 꺼져 있으면 넘기지 않는다 (목록이 바뀌어도 지금처럼 넘기는 때가 바뀌지 않게). 켜져 있어도 위젯이 실제로 쓰는 플래그로 한 번 더 고른다 (refresh.tsx)
  const briefList = polish ? briefQ.data : undefined;
  const briefAt = briefQ.dataUpdatedAt;
  const appBriefings = useMemo(() => (briefList ? { at: briefAt, list: briefList } : null), [briefList, briefAt]);
  const idxList = idx.data?.indices;
  const idxAt = idx.dataUpdatedAt;
  const indices = useMemo(() => (idxList ? { at: idxAt, list: pickWidgetIndices(idxList) } : null), [idxList, idxAt]);
  // 지수·환율 위젯 판: 같은 지수 띠 9개 (앱이 새 지수를 받으면 위젯도 같은 숫자로)
  const board = useMemo(() => (idxList ? { at: idxAt, list: pickBoard(idxList) } : null), [idxList, idxAt]);
  const ms = useMarketStatus().data;
  // 이번 실행에서 서버에서 받은 잔고인지: 받은 시각이 앱을 연 뒤인지로 본다 (기기 저장값 복원·오프라인 실패로 옛 잔고를 넘기지 않게)
  const [mountedAt] = useState(() => Date.now());
  const restoring = useIsRestoring();
  const fetchedThisSession = !restoring && dataAt > mountedAt;
  // 플래그가 바뀌어도 바로 (손익 전환·지수 줄이 켜지고 꺼지는 것을 1분 기다리지 않게)
  // 폴드 위젯 2차(widgetFoldFit — 넓은 모습 폭 규칙)도 넣는다 — 켜고 끄면 위젯을 바로 그 규칙으로 다시 그리게.
  // 시장 요약(marketSummary — 브리핑 위젯 첫 줄)도: 끄면 앱이 받은 플래그로 바로 넘겨 브리핑 위젯을 다시 그릴 때(다듬은 모습의 앱 브리핑) 첫 줄이 빠진다
  // 숫자 기준(numberBasis → basis, 3-32)도: 켜고 끄면 잔고·자산 위젯의 기준 글을 바로 붙이거나 뗀다
  const flagKey = features ? `${features.flags.pnlToggle}|${features.flags.indexLine}|${features.flags.market}|${features.flags.polish}|${features.flags.foldFit === true}|${features.flags.marketSummary === true}|${features.flags.basis === true}|${features.flags.tossAccount === true}` : "";
  // 브리핑 목록이 바뀌면 바로 (다시 만들기·새 브리핑). 다듬은 모습이 꺼져 있으면 넣지 않는다 — 지금처럼 브리핑 때문에 넘기지 않게.
  // 목록(성공한 최신 브리핑의 id·만든 시각)만 보고 시세는 보지 않는다: 3종목을 고르는 순서(원화 평가금액)를 넣으면 금액이 비슷한 두 종목이
  // 체결마다 뒤집힐 때마다 1분 규칙을 건너뛰고 넘긴다 (검증 지적). 시세 때문에 바뀐 순서·구성은 다음 1분 넘김(그때 시세로 고름)에 따라간다
  const briefKey = useMemo(() => (briefList ? widgetBriefingsKey(briefList) : ""), [briefList]);
  const last = useRef({ at: 0, key: "" });
  const push = useRef<(leaving: boolean) => void>(() => undefined);
  useEffect(() => {
    push.current = (leaving: boolean) => {
      const now = Date.now();
      if (!data || blocked) return;
      // 장 상태 칩: 위젯이 스스로 받는 /api/widget(&sessions=1 — 이 앱이 붙이는 표시)과 같은 함수(lib/liveDot widgetChip = 서버 widgetPayload.marketChip) — 장 상태와 잔고 시세의 세션으로.
      // 예전에는 달력만 봐서(useAnyMarketOpen) 추석 미국 주간거래에 앱이 그리면 "한국 휴장", 위젯이 받으면 "미국 주간거래"로 번갈아 바뀌었다.
      // 넘기는 순간의 시각으로 잔고를 새로 받을 때마다(세션 경계 1초 뒤 포함) 다시 계산하고, 칩 문구가 바뀌면 바로 넘긴다.
      // 칩이 바뀌는 때(nextChangeAt)가 지나면 위젯이 칩을 감춘다.
      // 다듬은 잔고 위젯(widgetPolish)은 시장별 문구(markets)로 두 시장을 한 칩에 그리고, 그 문구가 바뀌는 세션 경계에서도 감춘다 —
      // 예전 모습은 그 경계에서 감추면 안 되므로(한국 장중 09:00 에 칩·'지연'이 사라짐) 두 칩을 넘기고, 위젯이 실제로 쓰는 플래그로 고른다 (data.ts pushWidgetData)
      const market = widgetChip(ms, data, now);
      const marketPolished = widgetChip(ms, data, now, { markets: true });
      const chipKey = [market?.label ?? "", ...(marketPolished?.markets ?? []).map((m) => m.label)].join("·");
      const key = `${showKrw}|${afterCost}|${rowKrw}|${chipKey}|${flagKey}|${briefKey}|${accountKey}`;
      if (!widgetPushDue({ now, fetchedThisSession, lastAt: last.current.at, lastKey: last.current.key, key, leaving })) return;
      last.current = { at: now, key };
      // 잔고를 받은 시각(dataAt)도 넘긴다: 위젯이 이미 더 새 잔고를 가졌으면(앱이 다른 탭에 있는 동안 백그라운드 작업이 받음) 그쪽을 둔다 (통합 검증 지적)
      const args = { stocks: data, dataAt, showKrw, afterCost, rowKrw, market, marketPolished, features, indices, board, appBriefings, tossAccount };
      const boundary = credentialBoundary.current;
      // 인증 교체 때의 저장본 정리만 끝낸 뒤 전달한다. 평상시에는 기존처럼 곧바로 갱신한다.
      if (accountReset.current) void accountReset.current.then(() => {
        if (credentialBoundary.current === boundary) void refreshWidgets(args);
      }, () => undefined);
      else void refreshWidgets(args);
    };
    push.current(false);
  }, [data, dataAt, flagKey, briefKey, accountKey, showKrw, afterCost, rowKrw, ms, fetchedThisSession, features, indices, board, appBriefings, tossAccount, blocked]);
  // 잔고를 이번 실행에서 받지 않았을 때 (검증 지적): 위젯 종목 브리핑·알림으로 앱을 새로 켜 브리핑 상세에 바로 들어가면 잔고 탭이 아래에 가려져
  // 잔고를 받지 않으므로 위의 넘김은 3-16 규칙(기기 저장값 잔고로 위젯을 덮지 않음)에 막힌다. 그래도 목록이 바뀌면(다시 만들기·브리핑 알림으로 받음)
  // 브리핑 위젯만 바로 다시 그린다 — 잔고·자산·지수 위젯과 저장된 잔고·칩은 그대로, 3종목은 저장된 잔고로 고른다 (refresh.tsx refreshBriefingWidget).
  // 잔고를 받은 뒤로는 위의 넘김이 브리핑까지 함께 넘긴다 (키에 목록). 같은 목록은 다시 그리지 않는다
  const briefOnlyKey = useRef("");
  useEffect(() => {
    if (blocked || !appBriefings || !briefKey || (data && fetchedThisSession) || briefOnlyKey.current === briefKey) return;
    briefOnlyKey.current = briefKey;
    void refreshBriefingWidget(appBriefings);
  }, [appBriefings, briefKey, data, fetchedThisSession, blocked]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "background") push.current(true);
    });
    return () => sub.remove();
  }, []);
  return null;
}
