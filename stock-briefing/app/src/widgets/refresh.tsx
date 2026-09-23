import React from "react";
import { Platform } from "react-native";
import type { RegisteredWithQuote } from "@/api/types";
import { WIDGET_NAMES, AssetWidget, HoldingsWidget } from "./widgets";

/**
 * 앱이 이미 받아 둔 데이터로 홈 화면 위젯을 즉시 갱신한다 (서버 재호출 없음).
 * 위젯이 하나도 없으면 아무 일도 하지 않는다. Android 전용.
 */
export async function refreshWidgets({ stocks, showKrw, afterCost }: { stocks: RegisteredWithQuote[]; showKrw: boolean; afterCost: boolean }): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const { requestWidgetUpdate } = await import("react-native-android-widget");
    const fetchedAt = Date.now();
    await requestWidgetUpdate({
      widgetName: WIDGET_NAMES.holdings,
      renderWidget: (info) => <HoldingsWidget stocks={stocks} showKrw={showKrw} afterCost={afterCost} fetchedAt={fetchedAt} error={null} height={info.height} />,
    });
    await requestWidgetUpdate({
      widgetName: WIDGET_NAMES.asset,
      renderWidget: () => <AssetWidget stocks={stocks} showKrw={showKrw} afterCost={afterCost} fetchedAt={fetchedAt} error={null} />,
    });
  } catch {
    /* 위젯 모듈이 없는 빌드(개발 클라이언트 등)에서는 무시 */
  }
}
