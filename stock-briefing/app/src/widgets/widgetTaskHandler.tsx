import React from "react";
import { FlexWidget, TextWidget, type WidgetTaskHandlerProps } from "react-native-android-widget";
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
  try {
    const data = await loadWidgetData({ stocks: name !== WIDGET_NAMES.briefing, briefings: name === WIDGET_NAMES.briefing });
    renderWidget(render(name, data, widgetInfo.height));
  } catch (e) {
    // 렌더 중 예외가 나면 위젯이 빈 채로 남으므로 오류를 글로 보여준다
    renderWidget(
      <FlexWidget style={{ height: "match_parent", width: "match_parent", backgroundColor: "#12151B", borderRadius: 14, padding: 12, justifyContent: "center" }} clickAction="OPEN_APP">
        <TextWidget text="위젯을 그리지 못했습니다" style={{ color: "#FFFFFF", fontSize: 12, fontWeight: "700" }} />
        <TextWidget text={String(e instanceof Error ? e.message : e).slice(0, 120)} style={{ color: "#7A828F", fontSize: 10 }} maxLines={3} />
        <TextWidget text="눌러서 앱 열기" style={{ color: "#E1C25B", fontSize: 10, marginTop: 4 }} />
      </FlexWidget>,
    );
  }
}

export function render(name: string, data: Awaited<ReturnType<typeof loadWidgetData>>, height: number): React.JSX.Element {
  const now = Date.now();
  switch (name) {
    case WIDGET_NAMES.briefing:
      return <BriefingWidget briefings={data.briefings} fetchedAt={data.fetchedAt} error={data.error} now={now} market={data.market} />;
    case WIDGET_NAMES.asset:
      return <AssetWidget stocks={data.stocks} showKrw={data.showKrw} afterCost={data.afterCost} fetchedAt={data.fetchedAt} error={data.error} filled={data.filled} now={now} market={data.market} />;
    default:
      return <HoldingsWidget stocks={data.stocks} showKrw={data.showKrw} afterCost={data.afterCost} fetchedAt={data.fetchedAt} error={data.error} filled={data.filled} height={height} now={now} market={data.market} />;
  }
}
