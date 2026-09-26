import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import type { WidgetInfo } from "react-native-android-widget";
import type { LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { defaultApiUrl, STORAGE_KEYS } from "@/lib/settings";
import { carryBriefingsIntoPayload, loadCachedWidgetData, pushWidgetData, readCachedPayload, readPnlMode, saveWidgetView, withLastGood } from "./data";
import { fontScaleNow } from "./fontScale";
import type { WidgetFeatures, WidgetIndex, WidgetMarket } from "./payload";
import { renderBoth } from "./render";
import { WIDGET_NAMES } from "./widgets";

/** 환율을 모르는 달러 시세의 원화 환산 (서버 widgetPayload krwValue 와 같은 값) */
const FALLBACK_FX = 1400;

/** 보유 비중을 견줄 원화 환산 평가금액 — 서버 widgetPayload.ts krwValue 와 같은 식 (목록에 없는 종목·평가 없는 관심 종목은 0) */
function krwValue(s: RegisteredWithQuote | undefined): number {
  if (!s) return 0;
  const v = s.evaluation?.marketValue ?? 0;
  return s.quote?.currency === "USD" ? v * (s.quote.fxRate ?? FALLBACK_FX) : v;
}

/**
 * 앱이 받은 최신 브리핑 목록(/api/briefings/latest — 종목마다 최신 하나)에서 브리핑 위젯에 넣을 것 (위젯 검토 7번).
 * 서버 /api/widget 의 briefings(backend widgetPayload.ts buildWidgetPayload)와 같은 규칙: 성공한 것만, 보유 비중(원화 환산 평가금액) 큰 순 →
 * 같으면 최신 순, 앞의 3개. 요약은 서버처럼 첫 줄(빈 줄 건너뜀)만, 상세 본문은 넘기지 않는다 (위젯 저장값이 커지지 않게). 받은 목록은 바꾸지 않는다
 */
export function pickWidgetBriefings(latest: readonly LatestBriefing[], stocks: readonly RegisteredWithQuote[]): LatestBriefing[] {
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const ok = latest.filter((b) => b.latest?.status === "ok");
  ok.sort((a, b) => {
    const d = krwValue(byCode.get(b.code)) - krwValue(byCode.get(a.code));
    if (Number.isFinite(d) && d !== 0) return d;
    return a.latest!.createdAt < b.latest!.createdAt ? 1 : -1;
  });
  return ok.slice(0, 3).map((b) => ({ ...b, latest: { ...b.latest!, summary: b.latest!.summary.split("\n").find((l) => l.trim()) ?? "", detail: "" } }));
}

/**
 * 앱 → 위젯 즉시 넘김(WidgetBridge)의 '브리핑 목록이 바뀌었는지' 키: 성공한 최신 브리핑의 id·만든 시각을 정렬해 잇는다.
 * 시세(보유 비중)는 보지 않는다 — 고른 3종목의 순서를 키로 쓰면, 원화 평가금액이 비슷한 두 종목이 체결마다 뒤집힐 때마다
 * 1분 규칙(3-16)을 건너뛰고 넘겼다 (검증 지적). 다시 만들기·새 브리핑·실패로 바뀐 목록만 바로 넘긴다
 */
export function widgetBriefingsKey(latest: readonly LatestBriefing[]): string {
  return latest
    .flatMap((b) => (b.latest?.status === "ok" ? [`${b.latest.id}@${b.latest.createdAt}`] : []))
    .sort()
    .join(",");
}

/**
 * 앱이 받은 브리핑 목록으로 브리핑 위젯을 다시 그릴지 (다듬은 모습 widgetPolish 가 켜져 있을 때만 부른다).
 * 위젯이 마지막으로 받은 /api/widget 응답보다 늦게(같게) 받은 목록일 때만 — 앱이 며칠 떠 있으면 어제 연 브리핑 탭의 목록이 메모리에 남아,
 * 백그라운드 작업이 받아 그린 오늘 브리핑을 옛것으로 덮을 수 있다. 그 응답에 앱 목록을 적은 적이 있으면(briefingsAt — data.ts carryBriefingsIntoPayload)
 * 그 목록보다도 늦게(같게) 받은 것이어야 한다. 성공한 브리핑이 하나도 없으면 위젯이 받은 것(과 안내 문구)을 그대로 둔다
 */
async function appBriefingsToDraw(app: { at: number; list: readonly LatestBriefing[] } | null | undefined, stocks: readonly RegisteredWithQuote[]): Promise<LatestBriefing[] | null> {
  if (!app) return null;
  const picked = pickWidgetBriefings(app.list, stocks);
  if (!picked.length) return null;
  const cached = await readCachedPayload();
  return cached && Math.max(cached.at, cached.briefingsAt ?? 0) > app.at ? null : picked;
}

/** 위젯 코드가 쓰는 서버 주소 (data.ts readSettings 와 같은 규칙 — 저장된 그림은 이 주소와 함께 적는다) */
async function storedApiUrl(): Promise<string> {
  return (await AsyncStorage.getItem(STORAGE_KEYS.apiUrl).catch(() => null)) || defaultApiUrl();
}

/**
 * 브리핑 위젯만 앱이 받은 최신 브리핑으로 다시 그린다 (위젯 검토 7번 검증 지적, 다듬은 모습 widgetPolish).
 * 잔고를 이번 실행에서 받지 않았을 때 WidgetBridge 가 부른다: 위젯의 종목 브리핑·알림을 눌러 앱을 새로 켜 브리핑 상세로 바로 들어가면
 * 잔고 탭이 아래에 가려져 잔고를 받지 않으므로, 잔고와 함께 넘기는 refreshWidgets 는 3-16 규칙(기기 저장값 잔고로 위젯을 덮지 않음)에 막힌다.
 * 그래도 다시 만들기·브리핑 알림으로 방금 받은 목록은 새것이므로 브리핑 위젯은 바로 바꾼다.
 *  - 잔고·자산·지수·환율 위젯은 그리지 않고, 저장된 그림의 잔고·칩·기준 시각·플래그도 그대로 둔다 (브리핑만 바꾼다)
 *  - 3종목은 저장된 잔고(위젯이 마지막으로 그린 것)의 보유 비중으로 고른다
 *  - 위젯이 마지막으로 그린 플래그가 다듬은 모습이고, 위젯이 받아 둔 응답보다 늦게 받은 목록일 때만 (refreshWidgets 와 같은 규칙)
 * 위젯이 없으면 그리지 않는다(저장값만 바뀐다). Android 전용
 */
export async function refreshBriefingWidget(app: { at: number; list: readonly LatestBriefing[] } | null | undefined): Promise<void> {
  if (Platform.OS !== "android" || !app) return;
  try {
    const { requestWidgetUpdate } = await import("react-native-android-widget");
    const shown = await loadCachedWidgetData();
    if (!shown.features.polish) return;
    const picked = await appBriefingsToDraw(app, shown.stocks);
    if (!picked) return;
    // 고르는 동안 다른 갱신이 새 그림을 적었을 수 있으니 적기 직전에 다시 읽어 브리핑만 바꾼다
    const data = { ...(await loadCachedWidgetData()), briefings: picked };
    await saveWidgetView(data, await storedApiUrl());
    await carryBriefingsIntoPayload(picked, app.at);
    const pnlMode = await readPnlMode();
    const fontScale = fontScaleNow();
    await requestWidgetUpdate({
      widgetName: WIDGET_NAMES.briefing,
      renderWidget: (info: WidgetInfo) => renderBoth(WIDGET_NAMES.briefing, data, { width: info.width, height: info.height, fontScale, now: Date.now(), pnlMode }),
    });
  } catch {
    /* 위젯 모듈이 없는 빌드(개발 클라이언트 등)에서는 무시 */
  }
}

/**
 * 앱이 이미 받아 둔 데이터로 홈 화면 위젯을 즉시 갱신한다 (서버 재호출 없음).
 * 위젯이 하나도 없으면 아무 일도 하지 않는다. Android 전용. 라이트·다크 두 벌을 함께 그린다 (3-23)
 */
export async function refreshWidgets({
  stocks: raw,
  dataAt,
  showKrw,
  afterCost,
  filled: given,
  market,
  marketPolished,
  briefings,
  appBriefings,
  features,
  indices,
  board,
  rowKrw,
}: {
  stocks: RegisteredWithQuote[];
  /**
   * 잔고를 받은 시각 (앱: 잔고 쿼리의 react-query dataUpdatedAt, 백그라운드 작업: 위젯 조회 시각). 위젯이 이미 가진 잔고와 어느 쪽이 새 데이터인지
   * 견줄 때 쓴다 (통합 검증 지적 — 넘긴 시각으로 견주면 앱이 떠날 때 넘긴 옛 잔고가 더 새 서버 응답을 이겼다). 없으면 지금
   */
  dataAt?: number;
  showKrw: boolean;
  afterCost: boolean;
  /** 다듬은 잔고 위젯 종목 줄 손익을 원화로 (앱 설정). 주지 않으면(백그라운드 작업) 저장된 설정 */
  rowKrw?: boolean;
  /** 이미 마지막 값으로 채운 데이터(백그라운드 작업)면 채운 종목 코드. 없으면 여기서 채운다 */
  filled?: string[];
  /** 장 상태 칩 */
  market?: WidgetMarket | null;
  /** 다듬은 잔고 위젯용 칩 (시장별 문구와 그 경계, 앱 WidgetBridge). 위젯이 쓰는 플래그가 켜져 있을 때만 이것을 그린다 */
  marketPolished?: WidgetMarket | null;
  /** 주면 브리핑 위젯도 다시 그린다 (백그라운드 작업 — 서버가 고른 3종목) */
  briefings?: LatestBriefing[];
  /**
   * 앱이 받은 최신 브리핑 목록 전체와 받은 시각 (WidgetBridge — react-query 캐시). 위젯이 쓰는 플래그가 다듬은 모습(widgetPolish)이고
   * 위젯이 받아 둔 응답보다 늦게 받은 것이면, 서버와 같은 규칙으로 3종목을 골라 브리핑 위젯도 다시 그린다 (위젯 검토 7번). briefings 가 있으면 쓰지 않는다
   */
  appBriefings?: { at: number; list: readonly LatestBriefing[] } | null;
  /** 위젯 기능 플래그와 받은 시각 (앱이 받은 /api/features 또는 위젯 응답). 위젯이 받아 둔 것과 견줘 새것을 쓴다 */
  features?: { at: number; flags: WidgetFeatures } | null;
  /** 지수 줄 (받은 시각과 함께). 위젯이 받아 둔 것과 견줘 새것을 쓴다 */
  indices?: { at: number; list: WidgetIndex[] } | null;
  /** 지수·환율 위젯 판 9개 (앱 지수 띠 또는 백그라운드 작업이 받은 판, 받은 시각과 함께). 위젯이 받아 둔 것과 견줘 새것을 쓴다 */
  board?: { at: number; list: WidgetIndex[] } | null;
}): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const { requestWidgetUpdate } = await import("react-native-android-widget");
    const now = Date.now();
    // 기준 시각은 잔고를 받은 시각 (미래 시각은 지금으로)
    const fetchedAt = dataAt !== undefined && dataAt > 0 ? Math.min(dataAt, now) : now;
    // 시세가 빠진 종목은 마지막 값으로 채우고(위젯이 직접 받을 때와 같은 규칙), 다음 실패 대비로 적어 둔다 (더 새 마지막 잔고는 덮지 않는다)
    const { stocks, filled } = given ? { stocks: raw, filled: given } : await withLastGood(raw, fetchedAt);
    const push = {
      stocks,
      filled,
      showKrw,
      afterCost,
      fetchedAt,
      market: market ?? null,
      ...(marketPolished !== undefined ? { marketPolished } : {}),
      features,
      indices,
      board,
      ...(rowKrw !== undefined ? { rowKrw } : {}),
    };
    let data = await pushWidgetData({ ...push, briefings });
    // 앱이 받은 최신 브리핑 (위젯 검토 7번): 위젯이 실제로 쓰는 플래그(위에서 앱·위젯 중 늦게 받은 쪽으로 고름)가 다듬은 모습일 때만.
    // 꺼져 있으면 예전처럼 브리핑 위젯은 백그라운드 작업·위젯이 받은 것만 그리고, 저장해 둔 브리핑도 바꾸지 않는다.
    // 켜져 있으면 브리핑까지 넣어 다시 적는다 (같은 입력이라 지수·플래그·칩은 첫 번과 같게 고른다)
    const fromApp = !briefings && data.features.polish ? await appBriefingsToDraw(appBriefings, raw) : null;
    if (fromApp && appBriefings) {
      data = await pushWidgetData({ ...push, briefings: fromApp });
      // 위젯이 스스로 갱신할 때(받아 둔 응답 재사용·조회 실패) 옛 브리핑으로 되돌아가지 않게 받아 둔 응답에도 적는다 (검증 지적)
      await carryBriefingsIntoPayload(fromApp, appBriefings.at);
    }
    const pnlMode = await readPnlMode();
    const fontScale = fontScaleNow();
    // 그리는 시각은 지금 ('지연'·칩 만료·오늘 날짜 판단) — 잔고를 받은 시각이 아니다
    const draw = (name: string) => (info: WidgetInfo) => renderBoth(name, data, { width: info.width, height: info.height, fontScale, now, pnlMode });
    await requestWidgetUpdate({ widgetName: WIDGET_NAMES.holdings, renderWidget: draw(WIDGET_NAMES.holdings) });
    await requestWidgetUpdate({ widgetName: WIDGET_NAMES.asset, renderWidget: draw(WIDGET_NAMES.asset) });
    if (briefings || fromApp) await requestWidgetUpdate({ widgetName: WIDGET_NAMES.briefing, renderWidget: draw(WIDGET_NAMES.briefing) });
    // 지수·환율 위젯: 판·플래그는 앱이 받은 것과 위젯이 받아 둔 것 중 늦게 받은 쪽 (위젯이 없으면 아무 일도 없다)
    await requestWidgetUpdate({ widgetName: WIDGET_NAMES.market, renderWidget: draw(WIDGET_NAMES.market) });
  } catch {
    /* 위젯 모듈이 없는 빌드(개발 클라이언트 등)에서는 무시 */
  }
}

/**
 * 홈 화면에 지수·환율 위젯이 있는지 (백그라운드 작업이 서버에 판을 함께 물을지). 모르면(모듈 없음·조회 실패) false —
 * 그때는 위젯이 스스로 갱신할 때 판을 묻는다
 */
export async function marketWidgetPlaced(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    const { getWidgetInfo } = await import("react-native-android-widget");
    return (await getWidgetInfo(WIDGET_NAMES.market)).length > 0;
  } catch {
    return false;
  }
}
