import React from "react";
import { Platform } from "react-native";
import type { RegisteredWithQuote } from "@/api/types";
import { withLastGood } from "./data";
import { WIDGET_NAMES, AssetWidget, HoldingsWidget } from "./widgets";

/**
 * 앱이 이미 받아 둔 데이터로 홈 화면 위젯을 즉시 갱신한다 (서버 재호출 없음).
 * 위젯이 하나도 없으면 아무 일도 하지 않는다. Android 전용.
 */
export async function refreshWidgets({
  stocks: raw,
  showKrw,
  afterCost,
  filled: given,
}: {
  stocks: RegisteredWithQuote[];
  showKrw: boolean;
  afterCost: boolean;
  /** 이미 마지막 값으로 채운 데이터(백그라운드 작업)면 채운 종목 코드. 없으면 여기서 채운다 */
  filled?: string[];
}): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const { requestWidgetUpdate } = await import("react-native-android-widget");
    const fetchedAt = Date.now();
    // 시세가 빠진 종목은 마지막 값으로 채우고(위젯이 직접 받을 때와 같은 규칙), 다음 실패 대비로 적어 둔다
    const { stocks, filled } = given ? { stocks: raw, filled: given } : await withLastGood(raw, fetchedAt);
    await requestWidgetUpdate({
      widgetName: WIDGET_NAMES.holdings,
      renderWidget: (info) => <HoldingsWidget stocks={stocks} showKrw={showKrw} afterCost={afterCost} fetchedAt={fetchedAt} error={null} filled={filled} height={info.height} now={fetchedAt} />,
    });
    await requestWidgetUpdate({
      widgetName: WIDGET_NAMES.asset,
      renderWidget: () => <AssetWidget stocks={stocks} showKrw={showKrw} afterCost={afterCost} fetchedAt={fetchedAt} error={null} filled={filled} now={fetchedAt} />,
    });
  } catch {
    /* 위젯 모듈이 없는 빌드(개발 클라이언트 등)에서는 무시 */
  }
}
