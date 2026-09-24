import type { WidgetTaskHandlerProps } from "react-native-android-widget";
import { loadCachedWidgetData, loadWidgetData, readPnlMode, togglePnlMode } from "./data";
import { fontScaleNow } from "./fontScale";
import { errorView, renderBoth } from "./render";
import { WIDGET_CLICK, WIDGET_NAMES } from "./widgets";

/**
 * 위젯 이벤트 처리. 추가/주기 갱신/크기 변경/새로고침 클릭 때 서버에서 데이터를 받아 다시 그린다.
 * 종목·브리핑·합계 클릭은 OPEN_URI 딥링크라 여기로 오지 않는다. 늘 라이트·다크 두 벌을 그린다 (3-23).
 *  - REFRESH(↻): 저장해 둔 값으로 "갱신 중"을 바로 그리고(1초 안), 서버에서 받은 결과로 다시 그린다 (실패하면 "갱신 실패 …")
 *  - PNL_TOGGLE(손익): 누적 ↔ 당일을 바꿔 저장하고, 서버를 부르지 않고 저장해 둔 값으로 바로 다시 그린다
 */
export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const { widgetInfo, widgetAction, renderWidget } = props;
  if (widgetAction === "WIDGET_DELETED") return;
  const click = widgetAction === "WIDGET_CLICK" ? props.clickAction : null;
  if (widgetAction === "WIDGET_CLICK" && click !== WIDGET_CLICK.refresh && click !== WIDGET_CLICK.pnlToggle) return;
  const name = widgetInfo.widgetName;
  const frame = { width: widgetInfo.width, height: widgetInfo.height, fontScale: fontScaleNow() };
  try {
    if (click === WIDGET_CLICK.pnlToggle) {
      const cached = await loadCachedWidgetData();
      // 플래그가 그사이 꺼졌으면(옛 그림을 누름) 바꾸지 않고 누적으로 다시 그린다
      const pnlMode = cached.features.pnlToggle ? await togglePnlMode() : await readPnlMode();
      renderWidget(renderBoth(name, cached, { ...frame, now: Date.now(), pnlMode }));
      return;
    }
    const pnlMode = await readPnlMode();
    if (click === WIDGET_CLICK.refresh) {
      try {
        const cached = await loadCachedWidgetData();
        renderWidget(renderBoth(name, cached, { ...frame, now: Date.now(), pnlMode, refreshing: true }));
      } catch {
        /* 저장해 둔 값으로 못 그려도 서버에서 받아 그리는 것은 계속한다 */
      }
    }
    // ↻ 를 누른 때만 서버에 바로 묻고, 주기·추가·크기 변경 갱신은 백그라운드 작업이 받아 둔 응답을 다시 쓴다
    const data = await loadWidgetData({ stocks: name !== WIDGET_NAMES.briefing, briefings: name === WIDGET_NAMES.briefing, reuse: widgetAction !== "WIDGET_CLICK" });
    renderWidget(renderBoth(name, data, { ...frame, now: Date.now(), pnlMode }));
  } catch (e) {
    // 렌더 중 예외가 나면 위젯이 빈 채로 남으므로 오류를 글로 보여 준다
    renderWidget(errorView(e));
  }
}
