import { requestWidgetUpdate, type WidgetTaskHandlerProps } from "react-native-android-widget";
import { logWidgetRefresh } from "@/lib/widgetRefreshLog";
import { loadCachedWidgetData, loadWidgetData, readPnlMode, setPnlMode, togglePnlMode, type WidgetData } from "./data";
import { fontScaleNow } from "./fontScale";
import { failureText, type PnlMode } from "./model";
import { redrawAllWidgets } from "./redraw";
import { errorView, renderFor } from "./render";
import { forgetWidgetSize, type SizeSource } from "./sizeLog";
import { WIDGET_CLICK, WIDGET_NAMES } from "./widgets";

/**
 * 위젯 이벤트 처리. 추가/주기 갱신/크기 변경/새로고침 클릭 때 서버에서 데이터를 받아 다시 그린다.
 * 종목·브리핑·합계·지수 칸 클릭은 OPEN_URI 딥링크라 여기로 오지 않는다. 늘 라이트·다크 두 벌을 그린다 (3-23).
 * 위젯 4종(잔고·브리핑·자산·지수·환율)이 같은 처리를 쓴다 — 지수·환율 위젯의 ↻ 도 "갱신 중"을 먼저 그린다.
 *  - REFRESH(↻): 저장해 둔 값으로 "갱신 중"을 바로 그리고(1초 안), 서버에서 받은 결과로 다시 그린다 (실패하면 "갱신 실패 …")
 *  - PNL_TOGGLE(손익): 누른 위젯이 보여 주던 쪽의 반대로 바꿔 저장하고, 서버를 부르지 않고 저장해 둔 값으로 바로 다시 그린다.
 *    손익 칸 설정은 잔고 위젯 모두가 같이 쓰므로 다른 잔고 위젯도 같은 쪽으로 다시 그린다
 *  - 앞선 갱신이 실패한 뒤 이번에 서버에서 받았으면(위젯 2차 — data.recovered) 다른 위젯도 같은 값으로 다시 그려 '갱신 실패'를 모두 지운다
 *  - 크기는 widgetInfo 그대로 (renderFor). 폴드 위젯 2차(widgetFoldFit)는 넓은 모습을 위젯 폭 하나로만 정하고(render.tsx), 크기는 진단 기록에만 적는다
 *    (sizeLog.ts — 설정 '화면 정보' 공유 글). 위젯을 지우면 그 기록도 지운다
 */
export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const { widgetInfo, widgetAction, renderWidget } = props;
  if (widgetAction === "WIDGET_DELETED") {
    await forgetWidgetSize(widgetInfo.widgetId);
    return;
  }
  const click = widgetAction === "WIDGET_CLICK" ? props.clickAction : null;
  if (widgetAction === "WIDGET_CLICK" && click !== WIDGET_CLICK.refresh && click !== WIDGET_CLICK.pnlToggle) return;
  const name = widgetInfo.widgetName;
  const fontScale = fontScaleNow();
  /** 진단 기록에 적는 '크기를 알게 된 길' (sizeLog.ts — 배치에는 쓰지 않음) */
  const by: SizeSource = widgetAction === "WIDGET_ADDED" ? "add" : widgetAction === "WIDGET_RESIZED" ? "resize" : widgetAction === "WIDGET_CLICK" ? "click" : "update";
  try {
    if (click === WIDGET_CLICK.pnlToggle) {
      const cached = await loadCachedWidgetData();
      // 플래그가 그사이 꺼졌으면(옛 그림을 누름) 바꾸지 않고 누적으로 다시 그린다
      const pnlMode = cached.features.pnlToggle ? await switchPnl(props.clickActionData) : await readPnlMode();
      renderWidget(await renderFor(name, cached, widgetInfo, { fontScale, now: Date.now(), pnlMode, by }));
      if (cached.features.pnlToggle) await redrawHoldings(cached, pnlMode);
      return;
    }
    if (click === WIDGET_CLICK.refresh) {
      try {
        const cached = await loadCachedWidgetData();
        renderWidget(await renderFor(name, cached, widgetInfo, { fontScale, now: Date.now(), pnlMode: await readPnlMode(), refreshing: true, by }));
      } catch {
        /* 저장해 둔 값으로 못 그려도 서버에서 받아 그리는 것은 계속한다 */
      }
    }
    // ↻ 를 누른 때만 서버에 바로 묻고, 주기·추가·크기 변경 갱신은 백그라운드 작업이 받아 둔 응답을 다시 쓴다.
    // 지수·환율 위젯은 판을 함께 묻는다 (받아 둔 응답에 판이 없으면 재사용하지 않고 묻는다). 예전 서버의 예전 API(잔고·브리핑)는 부르지 않는다
    const market = name === WIDGET_NAMES.market;
    const data = await loadWidgetData({
      stocks: name !== WIDGET_NAMES.briefing && !market,
      briefings: name === WIDGET_NAMES.briefing,
      board: market,
      reuse: widgetAction !== "WIDGET_CLICK",
    });
    // 손익 칸 설정은 받은 뒤에 읽는다: 받는 동안(최대 12초, "갱신 중") 손익을 눌러 바꾼 것을 옛 값으로 되돌려 그리지 않게
    renderWidget(await renderFor(name, data, widgetInfo, { fontScale, now: Date.now(), pnlMode: await readPnlMode(), by }));
    // 실패 뒤 첫 성공 (위젯 2차): 다른 위젯에 남은 '갱신 실패 · …'도 방금 적은 값으로 지운다 (서버를 다시 부르지 않음).
    // 실패 표시를 이 조회가 지웠을 때만 true 라, 여러 위젯이 한꺼번에 받아도 다시 그리기는 한 번이다 (data.ts)
    if (data.recovered) await redrawAllWidgets(await loadCachedWidgetData());
    // 자동 갱신 기록 (위젯 리뷰 2, 설정 화면 '마지막 자동 갱신'): 주기 갱신은 periodic, ↻ 는 button. 추가·크기 변경은 적지 않는다(폴드를 접고 펼 때마다 오므로 간격이 흐려진다).
    // 받아 둔 응답을 다시 써 서버를 부르지 않았으면 skipped — 평균 간격을 서버에 실제로 물은 갱신으로만 내게 (통합 검증 지적)
    const source = widgetAction === "WIDGET_UPDATE" ? "periodic" : click === WIDGET_CLICK.refresh ? "button" : null;
    if (source) await logWidgetRefresh(source, data.error ? "failed" : data.asked === false ? "skipped" : "ok", { error: failureText(data.error) });
  } catch (e) {
    // 렌더 중 예외가 나면 위젯이 빈 채로 남으므로 오류를 글로 보여 준다
    renderWidget(errorView(e));
  }
}

/**
 * 손익 전환: 누른 그림이 보여 주던 쪽(clickActionData.mode)의 반대로 저장한다.
 * 저장된 값을 뒤집기만 하면, 잔고 위젯이 둘 이상일 때 옛 모드를 보이던 위젯을 눌러도 화면이 그대로다("눌러도 안 바뀜").
 * 보여 주던 쪽을 모르면(값이 없는 그림) 저장된 값을 뒤집는다
 */
async function switchPnl(data: Record<string, unknown> | undefined): Promise<PnlMode> {
  const shown = data?.mode;
  if (shown === "day" || shown === "cumulative") {
    const next: PnlMode = shown === "day" ? "cumulative" : "day";
    await setPnlMode(next);
    return next;
  }
  return togglePnlMode();
}

/** 다른 잔고 위젯도 같은 손익 칸으로 (서버를 부르지 않고 같은 저장값으로). 실패해도 누른 위젯은 이미 그렸다 */
async function redrawHoldings(data: WidgetData, pnlMode: PnlMode): Promise<void> {
  try {
    const fontScale = fontScaleNow();
    await requestWidgetUpdate({
      widgetName: WIDGET_NAMES.holdings,
      renderWidget: (info) => renderFor(WIDGET_NAMES.holdings, data, info, { fontScale, now: Date.now(), pnlMode }),
    });
  } catch {
    /* 다른 위젯은 다음 갱신 때 같은 값으로 그려진다 */
  }
}
