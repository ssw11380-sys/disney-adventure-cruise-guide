import { Platform } from "react-native";
import type { WidgetInfo } from "react-native-android-widget";
import type { LatestBriefing, RegisteredWithQuote } from "@/api/types";
import { pushWidgetData, readPnlMode, withLastGood } from "./data";
import { fontScaleNow } from "./fontScale";
import type { WidgetFeatures, WidgetIndex, WidgetMarket } from "./payload";
import { renderBoth } from "./render";
import { WIDGET_NAMES } from "./widgets";

/**
 * 앱이 이미 받아 둔 데이터로 홈 화면 위젯을 즉시 갱신한다 (서버 재호출 없음).
 * 위젯이 하나도 없으면 아무 일도 하지 않는다. Android 전용. 라이트·다크 두 벌을 함께 그린다 (3-23)
 */
export async function refreshWidgets({
  stocks: raw,
  showKrw,
  afterCost,
  filled: given,
  market,
  briefings,
  features,
  indices,
  board,
}: {
  stocks: RegisteredWithQuote[];
  showKrw: boolean;
  afterCost: boolean;
  /** 이미 마지막 값으로 채운 데이터(백그라운드 작업)면 채운 종목 코드. 없으면 여기서 채운다 */
  filled?: string[];
  /** 장 상태 칩 */
  market?: WidgetMarket | null;
  /** 주면 브리핑 위젯도 다시 그린다 (백그라운드 작업) */
  briefings?: LatestBriefing[];
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
    const fetchedAt = Date.now();
    // 시세가 빠진 종목은 마지막 값으로 채우고(위젯이 직접 받을 때와 같은 규칙), 다음 실패 대비로 적어 둔다
    const { stocks, filled } = given ? { stocks: raw, filled: given } : await withLastGood(raw, fetchedAt);
    const data = await pushWidgetData({ stocks, filled, showKrw, afterCost, fetchedAt, market: market ?? null, briefings, features, indices, board });
    const pnlMode = await readPnlMode();
    const fontScale = fontScaleNow();
    const draw = (name: string) => (info: WidgetInfo) => renderBoth(name, data, { width: info.width, height: info.height, fontScale, now: fetchedAt, pnlMode });
    await requestWidgetUpdate({ widgetName: WIDGET_NAMES.holdings, renderWidget: draw(WIDGET_NAMES.holdings) });
    await requestWidgetUpdate({ widgetName: WIDGET_NAMES.asset, renderWidget: draw(WIDGET_NAMES.asset) });
    if (briefings) await requestWidgetUpdate({ widgetName: WIDGET_NAMES.briefing, renderWidget: draw(WIDGET_NAMES.briefing) });
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
