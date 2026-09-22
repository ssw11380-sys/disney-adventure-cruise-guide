import React from "react";
import type { WidgetTaskHandlerProps } from "react-native-android-widget";
import { loadWidgetData } from "./data";
import { AssetWidget, BriefingWidget, HoldingsWidget, WIDGET_NAMES } from "./widgets";

/**
 * 위젯 이벤트 처리. 추가/주기 갱신/크기 변경/새로고침 클릭 때 서버에서 데이터를 받아 다시 그린다.
 * 종목·브리핑 클릭은 OPEN_URI 딥링크라 여기로 오지 않는다.
 */
export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const { widgetInfo, widgetAction, renderWidget } = props;
  if (widgetAction === "WIDGET_DELETED") return;
  if (widgetAction === "WIDGET_CLICK" && props.clickAction !== "REFRESH") return;
  const name = widgetInfo.widgetName;
  const data = await loadWidgetData({ stocks: name !== WIDGET_NAMES.briefing, briefings: name === WIDGET_NAMES.briefing });
  renderWidget(render(name, data, widgetInfo.height));
}

export function render(name: string, data: Awaited<ReturnType<typeof loadWidgetData>>, height: number): React.JSX.Element {
  switch (name) {
    case WIDGET_NAMES.briefing:
      return <BriefingWidget briefings={data.briefings} fetchedAt={data.fetchedAt} error={data.error} />;
    case WIDGET_NAMES.asset:
      return <AssetWidget stocks={data.stocks} showKrw={data.showKrw} fetchedAt={data.fetchedAt} error={data.error} />;
    default:
      return <HoldingsWidget stocks={data.stocks} showKrw={data.showKrw} fetchedAt={data.fetchedAt} error={data.error} height={height} />;
  }
}
